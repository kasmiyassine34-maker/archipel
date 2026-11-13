// Une partie : l'état de l'archipel et les règles, simulés côté serveur.
const S = require('../public/shared.js');
const { createWorld } = require('./world');
const { C, NODES, RECIPES, PARTS, RES, TILE, WEAPONS, ROLES, BEASTS, FRAGMENTS, BOATS } = S;

// Lavis d'aquarelle pour distinguer les joueurs : vermillon, bleu de Prusse, ocre, vert de vessie, violet, garance.
const COLORS = ['#c0543a', '#3f6f93', '#c99a3e', '#6f8f45', '#7d5f9a', '#b8687e'];
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const r2 = (v) => Math.round(v * 100) / 100;
const emptyInv = () => Object.fromEntries(RES.map((r) => [r, 0]));
const ST = { idle: 0, chase: 1, wind: 2, act: 3, stun: 4, flee: 5, sleep: 6 };

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
    const w = this.world;
    this.nodes = new Map();
    for (const n of w.nodes) { n.amt = NODES[n.k].max; this.nodes.set(n.id, n); }
    this.camp = w.camp;
    this.time = 0.08;
    this.day = 1;
    this.clock = 0; // secondes de jeu écoulées
    this.fire = { ...this.camp.fire, fuel: 120 };
    this.chest = { ...emptyInv(), bois: 6, nourriture: 8, eau: 8 };
    this.parts = {};
    this.recup = false; this.recupTimer = 0;
    this.boats = [];
    this.boatSeq = 1;
    this.grande = false;
    this.addBoat('barque');
    this.state = 'playing';
    this.ending = null;
    this.endedAt = null;
    this.events = [];
    this.dirtyNodes = new Set();

    // La carte se dessine à mesure qu'on explore : tuiles aperçues, récifs repérés, îles cartographiées.
    this.seen = new Uint8Array(w.W * w.H);
    this.newSeen = [];
    this.reefs = [];
    for (let i = 0; i < w.tiles.length; i++) if (w.tiles[i] === TILE.REEF) this.reefs.push({ i, x: (i % w.W) + 0.5, y: Math.floor(i / w.W) + 0.5 });
    this.spotted = new Set();
    this.newReefs = [];
    this.landCount = new Array(w.islands.length).fill(0);
    this.seenLand = new Array(w.islands.length).fill(0);
    for (let i = 0; i < w.tiles.length; i++) if (w.owner[i] >= 0) this.landCount[w.owner[i]]++;
    this.discovered = new Set();
    this.revealT = 0;
    const home = w.islands[0];
    this.reveal(home.x, home.y, home.r * 1.35 + 4, true);
    this.discovered.add(0);

    // Le mystère.
    this.frags = new Set();
    this.sites = new Map();
    for (const s of w.sites) this.sites.set(s.id, { ...s, done: false, prog: 0, open: false, workers: new Map(), levers: s.levers ? s.levers.map((l) => ({ ...l, at: 0, by: 0 })) : null });
    this.lantern = [...this.sites.values()].find((s) => s.k === 'phare');
    this.gardienDead = false;
    this.votes = new Map();
    this.fogNoteAt = 0;

    // Les bêtes.
    this.beasts = new Map();
    this.beastSeq = 1;
    for (const sp of w.spawns) this.spawnBeast(sp.k, sp.x, sp.y, sp.island);
    this.paleT = 20;
    this.projectiles = [];
    this.projSeq = 1;

    // Le temps qu'il fait : une tempête s'annonce environ une minute avant d'éclater.
    this.weather = { st: 'calme', t: 0, next: 470, wx: 0, wy: 0 };

    this.startedAt = Date.now();
    let i = 0;
    for (const p of this.players.values()) { const role = p.role; this.respawn(p, i++); p.role = role; }
  }

  addBoat(kind) {
    const d = this.camp.dock;
    const off = this.boats.length;
    const B = BOATS[kind];
    const b = {
      id: this.boatSeq++, kind,
      x: d.x - Math.sin(d.angle) * off * 1.4, y: d.y + Math.cos(d.angle) * off * 1.4,
      a: d.angle, seats: [], hold: {}, hull: B.hull, reefAt: 0, warnAt: 0,
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
  ownerAt(x, y) {
    const { W, H, owner } = this.world;
    const tx = Math.floor(x), ty = Math.floor(y);
    if (tx < 0 || ty < 0 || tx >= W || ty >= H) return -1;
    return owner[tx + ty * W];
  }
  currentAt(x, y) {
    const { W, H, currents } = this.world;
    const tx = Math.floor(x), ty = Math.floor(y);
    if (tx < 0 || ty < 0 || tx >= W || ty >= H) return [0, 0];
    const i = (tx + ty * W) * 2;
    return [currents[i] / 10, currents[i + 1] / 10];
  }

  log(text, kind = 'info') { this.events.push({ text, kind }); }
  fx(o) { this.events.push({ fx: o }); }

  // ---- Joueurs ----
  addPlayer(name, token) {
    const id = this.seq++;
    const used = new Set([...this.players.values()].map((p) => p.color));
    const color = COLORS.find((c) => !used.has(c)) || COLORS[id % COLORS.length];
    const p = { id, token, name, color, ws: null, online: true, role: null };
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
      inv: emptyInv(),
      tools: { hache: false, pioche: false, lance: false, fronde: false, torches: 1, bandages: 1 }, torchLeft: 0,
      weapon: 'mains', atkAt: 0, atkN: 0, atkA: 0, dodgeAt: 0, dodgeN: 0, invulnUntil: 0, healAt: 0,
      boat: null, lastPos: Date.now(), lastHarvest: 0, lastAct: 0,
    });
  }

  removePlayer(p) {
    this.leaveBoat(p, true);
    this.players.delete(p.id);
    this.votes.delete(p.id);
    this.log(`${p.name} a quitté la partie.`, 'leave');
    if (this.players.size === 0) this.emptySince = Date.now();
  }

  onlinePlayers() { return [...this.players.values()].filter((p) => p.online); }

  lightSources() {
    const out = [];
    if (this.fire.fuel > 0) out.push({ x: this.fire.x, y: this.fire.y, r: C.FIRE_RADIUS });
    for (const q of this.players.values()) if (q.online && q.torchLeft > 0) out.push({ x: q.x, y: q.y, r: C.TORCH_RADIUS });
    return out;
  }
  isLit(p) { return this.lightSources().some((l) => dist(p, l) <= l.r); }

  // ---- Brouillard ----
  reveal(cx, cy, r, force) {
    const { W, H, owner, islands } = this.world;
    const ph = this.world.phare;
    const locked = !force && this.frags && this.frags.size < C.FRAG_NEED;
    for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(H - 1, Math.floor(cy + r)); y++) {
      for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(W - 1, Math.floor(cx + r)); x++) {
        const i = x + y * W;
        if (this.seen[i]) continue;
        if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) > r) continue;
        if (locked && Math.hypot(x + 0.5 - ph.x, y + 0.5 - ph.y) < ph.zone) continue;
        this.seen[i] = 1;
        this.newSeen.push(i);
        const o = owner[i];
        if (o >= 0) {
          this.seenLand[o]++;
          if (!this.discovered.has(o) && this.seenLand[o] >= this.landCount[o] * 0.2) this.discover(o);
        }
      }
    }
    void islands;
  }

  discover(idx) {
    if (this.discovered.has(idx)) return;
    this.discovered.add(idx);
    const I = this.world.islands[idx];
    if (I.id === 'phare') this.log('Le Phare noir sort de la brume. Sa flamme ne chauffe pas.', 'mystery');
    else this.log(`Île cartographiée : ${I.name}.`, 'island');
    this.fx({ k: 'island', i: idx });
  }

  explore() {
    for (const p of this.players.values()) {
      if (!p.online) continue;
      const carto = p.role === 'cartographe';
      let r = (p.boat ? C.VIEW_SEA : C.VIEW) + (carto ? C.VIEW_CARTO : 0);
      if (S.darkness(this.time) > 0.6 && !this.isLit(p)) r -= 1.5;
      if (this.weather.st === 'tempete') r -= 1;
      if (p.downed) r = 2;
      this.reveal(p.x, p.y, Math.max(3, r));
      const o = this.ownerAt(p.x, p.y);
      if (o >= 0 && !this.discovered.has(o)) this.discover(o);
      const rr = carto ? C.REEF_SPOT_CARTO : C.REEF_SPOT;
      for (const f of this.reefs) {
        if (this.spotted.has(f.i)) continue;
        if (Math.abs(f.x - p.x) <= rr && Math.abs(f.y - p.y) <= rr && dist(f, p) <= rr) { this.spotted.add(f.i); this.newReefs.push(f.i); }
      }
    }
  }
  spotReefsAround(x, y, r) {
    for (const f of this.reefs) if (!this.spotted.has(f.i) && dist(f, { x, y }) <= r) { this.spotted.add(f.i); this.newReefs.push(f.i); }
  }

  // ---- Boucle de simulation ----
  tick(dt) {
    if (this.state !== 'playing') return;
    const now = Date.now();
    this.clock += dt;
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
      this.recupTimer += dt * (this.weather.st === 'tempete' ? 4 : 1);
      if (this.recupTimer >= C.RECUP_PERIOD) { this.recupTimer = 0; this.chest.eau++; }
    }

    for (const n of this.nodes.values()) {
      const def = NODES[n.k];
      if (n.amt >= def.max || !def.regrow) continue;
      n.rg += dt;
      if (n.rg >= def.regrow) { n.rg = 0; n.amt++; this.dirtyNodes.add(n.id); }
    }

    this.tickWeather(dt);

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
        const why = freezing ? 'de froid' : p.soif <= 0 ? 'de soif' : 'de faim';
        this.down(p, `${p.name} s'effondre ${why} ! Relevez-le vite.`);
      }
    }
    for (const b of this.boats) for (const id of b.seats) {
      const q = this.players.get(id); if (q) { q.x = b.x; q.y = b.y; }
    }

    this.revealT += dt;
    if (this.revealT >= 0.2) { this.revealT = 0; this.explore(); }

    this.tickSites(dt, now);
    this.tickBeasts(dt, now, dark);
    this.tickProjectiles(dt);
    if (this.state !== 'playing') return;

    const alive = this.onlinePlayers();
    if (alive.length > 0 && alive.every((p) => p.downed)) {
      this.state = 'lost'; this.endedAt = Date.now();
      this.log(`Toute l'équipe a sombré au jour ${this.day}.`, 'danger');
    }
  }

  down(p, text) {
    p.hp = 0; p.downed = true; p.torchLeft = 0;
    this.log(text, 'danger');
  }

  tickWeather(dt) {
    const w = this.weather;
    if (w.st === 'calme') {
      w.next -= dt;
      if (w.next <= 55) {
        w.st = 'annonce'; w.t = 55;
        const a = Math.random() * Math.PI * 2;
        w.wx = Math.cos(a); w.wy = Math.sin(a);
        this.log('Le baromètre chute. Une tempête approche : mettez les barques à l\'abri !', 'warn');
      }
    } else if (w.st === 'annonce') {
      w.t -= dt;
      if (w.t <= 0) { w.st = 'tempete'; w.t = 70 + Math.random() * 30; this.log('La tempête éclate ! La haute mer devient dangereuse.', 'danger'); }
    } else {
      w.t -= dt;
      for (const b of this.boats) {
        if (!b.seats.length || this.tileAt(b.x, b.y) !== TILE.DEEP) continue;
        b.hull -= BOATS[b.kind].storm * dt;
        if (b.hull < 30 && Date.now() - b.warnAt > 8000) { b.warnAt = Date.now(); this.log('Les vagues disloquent la barque ! Rejoignez une côte.', 'danger'); }
        if (b.hull <= 0) this.sink(b, 'Une lame de fond');
      }
      if (w.t <= 0) { w.st = 'calme'; w.next = 320 + Math.random() * 200; this.log('La tempête s\'éloigne.', 'info'); }
    }
  }
  wind() {
    const w = this.weather;
    const k = w.st === 'tempete' ? 1.3 : w.st === 'annonce' ? 0.35 : 0;
    return [w.wx * k, w.wy * k];
  }

  // ---- Fragments et sites ----
  tickSites(dt, now) {
    const online = this.onlinePlayers().filter((p) => !p.downed);
    const solo = online.length <= 1;
    for (const s of this.sites.values()) {
      if (s.done) continue;
      const active = [];
      for (const [pid, t] of s.workers) {
        const p = this.players.get(pid);
        if (!p || now - t > 450 || p.downed || p.boat || dist(p, s) > C.REACH + 0.8) { s.workers.delete(pid); continue; }
        active.push(p);
      }
      if (s.k === 'ruine' && !s.open) {
        // Deux leviers à tenir en même temps (seul, un levier reste baissé quelques secondes).
        const win = solo ? 8000 : 500;
        if (s.levers.every((l) => now - l.at < win) && (solo || s.levers[0].by !== s.levers[1].by)) {
          s.open = true;
          this.log('La porte de la ruine s\'ouvre dans un grondement de pierre.', 'mystery');
        }
        continue;
      }
      if (s.k === 'phare') {
        if (active.length) {
          s.prog += dt / C.DOUSE_TIME;
          if (s.prog >= 1) this.finish('verite');
        }
        continue;
      }
      if (s.k === 'stele') {
        const need = solo ? 1 : 2;
        if (active.length >= need) s.prog += dt / C.LIFT_TIME;
        else s.prog = Math.max(0, s.prog - dt * 0.25);
      } else if (active.length) {
        const fast = active.some((p) => p.role === 'cartographe');
        s.prog += dt / (C.READ_TIME * (fast ? 0.5 : 1));
      }
      if (s.prog >= 1) this.findFragment(s, active[0]);
    }
  }

  findFragment(s, p) {
    s.done = true; s.prog = 1;
    const F = FRAGMENTS.find((f) => f.n === s.frag);
    this.frags.add(F.n);
    this.log(`${p ? p.name : 'L\'équipe'} découvre un fragment : « ${F.title} ».`, 'mystery');
    this.fx({ k: 'frag', n: F.n });
    if (this.frags.size === C.FRAG_NEED) {
      this.log('Les fragments concordent : un cap se dessine à travers le banc de brume.', 'mystery');
      // La brume s'ouvre : on voit enfin ce qu'elle cachait aux abords.
      for (const q of this.players.values()) if (q.online) this.reveal(q.x, q.y, 6);
    }
    if (this.frags.size === C.FRAGS) this.log('Le carnet est complet. Vous connaissez toute l\'histoire du Phare noir.', 'mystery');
  }

  work(p, m) {
    const s = this.sites.get(m.id);
    if (!s || s.done || p.boat) return;
    const now = Date.now();
    if (s.k === 'ruine' && !s.open) {
      const l = s.levers[m.l | 0];
      if (!l || dist(p, l) > C.REACH + 0.8) return;
      l.at = now; l.by = p.id;
      return;
    }
    if (dist(p, s) > C.REACH + 0.8) return;
    if (s.k === 'phare' && this.frags.size < C.FRAG_NEED) return;
    s.workers.set(p.id, now);
  }

  // Au sommet du phare, avec tout le carnet et le gardien vaincu : l'équipe vote pour sa fin.
  ritual(p) {
    const s = this.lantern;
    if (!s || dist(p, s) > C.REACH + 0.8 || this.frags.size < C.FRAGS || !this.gardienDead) return;
    const need = { bois: 6, pierre: 3, eau: 3 };
    const near = this.onlinePlayers().filter((q) => !q.downed && dist(q, s) < 7);
    const pool = emptyInv();
    for (const q of near) for (const r of RES) pool[r] += q.inv[r];
    if (!S.canAfford(pool, need)) return this.reply(p, 'Le rituel demande 6 bois, 3 pierres et 3 eau, portés dans vos sacs jusqu\'au sommet.');
    for (const r in need) {
      let k = need[r];
      for (const q of near) { const t = Math.min(k, q.inv[r]); q.inv[r] -= t; k -= t; }
    }
    this.state = 'choice';
    this.votes.clear();
    this.log('La flamme noire vacille. Toute l\'équipe doit choisir.', 'mystery');
  }

  vote(p, v) {
    if (this.state !== 'choice' || !['verite', 'partir', 'rester'].includes(v)) return;
    this.votes.set(p.id, v);
    const online = this.onlinePlayers();
    if (online.every((q) => this.votes.has(q.id))) {
      const tally = { verite: 0, partir: 0, rester: 0 };
      for (const q of online) tally[this.votes.get(q.id)]++;
      const best = ['partir', 'rester', 'verite'].sort((a, b) => tally[b] - tally[a])[0];
      this.state = 'playing';
      this.finish(best === 'verite' ? 'verite' : best === 'partir' ? 'veilleurs_partir' : 'veilleurs_rester');
    }
  }

  finish(ending) {
    if (this.state !== 'playing') return;
    this.state = 'won'; this.ending = ending; this.endedAt = Date.now();
    const txt = {
      fuite: `Le navire prend la mer au jour ${this.day}. Derrière vous, la flamme noire continue de briller.`,
      verite: 'La flamme noire s\'éteint. La brume se lève, et une voile apparaît à l\'horizon.',
      veilleurs_partir: 'Une flamme blanche s\'élève du Phare. Elle guidera les marins, et vous ramènera chez vous.',
      veilleurs_rester: 'Une flamme blanche s\'élève du Phare. Vous serez ses nouveaux Veilleurs.',
    }[ending];
    this.log(txt, 'ship');
  }

  // ---- Bêtes ----
  spawnBeast(k, x, y, island, extra) {
    const def = BEASTS[k];
    const b = { id: this.beastSeq++, k, x, y, hx: x, hy: y, island, a: Math.random() * 6.28, hp: def.hp, mhp: def.hp,
      st: k === 'gardien' ? ST.sleep : ST.idle, t: 0, cd: 1, target: null, wx: x, wy: y, wt: 0, tx: x, ty: y, pat: 0, hit: null, dead: false, deadAt: 0, ...extra };
    this.beasts.set(b.id, b);
    return b;
  }

  beastCanWalk(b, x, y) {
    const t = this.tileAt(x, y);
    // Les bêtes craignent le feu de camp : elles n'approchent pas du camp tant qu'il brûle.
    if (b.k !== 'gardien' && this.fire.fuel > 0 && Math.hypot(x - this.fire.x, y - this.fire.y) < C.FIRE_RADIUS - 1.5) return false;
    if (b.k === 'crabe') return t === TILE.SAND || t === TILE.SHALLOW || t === TILE.GRASS;
    if (b.k === 'varan') return t === TILE.SAND || t === TILE.GRASS || t === TILE.ROCK;
    if (b.k === 'gardien') return S.walkable(t) && (this.ownerAt(x, y) === b.island || t === TILE.SHALLOW) && dist({ x, y }, this.world.phare) < this.world.phare.r * 1.6;
    return S.walkable(t);
  }

  stepBeast(b, ax, ay, speed, dt) {
    const l = Math.hypot(ax, ay); if (!l) return false;
    const vx = (ax / l) * speed * dt, vy = (ay / l) * speed * dt;
    let moved = false;
    if (this.beastCanWalk(b, b.x + vx, b.y)) { b.x += vx; moved = true; }
    if (this.beastCanWalk(b, b.x, b.y + vy)) { b.y += vy; moved = true; }
    this.turnBeast(b, Math.atan2(ay, ax), dt);
    return moved;
  }

  // Le crabe et le Gardien pivotent lentement : on peut les contourner pour frapper leur dos.
  turnBeast(b, want, dt) {
    const rate = b.k === 'crabe' ? 2.4 : b.k === 'gardien' ? 1.5 : 99;
    const d = S.angleDiff(want, b.a);
    b.a += Math.max(-rate * dt, Math.min(rate * dt, d));
  }

  validTarget(p) { return p && p.online && !p.downed && !p.boat; }

  tickBeasts(dt, now, dark) {
    const players = this.onlinePlayers().filter((p) => this.validTarget(p));
    const lights = this.lightSources();
    // Les Pâles sortent la nuit, à partir de la deuxième nuit, loin du feu.
    if (this.day >= 2 && dark > 0.7) {
      this.paleT -= dt;
      if (this.paleT <= 0) {
        this.paleT = 26;
        const wild = [...this.beasts.values()].filter((b) => b.k === 'pale' && !b.summoned && !b.dead).length;
        const cands = players.filter((p) => dist(p, this.fire) > C.FIRE_RADIUS + 3 && this.ownerAt(p.x, p.y) >= 0);
        if (wild < 2 + players.length * 2 && cands.length) {
          const p = cands[Math.floor(Math.random() * cands.length)];
          this.spawnPales(p, 2 + (Math.random() < 0.4 ? 1 : 0), false);
        }
      }
    } else if (dark < 0.3) {
      for (const b of this.beasts.values()) if (b.k === 'pale' && !b.summoned && !b.dead) { this.beasts.delete(b.id); this.fx({ k: 'fade', x: r2(b.x), y: r2(b.y) }); }
      this.paleT = 20;
    }

    for (const b of [...this.beasts.values()]) {
      const def = BEASTS[b.k];
      if (b.dead) {
        // Les crabes et les varans reviennent, loin des regards.
        if (b.k !== 'gardien' && now - b.deadAt > 150000 && !players.some((p) => Math.hypot(p.x - b.hx, p.y - b.hy) < 14)) {
          b.dead = false; b.hp = b.mhp; b.x = b.hx; b.y = b.hy; b.st = ST.idle; b.target = null;
        }
        continue;
      }
      b.cd -= dt;
      if (b.k === 'pale') {
        const L = lights.find((l) => dist(b, l) < l.r);
        if (L) {
          b.hp -= 9 * dt;
          if (b.hp <= 0) { this.killBeast(b, null); continue; }
          if (b.st !== ST.wind) { b.st = ST.flee; this.stepBeast(b, b.x - L.x, b.y - L.y, def.speed * 1.1, dt); continue; }
        } else if (b.st === ST.flee) b.st = ST.chase;
      }
      if (b.k === 'gardien') { if (this.tickGardien(b, dt, now, players)) continue; }

      if (b.st === ST.stun) { b.t -= dt; if (b.t <= 0) { b.st = ST.chase; b.cd = 0.6; } continue; }
      if (b.st === ST.wind) {
        b.t -= dt;
        const tg = this.players.get(b.target);
        if (b.k === 'pale' && this.validTarget(tg)) b.a = Math.atan2(tg.y - b.y, tg.x - b.x);
        if (b.t <= 0) this.perform(b, now);
        continue;
      }
      if (b.st === ST.act) { // charge du varan
        b.t -= dt;
        const stepN = 3;
        for (let k = 0; k < stepN; k++) {
          const nx = b.x + Math.cos(b.a) * def.charge * dt / stepN, ny = b.y + Math.sin(b.a) * def.charge * dt / stepN;
          if (!this.beastCanWalk(b, nx, ny)) { b.t = 0; break; }
          b.x = nx; b.y = ny;
          for (const p of players) if (!b.hit.has(p.id) && dist(p, b) < def.r + 0.55) { b.hit.add(p.id); this.hurt(p, def.dmg, b); }
        }
        if (b.t <= 0) { b.st = ST.stun; b.t = def.stun; }
        continue;
      }

      // Repérage.
      let tg = this.players.get(b.target);
      if (!this.validTarget(tg) || dist(tg, b) > def.aggro * 1.8 || Math.hypot(b.x - b.hx, b.y - b.hy) > 16) { tg = null; b.target = null; }
      if (!tg) {
        let bd = def.aggro;
        for (const p of players) {
          if (b.k === 'pale' && lights.some((l) => dist(p, l) < l.r - 0.5)) continue;
          const d = dist(p, b); if (d < bd) { bd = d; tg = p; }
        }
        if (tg) { b.target = tg.id; b.st = ST.chase; }
      }
      if (!tg) {
        b.st = ST.idle;
        b.wt -= dt;
        const home = Math.hypot(b.x - b.hx, b.y - b.hy);
        if (b.wt <= 0) {
          b.wt = 2 + Math.random() * 3;
          const a = Math.random() * 6.28, r = Math.random() * (home > 6 ? 1 : 4);
          b.wx = (home > 6 ? b.hx : b.x) + Math.cos(a) * r; b.wy = (home > 6 ? b.hy : b.y) + Math.sin(a) * r;
        }
        if (Math.hypot(b.wx - b.x, b.wy - b.y) > 0.3) this.stepBeast(b, b.wx - b.x, b.wy - b.y, def.speed * 0.45, dt);
        continue;
      }
      const d = dist(tg, b);
      const inRange = b.k === 'varan' ? d < 5.2 && d > 1.2 : d < def.reach + 0.15;
      const facing = Math.abs(S.angleDiff(Math.atan2(tg.y - b.y, tg.x - b.x), b.a)) < 0.6;
      if (inRange && b.cd <= 0 && (facing || (b.k !== 'crabe' && b.k !== 'gardien'))) {
        b.st = ST.wind; b.t = def.wind;
        if (b.k !== 'crabe' && b.k !== 'gardien') b.a = Math.atan2(tg.y - b.y, tg.x - b.x);
        b.tx = tg.x; b.ty = tg.y;
        continue;
      }
      if (b.k === 'varan' && d <= 1.2) { this.stepBeast(b, b.x - tg.x, b.y - tg.y, def.speed * 0.6, dt); continue; }
      if (d > def.reach * 0.8) this.stepBeast(b, tg.x - b.x, tg.y - b.y, def.speed, dt);
      else this.turnBeast(b, Math.atan2(tg.y - b.y, tg.x - b.x), dt);
    }
  }

  tickGardien(b, dt, now, players) {
    const ph = this.world.phare;
    const near = players.filter((p) => dist(p, ph) < ph.r * 1.6 + 1);
    if (b.st === ST.sleep) {
      if (near.some((p) => dist(p, b) < BEASTS.gardien.aggro)) {
        b.mhp = BEASTS.gardien.hp + 140 * Math.max(0, this.onlinePlayers().length - 1);
        b.hp = b.mhp; b.st = ST.chase; b.cd = 1.5; b.summonT = 18; b.awake = true;
        this.log('Le Gardien noir se lève. Sa face est une armure : frappez-le de dos !', 'danger');
      }
      return true;
    }
    if (!near.length) {
      b.calm = (b.calm || 0) + dt;
      if (b.calm > 10) { b.st = ST.sleep; b.x = b.hx; b.y = b.hy; b.hp = b.mhp; b.calm = 0; b.target = null; }
      return true;
    }
    b.calm = 0;
    // Il cible le plus proche : celui qui l'occupe de face laisse les autres frapper son dos.
    let tg = null, bd = 1e9;
    for (const p of near) { const d = dist(p, b); if (d < bd) { bd = d; tg = p; } }
    if (b.st !== ST.wind) b.target = tg.id;
    if (b.hp < b.mhp * 0.6) {
      b.summonT -= dt;
      if (b.summonT <= 0) { b.summonT = 22; this.spawnPales(b, 2, true); this.log('Le Gardien appelle la brume. Des Pâles se lèvent !', 'danger'); }
    }
    return false;
  }

  spawnPales(around, n, summoned) {
    for (let k = 0; k < n; k++) {
      for (let tries = 0; tries < 40; tries++) {
        const a = Math.random() * 6.28, r = summoned ? 2.5 + Math.random() * 2 : 10 + Math.random() * 5;
        const x = around.x + Math.cos(a) * r, y = around.y + Math.sin(a) * r;
        const t = this.tileAt(x, y);
        if (!S.walkable(t) || t === TILE.SHALLOW) continue;
        if (!summoned && this.ownerAt(x, y) !== this.ownerAt(around.x, around.y)) continue;
        if (!summoned && this.lightSources().some((l) => dist({ x, y }, l) < l.r + 1)) continue;
        this.spawnBeast('pale', x, y, this.ownerAt(x, y), { summoned, cd: 1.2 });
        this.fx({ k: 'rise', x: r2(x), y: r2(y) });
        break;
      }
    }
  }

  perform(b, now) {
    const def = BEASTS[b.k];
    b.cd = def.cd;
    const players = this.onlinePlayers().filter((p) => this.validTarget(p));
    if (b.k === 'varan') { b.st = ST.act; b.t = def.chargeT; b.hit = new Set(); return; }
    b.st = ST.chase;
    if (b.k === 'gardien') {
      const enraged = b.hp < b.mhp * 0.3;
      b.cd = def.cd * (enraged ? 0.6 : 1);
      if (b.pat % 2 === 0) { // coup de masse : un cercle au sol, annoncé
        for (const p of players) if (Math.hypot(p.x - b.tx, p.y - b.ty) < 2.3) this.hurt(p, def.dmg, b);
        this.fx({ k: 'slam', x: r2(b.tx), y: r2(b.ty) });
      } else { // balayage en arc devant lui
        for (const p of players) {
          const d = dist(p, b);
          if (d < 3.3 && Math.abs(S.angleDiff(Math.atan2(p.y - b.y, p.x - b.x), b.a)) < 1.3) this.hurt(p, 20, b);
        }
      }
      b.pat++;
      return;
    }
    for (const p of players) {
      const d = dist(p, b);
      if (d < def.reach + 0.45 && Math.abs(S.angleDiff(Math.atan2(p.y - b.y, p.x - b.x), b.a)) < 1.25) this.hurt(p, def.dmg, b);
    }
  }

  hurt(p, dmg, b) {
    if (!this.validTarget(p)) return;
    if (Date.now() < p.invulnUntil) { this.fx({ k: 'dodge', x: r2(p.x), y: r2(p.y) }); return; }
    p.hp -= dmg;
    this.fx({ k: 'hurt', id: p.id, x: r2(p.x), y: r2(p.y) });
    if (p.hp <= 0) this.down(p, `${p.name} est terrassé par ${b.k === 'gardien' ? 'le Gardien' : b.k === 'pale' ? 'un Pâle' : b.k === 'varan' ? 'un varan' : 'un crabe'} ! Relevez-le vite.`);
  }

  // Coup porté à une bête. from = point d'où vient le coup (pour la carapace).
  strike(p, b, base, from) {
    if (b.dead || b.st === ST.sleep) return;
    const def = BEASTS[b.k];
    let mult = p && p.role === 'chasseur' ? 1.5 : 1;
    let kind = 'n';
    if (def.armor && Math.abs(S.angleDiff(Math.atan2(from.y - b.y, from.x - b.x), b.a)) < 1.2 && b.st !== ST.stun) { mult *= def.armor; kind = 'armor'; }
    if (b.st === ST.stun) { mult *= 1.6; kind = 'crit'; }
    b.hp -= base * mult;
    this.fx({ k: 'hit', x: r2(b.x), y: r2(b.y), h: kind });
    if (!b.target && p && b.k !== 'gardien') { b.target = p.id; if (b.st === ST.idle) b.st = ST.chase; }
    if (b.hp <= 0) this.killBeast(b, p);
  }

  killBeast(b, p) {
    b.dead = true; b.deadAt = Date.now(); b.hp = 0;
    this.fx({ k: 'die', x: r2(b.x), y: r2(b.y), b: b.k });
    if (b.k === 'pale') { this.beasts.delete(b.id); return; }
    if (b.k === 'gardien') {
      this.gardienDead = true;
      for (const q of this.beasts.values()) if (q.summoned) this.beasts.delete(q.id);
      this.log(p ? `${p.name} abat le Gardien noir. La tour est silencieuse.` : 'Le Gardien noir s\'effondre.', 'mystery');
      return;
    }
    const def = BEASTS[b.k];
    if (p && def.meat) {
      const meat = def.meat * (p.role === 'chasseur' ? 2 : 1);
      const room = C.SAC_CAP - S.sacCount(p.inv);
      const k = Math.min(meat, room);
      p.inv.viande += k;
      this.log(`${p.name} abat ${b.k === 'varan' ? 'un varan' : 'un crabe'}${k ? ` : ${k} viande` : ''}${k < meat ? ' (sac plein)' : ''}.`, 'hunt');
    }
  }

  tickProjectiles(dt) {
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const s = this.projectiles[i];
      let hit = false;
      for (let k = 0; k < 3 && !hit; k++) {
        s.x += s.vx * dt / 3; s.y += s.vy * dt / 3; s.left -= Math.hypot(s.vx, s.vy) * dt / 3;
        for (const b of this.beasts.values()) {
          if (b.dead || b.st === ST.sleep) continue;
          if (dist(s, b) < BEASTS[b.k].r + 0.3) { this.strike(this.players.get(s.owner), b, s.dmg, { x: s.x - s.vx, y: s.y - s.vy }); hit = true; break; }
        }
      }
      if (hit || s.left <= 0 || this.tileAt(s.x, s.y) === TILE.ROCK) this.projectiles.splice(i, 1);
    }
  }

  // ---- Actions des joueurs ----
  handle(p, m) {
    if (!m || typeof m.t !== 'string') return;
    if (m.t === 'restart') { if (this.state === 'won' || this.state === 'lost') { this.reset(); return 'reinit'; } return; }
    if (m.t === 'ping') {
      if (Number.isFinite(m.x) && Number.isFinite(m.y)) this.events.push({ ping: { x: r2(m.x), y: r2(m.y), c: p.color, n: p.name } });
      return;
    }
    if (m.t === 'role') return this.pickRole(p, m.r);
    if (m.t === 'vote') return this.vote(p, m.v);
    if (m.t === 'dev' && process.env.ARCHIPEL_DEV) return this.dev(p, m); // outils de test, désactivés en production
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
      case 'eat': return this.eat(p);
      case 'drink': return this.consume(p, 'eau');
      case 'revive': return this.revive(p, m.id);
      case 'heal': return this.healOther(p, m.id, now);
      case 'bandage': return this.bandage(p);
      case 'craft': return this.craft(p, m.id);
      case 'build': return this.build(p, m.id);
      case 'launch': return this.launch(p);
      case 'atk': return this.attack(p, m.a, now);
      case 'dodge': return this.dodge(p, now);
      case 'weapon': return this.setWeapon(p, m.w);
      case 'work': return this.work(p, m);
      case 'ritual': return this.ritual(p);
      case 'repair': return this.repair(p, m.id);
    }
  }

  dev(p, m) {
    if (Number.isFinite(m.time)) this.time = m.time;
    if (m.chest) for (const r of RES) this.chest[r] = m.chest;
    if (m.reveal) { this.reveal(p.x, p.y, 400, true); for (const I of this.world.islands) this.discovered.add(I.idx); }
    if (Number.isFinite(m.frags)) for (let n = 1; n <= m.frags; n++) { this.frags.add(n); for (const s of this.sites.values()) if (s.frag === n) { s.done = true; s.prog = 1; } }
    if (m.tp) { p.x = m.tp.x; p.y = m.tp.y; this.correct(p); }
    if (m.storm) { this.weather.next = 56; }
    if (m.tools) Object.assign(p.tools, m.tools);
    if (m.gardien) for (const b of this.beasts.values()) if (b.k === 'gardien') this.killBeast(b, p);
    if (m.inv) Object.assign(p.inv, m.inv);
  }

  reply(p, text) { if (p.ws) p.ws.sendJSON({ t: 'note', text }); }

  pickRole(p, r) {
    if (!ROLES[r] || p.role === r) return;
    const other = this.onlinePlayers().find((q) => q !== p && q.role === r);
    if (other) return this.reply(p, `${other.name} est déjà ${ROLES[r].label.toLowerCase()}.`);
    p.role = r;
    this.log(`${p.name} sera ${ROLES[r].label.toLowerCase()}.`, 'join');
  }

  move(p, m) {
    if (!Number.isFinite(m.x) || !Number.isFinite(m.y)) return;
    const now = Date.now();
    const dt = Math.min(1, (now - p.lastPos) / 1000);
    p.lastPos = now;
    if (p.downed) return this.correct(p);
    const b = p.boat ? this.boats.find((x) => x.id === p.boat) : null;
    if (b) {
      if (b.seats[0] !== p.id) return; // seul le barreur dirige
      const [cx, cy] = this.currentAt(b.x, b.y), [wx, wy] = this.wind();
      const speed = BOATS[b.kind].speed(b.seats.length) + Math.hypot(cx, cy) + Math.hypot(wx, wy);
      if (Math.hypot(m.x - b.x, m.y - b.y) > speed * dt * 1.8 + 0.8 || !S.boatable(this.tileAt(m.x, m.y))) return this.correct(p);
      const ph = this.world.phare;
      if (this.frags.size < C.FRAG_NEED && Math.hypot(m.x - ph.x, m.y - ph.y) < ph.zone) {
        if (now - this.fogNoteAt > 4000) { this.fogNoteAt = now; this.reply(p, 'La brume est trop épaisse, impossible de tenir un cap. Il vous faut au moins trois fragments.'); }
        return this.correct(p);
      }
      b.x = m.x; b.y = m.y;
      if (Number.isFinite(m.a)) b.a = m.a;
      for (const id of b.seats) { const q = this.players.get(id); if (q) { q.x = b.x; q.y = b.y; } }
      if (this.tileAt(b.x, b.y) === TILE.REEF && now - b.reefAt > 1500) {
        b.reefAt = now;
        b.hull -= BOATS[b.kind].reef;
        this.spotReefsAround(b.x, b.y, 2.5);
        this.fx({ k: 'reef', x: r2(b.x), y: r2(b.y) });
        if (b.hull <= 0) this.sink(b, 'Un récif');
        else this.log(`La coque heurte un récif ! (${Math.max(0, Math.round((b.hull / BOATS[b.kind].hull) * 100))} %)`, 'warn');
      }
      return;
    }
    const lim = now - p.dodgeAt < (C.DODGE_TIME * 1000 + 350) ? C.DODGE_SPEED : C.SPEED_WALK;
    if (Math.hypot(m.x - p.x, m.y - p.y) > lim * dt * 1.8 + 0.8 || !S.walkable(this.tileAt(m.x, m.y))) return this.correct(p);
    p.x = m.x; p.y = m.y;
    if (Number.isFinite(m.d)) p.dir = m.d;
  }

  correct(p) { if (p.ws) p.ws.sendJSON({ t: 'correct', x: p.x, y: p.y }); }

  // Une barque coule : l'équipage s'échoue sur la côte la plus proche, la cale est perdue.
  sink(b, why) {
    const crew = b.seats.map((id) => this.players.get(id)).filter(Boolean);
    let spot = null;
    for (let r = 1; r < 40 && !spot; r++) {
      for (let k = 0; k < r * 8 && !spot; k++) {
        const a = (k / (r * 8)) * Math.PI * 2;
        const x = Math.floor(b.x + Math.cos(a) * r) + 0.5, y = Math.floor(b.y + Math.sin(a) * r) + 0.5;
        const t = this.tileAt(x, y);
        if (t >= TILE.SAND && t <= TILE.ROCK) spot = { x, y };
      }
    }
    spot = spot || { x: this.camp.fire.x, y: this.camp.fire.y + 1 };
    const I = this.world.islands[this.ownerAt(spot.x, spot.y)];
    for (const q of crew) {
      q.boat = null; q.x = spot.x + (Math.random() - 0.5); q.y = spot.y + (Math.random() - 0.5);
      if (!S.walkable(this.tileAt(q.x, q.y))) { q.x = spot.x; q.y = spot.y; }
      q.hp -= 20;
      if (q.hp <= 0) this.down(q, `${q.name} est rejeté sur la plage, inconscient.`);
      this.correct(q);
    }
    this.log(`${why} a eu raison de la ${BOATS[b.kind].label.toLowerCase()}. L'équipage s'échoue${I ? ' sur ' + I.name : ''}, la cale est perdue.`, 'danger');
    this.fx({ k: 'sink', x: r2(b.x), y: r2(b.y) });
    const d = this.camp.dock;
    b.seats = []; b.hold = {}; b.hull = BOATS[b.kind].hull * 0.5; b.x = d.x; b.y = d.y; b.a = d.angle;
  }

  harvest(p, id, now) {
    const n = this.nodes.get(id);
    if (!n || p.boat) return;
    const def = NODES[n.k];
    if (n.amt <= 0 || dist(p, n) > C.REACH + 0.4) return;
    const dur = def.dur * (def.tool && p.tools[def.tool] ? 0.5 : 1) * (n.k === 'tree' && p.role === 'charpentier' ? 0.7 : 1);
    if (now - p.lastHarvest < dur * 1000 * 0.75) return;
    if (S.sacCount(p.inv) >= C.SAC_CAP) return this.reply(p, 'Ton sac est plein. Dépose-le au coffre ou dans une barque (R).');
    p.lastHarvest = now;
    p.inv[def.res]++;
    if (n.k !== 'spring') { n.amt--; n.rg = 0; this.dirtyNodes.add(n.id); }
  }

  board(p, id) {
    const b = this.boats.find((x) => x.id === id);
    if (!b || p.boat || dist(p, b) > C.REACH + 0.6) return;
    if (b.seats.length >= BOATS[b.kind].seats) return this.reply(p, 'La barque est pleine.');
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
      let room = BOATS[b.kind].hold - S.sacCount(b.hold);
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

  gain(p, base) { return base * (p.role === 'herboriste' ? 1.4 : 1); }

  eat(p) {
    if (p.faim >= 96) return this.reply(p, "Tu n'as pas faim.");
    const atChest = dist(p, this.camp.chest) <= C.CAMP_REACH;
    for (const [src, res] of [[p.inv, 'nourriture'], [p.inv, 'viande'], [atChest ? this.chest : null, 'nourriture'], [atChest ? this.chest : null, 'viande']]) {
      if (!src || src[res] <= 0) continue;
      src[res]--;
      p.faim = Math.min(100, p.faim + this.gain(p, res === 'viande' ? C.MEAT_GAIN : C.EAT_GAIN));
      return;
    }
    this.reply(p, "Tu n'as rien à manger. Cueille des fruits, chasse, ou mange au coffre.");
  }

  consume(p, res) {
    if (p.soif >= 96) return this.reply(p, "Tu n'as pas soif.");
    let src = null;
    if (p.inv[res] > 0) src = p.inv;
    else if (dist(p, this.camp.chest) <= C.CAMP_REACH && this.chest[res] > 0) src = this.chest;
    else {
      const spring = [...this.nodes.values()].find((n) => n.k === 'spring' && dist(p, n) <= C.REACH + 0.4);
      if (spring) { p.soif = Math.min(100, p.soif + this.gain(p, C.DRINK_GAIN)); return; }
    }
    if (!src) return this.reply(p, "Tu n'as pas d'eau. Puise-en à une source ou bois au coffre.");
    src[res]--;
    p.soif = Math.min(100, p.soif + this.gain(p, C.DRINK_GAIN));
  }

  bandage(p) {
    if (p.tools.bandages <= 0) return this.reply(p, "Tu n'as plus de bandages. Fabrique-en à l'atelier.");
    if (p.hp >= 98) return this.reply(p, "Tu n'es pas blessé.");
    p.tools.bandages--;
    p.hp = Math.min(100, p.hp + (p.role === 'herboriste' ? 60 : C.BANDAGE_HEAL));
    this.fx({ k: 'heal', id: p.id, x: r2(p.x), y: r2(p.y) });
  }

  healOther(p, id, now) {
    const q = this.players.get(id);
    if (p.role !== 'herboriste' || !q || q === p || q.downed || dist(p, q) > C.REACH + 0.6 || now - p.healAt < 1200) return;
    p.healAt = now;
    q.hp = Math.min(100, q.hp + 30);
    this.fx({ k: 'heal', id: q.id, x: r2(q.x), y: r2(q.y) });
  }

  revive(p, id) {
    const q = this.players.get(id);
    if (!q || !q.downed || q === p || dist(p, q) > C.REACH + 0.6) return;
    q.downed = false; q.hp = p.role === 'herboriste' ? 70 : 35; q.faim = Math.max(q.faim, 30); q.soif = Math.max(q.soif, 30);
    this.log(`${p.name} relève ${q.name}.`, 'revive');
  }

  hasWeapon(p, w) { return w === 'mains' || (WEAPONS[w] && p.tools[w]); }
  setWeapon(p, w) { if (this.hasWeapon(p, w)) p.weapon = w; }

  attack(p, a, now) {
    if (p.boat || !Number.isFinite(a)) return;
    if (!this.hasWeapon(p, p.weapon)) p.weapon = 'mains';
    const W = WEAPONS[p.weapon];
    if (now - p.atkAt < W.cd * 1000 * 0.85) return;
    p.atkAt = now; p.atkN++; p.atkA = r2(a); p.dir = a;
    if (p.weapon === 'fronde') {
      if (p.inv.pierre <= 0) return this.reply(p, 'Il te faut des pierres dans ton sac pour la fronde.');
      p.inv.pierre--;
      this.projectiles.push({ id: this.projSeq++, x: p.x + Math.cos(a) * 0.4, y: p.y - 0.3 + Math.sin(a) * 0.4, vx: Math.cos(a) * W.speed, vy: Math.sin(a) * W.speed, left: W.range, owner: p.id, dmg: W.dmg });
      return;
    }
    for (const b of this.beasts.values()) {
      if (b.dead) continue;
      const d = dist(p, b) - BEASTS[b.k].r * 0.6;
      if (d > W.reach) continue;
      if (Math.abs(S.angleDiff(Math.atan2(b.y - p.y, b.x - p.x), a)) > W.arc / 2 + 0.25 && d > 0.5) continue;
      this.strike(p, b, W.dmg, p);
    }
  }

  dodge(p, now) {
    if (p.boat || now - p.dodgeAt < C.DODGE_CD * 1000 * 0.85) return;
    p.dodgeAt = now; p.dodgeN++;
    p.invulnUntil = now + C.DODGE_INVULN * 1000 + 80;
  }

  repair(p, id) {
    const b = this.boats.find((x) => x.id === id);
    if (!b || (p.boat !== b.id && dist(p, b) > C.REACH + 0.8)) return;
    const max = BOATS[b.kind].hull;
    if (b.hull >= max - 1) return this.reply(p, 'La coque est intacte.');
    if (p.role === 'charpentier') {
      const src = p.inv.bois >= 2 ? p.inv : (b.hold.bois || 0) >= 2 ? b.hold : null;
      if (!src) return this.reply(p, 'Il te faut deux bois (dans ton sac ou dans la cale).');
      src.bois -= 2;
    } else {
      if (dist(b, this.camp.dock) > 6 || !this.nearYard(p)) return this.reply(p, 'Seul le charpentier répare en mer. Ramène la barque au ponton.');
      if (this.chest.bois < 2) return this.reply(p, 'Il faut deux bois dans le coffre.');
      this.chest.bois -= 2;
    }
    b.hull = Math.min(max, b.hull + 30);
    this.log(`${p.name} répare la coque (${Math.round((b.hull / max) * 100)} %).`, 'craft');
  }

  nearCamp(p) { return dist(p, this.camp.bench) <= C.CAMP_REACH + 0.5 || dist(p, this.camp.chest) <= C.CAMP_REACH; }

  pay(cost) { for (const k in cost) this.chest[k] -= cost[k]; }

  craft(p, id) {
    const R = RECIPES[id];
    if (!R || !this.nearCamp(p)) return;
    if (id === 'recuperateur' && this.recup) return;
    if (id === 'grande' && this.grande) return;
    if (['hache', 'pioche', 'lance', 'fronde'].includes(id) && p.tools[id]) return this.reply(p, `Tu as déjà : ${R.label.toLowerCase()}.`);
    if (id === 'barque' && this.boats.filter((b) => b.kind === 'barque').length >= C.MAX_BOATS) return this.reply(p, 'Le ponton ne peut pas accueillir plus de barques.');
    if (!S.canAfford(this.chest, R.cost)) return this.reply(p, 'Pas assez de ressources dans le coffre.');
    this.pay(R.cost);
    if (['hache', 'pioche', 'lance', 'fronde'].includes(id)) { p.tools[id] = true; if (id !== 'pioche' && p.weapon === 'mains') p.weapon = id; }
    else if (id === 'torche') p.tools.torches++;
    else if (id === 'bandage') p.tools.bandages += 2;
    else if (id === 'barque') this.addBoat('barque');
    else if (id === 'grande') { this.addBoat('grande'); this.grande = true; }
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
    this.finish('fuite');
  }

  // ---- Messages réseau ----
  initPayload(p) {
    const w = this.world;
    return {
      t: 'init', you: p.id, token: p.token, code: this.code,
      W: w.W, H: w.H, tiles: Buffer.from(w.tiles).toString('base64'),
      currents: Buffer.from(w.currents.buffer, w.currents.byteOffset, w.currents.byteLength).toString('base64'),
      seen: Buffer.from(this.seen).toString('base64'),
      reefs: [...this.spotted],
      islands: w.islands, camp: this.camp, phare: w.phare,
      sites: [...this.sites.values()].map((s) => ({ id: s.id, k: s.k, frag: s.frag || 0, x: s.x, y: s.y, levers: s.levers ? s.levers.map((l) => ({ x: l.x, y: l.y })) : null })),
      nodes: [...this.nodes.values()].map((n) => [n.id, n.k, n.x, n.y, n.amt]),
      snap: { ...this.snapshot(true), ev: [], fog: [], nreefs: [] },
    };
  }

  snapshot(full) {
    const nodes = full ? [] : [...this.dirtyNodes].map((id) => [id, this.nodes.get(id).amt]);
    const now = Date.now();
    return {
      t: 's', time: r2(this.time * 1000) / 1000, day: this.day, st: this.state, end: this.ending,
      fire: Math.round(this.fire.fuel), chest: this.chest, parts: this.parts, recup: this.recup, grande: this.grande,
      wt: { st: this.weather.st, t: Math.round(this.weather.t), wx: r2(this.weather.wx), wy: r2(this.weather.wy) },
      frags: [...this.frags], isl: [...this.discovered], gd: this.gardienDead,
      votes: this.state === 'choice' ? Object.fromEntries(this.votes) : null,
      players: [...this.players.values()].filter((p) => p.online).map((p) => ({
        id: p.id, n: p.name, c: p.color, x: r2(p.x), y: r2(p.y), d: r2(p.dir || 0),
        hp: Math.round(p.hp), f: Math.round(p.faim), s: Math.round(p.soif),
        dn: p.downed, b: p.boat, tl: p.torchLeft > 0, cold: !!p.cold,
        inv: p.inv, tools: p.tools, r: p.role, w: p.weapon, an: p.atkN, aa: p.atkA, dg: p.dodgeN,
      })),
      boats: this.boats.map((b) => ({ id: b.id, k: b.kind, x: r2(b.x), y: r2(b.y), a: r2(b.a), seats: b.seats, hold: b.hold, hull: Math.round(b.hull) })),
      beasts: [...this.beasts.values()].filter((b) => !b.dead).map((b) => [b.id, b.k, r2(b.x), r2(b.y), r2(b.a), Math.ceil(b.hp), b.mhp, b.st,
        b.st === ST.wind ? r2(1 - b.t / BEASTS[b.k].wind) : 0, b.k === 'gardien' ? r2(b.tx) : 0, b.k === 'gardien' ? r2(b.ty) : 0, b.k === 'gardien' ? b.pat % 2 : 0]),
      proj: this.projectiles.map((s) => [s.id, r2(s.x), r2(s.y)]),
      sites: [...this.sites.values()].map((s) => [s.id, s.done ? 1 : 0, Math.round(s.prog * 100), s.open ? 1 : 0,
        s.levers ? s.levers.map((l) => (now - l.at < (this.onlinePlayers().length <= 1 ? 8000 : 500) ? 1 : 0)) : 0, s.workers.size]),
      fog: this.newSeen, nreefs: this.newReefs,
      nodes,
      ev: this.events,
    };
  }

  flush() { this.events = []; this.dirtyNodes.clear(); this.newSeen = []; this.newReefs = []; }
}

module.exports = { Game, ST };
