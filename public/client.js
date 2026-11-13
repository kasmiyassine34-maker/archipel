// L'Archipel : client navigateur (rendu 2D, commandes, réseau).
(() => {
  'use strict';
  const A = window.ARCHIPEL;
  const { TILE, C, NODES, RECIPES, PARTS, RES, RES_LABEL } = A;
  const $ = (id) => document.getElementById(id);
  const PX = 16; // pixels par tuile dans l'image de la carte
  const canvas = $('world');

  // ---------------------------------------------------------------- utilitaires
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const hash = (x, y, s = 0) => {
    let h = (x * 374761393 + y * 668265263 + s * 2147483647) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* stockage indisponible */ } },
  };
  const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

  // ---------------------------------------------------------------- état
  let ws = null, myId = null, token = null, roomCode = null;
  let world = null, mapCanvas = null, miniBase = null, bigBase = null;
  const nodes = new Map();
  let nodeGrid = new Map();
  let snap = null, snapAt = 0;
  const others = new Map(); // id -> {x,y} interpolés
  const boatsView = new Map();
  const me = { x: 0, y: 0, dir: 0, moving: false, vx: 0, vy: 0, boatA: 0 };
  let lastSent = 0, lastSentKey = '';
  let holdT = 0, holdKey = '';
  let target = null;
  const pings = [];
  let lastIsland = null;
  let ended = false;
  let wantReconnect = false, reconnectDelay = 1000;

  // ---------------------------------------------------------------- icônes des ressources
  const RES_ICON = {};
  (function makeIcons() {
    const draw = {
      bois(g) { g.fillStyle = '#7a4a24'; g.fillRect(2, 6, 12, 5); g.fillStyle = '#a8703c'; g.fillRect(2, 6, 12, 2); g.fillStyle = '#d9b07a'; g.fillRect(12, 6, 2, 5); g.fillStyle = '#7a4a24'; g.fillRect(12, 8, 1, 1); },
      pierre(g) { g.fillStyle = '#6f6a66'; g.fillRect(3, 6, 10, 7); g.fillRect(4, 5, 8, 1); g.fillStyle = '#9d9792'; g.fillRect(4, 6, 6, 3); g.fillStyle = '#4e4a47'; g.fillRect(3, 12, 10, 1); },
      fibre(g) { g.fillStyle = '#6aa548'; for (const x of [4, 7, 10]) g.fillRect(x, 3, 1, 11); g.fillStyle = '#c9b36a'; g.fillRect(3, 9, 9, 2); },
      nourriture(g) { g.fillStyle = '#d6453c'; g.fillRect(4, 6, 8, 7); g.fillRect(5, 5, 6, 9); g.fillStyle = '#f08a6f'; g.fillRect(5, 7, 2, 2); g.fillStyle = '#4c8a32'; g.fillRect(8, 3, 3, 2); },
      eau(g) { g.fillStyle = '#3fa7d6'; g.fillRect(7, 3, 2, 2); g.fillRect(6, 5, 4, 2); g.fillRect(5, 7, 6, 5); g.fillRect(6, 12, 4, 1); g.fillStyle = '#a6e1f5'; g.fillRect(6, 8, 1, 2); },
    };
    for (const r of RES) {
      const c = document.createElement('canvas'); c.width = c.height = 16;
      draw[r](c.getContext('2d'));
      RES_ICON[r] = c.toDataURL();
    }
  })();

  // ---------------------------------------------------------------- carte
  const tileAt = (x, y) => {
    if (!world) return TILE.DEEP;
    const tx = Math.floor(x), ty = Math.floor(y);
    if (tx < 0 || ty < 0 || tx >= world.W || ty >= world.H) return TILE.DEEP;
    return world.tiles[tx + ty * world.W];
  };

  function islandAt(x, y) {
    if (!world || tileAt(x, y) < TILE.SAND) return null;
    let best = null, bd = 1e9;
    for (const I of world.islands) { const d = Math.hypot(x - I.x, y - I.y); if (d < bd) { bd = d; best = I; } }
    return best;
  }

  function islandNear(x, y) {
    let best = null, bd = 1e9;
    for (const I of world.islands) { const d = Math.hypot(x - I.x, y - I.y) - I.r; if (d < bd) { bd = d; best = I; } }
    return bd < 5 ? best : null;
  }

  function buildMap() {
    const { W, H, tiles } = world;
    // Distance à la terre (pour dégrader la couleur de la mer).
    const far = new Uint8Array(W * H).fill(9);
    const q = [];
    for (let i = 0; i < W * H; i++) if (tiles[i] >= TILE.SAND) { far[i] = 0; q.push(i); }
    for (let h = 0; h < q.length; h++) {
      const i = q[h], x = i % W, y = (i / W) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const j = nx + ny * W; if (far[j] > far[i] + 1) { far[j] = far[i] + 1; if (far[j] < 9) q.push(j); }
      }
    }
    world.far = far;
    const pins = world.islands.find((I) => I.id === 'pins');
    const base = (x, y, t) => {
      const v = hash(x, y, 1);
      switch (t) {
        case TILE.DEEP: { const f = Math.min(far[x + y * W], 8) / 8; return mix([62, 140, 170], [24, 66, 96], f, (v - 0.5) * 0.025); }
        case TILE.SHALLOW: return mix([108, 196, 204], [70, 156, 184], (far[x + y * W] - 1) / 2, (v - 0.5) * 0.03);
        case TILE.SAND: return mix([236, 214, 160], [229, 205, 150], v, 0);
        case TILE.GRASS: {
          const isPins = pins && Math.hypot(x - pins.x, y - pins.y) < pins.r * 1.4;
          return isPins ? mix([86, 138, 70], [80, 130, 65], v, 0) : mix([126, 174, 88], [119, 167, 83], v, 0);
        }
        case TILE.ROCK: return mix([146, 138, 128], [128, 120, 112], v, 0);
      }
    };
    function mix(a, b, f, n) {
      f = clamp(f, 0, 1);
      return a.map((c, i) => Math.round((c + (b[i] - c) * f) * (1 + n)));
    }
    const rgb = (c) => `rgb(${c[0]},${c[1]},${c[2]})`;
    mapCanvas = document.createElement('canvas');
    mapCanvas.width = W * PX; mapCanvas.height = H * PX;
    const g = mapCanvas.getContext('2d');
    const col = new Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) col[x + y * W] = base(x, y, tiles[x + y * W]);
    // L'eau est peinte en dégradé lisse (une couleur par tuile, agrandie avec lissage).
    const water = document.createElement('canvas');
    water.width = W; water.height = H;
    const wg = water.getContext('2d');
    const wimg = wg.createImageData(W, H);
    for (let i = 0; i < W * H; i++) {
      const c = tiles[i] <= TILE.SHALLOW ? col[i] : [120, 204, 208];
      wimg.data[i * 4] = c[0]; wimg.data[i * 4 + 1] = c[1]; wimg.data[i * 4 + 2] = c[2]; wimg.data[i * 4 + 3] = 255;
    }
    wg.putImageData(wimg, 0, 0);
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(water, 0, 0, W * PX, H * PX);
    g.imageSmoothingEnabled = false;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const t = tiles[x + y * W], c = col[x + y * W];
      if (t >= TILE.SAND) { g.fillStyle = rgb(c); g.fillRect(x * PX, y * PX, PX, PX); }
      // Petits détails : grains de sable, brins d'herbe, fissures.
      if (t >= TILE.SAND) {
        for (let k = 0; k < 6; k++) {
          const px = Math.floor(hash(x, y, k + 10) * 15), py = Math.floor(hash(x, y, k + 30) * 15);
          const d = hash(x, y, k + 50) > 0.5 ? 1.08 : 0.9;
          g.fillStyle = rgb(c.map((v) => clamp(Math.round(v * d), 0, 255)));
          g.fillRect(x * PX + px, y * PX + py, t === TILE.GRASS ? 1 : 1, t === TILE.GRASS ? 2 : 1);
        }
      }
      // Bords tramés entre deux terrains pour adoucir la grille.
      const nbs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
      for (let d = 0; d < 4; d++) {
        const [dx, dy] = nbs[d];
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const nt = tiles[nx + ny * W];
        if (nt === t || nt < t || nt <= TILE.SHALLOW) continue; // le terrain « plus haut » déborde sur le plus bas
        g.fillStyle = rgb(col[nx + ny * W]);
        for (let k = 0; k < 8; k++) {
          const depth = hash(x, y, d * 16 + k) < 0.55 ? 2 : hash(x, y, d * 16 + k + 8) < 0.5 ? 4 : 0;
          if (!depth) continue;
          const a = k * 2;
          if (dx === 1) g.fillRect(x * PX + PX - depth, y * PX + a, depth, 2);
          if (dx === -1) g.fillRect(x * PX, y * PX + a, depth, 2);
          if (dy === 1) g.fillRect(x * PX + a, y * PX + PX - depth, 2, depth);
          if (dy === -1) g.fillRect(x * PX + a, y * PX, 2, depth);
        }
      }
      // Sable mouillé au bord de l'eau.
      if (t === TILE.SAND && nbs.some(([dx, dy]) => tiles[(x + dx) + (y + dy) * W] === TILE.SHALLOW)) {
        g.fillStyle = 'rgba(150,120,70,0.12)'; g.fillRect(x * PX, y * PX, PX, PX);
      }
    }
    // Mini-carte et grande carte.
    miniBase = renderOverview(1.5);
    bigBase = renderOverview(6, true);
  }

  function renderOverview(scale, names) {
    const { W, H, tiles } = world;
    const c = document.createElement('canvas');
    c.width = Math.round(W * scale); c.height = Math.round(H * scale);
    const g = c.getContext('2d');
    const pal = ['#1c4f6e', '#4e9fbd', '#e6d29e', '#7eae58', '#918a80'];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      g.fillStyle = pal[tiles[x + y * W]];
      g.fillRect(Math.floor(x * scale), Math.floor(y * scale), Math.ceil(scale), Math.ceil(scale));
    }
    if (names) {
      g.font = '700 18px "Pixelify Sans", sans-serif'; g.textAlign = 'center';
      for (const I of world.islands) {
        const ty = (I.y - I.r - 1.5) * scale;
        g.fillStyle = 'rgba(10,20,30,.7)'; g.fillText(I.name, I.x * scale + 1, ty + 2);
        g.fillStyle = '#f1e4c3'; g.fillText(I.name, I.x * scale, ty);
      }
      // Ressources dominantes.
      const legend = { home: 'Camp', pins: 'Bois', roc: 'Pierre', verte: 'Fruits · Lin · Eau', sable: 'Un peu de tout' };
      g.font = '500 13px Rubik, sans-serif';
      for (const I of world.islands) {
        g.fillStyle = 'rgba(241,228,195,.85)';
        g.fillText(legend[I.id] || '', I.x * scale, (I.y + I.r + 2.5) * scale);
      }
    }
    return c;
  }

  function indexNodes() {
    nodeGrid = new Map();
    for (const n of nodes.values()) {
      const k = Math.floor(n.x) + Math.floor(n.y) * 1000;
      if (!nodeGrid.has(k)) nodeGrid.set(k, []);
      nodeGrid.get(k).push(n);
    }
  }
  function nodesNear(x, y, r) {
    const out = [];
    for (let ty = Math.floor(y - r); ty <= Math.floor(y + r); ty++)
      for (let tx = Math.floor(x - r); tx <= Math.floor(x + r); tx++) {
        const b = nodeGrid.get(tx + ty * 1000); if (b) out.push(...b);
      }
    return out;
  }
  function blockedBySolid(x, y, fromX, fromY) {
    for (const n of nodesNear(x, y, 1)) {
      if (!NODES[n.k].solid || n.amt <= 0) continue;
      const d = Math.hypot(x - n.x, y - n.y);
      if (d < 0.42 && d < Math.hypot(fromX - n.x, fromY - n.y)) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------- réseau
  function connect(join) {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    const opened = Date.now();
    const slow = setTimeout(() => showLobbyError('Le serveur se réveille (offre gratuite), ça peut prendre jusqu\'à une minute…', true), 2500);
    ws.onopen = () => { clearTimeout(slow); hideLobbyError(); reconnectDelay = 1000; ws.send(JSON.stringify(join)); };
    ws.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.t === 's') onSnap(m);
      else if (m.t === 'init') onInit(m);
      else if (m.t === 'correct') { me.x = m.x; me.y = m.y; me.vx = me.vy = 0; }
      else if (m.t === 'note') showNote(m.text);
      else if (m.t === 'error') { wantReconnect = false; showLobby(); showLobbyError(m.text); ws.close(); }
    };
    ws.onclose = () => {
      clearTimeout(slow);
      if (!wantReconnect) return;
      showNote('Connexion perdue, reconnexion…');
      setTimeout(() => { if (wantReconnect) connect({ t: 'join', code: roomCode, token, name: myName() }); }, reconnectDelay);
      reconnectDelay = Math.min(8000, reconnectDelay * 1.6);
    };
    ws.onerror = () => { if (Date.now() - opened < 3000 && !wantReconnect) showLobbyError('Impossible de joindre le serveur. Réessaie dans un instant.'); };
  }
  const send = (o) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };

  function onInit(m) {
    myId = m.you; token = m.token; roomCode = m.code;
    store.set('archipel.token.' + roomCode, token);
    wantReconnect = true;
    if (location.hash !== '#' + roomCode) history.replaceState(null, '', '#' + roomCode);
    const bin = atob(m.tiles);
    const tiles = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) tiles[i] = bin.charCodeAt(i);
    const sameWorld = world && world.seedKey === m.tiles.length + ':' + m.tiles.slice(0, 64) + m.tiles.slice(-64) && world.camp.dock.x === m.camp.dock.x;
    world = { W: m.W, H: m.H, tiles, islands: m.islands, camp: m.camp, seedKey: m.tiles.length + ':' + m.tiles.slice(0, 64) + m.tiles.slice(-64) };
    if (!sameWorld || !mapCanvas) buildMap();
    nodes.clear();
    for (const [id, k, x, y, amt] of m.nodes) nodes.set(id, { id, k, x, y, amt });
    indexNodes();
    others.clear(); boatsView.clear();
    snap = null; ended = false; lastIsland = null;
    $('end').hidden = true;
    $('lobby').hidden = true;
    $('hud').hidden = false;
    $('room-code').textContent = roomCode;
    onSnap(m.snap);
    const p = snap.players.find((q) => q.id === myId);
    if (p) { me.x = p.x; me.y = p.y; }
    renderPanels(true);
  }

  function onSnap(s) {
    snap = s; snapAt = performance.now();
    for (const [id, amt] of s.nodes || []) { const n = nodes.get(id); if (n) n.amt = amt; }
    for (const e of s.ev || []) {
      if (e.ping) { pings.push({ ...e.ping, t: performance.now() }); continue; }
      addLog(e.text, e.kind);
    }
    const seen = new Set();
    for (const p of s.players) {
      seen.add(p.id);
      if (p.id === myId) continue;
      const o = others.get(p.id);
      if (!o) others.set(p.id, { x: p.x, y: p.y, px: p.x, py: p.y, step: 0 });
    }
    for (const id of [...others.keys()]) if (!seen.has(id)) others.delete(id);
    for (const b of s.boats) if (!boatsView.has(b.id)) boatsView.set(b.id, { x: b.x, y: b.y, a: b.a });
    const mine = myself();
    if (mine && mine.b) {
      const b = s.boats.find((x) => x.id === mine.b);
      if (b && b.seats[0] !== myId) { me.x = b.x; me.y = b.y; }
      if (b && !me.inBoat) { me.x = b.x; me.y = b.y; me.boatA = b.a; me.vx = me.vy = 0; }
    }
    me.inBoat = !!(mine && mine.b);
    if ((s.st === 'won' || s.st === 'lost') && !ended) { ended = true; showEnd(s); }
  }

  const myself = () => snap && snap.players.find((p) => p.id === myId);
  const myBoat = () => { const p = myself(); return p && p.b ? snap.boats.find((b) => b.id === p.b) : null; };

  // ---------------------------------------------------------------- commandes
  const keys = new Set();
  const typing = () => ['INPUT', 'TEXTAREA'].includes(document.activeElement && document.activeElement.tagName);
  window.addEventListener('keydown', (e) => {
    if (typing()) return;
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
    keys.add(e.code);
    if (e.repeat || !snap) return;
    const k = e.key.toLowerCase();
    if (k === 'e') pressInteract();
    else if (k === 'r') cargo();
    else if (k === 'f') send({ t: 'eat' });
    else if (k === 'g') send({ t: 'drink' });
    else if (k === 'm') toggle('bigmap');
    else if (k === 'h' || k === '?') toggle('help');
    else if (e.key === 'Escape') { $('bigmap').hidden = true; $('help').hidden = true; }
  });
  window.addEventListener('keyup', (e) => keys.delete(e.code));
  window.addEventListener('blur', () => keys.clear());
  const down = (...codes) => codes.some((c) => keys.has(c));
  const eHeld = () => keys.has('KeyE');

  function toggle(id) { $(id).hidden = !$(id).hidden; }

  function pressInteract() {
    if (!target || target.hold) return;
    send(target.msg);
  }
  function cargo() {
    const b = myBoat() || nearestBoat(C.REACH + 0.5);
    if (b) send({ t: 'cargo', id: b.id });
  }
  function nearestBoat(r) {
    let best = null, bd = r;
    for (const b of snap.boats) { const v = boatsView.get(b.id) || b; const d = dist(me, v); if (d <= bd) { bd = d; best = b; } }
    return best;
  }

  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (!snap) return;
    const w = screenToWorld(e.clientX, e.clientY);
    send({ t: 'ping', x: w.x, y: w.y });
  });
  $('minimap').addEventListener('click', () => toggle('bigmap'));
  $('bigmap').addEventListener('click', (e) => { if (e.target.id === 'bigmap') $('bigmap').hidden = true; });
  $('help-close').addEventListener('click', () => { $('help').hidden = true; });
  $('restart').addEventListener('click', () => send({ t: 'restart' }));
  $('launch').addEventListener('click', () => send({ t: 'launch' }));
  $('copy-link').addEventListener('click', async () => {
    const url = location.origin + location.pathname + '#' + roomCode;
    try { await navigator.clipboard.writeText(url); showNote('Lien copié. Envoie-le à tes amis !'); }
    catch { showNote(url); }
  });
  $('camp').addEventListener('click', (e) => {
    const b = e.target.closest('[data-craft],[data-build],[data-take]');
    if (!b || b.disabled) return;
    if (b.dataset.craft) send({ t: 'craft', id: b.dataset.craft });
    if (b.dataset.build) send({ t: 'build', id: b.dataset.build });
    if (b.dataset.take) send({ t: 'take', res: b.dataset.take });
  });

  // ---------------------------------------------------------------- accueil
  const myName = () => $('name').value.trim() || 'Naufragé';
  $('name').value = store.get('archipel.name') || '';
  const hashCode = location.hash.replace('#', '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
  if (hashCode) { $('code').value = hashCode; $('join').classList.add('primary'); $('create').classList.remove('primary'); }
  $('join-form').addEventListener('submit', (e) => { e.preventDefault(); start(true); });
  $('join').addEventListener('click', () => start(false));
  $('code').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); start(false); } });

  function start(create) {
    if (!$('name').value.trim()) { $('name').focus(); showLobbyError('Choisis un nom pour commencer.'); return; }
    store.set('archipel.name', myName());
    const code = $('code').value.trim().toUpperCase();
    if (!create && code.length !== 4) { showLobbyError('Le code de partie fait 4 lettres.'); return; }
    const tok = create ? null : store.get('archipel.token.' + code);
    if (ws) { wantReconnect = false; ws.close(); }
    connect({ t: 'join', create, code: create ? '' : code, name: myName(), token: tok });
  }
  function showLobby() { $('lobby').hidden = false; $('hud').hidden = true; }
  function showLobbyError(t, soft) { const el = $('lobby-error'); el.textContent = t; el.hidden = false; el.style.color = soft ? 'var(--sand-dim)' : ''; }
  function hideLobbyError() { $('lobby-error').hidden = true; }

  // ---------------------------------------------------------------- simulation locale
  function update(dt) {
    if (!snap || !world) return;
    const mine = myself();
    if (!mine) return;
    let ix = (down('KeyD', 'ArrowRight') ? 1 : 0) - (down('KeyA', 'ArrowLeft') ? 1 : 0);
    let iy = (down('KeyS', 'ArrowDown') ? 1 : 0) - (down('KeyW', 'ArrowUp') ? 1 : 0);
    const il = Math.hypot(ix, iy); if (il) { ix /= il; iy /= il; }
    const playing = snap.st === 'playing' && !mine.dn && $('help').hidden && $('bigmap').hidden;
    if (!playing) ix = iy = 0;

    const boat = myBoat();
    if (boat) {
      const bv = boatsView.get(boat.id);
      if (boat.seats[0] === myId) {
        const speed = C.SPEED_BOAT * (boat.seats.length >= 2 ? C.BOAT_CREW_BONUS : 1);
        me.vx += (ix * speed - me.vx) * Math.min(1, dt * 2.5);
        me.vy += (iy * speed - me.vy) * Math.min(1, dt * 2.5);
        const sp = Math.hypot(me.vx, me.vy);
        if (sp > 0.3) {
          const ta = Math.atan2(me.vy, me.vx);
          let da = ta - me.boatA; while (da > Math.PI) da -= 2 * Math.PI; while (da < -Math.PI) da += 2 * Math.PI;
          me.boatA += da * Math.min(1, dt * 5);
        }
        const fx = Math.cos(me.boatA) * 0.55, fy = Math.sin(me.boatA) * 0.55;
        const ok = (x, y) => A.boatable(tileAt(x, y)) && A.boatable(tileAt(x + fx, y + fy)) && A.boatable(tileAt(x - fx, y - fy));
        const nx = me.x + me.vx * dt, ny = me.y + me.vy * dt;
        if (ok(nx, me.y)) me.x = nx; else me.vx *= -0.2;
        if (ok(me.x, ny)) me.y = ny; else me.vy *= -0.2;
        me.moving = sp > 0.3;
        if (bv) { bv.x = me.x; bv.y = me.y; bv.a = me.boatA; }
      } else if (bv) { me.x = bv.x; me.y = bv.y; me.moving = false; }
    } else if (ix || iy) {
      const speed = tileAt(me.x, me.y) === TILE.SHALLOW ? C.SPEED_WADE : C.SPEED_WALK;
      const nx = me.x + ix * speed * dt, ny = me.y + iy * speed * dt;
      if (A.walkable(tileAt(nx, me.y)) && !blockedBySolid(nx, me.y, me.x, me.y)) me.x = nx;
      if (A.walkable(tileAt(me.x, ny)) && !blockedBySolid(me.x, ny, me.x, me.y)) me.y = ny;
      me.dir = Math.atan2(iy, ix);
      me.moving = true;
    } else me.moving = false;
    if (me.moving) me.step = (me.step || 0) + dt * 9;

    // Envoi de la position (15 fois par seconde au plus).
    const now = performance.now();
    if (now - lastSent > 66) {
      const drive = boat && boat.seats[0] === myId;
      const m = drive ? { t: 'pos', x: +me.x.toFixed(2), y: +me.y.toFixed(2), a: +me.boatA.toFixed(2) } : { t: 'pos', x: +me.x.toFixed(2), y: +me.y.toFixed(2), d: +me.dir.toFixed(2) };
      const key = JSON.stringify(m);
      if ((!boat || drive) && (key !== lastSentKey || now - lastSent > 1000)) { send(m); lastSentKey = key; lastSent = now; }
    }

    // Interpolation des autres joueurs et barques.
    const k = Math.min(1, dt * 12);
    for (const p of snap.players) {
      if (p.id === myId) continue;
      const o = others.get(p.id); if (!o) continue;
      const ox = o.x, oy = o.y;
      o.x += (p.x - o.x) * k; o.y += (p.y - o.y) * k;
      const mv = Math.hypot(o.x - ox, o.y - oy) / Math.max(dt, 1e-3);
      o.moving = mv > 0.4; if (o.moving) o.step += dt * 9;
    }
    for (const b of snap.boats) {
      const v = boatsView.get(b.id); if (!v) continue;
      if (boat && b.id === boat.id && boat.seats[0] === myId) continue;
      v.x += (b.x - v.x) * k; v.y += (b.y - v.y) * k;
      let da = b.a - v.a; while (da > Math.PI) da -= 2 * Math.PI; while (da < -Math.PI) da += 2 * Math.PI;
      v.a += da * k;
    }

    // Cible d'interaction.
    target = playing ? findTarget(mine, boat) : null;
    const key = target ? target.key : '';
    if (key !== holdKey) { holdKey = key; holdT = 0; }
    if (target && target.hold && eHeld()) {
      holdT += dt;
      if (holdT >= target.dur) { send(target.msg); holdT = 0; }
    } else holdT = Math.max(0, holdT - dt * 2);

    // Nom de l'île en arrivant.
    const I = islandAt(me.x, me.y);
    if (I && I.id !== lastIsland) { lastIsland = I.id; showIsland(I.name); }
  }

  function findTarget(mine, boat) {
    const cands = [];
    const sac = A.sacCount(mine.inv);
    // Relever un coéquipier passe avant tout.
    for (const p of snap.players) {
      if (p.id === myId || !p.dn) continue;
      const o = others.get(p.id) || p;
      if (dist(me, o) <= C.REACH + 0.4) return { key: 'rev' + p.id, hold: true, dur: C.REVIVE_TIME, msg: { t: 'revive', id: p.id }, text: `Maintenir E : relever ${p.n}` };
    }
    if (boat) {
      const extra = sac || A.sacCount(boat.hold) ? ' · R : cale' : '';
      return { key: 'leave', msg: { t: 'leave' }, text: 'E : Débarquer' + extra };
    }
    for (const b of snap.boats) {
      const v = boatsView.get(b.id) || b;
      const d = dist(me, v);
      if (d > C.REACH + 0.3) continue;
      const full = b.seats.length >= C.BOAT_SEATS;
      const hold = A.sacCount(b.hold);
      cands.push({ d: d - 0.2, key: 'boat' + b.id, msg: { t: 'board', id: b.id },
        text: (full ? 'Barque pleine' : b.seats.length ? 'E : Rejoindre à la rame' : 'E : Monter dans la barque') + (sac || hold ? ` · R : cale (${hold}/${C.HOLD_CAP})` : '') });
    }
    const camp = world.camp;
    const dc = dist(me, camp.chest);
    const boatsDocked = snap.boats.some((b) => A.sacCount(b.hold) > 0 && (dist(b, camp.chest) <= 9 || dist(b, camp.yard) <= 4));
    if (dc <= C.CAMP_REACH && (sac > 0 || boatsDocked)) cands.push({ d: dc - 0.5, key: 'chest', msg: { t: 'deposit' }, text: 'E : Déposer au coffre' });
    const df = dist(me, camp.fire);
    if (df <= C.REACH + 0.6) cands.push({ d: df - 0.3, key: 'fire', msg: { t: 'fuel' }, text: mine.inv.bois > 0 ? `E : Ajouter du bois au feu (${mine.inv.bois})` : 'E : Nourrir le feu avec le bois du coffre' });
    for (const n of nodesNear(me.x, me.y, C.REACH + 1)) {
      const d = dist(me, n);
      if (d > C.REACH || n.amt <= 0) continue;
      const def = NODES[n.k];
      const tool = def.tool && mine.tools[def.tool];
      const full = sac >= C.SAC_CAP;
      cands.push({ d, key: 'n' + n.id, hold: !full, dur: def.dur * (tool ? 0.5 : 1), msg: { t: 'harvest', id: n.id },
        text: full ? 'Sac plein : dépose-le au coffre ou en barque (R)' : `Maintenir E : ${def.label}${n.k === 'spring' ? ' · G : boire' : ''}` });
    }
    cands.sort((a, b) => a.d - b.d);
    return cands[0] || null;
  }

  // ---------------------------------------------------------------- rendu
  const ctx = canvas.getContext('2d');
  const light = document.createElement('canvas');
  const lctx = light.getContext('2d');
  let T = 32, dpr = 1, CW = 0, CH = 0;
  function resize() {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    CW = canvas.width = Math.round(innerWidth * dpr);
    CH = canvas.height = Math.round(innerHeight * dpr);
    light.width = CW; light.height = CH;
    // Une tuile mesure entre 30 et 48 pixels CSS selon la taille de l'écran.
    T = Math.round(clamp(innerWidth / 34, 30, 48) * dpr);
  }
  window.addEventListener('resize', resize);
  resize();

  let cam = { x: 0, y: 0 };
  const W2S = (x, y) => [Math.round((x - cam.x) * T + CW / 2), Math.round((y - cam.y) * T + CH / 2)];
  function screenToWorld(cx, cy) { return { x: (cx * dpr - CW / 2) / T + cam.x, y: (cy * dpr - CH / 2) / T + cam.y }; }

  // Dessine en « pixels de sprite » (16 par tuile) autour d'un point du monde.
  function sprite(x, y, fn, rot = 0) {
    const [sx, sy] = W2S(x, y);
    const s = T / PX;
    ctx.save();
    ctx.translate(sx, sy);
    if (rot) ctx.rotate(rot);
    ctx.scale(s, s);
    fn(ctx);
    ctx.restore();
  }
  const R = (g, c, x, y, w, h) => { g.fillStyle = c; g.fillRect(x, y, w, h); };
  const shadow = (g, w, y = 4) => { g.fillStyle = 'rgba(10,25,30,0.28)'; g.beginPath(); g.ellipse(0, y, w, w * 0.35, 0, 0, Math.PI * 2); g.fill(); };

  let now = 0;
  function drawTree(n) {
    const pine = world.islands.find((I) => I.id === 'pins');
    const isPine = pine && Math.hypot(n.x - pine.x, n.y - pine.y) < pine.r * 1.5;
    sprite(n.x, n.y, (g) => {
      if (n.amt <= 0) { shadow(g, 4, 3); R(g, '#6b4423', -3, -1, 6, 4); R(g, '#c49a62', -2, -1, 4, 2); return; }
      const sw = Math.sin(now / 900 + n.id) * 0.6;
      shadow(g, 7, 4);
      R(g, '#6b4423', -1.5, -3, 3, 7);
      if (isPine) {
        const layers = [[-7, -4, '#2f5d3a'], [-6, -9, '#3a6f45'], [-4, -14, '#4a8452']];
        for (const [w, y, c] of layers) {
          g.fillStyle = c; g.beginPath(); g.moveTo(sw + 0, y - 7); g.lineTo(sw - w, y + 2); g.lineTo(sw + -w * -1, y + 2); g.closePath(); g.fill();
        }
        R(g, 'rgba(255,255,255,.08)', sw - 1, -19, 2, 3);
      } else {
        g.fillStyle = '#3f7a3c'; g.beginPath(); g.arc(sw, -9, 7, 0, Math.PI * 2); g.fill();
        g.fillStyle = '#56994a'; g.beginPath(); g.arc(sw - 2, -11, 5, 0, Math.PI * 2); g.fill();
        g.fillStyle = '#6fb35a'; g.beginPath(); g.arc(sw - 3, -13, 2.2, 0, Math.PI * 2); g.fill();
      }
      if (n.amt < NODES.tree.max) R(g, '#e6c48f', -1.5, 1, 3, 1);
    });
  }
  function drawRock(n) {
    sprite(n.x, n.y, (g) => {
      if (n.amt <= 0) { R(g, '#8b847c', -4, 1, 2, 2); R(g, '#8b847c', 1, 2, 3, 2); return; }
      const s = 0.65 + 0.35 * (n.amt / NODES.rock.max);
      g.scale(s, s);
      shadow(g, 7, 4);
      g.fillStyle = '#6e6862'; g.beginPath(); g.moveTo(-7, 4); g.lineTo(-6, -3); g.lineTo(-2, -6); g.lineTo(4, -5); g.lineTo(7, 0); g.lineTo(6, 4); g.closePath(); g.fill();
      g.fillStyle = '#958e86'; g.beginPath(); g.moveTo(-5, -2); g.lineTo(-2, -5); g.lineTo(3, -4); g.lineTo(1, -1); g.closePath(); g.fill();
      R(g, '#4f4a45', -6, 3, 12, 1);
    });
  }
  function drawBush(n) {
    sprite(n.x, n.y, (g) => {
      shadow(g, 6, 3);
      g.fillStyle = '#3d7a35'; g.beginPath(); g.arc(0, -2, 6, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#54964a'; g.beginPath(); g.arc(-2, -4, 3.5, 0, Math.PI * 2); g.fill();
      for (let i = 0; i < n.amt * 2; i++) {
        const a = hash(n.id, i, 3) * Math.PI * 2, r = 1.5 + hash(n.id, i, 4) * 3.5;
        R(g, '#d84a3e', Math.round(Math.cos(a) * r) - 1, Math.round(Math.sin(a) * r) - 3, 2, 2);
        R(g, '#ff9a7a', Math.round(Math.cos(a) * r) - 1, Math.round(Math.sin(a) * r) - 3, 1, 1);
      }
    });
  }
  function drawFlax(n) {
    sprite(n.x, n.y, (g) => {
      const h = n.amt > 0 ? 9 : 3;
      for (let i = 0; i < 5; i++) {
        const x = -4 + i * 2, sw = n.amt > 0 ? Math.sin(now / 600 + n.id + i) * 0.8 : 0;
        R(g, '#5f9a3e', x, 2 - h + (i % 2), 1, h);
        if (n.amt > 0 && i < n.amt + 2) R(g, '#7fb6ff', x + sw - 0.5, 1 - h + (i % 2), 2, 2);
      }
    });
  }
  function drawSpring(n) {
    sprite(n.x, n.y, (g) => {
      g.fillStyle = '#8b847c';
      for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2; g.fillRect(Math.cos(a) * 7 - 1.5, Math.sin(a) * 4.5 - 1.5, 3, 3); }
      g.fillStyle = '#3c9ccc'; g.beginPath(); g.ellipse(0, 0, 6, 3.6, 0, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#7fd0ef'; g.beginPath(); g.ellipse(-1.5, -1, 3, 1.4, 0, 0, Math.PI * 2); g.fill();
      if (Math.sin(now / 300 + n.id) > 0.6) R(g, '#ffffff', 2, -1, 1, 1);
    });
  }
  function drawChest(p) {
    sprite(p.x, p.y, (g) => {
      shadow(g, 7, 4);
      R(g, '#6b4423', -7, -6, 14, 10); R(g, '#8a5a30', -7, -6, 14, 3); R(g, '#3d2614', -7, -3, 14, 1);
      R(g, '#d8a842', -1, -4, 2, 3); R(g, '#3d2614', -7, 3, 14, 1);
    });
  }
  function drawBench(p) {
    sprite(p.x, p.y, (g) => {
      shadow(g, 8, 4);
      R(g, '#5a3a1e', -7, -1, 2, 5); R(g, '#5a3a1e', 5, -1, 2, 5);
      R(g, '#9a6a3a', -8, -4, 16, 3); R(g, '#b98a52', -8, -4, 16, 1);
      R(g, '#8b8f96', -4, -7, 5, 2); R(g, '#6b4423', 0, -7, 4, 1); // hache posée
      R(g, '#7a5a3a', 3, -6, 3, 2);
    });
  }
  function drawFire(f, fuel) {
    sprite(f.x, f.y, (g) => {
      g.fillStyle = '#7d7670';
      for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2; g.fillRect(Math.round(Math.cos(a) * 6) - 1.5, Math.round(Math.sin(a) * 3.5) - 1.5, 3, 3); }
      R(g, '#5a3a1e', -5, -1, 10, 2); R(g, '#4a2e17', -2, -3, 4, 5);
      if (fuel > 0) {
        const s = clamp(fuel / 120, 0.45, 1.1);
        const fl = (o, c, w, h) => {
          const k = 1 + Math.sin(now / 90 + o) * 0.15;
          g.fillStyle = c; g.beginPath(); g.moveTo(-w, 0); g.quadraticCurveTo(-w * 0.6, -h * 0.6 * k, Math.sin(now / 130 + o), -h * k); g.quadraticCurveTo(w * 0.6, -h * 0.6 * k, w, 0); g.closePath(); g.fill();
        };
        fl(0, '#e5482d', 4.5 * s, 11 * s); fl(1.3, '#f59a2c', 3.2 * s, 8 * s); fl(2.6, '#ffe28a', 1.6 * s, 4.5 * s);
        for (let i = 0; i < 3; i++) {
          const t = ((now / 900 + i / 3) % 1);
          R(g, `rgba(255,200,90,${1 - t})`, Math.sin(i * 7 + now / 400) * 3, -6 - t * 14, 1, 1);
        }
      } else {
        for (let i = 0; i < 3; i++) {
          const t = ((now / 1600 + i / 3) % 1);
          g.fillStyle = `rgba(200,200,200,${0.35 * (1 - t)})`; g.beginPath(); g.arc(Math.sin(i * 5 + now / 700) * 2, -3 - t * 14, 1.5 + t * 2.5, 0, Math.PI * 2); g.fill();
        }
      }
    });
  }
  function drawShip(parts) {
    const y = world.camp.yard, d = world.camp.dock;
    const ang = Math.atan2(d.y - y.y, d.x - y.x);
    // Le navire est posé sur la cale de lancement, perpendiculaire au rivage.
    sprite(y.x, y.y, (g) => {
      // Rails de la cale.
      R(g, '#8a6a42', -26, -9, 52, 2); R(g, '#8a6a42', -26, 7, 52, 2);
      for (let i = -24; i <= 24; i += 6) R(g, '#a07a4a', i, -9, 2, 18);
      if (parts.quille) { R(g, '#5a3a1e', -22, -1, 44, 3); R(g, '#7a5230', -22, -1, 44, 1); }
      if (parts.coque) {
        g.fillStyle = '#7a4d28'; g.beginPath(); g.moveTo(-22, -7); g.lineTo(18, -7); g.lineTo(26, 0); g.lineTo(18, 7); g.lineTo(-22, 7); g.closePath(); g.fill();
        g.fillStyle = '#9a6a3a'; g.beginPath(); g.moveTo(-20, -5); g.lineTo(17, -5); g.lineTo(23, 0); g.lineTo(17, 5); g.lineTo(-20, 5); g.closePath(); g.fill();
        for (let i = -18; i < 16; i += 5) R(g, '#7a4d28', i, -5, 1, 10);
      }
      if (parts.vivres) { R(g, '#6b4423', -16, -3, 5, 6); R(g, '#a8783c', -16, -3, 5, 1); R(g, '#6b4423', -10, -3, 5, 6); R(g, '#a8783c', -10, -3, 5, 1); }
      if (parts.mat) { g.fillStyle = 'rgba(0,0,0,.25)'; g.fillRect(-1, -1, 3, 3); }
    }, ang);
    // Le mât et la voile sont dessinés « debout », sans rotation.
    sprite(y.x, y.y, (g) => {
      if (parts.mat) { R(g, '#4a2e17', -1, -34, 2, 34); R(g, '#4a2e17', -9, -28, 18, 2); }
      if (parts.voiles) {
        const b = Math.sin(now / 700) * 1.5;
        g.fillStyle = '#efe4c8'; g.beginPath(); g.moveTo(-9, -26); g.quadraticCurveTo(0 + b, -18, -9, -8); g.lineTo(9, -8); g.quadraticCurveTo(13 + b, -18, 9, -26); g.closePath(); g.fill();
        R(g, '#ef7f5a', -6, -19, 12, 2);
      }
    });
  }
  function drawBoat(b, v) {
    sprite(v.x, v.y, (g) => {
      g.fillStyle = 'rgba(10,30,45,.3)'; g.beginPath(); g.ellipse(1, 2, 12, 5, 0, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#6b4423'; g.beginPath(); g.moveTo(-11, -4); g.lineTo(7, -5); g.quadraticCurveTo(13, 0, 7, 5); g.lineTo(-11, 4); g.closePath(); g.fill();
      g.fillStyle = '#9a6a3a'; g.beginPath(); g.moveTo(-9, -3); g.lineTo(6, -3.5); g.quadraticCurveTo(10, 0, 6, 3.5); g.lineTo(-9, 3); g.closePath(); g.fill();
      R(g, '#6b4423', -3, -3, 1.5, 6); R(g, '#6b4423', 3, -3, 1.5, 6);
      const hold = A.sacCount(b.hold || {});
      if (hold > 0) { R(g, '#c49a62', -8, -2, 4, 4); if (hold > 10) R(g, '#a8783c', -8, -2, 4, 1); if (hold > 20) R(g, '#c49a62', 5, -1.5, 3, 3); }
      // Rames.
      const moving = Math.hypot(v.x - (v.lx ?? v.x), v.y - (v.ly ?? v.y)) > 0.002;
      if (b.seats.length) {
        const ph = moving ? Math.sin(now / 160) * 0.5 : 0;
        g.strokeStyle = '#4a2e17'; g.lineWidth = 1;
        g.beginPath(); g.moveTo(0, -3); g.lineTo(-3 + ph * 4, -11); g.moveTo(0, 3); g.lineTo(-3 + ph * 4, 11); g.stroke();
      }
      if (moving) {
        g.fillStyle = 'rgba(255,255,255,.5)';
        for (let i = 0; i < 3; i++) g.fillRect(-14 - i * 3, -2 + ((i * 3 + Math.floor(now / 120)) % 5), 2, 1);
      }
      // Passagers assis.
      b.seats.forEach((id, i) => {
        const p = snap.players.find((q) => q.id === id); if (!p) return;
        const x = i === 0 ? 0 : -6;
        g.fillStyle = p.c; g.beginPath(); g.arc(x, 0, 2.8, 0, Math.PI * 2); g.fill();
        R(g, '#f0c9a0', x - 1.5, -1.5, 3, 3);
      });
    }, v.a);
    v.lx = v.x; v.ly = v.y;
  }
  function drawPlayer(p, x, y, dir, moving, step) {
    sprite(x, y, (g) => {
      if (p.dn) {
        shadow(g, 6, 2);
        g.save(); g.rotate(Math.PI / 2);
        R(g, p.c, -4, -3, 8, 7); R(g, '#f0c9a0', -3, -9, 6, 6);
        g.restore();
        const pulse = 0.6 + 0.4 * Math.sin(now / 200);
        g.fillStyle = `rgba(229,72,77,${pulse})`; g.beginPath(); g.arc(0, -14, 4, 0, Math.PI * 2); g.fill();
        R(g, '#fff', -0.5, -16.5, 1, 3); R(g, '#fff', -0.5, -12.5, 1, 1);
        return;
      }
      shadow(g, 5, 5);
      const bob = moving ? Math.abs(Math.sin(step)) * -1 : 0;
      const legA = moving ? Math.sin(step) * 1.5 : 0;
      R(g, '#3a3530', -3, 2 + bob, 2, 3 + legA * 0.5); R(g, '#3a3530', 1, 2 + bob, 2, 3 - legA * 0.5);
      R(g, p.c, -4, -5 + bob, 8, 8);
      R(g, 'rgba(0,0,0,.18)', -4, 1 + bob, 8, 2);
      R(g, '#f0c9a0', -3, -11 + bob, 6, 6);
      R(g, '#5a3a1e', -3, -12 + bob, 6, 2);
      const fx = Math.round(Math.cos(dir) * 1.2), fy = Math.sin(dir) > 0.3 ? 0 : -1;
      if (Math.sin(dir) > -0.6) { R(g, '#2b2420', -2 + fx, -8 + bob + fy, 1, 1); R(g, '#2b2420', 1 + fx, -8 + bob + fy, 1, 1); }
      if (p.tl) {
        R(g, '#6b4423', 4, -7 + bob, 1, 7);
        const k = 1 + Math.sin(now / 80) * 0.2;
        g.fillStyle = '#f59a2c'; g.beginPath(); g.arc(4.5, -8 + bob, 2.2 * k, 0, Math.PI * 2); g.fill();
        g.fillStyle = '#ffe28a'; g.beginPath(); g.arc(4.5, -8 + bob, 1, 0, Math.PI * 2); g.fill();
      }
      if (p.cold) { g.strokeStyle = 'rgba(160,210,255,.9)'; g.lineWidth = 1; g.beginPath(); g.arc(0, -4, 9 + Math.sin(now / 150), 0, Math.PI * 2); g.stroke(); }
    });
  }

  function drawWater() {
    // Reflets animés sur la mer et écume au bord des plages.
    const x0 = Math.floor(cam.x - CW / 2 / T) - 1, x1 = Math.ceil(cam.x + CW / 2 / T) + 1;
    const y0 = Math.floor(cam.y - CH / 2 / T) - 1, y1 = Math.ceil(cam.y + CH / 2 / T) + 1;
    const s = T / PX;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const t = tileAt(x, y);
      if (t === TILE.DEEP) {
        const h = hash(x, y, 7);
        if (h > 0.16) continue;
        const ph = (now / 2400 + h * 10) % 1;
        const a = Math.sin(ph * Math.PI) * 0.35;
        if (a <= 0.02) continue;
        const [sx, sy] = W2S(x, y);
        ctx.fillStyle = `rgba(190,230,245,${a})`;
        ctx.fillRect(sx + Math.round((3 + ph * 6) * s), sy + Math.round((6 + h * 40) * s) % T, Math.round(5 * s), Math.max(1, Math.round(s)));
      } else if (t === TILE.SHALLOW) {
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          if (tileAt(x + dx, y + dy) < TILE.SAND) continue;
          const a = 0.25 + 0.25 * Math.sin(now / 700 + hash(x, y, dx * 3 + dy) * 6);
          const [sx, sy] = W2S(x, y);
          ctx.fillStyle = `rgba(255,255,255,${a})`;
          const off = Math.round((1 + Math.sin(now / 900 + x + y)) * s);
          const w = Math.max(1, Math.round(1.5 * s));
          if (dx === 1) ctx.fillRect(sx + T - w - off, sy, w, T);
          if (dx === -1) ctx.fillRect(sx + off, sy, w, T);
          if (dy === 1) ctx.fillRect(sx, sy + T - w - off, T, w);
          if (dy === -1) ctx.fillRect(sx, sy + off, T, w);
        }
      }
    }
  }

  function render() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#153e5c'; ctx.fillRect(0, 0, CW, CH);
    if (!world || !snap) return;
    const mine = myself();
    const tx = me.x, ty = me.y;
    cam.x += (tx - cam.x) * 0.2; cam.y += (ty - cam.y) * 0.2;
    if (Math.abs(cam.x - tx) > 20 || Math.abs(cam.y - ty) > 20) { cam.x = tx; cam.y = ty; }

    // Carte précalculée.
    ctx.imageSmoothingEnabled = false;
    const s = T / PX;
    const sx = (cam.x * PX) - CW / 2 / s, sy = (cam.y * PX) - CH / 2 / s;
    ctx.drawImage(mapCanvas, sx, sy, CW / s, CH / s, 0, 0, CW, CH);
    drawWater();

    // Objets triés par profondeur.
    const vx0 = cam.x - CW / 2 / T - 2, vx1 = cam.x + CW / 2 / T + 2, vy0 = cam.y - CH / 2 / T - 2, vy1 = cam.y + CH / 2 / T + 3;
    const vis = (x, y) => x > vx0 && x < vx1 && y > vy0 && y < vy1;
    const list = [];
    for (const n of nodes.values()) if (vis(n.x, n.y)) list.push({ y: n.y + (n.k === 'spring' ? -0.5 : 0), f: () => ({ tree: drawTree, rock: drawRock, bush: drawBush, flax: drawFlax, spring: drawSpring })[n.k](n) });
    const camp = world.camp;
    list.push({ y: camp.yard.y - 0.6, f: () => drawShip(snap.parts) });
    list.push({ y: camp.chest.y, f: () => drawChest(camp.chest) });
    list.push({ y: camp.bench.y, f: () => drawBench(camp.bench) });
    list.push({ y: camp.fire.y, f: () => drawFire(camp.fire, snap.fire) });
    for (const b of snap.boats) { const v = boatsView.get(b.id); if (v && vis(v.x, v.y)) list.push({ y: v.y - 0.3, f: () => drawBoat(b, v) }); }
    for (const p of snap.players) {
      if (p.b) continue;
      if (p.id === myId) list.push({ y: me.y, f: () => drawPlayer(p, me.x, me.y, me.dir, me.moving, me.step || 0) });
      else { const o = others.get(p.id); if (o && vis(o.x, o.y)) list.push({ y: o.y, f: () => drawPlayer(p, o.x, o.y, p.d, o.moving, o.step) }); }
    }
    list.sort((a, b) => a.y - b.y);
    for (const it of list) it.f();

    // Lumière : la nuit tombe, le feu et les torches percent l'obscurité.
    const dark = A.darkness(snap.time);
    if (dark > 0.01) {
      lctx.globalCompositeOperation = 'source-over';
      lctx.clearRect(0, 0, CW, CH);
      lctx.fillStyle = `rgba(6,10,30,${0.84 * dark})`;
      lctx.fillRect(0, 0, CW, CH);
      lctx.globalCompositeOperation = 'destination-out';
      const hole = (x, y, r, a = 1) => {
        const [px, py] = W2S(x, y);
        const gr = lctx.createRadialGradient(px, py, 0, px, py, r * T);
        gr.addColorStop(0, `rgba(0,0,0,${a})`); gr.addColorStop(0.55, `rgba(0,0,0,${a * 0.75})`); gr.addColorStop(1, 'rgba(0,0,0,0)');
        lctx.fillStyle = gr; lctx.fillRect(px - r * T, py - r * T, r * T * 2, r * T * 2);
      };
      const flick = 1 + Math.sin(now / 110) * 0.03 + Math.sin(now / 47) * 0.02;
      if (snap.fire > 0) hole(camp.fire.x, camp.fire.y - 0.3, C.FIRE_RADIUS * flick * clamp(snap.fire / 60, 0.7, 1));
      for (const p of snap.players) {
        const pos = p.id === myId ? me : (others.get(p.id) || p);
        if (p.tl) hole(pos.x, pos.y - 0.3, C.TORCH_RADIUS * flick);
        hole(pos.x, pos.y - 0.3, 1.6, 0.55);
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(light, 0, 0);
      // Lueur chaude.
      ctx.globalCompositeOperation = 'lighter';
      const glow = (x, y, r, a) => {
        const [px, py] = W2S(x, y);
        const gr = ctx.createRadialGradient(px, py, 0, px, py, r * T);
        gr.addColorStop(0, `rgba(255,140,50,${a})`); gr.addColorStop(1, 'rgba(255,140,50,0)');
        ctx.fillStyle = gr; ctx.fillRect(px - r * T, py - r * T, r * T * 2, r * T * 2);
      };
      if (snap.fire > 0) glow(camp.fire.x, camp.fire.y - 0.3, C.FIRE_RADIUS * 0.8, 0.22 * dark * flick);
      for (const p of snap.players) if (p.tl) { const pos = p.id === myId ? me : (others.get(p.id) || p); glow(pos.x, pos.y - 0.4, C.TORCH_RADIUS * 0.7, 0.16 * dark); }
      ctx.globalCompositeOperation = 'source-over';
    }
    const t = snap.time;
    if (t > 0.58 && t < 0.74) { ctx.fillStyle = `rgba(255,110,60,${0.1 * Math.sin(((t - 0.58) / 0.16) * Math.PI)})`; ctx.fillRect(0, 0, CW, CH); }

    // Signaux.
    for (let i = pings.length - 1; i >= 0; i--) {
      const pg = pings[i], age = (performance.now() - pg.t) / 1000;
      if (age > 4) { pings.splice(i, 1); continue; }
      const [px, py] = W2S(pg.x, pg.y);
      ctx.strokeStyle = pg.c; ctx.lineWidth = 2 * dpr;
      for (let k = 0; k < 2; k++) {
        const ph = ((age + k * 0.5) % 1);
        ctx.globalAlpha = (1 - ph) * (1 - age / 4);
        ctx.beginPath(); ctx.arc(px, py, (0.3 + ph * 1.2) * T, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.globalAlpha = 1 - age / 4;
      ctx.fillStyle = pg.c; ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px - 6 * dpr, py - 14 * dpr); ctx.lineTo(px + 6 * dpr, py - 14 * dpr); ctx.closePath(); ctx.fill();
      ctx.globalAlpha = 1;
      // Flèche au bord de l'écran si le signal est hors champ.
      if (px < 0 || py < 0 || px > CW || py > CH) {
        const a = Math.atan2(py - CH / 2, px - CW / 2);
        const ex = CW / 2 + Math.cos(a) * (Math.min(CW, CH) / 2 - 40 * dpr), ey = CH / 2 + Math.sin(a) * (Math.min(CW, CH) / 2 - 40 * dpr);
        ctx.save(); ctx.translate(ex, ey); ctx.rotate(a);
        ctx.fillStyle = pg.c; ctx.beginPath(); ctx.moveTo(14 * dpr, 0); ctx.lineTo(-6 * dpr, -9 * dpr); ctx.lineTo(-6 * dpr, 9 * dpr); ctx.closePath(); ctx.fill();
        ctx.restore();
      }
    }

    // Noms au-dessus des têtes (après la lumière pour rester lisibles).
    ctx.font = `600 ${Math.round(11 * dpr)}px Rubik, system-ui, sans-serif`;
    ctx.textAlign = 'center';
    for (const p of snap.players) {
      if (p.id === myId) continue;
      const o = p.b ? boatsView.get(p.b) : others.get(p.id);
      if (!o) continue;
      const [px, py] = W2S(o.x, o.y);
      const label = p.n;
      const w = ctx.measureText(label).width + 8 * dpr;
      const ly = py - T * (p.b ? 0.75 : 1.05) - (p.b && snap.boats.find((b) => b.id === p.b).seats[1] === p.id ? 14 * dpr : 0);
      ctx.fillStyle = 'rgba(15,29,43,.75)'; ctx.fillRect(px - w / 2, ly - 11 * dpr, w, 15 * dpr);
      ctx.fillStyle = p.c; ctx.fillRect(px - w / 2, ly + 3 * dpr, w, 1.5 * dpr);
      ctx.fillStyle = '#f1e4c3'; ctx.fillText(label, px, ly);
    }
    if (mine && !mine.b && !mine.dn) {
      const [px, py] = W2S(me.x, me.y);
      ctx.fillStyle = mine.c;
      const by = py - T * 1.05 + Math.sin(now / 300) * 2 * dpr;
      ctx.beginPath(); ctx.moveTo(px - 4 * dpr, by - 6 * dpr); ctx.lineTo(px + 4 * dpr, by - 6 * dpr); ctx.lineTo(px, by); ctx.closePath(); ctx.fill();
    }
    // Barre de récolte au-dessus de la cible.
    if (target && target.hold && holdT > 0) {
      const n = target.msg.t === 'harvest' ? nodes.get(target.msg.id) : null;
      const pos = n || (target.msg.t === 'revive' ? others.get(target.msg.id) : null);
      if (pos) {
        const [px, py] = W2S(pos.x, pos.y);
        const w = T * 0.9, f = clamp(holdT / target.dur, 0, 1);
        ctx.fillStyle = 'rgba(15,29,43,.85)'; ctx.fillRect(px - w / 2, py + T * 0.35, w, 5 * dpr);
        ctx.fillStyle = '#f2c14e'; ctx.fillRect(px - w / 2 + dpr, py + T * 0.35 + dpr, (w - 2 * dpr) * f, 3 * dpr);
      }
    }
  }

  // ---------------------------------------------------------------- mini-carte
  function drawOverview(cv, base, scale, big) {
    const g = cv.getContext('2d');
    g.imageSmoothingEnabled = false;
    g.drawImage(base, 0, 0, cv.width, cv.height);
    const k = cv.width / (world.W);
    const camp = world.camp;
    g.fillStyle = '#ef7f5a'; g.fillRect(camp.fire.x * k - 2, camp.fire.y * k - 2, 4, 4);
    for (const b of snap.boats) { const v = boatsView.get(b.id) || b; g.fillStyle = '#6b4423'; g.fillRect(v.x * k - 2, v.y * k - 1.5, 4, 3); }
    for (const p of snap.players) {
      const pos = p.id === myId ? me : (p.b ? boatsView.get(p.b) : others.get(p.id)) || p;
      g.fillStyle = p.c; g.beginPath(); g.arc(pos.x * k, pos.y * k, p.id === myId ? (big ? 6 : 3.5) : (big ? 5 : 2.5), 0, Math.PI * 2); g.fill();
      if (p.id === myId) { g.strokeStyle = '#fff'; g.lineWidth = big ? 2 : 1; g.stroke(); }
      if (big) { g.font = '600 13px Rubik, sans-serif'; g.textAlign = 'center'; g.fillStyle = '#fff'; g.fillText(p.n, pos.x * k, pos.y * k - 10); }
    }
    for (const pg of pings) { g.strokeStyle = pg.c; g.lineWidth = 2; g.beginPath(); g.arc(pg.x * k, pg.y * k, big ? 10 : 5, 0, Math.PI * 2); g.stroke(); }
    if (!big) {
      g.strokeStyle = 'rgba(255,255,255,.6)'; g.lineWidth = 1;
      g.strokeRect((cam.x - CW / 2 / T) * k, (cam.y - CH / 2 / T) * k, (CW / T) * k, (CH / T) * k);
    }
  }

  // ---------------------------------------------------------------- interface
  const logEl = $('log');
  function addLog(text, kind) {
    const li = document.createElement('li');
    li.textContent = text; li.className = kind || '';
    logEl.appendChild(li);
    while (logEl.children.length > 6) logEl.firstChild.remove();
    setTimeout(() => li.classList.add('fade'), 7000);
    setTimeout(() => li.remove(), 7700);
  }
  let noteTimer = 0;
  function showNote(t) { const el = $('note'); el.textContent = t; el.hidden = false; clearTimeout(noteTimer); noteTimer = setTimeout(() => { el.hidden = true; }, 3200); }
  function showIsland(name) { const el = $('island-toast'); el.hidden = true; void el.offsetWidth; el.textContent = name; el.hidden = false; }

  function costHTML(cost, stock) {
    return Object.entries(cost).map(([r, v]) => `<span class="${(stock[r] || 0) < v ? 'miss' : ''}">${v} ${RES_LABEL[r].toLowerCase()}</span>`).join(' · ');
  }
  function resItems(obj, take) {
    return RES.map((r) => `<li class="${obj[r] ? '' : 'zero'}" title="${RES_LABEL[r]}"${take ? ` data-take="${r}" role="button" tabindex="0"` : ''}><img src="${RES_ICON[r]}" alt="">${obj[r] || 0}</li>`).join('');
  }

  let lastPanelKey = '';
  function renderPanels(force) {
    if (!snap) return;
    const p = myself(); if (!p) return;
    // Barres de vie.
    for (const [k, v] of [['hp', p.hp], ['f', p.f], ['s', p.s]]) {
      const el = document.querySelector(`.bar[data-k="${k}"]`);
      el.querySelector('b').style.width = v + '%';
      el.classList.toggle('low', v < 25);
    }
    $('sac-count').textContent = `${A.sacCount(p.inv)}/${C.SAC_CAP}`;
    const sacKey = JSON.stringify(p.inv);
    if (force || $('sac').dataset.k !== sacKey) { $('sac').innerHTML = resItems(p.inv); $('sac').dataset.k = sacKey; }
    const tools = [];
    if (p.tools.hache) tools.push('<span>Hache</span>');
    if (p.tools.pioche) tools.push('<span>Pioche</span>');
    tools.push(`<span class="${p.tl ? 'lit' : ''}">Torches ${p.tools.torches}${p.tl ? ' · allumée' : ''}</span>`);
    $('tools').innerHTML = tools.join('');

    // Horloge.
    $('day').textContent = `Jour ${snap.day}`;
    $('phase').textContent = A.phase(snap.time);
    $('sun-dot').style.left = (snap.time * 100) + '%';
    $('fire').textContent = snap.fire > 0 ? fmtTime(snap.fire) : 'éteint';
    $('fire').parentElement.classList.toggle('out', snap.fire <= 30);

    // Équipage.
    $('crew').innerHTML = snap.players.map((q) => {
      const qx = q.id === myId ? me.x : q.x, qy = q.id === myId ? me.y : q.y;
      const st = q.dn ? 'à terre' : q.b ? 'en mer' : q.cold ? 'a froid' : (islandNear(qx, qy) || {}).name || 'en mer';
      return `<li><i class="dot" style="background:${q.c}"></i><span>${escapeHTML(q.n)}${q.id === myId ? ' (toi)' : ''}</span><span class="st ${q.dn || q.cold ? 'bad' : ''}">${st}</span></li>`;
    }).join('');

    // Pièces du navire.
    const nextIdx = PARTS.findIndex((x) => !snap.parts[x.id]);
    $('ship-track').innerHTML = '<span style="border:0;padding-left:0">Navire</span>' + PARTS.map((x, i) => `<span class="${snap.parts[x.id] ? 'done' : i === nextIdx ? 'next' : ''}">${x.label}</span>`).join('');

    // Panneau du camp.
    const camp = world.camp;
    const near = dist(me, camp.bench) <= C.CAMP_REACH + 0.5 || dist(me, camp.chest) <= C.CAMP_REACH || dist(me, camp.yard) <= C.CAMP_REACH + 1.5;
    $('camp').hidden = !near || p.dn;
    $('downed').hidden = !p.dn || snap.st !== 'playing';
    if (near) {
      const key = JSON.stringify([snap.chest, snap.parts, snap.recup, p.tools, snap.boats.length]);
      if (force || key !== lastPanelKey) {
        lastPanelKey = key;
        $('chest').innerHTML = resItems(snap.chest, true);
        $('recipes').innerHTML = Object.entries(RECIPES).map(([id, r]) => {
          const owned = (id === 'hache' && p.tools.hache) || (id === 'pioche' && p.tools.pioche) || (id === 'recuperateur' && snap.recup);
          const maxed = id === 'barque' && snap.boats.length >= C.MAX_BOATS;
          const ok = A.canAfford(snap.chest, r.cost) && !owned && !maxed;
          return `<button class="recipe ${owned ? 'done' : ''}" data-craft="${id}" ${ok ? '' : 'disabled'}><span class="nm">${r.label}${owned ? ' ✓' : ''}</span><span class="cost">${owned ? 'fait' : maxed ? 'max' : costHTML(r.cost, snap.chest)}</span><span class="ds">${r.desc}</span></button>`;
        }).join('');
        $('parts').innerHTML = PARTS.map((x, i) => {
          const done = snap.parts[x.id];
          const ok = !done && i === nextIdx && A.canAfford(snap.chest, x.cost);
          return `<button class="recipe ${done ? 'done' : ''}" data-build="${x.id}" ${ok ? '' : 'disabled'}><span class="nm">${i + 1}. ${x.label}${done ? ' ✓' : ''}</span><span class="cost">${done ? 'construite' : costHTML(x.cost, snap.chest)}</span></button>`;
        }).join('');
        $('launch').hidden = nextIdx !== -1;
      }
    }

    // Invite d'action.
    if (target) {
      $('prompt').hidden = false;
      $('prompt-text').textContent = target.text;
      $('prompt-progress').parentElement.style.visibility = target.hold ? 'visible' : 'hidden';
      $('prompt-progress').style.width = (target.hold ? clamp(holdT / target.dur, 0, 1) * 100 : 0) + '%';
    } else $('prompt').hidden = true;
  }
  const escapeHTML = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  function showEnd(s) {
    const won = s.st === 'won';
    $('end-eyebrow').textContent = won ? 'Sauvés' : 'Naufrage';
    $('end-title').textContent = won ? `Vous avez quitté l'archipel en ${s.day} jour${s.day > 1 ? 's' : ''} !` : `L'équipe a sombré au jour ${s.day}`;
    $('end-text').textContent = won
      ? `${s.players.map((p) => p.n).join(', ')} prennent la mer à bord du navire construit de leurs mains. Prêts à faire mieux sur une nouvelle île ?`
      : 'Le froid, la faim ou la soif ont eu raison de vous. Gardez le feu allumé la nuit et pensez à relever vos coéquipiers.';
    $('end').hidden = false;
  }

  // ---------------------------------------------------------------- boucle principale
  let prev = performance.now(), uiTimer = 0, miniTimer = 0;
  function frame(t) {
    const dt = Math.min(0.1, (t - prev) / 1000);
    prev = t; now = t;
    update(dt);
    render();
    uiTimer += dt; miniTimer += dt;
    if (uiTimer > 0.1) { uiTimer = 0; renderPanels(false); }
    if (miniTimer > 0.25 && world && snap) {
      miniTimer = 0;
      drawOverview($('minimap'), miniBase, 1.5, false);
      if (!$('bigmap').hidden) drawOverview($('bigmap-canvas'), bigBase, 6, true);
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // Pour les tests automatisés.
  window.__archipel = { get snap() { return snap; }, get me() { return me; }, get myId() { return myId; }, get world() { return world; }, nodes, send };
})();
