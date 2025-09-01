// server/server.js
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto"); // <- CSPRNG

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET','POST'] } });

app.use(express.json({ limit: '64kb' }));
app.use(express.static("public"));

/**
 * (OPCIONAL) Endpoint para probar uniformidad del RNG
 * Llama: /__rng?n=100000
 */
app.get('/__rng', (req, res) => {
  const N = Math.min(parseInt(req.query.n || '10000', 10), 1e6);
  const counts = Array(37).fill(0);
  for (let i = 0; i < N; i++) counts[crypto.randomInt(0, 37)]++;
  res.json({ N, counts });
});

// ======= Depuración simple (logs) =======
let __logSeq = 0;
const __logs = []; // {seq,time,label,data}
app.post('/__log', (req, res) => {
  const { label, data } = req.body || {};
  const item = { seq: ++__logSeq, time: Date.now(), label: String(label||''), data };
  __logs.push(item);
  if (__logs.length > 1000) __logs.shift();
  try { console.log('[web]', label, data); } catch {}
  res.json({ ok: true, seq: item.seq });
});
app.get('/__logs', (req, res) => {
  const since = parseInt(req.query.since, 10) || 0;
  const items = __logs.filter(x => x.seq > since).slice(-200);
  res.json({ items, nextSeq: items.length ? items[items.length-1].seq : since });
});

// ======= Estado de salas =======
const START_BALANCE = 5000;
// code -> { leaderId, players: Map<sid,{name,balance,ready}>, bets: Map<sid, Array<Bet>>, roundActive: bool, privacy: string, pendingNumber: number|null }
const rooms = new Map();

function newRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  if (rooms.has(code)) return newRoomCode();
  return code;
}

function roomStatePayload(code) {
  const room = rooms.get(code);
  if (!room) return null;
  const players = Array.from(room.players.entries()).map(([id, p]) => ({
    id, name: p.name, balance: p.balance, ready: !!p.ready
  }));
  const allReady = players.length > 0 && players.every(p => p.ready);
  return { code, leaderId: room.leaderId, players, roundActive: !!room.roundActive, allReady };
}

function multiplier(t){
  switch(t){
    case 'straight': return 35;
    case 'split':    return 17;
    case 'street':
    case 'trio':     return 11;
    case 'corner':
    case 'firstfour':return 8;
    case 'sixline':  return 5;
    case 'column':
    case 'dozen':    return 2;
    case 'color':
    case 'evenodd':
    case 'lowhigh':  return 1;
    default: return 0;
  }
}

io.on("connection", (socket) => {
  console.log('[io] connection', socket.id);
  let joinedCode = null;

  // Recibir logs desde el cliente
  socket.on('dbg:log', (payload) => {
    try { console.log('[client]', socket.id, payload?.label, payload?.data); } catch {}
  });

  // ACK visual del líder: NO tocamos el número del servidor
  socket.on('mp:landed', ({ code /*, number*/ }) => {
    code = String(code||'').toUpperCase().trim();
    const room = rooms.get(code); if (!room) return;
    if (!room.roundActive) return;
    if (room.leaderId !== socket.id) return;
    // Intencionalmente no modificamos room.pendingNumber aquí.
  });

  function emitState() {
    if (!joinedCode) return;
    const payload = roomStatePayload(joinedCode);
    if (payload) io.to(joinedCode).emit('mp:state', payload);
  }

  socket.on('mp:createRoom', ({ name, privacy }) => {
    console.log('[io] mp:createRoom', socket.id, name, privacy);
    const code = newRoomCode();
    const room = { leaderId: socket.id, players: new Map(), bets: new Map(), roundActive: false, privacy: privacy||'public', pendingNumber: null };
    rooms.set(code, room);
    room.players.set(socket.id, { name: String(name||'Player'), balance: START_BALANCE, ready: false });
    room.bets.set(socket.id, []);
    socket.join(code);
    joinedCode = code;
    socket.emit('mp:joined', { code, leader: true, you: socket.id });
    console.log('[io] room created', code, 'leader', socket.id);
    emitState();
  });

  socket.on('mp:joinRoom', ({ name, code }) => {
    console.log('[io] mp:joinRoom', socket.id, name, code);
    code = String(code||'').toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) return socket.emit('mp:error', { message: 'Sala no existe' });
    if (room.roundActive) return socket.emit('mp:error', { message: 'Ronda en curso' });
    room.players.set(socket.id, { name: String(name||'Player'), balance: START_BALANCE, ready: false });
    room.bets.set(socket.id, []);
    socket.join(code);
    joinedCode = code;
    socket.emit('mp:joined', { code, leader: room.leaderId===socket.id, you: socket.id });
    emitState();
  });

  socket.on('mp:placeBet', ({ code, bet }) => {
    console.log('[io] mp:placeBet', socket.id, code, bet?.id, bet?.amount);
    const room = rooms.get(code); if (!room) return;
    const p = room.players.get(socket.id); if (!p) return;
    if (room.roundActive) return;
    const amount = Number(bet.amount||0);
    if (!(amount>0) || p.balance < amount) return;
    p.balance -= amount;
    const arr = room.bets.get(socket.id) || [];
    arr.push({ id: String(bet.id), domId: String(bet.domId||''), type: bet.type, nums: Array.from(bet.nums||[]), amount });
    room.bets.set(socket.id, arr);
    p.ready = arr.length>0;
    emitState();
    socket.emit('mp:ack', { ok:true, action:'placeBet' });
  });

  socket.on('mp:undoLast', ({ code }) => {
    console.log('[io] mp:undoLast', socket.id, code);
    const room = rooms.get(code); if (!room) return;
    const p = room.players.get(socket.id); if (!p) return;
    if (room.roundActive) return;
    const arr = room.bets.get(socket.id) || [];
    const last = arr.pop();
    if (last){ p.balance += last.amount; }
    room.bets.set(socket.id, arr);
    p.ready = arr.length>0;
    emitState();
    socket.emit('mp:ack', { ok:true, action:'undoLast', last });
  });

  socket.on('mp:undoFromCell', ({ code, cellId }) => {
    console.log('[io] mp:undoFromCell', socket.id, code, cellId);
    const room = rooms.get(code); if (!room) return;
    const p = room.players.get(socket.id); if (!p) return;
    if (room.roundActive) return;
    const arr = room.bets.get(socket.id) || [];
    for (let i=arr.length-1;i>=0;i--){
      if (arr[i].domId===cellId || arr[i].id===cellId){
        const b=arr.splice(i,1)[0];
        p.balance+=b.amount;
        break;
      }
    }
    room.bets.set(socket.id, arr);
    p.ready = arr.length>0;
    emitState();
    socket.emit('mp:ack', { ok:true, action:'undoFromCell' });
  });

  socket.on('mp:clearBets', ({ code }) => {
    console.log('[io] mp:clearBets', socket.id, code);
    const room = rooms.get(code); if (!room) return;
    const p = room.players.get(socket.id); if (!p) return;
    if (room.roundActive) return;
    const arr = room.bets.get(socket.id) || [];
    const refund = arr.reduce((s,b)=>s+b.amount,0);
    p.balance += refund;
    room.bets.set(socket.id, []);
    p.ready = false;
    emitState();
    socket.emit('mp:ack', { ok:true, action:'clearBets' });
  });

  socket.on('mp:requestSpin', ({ code }) => {
    console.log('[io] mp:requestSpin', socket.id, code);
    const room = rooms.get(code); if (!room) return;
    if (room.roundActive) return;
    if (room.leaderId !== socket.id) return;
    const payload = roomStatePayload(code);
    if (!payload || !payload.allReady) return;

    room.roundActive = true;

    // Número autoritativo decidido en el servidor con CSPRNG
    const result = crypto.randomInt(0, 37); // 0..36
    room.pendingNumber = result;

    io.to(code).emit('mp:spin', { number: result });
    console.log('[io] mp:spin', code, result);

    // Liquidación tras la animación (~5.2s)
    setTimeout(() => {
      const number = Number.isInteger(room.pendingNumber)
        ? room.pendingNumber
        : crypto.randomInt(0, 37);

      const winners = [];
      for (const [pid, list] of room.bets.entries()){
        const player = room.players.get(pid); if (!player) continue;
        let payout = 0;
        for (const b of list){
          if (Array.isArray(b.nums) && b.nums.includes(number)) {
            payout += b.amount * (multiplier(b.type)+1);
          }
        }
        player.balance += payout;
        if (payout>0) winners.push({ playerId: pid, winAmount: payout });
      }

      // Reset apuestas y ready
      for (const pid of room.players.keys()){
        room.bets.set(pid, []);
        const p = room.players.get(pid); if (p) p.ready = false;
      }

      room.roundActive = false;
      room.pendingNumber = null;

      io.to(code).emit('mp:result', { number, winners, players: roomStatePayload(code).players });
      console.log('[io] mp:result', code, number, 'winners', winners.length);
      emitState();
    }, 5300);
  });

  // Petición de +100 (o +1000) enviada por un jugador al líder (si lo usas)
  socket.on('mp:request100', ({ code, playerId, name }) => {
    code = String(code||'').toUpperCase().trim();
    const room = rooms.get(code); if (!room) return;
    const leaderSid = room.leaderId; if (!leaderSid) return;
    io.to(leaderSid).emit('mp:req:100', { playerId: String(playerId||socket.id), name: String(name||'Jugador') });
  });

  // El líder otorga saldo (ahora +1000 para coincidir con tu UI actual)
  socket.on('mp:grant100', ({ code, playerId }) => {
    code = String(code||'').toUpperCase().trim();
    const room = rooms.get(code); if (!room) return;
    if (room.leaderId !== socket.id) return; // Solo líder
    const target = room.players.get(String(playerId)); if (!target) return;

    target.balance += 1000;

    io.to(code).emit('mp:state', roomStatePayload(code));
    io.to(code).emit('mp:ack', { ok: true, action: 'grant1000', to: playerId, amount: 1000 });
  });

  socket.on("disconnect", () => {
    console.log('[io] disconnect', socket.id, 'from', joinedCode);
    if (!joinedCode) return;
    const room = rooms.get(joinedCode);
    if (!room) return;
    room.players.delete(socket.id);
    room.bets.delete(socket.id);
    if (room.leaderId === socket.id) {
      // nuevo líder
      const next = room.players.keys().next();
      room.leaderId = next && !next.done ? next.value : null;
    }
    if (room.players.size===0) { rooms.delete(joinedCode); }
    else { io.to(joinedCode).emit('mp:state', roomStatePayload(joinedCode)); }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});