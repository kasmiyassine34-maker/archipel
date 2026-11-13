// Génération de l'archipel : îles, ressources et emplacement du camp.
const { TILE, C } = require('../public/shared.js');

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

// Chaque île a une ressource dominante, ce qui oblige à naviguer.
const ISLANDS = [
  { id: 'home',  name: 'Île du Naufrage', x: 64,  y: 47, r: 10, grassAt: 0.32,
    counts: { tree: 6, bush: 3, rock: 2 } },
  { id: 'pins',  name: 'Île aux Pins',    x: 25,  y: 24, r: 12.5, grassAt: 0.26,
    counts: { tree: 48, bush: 4, flax: 3 } },
  { id: 'roc',   name: 'Le Rocher',       x: 103, y: 22, r: 10, grassAt: 0.30, rocky: true,
    counts: { rock: 30, tree: 2 } },
  { id: 'verte', name: 'Île Verte',       x: 58,  y: 80, r: 11, grassAt: 0.28,
    counts: { bush: 18, flax: 18, spring: 2, tree: 6 } },
  { id: 'sable', name: 'Îlot des Sables', x: 104, y: 69, r: 6.5, grassAt: 0.55,
    counts: { flax: 4, bush: 3, rock: 3 } },
];

function createWorld(seed) {
  const rand = mulberry32(seed);
  const n1 = makeNoise(rand), n2 = makeNoise(rand);
  const { W, H } = C;
  const tiles = new Uint8Array(W * H);
  const owner = new Int8Array(W * H).fill(-1);
  const height = new Float32Array(W * H);

  const isl = ISLANDS.map((d, i) => ({
    ...d, idx: i,
    x: d.x + (i === 0 ? 0 : Math.round((rand() - 0.5) * 8)),
    y: d.y + (i === 0 ? 0 : Math.round((rand() - 0.5) * 6)),
  }));

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let best = -9, bi = -1;
      for (const I of isl) {
        const d = Math.hypot(x + 0.5 - I.x, y + 0.5 - I.y);
        // Rayon irrégulier : baies et pointes, pour des côtes qui ne soient pas des cercles.
        const r = I.r * (0.68 + 0.62 * n1(x / 7 + I.idx * 17, y / 7 + I.idx * 5));
        const h = 1 - d / r;
        if (h > best) { best = h; bi = I.idx; }
      }
      const h = best + (n2(x / 3.2, y / 3.2) - 0.5) * 0.24;
      const i = x + y * W;
      height[i] = h;
      const I = isl[bi];
      let t;
      if (x < 2 || y < 2 || x >= W - 2 || y >= H - 2) t = TILE.DEEP;
      else if (h > I.grassAt) t = I.rocky && h > I.grassAt + 0.08 ? TILE.ROCK : TILE.GRASS;
      else if (h > 0.1) t = TILE.SAND;
      else if (h > -0.24) t = TILE.SHALLOW;
      else t = TILE.DEEP;
      tiles[i] = t;
      if (t >= TILE.SAND) owner[i] = bi;
    }
  }

  const at = (x, y) => (x < 0 || y < 0 || x >= W || y >= H ? TILE.DEEP : tiles[x + y * W]);

  // Camp au centre de l'île de départ, chantier naval sur la plage la plus proche.
  const home = isl[0];
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
  // S'assure que le camp est sur de l'herbe praticable.
  for (const k of ['chest', 'bench', 'fire']) {
    const i = Math.floor(camp[k].x) + Math.floor(camp[k].y) * W;
    if (tiles[i] < TILE.SAND) tiles[i] = TILE.GRASS;
  }

  // Placement des ressources.
  const used = new Set();
  const nodes = [];
  const keepClear = [camp.chest, camp.bench, camp.fire, camp.yard];
  const allowed = {
    tree: (t, h, I) => t === TILE.GRASS,
    rock: (t, h, I) => t === TILE.ROCK || (t === TILE.GRASS && h > I.grassAt + 0.05) || (I.id === 'sable' && t === TILE.SAND && h > 0.3),
    bush: (t) => t === TILE.GRASS,
    flax: (t, h, I) => t === TILE.GRASS || (I.id === 'sable' && t === TILE.SAND && h > 0.25),
    spring: (t, h, I) => t === TILE.GRASS && h > 0.55,
  };
  let nid = 1;
  for (const I of isl) {
    for (const kind of ['spring', 'rock', 'tree', 'bush', 'flax']) {
      const want = I.counts[kind] || 0;
      if (!want) continue;
      const cand = [];
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = x + y * W;
        if (owner[i] !== I.idx || used.has(i)) continue;
        if (!allowed[kind](tiles[i], height[i], I)) continue;
        if (keepClear.some((p) => Math.hypot(x + 0.5 - p.x, y + 0.5 - p.y) < 3.2)) continue;
        cand.push(i);
      }
      for (let k = cand.length - 1; k > 0; k--) { const j = Math.floor(rand() * (k + 1)); [cand[k], cand[j]] = [cand[j], cand[k]]; }
      let placed = 0;
      for (const i of cand) {
        if (placed >= want) break;
        if (used.has(i)) continue;
        const x = i % W, y = (i / W) | 0;
        // Les arbres et rochers gardent un peu d'espace pour qu'on circule entre eux.
        if ((kind === 'tree' || kind === 'rock') && rand() < 0.35 && [[1,0],[0,1],[-1,0],[0,-1]].some(([dx,dy]) => used.has(x+dx+(y+dy)*W))) continue;
        used.add(i);
        const jx = kind === 'spring' ? 0.5 : 0.3 + rand() * 0.4, jy = kind === 'spring' ? 0.5 : 0.3 + rand() * 0.4;
        nodes.push({ id: nid++, k: kind, x: +(x + jx).toFixed(2), y: +(y + jy).toFixed(2), amt: 0, rg: 0 });
        placed++;
      }
    }
  }

  return {
    W, H, tiles, seed,
    islands: isl.map((I) => ({ id: I.id, name: I.name, x: I.x, y: I.y, r: I.r })),
    nodes, camp,
  };
}

module.exports = { createWorld, mulberry32 };
