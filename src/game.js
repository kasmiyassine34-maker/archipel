// Une partie : l'état de l'archipel et les règles, simulés côté serveur.
const S = require('../public/shared.js');
const { createWorld } = require('./world');
const { C, NODES, RECIPES, PARTS, RES, TILE } = S;

// Lavis d'aquarelle pour distinguer les joueurs : vermillon, bleu de Prusse, ocre, vert de vessie, violet, garance.
const COLORS = ['#c0543a', '#3f6f93', '#c99a3e', '#6f8f45', '#7d5f9a', '#b8687e'];
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const r2 = (v) => Math.round(v * 100) / 100;

class Game {
  constructor(code, seed) {
    this.code = code;
    this.players = new Map(); // id -> joueur
    this.seq = 1;
    this.emptySince = Date.now();
    this.reset(seed);
  }

  reset(seed) {
    this.seed = seed ?? ((Math.random() * 2 ** 31) | 0);
    this.world = createWorld(this.seed);
    this.nodes = new Map();
    for (const n of this.world.nodes) { n.amt = NODES[n.k].max; this.nodes.set(n.id, n); }
    this.camp = this.world.camp;
    this.time = 0.08;
    this.day = 1;
    this.fire = { ...this.camp.fire, fuel: 120 };
    this.chest = { bois: 6, pierre: 0, fibre: 0, nourriture: 8, eau: 8 };
    this.parts = {};
    this.recup = false; this.recupTimer = 0;
    this.boats = [];
    this.boatSeq = 1;
    this.addBoat();
    this.state = 'playing';
    this.endedAt = null;
    this.startedAt = Date.now();
    this.events = [];
    this.dirtyNodes = new Set();
    let i = 0;
    for (const p of this.players.values()) this.respawn(p, i++);
  }

  addBoat() {
    const d = this.camp.dock;
    const off = this.boats.length;
    const b = {
      id: this.boatSeq++,
      x: d.x - Math.sin(d.angle) * off * 1.4, y: d.y + Math.cos(d.angle) * off * 1.4,
      a: d.angle, seats: [], hold: {},
    };
    if (!S.boatable(this.tileAt(b.x, b.y))) { b.x = d.x; b.y = d.y; }
    this.boats.push(b);
    return b;
  }

  tileAt(x, y) {
    const { W, H, tiles } = this.world;
    const tx = Math.floor(x), ty = Math.floor(y);
    if (tx < 0 || ty < 0 || tx >= W || ty >= H) return TILE.DEEP;
    return tiles[tx + ty * W];
  }

  log(text, kind = 'info') { this.events.push({ text, kind }); }

  // ---- Joueurs ----
  addPlayer(name, token) {
    const id = this.seq++;
    const used = new Set([...this.players.values()].map((p) => p.color));
    const color = COLORS.find((c) => !used.has(c)) || COLORS[id % COLORS.length];
    const p = { id, token, name, color, ws: null, online: true };
    this.respawn(p, this.players.size);
    this.players.set(id, p);
    this.emptySince = null;
    this.log(`${name} rejoint l'archipel.`, 'join');
    return p;
  }

  respawn(p, i) {
    const f = this.camp.fire;
    const ang = (i / 6) * Math.PI * 2;
    Object.assign(p, {
      x: f.x + Math.cos(ang) * 1.6, y: f.y + Math.sin(ang) * 1.6 - 0.5, dir: 0,
      hp: 100, faim: 100, soif: 100, downed: false,
      inv: { bois: 0, pierre: 0, fibre: 0, nourriture: 0, eau: 0 },
      tools: { hache: false, pioche: false, torches: 1 }, torchLeft: 0,
      boat: null, lastPos: Date.now(), lastHarvest: 0, lastAct: 0,
    });
  }

  removePlayer(p) {
    this.leaveBoat(p, true);
    this.players.delete(p.id);
    this.log(`${p.name} a quitté la partie.`, 'leave');
    if (this.players.size === 0) this.emptySince = Date.now();
  }

  onlinePlayers() { return [...this.players.values()].filter((p) => p.online); }

  isLit(p) {
    if (this.fire.fuel > 0 && dist(p, this.fire) <= C.FIRE_RADIUS) return true;
    for (const q of this.players.values()) if (q.torchLeft > 0 && dist(p, q) <= C.TORCH_RADIUS) return true;
    return false;
  }

  // ---- Boucle de simulation ----
  tick(dt) {
    if (this.state !== 'playing') return;
    this.time += dt / C.DAY_LEN;
    if (this.time >= 1) {
      this.time -= 1; this.day++;
      this.log(`Le jour ${this.day} se lève.`, 'day');
    }
    const dark = S.darkness(this.time);
    const prevFuel = this.fire.fuel;
    this.fire.fuel = Math.max(0, this.fire.fuel - dt);
    if (prevFuel > 0 && this.fire.fuel === 0) this.log('Le feu de camp s\'est éteint ! Ajoutez du bois.', 'warn');
    if (prevFuel > 45 && this.fire.fuel <= 45 && dark > 0.3) this.log('Le feu faiblit.', 'warn');

    if (this.recup) {
      this.recupTimer += dt;
      if (this.recupTimer >= C.RECUP_PERIOD) { this.recupTimer = 0; this.chest.eau++; }
    }

    for (const n of this.nodes.values()) {
      const def = NODES[n.k];
      if (n.amt >= def.max || !def.regrow) continue;
      n.rg += dt;
      if (n.rg >= def.regrow) { n.rg = 0; n.amt++; this.dirtyNodes.add(n.id); }
    }

    const cold = S.isCold(this.time);
    for (const p of this.players.values()) {
      if (p.downed || !p.online) continue;
      // Torche : s'allume seule la nuit quand on est loin du feu.
      if (p.torchLeft > 0) p.torchLeft = Math.max(0, p.torchLeft - dt);
      else if (dark > 0.6 && p.tools.torches > 0 && !(this.fire.fuel > 0 && dist(p, this.fire) <= C.FIRE_RADIUS)) {
        p.tools.torches--; p.torchLeft = C.TORCH_TIME;
      }
      p.faim = Math.max(0, p.faim - C.FAIM_RATE * dt);
      p.soif = Math.max(0, p.soif - C.SOIF_RATE * dt);
      const freezing = cold && !this.isLit(p);
      p.cold = freezing;
      const dmg = (p.faim <= 0 ? 1 : 0) + (p.soif <= 0 ? 1.3 : 0) + (freezing ? 1.6 : 0);
      if (dmg > 0) p.hp -= dmg * dt;
      else if (p.faim > 40 && p.soif > 40) p.hp = Math.min(100, p.hp + 0.7 * dt);
      if (p.hp <= 0) {
        p.hp = 0; p.downed = true; p.torchLeft = 0;
        const why = freezing ? 'de froid' : p.soif <= 0 ? 'de soif' : 'de faim';
        this.log(`${p.name} s'effondre ${why} ! Relevez-le vite.`, 'danger');
      }
    }
    for (const b of this.boats) for (const id of b.seats) {
      const q = this.players.get(id); if (q) { q.x = b.x; q.y = b.y; }
    }

    const alive = this.onlinePlayers();
    if (alive.length > 0 && alive.every((p) => p.downed)) {
      this.state = 'lost'; this.endedAt = Date.now();
      this.log(`Toute l'équipe a sombré au jour ${this.day}.`, 'danger');
    }
  }

  // ---- Actions des joueurs ----
  handle(p, m) {
    if (!m || typeof m.t !== 'string') return;
    if (m.t === 'restart') { if (this.state !== 'playing') { this.reset(); return 'reinit'; } return; }
    if (m.t === 'ping') {
      if (Number.isFinite(m.x) && Number.isFinite(m.y)) this.events.push({ ping: { x: r2(m.x), y: r2(m.y), c: p.color, n: p.name } });
      return;
    }
    if (m.t === 'dev' && process.env.ARCHIPEL_DEV) { // outils de test, désactivés en production
      if (Number.isFinite(m.time)) this.time = m.time;
      if (m.chest) for (const r of RES) this.chest[r] = m.chest;
      return;
    }
    if (this.state !== 'playing') return;
    if (m.t === 'pos') return this.move(p, m);
    if (p.downed) return;
    const now = Date.now();
    switch (m.t) {
      case 'harvest': return this.harvest(p, m.id, now);
      case 'board': return this.board(p, m.id);
      case 'leave': return this.leaveBoat(p);
      case 'cargo': return this.cargo(p, m.id);
      case 'deposit': return this.deposit(p);
      case 'take': return this.take(p, m.res);
      case 'fuel': return this.fuel(p);
      case 'eat': return this.consume(p, 'nourriture');
      case 'drink': return this.consume(p, 'eau');
      case 'revive': return this.revive(p, m.id);
      case 'craft': return this.craft(p, m.id);
      case 'build': return this.build(p, m.id);
      case 'launch': return this.launch(p);
    }
  }

  reply(p, text) { if (p.ws) p.ws.sendJSON({ t: 'note', text }); }

  move(p, m) {
    if (!Number.isFinite(m.x) || !Number.isFinite(m.y)) return;
    const now = Date.now();
    const dt = Math.min(1, (now - p.lastPos) / 1000);
    p.lastPos = now;
    if (p.downed) return this.correct(p);
    const b = p.boat ? this.boats.find((x) => x.id === p.boat) : null;
    if (b) {
      if (b.seats[0] !== p.id) return; // seul le rameur de tête dirige
      const speed = C.SPEED_BOAT * C.BOAT_CREW_BONUS;
      if (Math.hypot(m.x - b.x, m.y - b.y) > speed * dt * 1.8 + 0.8 || !S.boatable(this.tileAt(m.x, m.y))) return this.correct(p);
      b.x = m.x; b.y = m.y;
      if (Number.isFinite(m.a)) b.a = m.a;
      for (const id of b.seats) { const q = this.players.get(id); if (q) { q.x = b.x; q.y = b.y; } }
      return;
    }
    if (Math.hypot(m.x - p.x, m.y - p.y) > C.SPEED_WALK * dt * 1.8 + 0.8 || !S.walkable(this.tileAt(m.x, m.y))) return this.correct(p);
    p.x = m.x; p.y = m.y;
    if (Number.isFinite(m.d)) p.dir = m.d;
  }

  correct(p) { if (p.ws) p.ws.sendJSON({ t: 'correct', x: p.x, y: p.y }); }

  harvest(p, id, now) {
    const n = this.nodes.get(id);
    if (!n || p.boat) return;
    const def = NODES[n.k];
    if (n.amt <= 0 || dist(p, n) > C.REACH + 0.4) return;
    const dur = def.dur * (def.tool && p.tools[def.tool] ? 0.5 : 1);
    if (now - p.lastHarvest < dur * 1000 * 0.75) return;
    if (S.sacCount(p.inv) >= C.SAC_CAP) return this.reply(p, 'Ton sac est plein. Dépose-le au coffre ou dans une barque (R).');
    p.lastHarvest = now;
    p.inv[def.res]++;
    if (n.k !== 'spring') { n.amt--; n.rg = 0; this.dirtyNodes.add(n.id); }
  }

  board(p, id) {
    const b = this.boats.find((x) => x.id === id);
    if (!b || p.boat || dist(p, b) > C.REACH + 0.4) return;
    if (b.seats.length >= C.BOAT_SEATS) return this.reply(p, 'La barque est pleine.');
    b.seats.push(p.id); p.boat = b.id; p.x = b.x; p.y = b.y;
  }

  leaveBoat(p, force) {
    if (!p.boat) return;
    const b = this.boats.find((x) => x.id === p.boat);
    if (b) {
      let spot = null;
      if (this.tileAt(b.x, b.y) === TILE.SHALLOW) spot = { x: b.x, y: b.y };
      else {
        let best = 1e9;
        for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
          const x = Math.floor(b.x) + dx + 0.5, y = Math.floor(b.y) + dy + 0.5;
          const d = Math.hypot(x - b.x, y - b.y);
          if (d <= 2.6 && S.walkable(this.tileAt(x, y)) && d < best) { best = d; spot = { x, y }; }
        }
      }
      if (!spot && !force) return this.reply(p, 'Trop loin du rivage pour débarquer.');
      b.seats = b.seats.filter((id) => id !== p.id);
      if (spot) { p.x = spot.x; p.y = spot.y; }
    }
    p.boat = null;
    if (p.ws) this.correct(p);
  }

  cargo(p, id) {
    const b = this.boats.find((x) => x.id === id);
    if (!b || dist(p, b) > C.REACH + 0.6) return;
    const inSac = S.sacCount(p.inv);
    if (inSac > 0) {
      let room = C.HOLD_CAP - S.sacCount(b.hold);
      if (room <= 0) return this.reply(p, 'La cale de la barque est pleine.');
      for (const r of RES) {
        const k = Math.min(room, p.inv[r]);
        if (k > 0) { b.hold[r] = (b.hold[r] || 0) + k; p.inv[r] -= k; room -= k; }
      }
    } else {
      let room = C.SAC_CAP;
      for (const r of RES) {
        const k = Math.min(room, b.hold[r] || 0);
        if (k > 0) { p.inv[r] += k; b.hold[r] -= k; room -= k; }
      }
    }
  }

  deposit(p) {
    if (dist(p, this.camp.chest) > C.CAMP_REACH) return;
    let total = 0;
    for (const r of RES) { this.chest[r] += p.inv[r]; total += p.inv[r]; p.inv[r] = 0; }
    // Les barques amarrées près du camp se vident aussi dans le coffre.
    for (const b of this.boats) {
      if (dist(b, this.camp.chest) > 9 && dist(b, this.camp.yard) > 4) continue;
      for (const r of RES) { const k = b.hold[r] || 0; this.chest[r] += k; total += k; b.hold[r] = 0; }
    }
    if (total > 0) this.log(`${p.name} dépose ${total} ressource${total > 1 ? 's' : ''} au coffre.`, 'chest');
  }

  take(p, res) {
    if (!RES.includes(res) || dist(p, this.camp.chest) > C.CAMP_REACH) return;
    if (this.chest[res] <= 0) return;
    if (S.sacCount(p.inv) >= C.SAC_CAP) return this.reply(p, 'Ton sac est plein.');
    const k = Math.min(this.chest[res], C.SAC_CAP - S.sacCount(p.inv), 4);
    this.chest[res] -= k; p.inv[res] += k;
  }

  fuel(p) {
    if (dist(p, this.fire) > C.REACH + 0.8) return;
    const fromChest = p.inv.bois === 0 && dist(p, this.camp.chest) <= C.CAMP_REACH + 1;
    const room = Math.floor((C.FIRE_MAX - this.fire.fuel) / C.FIRE_PER_WOOD);
    if (room <= 0) return this.reply(p, 'Le feu est déjà bien nourri.');
    const src = fromChest ? this.chest : p.inv;
    const k = Math.min(room, src.bois, 5);
    if (k <= 0) return this.reply(p, 'Il te faut du bois pour le feu.');
    src.bois -= k;
    this.fire.fuel += k * C.FIRE_PER_WOOD;
    this.log(`${p.name} ajoute ${k} bois au feu.`, 'fire');
  }

  consume(p, res) {
    const gainKey = res === 'nourriture' ? 'faim' : 'soif';
    if (p[gainKey] >= 96) return;
    let src = null;
    if (p.inv[res] > 0) src = p.inv;
    else if (dist(p, this.camp.chest) <= C.CAMP_REACH && this.chest[res] > 0) src = this.chest;
    else if (res === 'eau') {
      const spring = [...this.nodes.values()].find((n) => n.k === 'spring' && dist(p, n) <= C.REACH + 0.4);
      if (spring) { p.soif = Math.min(100, p.soif + C.DRINK_GAIN); return; }
    }
    if (!src) return this.reply(p, res === 'eau' ? "Tu n'as pas d'eau. Puise-en à une source ou bois au coffre." : "Tu n'as rien à manger. Cueille des fruits ou mange au coffre.");
    src[res]--;
    p[gainKey] = Math.min(100, p[gainKey] + (res === 'eau' ? C.DRINK_GAIN : C.EAT_GAIN));
  }

  revive(p, id) {
    const q = this.players.get(id);
    if (!q || !q.downed || q === p || dist(p, q) > C.REACH + 0.6) return;
    q.downed = false; q.hp = 35; q.faim = Math.max(q.faim, 30); q.soif = Math.max(q.soif, 30);
    this.log(`${p.name} relève ${q.name}.`, 'revive');
  }

  nearCamp(p) { return dist(p, this.camp.bench) <= C.CAMP_REACH + 0.5 || dist(p, this.camp.chest) <= C.CAMP_REACH; }

  pay(cost) { for (const k in cost) this.chest[k] -= cost[k]; }

  craft(p, id) {
    const R = RECIPES[id];
    if (!R || !this.nearCamp(p)) return;
    if (R.once && this.recup) return;
    if (id === 'hache' && p.tools.hache) return this.reply(p, 'Tu as déjà une hache.');
    if (id === 'pioche' && p.tools.pioche) return this.reply(p, 'Tu as déjà une pioche.');
    if (id === 'barque' && this.boats.length >= C.MAX_BOATS) return this.reply(p, 'Le ponton ne peut pas accueillir plus de barques.');
    if (!S.canAfford(this.chest, R.cost)) return this.reply(p, 'Pas assez de ressources dans le coffre.');
    this.pay(R.cost);
    if (id === 'hache') p.tools.hache = true;
    else if (id === 'pioche') p.tools.pioche = true;
    else if (id === 'torche') p.tools.torches++;
    else if (id === 'barque') this.addBoat();
    else if (id === 'recuperateur') this.recup = true;
    this.log(`${p.name} fabrique : ${R.label}.`, 'craft');
  }

  build(p, id) {
    const idx = PARTS.findIndex((x) => x.id === id);
    if (idx < 0 || this.parts[id] || !this.nearYard(p)) return;
    if (idx > 0 && !this.parts[PARTS[idx - 1].id]) return this.reply(p, `Construisez d'abord : ${PARTS[idx - 1].label}.`);
    if (!S.canAfford(this.chest, PARTS[idx].cost)) return this.reply(p, 'Pas assez de ressources dans le coffre.');
    this.pay(PARTS[idx].cost);
    this.parts[id] = true;
    this.log(`Le navire avance : ${PARTS[idx].label} terminée par ${p.name} !`, 'ship');
  }

  nearYard(p) { return dist(p, this.camp.yard) <= C.CAMP_REACH + 1.5 || this.nearCamp(p); }

  launch(p) {
    if (!PARTS.every((x) => this.parts[x.id])) return;
    const away = this.onlinePlayers().filter((q) => !q.downed && dist(q, this.camp.yard) > C.LAUNCH_RADIUS);
    if (away.length) return this.reply(p, `Attendez tout le monde au chantier : ${away.map((q) => q.name).join(', ')}.`);
    const downed = this.onlinePlayers().filter((q) => q.downed);
    if (downed.length) return this.reply(p, `Relevez d'abord : ${downed.map((q) => q.name).join(', ')}.`);
    this.state = 'won'; this.endedAt = Date.now();
    this.log(`Le navire prend la mer au jour ${this.day} ! Vous avez quitté l'archipel.`, 'ship');
  }

  // ---- Messages réseau ----
  initPayload(p) {
    const w = this.world;
    return {
      t: 'init', you: p.id, token: p.token, code: this.code,
      W: w.W, H: w.H, tiles: Buffer.from(w.tiles).toString('base64'),
      islands: w.islands, camp: this.camp,
      nodes: [...this.nodes.values()].map((n) => [n.id, n.k, n.x, n.y, n.amt]),
      snap: { ...this.snapshot(true), ev: [] },
    };
  }

  snapshot(full) {
    const nodes = full ? [] : [...this.dirtyNodes].map((id) => [id, this.nodes.get(id).amt]);
    return {
      t: 's', time: r2(this.time * 1000) / 1000, day: this.day, st: this.state,
      fire: Math.round(this.fire.fuel), chest: this.chest, parts: this.parts, recup: this.recup,
      players: [...this.players.values()].filter((p) => p.online).map((p) => ({
        id: p.id, n: p.name, c: p.color, x: r2(p.x), y: r2(p.y), d: r2(p.dir || 0),
        hp: Math.round(p.hp), f: Math.round(p.faim), s: Math.round(p.soif),
        dn: p.downed, b: p.boat, tl: p.torchLeft > 0, cold: !!p.cold,
        inv: p.inv, tools: p.tools,
      })),
      boats: this.boats.map((b) => ({ id: b.id, x: r2(b.x), y: r2(b.y), a: r2(b.a), seats: b.seats, hold: b.hold })),
      nodes,
      ev: this.events,
    };
  }

  flush() { this.events = []; this.dirtyNodes.clear(); }
}

module.exports = { Game };
