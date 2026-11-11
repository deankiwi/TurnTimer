'use strict';

/*
 * TurnTimer client.
 *
 * The server owns all time. On every 'state' message we store the snapshot and
 * the clock offset (serverNow - Date.now()); a requestAnimationFrame loop then
 * paints the numbers by interpolating the one running clock locally. No timing
 * decision is made here.
 */

const app = document.getElementById('app');
const banner = document.getElementById('banner');

const LS = {
  name: 'turntimer:name',
  tok: (id) => `turntimer:tok:${id}`,
};

const G = {
  ws: null,
  connected: false,
  retry: 0,
  lobbyId: null,
  token: null,
  playerId: null,
  isHost: false,
  state: null, // last lobby snapshot
  offset: 0, // serverNow - Date.now()
  sig: null, // structural signature of the rendered DOM
  view: null, // 'create' | 'join' | 'lobby' | 'game'
  dead: null, // fatal message, stops the app
};

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

function lobbyIdFromPath() {
  const m = location.pathname.match(/^\/l\/([A-Za-z0-9_-]+)$/);
  return m ? m[1] : null;
}

function go(path) {
  history.pushState(null, '', path);
  route();
}

window.addEventListener('popstate', route);

function route() {
  G.dead = null;
  const id = lobbyIdFromPath();
  if (!id) {
    teardownWs();
    G.lobbyId = null;
    renderCreate();
    return;
  }
  G.lobbyId = id;
  G.token = localStorage.getItem(LS.tok(id));
  if (!G.token) {
    // Need a name before joining.
    renderJoin();
    return;
  }
  connect();
}

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------

function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws?lobby=${encodeURIComponent(G.lobbyId || 'new')}`;
}

function teardownWs() {
  if (G.ws) {
    G.ws.onopen = G.ws.onclose = G.ws.onmessage = G.ws.onerror = null;
    try { G.ws.close(); } catch (_) {}
    G.ws = null;
  }
  G.connected = false;
}

function connect() {
  teardownWs();
  const ws = new WebSocket(wsUrl());
  G.ws = ws;

  ws.onopen = () => {
    G.connected = true;
    G.retry = 0;
    hideBanner();
    if (G.lobbyId) {
      send({ type: 'hello', lobbyId: G.lobbyId, token: G.token || undefined });
    } else if (pendingCreate) {
      send(pendingCreate);
    }
  };

  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    onServerMessage(msg);
  };

  ws.onclose = () => {
    G.connected = false;
    if (G.dead) return;
    G.retry++;
    showBanner('Reconnecting…', 'info');
    const wait = Math.min(8000, 400 * 2 ** Math.min(G.retry, 4));
    setTimeout(() => {
      if (G.dead) return;
      if (G.lobbyId || pendingCreate) connect();
    }, wait);
  };

  ws.onerror = () => {};
}

function send(obj) {
  if (G.ws && G.ws.readyState === WebSocket.OPEN) G.ws.send(JSON.stringify(obj));
}

let pendingCreate = null;

function onServerMessage(msg) {
  switch (msg.type) {
    case 'created':
    case 'joined': {
      pendingCreate = null;
      G.lobbyId = msg.lobbyId;
      G.token = msg.token;
      G.playerId = msg.playerId;
      localStorage.setItem(LS.tok(msg.lobbyId), msg.token);
      if (lobbyIdFromPath() !== msg.lobbyId) {
        history.replaceState(null, '', `/l/${msg.lobbyId}`);
      }
      return;
    }
    case 'state': {
      G.state = msg.lobby;
      G.playerId = msg.you.playerId;
      G.isHost = msg.you.isHost;
      G.offset = msg.serverNow - Date.now();
      renderFromState();
      return;
    }
    case 'error': {
      G.dead = msg.error;
      teardownWs();
      renderDead(msg.error);
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

function serverNow() {
  return Date.now() + G.offset;
}

// Remaining ms for player at index `i`, interpolating the running clock.
function remainingMs(i) {
  const s = G.state;
  const p = s.players[i];
  if (!p) return 0;
  let ms = p.timeLeftMs;
  if (s.started && !s.paused && i === s.currentIndex && s.turnStartedAt != null) {
    ms = p.timeLeftMs - (serverNow() - s.turnStartedAt);
  }
  return Math.max(0, ms);
}

function fmt(ms) {
  const t = Math.max(0, ms);
  if (t < 10_000) return (t / 1000).toFixed(1);
  const total = Math.ceil(t / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return `${h ? h + ':' : ''}${mm}:${String(sec).padStart(2, '0')}`;
}

function fmtSeconds(ms) {
  const sec = Math.round(ms / 1000);
  return (sec < 0 ? '−' : '+') + Math.abs(sec) + 's';
}

function fmtMinutes(ms) {
  const m = ms / 60000;
  return Number.isInteger(m) ? String(m) : m.toFixed(2).replace(/\.?0+$/, '');
}

// Players controlled by this phone.
function isMine(p) {
  return p && p.deviceId === G.playerId;
}

// ---------------------------------------------------------------------------
// Banner
// ---------------------------------------------------------------------------

function showBanner(text, kind) {
  banner.textContent = text;
  banner.className = kind === 'info' ? 'info' : '';
  banner.hidden = false;
}
function hideBanner() {
  banner.hidden = true;
}

// ---------------------------------------------------------------------------
// Rendering — create / join / dead
// ---------------------------------------------------------------------------

function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

function renderCreate() {
  G.view = 'create';
  G.sig = null;
  const name = localStorage.getItem(LS.name) || '';
  app.innerHTML = '';
  app.appendChild(el(`
    <div class="hero">
      <h1>⏱️ TurnTimer</h1>
      <p class="tagline">Online multiplayer chess clock</p>
    </div>
  `));
  app.appendChild(el(`
    <ol class="steps">
      <li><strong>Create lobby</strong></li>
      <li><strong>Share the link.</strong> Other devices can join.</li>
      <li><strong>Start game</strong></li>
    </ol>
  `));
  const card = el(`
    <div class="card">
      <h2>New game</h2>
      <label for="c-name">Your name</label>
      <input id="c-name" type="text" maxlength="24" placeholder="e.g. Dean" />
      <label for="c-time">Time per player (minutes)</label>
      <input id="c-time" type="number" min="0.5" step="0.5" value="10" inputmode="decimal" />
      <label for="c-inc">Increment per turn (seconds)</label>
      <input id="c-inc" type="number" min="0" max="600" step="1" value="0" inputmode="numeric" />
      <label for="c-max">Max players</label>
      <input id="c-max" type="number" min="2" max="16" step="1" value="6" inputmode="numeric" />
      <div class="btn-row" style="margin-top:16px">
        <button class="btn-primary" id="c-go" style="flex:1">Create lobby</button>
      </div>
      <p class="small muted" id="c-msg" style="margin-top:10px"></p>
    </div>
  `);
  card.querySelector('#c-name').value = name;
  card.querySelector('#c-go').onclick = () => {
    const nm = card.querySelector('#c-name').value.trim();
    if (!nm) { card.querySelector('#c-msg').textContent = 'Enter your name first.'; return; }
    localStorage.setItem(LS.name, nm);
    pendingCreate = {
      type: 'create',
      name: nm,
      minutes: parseFloat(card.querySelector('#c-time').value) || 10,
      incrementSeconds: parseInt(card.querySelector('#c-inc').value, 10) || 0,
      maxPlayers: parseInt(card.querySelector('#c-max').value, 10) || 6,
    };
    card.querySelector('#c-go').disabled = true;
    card.querySelector('#c-msg').textContent = 'Creating…';
    connect();
  };
  app.appendChild(card);
  app.appendChild(el(`<div class="spacer"></div>`));
  app.appendChild(el(`<div class="footer">No sign-up, no app to install.</div>`));
  app.appendChild(feedbackLink());
}

function renderJoin() {
  G.view = 'join';
  G.sig = null;
  const name = localStorage.getItem(LS.name) || '';
  app.innerHTML = '';
  app.appendChild(el(`<div><h1>⏱️ TurnTimer</h1><p class="muted">Join game <code>${G.lobbyId}</code></p></div>`));
  const card = el(`
    <div class="card">
      <h2>Your name</h2>
      <input id="j-name" type="text" maxlength="24" placeholder="e.g. Sam" />
      <div class="btn-row" style="margin-top:14px">
        <button class="btn-primary" id="j-go" style="flex:1">Join</button>
      </div>
      <p class="small muted" id="j-msg" style="margin-top:10px"></p>
    </div>
  `);
  card.querySelector('#j-name').value = name;
  const submit = () => {
    const nm = card.querySelector('#j-name').value.trim();
    if (!nm) { card.querySelector('#j-msg').textContent = 'Enter your name first.'; return; }
    localStorage.setItem(LS.name, nm);
    G.pendingName = nm;
    card.querySelector('#j-go').disabled = true;
    card.querySelector('#j-msg').textContent = 'Joining…';
    // connect() then send hello with the name (no token yet)
    const once = () => {
      send({ type: 'hello', lobbyId: G.lobbyId, name: nm });
    };
    G.token = null;
    connectThen(once);
  };
  card.querySelector('#j-go').onclick = submit;
  card.querySelector('#j-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  app.appendChild(card);
}

// connect and run fn once open (used by the join screen to send a named hello)
function connectThen(fn) {
  teardownWs();
  const ws = new WebSocket(wsUrl());
  G.ws = ws;
  ws.onopen = () => { G.connected = true; G.retry = 0; hideBanner(); fn(); };
  ws.onmessage = (ev) => { let m; try { m = JSON.parse(ev.data); } catch { return; } onServerMessage(m); };
  ws.onclose = () => {
    G.connected = false;
    if (G.dead) return;
    G.retry++;
    showBanner('Reconnecting…', 'info');
    setTimeout(() => { if (!G.dead && G.lobbyId) connect(); }, Math.min(8000, 400 * 2 ** Math.min(G.retry, 4)));
  };
  ws.onerror = () => {};
}

function renderDead(text) {
  G.view = 'dead';
  G.sig = null;
  app.innerHTML = '';
  app.appendChild(el(`
    <div class="card">
      <h2>Can't continue</h2>
      <p>${escapeHtml(text)}</p>
      <div class="btn-row" style="margin-top:12px">
        <button class="btn-primary" id="d-home">Back to start</button>
      </div>
    </div>
  `));
  app.querySelector('#d-home').onclick = () => {
    if (G.lobbyId) localStorage.removeItem(LS.tok(G.lobbyId));
    go('/');
  };
}

// ---------------------------------------------------------------------------
// Rendering — lobby setup + game (signature-gated rebuild)
// ---------------------------------------------------------------------------

function structuralSig() {
  const s = G.state;
  return JSON.stringify({
    v: s.started ? 'game' : 'lobby',
    paused: s.paused,
    pausedBy: s.pausedByName,
    cur: s.currentIndex,
    host: s.hostPlayerId,
    max: s.maxPlayers,
    def: s.defaultTimeMs,
    inc: s.incrementMs,
    isHost: G.isHost,
    me: G.playerId,
    players: s.players.map((p) => [p.id, p.deviceId, p.name, p.baseTimeMs, p.connected]),
  });
}

function renderFromState() {
  if (!G.state) return;
  const sig = structuralSig();
  if (sig !== G.sig) {
    G.sig = sig;
    // A rebuild (e.g. someone joining) must not eat a half-typed value.
    const f = document.activeElement;
    const keep = f && f.dataset && f.dataset.key ? { key: f.dataset.key, value: f.value } : null;
    if (G.state.started) buildGame();
    else buildLobby();
    const added = G.addedFrom != null && G.state.players.filter(isMine).length > G.addedFrom;
    if (added) {
      // Just added a player on this device: jump into its name box.
      G.addedFrom = null;
      const boxes = app.querySelectorAll('.dgroup.mine input.name');
      const inp = boxes[boxes.length - 1];
      if (inp) { inp.focus(); inp.select(); }
    } else if (keep) {
      const inp = app.querySelector(`input[data-key="${keep.key}"]`);
      if (inp) { inp.value = keep.value; inp.focus(); }
    }
  }
  paint();
}

// ---- lobby setup ----

function buildLobby() {
  const s = G.state;
  G.view = 'lobby';
  app.innerHTML = '';

  app.appendChild(el(`<div><h1>⏱️ Lobby</h1></div>`));

  // Share link
  const url = `${location.origin}/l/${s.id}`;
  const share = el(`
    <div class="card">
      <h2>Invite players</h2>
      <div class="link-row">
        <input id="share-url" type="text" readonly value="${url}" />
        <button id="share-copy">Copy</button>
      </div>
      <p class="small muted" style="margin-top:8px">Send this link. It opens the game on their phone.</p>
    </div>
  `);
  share.querySelector('#share-copy').onclick = async () => {
    const btn = share.querySelector('#share-copy');
    if (await copyText(url)) {
      btn.textContent = 'Copied';
    } else {
      // Leave it selected so the user can copy by hand.
      const inp = share.querySelector('#share-url');
      inp.focus();
      inp.setSelectionRange(0, url.length);
      btn.textContent = 'Select & copy';
    }
    setTimeout(() => { if (btn.isConnected) btn.textContent = 'Copy'; }, 1500);
  };
  app.appendChild(share);

  // Settings (host) / summary (others)
  if (G.isHost) {
    const set = el(`
      <div class="card">
        <h2>Settings</h2>
        <div class="field-inline">
          <input id="set-time" type="number" min="0.5" step="0.5" inputmode="decimal" />
          <span class="muted small">default minutes / player</span>
        </div>
        <div class="field-inline" style="margin-top:8px">
          <input id="set-inc" type="number" min="0" max="600" step="1" inputmode="numeric" />
          <span class="muted small">increment seconds / turn</span>
        </div>
        <div class="field-inline" style="margin-top:8px">
          <input id="set-max" type="number" min="2" max="16" step="1" inputmode="numeric" />
          <span class="muted small">max players</span>
        </div>
      </div>
    `);
    set.querySelector('#set-time').value = fmtMinutes(s.defaultTimeMs);
    set.querySelector('#set-inc').value = String(Math.round(s.incrementMs / 1000));
    set.querySelector('#set-max').value = String(s.maxPlayers);
    set.querySelector('#set-time').onchange = (e) => send({ type: 'setDefaultTime', minutes: parseFloat(e.target.value) });
    set.querySelector('#set-inc').onchange = (e) => send({ type: 'setIncrement', seconds: parseInt(e.target.value, 10) });
    set.querySelector('#set-max').onchange = (e) => send({ type: 'setMaxPlayers', value: parseInt(e.target.value, 10) });
    app.appendChild(set);
  } else {
    app.appendChild(el(`
      <div class="card small muted">
        ${fmtMinutes(s.defaultTimeMs)} min/player · +${Math.round(s.incrementMs / 1000)}s per turn · up to ${s.maxPlayers} players
      </div>
    `));
  }

  // Player list, one block per device
  const listCard = el(`<div class="card"><h2>Players & turn order</h2><div class="plist" id="plist"></div></div>`);
  const list = listCard.querySelector('#plist');
  const groups = [];
  s.players.forEach((p, i) => {
    const last = groups[groups.length - 1];
    if (last && last.deviceId === p.deviceId) last.items.push({ p, i });
    else groups.push({ deviceId: p.deviceId, items: [{ p, i }] });
  });
  groups.forEach((g, gi) => {
    const mineGroup = g.deviceId === G.playerId;
    const owner = s.players.find((p) => p.id === g.deviceId);
    const box = el(`<div class="dgroup ${mineGroup ? 'mine' : ''}"></div>`);
    if (mineGroup || g.items.length > 1) {
      const cap = el(`<div class="dcap small"></div>`);
      cap.textContent = mineGroup ? 'Your device' : `${owner ? owner.name : 'Unknown'}'s device`;
      box.appendChild(cap);
    }
    g.items.forEach(({ p, i }, k) => {
      const primary = p.id === p.deviceId;
      const isHost = p.id === s.hostPlayerId;
      const row = el(`
        <div class="prow ${isHost ? 'host' : ''} ${p.connected ? '' : 'offline'}">
          <span class="idx">${i + 1}</span>
          <span class="pname"></span>
        </div>
      `);
      const nameSpan = row.querySelector('.pname');
      if (mineGroup) {
        const inp = el(`<input class="name" type="text" maxlength="24" />`);
        inp.value = p.name;
        inp.dataset.key = `name:${p.id}`;
        inp.style.flex = '1';
        inp.onchange = () => {
          const v = inp.value.trim();
          if (!v) return;
          if (primary) localStorage.setItem(LS.name, v);
          send({ type: 'setName', playerId: p.id, name: v });
        };
        row.replaceChild(inp, nameSpan);
      } else {
        nameSpan.textContent = p.name;
      }

      // Host taps the time itself to change it (an input styled as text).
      if (G.isHost) {
        const time = el(`
          <label class="ptime-edit" title="Minutes for this player">
            <input type="number" min="0.5" step="0.5" inputmode="decimal" /><span>m</span>
          </label>
        `);
        const inp = time.querySelector('input');
        inp.value = fmtMinutes(p.baseTimeMs);
        inp.dataset.key = `time:${p.id}`;
        inp.onfocus = () => inp.select();
        inp.onkeydown = (e) => { if (e.key === 'Enter') inp.blur(); };
        inp.onchange = () => {
          const v = parseFloat(inp.value);
          if (Number.isFinite(v)) send({ type: 'setPlayerTime', playerId: p.id, minutes: v });
          else inp.value = fmtMinutes(p.baseTimeMs);
        };
        row.appendChild(time);
      } else {
        const time = el(`<span class="ptime"></span>`);
        time.textContent = fmtMinutes(p.baseTimeMs) + 'm';
        row.appendChild(time);
      }

      const ctl = el(`<span class="ctl"></span>`);
      // Reordering moves the whole device, so the arrows sit on its first row.
      if (G.isHost && k === 0) {
        const up = el(`<button class="mini" ${gi === 0 ? 'disabled' : ''}>↑</button>`);
        const dn = el(`<button class="mini" ${gi === groups.length - 1 ? 'disabled' : ''}>↓</button>`);
        up.onclick = () => send({ type: 'move', playerId: p.id, dir: -1 });
        dn.onclick = () => send({ type: 'move', playerId: p.id, dir: 1 });
        ctl.appendChild(up);
        ctl.appendChild(dn);
      }
      const canRemove = !isHost && p.id !== G.playerId && ((mineGroup && !primary) || G.isHost);
      if (canRemove) {
        const kick = el(`<button class="mini btn-danger">✕</button>`);
        const extra = primary && g.items.length > 1 ? ' and everyone on their device' : '';
        kick.title = `Remove ${p.name}${extra}`;
        confirmTap(kick, 'Remove?', () => send({ type: 'kick', playerId: p.id }));
        ctl.appendChild(kick);
      }
      if (ctl.children.length) row.appendChild(ctl);
      box.appendChild(row);
    });
    if (mineGroup) {
      const full = s.players.length >= s.maxPlayers;
      const add = el(`<button class="addbtn" ${full ? 'disabled' : ''}>+ Add player to this device</button>`);
      add.onclick = () => {
        // Server names them "Player N"; they rename in place.
        G.addedFrom = s.players.filter(isMine).length;
        send({ type: 'addLocalPlayer' });
      };
      box.appendChild(add);
      if (full) box.appendChild(el(`<div class="small muted">Lobby is full (max ${s.maxPlayers}).</div>`));
    }
    list.appendChild(box);
  });
  app.appendChild(listCard);

  app.appendChild(el(`<div class="spacer"></div>`));

  if (G.isHost) {
    const canStart = s.players.length >= 2;
    const startBtn = el(`<button class="bigbtn" ${canStart ? '' : 'disabled'}>START GAME</button>`);
    startBtn.onclick = () => send({ type: 'start' });
    app.appendChild(startBtn);
    if (!canStart) app.appendChild(el(`<div class="footer">Need at least 2 players to start.</div>`));
  } else {
    app.appendChild(el(`<div class="footer">Waiting for the host to start…</div>`));
  }
  app.appendChild(feedbackLink());
}

// ---- game ----

function buildGame() {
  const s = G.state;
  G.view = 'game';
  app.innerHTML = '';

  const wrap = el(`<div class="game"></div>`);

  const turnbox = el(`
    <div class="turnbox" id="turnbox">
      <div class="who" id="tb-who"></div>
      <div class="bigtime" id="tb-time">0:00</div>
      <div class="status" id="tb-status"></div>
    </div>
  `);
  wrap.appendChild(turnbox);

  const bigBtn = el(`<button class="bigbtn" id="endturn">END TURN</button>`);
  bigBtn.onclick = () => send({ type: 'endTurn' });
  wrap.appendChild(bigBtn);

  const subs = el(`<div class="subbtns"></div>`);
  const pauseBtn = el(`<button class="pausebtn" id="pausebtn">PAUSE</button>`);
  pauseBtn.onclick = () => send({ type: s.paused ? 'resume' : 'pause' });
  subs.appendChild(pauseBtn);
  wrap.appendChild(subs);

  const others = el(`<div class="others" id="others"></div>`);
  let box = null;
  s.players.forEach((p, i) => {
    // Same per-device boxes as the pause screen, blue for this one.
    if (!box || p.deviceId !== s.players[i - 1].deviceId) {
      box = el(`<div class="tgroup ${isMine(p) ? 'mine' : ''}"></div>`);
      others.appendChild(box);
    }
    const row = el(`
      <div class="orow" data-i="${i}">
        <span class="dot"></span>
        <span class="oname"></span>
        <span class="tag out" hidden>flag</span>
        <span class="otime">0:00</span>
      </div>
    `);
    row.querySelector('.oname').textContent = p.name + (p.id === G.playerId ? ' (you)' : '');
    box.appendChild(row);
  });
  wrap.appendChild(others);

  // Host controls live below the list, well away from END TURN.
  if (G.isHost) {
    const hostRow = el(`<div class="hostbtns"></div>`);
    const skipBtn = el(`<button id="skipbtn">SKIP</button>`);
    skipBtn.onclick = () => send({ type: 'endTurn' });
    const lobbyBtn = el(`<button id="lobbybtn">RETURN TO LOBBY</button>`);
    confirmTap(lobbyBtn, 'TAP AGAIN TO STOP GAME', () => send({ type: 'reset' }));
    hostRow.appendChild(skipBtn);
    hostRow.appendChild(lobbyBtn);
    wrap.appendChild(hostRow);
  }

  app.appendChild(wrap);

  // Pause overlay lives outside the game wrap so it can cover the screen.
  let overlay = document.getElementById('pause-overlay');
  if (overlay) overlay.remove();
}

// ---------------------------------------------------------------------------
// paint() — cheap per-frame updates, no DOM structure changes
// ---------------------------------------------------------------------------

function paint() {
  if (!G.state) return;
  if (G.state.started) paintGame();
  else paintLobby();
}

function paintLobby() {
  const list = document.getElementById('plist');
  if (!list) return;
  const rows = list.querySelectorAll('.prow .ptime');
  G.state.players.forEach((p, i) => {
    if (rows[i]) rows[i].textContent = fmtMinutes(p.baseTimeMs) + 'm';
  });
}

function paintGame() {
  const s = G.state;
  const current = s.players[s.currentIndex];
  const myTurn = isMine(current);
  const mineCount = s.players.filter(isMine).length;

  // Big box shows this device's player who is up now, else whichever of them
  // plays next (or, if you're only spectating, the current player's clock).
  let me = -1;
  for (let k = 0; k < s.players.length && me < 0; k++) {
    const i = (s.currentIndex + k) % s.players.length;
    if (isMine(s.players[i])) me = i;
  }
  const focusIdx = me >= 0 ? me : s.currentIndex;
  const myMs = remainingMs(focusIdx);

  const turnbox = document.getElementById('turnbox');
  const tbWho = document.getElementById('tb-who');
  const tbTime = document.getElementById('tb-time');
  const tbStatus = document.getElementById('tb-status');
  if (turnbox) {
    tbWho.textContent = me < 0 ? `Spectating — ${current ? current.name : ''}`
      : mineCount > 1 ? `${s.players[me].name}'s time` : 'Your time';
    tbTime.textContent = fmt(myMs);
    turnbox.classList.toggle('myturn', myTurn && !s.paused);
    turnbox.classList.toggle('low', myMs > 0 && myMs <= 15_000);
    turnbox.classList.toggle('flag', myMs <= 0);
    if (s.paused) {
      tbStatus.textContent = 'Paused';
      tbStatus.className = 'status wait';
    } else if (myTurn) {
      tbStatus.textContent = mineCount > 1 ? `${current.name}'s turn` : 'Your turn';
      tbStatus.className = 'status mine';
    } else {
      tbStatus.textContent = current ? `${current.name}'s turn` : '';
      tbStatus.className = 'status wait';
    }
  }

  const endBtn = document.getElementById('endturn');
  if (endBtn) {
    endBtn.disabled = s.paused || !myTurn;
  }

  const skipBtn = document.getElementById('skipbtn');
  if (skipBtn) {
    skipBtn.disabled = s.paused;
    skipBtn.textContent = `SKIP ${current ? current.name.toUpperCase() : ''}`;
  }

  const pauseBtn = document.getElementById('pausebtn');
  if (pauseBtn) {
    pauseBtn.disabled = s.paused && s.resumeLocked && !G.isHost;
    pauseBtn.textContent = s.paused ? 'RESUME' : 'PAUSE';
    pauseBtn.classList.toggle('paused', s.paused);
  }

  const others = document.getElementById('others');
  if (others) {
    others.querySelectorAll('.orow').forEach((row) => {
      const i = +row.dataset.i;
      const ms = remainingMs(i);
      row.classList.toggle('current', i === s.currentIndex && !s.paused);
      row.classList.toggle('flag', ms <= 0);
      row.querySelector('.otime').textContent = fmt(ms);
      row.querySelector('.tag.out').hidden = ms > 0;
    });
  }

  // Full-screen pause overlay: everyone's clock, host can adjust them live.
  let overlay = document.getElementById('pause-overlay');
  if (s.paused && !overlay) {
    overlay = el(`
      <div class="paused-overlay" id="pause-overlay">
        <div class="big">PAUSED</div>
        <div class="muted" id="po-by"></div>
        <div class="ptable" id="po-table"></div>
        <button class="btn-primary" id="po-resume" style="padding:16px 28px;font-size:1.1rem">RESUME</button>
      </div>
    `);
    const table = overlay.querySelector('#po-table');
    let box = null;
    s.players.forEach((p, i) => {
      // One box per device, blue for this one.
      if (!box || p.deviceId !== s.players[i - 1].deviceId) {
        box = el(`<div class="tgroup ${isMine(p) ? 'mine' : ''}"></div>`);
        table.appendChild(box);
      }
      const row = el(`
        <div class="trow" data-i="${i}">
          <span class="tname"></span>
          <span class="tadj" hidden></span>
          <span class="tctl"></span>
        </div>
      `);
      row.querySelector('.tname').textContent = p.name;
      // Whose clock starts again on resume.
      if (i === s.currentIndex) row.classList.add('current');
      const ctl = row.querySelector('.tctl');
      const time = G.isHost
        ? el(`<button class="ttime editable" title="Add or subtract seconds"></button>`)
        : el(`<span class="ttime"></span>`);
      if (G.isHost) {
        const adjust = (seconds) => send({ type: 'adjustTime', playerId: p.id, seconds });
        const minus = el(`<button class="mini">−5</button>`);
        const plus = el(`<button class="mini">+5</button>`);
        minus.onclick = () => adjust(-5);
        plus.onclick = () => adjust(5);
        // Tapping the time swaps it for a box to type ± seconds into.
        const entry = el(`<input class="tedit" type="text" placeholder="±sec" hidden />`);
        const close = (apply) => {
          if (entry.hidden) return;
          const n = parseFloat(entry.value.replace('−', '-'));
          if (apply && Number.isFinite(n) && n !== 0) adjust(n);
          entry.hidden = true;
          time.hidden = false;
        };
        time.onclick = () => {
          time.hidden = true;
          entry.hidden = false;
          entry.value = '';
          entry.focus();
        };
        entry.onkeydown = (e) => {
          if (e.key === 'Enter') close(true);
          else if (e.key === 'Escape') close(false);
        };
        entry.onblur = () => close(true);
        ctl.appendChild(minus);
        ctl.appendChild(time);
        ctl.appendChild(entry);
        ctl.appendChild(plus);
      } else {
        ctl.appendChild(time);
      }
      box.appendChild(row);
    });
    overlay.querySelector('#po-resume').onclick = () => send({ type: 'resume' });
    document.body.appendChild(overlay);
  }
  if (overlay) {
    if (!s.paused) { overlay.remove(); }
    else {
      const by = overlay.querySelector('#po-by');
      by.textContent = s.pausedByName ? `by ${s.pausedByName}` : '';
      // Once the host starts adjusting, only they can resume.
      const locked = s.resumeLocked && !G.isHost;
      const resume = overlay.querySelector('#po-resume');
      resume.disabled = locked;
      resume.textContent = locked ? 'Waiting for admin to resume' : 'RESUME';
      overlay.querySelectorAll('.trow').forEach((row) => {
        const p = s.players[+row.dataset.i];
        if (!p) return;
        row.querySelector('.ttime').textContent = fmt(remainingMs(+row.dataset.i));
        const adj = row.querySelector('.tadj');
        adj.hidden = !p.adjustMs;
        adj.textContent = p.adjustMs ? fmtSeconds(p.adjustMs) : '';
        adj.classList.toggle('neg', p.adjustMs < 0);
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Animation loop
// ---------------------------------------------------------------------------

function loop() {
  if (G.state && (G.view === 'game' || G.view === 'lobby')) paint();
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

// Two-tap confirm instead of confirm(), which embedded browsers block:
// the first tap arms the button for a few seconds, the second one acts.
function confirmTap(btn, armedLabel, fn) {
  const label = btn.textContent;
  let timer = null;
  btn.onclick = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
      fn();
      return;
    }
    btn.textContent = armedLabel;
    btn.classList.add('armed');
    timer = setTimeout(() => {
      timer = null;
      btn.textContent = label;
      btn.classList.remove('armed');
    }, 3000);
  };
}

// The Clipboard API only exists on https/localhost, so on a LAN address
// (e.g. testing on a phone) fall back to the old execCommand route.
async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    try { await navigator.clipboard.writeText(text); return true; } catch (_) {}
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  // 16px stops iOS zooming in; off-screen so nothing flashes.
  ta.style.cssText = 'position:fixed;top:0;left:-9999px;font-size:16px;';
  document.body.appendChild(ta);
  ta.focus();
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try { ok = document.execCommand('copy'); } catch (_) {}
  ta.remove();
  return ok;
}

// ---------------------------------------------------------------------------
// Feedback
// ---------------------------------------------------------------------------

function feedbackLink() {
  const wrap = el(`<div class="footer"><button class="linkbtn">Send feedback</button></div>`);
  wrap.querySelector('button').onclick = openFeedback;
  return wrap;
}

// Lives on <body>, like the pause overlay, so lobby rebuilds don't close it.
function openFeedback() {
  if (document.getElementById('fb-modal')) return;
  // Built at click time so the address isn't sitting in the page for scrapers.
  const addr = ['me', 'deanw.dev'].join('@');
  const modal = el(`
    <div class="modal" id="fb-modal">
      <div class="card modal-card">
        <h2>Feedback</h2>
        <p>Would love to hear from you! Ideas, bugs, anything. Send an email to:</p>
        <div class="link-row">
          <input id="fb-addr" type="text" readonly />
          <button id="fb-copy">Copy</button>
        </div>
        <div class="btn-row" style="margin-top:16px">
          <button class="btn-ghost" id="fb-close">Close</button>
          <a class="btn-primary btn-link" id="fb-mail" style="flex:1">Open email app</a>
        </div>
      </div>
    </div>
  `);
  const $ = (id) => modal.querySelector(id);
  const close = () => modal.remove();
  $('#fb-addr').value = addr;
  $('#fb-mail').href = `mailto:${addr}?subject=${encodeURIComponent('TurnTimer feedback')}`;
  $('#fb-copy').onclick = async () => {
    const btn = $('#fb-copy');
    btn.textContent = (await copyText(addr)) ? 'Copied' : 'Select & copy';
    setTimeout(() => { if (btn.isConnected) btn.textContent = 'Copy'; }, 1500);
  };
  $('#fb-close').onclick = close;
  modal.onclick = (e) => { if (e.target === modal) close(); };
  document.body.appendChild(modal);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Wake lock is nice-to-have so the screen doesn't sleep mid-turn.
async function keepAwake() {
  try {
    if ('wakeLock' in navigator) {
      let lock = await navigator.wakeLock.request('screen');
      document.addEventListener('visibilitychange', async () => {
        if (document.visibilityState === 'visible') {
          try { lock = await navigator.wakeLock.request('screen'); } catch (_) {}
        }
      });
    }
  } catch (_) {}
}
keepAwake();

route();
