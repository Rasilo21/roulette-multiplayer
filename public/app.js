(() => {
  "use strict";
  // ======= Datos ruleta =======
  const EURO_ORDER = [0,32,15,19,4,21,2,25,17,34,6,27,13,36,11,30,8,23,10,5,24,16,33,1,20,14,31,9,22,18,29,7,28,12,35,3,26];
  const REDS   = new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);
  const BLACKS = new Set(Array.from({length:36},(_,i)=>i+1).filter(n=>!REDS.has(n)));
  // ======= Utils =======
  const $   = id => document.getElementById(id);
  const fmt = n  => n.toLocaleString('es-ES',{minimumFractionDigits:2,maximumFractionDigits:2});
  const toast = (t)=>{ const el=$('toast'); if(!el) return; el.textContent=t; el.style.display='block'; setTimeout(()=>el.style.display='none',1300); };
  const log   = (t)=>{ const el=$('log'); if(!el) return; const time=new Date().toLocaleTimeString(); el.textContent=`[${time}] ${t}\n${el.textContent}`; };
  const vscLog = (label, data) => { try { if (MP && MP.socket) MP.socket.emit('dbg:log', { label, data }); } catch {} }; // server also has /__log endpoint
  const safeLog = (t)=>{ try{ if (typeof log==='function'){ log(t); } }catch{}; try{ console.log('[LOG]', t); }catch{}; try{ vscLog('log', t); }catch{} };
  const dbg   = (label, data)=>{ try{ console.log('[DBG]', label, data); }catch{}; try{ safeLog(`${label}: ${typeof data==='string'?data:JSON.stringify(data)}`) }catch{}; try{ vscLog(label, data); }catch{} };
  // ======= Estado =======
  let balance=5000, selected=1000.00, roundActive=true;
  const bets=[], sumById=new Map(), history=[];
  let lastBets=[];
  let MODE = 'sp'; // 'sp' | 'mp'
  const MP = { socket:null, code:null, you:null, leader:false, state:null };
  let allInPending = false;
  try { window.__MP = MP; } catch{}
  // ======= DOM =======
  const board=$('board');
  const chipsWrap=$('chips');
  // ========================= Construcción del tablero =========================
  const cell = (cls,txt,id)=>{ const d=document.createElement('div'); d.className=`cell ${cls}`; d.textContent=txt; d.id=id; d.appendChild(sum()); return d; };
  const sum = ()=>{ const s=document.createElement('div'); s.className='sum'; s.textContent='0.00'; return s; };
  // 0 (vertical)
  board.appendChild(cell('green','0','num-0'));
  // 1..36 — 12 columnas x 3 filas (top/mid/bot = 3/2/1)
  for(let col=0; col<12; col++){
    const top=3+col*3, mid=2+col*3, bot=1+col*3;
    [top,mid,bot].forEach(n=>{ board.appendChild(cell(REDS.has(n)?'red':'black', String(n), `num-${n}`)); });
  }
  // 2to1
  for(let r=1;r<=3;r++) board.appendChild(cell('out','2to1',`col-${r}`));
  // docenas + externas
  const addOut=(label,cls,id,gridCol)=>{ const d=cell('out '+(cls||''),label,id); d.style.gridColumn=gridCol; board.appendChild(d); };
  addOut('1-12','',    'dz-1','2 / span 4');
  addOut('13-24','',   'dz-2','6 / span 4');
  addOut('25-36','',   'dz-3','10 / span 4');
  addOut('1-18','',    'lh-low', '2 / span 2');
  addOut('Even','',    'ev-even','4 / span 2');
  { const d = cell('out','', 'color-red');   d.style.gridColumn='6 / span 2'; const rh=document.createElement('div'); rh.className='diamond red';   d.innerHTML=''; d.appendChild(rh); d.appendChild(sum()); board.appendChild(d); }
  { const d = cell('out','', 'color-black'); d.style.gridColumn='8 / span 2'; const bh=document.createElement('div'); bh.className='diamond black'; d.innerHTML=''; d.appendChild(bh); d.appendChild(sum()); board.appendChild(d); }
  addOut('Odd','',     'ev-odd','10 / span 2');
  addOut('19-36','',   'lh-high','12 / span 2');
  // ========================= Chips =========================
  const CHIP_SET=[
    {v:1,    css:'c-1',   label:'1'},
    {v:5,    css:'c-5',   label:'5'},
    {v:25,   css:'c-25',  label:'25'},
    {v:100,  css:'c-100', label:'100'},
    {v:500,  css:'c-500', label:'500'},
    {v:1000, css:'c-1k',  label:'1k'},
  ];
  CHIP_SET.forEach(({v,css,label})=>{
    const d=document.createElement('div'); d.className=`chip ${css}`; d.innerHTML=`<div>${label}</div>`;
    d.addEventListener('click', ()=>{
      document.querySelectorAll('.chip').forEach(c=>c.classList.remove('active'));
      d.classList.add('active');
      selected=v; safeLog(`Ficha ${label}`);
    });
    chipsWrap.appendChild(d);
  });
  chipsWrap.querySelector('.c-1k').classList.add('active');
  // ========================= Sumas / header =========================
  function addSum(id, amt){ const el = document.getElementById(id).querySelector('.sum'); const curr = (sumById.get(id)||0) + amt; sumById.set(id, curr); el.style.display='block'; el.textContent = fmt(curr); }
  function subSum(id, amt){ const el = document.getElementById(id).querySelector('.sum'); const curr = (sumById.get(id)||0) - amt; if(curr<=0){ sumById.delete(id); el.style.display='none'; el.textContent=''; } else { sumById.set(id, curr); el.textContent=fmt(curr); } }
  const updateHeader = ()=>{ $('balance').textContent = fmt(balance); $('stake').textContent = fmt(bets.reduce((s,b)=>s+b.amount,0)); };
  function toggleControls(dis){ ['btn-spin','btn-delete','btn-undo','btn-double','btn-repeat','btn-allin'].forEach(id=>{ const b=$(id); if(b) b.disabled=dis; }); }
  function enterAllIn(){ allInPending = true; try{ document.body.classList.add('allin-mode'); }catch{} }
  function exitAllIn(){ allInPending = false; try{ document.body.classList.remove('allin-mode'); }catch{} }
  // ========================= Pagos y helpers =========================
  function multiplier(t){ switch(t){ case 'straight': return 35; case 'split': return 17; case 'street': case 'trio': return 11; case 'corner': case 'firstfour': return 8; case 'sixline': return 5; case 'column': case 'dozen': return 2; case 'color': case 'evenodd': case 'lowhigh': return 1; default: return 0; } }
  function settle(n, arr){ let payout=0; for(const b of arr){ if(b.nums && b.nums.includes(n)) payout += b.amount*(multiplier(b.type)+1); } balance += payout; return payout; }
  function pushHistory(n){ history.unshift(n); if(history.length>22) history.pop(); const box=$('history'); if(!box) return; box.innerHTML=''; history.forEach(x=>{ const t=document.createElement('span'); t.className='tagb '+(x===0?'green':(REDS.has(x)?'red':'black')); t.textContent=x; box.appendChild(t); }); }
  // ========================= Clicks de apuesta =========================
  const colNums = (r)=>Array.from({length:12},(_,i)=>r+i*3);
  const dozenNums = (d)=>Array.from({length:12},(_,i)=>1+(d-1)*12+i);
  const rangeNums=(a,b)=>Array.from({length:b-a+1},(_,i)=>a+i);
  const allNums=Array.from({length:36},(_,i)=>i+1);
  board.addEventListener('click', (e)=>{
    const t = e.target.closest('.cell'); if(!t) return;
    if(!roundActive){ toast('Ronda en curso.'); return; }
    const id=t.id; let bet=null;
    if (allInPending){
      if (balance<=0){ toast('Saldo insuficiente'); exitAllIn(); return; }
      const amt = balance;
      if(id.startsWith('num-')){ const n=+id.split('-')[1]; bet={id:`pleno-${n}`, type:'straight', nums:[n], amount:amt, domId:id}; }
      else if(id.startsWith('col-')){ const r=+id.split('-')[1]; bet={id:`col-${r}`, type:'column', nums:colNums(r).filter(n=>n>=1&&n<=36), amount:amt, domId:id}; }
      else if(id==='dz-1'||id==='dz-2'||id==='dz-3'){ const d=+id.split('-')[1]; bet={id:`dz-${d}`, type:'dozen', nums:dozenNums(d), amount:amt, domId:id}; }
      else if(id==='lh-low'){ bet={id:'low', type:'lowhigh', nums:rangeNums(1,18), amount:amt, domId:id}; }
      else if(id==='lh-high'){ bet={id:'high', type:'lowhigh', nums:rangeNums(19,36), amount:amt, domId:id}; }
      else if(id==='ev-even'){ bet={id:'even', type:'evenodd', nums:allNums.filter(n=>n%2===0), amount:amt, domId:id}; }
      else if(id==='ev-odd'){ bet={id:'odd', type:'evenodd', nums:allNums.filter(n=>n%2===1), amount:amt, domId:id}; }
      else if(id==='color-red'){ bet={id:'red', type:'color', nums:allNums.filter(n=>REDS.has(n)), amount:amt, domId:id}; }
      else if(id==='color-black'){ bet={id:'black', type:'color', nums:allNums.filter(n=>BLACKS.has(n)), amount:amt, domId:id}; }
      exitAllIn();
      if(!bet) return;
      bets.push(bet); balance-=bet.amount; addSum(bet.domId, bet.amount); updateHeader();
      if (MODE==='mp' && MP.socket && MP.code){ try{ MP.socket.emit('mp:placeBet', { code: MP.code, bet }); }catch{} }
      return;
    }
    if(balance < selected){ toast('Saldo insuficiente'); return; }
    if(id.startsWith('num-')){ const n=+id.split('-')[1]; bet={id:`pleno-${n}`, type:'straight', nums:[n], amount:selected, domId:id}; }
    else if(id.startsWith('col-')){ const r=+id.split('-')[1]; bet={id:`col-${r}`, type:'column', nums:colNums(r).filter(n=>n>=1&&n<=36), amount:selected, domId:id}; }
    else if(id==='dz-1'||id==='dz-2'||id==='dz-3'){ const d=+id.split('-')[1]; bet={id:`dz-${d}`, type:'dozen', nums:dozenNums(d), amount:selected, domId:id}; }
    else if(id==='lh-low'){ bet={id:'low', type:'lowhigh', nums:rangeNums(1,18), amount:selected, domId:id}; }
    else if(id==='lh-high'){ bet={id:'high', type:'lowhigh', nums:rangeNums(19,36), amount:selected, domId:id}; }
    else if(id==='ev-even'){ bet={id:'even', type:'evenodd', nums:allNums.filter(n=>n%2===0), amount:selected, domId:id}; }
    else if(id==='ev-odd'){ bet={id:'odd', type:'evenodd', nums:allNums.filter(n=>n%2===1), amount:selected, domId:id}; }
    else if(id==='color-red'){ bet={id:'red', type:'color', nums:allNums.filter(n=>REDS.has(n)), amount:selected, domId:id}; }
    else if(id==='color-black'){ bet={id:'black', type:'color', nums:allNums.filter(n=>BLACKS.has(n)), amount:selected, domId:id}; }
    if(!bet) return;
    bets.push(bet); balance-=selected; addSum(bet.domId, bet.amount); updateHeader();
    if (MODE==='mp' && MP.socket && MP.code){ try{ MP.socket.emit('mp:placeBet', { code: MP.code, bet }); }catch{} }
  });
  // Click derecho: quitar una ficha (última apuesta) de esa casilla
  board.addEventListener('contextmenu', (e)=>{
    const t = e.target.closest('.cell'); if(!t) return;
    e.preventDefault();
    if(!roundActive){ toast('Ronda en curso.'); return; }
    const id = t.id;
    for (let i=bets.length-1; i>=0; i--) {
      const b = bets[i];
      if (b && b.domId === id) {
        bets.splice(i,1);
        balance += b.amount;
        subSum(id, b.amount);
        updateHeader();
        if (MODE==='mp' && MP.socket && MP.code) {
          try { MP.socket.emit('mp:undoFromCell', { code: MP.code, cellId: id }); } catch {}
        }
        return;
      }
    }
  });
  // ========================= Botones principales =========================



  $('btn-undo').onclick = ()=>{
    const last = bets.pop(); if(!last) return; balance+=last.amount; subSum(last.domId, last.amount); updateHeader();
    if (MODE==='mp' && MP.socket && MP.code){ try{ MP.socket.emit('mp:undoLast', { code: MP.code }); }catch{} }
  };
  $('btn-delete').onclick = ()=>{
    const refund = bets.reduce((s,b)=>s+b.amount,0); balance+=refund; bets.length=0; sumById.clear(); document.querySelectorAll('.sum').forEach(s=>{s.style.display='none'; s.textContent='0.00';}); updateHeader();
    if (MODE==='mp' && MP.socket && MP.code){ try{ MP.socket.emit('mp:clearBets', { code: MP.code }); }catch{} }
  };
  $('btn-repeat').onclick = ()=>{
    if(lastBets.length===0){ toast('No hay apuestas previas'); return; }
    const total = lastBets.reduce((s,b)=>s+b.amount,0); if(balance<total){ toast('Saldo insuficiente'); return; }
    lastBets.forEach(b=>{ const nb={...b, amount:b.amount, id:b.id, domId:b.domId}; bets.push(nb); balance-=nb.amount; addSum(nb.domId, nb.amount); }); updateHeader();
  };
  $('btn-double').onclick = ()=>{
    const total = bets.reduce((s,b)=>s+b.amount,0); if(total===0){ toast('Sin apuestas'); return; } if(balance<total){ toast('Saldo insuficiente'); return; }
    bets.forEach(b=>{ b.amount+=b.amount; addSum(b.domId, b.amount/2); }); balance-=total; updateHeader();
  };
  $('btn-spin').onclick = async ()=>{
    if (MODE==='mp') { if(MP.socket && MP.code){ try{ MP.socket.emit('mp:requestSpin', { code: MP.code }); }catch{} } return; }
    if(bets.length===0){ toast('Sin apuestas'); return; }
    roundActive = false; toggleControls(true);
    const number = await Wheel2D.spin();
    safeLog(`[SP] Ganador: ${number}`);
    const win = settle(number, bets);
    lastBets = bets.map(b=>({...b}));
    while(bets.length) bets.pop(); sumById.clear(); document.querySelectorAll('.sum').forEach(s=>{s.style.display='none'; s.textContent='0.00';});
    pushHistory(number);
    const color = number===0 ? 'verde' : (REDS.has(number)?'rojo':'negro');
    toast(`Salió ${number} (${color}). Ganancia: ${fmt(win)}`);
    safeLog(`SP resultado: ${number} (${color}). Ganancia: ${fmt(win)}`);
    roundActive = true; toggleControls(false); updateHeader();
  };


  // ========================= Overlay inicio / Lobby =========================
  window.addEventListener('load', () => {
    try { Wheel2D.init('#wheel2d'); } catch(e) {}
    // Menu de inicio: wiring
    const overlay = document.getElementById('startOverlay');
    const menuInicio = document.getElementById('menuInicio');
    const menuMultiplayer = document.getElementById('menuMultiplayer');
    const btnSP = document.getElementById('btn-start-singleplayer');
    const btnMP = document.getElementById('btn-start-multiplayer');
    const btnBack = document.getElementById('btn-lobby-back');
    const btnCreate = document.getElementById('btn-create-room');
    const btnJoin = document.getElementById('btn-join-room');
    const codeBox = document.getElementById('mp-created');
    const codeSpan = document.getElementById('mp-room-created-code');
    const btnCopyCreated = document.getElementById('btn-copy-created');
    const btnEnterRoom = document.getElementById('btn-enter-room');
    const btnAllIn = document.getElementById('btn-allin');

    // Add circular SP recharge button (↻) to the rack, left of delete
    // Add circular SP recharge button (↻) to the rack, left of delete
    try {
      const rack = document.querySelector('.rack');
      const btnDelete = document.getElementById('btn-delete');
      // AHORA solo se crea en modo singleplayer
      if (MODE === 'sp' && rack && btnDelete && !document.getElementById('btn-sp-recharge')){
        const b = document.createElement('button');
        b.id = 'btn-sp-recharge';
        b.className = 'btn';
        b.title = 'Añadir 100';
        b.textContent = '↻';
        b.style.cssText = 'width:36px;height:36px;border-radius:50%;display:inline-grid;place-items:center;padding:0;margin-right:8px;font-size:16px;line-height:1';
        rack.insertBefore(b, btnDelete);
        try { MP.rechargeBtn = b; } catch {}
        b.onclick = () => {
          if (MODE === 'sp'){
            balance += 100; updateHeader();
            safeLog('SP: +100 agregado');
          } else if (MODE === 'mp'){
            toast('No disponible en multijugador');
            return;
          }
        };
      }
    } catch {}
    if (overlay && btnSP && btnMP){
      btnSP.onclick = () => { 
        MODE='sp'; 
        overlay.style.display = 'none'; 
        const rb = document.getElementById('btn-sp-recharge');
        if (rb) { rb.disabled = false; rb.style.opacity = ''; rb.style.pointerEvents=''; rb.title = 'Añadir 100'; }
        safeLog('Modo: Singleplayer'); 
      };
      btnMP.onclick = () => { 
        MODE='mp'; 
        menuInicio.style.display='none'; 
        menuMultiplayer.style.display='block'; 
        const rb = document.getElementById('btn-sp-recharge');
        if (rb) { rb.disabled = true; rb.style.opacity = '0.6'; rb.style.pointerEvents='none'; rb.title = 'No disponible en multijugador'; }
        safeLog('Modo: Multiplayer'); 
      };
    }
    if (btnBack){ btnBack.onclick = () => { menuMultiplayer.style.display='none'; menuInicio.style.display='block'; }; }
    function renderHud(state) {
      const hud = document.getElementById('playersHud'); 
      if (!hud) return; 

      hud.innerHTML = ''; // Limpiamos el HUD para repintarlo

      // Mostrar el código de la sala
      if (MP.code) { 
        const r = document.createElement('div'); 
        r.className = 'player-pill'; 
        r.innerHTML = `<span class="name">Sala:</span> <span class="bal" id="hud-room-code">${MP.code}</span>`; 
        r.style.cursor = 'pointer'; 
        r.title = 'Copiar código'; 
        r.onclick = async () => { 
          try { await navigator.clipboard.writeText(MP.code); toast('Código copiado'); } catch {} 
        }; 
        hud.appendChild(r); 
      }

      // Añadimos cada jugador y, si eres el líder, su botón
      state.players.forEach(p => { 
        const d = document.createElement('div'); 
        d.className = 'player-pill' + (p.id === state.leaderId ? ' leader' : '') + (p.ready ? ' ready' : ''); 
        
        // Creamos todo el HTML del jugador, pero SIN el botón de "100" para otros jugadores
        d.innerHTML = `
          <span class="dot"></span>
          <span class="name">${p.name}${p.id === state.leaderId ? ' 👑' : ''}</span>
          <span class="bal">${fmt(p.balance)}</span>
          `; // Aquí se eliminó la línea del botón de "100"
        hud.appendChild(d); 
      });

      // Ya no necesitamos adjuntar event listeners a los botones de "100"
      // porque han sido eliminados del DOM.
      // Si en el futuro agregas otros botones que necesiten listeners, deberás agregarlos aquí.
    }

    function updateSpinGating(){ const btn=$('btn-spin'); if(!btn) return; if (MODE==='mp' && MP.state){ const allReady = !!MP.state.allReady; const isLeader = MP.leader; const isRound  = !!MP.state.roundActive; btn.disabled = !(allReady && isLeader && !isRound); } else { btn.disabled = false; } }
    function connectSocket(){
      if(MP.socket) return MP.socket;
      if (typeof io === 'undefined') { toast('Socket.IO no cargado'); safeLog('Error: window.io undefined'); return null; }
      const isHttp = typeof location !== 'undefined' && /^https?:$/i.test(location.protocol);
      const proto = isHttp ? location.protocol : 'http:';
      const sameOriginPort = isHttp ? (location.port||'80') : '';
      const shouldUseExplicit = !isHttp || (sameOriginPort !== '3000');
      const host = (typeof location !== 'undefined' && location.hostname) ? location.hostname : 'localhost';
      const serverURL = shouldUseExplicit ? `${proto}//${host}:3000` : undefined;
      try { MP.socket = serverURL ? io(serverURL, { transports:['websocket','polling'] }) : io(); }
      catch (e) { safeLog('Fallo creando socket: '+(e?.message||e)); toast('No se pudo iniciar socket'); return null; }
      MP.socket.on('connect', ()=>{ safeLog(`Conectado a multiplayer (${MP.socket.id})`); });
      MP.socket.on('connect_error', (e)=>{ toast('Error de conexión'); safeLog('connect_error: '+(e?.message||e)); });
      MP.socket.on('error', (e)=>{ safeLog('socket error: '+(e?.message||e)); });
      MP.socket.on('mp:joined', ({ code, leader, you }) => {
        MP.code=code; MP.you=you; MP.leader=!!leader;
        if (leader) {
          if (codeSpan) codeSpan.textContent = code;
          if (codeBox) codeBox.style.display='block';
          if (btnEnterRoom) btnEnterRoom.style.display='inline-block';
          const joinInput = document.getElementById('mp-room-code'); if(joinInput) joinInput.value = code;
          safeLog('Sala creada: '+code);
        } else { overlay.style.display='none'; }
      });
      MP.socket.on('mp:state', (state) => {
        MP.state = state;
        MP.leader = state.leaderId === MP.you;

        const self = state.players.find(p => p.id === MP.you);
        MP.spectator = !!(self && self.spectator);

        const me = state.players.find(p => p.id === MP.you);
        if (me) { balance = me.balance; updateHeader(); }

        // Re-pintamos HUD y actualizamos el gating del botón "GIRAR"
        renderHud(state);
        updateSpinGating();

        // Si eres líder, convierte el "nombre" de cada jugador en un botón que da +100 €
        if (MP.leader) {
          try {
            const pills = Array.from(document.querySelectorAll('#playersHud .player-pill'));
            let idx = 0;
            pills.forEach(pill => {
              // Omitir la "píldora" de la sala (la que muestra el código)
              if (pill.querySelector('#hud-room-code')) return;

              const p = state.players[idx++]; 
              if (!p) return;

              const nameEl = pill.querySelector('.name');
              if (!nameEl) return;

              const btn = document.createElement('button');
              btn.className = 'btn';
              btn.style.cssText = 'padding:2px 6px;font-size:12px;line-height:1;margin-right:6px;cursor:pointer';
              btn.title = 'Dar +100 € a este jugador';
              // Conserva el icono de líder en el texto si corresponde
              btn.textContent = `${p.name}${p.id === state.leaderId ? ' 👑' : ''}`;

              btn.onclick = (ev) => {
                ev.stopPropagation();
                try { MP.socket.emit('mp:grant100', { code: MP.code, playerId: p.id }); } catch {}
              };

              nameEl.replaceWith(btn);
            });
          } catch {}
        }
      });

      // Acks varias: grant100 (líder) y selfRecharge (todos)
      MP.socket.on('mp:ack', (payload) => {
        try {
          if (payload?.action === 'grant100' && payload.ok && MP.leader) {
            toast(`+100 € añadidos`);
          }
          if (false && payload?.action === 'selfRecharge') {
            const btn = MP.rechargeBtn && document.getElementById('btn-sp-recharge');
            if (payload.ok) {
              toast(`+100 € añadidos`);
              // Aplicar cooldown visual de 30s si viene indicado
              if (typeof payload.nextAt === 'number') {
                MP.nextRechargeAt = payload.nextAt;
                if (btn) {
                  btn.disabled = true;
                  const tick = () => {
                    const now = Date.now();
                    if (now >= MP.nextRechargeAt) {
                      btn.disabled = false;
                      btn.title = 'Añadir 100';
                    } else {
                      const s = Math.ceil((MP.nextRechargeAt - now)/1000);
                      btn.title = `Renovar en ${s}s`;
                      setTimeout(tick, 250);
                    }
                  };
                  tick();
                }
              }
            } else {
              const ms = Math.max(0, payload?.cooldownMs||0);
              if (ms>0) {
                const s = Math.ceil(ms/1000);
                toast(`Espera ${s}s para renovar`);
                MP.nextRechargeAt = Date.now() + ms;
                if (btn) btn.title = `Renovar en ${s}s`;
              } else if (payload?.error) {
                toast('Error al renovar');
              }
            }
          }
        } catch {}
      });
      MP.socket.on('mp:error', (e)=> { toast(e?.message||'Error MP'); });
      MP.socket.on('mp:spin', async ({ number })=>{ 
        roundActive = false; 
        toggleControls(true); 
        try { await Wheel2D.spinTo(number); } catch(e){} 
        try { MP.socket.emit('mp:landed', { code: MP.code, number }); } catch {}
      });
      MP.socket.on('mp:result', ({ number, winners, players })=>{
        while(bets.length) bets.pop(); sumById.clear(); document.querySelectorAll('.sum').forEach(s=>{s.style.display='none'; s.textContent='0.00';});
        const me = players.find(p=>p.id===MP.you); if(me){ balance = me.balance; }
        pushHistory(number);
        const color = number===0 ? 'verde' : (REDS.has(number)?'rojo':'negro');
        safeLog(`[MP] Ganador: ${number} (${color}).`);
        try {
          const myWin = (winners||[]).find(w=>w.playerId===MP.you)?.winAmount||0;
          if (myWin>0) {
            safeLog(`[MP] Ganancia: ${fmt(myWin)}`);
          } else {
            safeLog(`[MP] Ganancia: 0,00`);
          }
        } catch {}
        roundActive = true; toggleControls(false); updateHeader();
      });
      // Notificación en el líder de solicitudes de +100
      MP.socket.on('mp:req:100', ({ playerId, name })=>{
        try {
          let island = document.getElementById('grant-island');
          if (!island){
            island = document.createElement('div');
            island.id = 'grant-island';
            island.style.cssText = 'position:fixed;top:10px;right:10px;z-index:99999;background:#0b0e13;border:1px solid #273047;color:#e8edf2;padding:8px 12px;border-radius:10px;box-shadow:0 6px 20px rgba(0,0,0,.4);cursor:pointer;font:600 13px system-ui;';
            document.body.appendChild(island);
          }
          island.textContent = `⚠ Solicitud +100: ${name}`;
          island.onclick = () => {
            try { MP.socket.emit('mp:grant100', { code: MP.code, playerId }); safeLog(`MP(líder): +100 otorgado a ${name}`); } catch{}
            try { island.remove(); } catch{}
          };
        } catch{}
      });
      return MP.socket;
    }
    if (btnCreate){ btnCreate.onclick = () => { MODE='mp'; const name = (document.getElementById('mp-name-create')?.value||'').trim()||'Jugador'; const privacy = document.getElementById('mp-privacy')?.value||'public'; const s = connectSocket(); if(!s){ toast('No se pudo iniciar socket'); return; } try{ s.emit('mp:createRoom', { name, privacy }); }catch(e){ safeLog('emit error createRoom: '+(e?.message||e)); } }; }
    if (btnJoin){ btnJoin.onclick = () => { MODE='mp'; const name = (document.getElementById('mp-name-join')?.value||'').trim()||'Jugador'; const code = (document.getElementById('mp-room-code')?.value||'').trim(); if(!code){ toast('Ingresa código de sala'); return; } const s = connectSocket(); if(!s){ toast('No se pudo iniciar socket'); return; } try{ s.emit('mp:joinRoom', { name, code }); }catch(e){ safeLog('emit error joinRoom: '+(e?.message||e)); } }; }
    if (btnCopyCreated){ btnCopyCreated.onclick = async () => { const code = codeSpan?.textContent?.trim(); if(!code) return; try { await navigator.clipboard.writeText(code); toast('Código copiado'); } catch { const tmp=document.createElement('input'); tmp.value=code; document.body.appendChild(tmp); tmp.select(); document.execCommand('copy'); tmp.remove(); toast('Código copiado'); } }; }
    if (btnEnterRoom){ btnEnterRoom.onclick = () => { overlay.style.display='none'; } }

    if (btnAllIn){ btnAllIn.onclick = () => {
      if (!roundActive){ toast('Ronda en curso.'); return; }
      if (balance<=0){ toast('Saldo insuficiente'); return; }
      enterAllIn(); toast('Haz clic en una casilla para ALL‑IN');
    }; }
  });
  // ========================= Init =========================
  updateHeader();
  log('Listo para jugar');
})();
/* ===================== RUEDA 2D — MÓDULO ===================== */
const Wheel2D = (() => {
  // Orden europeo y colores
  const ORDER = [0,32,15,19,4,21,2,25,17,34,6,27,13,36,11,30,8,23,10,5,24,16,33,1,20,14,31,9,22,18,29,7,28,12,35,3,26];
  const REDS  = new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);
  const STEP  = 360 / 37;
  let $c, ctx, currentRot = 0, drew = false;
  const norm = d => ((d % 360) + 360) % 360;
  function pxRatio() { return window.devicePixelRatio || 1; }
  function sizeCanvas() {
    if (!$c) return;
    const r = $c.getBoundingClientRect();
    const dpr = pxRatio();
    const size = Math.round(Math.min(r.width, r.height) * dpr);
    if ($c.width !== size || $c.height !== size) { $c.width = size; $c.height = size; drew = false; draw(); }
  }
  function draw() {
    if (!$c) return; if (drew) return; drew = true;
    const dpr = pxRatio();
    const w = $c.width / dpr, h = $c.height / dpr;
    const cx = w/2, cy = h/2; const R  = Math.min(cx, cy) - 8;
    ctx.setTransform(dpr,0,0,dpr,0,0); ctx.clearRect(0,0,w,h);
    // disco base
    ctx.beginPath(); ctx.arc(cx,cy,R,0,Math.PI*2); ctx.fillStyle = '#0d1118'; ctx.fill();
    // gajos + separadores
    const sep = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--cw-sep')) || 0.7;
    for (let i=0;i<37;i++){
      const n = ORDER[i]; const a0 = (-90 + i*STEP) * Math.PI/180; const a1 = (-90 + (i+1)*STEP) * Math.PI/180; const aSep = (-90 + (i+1)*STEP - sep) * Math.PI/180;
      ctx.beginPath(); ctx.moveTo(cx,cy); ctx.arc(cx,cy,R,a0,aSep); ctx.closePath(); ctx.fillStyle = (n===0) ? '#18a252' : (REDS.has(n) ? '#c1121f' : '#171b24'); ctx.fill();
      ctx.beginPath(); ctx.moveTo(cx,cy); ctx.arc(cx,cy,R,aSep,a1); ctx.closePath(); ctx.fillStyle = '#0a0f15'; ctx.fill();
    }
    // aro interior
    ctx.beginPath(); ctx.arc(cx,cy,R*0.60,0,Math.PI*2); ctx.fillStyle = '#0d1118'; ctx.fill();
    // números
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.font = `${Math.max(10, Math.floor(R*0.08))}px system-ui, -apple-system, Segoe UI, Inter, Roboto, Arial`;
    for (let i=0;i<37;i++){
      const n = ORDER[i]; const mid = (-90 + i*STEP + STEP/2) * Math.PI/180; const rText = R * 0.82; const tx = cx + Math.cos(mid) * rText; const ty = cy + Math.sin(mid) * rText;
      ctx.save(); ctx.translate(tx,ty); ctx.rotate(mid + Math.PI/2); ctx.fillStyle = (n===0) ? '#eaffea' : '#f6f8ff'; ctx.fillText(String(n), 0, 0); ctx.restore();
    }
  }
  function spin() { const idx = Math.floor(Math.random() * ORDER.length); return spinTo(ORDER[idx]); }
  function spinTo(number){
    const idx = ORDER.indexOf(number);
    if (idx < 0) return Promise.resolve(null);
    // Centro del sector visible teniendo en cuenta que el dibujo empieza a -90°
    const targetAngle = 270 - (idx * STEP + STEP / 2) + 90;

    const normalizedTargetAngle = norm(targetAngle);

    // Diferencia angular desde la rotación actual normalizada
    const delta = (normalizedTargetAngle - norm(currentRot) + 360) % 360;
    // Vueltas extra para animación
    const extra = 6 + Math.floor(Math.random() * 3);
    const final = currentRot + extra * 360 + delta;
    return new Promise(res => {
      $c.style.transform = `rotate(${final}deg)`;
      const onEnd = () => {
        $c.removeEventListener('transitionend', onEnd);
        currentRot = final;
        res(number); // aterriza exactamente en el número solicitado
      };
      $c.addEventListener('transitionend', onEnd, { once: true });
    });
  }
  function init(selector = '#wheel2d'){
    $c = document.querySelector(selector); if (!$c) return console.warn('[Wheel2D] No se encontró el canvas');
    ctx = $c.getContext('2d'); sizeCanvas(); draw(); window.addEventListener('resize', sizeCanvas, {passive:true});
  }
  // Reasigna spin para que el número lo determine la posición final aleatoria
  const angleToIndex = (deg) => {
    // Pasamos a un frame donde 0° corresponde al -90° del dibujo
    const normalizedAngle = norm(deg) % 360 + 270;
    const rel = (270 - normalizedAngle + 360) % 360;      // compensa el -90°
    const a   = (360 - rel) % 360;            // porque la rueda rota CW
    const index = Math.floor(rel / STEP);
    return index;
  };
  let _spin = spin; // keep ref if needed
  spin = function(){
    const extra = 6 + Math.floor(Math.random() * 3);
    const jitter = Math.random() * 360;
    const final  = currentRot + extra * 360 + jitter;
    return new Promise(res => {
      $c.style.transform = `rotate(${final}deg)`;
      const onEnd = () => {
        $c.removeEventListener('transitionend', onEnd);
        currentRot = final;
        const idx = angleToIndex(currentRot);
        res(ORDER[idx]);
      };
      $c.addEventListener('transitionend', onEnd, { once: true });
    });
  };
  return { init, spin, spinTo, order: ORDER, isRed: n => REDS.has(n) };
})();
