// Génération de l'archipel : îles, ressources, récifs, courants, sites des fragments et emplacement du camp.
const { TILE, C, FRAGMENTS } = require('../public/shared.js');

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeNoise(rand) {
  const N = 64, g = new Float32Array(N * N);
  for (let i = 0; i < g.length; i++) g[i] = rand();
  const v = (a, b) => g[(((a % N) + N) % N) + (((b % N) + N) % N) * N];
  const s = (t) => t * t * (3 - 2 * t);
  const lerp = (a, b, t) => a + (b - a) * t;
  return (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const u = s(x - xi), w = s(y - yi);
    return lerp(lerp(v(xi, yi), v(xi + 1, yi), u), lerp(v(xi, yi + 1), v(xi + 1, yi + 1), u), w);
  };
}

// Chaque type d'île a sa ressource dominante, ce qui oblige à naviguer.
// ref = rayon de référence pour lequel les quantités sont prévues.
const BIOMES = {
  home:  { grassAt: 0.32, ref: 10,   counts: { tree: 6, bush: 3, rock: 2 } },
  foret: { grassAt: 0.26, ref: 12.5, counts: { tree: 46, bush: 4, flax: 3 } },
  roc:   { grassAt: 0.30, ref: 10,   counts: { rock: 30, tree: 2 }, rocky: true },
  verte: { grassAt: 0.28, ref: 11,   counts: { bush: 18, flax: 16, spring: 2, tree: 6 } },
  sable: { grassAt: 0.55, ref: 7,    counts: { flax: 5, bush: 4, rock: 4 } },
  phare: { grassAt: 0.30, ref: 9,    counts: { rock: 8, tree: 3 }, rocky: true },
};
const NAMES = {
  foret: ['Île aux Pins', 'Bois-Sombre', 'Île des Cèdres'],
  roc:   ['Le Rocher', 'Les Dents', 'Roc-Fendu'],
  verte: ['Île Verte', 'Les Vergers', 'Île aux Sources'],
  sable: ['Îlot des Sables', 'La Dune', 'Banc-Doré'],
};
const SIZE = { foret: 12.5, roc: 10, verte: 11, sable: 7 };

function shuffle(a, rand) {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

function createWorld(seed) {
  const rand = mulberry32(seed);
  const n1 = makeNoise(rand), n2 = makeNoise(rand), n3 = makeNoise(rand);
  const { W, H } = C;
  const tiles = new Uint8Array(W * H);
  const owner = new Int8Array(W * H).fill(-1);
  const height = new Float32Array(W * H);

  // ---------------------------------------------------------------- placement des îles
  const isl = [];
  const used = new Set();
  const pickName = (b) => { const l = NAMES[b].filter((n) => !used.has(n)); const n = l[Math.floor(rand() * l.length)] || NAMES[b][0]; used.add(n); return n; };
  const add = (o) => { o.idx = isl.length; isl.push(o); return o; };
  const home = add({ id: 'home', biome: 'home', name: 'Île du Naufrage', x: W / 2, y: H / 2, r: 10, ring: 0 });

  // Le Phare noir, dans un coin de l'archipel, derrière son banc de brume.
  const corners = [[24, 20], [W - 24, 20], [24, H - 20], [W - 24, H - 20]];
  const [pcx, pcy] = corners[Math.floor(rand() * 4)];
  const phare = add({ id: 'phare', biome: 'phare', name: 'Le Phare noir', x: pcx + (rand() - 0.5) * 4, y: pcy + (rand() - 0.5) * 4, r: 8.5, ring: 3 });
  const ZONE = phare.r + 10; // rayon du banc de brume
  const pAng = Math.atan2(phare.y - home.y, phare.x - home.x);

  // Trois îles proches, une par ressource essentielle, réparties autour du camp.
  const near = shuffle(['foret', 'roc', 'verte'], rand);
  const a0 = pAng + Math.PI / 3 + rand() * 0.6;
  near.forEach((b, k) => {
    const a = a0 + (k * Math.PI * 2) / 3 + (rand() - 0.5) * 0.5;
    const d = 25 + rand() * 4;
    const r = SIZE[b] * (0.85 + rand() * 0.12);
    add({ id: 'i' + isl.length, biome: b, name: pickName(b), x: home.x + Math.cos(a) * d * 1.15, y: home.y + Math.sin(a) * d * 0.9, r, ring: 1 });
  });
  // Six îles lointaines.
  const far = shuffle(['foret', 'roc', 'verte', 'sable', 'sable', rand() < 0.5 ? 'verte' : 'foret'], rand);
  for (const b of far) {
    let best = null;
    for (let tries = 0; tries < 4000 && !best; tries++) {
      const slack = tries > 2500 ? 3 : 6;
      const r = SIZE[b] * (0.72 + rand() * 0.22);
      const x = r + 6 + rand() * (W - 2 * r - 12), y = r + 6 + rand() * (H - 2 * r - 12);
      if (Math.hypot(x - home.x, y - home.y) < 36) continue;
      if (Math.hypot(x - phare.x, y - phare.y) < ZONE + r + 3) continue;
      if (isl.some((I) => Math.hypot(x - I.x, y - I.y) < I.r + r + slack + (I.id === 'phare' ? 6 : 0))) continue;
      best = { x, y, r };
    }
    if (best) add({ id: 'i' + isl.length, biome: b, name: pickName(b), ...best, ring: 2 });
  }

  // ---------------------------------------------------------------- relief
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let best = -9, bi = -1;
      for (const I of isl) {
        const d = Math.hypot(x + 0.5 - I.x, y + 0.5 - I.y);
        if (d > I.r * 1.6 + 3) continue;
        // Rayon irrégulier : baies et pointes, pour des côtes qui ne soient pas des cercles.
        const r = I.r * (0.68 + 0.62 * n1(x / 7 + I.idx * 17, y / 7 + I.idx * 5));
        const h = 1 - d / r;
        if (h > best) { best = h; bi = I.idx; }
      }
      const i = x + y * W;
      if (bi < 0) { tiles[i] = TILE.DEEP; height[i] = -1; continue; }
      const h = best + (n2(x / 3.2, y / 3.2) - 0.5) * 0.24;
      height[i] = h;
      const I = isl[bi], B = BIOMES[I.biome];
      let t;
      if (x < 2 || y < 2 || x >= W - 2 || y >= H - 2) t = TILE.DEEP;
      else if (h > B.grassAt) t = B.rocky && h > B.grassAt + 0.08 ? TILE.ROCK : TILE.GRASS;
      else if (h > 0.1) t = TILE.SAND;
      else if (h > -0.24) t = TILE.SHALLOW;
      else t = TILE.DEEP;
      tiles[i] = t;
      if (t >= TILE.SAND) owner[i] = bi;
    }
  }
  const at = (x, y) => (x < 0 || y < 0 || x >= W || y >= H ? TILE.DEEP : tiles[x + y * W]);
  const land = (x, y) => { const t = at(x, y); return t >= TILE.SAND && t <= TILE.ROCK; };

  // ---------------------------------------------------------------- camp
  const cx = Math.floor(home.x), cy = Math.floor(home.y);
  let yard = null, dock = null, bestD = 1e9;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (owner[x + y * W] !== 0 || at(x, y) !== TILE.SAND) continue;
    const nb = [[1, 0], [-1, 0], [0, 1], [0, -1]].find(([dx, dy]) => at(x + dx, y + dy) === TILE.SHALLOW);
    if (!nb) continue;
    const d = Math.hypot(x - cx, y - cy);
    if (d < bestD && d > 4) { bestD = d; yard = { x, y }; dock = { x: x + nb[0], y: y + nb[1], dx: nb[0], dy: nb[1] }; }
  }
  // Pousse le ponton d'une tuile vers le large si possible, pour que la barque flotte bien.
  if (at(dock.x + dock.dx, dock.y + dock.dy) <= TILE.SHALLOW) { dock.x += dock.dx; dock.y += dock.dy; }
  const camp = {
    chest: { x: cx + 0.5, y: cy + 0.5 },
    bench: { x: cx + 2.5, y: cy + 0.5 },
    fire:  { x: cx + 0.5, y: cy + 3.0 },
    yard:  { x: yard.x + 0.5, y: yard.y + 0.5 },
    dock:  { x: dock.x + 0.5, y: dock.y + 0.5, angle: Math.atan2(dock.dy, dock.dx) },
  };
  for (const k of ['chest', 'bench', 'fire']) {
    const i = Math.floor(camp[k].x) + Math.floor(camp[k].y) * W;
    if (tiles[i] < TILE.SAND) tiles[i] = TILE.GRASS;
  }

  // ---------------------------------------------------------------- récifs
  const isWater = (x, y) => at(x, y) <= TILE.SHALLOW;
  const nearDock = (x, y) => Math.hypot(x + 0.5 - camp.dock.x, y + 0.5 - camp.dock.y) < 9;
  const setReef = (x, y) => { if (x > 2 && y > 2 && x < W - 3 && y < H - 3 && isWater(x, y) && !nearDock(x, y)) tiles[x + y * W] = TILE.REEF; };
  // Une couronne de récifs autour du Phare, ouverte d'un seul côté : le cap des fragments passe par là.
  const gapA = Math.atan2(home.y - phare.y, home.x - phare.x);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const d = Math.hypot(x + 0.5 - phare.x, y + 0.5 - phare.y);
    if (d < phare.r + 4 || d > phare.r + 6.2) continue;
    let da = Math.atan2(y + 0.5 - phare.y, x + 0.5 - phare.x) - gapA;
    while (da > Math.PI) da -= 2 * Math.PI; while (da < -Math.PI) da += 2 * Math.PI;
    if (Math.abs(da) < 0.32) continue;
    if (n3(x / 2.2, y / 2.2) > 0.32) setReef(x, y);
  }
  // Des bancs de récifs au large des îles et dans les passes.
  const blob = (sx, sy, n) => {
    let x = sx, y = sy;
    for (let k = 0; k < n; k++) {
      setReef(x, y);
      const d = [[1, 0], [-1, 0], [0, 1], [0, -1]][Math.floor(rand() * 4)];
      x += d[0]; y += d[1];
    }
  };
  for (let k = 0; k < 16; k++) {
    const I = isl[1 + Math.floor(rand() * (isl.length - 1))];
    if (I.id === 'phare') continue;
    const a = rand() * Math.PI * 2, d = I.r * 1.25 + 2 + rand() * 4;
    const x = Math.floor(I.x + Math.cos(a) * d), y = Math.floor(I.y + Math.sin(a) * d);
    if (isWater(x, y)) blob(x, y, 3 + Math.floor(rand() * 5));
  }
  for (let k = 0; k < 8; k++) {
    const x = 6 + Math.floor(rand() * (W - 12)), y = 6 + Math.floor(rand() * (H - 12));
    if (Math.hypot(x - home.x, y - home.y) < 20 || !isWater(x, y)) continue;
    blob(x, y, 4 + Math.floor(rand() * 6));
  }

  // ---------------------------------------------------------------- courants
  // Chaque courant est un fleuve dans la mer : il déporte les barques (en dixièmes de tuile par seconde).
  const currents = new Int8Array(W * H * 2);
  for (let k = 0, tries = 0; k < 6 && tries < 400; tries++) {
    let x = 8 + rand() * (W - 16), y = 8 + rand() * (H - 16);
    if (at(Math.floor(x), Math.floor(y)) !== TILE.DEEP || Math.hypot(x - home.x, y - home.y) < 18 || Math.hypot(x - phare.x, y - phare.y) < ZONE + 2) continue;
    k++;
    let a = rand() * Math.PI * 2;
    const str = 1.6 + rand() * 0.9;
    for (let s = 0; s < 50; s++) {
      a += (n2(x / 9 + k * 13, y / 9) - 0.5) * 0.55;
      x += Math.cos(a); y += Math.sin(a);
      if (x < 4 || y < 4 || x > W - 5 || y > H - 5) break;
      if (Math.hypot(x - home.x, y - home.y) < 16 || Math.hypot(x - phare.x, y - phare.y) < ZONE) break;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const tx = Math.floor(x) + dx, ty = Math.floor(y) + dy;
        if (Math.hypot(tx + 0.5 - x, ty + 0.5 - y) > 1.7 || at(tx, ty) !== TILE.DEEP) continue;
        const i = (tx + ty * W) * 2;
        currents[i] = Math.round(Math.cos(a) * str * 10); currents[i + 1] = Math.round(Math.sin(a) * str * 10);
      }
    }
  }

  // ---------------------------------------------------------------- sites des fragments
  const sites = [];
  const clearAround = (x, y, r, ok) => {
    for (let dy = -Math.ceil(r); dy <= Math.ceil(r); dy++) for (let dx = -Math.ceil(r); dx <= Math.ceil(r); dx++) {
      if (Math.hypot(dx, dy) > r) continue;
      if (!ok(at(x + dx, y + dy))) return false;
    }
    return true;
  };
  const spotOn = (I, kind) => {
    const cand = [];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (owner[x + y * W] !== I.idx) continue;
      const t = at(x, y);
      if (kind === 'epave') {
        if (t !== TILE.SAND || ![[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => at(x + dx, y + dy) === TILE.SHALLOW)) continue;
        if (!clearAround(x, y, 1, (u) => u >= TILE.SHALLOW && u <= TILE.ROCK)) continue;
      } else if (kind === 'ruine') {
        if (t < TILE.GRASS || !clearAround(x, y, 2.2, (u) => u >= TILE.SAND && u <= TILE.ROCK)) continue;
        if (!land(x - 3, y + 1) || !land(x + 3, y + 1)) continue;
      } else if (kind === 'phare') {
        if (t < TILE.GRASS || !clearAround(x, y, 1.5, (u) => u >= TILE.SAND && u <= TILE.ROCK)) continue;
      } else if (t < TILE.SAND || !clearAround(x, y, 1.2, (u) => u >= TILE.SAND && u <= TILE.ROCK)) continue;
      cand.push([x, y, Math.hypot(x + 0.5 - I.x, y + 0.5 - I.y)]);
    }
    if (!cand.length) return null;
    if (kind === 'phare') { cand.sort((a, b) => a[2] - b[2]); return cand[0]; }
    return cand[Math.floor(rand() * cand.length)];
  };
  const others = isl.filter((I) => I.ring === 1 || I.ring === 2);
  const ring1 = shuffle(others.filter((I) => I.ring === 1), rand);
  const pool = shuffle(others.filter((I) => I !== ring1[0]), rand);
  // Les deux derniers fragments, les plus précieux, sont sur les îles les plus lointaines.
  pool.sort((a, b) => Math.hypot(b.x - home.x, b.y - home.y) - Math.hypot(a.x - home.x, a.y - home.y));
  const far2 = pool.splice(0, 2);
  shuffle(pool, rand);
  const order = [ring1[0], ...pool.slice(0, 4), far2[1], far2[0]];
  let sid = 1;
  FRAGMENTS.forEach((F, k) => {
    const I = order[k] || others[k % others.length];
    let kind = F.site;
    let s = spotOn(I, kind);
    if (!s && kind !== 'carnet') { kind = 'carnet'; s = spotOn(I, kind); }
    if (!s) return;
    const site = { id: sid++, k: kind, frag: F.n, island: I.idx, x: s[0] + 0.5, y: s[1] + 0.5 };
    if (kind === 'ruine') site.levers = [{ x: s[0] - 2.5, y: s[1] + 1.5 }, { x: s[0] + 3.5, y: s[1] + 1.5 }];
    sites.push(site);
  });
  const ps = spotOn(phare, 'phare') || [Math.floor(phare.x), Math.floor(phare.y)];
  const lantern = { id: sid++, k: 'phare', island: phare.idx, x: ps[0] + 0.5, y: ps[1] + 0.5 };
  sites.push(lantern);

  // ---------------------------------------------------------------- ressources
  const taken = new Set();
  const nodes = [];
  const keepClear = [camp.chest, camp.bench, camp.fire, camp.yard];
  for (const s of sites) { keepClear.push(s); if (s.levers) keepClear.push(...s.levers); }
  const allowed = {
    tree: (t) => t === TILE.GRASS,
    rock: (t, h, I) => t === TILE.ROCK || (t === TILE.GRASS && h > BIOMES[I.biome].grassAt + 0.05) || (I.biome === 'sable' && t === TILE.SAND && h > 0.3),
    bush: (t) => t === TILE.GRASS,
    flax: (t, h, I) => t === TILE.GRASS || (I.biome === 'sable' && t === TILE.SAND && h > 0.25),
    spring: (t, h) => t === TILE.GRASS && h > 0.5,
  };
  let nid = 1;
  for (const I of isl) {
    const B = BIOMES[I.biome];
    const scale = I.id === 'home' ? 1 : Math.max(0.55, (I.r * I.r) / (B.ref * B.ref));
    for (const kind of ['spring', 'rock', 'tree', 'bush', 'flax']) {
      let want = Math.round((B.counts[kind] || 0) * (kind === 'spring' ? 1 : scale));
      if (!want) continue;
      const cand = [];
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = x + y * W;
        if (owner[i] !== I.idx || taken.has(i)) continue;
        if (!allowed[kind](tiles[i], height[i], I)) continue;
        if (keepClear.some((p) => Math.hypot(x + 0.5 - p.x, y + 0.5 - p.y) < 3)) continue;
        cand.push(i);
      }
      shuffle(cand, rand);
      let placed = 0;
      for (const i of cand) {
        if (placed >= want) break;
        if (taken.has(i)) continue;
        const x = i % W, y = (i / W) | 0;
        // Les arbres et rochers gardent un peu d'espace pour qu'on circule entre eux.
        if ((kind === 'tree' || kind === 'rock') && rand() < 0.35 && [[1, 0], [0, 1], [-1, 0], [0, -1]].some(([dx, dy]) => taken.has(x + dx + (y + dy) * W))) continue;
        taken.add(i);
        const jx = kind === 'spring' ? 0.5 : 0.3 + rand() * 0.4, jy = kind === 'spring' ? 0.5 : 0.3 + rand() * 0.4;
        nodes.push({ id: nid++, k: kind, x: +(x + jx).toFixed(2), y: +(y + jy).toFixed(2), amt: 0, rg: 0 });
        placed++;
      }
    }
  }

  // ---------------------------------------------------------------- bêtes
  const spawns = [];
  const landTiles = (I, pred) => {
    const out = [];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = x + y * W;
      if (owner[i] === I.idx && pred(tiles[i]) && !taken.has(i) && !keepClear.some((p) => Math.hypot(x + 0.5 - p.x, y + 0.5 - p.y) < 2.5)) out.push([x + 0.5, y + 0.5]);
    }
    return shuffle(out, rand);
  };
  for (const I of isl) {
    const crabs = I.id === 'home' ? 1 : I.ring === 1 ? 2 : 3;
    const varans = I.ring === 2 && (I.biome === 'foret' || I.biome === 'verte') ? (I.biome === 'foret' ? 3 : 2) : I.ring === 1 && I.biome === 'foret' ? 1 : 0;
    const sand = landTiles(I, (t) => t === TILE.SAND);
    // Le crabe de l'île du camp se tient loin du feu.
    const far = I.id === 'home' ? sand.filter(([x, y]) => Math.hypot(x - camp.fire.x, y - camp.fire.y) > 7) : sand;
    for (let k = 0; k < crabs && k < far.length; k++) spawns.push({ k: 'crabe', x: far[k][0], y: far[k][1], island: I.idx });
    const grass = landTiles(I, (t) => t === TILE.GRASS);
    for (let k = 0; k < varans && k < grass.length; k++) spawns.push({ k: 'varan', x: grass[k][0], y: grass[k][1], island: I.idx });
  }
  spawns.push({ k: 'gardien', x: lantern.x, y: lantern.y + 1.5, island: phare.idx });

  return {
    W, H, tiles, seed, owner,
    islands: isl.map((I) => ({ id: I.id, idx: I.idx, name: I.name, biome: I.biome, ring: I.ring, x: +I.x.toFixed(2), y: +I.y.toFixed(2), r: +I.r.toFixed(2) })),
    nodes, camp, sites, spawns, currents,
    phare: { x: +phare.x.toFixed(2), y: +phare.y.toFixed(2), r: phare.r, zone: ZONE, gap: +gapA.toFixed(3) },
  };
}

module.exports = { createWorld, mulberry32 };
