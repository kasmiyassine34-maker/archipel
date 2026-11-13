// L'Archipel : client navigateur (rendu 2D, commandes, réseau).
(() => {
  'use strict';
  const A = window.ARCHIPEL;
  const { TILE, C, NODES, RECIPES, PARTS, RES, RES_LABEL } = A;
  const $ = (id) => document.getElementById(id);
  const PA = window.PAPER_ART;
  const P = PA.PALETTE;
  const PX = PA.PX; // pixels par tuile dans l'image de la carte
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
  const RES_ICON = PA.icons();

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
    const t0 = performance.now();
    mapCanvas = PA.paintMap(world, PX);
    makeOverviews();
    console.debug(`Carte peinte en ${Math.round(performance.now() - t0)} ms`);
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
    preview = false;
    setWorld(m);
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

  // Charge un archipel (celui de la partie, ou l'aperçu de l'écran d'accueil).
  function setWorld(m) {
    const bin = atob(m.tiles);
    const tiles = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) tiles[i] = bin.charCodeAt(i);
    const key = m.tiles.length + ':' + m.tiles.slice(0, 64) + m.tiles.slice(-64) + ':' + m.camp.dock.x + ',' + m.camp.dock.y;
    const same = world && world.seedKey === key && mapCanvas;
    world = { W: m.W, H: m.H, tiles, islands: m.islands, camp: m.camp, seedKey: key };
    if (!same) buildMap();
    nodes.clear();
    for (const [id, k, x, y, amt] of m.nodes) nodes.set(id, { id, k, x, y, amt });
    indexNodes();
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
      snap = { time: 0.3, day: 1, st: 'preview', fire: 200, chest: {}, parts: {}, recup: false, players: [], boats: m.boats || [], nodes: [], ev: [] };
      for (const b of snap.boats) boatsView.set(b.id, { x: b.x, y: b.y, a: b.a });
      preview = true;
      me.x = world.camp.fire.x; me.y = world.camp.fire.y;
      cam.x = me.x; cam.y = me.y;
    } catch { /* l'accueil reste lisible sans aperçu */ }
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
  function showLobbyError(t, soft) { const el = $('lobby-error'); el.textContent = t; el.hidden = false; el.style.color = soft ? 'var(--ink-2)' : ''; el.style.fontStyle = soft ? 'italic' : ''; }
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
        // Pilotage d'une vraie barque : avant/arrière pour ramer, gauche/droite pour tourner.
        const speed = C.SPEED_BOAT * (boat.seats.length >= 2 ? C.BOAT_CREW_BONUS : 1);
        const thrust = playing ? -iy : 0, turn = playing ? ix : 0;
        const want = thrust > 0 ? speed : thrust < 0 ? -speed * 0.55 : 0;
        me.spd = (me.spd || 0) + (want - (me.spd || 0)) * Math.min(1, dt * (want ? 2.2 : 1.4));
        // Nombre de points de la coque (centre, proue, poupe) posés sur la terre.
        const grounded = (x, y, a) => {
          if (!A.boatable(tileAt(x, y))) return 99;
          const fx = Math.cos(a) * 0.55, fy = Math.sin(a) * 0.55;
          return (A.boatable(tileAt(x + fx, y + fy)) ? 0 : 1) + (A.boatable(tileAt(x - fx, y - fy)) ? 0 : 1);
        };
        // On ne refuse un mouvement que s'il échoue davantage la barque : elle peut toujours se dégager.
        const na = me.boatA + turn * 2.4 * dt * (me.spd < -0.2 ? -1 : 1);
        if (turn && grounded(me.x, me.y, na) <= grounded(me.x, me.y, me.boatA)) me.boatA = na;
        const vx = Math.cos(me.boatA) * me.spd, vy = Math.sin(me.boatA) * me.spd;
        const here = grounded(me.x, me.y, me.boatA);
        const nx = me.x + vx * dt, ny = me.y + vy * dt;
        let hit = false;
        if (grounded(nx, me.y, me.boatA) <= here) me.x = nx; else hit = true;
        if (grounded(me.x, ny, me.boatA) <= here) me.y = ny; else hit = true;
        if (hit) me.spd *= 0.3;
        me.vx = vx; me.vy = vy;
        me.moving = Math.abs(me.spd) > 0.25;
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
    if (I && I.id !== lastIsland) { lastIsland = I.id; showIsland(I); }
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
    const pine = world.islands.find((I) => I.id === 'pins');
    return pine && Math.hypot(x - pine.x, y - pine.y) < pine.r * 1.5;
  }
  function drawTree(n) {
    sprite(n.x, n.y, (g) => {
      if (n.amt <= 0) {
        groundHatch(g, 8, 3, n.id);
        g.fillStyle = 'rgb(214,182,132)'; g.beginPath(); g.ellipse(0, 1, 4, 2.4, 0, 0, Math.PI * 2); g.fill(); g.stroke();
        g.beginPath(); g.ellipse(0, 1, 1.8, 1, 0, 0, Math.PI * 2); g.stroke();
        return;
      }
      const sw = Math.sin(now / 1300 + n.id) * 0.5;
      groundHatch(g, 12, 5, n.id);
      g.lineWidth = 1.6; g.beginPath(); g.moveTo(0, 6); g.lineTo(sw * 0.4, -3); g.stroke(); g.lineWidth = 1.15;
      if (isPineAt(n.x, n.y)) {
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
      // Une hache et un maillet posés sur l'établi.
      g.beginPath(); g.moveTo(-6, -6); g.lineTo(0, -9); g.stroke();
      g.fillStyle = P.stone; PA.wobblyPoly(g, [[-1, -11], [2, -10], [1, -7], [-1, -8]], 5, 0.3); g.fill(); g.stroke();
      g.fillStyle = P.woodDark; g.fillRect(3, -9, 5, 3); g.strokeRect(3, -9, 5, 3);
    });
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
        const flame = (o, col, w, h) => {
          const k = 1 + Math.sin(now / 95 + o) * 0.14, tip = Math.sin(now / 140 + o) * 1.4;
          g.beginPath(); g.moveTo(-w, 1);
          g.bezierCurveTo(-w * 1.1, -h * 0.4 * k, -w * 0.3, -h * 0.6 * k, tip, -h * k);
          g.bezierCurveTo(w * 0.3, -h * 0.6 * k, w * 1.1, -h * 0.4 * k, w, 1);
          g.closePath(); g.fillStyle = col; g.fill();
        };
        flame(0, 'rgba(196,74,40,.9)', 5 * s, 15 * s); g.stroke();
        flame(1.7, 'rgba(226,130,52,.95)', 3.4 * s, 10 * s);
        flame(3.1, 'rgba(244,206,120,.95)', 1.8 * s, 6 * s);
        for (let i = 0; i < 4; i++) {
          const t = ((now / 1000 + i / 4) % 1);
          g.fillStyle = `rgba(158,58,36,${1 - t})`; g.beginPath(); g.arc(Math.sin(i * 7 + now / 400) * 4, -8 - t * 16, 0.8, 0, Math.PI * 2); g.fill();
        }
      } else {
        g.save(); g.globalAlpha = 0.5; g.lineWidth = 0.8;
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
    sprite(v.x, v.y, (g) => {
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
      PA.wobblyPoly(g, hull, b.id * 13, 0.4); g.fillStyle = P.wood; g.fill(); g.stroke();
      PA.wobblyPoly(g, [[-11, -3], [7, -4], [11, 0], [7, 4], [-11, 3]], b.id * 13 + 1, 0.3); g.fillStyle = 'rgb(196,150,98)'; g.fill(); g.stroke();
      g.lineWidth = 1.4; g.beginPath(); g.moveTo(-3, -3.5); g.lineTo(-3, 3.5); g.moveTo(4, -3.8); g.lineTo(4, 3.8); g.stroke(); g.lineWidth = 1.15;
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
        const x = i === 0 ? 0.5 : -7;
        g.fillStyle = p.c; g.beginPath(); g.arc(x, 0, 3.4, 0, Math.PI * 2); g.fill(); g.stroke();
        g.fillStyle = P.skin; g.beginPath(); g.arc(x + 0.5, 0, 2, 0, Math.PI * 2); g.fill(); g.stroke();
      });
    }, v.a);
    v.lx = v.x; v.ly = v.y;
  }
  function drawPlayer(p, x, y, dir, moving, step) {
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
      groundHatch(g, 10, 7, p.id);
      const bob = moving ? -Math.abs(Math.sin(step)) * 0.9 : 0;
      const leg = moving ? Math.sin(step) * 2.2 : 0;
      g.lineWidth = 1.5;
      g.beginPath(); g.moveTo(-2, 2 + bob); g.lineTo(-2 - leg * 0.4, 7); g.moveTo(2, 2 + bob); g.lineTo(2 + leg * 0.4, 7); g.stroke();
      g.lineWidth = 1.15;
      PA.wobblyPoly(g, [[-4.5, -5 + bob], [4.5, -5 + bob], [5, 3 + bob], [-5, 3 + bob]], p.id * 3, 0.35);
      g.fillStyle = p.c; g.fill(); g.stroke();
      g.fillStyle = P.skin; PA.wobblyCircle(g, 0, -9.5 + bob, 3.8, p.id * 5, 0.06, 10); g.fill(); g.stroke();
      g.fillStyle = P.ink; g.beginPath(); g.arc(0, -10.5 + bob, 3.9, Math.PI * 1.05, Math.PI * 1.95); g.fill();
      if (Math.sin(dir) > -0.6) {
        const fx = Math.cos(dir) * 1.3;
        g.beginPath(); g.arc(-1.3 + fx, -9 + bob, 0.55, 0, Math.PI * 2); g.arc(1.3 + fx, -9 + bob, 0.55, 0, Math.PI * 2); g.fill();
      }
      if (p.tl) {
        g.lineWidth = 1.3; g.beginPath(); g.moveTo(5, -1 + bob); g.lineTo(6.5, -9 + bob); g.stroke(); g.lineWidth = 1.15;
        const k = 1 + Math.sin(now / 80) * 0.2;
        g.fillStyle = 'rgba(226,130,52,.95)'; g.beginPath(); g.ellipse(6.8, -11.5 + bob, 1.9 * k, 3 * k, 0, 0, Math.PI * 2); g.fill(); g.stroke();
        g.fillStyle = 'rgba(244,206,120,.95)'; g.beginPath(); g.ellipse(6.8, -11 + bob, 0.9, 1.5, 0, 0, Math.PI * 2); g.fill();
      }
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

  // Petites vagues dessinées à l'encre sur la mer, comme sur les vieilles cartes.
  function drawSea() {
    const x0 = Math.floor(cam.x - CW / 2 / T) - 1, x1 = Math.ceil(cam.x + CW / 2 / T) + 1;
    const y0 = Math.floor(cam.y - CH / 2 / T) - 1, y1 = Math.ceil(cam.y + CH / 2 / T) + 1;
    ctx.save();
    ctx.strokeStyle = P.ink; ctx.lineCap = 'round';
    ctx.lineWidth = Math.max(1, 0.9 * T / PX);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      if (hash(x, y, 7) > 0.07 || tileAt(x, y) !== TILE.DEEP || tileAt(x + 2, y) !== TILE.DEEP || tileAt(x - 2, y) !== TILE.DEEP || tileAt(x, y + 2) !== TILE.DEEP || tileAt(x, y - 2) !== TILE.DEEP) continue;
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

  function render() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = 'rgb(118,160,166)'; ctx.fillRect(0, 0, CW, CH);
    if (!world || !snap || !mapCanvas) return;
    const mine = myself();
    const tx = me.x, ty = me.y;
    cam.x += (tx - cam.x) * 0.2; cam.y += (ty - cam.y) * 0.2;
    if (Math.abs(cam.x - tx) > 20 || Math.abs(cam.y - ty) > 20) { cam.x = tx; cam.y = ty; }

    // Carte peinte une fois pour toutes.
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    const s = T / PX;
    const sx = (cam.x * PX) - CW / 2 / s, sy = (cam.y * PX) - CH / 2 / s;
    ctx.drawImage(mapCanvas, sx, sy, CW / s, CH / s, 0, 0, CW, CH);
    drawSea();

    // Objets triés par profondeur.
    const vx0 = cam.x - CW / 2 / T - 2, vx1 = cam.x + CW / 2 / T + 2, vy0 = cam.y - CH / 2 / T - 2, vy1 = cam.y + CH / 2 / T + 3;
    const vis = (x, y) => x > vx0 && x < vx1 && y > vy0 && y < vy1;
    const list = [];
    const drawers = { tree: drawTree, rock: drawRock, bush: drawBush, flax: drawFlax, spring: drawSpring };
    for (const n of nodes.values()) if (vis(n.x, n.y)) list.push({ y: n.y + (n.k === 'spring' ? -0.5 : 0), f: () => drawers[n.k](n) });
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
      for (const p of snap.players) if (p.tl) { const pos = p.id === myId ? me : (others.get(p.id) || p); glow(pos.x, pos.y - 0.4, C.TORCH_RADIUS * 0.75, 0.55 * dark); }
      ctx.globalCompositeOperation = 'source-over';
    }
    const t = snap.time;
    if (t > 0.58 && t < 0.74) { ctx.fillStyle = `rgba(200,110,60,${0.12 * Math.sin(((t - 0.58) / 0.16) * Math.PI)})`; ctx.fillRect(0, 0, CW, CH); }

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
      const second = p.b && (snap.boats.find((b) => b.id === p.b) || { seats: [] }).seats[1] === p.id;
      const ly = py - T * (p.b ? 0.8 : 1.1) - (second ? 15 * dpr : 0);
      ctx.lineWidth = 4 * dpr; ctx.strokeStyle = 'rgba(238,226,197,.92)'; ctx.strokeText(p.n, px, ly);
      ctx.fillStyle = P.ink; ctx.fillText(p.n, px, ly);
      const w = ctx.measureText(p.n).width;
      ctx.strokeStyle = p.c; ctx.lineWidth = 2 * dpr; ctx.beginPath(); ctx.moveTo(px - w / 2, ly + 4 * dpr); ctx.lineTo(px + w / 2, ly + 4 * dpr); ctx.stroke();
    }
    if (mine && !mine.b && !mine.dn) {
      const [px, py] = W2S(me.x, me.y);
      const by = py - T * 1.12 + Math.sin(now / 320) * 2 * dpr;
      ctx.fillStyle = P.red; ctx.strokeStyle = P.ink; ctx.lineWidth = 1.2 * dpr;
      ctx.beginPath(); ctx.moveTo(px - 5 * dpr, by - 8 * dpr); ctx.lineTo(px + 5 * dpr, by - 8 * dpr); ctx.lineTo(px, by); ctx.closePath(); ctx.fill(); ctx.stroke();
    }
    // Jauge de récolte sous la cible.
    if (target && target.hold && holdT > 0) {
      const n = target.msg.t === 'harvest' ? nodes.get(target.msg.id) : null;
      const pos = n || (target.msg.t === 'revive' ? others.get(target.msg.id) : null);
      if (pos) {
        const [px, py] = W2S(pos.x, pos.y);
        const w = T * 0.95, h = 6 * dpr, f = clamp(holdT / target.dur, 0, 1);
        const y0 = py + T * 0.42;
        ctx.fillStyle = 'rgba(238,226,197,.95)'; ctx.fillRect(px - w / 2, y0, w, h);
        ctx.fillStyle = P.red; ctx.fillRect(px - w / 2, y0, w * f, h);
        ctx.strokeStyle = P.ink; ctx.lineWidth = 1.2 * dpr; ctx.strokeRect(px - w / 2, y0, w, h);
      }
    }
  }

  // ---------------------------------------------------------------- cartes réduites
  function makeOverviews() {
    // Mini-carte : la carte peinte réduite.
    miniBase = document.createElement('canvas');
    miniBase.width = 192; miniBase.height = 144;
    const m = miniBase.getContext('2d');
    m.imageSmoothingEnabled = true; m.imageSmoothingQuality = 'high';
    m.drawImage(mapCanvas, 0, 0, 192, 144);
    bigBase = null; // dessinée à la première ouverture, quand les polices sont chargées
  }
  function makeBigBase() {
    const W = 960, H = 720;
    bigBase = document.createElement('canvas'); bigBase.width = W; bigBase.height = H;
    const g = bigBase.getContext('2d');
    g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
    g.drawImage(mapCanvas, 0, 0, W, H);
    const k = W / world.W;
    // Cadre double, comme une carte imprimée.
    g.strokeStyle = P.ink; g.lineWidth = 3; g.strokeRect(10, 10, W - 20, H - 20);
    g.lineWidth = 1; g.strokeRect(17, 17, W - 34, H - 34);
    // Graduations du cadre.
    for (let x = 17; x < W - 17; x += 24) { g.fillStyle = (x / 24) % 2 < 1 ? P.ink : P.paper; g.fillRect(x, 10, 24, 7); g.fillRect(x, H - 17, 24, 7); }
    g.strokeRect(10, 10, W - 20, 7); g.strokeRect(10, H - 17, W - 20, 7);
    // Noms des îles et ressources.
    const legend = { home: 'le camp', pins: 'bois', roc: 'pierre', verte: 'fruits, lin, eau douce', sable: 'un peu de tout' };
    g.textAlign = 'center'; g.lineJoin = 'round';
    for (const I of world.islands) {
      const x = I.x * k, y = (I.y - I.r - 1.8) * k;
      g.font = '30px "IM Fell English SC", "IM Fell English", Georgia, serif';
      g.lineWidth = 5; g.strokeStyle = 'rgba(238,226,197,.85)'; g.strokeText(I.name, x, y);
      g.fillStyle = P.ink; g.fillText(I.name, x, y);
      g.font = 'italic 19px "IM Fell English", Georgia, serif';
      const ly = Math.min((I.y + I.r + 3) * k, H - 34);
      g.strokeText(legend[I.id] || '', x, ly); g.fillStyle = P.red; g.fillText(legend[I.id] || '', x, ly);
    }
    // Rose des vents en bas à gauche, cartouche en haut au centre : deux zones de pleine mer sur toutes les cartes.
    PA.compass(g, 100, H - 100, 48);
    // Cartouche du titre.
    g.save(); g.translate(W / 2, 74);
    g.fillStyle = 'rgba(238,226,197,.94)'; g.strokeStyle = P.ink;
    g.beginPath(); g.moveTo(-120, -40); g.lineTo(120, -40); g.quadraticCurveTo(132, 0, 120, 40); g.lineTo(-120, 40); g.quadraticCurveTo(-132, 0, -120, -40); g.closePath();
    g.fill(); g.lineWidth = 2; g.stroke();
    g.lineWidth = 0.8; g.beginPath(); g.moveTo(-112, -33); g.lineTo(112, -33); g.moveTo(-112, 33); g.lineTo(112, 33); g.stroke();
    g.fillStyle = P.ink; g.textAlign = 'center';
    g.font = '34px "IM Fell English SC", Georgia, serif'; g.fillText("L'Archipel", 0, 4);
    g.font = 'italic 15px "IM Fell English", Georgia, serif'; g.fillText('relevé par les naufragés', 0, 24);
    g.restore();
  }
  function drawOverview(cv, big) {
    if (big && !bigBase) makeBigBase();
    const base = big ? bigBase : miniBase;
    const g = cv.getContext('2d');
    g.imageSmoothingEnabled = true;
    g.drawImage(base, 0, 0, cv.width, cv.height);
    const k = cv.width / world.W;
    const camp = world.camp;
    g.lineWidth = big ? 1.5 : 1; g.strokeStyle = P.ink;
    // Le camp : une petite tente.
    const tx = camp.fire.x * k, ty = camp.fire.y * k, ts = big ? 9 : 4;
    g.fillStyle = P.red; g.beginPath(); g.moveTo(tx, ty - ts); g.lineTo(tx + ts, ty + ts * 0.6); g.lineTo(tx - ts, ty + ts * 0.6); g.closePath(); g.fill(); g.stroke();
    for (const b of snap.boats) {
      const v = boatsView.get(b.id) || b;
      g.fillStyle = P.wood; g.beginPath(); g.ellipse(v.x * k, v.y * k, big ? 7 : 3.5, big ? 3 : 1.8, v.a, 0, Math.PI * 2); g.fill(); g.stroke();
    }
    g.textAlign = 'center';
    for (const p of snap.players) {
      const pos = p.id === myId ? me : (p.b ? boatsView.get(p.b) : others.get(p.id)) || p;
      const r = p.id === myId ? (big ? 7 : 3.6) : (big ? 5.5 : 2.8);
      g.fillStyle = p.c; g.beginPath(); g.arc(pos.x * k, pos.y * k, r, 0, Math.PI * 2); g.fill(); g.stroke();
      if (p.id === myId) { g.beginPath(); g.arc(pos.x * k, pos.y * k, r + (big ? 4 : 2.5), 0, Math.PI * 2); g.stroke(); }
      if (big) {
        g.font = 'italic 17px "IM Fell English", Georgia, serif';
        g.lineWidth = 4; g.strokeStyle = 'rgba(238,226,197,.9)'; g.strokeText(p.n, pos.x * k, pos.y * k - 14);
        g.fillStyle = P.ink; g.fillText(p.n, pos.x * k, pos.y * k - 14); g.lineWidth = 1.5; g.strokeStyle = P.ink;
      }
    }
    for (const pg of pings) {
      const x = pg.x * k, y = pg.y * k, r = big ? 8 : 4;
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
    setTimeout(() => li.classList.add('fade'), 7000);
    setTimeout(() => li.remove(), 7700);
  }
  let noteTimer = 0;
  function showNote(t) { const el = $('note'); el.textContent = t; el.hidden = false; clearTimeout(noteTimer); noteTimer = setTimeout(() => { el.hidden = true; }, 3200); }
  const ISLAND_NOTE = { home: 'notre camp', pins: 'du bois à perte de vue', roc: 'pierre et éboulis', verte: 'fruits, lin et eau douce', sable: 'un peu de tout' };
  function showIsland(I) {
    const el = $('island-toast'); el.hidden = true; void el.offsetWidth;
    el.innerHTML = `${escapeHTML(I.name)}<small>${ISLAND_NOTE[I.id] || ''}</small>`;
    el.hidden = false;
  }
  const ROMAN = (n) => { let r = ''; for (const [v, l] of [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']]) while (n >= v) { r += l; n -= v; } return r; };

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
    $('day').textContent = `Jour ${ROMAN(snap.day)}`;
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
    $('ship-track').innerHTML = '<span class="title">Le navire</span>' + PARTS.map((x, i) => `<span class="step ${snap.parts[x.id] ? 'done' : i === nextIdx ? 'next' : ''}">${x.label}</span>`).join('');

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
    if (preview && world) {
      const c = world.camp.fire, k = t / 26000;
      me.x = c.x + Math.cos(k) * 22 - 4; me.y = c.y + Math.sin(k * 1.3) * 14;
    }
    update(dt);
    render();
    uiTimer += dt; miniTimer += dt;
    if (uiTimer > 0.1) { uiTimer = 0; renderPanels(false); }
    if (miniTimer > 0.25 && world && snap) {
      miniTimer = 0;
      drawOverview($('minimap'), false);
      if (!$('bigmap').hidden) drawOverview($('bigmap-canvas'), true);
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  loadPreview();

  // Pour les tests automatisés.
  window.__archipel = { get snap() { return snap; }, get me() { return me; }, get myId() { return myId; }, get world() { return world; }, nodes, send };
})();
