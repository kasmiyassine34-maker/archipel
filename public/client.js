// L'Archipel : client navigateur (rendu 2D, commandes, réseau).
(() => {
  'use strict';
  const A = window.ARCHIPEL;
  const { TILE, C, NODES, RECIPES, PARTS, RES, RES_LABEL, WEAPONS, WEAPON_ORDER, ROLES, BEASTS, FRAGMENTS, BOATS } = A;
  const $ = (id) => document.getElementById(id);
  const PA = window.PAPER_ART;
  const P = PA.PALETTE;
  const PX = PA.PX; // pixels par tuile dans l'image de la carte
  const MS = 4;     // pixels par tuile du masque de brume
  const canvas = $('world');
  const ST = { idle: 0, chase: 1, wind: 2, act: 3, stun: 4, flee: 5, sleep: 6 };

  // ---------------------------------------------------------------- utilitaires
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const hash = PA.hash;
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* stockage indisponible */ } },
  };
  const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  const ROMAN = (n) => { let r = ''; for (const [v, l] of [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']]) while (n >= v) { r += l; n -= v; } return r; };
  const escapeHTML = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const b64 = (s) => { const bin = atob(s); const a = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return a; };

  // ---------------------------------------------------------------- état
  let ws = null, myId = null, token = null, roomCode = null;
  let world = null, mapCanvas = null, miniBase = null, bigBase = null, fogMask = null;
  const nodes = new Map();
  let nodeGrid = new Map();
  const sites = new Map();
  let snap = null;
  const others = new Map();     // id -> {x, y} interpolés
  const boatsView = new Map();
  const beastsView = new Map();
  const me = { x: 0, y: 0, dir: 0, moving: false, vx: 0, vy: 0, boatA: 0, aim: 0, swingAt: -9, swingA: 0, dashUntil: 0, dashA: 0, dodgeAt: -9, atkAt: -9, hurtAt: -9 };
  let lastSent = 0, lastSentKey = '';
  let holdT = 0, holdKey = '', workSent = 0;
  let target = null;
  const pings = [];
  const effects = [];
  let lastIsland = null;
  let ended = false;
  let wantReconnect = false, reconnectDelay = 1000;
  let fogNoteAt = 0;
  let lastFrags = 0;
  let lightning = 0, nextBolt = 4;
  const mouse = { x: innerWidth / 2, y: innerHeight / 2 };

  const RES_ICON = PA.icons();

  // ---------------------------------------------------------------- carte
  const tileAt = (x, y) => {
    if (!world) return TILE.DEEP;
    const tx = Math.floor(x), ty = Math.floor(y);
    if (tx < 0 || ty < 0 || tx >= world.W || ty >= world.H) return TILE.DEEP;
    return world.tiles[tx + ty * world.W];
  };
  const seenAt = (x, y) => {
    if (!world) return false;
    const tx = Math.floor(x), ty = Math.floor(y);
    if (tx < 0 || ty < 0 || tx >= world.W || ty >= world.H) return false;
    return world.seen[tx + ty * world.W] === 1;
  };
  const currentAt = (x, y) => {
    const tx = Math.floor(x), ty = Math.floor(y);
    if (!world || tx < 0 || ty < 0 || tx >= world.W || ty >= world.H) return [0, 0];
    const i = (tx + ty * world.W) * 2;
    return [world.currents[i] / 10, world.currents[i + 1] / 10];
  };
  const fragCount = () => (snap && snap.frags ? snap.frags.length : 0);
  const discovered = (I) => snap && snap.isl && snap.isl.includes(I.idx);

  function islandAt(x, y) {
    if (!world || !A.isLand(tileAt(x, y))) return null;
    let best = null, bd = 1e9;
    for (const I of world.islands) { const d = Math.hypot(x - I.x, y - I.y) / I.r; if (d < bd) { bd = d; best = I; } }
    return best;
  }
  function islandNear(x, y) {
    let best = null, bd = 1e9;
    for (const I of world.islands) { const d = Math.hypot(x - I.x, y - I.y) - I.r; if (d < bd) { bd = d; best = I; } }
    return bd < 5 ? best : null;
  }

  function buildMap() {
    const t0 = performance.now();
    mapCanvas = PA.paintMap(world, PX);
    makeOverviews();
    console.debug(`Carte peinte en ${Math.round(performance.now() - t0)} ms`);
  }

  // Le masque de brume : blanc là où l'équipe a déjà regardé. Chaque tuile y laisse une tache aux bords flous.
  function resetFog() {
    fogMask = document.createElement('canvas');
    fogMask.width = world.W * MS; fogMask.height = world.H * MS;
    const all = [];
    for (let i = 0; i < world.seen.length; i++) if (world.seen[i]) all.push(i);
    paintFog(all);
  }
  function paintFog(list) {
    if (!fogMask || !list.length) return;
    const g = fogMask.getContext('2d');
    for (const i of list) {
      const x = i % world.W, y = (i / world.W) | 0;
      const cx = (x + 0.5) * MS, cy = (y + 0.5) * MS, r = MS * (1.15 + hash(x, y, 31) * 0.5);
      const gr = g.createRadialGradient(cx, cy, r * 0.25, cx, cy, r);
      gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr; g.fillRect(cx - r, cy - r, r * 2, r * 2);
    }
    bigDirty = true;
  }
  let bigDirty = true;

  // Papier vierge : là où personne n'est encore allé, la carte reste à dessiner.
  const paperTile = (() => {
    const c = document.createElement('canvas'); c.width = c.height = 256;
    const g = c.getContext('2d');
    const img = g.createImageData(256, 256), d = img.data;
    for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
      const k = 1 + (hash(x, y, 5) - 0.5) * 0.06 + (hash(x >> 3, y >> 1, 9) - 0.5) * 0.025;
      const o = (x + y * 256) * 4;
      d[o] = 240 * k; d[o + 1] = 229 * k; d[o + 2] = 201 * k; d[o + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    return c;
  })();

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
    for (const s of sites.values()) {
      if (s.k !== 'phare' && s.k !== 'ruine') continue;
      const rr = s.k === 'phare' ? 1.1 : 0.9;
      const d = Math.hypot(x - s.x, y - (s.y - 0.4));
      if (d < rr && d < Math.hypot(fromX - s.x, fromY - (s.y - 0.4))) return true;
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
      else if (m.t === 'correct') { me.x = m.x; me.y = m.y; me.vx = me.vy = 0; me.spd = 0; }
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
    preview = false;
    setWorld(m);
    others.clear(); boatsView.clear(); beastsView.clear(); effects.length = 0;
    snap = null; ended = false; lastIsland = null;
    $('end').hidden = true; $('vote').hidden = true;
    $('lobby').hidden = true;
    $('hud').hidden = false;
    $('room-code').textContent = roomCode;
    onSnap(m.snap);
    lastFrags = fragCount();
    const p = snap.players.find((q) => q.id === myId);
    if (p) { me.x = p.x; me.y = p.y; }
    renderPanels(true);
    if (p && !p.r) openRoles();
  }

  // Charge un archipel (celui de la partie, ou l'aperçu de l'écran d'accueil).
  function setWorld(m) {
    const tiles = b64(m.tiles);
    const key = m.tiles.length + ':' + m.tiles.slice(0, 64) + m.tiles.slice(-64) + ':' + m.camp.dock.x + ',' + m.camp.dock.y;
    const same = world && world.seedKey === key && mapCanvas;
    const cur = b64(m.currents);
    world = {
      W: m.W, H: m.H, tiles, islands: m.islands, camp: m.camp, phare: m.phare, seedKey: key,
      currents: new Int8Array(cur.buffer, cur.byteOffset, cur.byteLength),
      seen: m.seen ? b64(m.seen) : new Uint8Array(m.W * m.H).fill(1),
      reefs: new Set(m.reefs || []),
    };
    if (!same) buildMap();
    resetFog();
    nodes.clear();
    for (const [id, k, x, y, amt] of m.nodes) nodes.set(id, { id, k, x, y, amt });
    indexNodes();
    sites.clear();
    for (const s of m.sites || []) sites.set(s.id, { ...s, done: 0, prog: 0, open: 0, lv: [0, 0], wk: 0 });
    bigBase = null;
  }

  // Écran d'accueil : la caméra survole lentement un archipel, comme on feuillette un atlas.
  let preview = false;
  async function loadPreview() {
    try {
      const r = await fetch('preview.json');
      const m = await r.json();
      if (myId) return;
      if (document.fonts) await document.fonts.ready;
      if (myId) return; // la partie a commencé entre-temps
      setWorld(m);
      snap = { time: 0.3, day: 1, st: 'preview', fire: 200, chest: {}, parts: {}, recup: false, players: [], boats: m.boats || [], beasts: [], proj: [], sites: [], nodes: [], ev: [], frags: [], isl: world.islands.map((I) => I.idx), wt: { st: 'calme' } };
      for (const b of snap.boats) boatsView.set(b.id, { x: b.x, y: b.y, a: b.a });
      preview = true;
      me.x = world.camp.fire.x; me.y = world.camp.fire.y;
      cam.x = me.x; cam.y = me.y;
    } catch { /* l'accueil reste lisible sans aperçu */ }
  }

  function onSnap(s) {
    snap = s;
    for (const [id, amt] of s.nodes || []) { const n = nodes.get(id); if (n) n.amt = amt; }
    if (s.fog && s.fog.length && world) { for (const i of s.fog) world.seen[i] = 1; paintFog(s.fog); }
    if (s.nreefs && world) for (const i of s.nreefs) world.reefs.add(i);
    for (const row of s.sites || []) {
      const st = sites.get(row[0]); if (!st) continue;
      st.done = row[1]; st.prog = row[2] / 100; st.open = row[3]; st.lv = row[4] || [0, 0]; st.wk = row[5];
    }
    for (const e of s.ev || []) {
      if (e.ping) { pings.push({ ...e.ping, t: performance.now() }); continue; }
      if (e.fx) { onFx(e.fx); continue; }
      addLog(e.text, e.kind);
    }
    const seen = new Set();
    for (const p of s.players) {
      seen.add(p.id);
      if (p.id === myId) continue;
      let o = others.get(p.id);
      if (!o) { o = { x: p.x, y: p.y, step: 0, an: p.an, dg: p.dg, swingAt: -9, swingA: 0 }; others.set(p.id, o); }
      if (p.an !== o.an) { o.an = p.an; o.swingAt = now; o.swingA = p.aa; }
      if (p.dg !== o.dg) { o.dg = p.dg; o.dodgeAt = now; }
    }
    for (const id of [...others.keys()]) if (!seen.has(id)) others.delete(id);
    for (const b of s.boats) if (!boatsView.has(b.id)) boatsView.set(b.id, { x: b.x, y: b.y, a: b.a });
    const bseen = new Set();
    for (const row of s.beasts || []) {
      const [id, k, x, y, a] = row;
      bseen.add(id);
      let v = beastsView.get(id);
      if (!v) { v = { x, y, a, step: 0, born: now }; beastsView.set(id, v); }
      v.row = row;
    }
    for (const id of [...beastsView.keys()]) if (!bseen.has(id)) beastsView.delete(id);
    const mine = myself();
    if (mine && mine.b) {
      const b = s.boats.find((x) => x.id === mine.b);
      if (b && b.seats[0] !== myId) { me.x = b.x; me.y = b.y; }
      if (b && !me.inBoat) { me.x = b.x; me.y = b.y; me.boatA = b.a; me.vx = me.vy = 0; me.spd = 0; }
    }
    me.inBoat = !!(mine && mine.b);
    const fc = fragCount();
    if (fc >= C.FRAG_NEED && lastFrags < C.FRAG_NEED) bigBase = null;
    lastFrags = fc;
    if (s.st === 'choice') openVote(); else $('vote').hidden = true;
    if ((s.st === 'won' || s.st === 'lost') && !ended) { ended = true; showEnd(s); }
  }

  const myself = () => snap && snap.players.find((p) => p.id === myId);
  const myBoat = () => { const p = myself(); return p && p.b ? snap.boats.find((b) => b.id === p.b) : null; };

  function onFx(f) {
    const t = now;
    if (f.k === 'frag') { showFragment(f.n); return; }
    if (f.k === 'island') return;
    if (f.k === 'hurt' && f.id === myId) { me.hurtAt = t; shake = 1; }
    if (f.k === 'heal' && f.id === myId) me.healAt = t;
    effects.push({ ...f, t });
  }

  // ---------------------------------------------------------------- commandes
  const keys = new Set();
  const typing = () => ['INPUT', 'TEXTAREA'].includes(document.activeElement && document.activeElement.tagName);
  const overlayOpen = () => !$('help').hidden || !$('bigmap').hidden || !$('journal').hidden || !$('roles').hidden;
  window.addEventListener('keydown', (e) => {
    if (typing()) return;
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
    keys.add(e.code);
    if (e.repeat || !snap || preview) return;
    const k = e.key.toLowerCase();
    if (e.key === 'Escape') { for (const id of ['bigmap', 'help', 'journal', 'roles']) $(id).hidden = true; $('frag-toast').hidden = true; return; }
    if (k === 'm') return toggle('bigmap');
    if (k === 'h' || k === '?') return toggle('help');
    if (k === 'j') return toggleJournal();
    if (overlayOpen()) return;
    if (k === 'e') pressInteract();
    else if (k === 'r') cargo();
    else if (k === 'f') send({ t: 'eat' });
    else if (k === 'g') send({ t: 'drink' });
    else if (k === 'b') send({ t: 'bandage' });
    else if (k === 't') repair();
    else if (e.code === 'Space') dodge();
    else if (/^Digit[1-4]$/.test(e.code)) pickWeapon(WEAPON_ORDER[+e.code.slice(5) - 1]);
  });
  window.addEventListener('keyup', (e) => keys.delete(e.code));
  window.addEventListener('blur', () => keys.clear());
  const down = (...codes) => codes.some((c) => keys.has(c));
  const eHeld = () => keys.has('KeyE');

  function toggle(id) { $(id).hidden = !$(id).hidden; if (id === 'bigmap' && !$(id).hidden) bigDirty = true; }

  function pressInteract() {
    if (!target || target.hold) return;
    if (target.journal) { openJournal(target.journal); return; }
    send(target.msg);
  }
  function cargo() {
    const b = myBoat() || nearestBoat(C.REACH + 0.5);
    if (b) send({ t: 'cargo', id: b.id });
  }
  function repair() {
    const b = myBoat() || nearestBoat(C.REACH + 0.8);
    if (b) send({ t: 'repair', id: b.id });
  }
  function nearestBoat(r) {
    let best = null, bd = r;
    for (const b of snap.boats) { const v = boatsView.get(b.id) || b; const d = dist(me, v); if (d <= bd) { bd = d; best = b; } }
    return best;
  }
  function pickWeapon(w) {
    const p = myself(); if (!p) return;
    if (w !== 'mains' && !p.tools[w]) { showNote(`Pas de ${WEAPONS[w].label.toLowerCase()} : fabrique-la à l'atelier du camp.`); return; }
    send({ t: 'weapon', w });
  }

  function canAct() {
    const p = myself();
    return p && snap.st === 'playing' && !p.dn && !p.b && !overlayOpen();
  }
  function attack() {
    if (!canAct()) return;
    const p = myself();
    const w = WEAPONS[p.w] || WEAPONS.mains;
    if (now - me.atkAt < w.cd * 1000) return;
    if (p.w === 'fronde' && !(p.inv.pierre > 0)) { showNote('Il te faut des pierres dans ton sac pour la fronde.'); return; }
    me.atkAt = now;
    const a = aimAngle();
    me.swingAt = now; me.swingA = a; me.dir = a;
    send({ t: 'atk', a: +a.toFixed(3) });
  }
  function dodge() {
    if (!canAct() || now - me.dodgeAt < C.DODGE_CD * 1000) return;
    me.dodgeAt = now;
    me.dashUntil = now + C.DODGE_TIME * 1000;
    const ix = (down('KeyD', 'ArrowRight') ? 1 : 0) - (down('KeyA', 'ArrowLeft') ? 1 : 0);
    const iy = (down('KeyS', 'ArrowDown') ? 1 : 0) - (down('KeyW', 'ArrowUp') ? 1 : 0);
    me.dashA = ix || iy ? Math.atan2(iy, ix) : aimAngle() + Math.PI;
    send({ t: 'dodge' });
  }
  function aimAngle() {
    const w = screenToWorld(mouse.x, mouse.y);
    return Math.atan2(w.y - (me.y - 0.35), w.x - me.x);
  }

  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (!snap || preview) return;
    const w = screenToWorld(e.clientX, e.clientY);
    send({ t: 'ping', x: w.x, y: w.y });
  });
  canvas.addEventListener('mousemove', (e) => { mouse.x = e.clientX; mouse.y = e.clientY; });
  canvas.addEventListener('mousedown', (e) => { mouse.x = e.clientX; mouse.y = e.clientY; if (e.button === 0 && snap && !preview) attack(); });
  $('minimap').addEventListener('click', () => toggle('bigmap'));
  $('bigmap').addEventListener('click', (e) => { if (e.target.id === 'bigmap') $('bigmap').hidden = true; });
  $('journal').addEventListener('click', (e) => { if (e.target.id === 'journal' || e.target.closest('[data-close]')) $('journal').hidden = true; });
  $('help-close').addEventListener('click', () => { $('help').hidden = true; });
  $('restart').addEventListener('click', () => send({ t: 'restart' }));
  $('launch').addEventListener('click', () => send({ t: 'launch' }));
  $('frag-toast').addEventListener('click', () => { $('frag-toast').hidden = true; });
  $('copy-link').addEventListener('click', async () => {
    const url = location.origin + location.pathname + '#' + roomCode;
    try { await navigator.clipboard.writeText(url); showNote('Lien copié. Envoie-le à tes amis !'); }
    catch { showNote(url); }
  });
  $('camp').addEventListener('click', (e) => {
    const b = e.target.closest('[data-craft],[data-build],[data-take],[data-repair]');
    if (!b || b.disabled) return;
    if (b.dataset.craft) send({ t: 'craft', id: b.dataset.craft });
    if (b.dataset.build) send({ t: 'build', id: b.dataset.build });
    if (b.dataset.take) send({ t: 'take', res: b.dataset.take });
    if (b.dataset.repair) send({ t: 'repair', id: +b.dataset.repair });
  });
  $('weapons').addEventListener('click', (e) => { const b = e.target.closest('[data-w]'); if (b) pickWeapon(b.dataset.w); });
  $('roles').addEventListener('click', (e) => {
    const b = e.target.closest('[data-role]');
    if (b && !b.disabled) { send({ t: 'role', r: b.dataset.role }); $('roles').hidden = true; }
    if (e.target.closest('[data-close]')) $('roles').hidden = true;
  });
  $('role-line').addEventListener('click', openRoles);
  $('vote').addEventListener('click', (e) => { const b = e.target.closest('[data-vote]'); if (b) send({ t: 'vote', v: b.dataset.vote }); });

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
  function showLobbyError(t, soft) { const el = $('lobby-error'); el.textContent = t; el.hidden = false; el.style.color = soft ? 'var(--ink-2)' : ''; el.style.fontStyle = soft ? 'italic' : ''; }
  function hideLobbyError() { $('lobby-error').hidden = true; }

  // ---------------------------------------------------------------- simulation locale
  function windNow() {
    const w = snap && snap.wt;
    if (!w) return [0, 0];
    const k = w.st === 'tempete' ? 1.3 : w.st === 'annonce' ? 0.35 : 0;
    return [w.wx * k, w.wy * k];
  }
  function inFogBank(x, y) {
    const ph = world.phare;
    return ph && fragCount() < C.FRAG_NEED && Math.hypot(x - ph.x, y - ph.y) < ph.zone;
  }

  function update(dt) {
    if (!snap || !world) return;
    const mine = myself();
    if (!mine) return;
    let ix = (down('KeyD', 'ArrowRight') ? 1 : 0) - (down('KeyA', 'ArrowLeft') ? 1 : 0);
    let iy = (down('KeyS', 'ArrowDown') ? 1 : 0) - (down('KeyW', 'ArrowUp') ? 1 : 0);
    const il = Math.hypot(ix, iy); if (il) { ix /= il; iy /= il; }
    const playing = snap.st === 'playing' && !mine.dn && !overlayOpen();
    if (!playing) ix = iy = 0;

    const boat = myBoat();
    if (boat) {
      const bv = boatsView.get(boat.id);
      if (boat.seats[0] === myId) {
        // Pilotage d'une vraie barque : avant/arrière pour ramer, gauche/droite pour tourner.
        const speed = BOATS[boat.k || 'barque'].speed(boat.seats.length);
        const thrust = playing ? -iy : 0, turn = playing ? ix : 0;
        const want = thrust > 0 ? speed : thrust < 0 ? -speed * 0.55 : 0;
        me.spd = (me.spd || 0) + (want - (me.spd || 0)) * Math.min(1, dt * (want ? 2.2 : 1.4));
        const len = boat.k === 'grande' ? 0.85 : 0.55;
        // Nombre de points de la coque (centre, proue, poupe) posés sur la terre.
        const grounded = (x, y, a) => {
          if (!A.boatable(tileAt(x, y))) return 99;
          if (inFogBank(x, y)) return 50;
          const fx = Math.cos(a) * len, fy = Math.sin(a) * len;
          return (A.boatable(tileAt(x + fx, y + fy)) ? 0 : 1) + (A.boatable(tileAt(x - fx, y - fy)) ? 0 : 1);
        };
        // On ne refuse un mouvement que s'il échoue davantage la barque : elle peut toujours se dégager.
        const na = me.boatA + turn * (boat.k === 'grande' ? 1.7 : 2.4) * dt * (me.spd < -0.2 ? -1 : 1);
        if (turn && grounded(me.x, me.y, na) <= grounded(me.x, me.y, me.boatA)) me.boatA = na;
        const [cx, cy] = currentAt(me.x, me.y), [wx, wy] = windNow();
        const vx = Math.cos(me.boatA) * me.spd + cx + wx, vy = Math.sin(me.boatA) * me.spd + cy + wy;
        const here = grounded(me.x, me.y, me.boatA);
        const nx = me.x + vx * dt, ny = me.y + vy * dt;
        let hit = false;
        if (grounded(nx, me.y, me.boatA) <= here) me.x = nx; else hit = true;
        if (grounded(me.x, ny, me.boatA) <= here) me.y = ny; else hit = true;
        if (hit) {
          me.spd *= 0.3;
          if ((inFogBank(nx, me.y) || inFogBank(me.x, ny)) && now - fogNoteAt > 4000) { fogNoteAt = now; showNote('La brume est trop épaisse : impossible de tenir un cap. Il vous faut au moins trois fragments.'); }
        }
        me.vx = vx; me.vy = vy;
        me.moving = Math.abs(me.spd) > 0.25;
        if (bv) { bv.x = me.x; bv.y = me.y; bv.a = me.boatA; }
      } else if (bv) { me.x = bv.x; me.y = bv.y; me.moving = false; }
    } else {
      let dx = ix, dy = iy, speed = tileAt(me.x, me.y) === TILE.SHALLOW ? C.SPEED_WADE : C.SPEED_WALK;
      if (now < me.dashUntil && playing) { dx = Math.cos(me.dashA); dy = Math.sin(me.dashA); speed = C.DODGE_SPEED; }
      if (dx || dy) {
        const nx = me.x + dx * speed * dt, ny = me.y + dy * speed * dt;
        if (A.walkable(tileAt(nx, me.y)) && !blockedBySolid(nx, me.y, me.x, me.y)) me.x = nx;
        if (A.walkable(tileAt(me.x, ny)) && !blockedBySolid(me.x, ny, me.x, me.y)) me.y = ny;
        if (now >= me.dashUntil) me.dir = Math.atan2(dy, dx);
        me.moving = true;
      } else me.moving = false;
    }
    if (me.moving) me.step = (me.step || 0) + dt * 9;

    // Envoi de la position (15 fois par seconde au plus).
    const t = performance.now();
    if (t - lastSent > 66) {
      const drive = boat && boat.seats[0] === myId;
      const m = drive ? { t: 'pos', x: +me.x.toFixed(2), y: +me.y.toFixed(2), a: +me.boatA.toFixed(2) } : { t: 'pos', x: +me.x.toFixed(2), y: +me.y.toFixed(2), d: +me.dir.toFixed(2) };
      const key = JSON.stringify(m);
      if ((!boat || drive) && (key !== lastSentKey || t - lastSent > 1000)) { send(m); lastSentKey = key; lastSent = t; }
    }

    // Interpolation des autres joueurs, des barques et des bêtes.
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
      v.a += A.angleDiff(b.a, v.a) * k;
    }
    for (const v of beastsView.values()) {
      const [, , x, y, a] = v.row;
      const ox = v.x, oy = v.y;
      v.x += (x - v.x) * k; v.y += (y - v.y) * k;
      v.a += A.angleDiff(a, v.a) * k;
      const mv = Math.hypot(v.x - ox, v.y - oy) / Math.max(dt, 1e-3);
      v.moving = mv > 0.3; if (v.moving) v.step += dt * 11;
    }

    // Cible d'interaction.
    target = playing ? findTarget(mine, boat) : null;
    const key = target ? target.key : '';
    if (key !== holdKey) { holdKey = key; holdT = 0; }
    if (target && target.hold && eHeld()) {
      holdT += dt;
      if (target.work) {
        if (t - workSent > 220) { workSent = t; send(target.msg); }
      } else if (holdT >= target.dur) { send(target.msg); holdT = 0; }
    } else holdT = Math.max(0, holdT - dt * 2);

    // Nom de l'île en arrivant.
    const I = islandAt(me.x, me.y);
    if (I && I.id !== lastIsland) { lastIsland = I.id; showIsland(I); }
  }

  const SITE_TEXT = { carnet: 'lire le carnet', epave: "fouiller l'épave", coffret: 'ouvrir le coffret', stele: 'relever la stèle', ruine: 'déchiffrer la fresque' };
  function findTarget(mine, boat) {
    const cands = [];
    const sac = A.sacCount(mine.inv);
    // Relever un coéquipier passe avant tout.
    for (const p of snap.players) {
      if (p.id === myId || !p.dn) continue;
      const o = others.get(p.id) || p;
      if (dist(me, o) <= C.REACH + 0.4) return { key: 'rev' + p.id, hold: true, dur: C.REVIVE_TIME * (mine.r === 'herboriste' ? 0.5 : 1), msg: { t: 'revive', id: p.id }, pos: o, text: `Maintenir E : relever ${p.n}` };
    }
    if (boat) {
      const extra = sac || A.sacCount(boat.hold) ? ' · R : cale' : '';
      return { key: 'leave', msg: { t: 'leave' }, text: 'E : Débarquer' + extra };
    }
    if (mine.r === 'herboriste') {
      for (const p of snap.players) {
        if (p.id === myId || p.dn || p.b || p.hp >= 90) continue;
        const o = others.get(p.id) || p;
        const d = dist(me, o);
        if (d <= C.REACH + 0.3) cands.push({ d: d - 0.6, key: 'heal' + p.id, hold: true, dur: 1.2, msg: { t: 'heal', id: p.id }, pos: o, text: `Maintenir E : soigner ${p.n} (${p.hp} %)` });
      }
    }
    for (const b of snap.boats) {
      const v = boatsView.get(b.id) || b;
      const d = dist(me, v);
      if (d > C.REACH + 0.3) continue;
      const B = BOATS[b.k || 'barque'];
      const full = b.seats.length >= B.seats;
      const hold = A.sacCount(b.hold);
      const dmg = b.hull < B.hull - 1 ? ` · T : réparer (${Math.round((b.hull / B.hull) * 100)} %)` : '';
      cands.push({ d: d - 0.2, key: 'boat' + b.id, msg: { t: 'board', id: b.id },
        text: (full ? `${B.label} pleine` : b.seats.length ? 'E : Rejoindre à la rame' : `E : Monter dans la ${B.label.toLowerCase()}`) + (sac || hold ? ` · R : cale (${hold}/${B.hold})` : '') + dmg });
    }
    // Sites du mystère.
    for (const s of sites.values()) {
      if (!seenAt(s.x, s.y)) continue;
      if (s.k === 'ruine' && !s.open && !s.done) {
        s.levers.forEach((l, i) => {
          const d = dist(me, l);
          if (d > C.REACH + 0.3) return;
          const other = s.lv[1 - i];
          cands.push({ d, key: `lev${s.id}.${i}`, hold: true, work: true, msg: { t: 'work', id: s.id, l: i }, pos: l,
            text: snap.players.length <= 1 ? 'Maintenir E : abaisser le levier (puis vite l\'autre)' : other ? 'Maintenir E : l\'autre levier est baissé, tiens bon !' : 'Maintenir E : tenir le levier · il faut être deux' });
        });
        continue;
      }
      const d = dist(me, s);
      if (d > C.REACH + 0.4) continue;
      if (s.k === 'phare') {
        if (fragCount() >= C.FRAGS && snap.gd) cands.push({ d, key: 'ritual', msg: { t: 'ritual' }, text: 'E : Accomplir le rituel de la flamme blanche (6 bois, 3 pierres, 3 eau)' });
        else cands.push({ d, key: 'douse', hold: true, work: true, msg: { t: 'work', id: s.id }, pos: s, prog: () => s.prog, text: 'Maintenir E : étouffer la flamme noire' + (snap.gd ? '' : ' · pendant que les autres occupent le Gardien') });
        continue;
      }
      if (s.done) { cands.push({ d: d + 0.3, key: 're' + s.id, journal: s.frag, text: `E : relire le fragment ${ROMAN(s.frag)}` }); continue; }
      const need = s.k === 'stele' && snap.players.length > 1 ? ` · à deux (${Math.min(2, s.wk)}/2)` : '';
      cands.push({ d, key: 'site' + s.id, hold: true, work: true, msg: { t: 'work', id: s.id }, pos: s, prog: () => s.prog, text: `Maintenir E : ${SITE_TEXT[s.k]}${need}` });
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
      const dur = def.dur * (tool ? 0.5 : 1) * (n.k === 'tree' && mine.r === 'charpentier' ? 0.7 : 1);
      cands.push({ d, key: 'n' + n.id, hold: !full, dur, msg: { t: 'harvest', id: n.id }, pos: n,
        text: full ? 'Sac plein : dépose-le au coffre ou en barque (R)' : `Maintenir E : ${def.label}${n.k === 'spring' ? ' · G : boire' : ''}` });
    }
    cands.sort((a, b) => a.d - b.d);
    return cands[0] || null;
  }

  // ---------------------------------------------------------------- rendu
  const ctx = canvas.getContext('2d');
  const light = document.createElement('canvas');
  const lctx = light.getContext('2d');
  const fogC = document.createElement('canvas');
  const fctx = fogC.getContext('2d');
  let T = 32, dpr = 1, CW = 0, CH = 0, shake = 0;
  function resize() {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    CW = canvas.width = Math.round(innerWidth * dpr);
    CH = canvas.height = Math.round(innerHeight * dpr);
    light.width = CW; light.height = CH;
    fogC.width = CW; fogC.height = CH;
    // Une tuile mesure entre 30 et 48 pixels CSS selon la taille de l'écran.
    T = Math.round(clamp(innerWidth / 34, 30, 48) * dpr);
  }
  window.addEventListener('resize', resize);
  resize();

  const cam = { x: 0, y: 0, ox: 0, oy: 0 };
  const W2S = (x, y) => [Math.round((x - cam.x) * T + CW / 2 + cam.ox), Math.round((y - cam.y) * T + CH / 2 + cam.oy)];
  function screenToWorld(cx, cy) { return { x: (cx * dpr - CW / 2 - cam.ox) / T + cam.x, y: (cy * dpr - CH / 2 - cam.oy) / T + cam.y }; }

  // Dessine autour d'un point du monde, en unités de carte (PX par tuile), à l'encre.
  function sprite(x, y, fn, rot = 0) {
    const [sx, sy] = W2S(x, y);
    const s = T / PX;
    ctx.save();
    ctx.translate(sx, sy);
    if (rot) ctx.rotate(rot);
    ctx.scale(s, s);
    ctx.lineWidth = 1.15; ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.strokeStyle = P.ink;
    fn(ctx);
    ctx.restore();
  }
  // Ombre à la manière des cartes : trois petits traits horizontaux.
  function groundHatch(g, w, y, seed) {
    g.save(); g.globalAlpha = 0.45; g.lineWidth = 0.9;
    g.beginPath();
    for (let i = 0; i < 3; i++) {
      const l = w * (1 - i * 0.28), ox = (hash(seed, i, 2) - 0.5) * 2 + w * 0.25;
      g.moveTo(ox - l / 2, y + i * 1.6); g.lineTo(ox + l / 2, y + i * 1.6);
    }
    g.stroke(); g.restore();
  }
  // Hachures dans une forme déjà tracée (côté ombre, en bas à droite).
  function shadeInside(g, x0, y0, x1, y1, step = 2.2) {
    g.save(); g.clip(); g.globalAlpha = 0.55; g.lineWidth = 0.75;
    g.beginPath();
    for (let x = x0; x <= x1 + (y1 - y0); x += step) { g.moveTo(x, y0); g.lineTo(x - (y1 - y0), y1); }
    g.stroke(); g.restore();
  }

  let now = 0;
  function isPineAt(x, y) {
    const I = islandNear(x, y);
    return I && I.biome === 'foret';
  }
  function drawTree(n) {
    sprite(n.x, n.y, (g) => {
      if (n.amt <= 0) {
        groundHatch(g, 8, 3, n.id);
        g.fillStyle = 'rgb(214,182,132)'; g.beginPath(); g.ellipse(0, 1, 4, 2.4, 0, 0, Math.PI * 2); g.fill(); g.stroke();
        g.beginPath(); g.ellipse(0, 1, 1.8, 1, 0, 0, Math.PI * 2); g.stroke();
        return;
      }
      const sw = Math.sin(now / 1300 + n.id) * 0.5 * (stormK() * 3 + 1);
      groundHatch(g, 12, 5, n.id);
      g.lineWidth = 1.6; g.beginPath(); g.moveTo(0, 6); g.lineTo(sw * 0.4, -3); g.stroke(); g.lineWidth = 1.15;
      if (n.pine ?? (n.pine = isPineAt(n.x, n.y))) {
        const pts = [[sw, -24], [-5, -14], [-3, -14], [-8, -5], [-4, -5], [-9, 3], [9, 3], [4, -5], [8, -5], [3, -14], [5, -14]];
        PA.wobblyPoly(g, pts, n.id, 0.8);
        g.fillStyle = P.pine; g.fill(); g.stroke();
        PA.wobblyPoly(g, pts, n.id, 0.8); shadeInside(g, sw, -24, 9, 3);
      } else {
        PA.wobblyCircle(g, sw, -9, 8.5, n.id, 0.1);
        g.fillStyle = P.leaf; g.fill(); g.stroke();
        PA.wobblyCircle(g, sw, -9, 8.5, n.id, 0.1); shadeInside(g, sw + 1, -14, sw + 9, -1);
        g.strokeStyle = 'rgba(250,240,210,.75)'; g.beginPath(); g.arc(sw - 2.5, -11.5, 3.5, Math.PI * 1.05, Math.PI * 1.6); g.stroke();
      }
      if (n.amt < NODES.tree.max) { g.fillStyle = 'rgb(214,182,132)'; g.fillRect(1.5, 3, 1.6, 1.2); g.fillRect(-3.2, 4.2, 1.4, 1); }
    });
  }
  function drawRock(n) {
    sprite(n.x, n.y, (g) => {
      if (n.amt <= 0) {
        g.fillStyle = P.stone;
        for (const [x, y, r] of [[-3, 2, 1.6], [2, 3, 1.3], [4, 0, 1]]) { g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill(); g.stroke(); }
        return;
      }
      const k = 0.65 + 0.35 * (n.amt / NODES.rock.max);
      g.scale(k, k);
      groundHatch(g, 14, 6, n.id);
      const pts = [[-9, 5], [-8, -3], [-3, -8], [4, -7], [9, -1], [8, 5]];
      PA.wobblyPoly(g, pts, n.id, 1.2); g.fillStyle = P.stone; g.fill(); g.stroke();
      PA.wobblyPoly(g, pts, n.id, 1.2); shadeInside(g, 1, -8, 9, 6, 1.8);
      g.beginPath(); g.moveTo(-3, -8); g.lineTo(-1, -2); g.lineTo(-8, -1); g.stroke();
    });
  }
  function drawBush(n) {
    sprite(n.x, n.y, (g) => {
      groundHatch(g, 11, 4, n.id);
      g.fillStyle = P.leaf;
      for (const [x, y, r, s] of [[-4, -2, 4.5, 1], [3.5, -2.5, 4.5, 2], [0, -6, 4.5, 3]]) { PA.wobblyCircle(g, x, y, r, n.id * 7 + s, 0.12, 10); g.fill(); g.stroke(); }
      for (let i = 0; i < n.amt * 2; i++) {
        const a = hash(n.id, i, 3) * Math.PI * 2, r = 1 + hash(n.id, i, 4) * 4.5;
        g.fillStyle = P.berry; g.beginPath(); g.arc(Math.cos(a) * r, Math.sin(a) * r - 3.5, 1.3, 0, Math.PI * 2); g.fill();
        g.lineWidth = 0.6; g.stroke(); g.lineWidth = 1.15;
      }
    });
  }
  function drawFlax(n) {
    sprite(n.x, n.y, (g) => {
      g.strokeStyle = 'rgb(84,110,58)';
      const h = n.amt > 0 ? 12 : 3;
      for (let i = 0; i < 6; i++) {
        const x = -5 + i * 2, sw = n.amt > 0 ? Math.sin(now / 700 + n.id + i) * 1 : 0;
        g.beginPath(); g.moveTo(x, 3); g.quadraticCurveTo(x, 3 - h * 0.6, x + sw, 3 - h + (i % 2) * 2); g.stroke();
      }
      g.strokeStyle = P.ink;
      if (n.amt > 0) for (let i = 0; i < n.amt + 2; i++) {
        const x = -5 + i * 2 + Math.sin(now / 700 + n.id + i);
        g.fillStyle = P.flax; g.beginPath(); g.arc(x, -9 + (i % 2) * 2, 1.4, 0, Math.PI * 2); g.fill(); g.lineWidth = 0.6; g.stroke(); g.lineWidth = 1.15;
      }
    });
  }
  function drawSpring(n) {
    sprite(n.x, n.y, (g) => {
      g.fillStyle = P.stone;
      for (let i = 0; i < 9; i++) { const a = (i / 9) * Math.PI * 2; PA.wobblyCircle(g, Math.cos(a) * 8.5, Math.sin(a) * 5.5, 1.8, n.id * 9 + i, 0.2, 7); g.fill(); g.stroke(); }
      g.fillStyle = 'rgb(130,178,200)'; g.beginPath(); g.ellipse(0, 0, 7, 4.3, 0, 0, Math.PI * 2); g.fill(); g.stroke();
      const t = (now / 1800 + n.id * 0.3) % 1;
      g.save(); g.globalAlpha = 1 - t; g.strokeStyle = 'rgb(46,80,110)'; g.lineWidth = 0.7;
      g.beginPath(); g.ellipse(0, 0, 1 + t * 5.5, 0.6 + t * 3.3, 0, 0, Math.PI * 2); g.stroke(); g.restore();
    });
  }
  function drawChest(p) {
    sprite(p.x, p.y, (g) => {
      groundHatch(g, 16, 5, 1);
      PA.wobblyPoly(g, [[-8, -7], [8, -7], [8, 5], [-8, 5]], 3, 0.6); g.fillStyle = P.wood; g.fill(); g.stroke();
      g.beginPath(); g.moveTo(-8, -3); g.lineTo(8, -3); g.stroke();
      g.fillStyle = 'rgb(196,150,64)'; g.fillRect(-1.5, -5, 3, 4); g.strokeRect(-1.5, -5, 3, 4);
      g.lineWidth = 0.7; g.beginPath(); for (const x of [-5, 4]) { g.moveTo(x, -2); g.lineTo(x, 5); } g.stroke();
    });
  }
  function drawBench(p) {
    sprite(p.x, p.y, (g) => {
      groundHatch(g, 18, 5, 2);
      g.lineWidth = 1.5; g.beginPath(); g.moveTo(-7, -2); g.lineTo(-8, 5); g.moveTo(7, -2); g.lineTo(8, 5); g.stroke(); g.lineWidth = 1.15;
      PA.wobblyPoly(g, [[-10, -5], [10, -5], [10, -2], [-10, -2]], 4, 0.4); g.fillStyle = P.wood; g.fill(); g.stroke();
      g.beginPath(); g.moveTo(-6, -6); g.lineTo(0, -9); g.stroke();
      g.fillStyle = P.stone; PA.wobblyPoly(g, [[-1, -11], [2, -10], [1, -7], [-1, -8]], 5, 0.3); g.fill(); g.stroke();
      g.fillStyle = P.woodDark; g.fillRect(3, -9, 5, 3); g.strokeRect(3, -9, 5, 3);
    });
  }
  function flame(g, o, col, w, h) {
    const k = 1 + Math.sin(now / 95 + o) * 0.14, tip = Math.sin(now / 140 + o) * 1.4;
    g.beginPath(); g.moveTo(-w, 1);
    g.bezierCurveTo(-w * 1.1, -h * 0.4 * k, -w * 0.3, -h * 0.6 * k, tip, -h * k);
    g.bezierCurveTo(w * 0.3, -h * 0.6 * k, w * 1.1, -h * 0.4 * k, w, 1);
    g.closePath(); g.fillStyle = col; g.fill();
  }
  function drawFire(f, fuel) {
    sprite(f.x, f.y, (g) => {
      g.fillStyle = P.stone;
      for (let i = 0; i < 9; i++) { const a = (i / 9) * Math.PI * 2; PA.wobblyCircle(g, Math.cos(a) * 7, Math.sin(a) * 4, 1.9, 40 + i, 0.2, 7); g.fill(); g.stroke(); }
      g.lineWidth = 2.2; g.strokeStyle = P.woodDark;
      g.beginPath(); g.moveTo(-5, 2); g.lineTo(5, -2); g.moveTo(-5, -2); g.lineTo(5, 2); g.stroke();
      g.lineWidth = 1.15; g.strokeStyle = P.ink;
      if (fuel > 0) {
        const s = clamp(fuel / 120, 0.5, 1.1);
        flame(g, 0, 'rgba(196,74,40,.9)', 5 * s, 15 * s); g.stroke();
        flame(g, 1.7, 'rgba(226,130,52,.95)', 3.4 * s, 10 * s);
        flame(g, 3.1, 'rgba(244,206,120,.95)', 1.8 * s, 6 * s);
        for (let i = 0; i < 4; i++) {
          const t = ((now / 1000 + i / 4) % 1);
          g.fillStyle = `rgba(158,58,36,${1 - t})`; g.beginPath(); g.arc(Math.sin(i * 7 + now / 400) * 4, -8 - t * 16, 0.8, 0, Math.PI * 2); g.fill();
        }
      } else {
        g.save(); g.lineWidth = 0.8;
        for (let i = 0; i < 2; i++) {
          const t = ((now / 2200 + i / 2) % 1);
          g.globalAlpha = 0.5 * (1 - t);
          g.beginPath(); g.arc(Math.sin(i * 3 + now / 900) * 2, -4 - t * 14, 2 + t * 3, Math.PI * 0.2, Math.PI * 1.4); g.stroke();
        }
        g.restore();
      }
    });
  }
  // Le navire en construction : les pièces manquantes sont esquissées en pointillés, comme un plan.
  function drawShip(parts) {
    const y = world.camp.yard, d = world.camp.dock;
    const ang = Math.atan2(d.y - y.y, d.x - y.x);
    const ghost = (g, done, fn) => {
      g.save();
      if (!done) { g.setLineDash([2, 2.5]); g.globalAlpha = 0.45; }
      fn(g, done); g.restore();
    };
    sprite(y.x, y.y, (g) => {
      g.save(); g.lineWidth = 1; g.globalAlpha = 0.8;
      g.beginPath(); g.moveTo(-30, -10); g.lineTo(30, -10); g.moveTo(-30, 10); g.lineTo(30, 10); g.stroke();
      g.lineWidth = 0.8; g.beginPath(); for (let i = -28; i <= 28; i += 5) { g.moveTo(i, -10); g.lineTo(i, 10); } g.stroke();
      g.restore();
      const hull = [[-24, -8], [18, -8], [28, 0], [18, 8], [-24, 8], [-27, 0]];
      ghost(g, parts.coque, (g, done) => {
        PA.wobblyPoly(g, hull, 77, done ? 0.5 : 0);
        if (done) { g.fillStyle = P.wood; g.fill(); }
        g.stroke();
        if (done) { g.lineWidth = 0.7; g.beginPath(); for (let i = -20; i < 18; i += 5) { g.moveTo(i, -8); g.lineTo(i, 8); } g.stroke(); }
      });
      ghost(g, parts.quille, (g) => { g.lineWidth = 2; g.beginPath(); g.moveTo(-26, 0); g.lineTo(27, 0); g.stroke(); });
      ghost(g, parts.vivres, (g, done) => {
        for (const x of [-18, -12]) { g.beginPath(); g.ellipse(x, 0, 2.6, 3.6, 0, 0, Math.PI * 2); if (done) { g.fillStyle = P.woodDark; g.fill(); } g.stroke(); }
      });
    }, ang);
    sprite(y.x, y.y, (g) => {
      ghost(g, parts.mat, (g) => {
        g.lineWidth = 2; g.beginPath(); g.moveTo(0, 0); g.lineTo(0, -40); g.stroke();
        g.lineWidth = 1.4; g.beginPath(); g.moveTo(-11, -33); g.lineTo(11, -33); g.stroke();
      });
      ghost(g, parts.voiles, (g, done) => {
        const b = done ? Math.sin(now / 800) * 1.6 : 0;
        g.beginPath(); g.moveTo(-10, -32); g.quadraticCurveTo(-3 + b, -22, -10, -11); g.lineTo(10, -11); g.quadraticCurveTo(15 + b, -22, 10, -32); g.closePath();
        if (done) { g.fillStyle = 'rgb(244,236,214)'; g.fill(); }
        g.stroke();
        if (done) { g.fillStyle = P.red; g.fillRect(-8, -23, 18, 2.4); g.beginPath(); g.moveTo(0, -40); g.lineTo(7, -38); g.lineTo(0, -36); g.closePath(); g.fill(); g.stroke(); }
      });
    });
  }
  function drawBoat(b, v) {
    const moving = Math.hypot(v.x - (v.lx ?? v.x), v.y - (v.ly ?? v.y)) > 0.002;
    const big = b.k === 'grande';
    sprite(v.x, v.y, (g) => {
      if (big) g.scale(1.45, 1.25);
      if (moving) {
        g.save(); g.globalAlpha = 0.55; g.lineWidth = 0.8;
        for (let i = 0; i < 3; i++) {
          const x = -16 - i * 5, o = Math.sin(now / 200 + i) * 0.8;
          g.beginPath(); g.arc(x, -5 - i * 1.2 + o, 2, 0, Math.PI); g.arc(x - 4, -5 - i * 1.2 + o, 2, 0, Math.PI); g.stroke();
          g.beginPath(); g.arc(x, 5 + i * 1.2 - o, 2, Math.PI, Math.PI * 2); g.stroke();
        }
        g.restore();
      }
      const hull = [[-13, -5], [8, -6], [15, 0], [8, 6], [-13, 5], [-14, 0]];
      PA.wobblyPoly(g, hull, b.id * 13, 0.4); g.fillStyle = big ? P.woodDark : P.wood; g.fill(); g.stroke();
      PA.wobblyPoly(g, [[-11, -3], [7, -4], [11, 0], [7, 4], [-11, 3]], b.id * 13 + 1, 0.3); g.fillStyle = 'rgb(196,150,98)'; g.fill(); g.stroke();
      g.lineWidth = 1.4; g.beginPath(); g.moveTo(-3, -3.5); g.lineTo(-3, 3.5); g.moveTo(4, -3.8); g.lineTo(4, 3.8); if (big) { g.moveTo(-8.5, -3.2); g.lineTo(-8.5, 3.2); } g.stroke(); g.lineWidth = 1.15;
      if (big) { g.save(); g.lineWidth = 0.6; g.beginPath(); g.moveTo(-13, -5); g.lineTo(8, -6); g.moveTo(-13, 5); g.lineTo(8, 6); g.setLineDash([1, 1.6]); g.stroke(); g.restore(); }
      // Une coque abîmée se voit : planches fendues.
      const B = BOATS[b.k || 'barque'];
      if (b.hull < B.hull * 0.6) { g.save(); g.strokeStyle = P.red; g.lineWidth = 0.8; g.beginPath(); g.moveTo(-6, -5); g.lineTo(-4, -2); g.lineTo(-6, 0); g.moveTo(5, 5.5); g.lineTo(3, 3); g.stroke(); g.restore(); }
      const hold = A.sacCount(b.hold || {});
      if (hold > 0) {
        g.fillStyle = 'rgb(214,182,132)'; g.fillRect(-10, -2.5, 5, 5); g.strokeRect(-10, -2.5, 5, 5);
        if (hold > 12) { g.fillRect(5.5, -2, 4, 4); g.strokeRect(5.5, -2, 4, 4); }
      }
      if (b.seats.length) {
        const ph = moving ? Math.sin(now / 170) : 0;
        g.lineWidth = 1.3;
        g.beginPath(); g.moveTo(0, -4); g.lineTo(-4 + ph * 4, -14); g.moveTo(0, 4); g.lineTo(-4 + ph * 4, 14); g.stroke();
        g.lineWidth = 1.15;
      }
      b.seats.forEach((id, i) => {
        const p = snap.players.find((q) => q.id === id); if (!p) return;
        const x = i === 0 ? 0.5 : i === 1 ? -6 : 6.5;
        g.fillStyle = p.c; g.beginPath(); g.arc(x, 0, 3.4, 0, Math.PI * 2); g.fill(); g.stroke();
        g.fillStyle = P.skin; g.beginPath(); g.arc(x + 0.5, 0, 2, 0, Math.PI * 2); g.fill(); g.stroke();
      });
    }, v.a);
    v.lx = v.x; v.ly = v.y;
  }
  function drawWeapon(g, w, bob, dir) {
    if (w === 'lance') {
      g.save(); g.lineWidth = 1.2;
      g.beginPath(); g.moveTo(6, 6 + bob); g.lineTo(8, -16 + bob); g.stroke();
      g.fillStyle = P.stone; g.beginPath(); g.moveTo(8.4, -20 + bob); g.lineTo(9.6, -15 + bob); g.lineTo(7, -15.5 + bob); g.closePath(); g.fill(); g.stroke();
      g.restore();
    } else if (w === 'hache') {
      g.save(); g.lineWidth = 1.3;
      g.beginPath(); g.moveTo(5, 2 + bob); g.lineTo(7, -7 + bob); g.stroke();
      g.fillStyle = P.stone; g.beginPath(); g.moveTo(6.5, -8 + bob); g.quadraticCurveTo(11, -8 + bob, 10.5, -4 + bob); g.lineTo(7, -5 + bob); g.closePath(); g.fill(); g.stroke();
      g.restore();
    } else if (w === 'fronde') {
      g.save(); g.lineWidth = 0.8; g.beginPath(); g.moveTo(5, 1 + bob); g.quadraticCurveTo(7 + Math.sin(now / 200), 6 + bob, 5.5, 8 + bob); g.stroke(); g.restore();
    }
    void dir;
  }
  // Le coup porté : un trait d'encre rapide dans la direction visée.
  function drawSwing(x, y, a, w, t0) {
    const age = (now - t0) / 1000;
    if (age < 0 || age > 0.2) return;
    const W = WEAPONS[w] || WEAPONS.mains;
    const k = age / 0.2;
    sprite(x, y - 0.35, (g) => {
      g.save(); g.strokeStyle = P.ink; g.globalAlpha = 1 - k;
      if (w === 'lance') {
        g.lineWidth = 2.2; g.beginPath(); g.moveTo(Math.cos(a) * 6, Math.sin(a) * 6); g.lineTo(Math.cos(a) * W.reach * PX * (0.6 + k * 0.4), Math.sin(a) * W.reach * PX * (0.6 + k * 0.4)); g.stroke();
      } else if (w !== 'fronde') {
        const r = W.reach * PX * 0.85;
        g.lineWidth = 3 * (1 - k) + 0.6;
        g.beginPath(); g.arc(0, 0, r, a - W.arc / 2, a - W.arc / 2 + W.arc * Math.min(1, k * 2.5)); g.stroke();
        g.lineWidth = 0.7; g.beginPath(); g.arc(0, 0, r * 0.8, a - W.arc / 2 + 0.15, a - W.arc / 2 + W.arc * Math.min(1, k * 2.5) - 0.1); g.stroke();
      }
      g.restore();
    });
  }
  function drawPlayer(p, x, y, dir, moving, step, extra) {
    sprite(x, y, (g) => {
      if (p.dn) {
        groundHatch(g, 14, 3, p.id);
        g.save(); g.rotate(Math.PI / 2 - 0.15);
        PA.wobblyPoly(g, [[-4, -5], [4, -5], [4, 3], [-4, 3]], p.id, 0.4); g.fillStyle = p.c; g.fill(); g.stroke();
        g.fillStyle = P.skin; g.beginPath(); g.arc(0, -9, 3.6, 0, Math.PI * 2); g.fill(); g.stroke();
        g.restore();
        const pulse = 0.65 + 0.35 * Math.sin(now / 220);
        g.save(); g.globalAlpha = pulse; g.strokeStyle = P.red; g.lineWidth = 1.6;
        g.beginPath(); g.arc(0, -17, 5, 0, Math.PI * 2); g.stroke();
        g.beginPath(); g.moveTo(0, -20); g.lineTo(0, -16.5); g.stroke();
        g.fillStyle = P.red; g.beginPath(); g.arc(0, -14.3, 0.9, 0, Math.PI * 2); g.fill();
        g.restore();
        return;
      }
      const dodging = extra && now - extra.dodgeAt < 260;
      if (dodging) { g.save(); g.globalAlpha = 0.35; g.lineWidth = 0.8; for (let i = 1; i <= 3; i++) { g.beginPath(); g.arc(-Math.cos(dir) * i * 4, 4 - Math.sin(dir) * i * 4, 2.2 - i * 0.4, 0, Math.PI * 2); g.stroke(); } g.restore(); }
      groundHatch(g, 10, 7, p.id);
      const bob = moving ? -Math.abs(Math.sin(step)) * 0.9 : 0;
      const leg = moving ? Math.sin(step) * 2.2 : 0;
      g.lineWidth = 1.5;
      g.beginPath(); g.moveTo(-2, 2 + bob); g.lineTo(-2 - leg * 0.4, 7); g.moveTo(2, 2 + bob); g.lineTo(2 + leg * 0.4, 7); g.stroke();
      g.lineWidth = 1.15;
      if (extra && now - extra.hurtAt < 220) { g.save(); g.translate((hash(now | 0, 1) - 0.5) * 2, 0); }
      PA.wobblyPoly(g, [[-4.5, -5 + bob], [4.5, -5 + bob], [5, 3 + bob], [-5, 3 + bob]], p.id * 3, 0.35);
      g.fillStyle = p.c; g.fill(); g.stroke();
      g.fillStyle = P.skin; PA.wobblyCircle(g, 0, -9.5 + bob, 3.8, p.id * 5, 0.06, 10); g.fill(); g.stroke();
      g.fillStyle = P.ink; g.beginPath(); g.arc(0, -10.5 + bob, 3.9, Math.PI * 1.05, Math.PI * 1.95); g.fill();
      if (Math.sin(dir) > -0.6) {
        const fx = Math.cos(dir) * 1.3;
        g.beginPath(); g.arc(-1.3 + fx, -9 + bob, 0.55, 0, Math.PI * 2); g.arc(1.3 + fx, -9 + bob, 0.55, 0, Math.PI * 2); g.fill();
      }
      if (extra && now - extra.hurtAt < 220) g.restore();
      if (p.tl) {
        g.lineWidth = 1.3; g.beginPath(); g.moveTo(-5, -1 + bob); g.lineTo(-6.5, -9 + bob); g.stroke(); g.lineWidth = 1.15;
        const k = 1 + Math.sin(now / 80) * 0.2;
        g.fillStyle = 'rgba(226,130,52,.95)'; g.beginPath(); g.ellipse(-6.8, -11.5 + bob, 1.9 * k, 3 * k, 0, 0, Math.PI * 2); g.fill(); g.stroke();
        g.fillStyle = 'rgba(244,206,120,.95)'; g.beginPath(); g.ellipse(-6.8, -11 + bob, 0.9, 1.5, 0, 0, Math.PI * 2); g.fill();
      }
      drawWeapon(g, p.w, bob, dir);
      if (p.cold) {
        g.save(); g.strokeStyle = P.blue; g.lineWidth = 0.9; g.globalAlpha = 0.85;
        for (const s of [-1, 1]) {
          g.beginPath();
          for (let i = 0; i < 12; i++) { const a = i * 0.7 + now / 300, r = 0.4 + i * 0.25; g.lineTo(s * 9 + Math.cos(a) * r, -12 + Math.sin(a) * r); }
          g.stroke();
        }
        g.restore();
      }
    });
  }

  // ---------------------------------------------------------------- bêtes
  const BEAST_COL = { crabe: 'rgb(196,96,60)', varan: 'rgb(124,128,80)', pale: 'rgba(232,232,226,.82)', gardien: 'rgb(52,48,62)' };
  function drawCrab(v, row, g) {
    const st = row[7], wind = st === ST.wind ? row[8] : 0;
    const leg = v.moving ? Math.sin(v.step) * 1.6 : 0;
    groundHatch(g, 14, 6, v.row[0]);
    g.save(); g.rotate(v.a + Math.PI / 2);
    g.lineWidth = 1.1;
    for (const s of [-1, 1]) for (let i = 0; i < 3; i++) {
      const y = -1.5 + i * 2.6, l = leg * (i % 2 ? 1 : -1) * s;
      g.beginPath(); g.moveTo(s * 5, y); g.lineTo(s * 9, y + 1.5 + l); g.lineTo(s * 10.5, y + 4 + l); g.stroke();
    }
    // Pinces : levées pendant l'attaque annoncée.
    const up = wind * 3.5;
    for (const s of [-1, 1]) {
      g.beginPath(); g.moveTo(s * 3.5, -4); g.lineTo(s * 5.5, -8 - up); g.stroke();
      g.fillStyle = BEAST_COL.crabe; PA.wobblyCircle(g, s * 5.8, -10.5 - up, 2.6, 7 + s, 0.15, 8); g.fill(); g.stroke();
      g.beginPath(); g.moveTo(s * 5.8, -12.5 - up); g.lineTo(s * 5.4, -9.5 - up); g.stroke();
    }
    g.fillStyle = BEAST_COL.crabe; PA.wobblyCircle(g, 0, 0, 6, 11, 0.08, 14); g.fill(); g.stroke();
    PA.wobblyCircle(g, 0, 0, 6, 11, 0.08, 14); shadeInside(g, 0, -6, 6, 6, 1.9);
    g.fillStyle = P.ink; g.beginPath(); g.arc(-2, -5.5, 0.9, 0, Math.PI * 2); g.arc(2, -5.5, 0.9, 0, Math.PI * 2); g.fill();
    g.restore();
  }
  function drawVaran(v, row, g) {
    const st = row[7];
    const sw = v.moving || st === ST.act ? Math.sin(v.step) * 0.25 : Math.sin(now / 900) * 0.05;
    groundHatch(g, 20, 5, v.row[0]);
    g.save(); g.rotate(v.a);
    g.fillStyle = BEAST_COL.varan;
    // Queue en S, corps, tête.
    g.lineWidth = 1.15;
    g.beginPath(); g.moveTo(-6, -2); g.quadraticCurveTo(-13, -2 + sw * 12, -20, sw * -8); g.quadraticCurveTo(-13, 2 + sw * 12, -6, 2); g.closePath(); g.fill(); g.stroke();
    for (const s of [-1, 1]) for (const x of [-3, 5]) {
      const l = (v.moving ? Math.sin(v.step + x) : 0) * 2 * s;
      g.beginPath(); g.moveTo(x, s * 3); g.lineTo(x + 2 + l, s * 7); g.lineTo(x + 4 + l, s * 7.5); g.stroke();
    }
    PA.wobblyPoly(g, [[-7, -3.5], [3, -4.2], [8, -2.6], [8, 2.6], [3, 4.2], [-7, 3.5]], 5, 0.4); g.fill(); g.stroke();
    PA.wobblyPoly(g, [[-7, -3.5], [3, -4.2], [8, -2.6], [8, 2.6], [3, 4.2], [-7, 3.5]], 5, 0.4); shadeInside(g, -7, 0, 8, 4.2, 2);
    g.beginPath(); g.ellipse(11, 0, 4.2, 2.8, 0, 0, Math.PI * 2); g.fill(); g.stroke();
    g.fillStyle = 'rgb(232,200,96)'; g.beginPath(); g.arc(12, -1.6, 0.8, 0, Math.PI * 2); g.arc(12, 1.6, 0.8, 0, Math.PI * 2); g.fill();
    if (st === ST.wind) { g.strokeStyle = P.red; g.lineWidth = 0.8; g.beginPath(); g.moveTo(15, 0); g.lineTo(17 + Math.sin(now / 40) * 1.5, 0.6); g.stroke(); }
    g.restore();
    if (st === ST.stun) {
      g.save(); g.strokeStyle = P.ink; g.lineWidth = 0.8;
      for (let i = 0; i < 3; i++) { const a = now / 300 + i * 2.1; g.beginPath(); g.arc(Math.cos(a) * 6, -10 + Math.sin(a) * 2, 1.2, 0, Math.PI * 2); g.stroke(); }
      g.restore();
    }
  }
  function drawPale(v, row, g) {
    const bob = Math.sin(now / 400 + row[0]) * 1.4;
    const born = clamp((now - v.born) / 900, 0, 1);
    const fleeing = row[7] === ST.flee;
    g.save(); g.globalAlpha = born * (fleeing ? 0.55 : 0.9);
    g.fillStyle = BEAST_COL.pale; g.strokeStyle = 'rgba(46,36,26,.7)';
    g.beginPath();
    g.moveTo(-6, 4 + bob);
    g.bezierCurveTo(-7, -6 + bob, -4, -16 + bob, 0, -16 + bob);
    g.bezierCurveTo(4, -16 + bob, 7, -6 + bob, 6, 4 + bob);
    for (let i = 0; i < 5; i++) { const x = 6 - (i + 1) * 2.4; g.lineTo(x + 1.2, 1 + bob + Math.sin(now / 160 + i) * 1.2); g.lineTo(x, 4 + bob); }
    g.closePath(); g.fill(); g.setLineDash([2, 1.4]); g.stroke(); g.setLineDash([]);
    g.fillStyle = 'rgb(30,28,36)';
    g.beginPath(); g.ellipse(-2.2, -9 + bob, 1.1, 1.6, 0, 0, Math.PI * 2); g.ellipse(2.2, -9 + bob, 1.1, 1.6, 0, 0, Math.PI * 2); g.fill();
    // Bras tendus pendant l'attaque.
    if (row[7] === ST.wind) { g.lineWidth = 1; g.beginPath(); const a = v.a; g.moveTo(0, -6 + bob); g.lineTo(Math.cos(a) * 10, -6 + bob + Math.sin(a) * 8); g.stroke(); }
    g.restore();
  }
  function drawGardien(v, row, g) {
    const st = row[7];
    const sleep = st === ST.sleep;
    g.save(); g.scale(1.9, 1.9);
    groundHatch(g, 18, 6, 99);
    const bob = sleep ? 0 : Math.sin(now / 600) * 0.8;
    // Manteau.
    g.fillStyle = BEAST_COL.gardien;
    g.beginPath(); g.moveTo(-9, 6); g.quadraticCurveTo(-10, -8 + bob, -4, -14 + bob); g.lineTo(4, -14 + bob); g.quadraticCurveTo(10, -8 + bob, 9, 6); g.closePath(); g.fill(); g.stroke();
    g.save(); g.beginPath(); g.moveTo(-9, 6); g.quadraticCurveTo(-10, -8 + bob, -4, -14 + bob); g.lineTo(4, -14 + bob); g.quadraticCurveTo(10, -8 + bob, 9, 6); g.closePath();
    g.strokeStyle = 'rgba(238,226,197,.25)'; shadeInside(g, -9, -14, 9, 6, 1.6); g.restore();
    // Capuche.
    g.beginPath(); g.ellipse(0, -16 + bob, 5, 5.5, 0, 0, Math.PI * 2); g.fill(); g.stroke();
    // La face est une plaque d'armure tournée vers sa cible : de dos, il est vulnérable.
    const fx = Math.cos(v.a), fy = Math.sin(v.a);
    g.save(); g.translate(fx * 3.4, -15 + bob + fy * 1.6);
    g.fillStyle = 'rgb(150,144,136)'; PA.wobblyPoly(g, [[-3, -3], [3, -3], [2.4, 3], [0, 4.5], [-2.4, 3]], 8, 0.3); g.fill(); g.stroke();
    g.fillStyle = sleep ? 'rgb(60,56,70)' : 'rgb(150,90,200)';
    g.beginPath(); g.arc(-1.2, -0.6, 0.7, 0, Math.PI * 2); g.arc(1.2, -0.6, 0.7, 0, Math.PI * 2); g.fill();
    g.restore();
    // La lanterne noire au bout du bras.
    if (!sleep) {
      const lx = fx * 9 + 3, ly = -6 + bob;
      g.beginPath(); g.moveTo(fx * 4, -8 + bob); g.lineTo(lx, ly); g.stroke();
      g.fillStyle = 'rgba(40,20,60,.9)'; g.beginPath(); g.ellipse(lx, ly + 3, 1.8, 2.6, 0, 0, Math.PI * 2); g.fill(); g.stroke();
    }
    g.restore();
  }
  // L'attaque annoncée : un trait d'encre rouge qui se dessine avant le coup.
  function drawTelegraph(v, row) {
    const [, k, , , , , , st, prog, tx, ty, pat] = row;
    if (st !== ST.wind) return;
    const def = BEASTS[k];
    ctx.save();
    ctx.strokeStyle = P.red; ctx.fillStyle = 'rgba(158,58,36,.12)';
    ctx.lineWidth = Math.max(1.5, T / 22);
    const [sx, sy] = W2S(v.x, v.y);
    if (k === 'varan') {
      const L = def.charge * def.chargeT * T * 1.05;
      const ex = sx + Math.cos(v.a) * L * prog, ey = sy + Math.sin(v.a) * L * prog;
      ctx.setLineDash([T * 0.22, T * 0.14]);
      ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey); ctx.stroke();
      ctx.setLineDash([]);
      if (prog > 0.7) {
        ctx.beginPath(); ctx.moveTo(ex, ey);
        ctx.lineTo(ex - Math.cos(v.a - 0.5) * T * 0.4, ey - Math.sin(v.a - 0.5) * T * 0.4);
        ctx.moveTo(ex, ey); ctx.lineTo(ex - Math.cos(v.a + 0.5) * T * 0.4, ey - Math.sin(v.a + 0.5) * T * 0.4); ctx.stroke();
      }
    } else if (k === 'gardien' && pat === 0) {
      const [cx, cy] = W2S(tx, ty);
      const r = 2.3 * T;
      ctx.globalAlpha = 0.25 + prog * 0.6;
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2 * prog); ctx.stroke();
      ctx.beginPath(); ctx.arc(cx, cy, r * prog, 0, Math.PI * 2); ctx.fill();
      ctx.save(); ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.clip(); ctx.globalAlpha = 0.3 * prog; ctx.lineWidth = 1;
      ctx.beginPath(); for (let x = -r; x < r; x += T * 0.25) { ctx.moveTo(cx + x, cy - r); ctx.lineTo(cx + x - r, cy + r); } ctx.stroke(); ctx.restore();
    } else {
      const R = (k === 'gardien' ? 3.3 : def.reach + 0.4) * T, half = k === 'gardien' ? 1.3 : 1.15;
      const cy = sy - T * 0.25;
      ctx.beginPath(); ctx.moveTo(sx, cy); ctx.arc(sx, cy, R, v.a - half, v.a - half + 2 * half * prog); ctx.closePath();
      ctx.globalAlpha = 0.35 + prog * 0.5; ctx.fill(); ctx.stroke();
    }
    ctx.restore();
  }
  function drawBeast(v) {
    const row = v.row, k = row[1];
    sprite(v.x, v.y, (g) => {
      if (k === 'crabe') drawCrab(v, row, g);
      else if (k === 'varan') drawVaran(v, row, g);
      else if (k === 'pale') drawPale(v, row, g);
      else drawGardien(v, row, g);
    });
    const hp = row[5], mhp = row[6];
    if (hp < mhp && k !== 'gardien') {
      const [px, py] = W2S(v.x, v.y);
      const w = T * 0.8, h = 4 * dpr, y0 = py - T * (k === 'pale' ? 1.1 : 0.85);
      ctx.fillStyle = 'rgba(238,226,197,.9)'; ctx.fillRect(px - w / 2, y0, w, h);
      ctx.fillStyle = P.red; ctx.fillRect(px - w / 2, y0, w * clamp(hp / mhp, 0, 1), h);
      ctx.strokeStyle = P.ink; ctx.lineWidth = dpr; ctx.strokeRect(px - w / 2, y0, w, h);
    }
  }

  // ---------------------------------------------------------------- sites du mystère
  function drawSite(s) {
    const near = dist(me, s) < 8;
    sprite(s.x, s.y, (g) => {
      if (s.k === 'carnet') {
        groundHatch(g, 14, 5, s.id);
        g.lineWidth = 1.4; g.beginPath(); g.moveTo(-7, 4); g.lineTo(-7, -12); g.moveTo(-11, -8); g.lineTo(-3, -8); g.stroke(); g.lineWidth = 1.15;
        g.fillStyle = P.stone; for (let i = 0; i < 5; i++) { const a = i * 1.26; g.beginPath(); g.arc(4 + Math.cos(a) * 4, 2 + Math.sin(a) * 2.4, 1.3, 0, Math.PI * 2); g.fill(); g.stroke(); }
        g.fillStyle = s.done ? 'rgb(230,214,180)' : 'rgb(246,236,210)';
        g.beginPath(); g.moveTo(-2, -2); g.lineTo(4, -4); g.lineTo(10, -2); g.lineTo(10, 3); g.lineTo(4, 1); g.lineTo(-2, 3); g.closePath(); g.fill(); g.stroke();
        g.beginPath(); g.moveTo(4, -4); g.lineTo(4, 1); g.stroke();
        g.lineWidth = 0.5; g.beginPath(); for (let i = 0; i < 3; i++) { g.moveTo(-0.5, -1 + i * 1.3); g.lineTo(3, -2 + i * 1.3); g.moveTo(5, -2 + i * 1.3); g.lineTo(8.5, -1 + i * 1.3); } g.stroke();
      } else if (s.k === 'epave') {
        g.save(); g.lineWidth = 1.6;
        for (let i = 0; i < 5; i++) { const x = -14 + i * 6; g.beginPath(); g.moveTo(x, 6); g.quadraticCurveTo(x - 3, -4, x + 1, -10 + (i % 2) * 3); g.stroke(); }
        g.lineWidth = 2; g.beginPath(); g.moveTo(-17, 7); g.lineTo(14, 5); g.stroke();
        g.lineWidth = 1.3; g.beginPath(); g.moveTo(4, 4); g.lineTo(22, -4); g.stroke();
        g.restore();
        g.fillStyle = P.wood; g.fillRect(-4, 1, 6, 4); g.strokeRect(-4, 1, 6, 4);
      } else if (s.k === 'coffret') {
        groundHatch(g, 12, 4, s.id);
        g.fillStyle = 'rgb(118,104,90)'; PA.wobblyPoly(g, [[-6, -5], [6, -5], [6, 3], [-6, 3]], 9, 0.4); g.fill(); g.stroke();
        g.beginPath(); g.moveTo(-6, -2); g.lineTo(6, -2); g.stroke();
        g.fillStyle = s.done ? P.stone : 'rgb(196,150,64)'; g.fillRect(-1.2, -3.6, 2.4, 3); g.strokeRect(-1.2, -3.6, 2.4, 3);
        if (s.done) { g.fillStyle = 'rgb(118,104,90)'; g.beginPath(); g.moveTo(-6, -5); g.lineTo(6, -5); g.lineTo(5, -10); g.lineTo(-7, -10); g.closePath(); g.fill(); g.stroke(); }
      } else if (s.k === 'stele') {
        groundHatch(g, 16, 6, s.id);
        const lift = s.done ? 1 : s.prog;
        g.save();
        g.translate(0, 4); g.rotate(-Math.PI / 2 * (1 - lift)); g.translate(0, -4);
        g.fillStyle = 'rgb(176,170,160)'; PA.wobblyPoly(g, [[-5, 4], [-5, -16], [-2, -20], [2, -20], [5, -16], [5, 4]], s.id, 0.5); g.fill(); g.stroke();
        g.lineWidth = 0.7;
        for (let i = 0; i < 4; i++) { g.beginPath(); g.moveTo(-3, -14 + i * 4); g.lineTo(-1, -12 + i * 4); g.lineTo(1, -14 + i * 4); g.lineTo(3, -12 + i * 4); g.stroke(); }
        g.restore();
      } else if (s.k === 'ruine') {
        groundHatch(g, 30, 7, s.id);
        g.fillStyle = P.stone;
        for (const [x, w, h] of [[-15, 6, 14], [9, 6, 18]]) { PA.wobblyPoly(g, [[x, 5], [x, 5 - h], [x + w, 5 - h + 2], [x + w, 5]], x * 3, 0.6); g.fill(); g.stroke(); PA.wobblyPoly(g, [[x, 5], [x, 5 - h], [x + w, 5 - h + 2], [x + w, 5]], x * 3, 0.6); shadeInside(g, x, 5 - h, x + w, 5, 2); }
        g.beginPath(); g.moveTo(-9, 5); g.lineTo(-9, -8); g.quadraticCurveTo(0, -19, 9, -8); g.lineTo(9, 5); g.lineTo(6, 5); g.lineTo(6, -7); g.quadraticCurveTo(0, -14, -6, -7); g.lineTo(-6, 5); g.closePath(); g.fill(); g.stroke();
        g.fillStyle = s.open ? 'rgb(214,190,150)' : 'rgb(60,50,40)';
        g.beginPath(); g.moveTo(-6, 5); g.lineTo(-6, -7); g.quadraticCurveTo(0, -14, 6, -7); g.lineTo(6, 5); g.closePath(); g.fill(); g.stroke();
        if (s.open) { g.save(); g.strokeStyle = P.red; g.lineWidth = 0.7; g.beginPath(); g.arc(0, -5, 2, 0, Math.PI * 2); g.moveTo(-3, 0); g.lineTo(3, 0); g.moveTo(0, -3); g.lineTo(0, 3); g.stroke(); g.restore(); }
      } else if (s.k === 'phare') {
        drawLighthouse(g, s);
      }
      if (!s.done && near && s.k !== 'phare') {
        const by = (s.k === 'ruine' ? -26 : -22) + Math.sin(now / 350) * 1.5;
        g.font = 'italic 14px "IM Fell English", Georgia, serif'; g.textAlign = 'center';
        g.lineWidth = 3; g.strokeStyle = 'rgba(238,226,197,.9)'; g.strokeText('?', 0, by); g.fillStyle = P.red; g.fillText('?', 0, by);
      }
    });
    if (s.levers) for (let i = 0; i < 2; i++) {
      const l = s.levers[i], on = s.open || s.lv[i];
      sprite(l.x, l.y, (g) => {
        groundHatch(g, 8, 3, i + 4);
        g.fillStyle = P.stone; g.fillRect(-3, -4, 6, 6); g.strokeRect(-3, -4, 6, 6);
        g.lineWidth = 1.6; g.beginPath(); g.moveTo(0, -2); g.lineTo(on ? 5 : -2, on ? 2 : -11); g.stroke();
        g.fillStyle = on ? P.red : P.woodDark; g.beginPath(); g.arc(on ? 5 : -2, on ? 2 : -11, 1.6, 0, Math.PI * 2); g.fill(); g.stroke();
      });
    }
    // Barre de progression partagée (stèle, lecture, flamme).
    if (!s.done && s.prog > 0.01) {
      const [px, py] = W2S(s.x, s.y);
      const w = T * 1.1, h = 6 * dpr, y0 = py + T * 0.45;
      ctx.fillStyle = 'rgba(238,226,197,.95)'; ctx.fillRect(px - w / 2, y0, w, h);
      ctx.fillStyle = s.k === 'phare' ? 'rgb(90,60,130)' : P.red; ctx.fillRect(px - w / 2, y0, w * clamp(s.prog, 0, 1), h);
      ctx.strokeStyle = P.ink; ctx.lineWidth = 1.2 * dpr; ctx.strokeRect(px - w / 2, y0, w, h);
    }
  }
  function drawLighthouse(g) {
    groundHatch(g, 34, 8, 77);
    const tw = 9, top = -62;
    g.fillStyle = 'rgb(120,114,108)';
    PA.wobblyPoly(g, [[-tw - 3, 6], [-tw + 1, top + 14], [tw - 1, top + 14], [tw + 3, 6]], 31, 0.6); g.fill(); g.stroke();
    PA.wobblyPoly(g, [[-tw - 3, 6], [-tw + 1, top + 14], [tw - 1, top + 14], [tw + 3, 6]], 31, 0.6); shadeInside(g, -tw, top, tw + 3, 6, 2.2);
    g.lineWidth = 0.8; g.beginPath(); for (const y of [-10, -26, -40]) { g.moveTo(-tw - 1 + (6 - y) * 0.06, y); g.lineTo(tw + 1 - (6 - y) * 0.06, y); } g.stroke(); g.lineWidth = 1.15;
    g.fillStyle = 'rgb(40,32,30)'; g.beginPath(); g.moveTo(-3, 6); g.lineTo(-3, -2); g.quadraticCurveTo(0, -6, 3, -2); g.lineTo(3, 6); g.closePath(); g.fill(); g.stroke();
    g.fillStyle = 'rgb(90,84,80)'; g.fillRect(-tw - 2, top + 11, tw * 2 + 4, 3); g.strokeRect(-tw - 2, top + 11, tw * 2 + 4, 3);
    g.fillStyle = 'rgba(30,24,40,.85)'; g.fillRect(-6, top, 12, 11); g.strokeRect(-6, top, 12, 11);
    g.beginPath(); g.moveTo(-7, top); g.lineTo(0, top - 7); g.lineTo(7, top); g.closePath(); g.fillStyle = 'rgb(60,50,50)'; g.fill(); g.stroke();
    // La flamme noire : elle ne chauffe pas, elle assombrit.
    g.save(); g.translate(0, top + 9);
    flame(g, 0, 'rgba(70,40,110,.95)', 3.4, 9);
    flame(g, 1.4, 'rgba(18,10,28,.95)', 2, 6);
    g.restore();
  }

  // Récifs repérés : pointes de roche à fleur d'eau, écume.
  function drawReefs(x0, y0, x1, y1) {
    ctx.save(); ctx.strokeStyle = P.ink; ctx.lineCap = 'round';
    const s = T / PX;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      if (tileAt(x, y) !== TILE.REEF || !world.reefs.has(x + y * world.W)) continue;
      const [sx, sy] = W2S(x + 0.5, y + 0.5);
      ctx.save(); ctx.translate(sx, sy); ctx.scale(s, s); ctx.lineWidth = 1;
      for (let k = 0; k < 3; k++) {
        const ox = (hash(x, y, 40 + k) - 0.5) * 12, oy = (hash(x, y, 50 + k) - 0.5) * 10, h = 3 + hash(x, y, 60 + k) * 3;
        ctx.fillStyle = 'rgb(92,86,80)';
        ctx.beginPath(); ctx.moveTo(ox - 2.6, oy + 1.5); ctx.lineTo(ox - 0.4, oy - h); ctx.lineTo(ox + 2.6, oy + 1.5); ctx.closePath(); ctx.fill(); ctx.stroke();
        const t = (now / 1400 + hash(x, y, 70 + k)) % 1;
        ctx.globalAlpha = 0.7 * (1 - t); ctx.strokeStyle = 'rgb(250,246,236)';
        ctx.beginPath(); ctx.ellipse(ox, oy + 1.5, 3 + t * 4, 1 + t * 1.5, 0, Math.PI * 0.05, Math.PI * 0.95); ctx.stroke();
        ctx.globalAlpha = 1; ctx.strokeStyle = P.ink;
      }
      ctx.restore();
    }
    ctx.restore();
  }
  // Courants : de petites flèches d'encre qui glissent dans le sens de l'eau.
  function drawCurrents(x0, y0, x1, y1) {
    ctx.save(); ctx.strokeStyle = 'rgba(46,60,80,.55)'; ctx.lineCap = 'round'; ctx.lineWidth = Math.max(1, T / 30);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      if ((x + y * 3) % 3 !== 0 || hash(x, y, 91) > 0.55) continue;
      const [cx, cy] = currentAt(x, y);
      if (!cx && !cy) continue;
      if (!seenAt(x, y)) continue;
      const m = Math.hypot(cx, cy), ux = cx / m, uy = cy / m;
      const t = ((now / 1000) * m * 0.45 + hash(x, y, 92)) % 1;
      const px = x + 0.5 + ux * (t - 0.5), py = y + 0.5 + uy * (t - 0.5);
      const [sx, sy] = W2S(px, py);
      const L = T * 0.32;
      ctx.globalAlpha = Math.sin(t * Math.PI) * 0.9;
      ctx.beginPath();
      ctx.moveTo(sx - ux * L, sy - uy * L); ctx.lineTo(sx + ux * L, sy + uy * L);
      ctx.lineTo(sx + ux * L - (ux * 0.5 - uy * 0.4) * L * 0.8, sy + uy * L - (uy * 0.5 + ux * 0.4) * L * 0.8);
      ctx.moveTo(sx + ux * L, sy + uy * L);
      ctx.lineTo(sx + ux * L - (ux * 0.5 + uy * 0.4) * L * 0.8, sy + uy * L - (uy * 0.5 - ux * 0.4) * L * 0.8);
      ctx.stroke();
    }
    ctx.restore();
  }
  // Le banc de brume qui cache le Phare : un mur blanc qui ondule sur la mer.
  function drawFogBank() {
    const ph = world.phare; if (!ph) return;
    const [sx, sy] = W2S(ph.x, ph.y);
    const R = ph.zone * T;
    if (sx + R < 0 || sy + R < 0 || sx - R > CW || sy - R > CH) return;
    const open = fragCount() >= C.FRAG_NEED;
    ctx.save();
    const gr = ctx.createRadialGradient(sx, sy, R * 0.55, sx, sy, R * 1.08);
    const a = open ? 0.28 : 0.82;
    gr.addColorStop(0, `rgba(236,234,228,${a})`); gr.addColorStop(0.75, `rgba(236,234,228,${a * 0.85})`); gr.addColorStop(1, 'rgba(236,234,228,0)');
    ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(sx, sy, R * 1.1, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(120,120,130,.45)'; ctx.lineWidth = Math.max(1, T / 26);
    for (let i = 0; i < 40; i++) {
      const ang = (i / 40) * Math.PI * 2 + now / 30000 * (i % 2 ? 1 : -1);
      const rr = R * (0.86 + 0.12 * Math.sin(i * 7.3 + now / 2500));
      const x = sx + Math.cos(ang) * rr, y = sy + Math.sin(ang) * rr;
      ctx.beginPath(); ctx.arc(x, y, T * 0.5, Math.PI * 1.1, Math.PI * 1.9); ctx.arc(x + T * 0.8, y, T * 0.4, Math.PI * 1.1, Math.PI * 1.9); ctx.stroke();
    }
    ctx.restore();
  }

  // Petites vagues dessinées à l'encre sur la mer, comme sur les vieilles cartes.
  function drawSea(x0, y0, x1, y1) {
    ctx.save();
    ctx.strokeStyle = P.ink; ctx.lineCap = 'round';
    ctx.lineWidth = Math.max(1, 0.9 * T / PX);
    const thr = 0.07 + stormK() * 0.1;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      if (hash(x, y, 7) > thr || tileAt(x, y) !== TILE.DEEP || tileAt(x + 2, y) !== TILE.DEEP || tileAt(x - 2, y) !== TILE.DEEP || tileAt(x, y + 2) !== TILE.DEEP || tileAt(x, y - 2) !== TILE.DEEP) continue;
      const h = hash(x, y, 8);
      const drift = Math.sin(now / 1600 + h * 12) * 0.18;
      const [sx, sy] = W2S(x + 0.2 + h * 0.6 + drift, y + 0.5 + Math.cos(now / 1900 + h * 9) * 0.06);
      const r = T * 0.11;
      ctx.globalAlpha = 0.32 + 0.12 * Math.sin(now / 1200 + h * 20);
      ctx.beginPath();
      ctx.arc(sx, sy, r, Math.PI * 1.1, Math.PI * 1.9);
      ctx.arc(sx + r * 1.7, sy, r, Math.PI * 1.1, Math.PI * 1.9);
      if (h > 0.5) ctx.arc(sx + r * 3.4, sy, r, Math.PI * 1.1, Math.PI * 1.9);
      ctx.stroke();
    }
    ctx.restore();
  }

  function stormK() { const w = snap && snap.wt; return !w ? 0 : w.st === 'tempete' ? 1 : w.st === 'annonce' ? 0.3 : 0; }

  // La brume du papier vierge, accrochée au monde, avec un léger quadrillage de carte à remplir.
  function drawFog() {
    fctx.globalCompositeOperation = 'source-over';
    fctx.setTransform(1, 0, 0, 1, 0, 0);
    fctx.clearRect(0, 0, CW, CH);
    const ox = ((-(cam.x * T) + CW / 2 + cam.ox) % 256 + 256) % 256, oy = ((-(cam.y * T) + CH / 2 + cam.oy) % 256 + 256) % 256;
    fctx.save(); fctx.translate(ox - 256, oy - 256);
    fctx.fillStyle = fctx.createPattern(paperTile, 'repeat'); fctx.fillRect(0, 0, CW + 512, CH + 512);
    fctx.restore();
    fctx.strokeStyle = 'rgba(46,36,26,.12)'; fctx.lineWidth = Math.max(1, dpr);
    fctx.beginPath();
    const x0 = Math.floor((cam.x - CW / 2 / T) / 10) * 10, x1 = cam.x + CW / 2 / T;
    const y0 = Math.floor((cam.y - CH / 2 / T) / 10) * 10, y1 = cam.y + CH / 2 / T;
    for (let x = x0; x <= x1; x += 10) { const [sx] = W2S(x, 0); fctx.moveTo(sx, 0); fctx.lineTo(sx, CH); }
    for (let y = y0; y <= y1; y += 10) { const [, sy] = W2S(0, y); fctx.moveTo(0, sy); fctx.lineTo(CW, sy); }
    fctx.stroke();
    fctx.globalCompositeOperation = 'destination-out';
    fctx.imageSmoothingEnabled = true; fctx.imageSmoothingQuality = 'high';
    const wx = cam.x - (CW / 2 + cam.ox) / T, wy = cam.y - (CH / 2 + cam.oy) / T;
    fctx.drawImage(fogMask, wx * MS, wy * MS, (CW / T) * MS, (CH / T) * MS, 0, 0, CW, CH);
    fctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(fogC, 0, 0);
  }

  function drawEffects() {
    for (let i = effects.length - 1; i >= 0; i--) {
      const f = effects[i], age = (now - f.t) / 1000;
      const life = f.k === 'die' ? 1.6 : f.k === 'slam' ? 0.6 : f.k === 'sink' ? 2 : 0.7;
      if (age > life) { effects.splice(i, 1); continue; }
      if (f.x === undefined) continue;
      const [sx, sy] = W2S(f.x, f.y - 0.3);
      const k = age / life;
      ctx.save(); ctx.lineCap = 'round';
      if (f.k === 'hit') {
        const col = f.h === 'armor' ? 'rgb(120,120,130)' : P.ink;
        ctx.strokeStyle = col; ctx.lineWidth = (f.h === 'crit' ? 3 : 2) * dpr * (1 - k);
        ctx.globalAlpha = 1 - k;
        const r = T * (0.25 + k * 0.35) * (f.h === 'crit' ? 1.4 : 1);
        ctx.beginPath();
        for (let j = 0; j < 7; j++) { const a = j * 0.9 + f.t; ctx.moveTo(sx + Math.cos(a) * r * 0.4, sy + Math.sin(a) * r * 0.4); ctx.lineTo(sx + Math.cos(a) * r, sy + Math.sin(a) * r); }
        ctx.stroke();
        if (f.h === 'armor' && k < 0.6) { ctx.font = `italic ${Math.round(12 * dpr)}px "IM Fell English", Georgia, serif`; ctx.textAlign = 'center'; ctx.fillStyle = 'rgb(90,90,100)'; ctx.fillText('carapace', sx, sy - T * 0.7); }
        if (f.h === 'crit' && k < 0.6) { ctx.fillStyle = P.red; ctx.beginPath(); ctx.arc(sx, sy, T * 0.12, 0, Math.PI * 2); ctx.fill(); }
      } else if (f.k === 'hurt') {
        ctx.fillStyle = P.red; ctx.globalAlpha = 0.8 * (1 - k);
        for (let j = 0; j < 5; j++) { const a = hash(j, f.t | 0, 3) * 6.28, r = T * 0.2 + k * T * 0.5 * hash(j, 2, f.t | 0); ctx.beginPath(); ctx.arc(sx + Math.cos(a) * r, sy + Math.sin(a) * r, T * 0.06 * (1 - k * 0.5), 0, Math.PI * 2); ctx.fill(); }
      } else if (f.k === 'dodge') {
        ctx.font = `italic ${Math.round(14 * dpr)}px "IM Fell English", Georgia, serif`; ctx.textAlign = 'center';
        ctx.globalAlpha = 1 - k; ctx.lineWidth = 3 * dpr; ctx.strokeStyle = P.paper; ctx.strokeText('esquivé', sx, sy - T * (0.9 + k * 0.4));
        ctx.fillStyle = P.ink; ctx.fillText('esquivé', sx, sy - T * (0.9 + k * 0.4));
      } else if (f.k === 'slam') {
        ctx.strokeStyle = P.ink; ctx.globalAlpha = 1 - k; ctx.lineWidth = 3 * dpr * (1 - k);
        ctx.beginPath(); ctx.arc(sx, sy + T * 0.3, T * (1 + k * 1.6), 0, Math.PI * 2); ctx.stroke();
      } else if (f.k === 'die') {
        ctx.fillStyle = f.b === 'pale' ? 'rgba(230,230,224,.8)' : 'rgba(46,36,26,.55)'; ctx.globalAlpha = 1 - k;
        for (let j = 0; j < 9; j++) { const a = j * 0.7, r = T * (0.15 + 0.5 * hash(j, 5, f.t | 0)) * Math.min(1, age * 5); ctx.beginPath(); ctx.arc(sx + Math.cos(a) * r, sy + Math.sin(a) * r * 0.6, T * 0.09, 0, Math.PI * 2); ctx.fill(); }
      } else if (f.k === 'fade' || f.k === 'rise') {
        ctx.strokeStyle = 'rgba(200,200,196,.9)'; ctx.globalAlpha = 1 - k; ctx.lineWidth = 1.5 * dpr;
        for (let j = 0; j < 3; j++) { ctx.beginPath(); ctx.arc(sx + (j - 1) * T * 0.3, sy - k * T * 0.8 - j * 4, T * (0.2 + k * 0.3), Math.PI, Math.PI * 2); ctx.stroke(); }
      } else if (f.k === 'reef' || f.k === 'sink') {
        ctx.strokeStyle = 'rgb(250,246,236)'; ctx.globalAlpha = 1 - k; ctx.lineWidth = 2 * dpr;
        for (let j = 0; j < 3; j++) { ctx.beginPath(); ctx.ellipse(sx, sy + T * 0.3, T * (0.3 + k + j * 0.25), T * (0.12 + k * 0.3 + j * 0.1), 0, 0, Math.PI * 2); ctx.stroke(); }
      } else if (f.k === 'heal') {
        ctx.strokeStyle = 'rgb(90,130,60)'; ctx.globalAlpha = 1 - k; ctx.lineWidth = 2 * dpr;
        for (let j = 0; j < 3; j++) { const x = sx + (j - 1) * T * 0.3, y = sy - T * (0.6 + k * 0.8) - j * 5; ctx.beginPath(); ctx.moveTo(x - 4 * dpr, y); ctx.lineTo(x + 4 * dpr, y); ctx.moveTo(x, y - 4 * dpr); ctx.lineTo(x, y + 4 * dpr); ctx.stroke(); }
      }
      ctx.restore();
    }
  }

  function drawWeather() {
    const w = snap.wt; if (!w || w.st === 'calme') return;
    const storm = w.st === 'tempete';
    ctx.save();
    ctx.fillStyle = `rgba(40,52,70,${storm ? 0.3 : 0.1})`; ctx.fillRect(0, 0, CW, CH);
    // Pluie à l'encre, poussée par le vent.
    const n = storm ? 220 : 40;
    const wx = w.wx || 0.3, wy = 1;
    ctx.strokeStyle = storm ? 'rgba(40,52,70,.45)' : 'rgba(40,52,70,.25)'; ctx.lineWidth = Math.max(1, dpr);
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const t = (now / (storm ? 500 : 800) + hash(i, 1, 2)) % 1;
      const x = ((hash(i, 3, 4) * CW + t * wx * 260 * dpr) % CW + CW) % CW, y = t * CH;
      const L = (storm ? 18 : 10) * dpr;
      ctx.moveTo(x, y); ctx.lineTo(x + wx * L * 0.7, y + wy * L);
    }
    ctx.stroke();
    if (storm) {
      nextBolt -= 1 / 60;
      if (nextBolt <= 0) { lightning = 1; nextBolt = 5 + Math.random() * 8; }
      if (lightning > 0) { ctx.fillStyle = `rgba(250,248,240,${lightning * 0.55})`; ctx.fillRect(0, 0, CW, CH); lightning = Math.max(0, lightning - 0.06); }
    }
    ctx.restore();
  }

  function render() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = 'rgb(118,160,166)'; ctx.fillRect(0, 0, CW, CH);
    if (!world || !snap || !mapCanvas) return;
    const mine = myself();
    const tx = me.x, ty = me.y;
    cam.x += (tx - cam.x) * 0.2; cam.y += (ty - cam.y) * 0.2;
    if (Math.abs(cam.x - tx) > 20 || Math.abs(cam.y - ty) > 20) { cam.x = tx; cam.y = ty; }
    shake = Math.max(0, shake - 0.08);
    cam.ox = (Math.random() - 0.5) * shake * 10 * dpr; cam.oy = (Math.random() - 0.5) * shake * 10 * dpr;

    // Carte peinte une fois pour toutes.
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    const s = T / PX;
    const sx = (cam.x * PX) - (CW / 2 + cam.ox) / s, sy = (cam.y * PX) - (CH / 2 + cam.oy) / s;
    ctx.drawImage(mapCanvas, sx, sy, CW / s, CH / s, 0, 0, CW, CH);
    const vx0 = Math.floor(cam.x - CW / 2 / T) - 1, vx1 = Math.ceil(cam.x + CW / 2 / T) + 1, vy0 = Math.floor(cam.y - CH / 2 / T) - 1, vy1 = Math.ceil(cam.y + CH / 2 / T) + 1;
    drawSea(vx0, vy0, vx1, vy1);
    drawCurrents(vx0, vy0, vx1, vy1);
    drawReefs(vx0, vy0, vx1, vy1);

    // Objets triés par profondeur.
    const vis = (x, y) => x > vx0 - 1 && x < vx1 + 1 && y > vy0 - 1 && y < vy1 + 2 && seenAt(x, y);
    const list = [];
    const drawers = { tree: drawTree, rock: drawRock, bush: drawBush, flax: drawFlax, spring: drawSpring };
    for (const n of nodes.values()) if (vis(n.x, n.y)) list.push({ y: n.y + (n.k === 'spring' ? -0.5 : 0), f: () => drawers[n.k](n) });
    for (const st of sites.values()) if (vis(st.x, st.y)) list.push({ y: st.y + (st.k === 'epave' ? -0.4 : 0), f: () => drawSite(st) });
    const camp = world.camp;
    list.push({ y: camp.yard.y - 0.6, f: () => drawShip(snap.parts) });
    list.push({ y: camp.chest.y, f: () => drawChest(camp.chest) });
    list.push({ y: camp.bench.y, f: () => drawBench(camp.bench) });
    list.push({ y: camp.fire.y, f: () => drawFire(camp.fire, snap.fire) });
    for (const b of snap.boats) { const v = boatsView.get(b.id); if (v && vis(v.x, v.y)) list.push({ y: v.y - 0.3, f: () => drawBoat(b, v) }); }
    for (const v of beastsView.values()) if (vis(v.x, v.y)) list.push({ y: v.y, f: () => drawBeast(v) });
    for (const p of snap.players) {
      if (p.b) continue;
      if (p.id === myId) list.push({ y: me.y, f: () => { drawPlayer(p, me.x, me.y, me.dir, me.moving, me.step || 0, me); drawSwing(me.x, me.y, me.swingA, p.w, me.swingAt); } });
      else { const o = others.get(p.id); if (o && vis(o.x, o.y)) list.push({ y: o.y, f: () => { drawPlayer(p, o.x, o.y, p.d, o.moving, o.step, o); drawSwing(o.x, o.y, o.swingA, p.w, o.swingAt); } }); }
    }
    list.sort((a, b) => a.y - b.y);
    for (const it of list) it.f();
    for (const v of beastsView.values()) if (vis(v.x, v.y)) drawTelegraph(v, v.row);
    for (const [, x, y] of snap.proj || []) {
      const [px, py] = W2S(x, y);
      ctx.fillStyle = P.stone; ctx.strokeStyle = P.ink; ctx.lineWidth = dpr;
      ctx.beginPath(); ctx.arc(px, py, T * 0.08, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
    drawEffects();
    drawFogBank();
    drawFog();

    // La nuit : un lavis d'encre indigo que seuls le feu et les torches percent.
    const dark = A.darkness(snap.time);
    const flick = 1 + Math.sin(now / 110) * 0.03 + Math.sin(now / 47) * 0.02;
    if (dark > 0.01) {
      lctx.globalCompositeOperation = 'source-over';
      lctx.clearRect(0, 0, CW, CH);
      lctx.fillStyle = `rgba(24,30,64,${0.8 * dark})`;
      lctx.fillRect(0, 0, CW, CH);
      lctx.globalCompositeOperation = 'destination-out';
      const hole = (x, y, r, a = 1) => {
        const [px, py] = W2S(x, y);
        const gr = lctx.createRadialGradient(px, py, 0, px, py, r * T);
        gr.addColorStop(0, `rgba(0,0,0,${a})`); gr.addColorStop(0.5, `rgba(0,0,0,${a * 0.8})`); gr.addColorStop(1, 'rgba(0,0,0,0)');
        lctx.fillStyle = gr; lctx.fillRect(px - r * T, py - r * T, r * T * 2, r * T * 2);
      };
      if (snap.fire > 0) hole(camp.fire.x, camp.fire.y - 0.3, C.FIRE_RADIUS * flick * clamp(snap.fire / 60, 0.7, 1));
      for (const p of snap.players) {
        const pos = p.id === myId ? me : (p.b ? boatsView.get(p.b) : others.get(p.id)) || p;
        if (p.tl) hole(pos.x, pos.y - 0.3, C.TORCH_RADIUS * flick);
        hole(pos.x, pos.y - 0.3, 1.7, 0.5);
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(light, 0, 0);
      ctx.globalCompositeOperation = 'soft-light';
      const glow = (x, y, r, a) => {
        const [px, py] = W2S(x, y);
        const gr = ctx.createRadialGradient(px, py, 0, px, py, r * T);
        gr.addColorStop(0, `rgba(255,150,60,${a})`); gr.addColorStop(1, 'rgba(255,150,60,0)');
        ctx.fillStyle = gr; ctx.fillRect(px - r * T, py - r * T, r * T * 2, r * T * 2);
      };
      if (snap.fire > 0) glow(camp.fire.x, camp.fire.y - 0.3, C.FIRE_RADIUS * 0.85, 0.75 * dark * flick);
      for (const p of snap.players) if (p.tl) { const pos = p.id === myId ? me : (p.b ? boatsView.get(p.b) : others.get(p.id)) || p; glow(pos.x, pos.y - 0.4, C.TORCH_RADIUS * 0.75, 0.55 * dark); }
      ctx.globalCompositeOperation = 'source-over';
      // Les yeux des Pâles restent visibles dans le noir.
      for (const v of beastsView.values()) {
        if (v.row[1] !== 'pale' || !vis(v.x, v.y)) continue;
        const [px, py] = W2S(v.x, v.y - 0.45);
        ctx.fillStyle = `rgba(220,230,240,${0.7 * dark})`;
        ctx.beginPath(); ctx.arc(px - T * 0.11, py, T * 0.04, 0, Math.PI * 2); ctx.arc(px + T * 0.11, py, T * 0.04, 0, Math.PI * 2); ctx.fill();
      }
    }
    const t = snap.time;
    if (t > 0.58 && t < 0.74) { ctx.fillStyle = `rgba(200,110,60,${0.12 * Math.sin(((t - 0.58) / 0.16) * Math.PI)})`; ctx.fillRect(0, 0, CW, CH); }
    drawWeather();

    // Signaux : une croix rouge, comme sur une carte au trésor.
    for (let i = pings.length - 1; i >= 0; i--) {
      const pg = pings[i], age = (performance.now() - pg.t) / 1000;
      if (age > 5) { pings.splice(i, 1); continue; }
      const [px, py] = W2S(pg.x, pg.y);
      const fade = age > 4 ? 5 - age : 1;
      const r = T * 0.32, grow = Math.min(1, age * 4);
      ctx.save(); ctx.globalAlpha = fade; ctx.lineCap = 'round';
      ctx.strokeStyle = P.red; ctx.lineWidth = 3 * dpr;
      ctx.beginPath(); ctx.moveTo(px - r * grow, py - r * grow); ctx.lineTo(px + r * grow, py + r * grow);
      ctx.moveTo(px + r * grow, py - r * grow); ctx.lineTo(px - r * grow, py + r * grow); ctx.stroke();
      const ph = (age % 1.2) / 1.2;
      ctx.globalAlpha = fade * (1 - ph); ctx.lineWidth = 1.5 * dpr; ctx.strokeStyle = P.ink;
      ctx.beginPath(); ctx.arc(px, py, r * (1.3 + ph * 1.6), 0, Math.PI * 2); ctx.stroke();
      ctx.globalAlpha = fade;
      ctx.font = `italic ${Math.round(13 * dpr)}px "IM Fell English", Georgia, serif`;
      ctx.textAlign = 'center'; ctx.lineWidth = 3 * dpr; ctx.strokeStyle = P.paper; ctx.fillStyle = P.red;
      ctx.strokeText(pg.n, px, py - r * 1.6); ctx.fillText(pg.n, px, py - r * 1.6);
      if (px < 0 || py < 0 || px > CW || py > CH) {
        const a = Math.atan2(py - CH / 2, px - CW / 2);
        const ex = CW / 2 + Math.cos(a) * (Math.min(CW, CH) / 2 - 44 * dpr), ey = CH / 2 + Math.sin(a) * (Math.min(CW, CH) / 2 - 44 * dpr);
        ctx.translate(ex, ey); ctx.rotate(a);
        ctx.fillStyle = P.red; ctx.strokeStyle = P.ink; ctx.lineWidth = 1.2 * dpr;
        ctx.beginPath(); ctx.moveTo(16 * dpr, 0); ctx.lineTo(-6 * dpr, -9 * dpr); ctx.lineTo(-2 * dpr, 0); ctx.lineTo(-6 * dpr, 9 * dpr); ctx.closePath(); ctx.fill(); ctx.stroke();
      }
      ctx.restore();
    }

    // Noms à l'encre, en italique, avec un halo de papier pour rester lisibles la nuit.
    ctx.font = `italic ${Math.round(14 * dpr)}px "IM Fell English", Georgia, serif`;
    ctx.textAlign = 'center'; ctx.lineJoin = 'round';
    for (const p of snap.players) {
      if (p.id === myId) continue;
      const o = p.b ? boatsView.get(p.b) : others.get(p.id);
      if (!o) continue;
      const [px, py] = W2S(o.x, o.y);
      const seat = p.b ? (snap.boats.find((b) => b.id === p.b) || { seats: [] }).seats.indexOf(p.id) : 0;
      const ly = py - T * (p.b ? 0.8 : 1.1) - Math.max(0, seat) * 15 * dpr;
      const label = p.n + (p.r ? ` · ${ROLES[p.r].label.toLowerCase()}` : '');
      ctx.lineWidth = 4 * dpr; ctx.strokeStyle = 'rgba(238,226,197,.92)'; ctx.strokeText(label, px, ly);
      ctx.fillStyle = P.ink; ctx.fillText(label, px, ly);
      const w = ctx.measureText(label).width;
      ctx.strokeStyle = p.c; ctx.lineWidth = 2 * dpr; ctx.beginPath(); ctx.moveTo(px - w / 2, ly + 4 * dpr); ctx.lineTo(px + w / 2, ly + 4 * dpr); ctx.stroke();
      if (!p.dn && p.hp < 100) {
        const bw = Math.min(w, T * 0.9), by = ly + 7 * dpr;
        ctx.fillStyle = 'rgba(238,226,197,.9)'; ctx.fillRect(px - bw / 2, by, bw, 3 * dpr);
        ctx.fillStyle = P.red; ctx.fillRect(px - bw / 2, by, bw * p.hp / 100, 3 * dpr);
      }
    }
    if (mine && !mine.b && !mine.dn) {
      const [px, py] = W2S(me.x, me.y);
      const by = py - T * 1.12 + Math.sin(now / 320) * 2 * dpr;
      ctx.fillStyle = P.red; ctx.strokeStyle = P.ink; ctx.lineWidth = 1.2 * dpr;
      ctx.beginPath(); ctx.moveTo(px - 5 * dpr, by - 8 * dpr); ctx.lineTo(px + 5 * dpr, by - 8 * dpr); ctx.lineTo(px, by); ctx.closePath(); ctx.fill(); ctx.stroke();
      // Le viseur : un petit trait vers la souris, pour savoir où part le coup.
      if (snap.st === 'playing') {
        const a = aimAngle(), r0 = T * 0.55, r1 = T * 0.8;
        const [cx, cy] = W2S(me.x, me.y - 0.35);
        ctx.strokeStyle = 'rgba(46,36,26,.5)'; ctx.lineWidth = 1.5 * dpr;
        ctx.beginPath(); ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0); ctx.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1); ctx.stroke();
      }
    }
    // Jauge d'action sous la cible.
    if (target && target.hold && holdT > 0 && target.pos) {
      const [px, py] = W2S(target.pos.x, target.pos.y);
      const w = T * 0.95, h = 6 * dpr, f = target.prog ? target.prog() : clamp(holdT / target.dur, 0, 1);
      const y0 = py + T * 0.42 + (target.work ? 9 * dpr : 0);
      if (!target.work || target.key.startsWith('lev')) {
        const ff = target.work ? 1 : f;
        ctx.fillStyle = 'rgba(238,226,197,.95)'; ctx.fillRect(px - w / 2, y0, w, h);
        ctx.fillStyle = P.red; ctx.fillRect(px - w / 2, y0, w * ff, h);
        ctx.strokeStyle = P.ink; ctx.lineWidth = 1.2 * dpr; ctx.strokeRect(px - w / 2, y0, w, h);
      }
    }
    // Blessure : le bord de la page rougit.
    const hurt = (now - me.hurtAt) / 1000;
    if (hurt < 0.5 || (mine && mine.hp < 30 && !mine.dn)) {
      const a = hurt < 0.5 ? 0.45 * (1 - hurt / 0.5) : 0.18 + 0.08 * Math.sin(now / 300);
      const gr = ctx.createRadialGradient(CW / 2, CH / 2, Math.min(CW, CH) * 0.35, CW / 2, CH / 2, Math.max(CW, CH) * 0.7);
      gr.addColorStop(0, 'rgba(158,58,36,0)'); gr.addColorStop(1, `rgba(158,58,36,${a})`);
      ctx.fillStyle = gr; ctx.fillRect(0, 0, CW, CH);
    }
  }

  // ---------------------------------------------------------------- cartes réduites
  function makeOverviews() {
    miniBase = document.createElement('canvas');
    miniBase.width = 384; miniBase.height = Math.round(384 * world.H / world.W);
    const m = miniBase.getContext('2d');
    m.imageSmoothingEnabled = true; m.imageSmoothingQuality = 'high';
    m.drawImage(mapCanvas, 0, 0, miniBase.width, miniBase.height);
    bigBase = null; // dessinée à la première ouverture, quand les polices sont chargées
  }
  const BIOME_NOTE = { home: 'le camp', foret: 'bois', roc: 'pierre', verte: 'fruits, lin, eau douce', sable: 'un peu de tout', phare: 'la flamme noire' };
  // Applique le papier vierge sur une vue réduite de la carte.
  function fogOver(g, w, h) {
    const f = document.createElement('canvas'); f.width = w; f.height = h;
    const fg = f.getContext('2d');
    fg.fillStyle = fg.createPattern(paperTile, 'repeat'); fg.fillRect(0, 0, w, h);
    fg.strokeStyle = 'rgba(46,36,26,.14)'; fg.lineWidth = 1;
    fg.beginPath();
    const k = w / world.W;
    for (let x = 10; x < world.W; x += 10) { fg.moveTo(x * k, 0); fg.lineTo(x * k, h); }
    for (let y = 10; y < world.H; y += 10) { fg.moveTo(0, y * k); fg.lineTo(w, y * k); }
    fg.stroke();
    fg.globalCompositeOperation = 'destination-out';
    fg.imageSmoothingEnabled = true;
    fg.drawImage(fogMask, 0, 0, w, h);
    g.drawImage(f, 0, 0);
  }
  function makeBigBase() {
    const W = 960, H = Math.round(960 * world.H / world.W);
    bigBase = document.createElement('canvas'); bigBase.width = W; bigBase.height = H;
    const g = bigBase.getContext('2d');
    g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
    g.drawImage(mapCanvas, 0, 0, W, H);
    const k = W / world.W;
    // Récifs et courants repérés.
    g.strokeStyle = 'rgba(46,60,80,.6)'; g.lineWidth = 1.2;
    for (let y = 0; y < world.H; y += 3) for (let x = 0; x < world.W; x += 3) {
      const [cx, cy] = currentAt(x, y); if ((!cx && !cy) || !seenAt(x, y)) continue;
      const m = Math.hypot(cx, cy), ux = cx / m, uy = cy / m, px = (x + 0.5) * k, py = (y + 0.5) * k, L = k * 1.1;
      g.beginPath(); g.moveTo(px - ux * L, py - uy * L); g.lineTo(px + ux * L, py + uy * L);
      g.lineTo(px + ux * L - (ux - uy * 0.7) * L * 0.6, py + uy * L - (uy + ux * 0.7) * L * 0.6); g.stroke();
    }
    g.fillStyle = 'rgb(70,64,60)';
    for (const i of world.reefs) { const x = i % world.W, y = (i / world.W) | 0; g.beginPath(); g.moveTo(x * k + k * 0.1, (y + 0.9) * k); g.lineTo((x + 0.5) * k, y * k + k * 0.1); g.lineTo((x + 0.9) * k, (y + 0.9) * k); g.fill(); }
    fogOver(g, W, H);
    // Le banc de brume.
    const ph = world.phare;
    if (ph) {
      g.save();
      const open = fragCount() >= C.FRAG_NEED;
      g.fillStyle = open ? 'rgba(236,234,228,.35)' : 'rgba(228,226,220,.9)';
      g.strokeStyle = 'rgba(100,100,110,.6)'; g.lineWidth = 1.2;
      g.beginPath();
      for (let i = 0; i <= 48; i++) { const a = (i / 48) * Math.PI * 2, r = ph.zone * k * (1 + 0.05 * Math.sin(i * 5)); g.lineTo(ph.x * k + Math.cos(a) * r, ph.y * k + Math.sin(a) * r); }
      g.closePath(); g.fill(); g.setLineDash([4, 3]); g.stroke(); g.setLineDash([]);
      g.font = 'italic 20px "IM Fell English", Georgia, serif'; g.textAlign = 'center'; g.fillStyle = 'rgb(90,90,100)';
      if (!open) { g.fillText('banc de brume', ph.x * k, ph.y * k - 6); g.font = '34px "IM Fell English SC", Georgia, serif'; g.fillText('?', ph.x * k, ph.y * k + 26); }
      // Le cap que dessinent les fragments.
      if (open) {
        const hx = world.camp.fire.x * k, hy = world.camp.fire.y * k;
        g.strokeStyle = P.red; g.lineWidth = 2; g.setLineDash([7, 6]);
        g.beginPath(); g.moveTo(hx, hy); g.lineTo(ph.x * k, ph.y * k); g.stroke(); g.setLineDash([]);
        const mx = (hx + ph.x * k) / 2, my = (hy + ph.y * k) / 2;
        g.font = 'italic 17px "IM Fell English", Georgia, serif'; g.lineWidth = 4; g.strokeStyle = 'rgba(238,226,197,.9)';
        g.strokeText('le cap des fragments', mx, my - 8); g.fillStyle = P.red; g.fillText('le cap des fragments', mx, my - 8);
      }
      g.restore();
    }
    // Cadre double, comme une carte imprimée.
    g.strokeStyle = P.ink; g.lineWidth = 3; g.strokeRect(10, 10, W - 20, H - 20);
    g.lineWidth = 1; g.strokeRect(17, 17, W - 34, H - 34);
    for (let x = 17; x < W - 17; x += 24) { g.fillStyle = (x / 24) % 2 < 1 ? P.ink : P.paper; g.fillRect(x, 10, 24, 7); g.fillRect(x, H - 17, 24, 7); }
    g.strokeRect(10, 10, W - 20, 7); g.strokeRect(10, H - 17, W - 20, 7);
    // Noms des îles cartographiées.
    g.textAlign = 'center'; g.lineJoin = 'round';
    for (const I of world.islands) {
      if (!discovered(I)) continue;
      const x = I.x * k, y = Math.max((I.y - I.r - 1.4) * k, 44);
      g.font = '24px "IM Fell English SC", "IM Fell English", Georgia, serif';
      g.lineWidth = 5; g.strokeStyle = 'rgba(238,226,197,.85)'; g.strokeText(I.name, x, y);
      g.fillStyle = P.ink; g.fillText(I.name, x, y);
      g.font = 'italic 16px "IM Fell English", Georgia, serif';
      const ly = Math.min((I.y + I.r + 2.6) * k, H - 30);
      const note = BIOME_NOTE[I.biome] || '';
      g.strokeText(note, x, ly); g.fillStyle = P.red; g.fillText(note, x, ly);
    }
    // Sites aperçus : un point d'interrogation, ou une croix une fois le fragment trouvé.
    for (const s of sites.values()) {
      if (s.k === 'phare' || !seenAt(s.x, s.y)) continue;
      const x = s.x * k, y = s.y * k;
      g.font = 'bold 20px "IM Fell English", Georgia, serif';
      g.lineWidth = 4; g.strokeStyle = 'rgba(238,226,197,.9)';
      const txt = s.done ? ROMAN(s.frag) : '?';
      g.strokeText(txt, x, y + 7); g.fillStyle = s.done ? P.ink : P.red; g.fillText(txt, x, y + 7);
    }
    // Le cartouche et la rose des vents se posent là où la mer est libre.
    const spots = [[W / 2, 66], [W / 2, H - 62], [160, 66], [W - 160, 66], [160, H - 62], [W - 160, H - 62]];
    const clear = ([x, y]) => Math.min(...world.islands.map((I) => Math.hypot(I.x * k - x, I.y * k - y) - (I.r + (I.id === 'phare' ? 10 : 3)) * k));
    spots.sort((a, b) => clear(b) - clear(a));
    const [tx0, ty0] = spots[0];
    const rose = [[90, H - 90], [W - 90, H - 90], [90, 90], [W - 90, 90]].filter(([x, y]) => Math.hypot(x - tx0, y - ty0) > 200).sort((a, b) => clear(b) - clear(a))[0];
    PA.compass(g, rose[0], rose[1], 42);
    g.save(); g.translate(tx0, ty0);
    g.fillStyle = 'rgba(238,226,197,.94)'; g.strokeStyle = P.ink;
    g.beginPath(); g.moveTo(-120, -36); g.lineTo(120, -36); g.quadraticCurveTo(132, 0, 120, 36); g.lineTo(-120, 36); g.quadraticCurveTo(-132, 0, -120, -36); g.closePath();
    g.fill(); g.lineWidth = 2; g.stroke();
    g.fillStyle = P.ink; g.textAlign = 'center';
    g.font = '32px "IM Fell English SC", Georgia, serif'; g.fillText("L'Archipel", 0, 4);
    g.font = 'italic 15px "IM Fell English", Georgia, serif'; g.fillText('relevé par les naufragés', 0, 24);
    g.restore();
    bigDirty = false;
  }
  let miniFog = null, miniFogAt = -1;
  function drawOverview(cv, big) {
    if (big && (!bigBase || bigDirty)) makeBigBase();
    const g = cv.getContext('2d');
    if (cv.height !== Math.round(cv.width * world.H / world.W)) cv.height = Math.round(cv.width * world.H / world.W);
    g.imageSmoothingEnabled = true;
    if (big) g.drawImage(bigBase, 0, 0, cv.width, cv.height);
    else {
      if (!miniFog || now - miniFogAt > 1000) {
        miniFog = document.createElement('canvas'); miniFog.width = cv.width; miniFog.height = cv.height;
        const mg = miniFog.getContext('2d'); mg.drawImage(miniBase, 0, 0, cv.width, cv.height); fogOver(mg, cv.width, cv.height);
        miniFogAt = now;
      }
      g.drawImage(miniFog, 0, 0);
    }
    const k = cv.width / world.W;
    const camp = world.camp;
    g.lineWidth = big ? 1.5 : 1; g.strokeStyle = P.ink;
    const tx = camp.fire.x * k, ty = camp.fire.y * k, ts = big ? 9 : 5;
    g.fillStyle = P.red; g.beginPath(); g.moveTo(tx, ty - ts); g.lineTo(tx + ts, ty + ts * 0.6); g.lineTo(tx - ts, ty + ts * 0.6); g.closePath(); g.fill(); g.stroke();
    for (const b of snap.boats) {
      const v = boatsView.get(b.id) || b;
      g.fillStyle = P.wood; g.beginPath(); g.ellipse(v.x * k, v.y * k, big ? 7 : 4, big ? 3 : 2, v.a, 0, Math.PI * 2); g.fill(); g.stroke();
    }
    const mine = myself();
    if (mine && mine.r === 'chasseur') {
      for (const v of beastsView.values()) {
        if (!seenAt(v.x, v.y)) continue;
        g.fillStyle = P.red; g.beginPath(); g.arc(v.x * k, v.y * k, big ? 3 : 1.8, 0, Math.PI * 2); g.fill();
      }
    }
    g.textAlign = 'center';
    for (const p of snap.players) {
      const pos = p.id === myId ? me : (p.b ? boatsView.get(p.b) : others.get(p.id)) || p;
      const r = p.id === myId ? (big ? 7 : 4.5) : (big ? 5.5 : 3.5);
      g.fillStyle = p.c; g.beginPath(); g.arc(pos.x * k, pos.y * k, r, 0, Math.PI * 2); g.fill(); g.stroke();
      if (p.id === myId) { g.beginPath(); g.arc(pos.x * k, pos.y * k, r + (big ? 4 : 2.5), 0, Math.PI * 2); g.stroke(); }
      if (big) {
        g.font = 'italic 17px "IM Fell English", Georgia, serif';
        g.lineWidth = 4; g.strokeStyle = 'rgba(238,226,197,.9)'; g.strokeText(p.n, pos.x * k, pos.y * k - 14);
        g.fillStyle = P.ink; g.fillText(p.n, pos.x * k, pos.y * k - 14); g.lineWidth = 1.5; g.strokeStyle = P.ink;
      }
    }
    for (const pg of pings) {
      const x = pg.x * k, y = pg.y * k, r = big ? 8 : 5;
      g.save(); g.strokeStyle = P.red; g.lineWidth = big ? 3 : 2;
      g.beginPath(); g.moveTo(x - r, y - r); g.lineTo(x + r, y + r); g.moveTo(x + r, y - r); g.lineTo(x - r, y + r); g.stroke(); g.restore();
    }
    if (!big) {
      g.save(); g.setLineDash([3, 2]); g.strokeStyle = P.ink; g.lineWidth = 1;
      g.strokeRect((cam.x - CW / 2 / T) * k, (cam.y - CH / 2 / T) * k, (CW / T) * k, (CH / T) * k);
      g.restore();
    }
  }

  // ---------------------------------------------------------------- interface
  const logEl = $('log');
  function addLog(text, kind) {
    const li = document.createElement('li');
    li.textContent = text; li.className = kind || '';
    logEl.appendChild(li);
    while (logEl.children.length > 6) logEl.firstChild.remove();
    const life = kind === 'mystery' ? 11000 : 7000;
    setTimeout(() => li.classList.add('fade'), life);
    setTimeout(() => li.remove(), life + 700);
  }
  let noteTimer = 0;
  function showNote(t) { const el = $('note'); el.textContent = t; el.hidden = false; clearTimeout(noteTimer); noteTimer = setTimeout(() => { el.hidden = true; }, 3600); }
  function showIsland(I) {
    const el = $('island-toast'); el.hidden = true; void el.offsetWidth;
    el.innerHTML = `${escapeHTML(I.name)}<small>${BIOME_NOTE[I.biome] || ''}</small>`;
    el.hidden = false;
  }
  let fragTimer = 0;
  function showFragment(n) {
    const F = FRAGMENTS.find((f) => f.n === n); if (!F) return;
    const el = $('frag-toast');
    el.innerHTML = `<p class="eyebrow">Fragment ${ROMAN(n)} sur ${C.FRAGS}</p><h3>${escapeHTML(F.title)}</h3><p class="frag-text">${escapeHTML(F.text)}</p><p class="tiny"><kbd>J</kbd> ouvre le carnet. Clique pour refermer.</p>`;
    el.hidden = false;
    clearTimeout(fragTimer); fragTimer = setTimeout(() => { el.hidden = true; }, 14000);
    if (!$('journal').hidden) renderJournal();
  }
  function renderJournal(focus) {
    const have = new Set(snap.frags || []);
    const n = have.size;
    const lead = n === 0 ? "Aucun fragment pour l'instant. Cherchez les points d'interrogation rouges sur les îles."
      : n < C.FRAG_NEED ? `Encore ${C.FRAG_NEED - n} fragment${C.FRAG_NEED - n > 1 ? 's' : ''} et le cap à travers le banc de brume se dessinera sur la carte.`
      : n < C.FRAGS ? 'Le cap vers le Phare noir est tracé sur la carte. Les fragments manquants changent la fin que vous pourrez choisir.'
      : snap.gd ? "Tout est clair. Portez 6 bois, 3 pierres et 3 eau au sommet du Phare." : "Le carnet est complet. Il reste le Gardien.";
    $('journal-lead').textContent = lead;
    $('journal-count').textContent = `${n} / ${C.FRAGS}`;
    $('journal-list').innerHTML = FRAGMENTS.map((F) => have.has(F.n)
      ? `<li class="found${focus === F.n ? ' focus' : ''}" id="frag-${F.n}"><span class="num">${ROMAN(F.n)}</span><div><h3>${escapeHTML(F.title)}</h3><p>${escapeHTML(F.text)}</p></div></li>`
      : `<li class="missing"><span class="num">${ROMAN(F.n)}</span><div><h3>Page arrachée</h3><p>Quelque part dans l'archipel…</p></div></li>`).join('');
    if (focus) { const el = $('frag-' + focus); if (el) el.scrollIntoView({ block: 'nearest' }); }
  }
  function openJournal(focus) { renderJournal(focus); $('journal').hidden = false; }
  function toggleJournal() { if ($('journal').hidden) openJournal(); else $('journal').hidden = true; }

  function openRoles() {
    if (!snap) return;
    const p = myself();
    $('role-cards').innerHTML = Object.entries(ROLES).map(([id, R]) => {
      const by = snap.players.find((q) => q.r === id && q.id !== myId);
      const mineR = p && p.r === id;
      return `<button class="role-card${mineR ? ' mine' : ''}" data-role="${id}" ${by ? 'disabled' : ''}><span class="nm">${R.label}</span><span class="short">${R.short}</span><span class="ds">${R.desc}</span>${by ? `<span class="by">pris par ${escapeHTML(by.n)}</span>` : mineR ? '<span class="by">ton métier</span>' : ''}</button>`;
    }).join('');
    $('roles').hidden = false;
  }

  function openVote() {
    const el = $('vote');
    const votes = snap.votes || {};
    const names = (v) => snap.players.filter((q) => votes[q.id] === v).map((q) => escapeHTML(q.n)).join(', ');
    const key = JSON.stringify(votes);
    if (!el.hidden && el.dataset.k === key) return;
    el.dataset.k = key;
    $('vote-options').innerHTML = [
      ['verite', 'Éteindre la flamme', 'La brume se lève, un navire vous recueille. Le Phare restera une ruine.'],
      ['partir', 'Rallumer la flamme et partir', 'Une flamme blanche guidera les marins. Elle vous ramènera chez vous.'],
      ['rester', 'Rallumer la flamme et rester', "Vous devenez les nouveaux Veilleurs de l'archipel."],
    ].map(([v, t, d]) => `<button class="role-card${votes[myId] === v ? ' mine' : ''}" data-vote="${v}"><span class="nm">${t}</span><span class="ds">${d}</span>${names(v) ? `<span class="by">${names(v)}</span>` : ''}</button>`).join('');
    $('vote-wait').textContent = `${Object.keys(votes).length} vote${Object.keys(votes).length > 1 ? 's' : ''} sur ${snap.players.length}. La majorité l'emporte quand tout le monde a choisi.`;
    el.hidden = false;
  }

  function costHTML(cost, stock) {
    return Object.entries(cost).map(([r, v]) => `<span class="${(stock[r] || 0) < v ? 'miss' : ''}">${v} ${RES_LABEL[r].toLowerCase()}</span>`).join(' · ');
  }
  function resItems(obj, take) {
    return RES.map((r) => `<li class="${obj[r] ? '' : 'zero'}" title="${RES_LABEL[r]}"${take ? ` data-take="${r}" role="button" tabindex="0"` : ''}><img src="${RES_ICON[r]}" alt="">${obj[r] || 0}</li>`).join('');
  }

  let lastPanelKey = '';
  function renderPanels(force) {
    if (!snap || preview) return;
    const p = myself(); if (!p) return;
    for (const [k, v] of [['hp', p.hp], ['f', p.f], ['s', p.s]]) {
      const el = document.querySelector(`.bar[data-k="${k}"]`);
      el.querySelector('b').style.width = clamp(v, 0, 100) + '%';
      el.classList.toggle('low', v < 25);
    }
    $('role-line').innerHTML = p.r ? `<b>${ROLES[p.r].label}</b> · ${ROLES[p.r].short}` : '<b>Choisir un métier</b>';
    $('sac-count').textContent = `${A.sacCount(p.inv)}/${C.SAC_CAP}`;
    const sacKey = JSON.stringify(p.inv);
    if (force || $('sac').dataset.k !== sacKey) { $('sac').innerHTML = resItems(p.inv); $('sac').dataset.k = sacKey; }
    const wKey = JSON.stringify([p.w, p.tools]);
    if (force || $('weapons').dataset.k !== wKey) {
      $('weapons').dataset.k = wKey;
      $('weapons').innerHTML = WEAPON_ORDER.map((w, i) => {
        const has = w === 'mains' || p.tools[w];
        return `<button class="wpn${p.w === w ? ' on' : ''}" data-w="${w}" ${has ? '' : 'disabled'} title="${WEAPONS[w].label}"><kbd>${i + 1}</kbd>${WEAPONS[w].label}</button>`;
      }).join('');
    }
    const tools = [];
    if (p.tools.pioche) tools.push('<span>Pioche</span>');
    tools.push(`<span class="${p.tl ? 'lit' : ''}">Torches ${p.tools.torches}${p.tl ? ' · allumée' : ''}</span>`);
    tools.push(`<span>Bandages ${p.tools.bandages}</span>`);
    $('tools').innerHTML = tools.join('');

    $('day').textContent = `Jour ${ROMAN(snap.day)}`;
    $('phase').textContent = A.phase(snap.time);
    $('sun-dot').style.left = (snap.time * 100) + '%';
    $('fire').textContent = snap.fire > 0 ? fmtTime(snap.fire) : 'éteint';
    $('fire').parentElement.classList.toggle('out', snap.fire <= 30);
    const w = snap.wt || { st: 'calme' };
    $('weather').textContent = w.st === 'tempete' ? `Tempête : ${fmtTime(w.t)}` : w.st === 'annonce' ? `Le baromètre chute : tempête dans ${fmtTime(w.t)}` : 'Mer calme';
    $('weather').className = 'weather-line ' + w.st;

    $('crew').innerHTML = snap.players.map((q) => {
      const qx = q.id === myId ? me.x : q.x, qy = q.id === myId ? me.y : q.y;
      const I = islandNear(qx, qy);
      const st = q.dn ? 'à terre' : q.b ? 'en mer' : q.cold ? 'a froid' : (I && discovered(I) ? I.name : 'en mer');
      return `<li><i class="dot" style="background:${q.c}"></i><span>${escapeHTML(q.n)}${q.id === myId ? ' (toi)' : ''}${q.r ? `<em>${ROLES[q.r].label.toLowerCase()}</em>` : ''}</span><span class="st ${q.dn || q.cold ? 'bad' : ''}">${escapeHTML(st)}</span></li>`;
    }).join('');

    // Carnet et navire.
    const have = new Set(snap.frags || []);
    const nextIdx = PARTS.findIndex((x) => !snap.parts[x.id]);
    const built = PARTS.filter((x) => snap.parts[x.id]).length;
    $('ship-track').innerHTML = `<span class="title">Le carnet</span><span class="frags">${FRAGMENTS.map((F) => `<i class="${have.has(F.n) ? 'on' : ''}" title="Fragment ${ROMAN(F.n)}">${ROMAN(F.n)}</i>`).join('')}</span><span class="sep"></span><span class="title">Le navire</span><span class="step ${built === PARTS.length ? 'done' : ''}">${built}/${PARTS.length}</span>`;

    // Barre du Gardien.
    const gard = [...beastsView.values()].find((v) => v.row[1] === 'gardien' && v.row[7] !== ST.sleep && dist(v, me) < 16);
    $('boss').hidden = !gard;
    if (gard) $('boss-bar').style.width = clamp(gard.row[5] / gard.row[6], 0, 1) * 100 + '%';

    // Panneau du camp.
    const camp = world.camp;
    const near = dist(me, camp.bench) <= C.CAMP_REACH + 0.5 || dist(me, camp.chest) <= C.CAMP_REACH || dist(me, camp.yard) <= C.CAMP_REACH + 1.5;
    $('camp').hidden = !near || p.dn;
    $('downed').hidden = !p.dn || snap.st !== 'playing';
    if (near) {
      const docked = snap.boats.filter((b) => dist(b, camp.dock) < 6 && b.hull < BOATS[b.k || 'barque'].hull - 1);
      const key = JSON.stringify([snap.chest, snap.parts, snap.recup, snap.grande, p.tools, snap.boats.length, docked.map((b) => b.hull)]);
      if (force || key !== lastPanelKey) {
        lastPanelKey = key;
        $('chest').innerHTML = resItems(snap.chest, true);
        $('recipes').innerHTML = Object.entries(RECIPES).map(([id, r]) => {
          const owned = (['hache', 'pioche', 'lance', 'fronde'].includes(id) && p.tools[id]) || (id === 'recuperateur' && snap.recup) || (id === 'grande' && snap.grande);
          const maxed = id === 'barque' && snap.boats.filter((b) => (b.k || 'barque') === 'barque').length >= C.MAX_BOATS;
          const ok = A.canAfford(snap.chest, r.cost) && !owned && !maxed;
          return `<button class="recipe ${owned ? 'done' : ''}" data-craft="${id}" ${ok ? '' : 'disabled'}><span class="nm">${r.label}${owned ? ' ✓' : ''}</span><span class="cost">${owned ? 'fait' : maxed ? 'max' : costHTML(r.cost, snap.chest)}</span><span class="ds">${r.desc}</span></button>`;
        }).join('');
        $('repairs').innerHTML = docked.length ? docked.map((b) => `<button class="recipe" data-repair="${b.id}" ${snap.chest.bois >= 2 ? '' : 'disabled'}><span class="nm">Réparer la ${BOATS[b.k || 'barque'].label.toLowerCase()} (${Math.round((b.hull / BOATS[b.k || 'barque'].hull) * 100)} %)</span><span class="cost">${costHTML({ bois: 2 }, snap.chest)}</span></button>`).join('') : '<p class="tiny">Les barques amarrées sont en bon état.</p>';
        $('parts').innerHTML = PARTS.map((x, i) => {
          const done = snap.parts[x.id];
          const ok = !done && i === nextIdx && A.canAfford(snap.chest, x.cost);
          return `<button class="recipe ${done ? 'done' : ''}" data-build="${x.id}" ${ok ? '' : 'disabled'}><span class="nm">${i + 1}. ${x.label}${done ? ' ✓' : ''}</span><span class="cost">${done ? 'construite' : costHTML(x.cost, snap.chest)}</span></button>`;
        }).join('');
        $('launch').hidden = nextIdx !== -1;
      }
    }

    // Invite d'action.
    const boat = myBoat();
    if (target) {
      $('prompt').hidden = false;
      let text = target.text;
      if (boat) { const B = BOATS[boat.k || 'barque']; text += ` · coque ${Math.round((boat.hull / B.hull) * 100)} %${p.r === 'charpentier' && boat.hull < B.hull - 1 ? ' (T : réparer)' : ''}`; }
      $('prompt-text').textContent = text;
      const showBar = target.hold;
      $('prompt-progress').parentElement.style.visibility = showBar ? 'visible' : 'hidden';
      const f = target.prog ? target.prog() : target.work ? (holdT > 0 ? 1 : 0) : clamp(holdT / target.dur, 0, 1);
      $('prompt-progress').style.width = (showBar ? f * 100 : 0) + '%';
    } else $('prompt').hidden = true;
  }

  const ENDINGS = {
    fuite: ['La fuite', 'Vous avez quitté l\'archipel', "Le navire prend le large. Derrière vous, la flamme noire brille toujours, et d'autres marins viendront s'y briser."],
    verite: ['La vérité', 'La flamme noire est éteinte', "La brume se lève pour la première fois depuis des siècles. Au matin, une voile apparaît à l'horizon et vient vous chercher."],
    veilleurs_partir: ['Les Veilleurs', 'Une flamme blanche sur l\'archipel', 'Le Phare guide de nouveau les marins. Vous rentrez chez vous, et vous savez que plus aucun navire ne se brisera ici.'],
    veilleurs_rester: ['Les Veilleurs', 'Les nouveaux gardiens', "Vous restez. Chaque nuit, l'un de vous monte au sommet nourrir la flamme blanche. L'archipel a de nouveau ses Veilleurs."],
  };
  function showEnd(s) {
    const won = s.st === 'won';
    const E = ENDINGS[s.end] || ENDINGS.fuite;
    const n = (s.frags || []).length;
    $('end-eyebrow').textContent = won ? `Fin : ${E[0]}` : 'Naufrage';
    $('end-title').textContent = won ? E[1] : `L'équipe a sombré au jour ${s.day}`;
    $('end-text').textContent = won ? E[2] : 'Le froid, la faim, la soif ou les bêtes ont eu raison de vous. Gardez le feu allumé la nuit et relevez vos coéquipiers.';
    const missing = FRAGMENTS.filter((F) => !(s.frags || []).includes(F.n));
    $('end-stats').innerHTML = `<li>Jour ${ROMAN(s.day)}</li><li>${n} fragment${n > 1 ? 's' : ''} sur ${C.FRAGS}</li><li>${(s.isl || []).length} île${(s.isl || []).length > 1 ? 's' : ''} cartographiée${(s.isl || []).length > 1 ? 's' : ''}</li>` +
      (missing.length && won ? `<li class="miss">Il vous a manqué : ${missing.map((F) => escapeHTML(F.title)).join(', ')}.</li>` : '');
    $('end').hidden = false;
  }

  // ---------------------------------------------------------------- boucle principale
  let prev = performance.now(), uiTimer = 0, miniTimer = 0;
  function frame(t) {
    const dt = Math.min(0.1, (t - prev) / 1000);
    prev = t; now = t;
    if (preview && world) {
      const c = world.camp.fire, k = t / 26000;
      me.x = c.x + Math.cos(k) * 22 - 4; me.y = c.y + Math.sin(k * 1.3) * 14;
    }
    if (!preview) update(dt);
    render();
    uiTimer += dt; miniTimer += dt;
    if (uiTimer > 0.1) { uiTimer = 0; renderPanels(false); }
    if (miniTimer > 0.25 && world && snap && !preview) {
      miniTimer = 0;
      drawOverview($('minimap'), false);
      if (!$('bigmap').hidden) drawOverview($('bigmap-canvas'), true);
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  loadPreview();

  // Pour les tests automatisés.
  window.__archipel = { get snap() { return snap; }, get me() { return me; }, get myId() { return myId; }, get world() { return world; }, nodes, sites, beastsView, send, openJournal };
})();
