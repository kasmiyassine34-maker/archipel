// Tests des règles (sans navigateur) et d'une vraie connexion réseau avec deux joueurs simulés.
// Lancer avec : npm test
const assert = require('assert');
const { spawn } = require('child_process');
const path = require('path');
const WebSocket = require('ws');
const { Game } = require('../src/game');
const S = require('../public/shared.js');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('  ÉCHEC  ' + name + '\n' + e.stack); process.exitCode = 1; }
}
const fakeWs = () => { const out = []; return { out, sendJSON: (o) => out.push(o) }; };

console.log('Règles du jeu');

test('le monde a un camp, un ponton dans l\'eau et des ressources sur chaque île', () => {
  for (const seed of [1, 2, 3, 42, 1234, 99999]) {
    const g = new Game('TEST', seed);
    const c = g.camp;
    assert.ok(S.walkable(g.tileAt(c.chest.x, c.chest.y)), 'coffre sur terre');
    assert.ok(S.walkable(g.tileAt(c.fire.x, c.fire.y)), 'feu sur terre');
    assert.ok(S.boatable(g.tileAt(c.dock.x, c.dock.y)), 'ponton dans l\'eau');
    assert.ok(S.boatable(g.tileAt(g.boats[0].x, g.boats[0].y)), 'barque dans l\'eau');
    const kinds = new Set([...g.nodes.values()].map((n) => n.k));
    for (const k of ['tree', 'rock', 'bush', 'flax', 'spring']) assert.ok(kinds.has(k), `ressource ${k} (graine ${seed})`);
    for (const n of g.nodes.values()) assert.ok(S.walkable(g.tileAt(n.x, n.y)), 'ressource sur terre');
  }
});

test('on récolte, le sac se remplit puis se vide au coffre', () => {
  const g = new Game('TEST', 7);
  const p = g.addPlayer('Yassine', 't1'); p.ws = fakeWs();
  const tree = [...g.nodes.values()].find((n) => n.k === 'tree');
  p.x = tree.x + 0.5; p.y = tree.y;
  p.lastHarvest = 0;
  g.handle(p, { t: 'harvest', id: tree.id });
  assert.strictEqual(p.inv.bois, 1);
  assert.strictEqual(tree.amt, S.NODES.tree.max - 1);
  // Trop rapide : refusé.
  g.handle(p, { t: 'harvest', id: tree.id });
  assert.strictEqual(p.inv.bois, 1);
  // Trop loin : refusé.
  p.lastHarvest = 0; p.x += 5;
  g.handle(p, { t: 'harvest', id: tree.id });
  assert.strictEqual(p.inv.bois, 1);
  p.x = g.camp.chest.x + 1; p.y = g.camp.chest.y;
  const before = g.chest.bois;
  g.handle(p, { t: 'deposit' });
  assert.strictEqual(g.chest.bois, before + 1);
  assert.strictEqual(p.inv.bois, 0);
});

test('le sac est limité', () => {
  const g = new Game('TEST', 7);
  const p = g.addPlayer('A', 't'); p.ws = fakeWs();
  p.inv.pierre = S.C.SAC_CAP;
  const bush = [...g.nodes.values()].find((n) => n.k === 'bush');
  p.x = bush.x; p.y = bush.y; p.lastHarvest = 0;
  g.handle(p, { t: 'harvest', id: bush.id });
  assert.strictEqual(p.inv.nourriture, 0);
  assert.ok(p.ws.out.some((m) => m.t === 'note'));
});

test('fabriquer une hache coûte des ressources du coffre', () => {
  const g = new Game('TEST', 7);
  const p = g.addPlayer('A', 't'); p.ws = fakeWs();
  p.x = g.camp.bench.x; p.y = g.camp.bench.y + 1;
  g.chest.bois = 10; g.chest.pierre = 10;
  g.handle(p, { t: 'craft', id: 'hache' });
  assert.ok(p.tools.hache);
  assert.strictEqual(g.chest.bois, 6);
  assert.strictEqual(g.chest.pierre, 7);
  g.handle(p, { t: 'craft', id: 'hache' });
  assert.strictEqual(g.chest.bois, 6, 'pas de deuxième hache');
});

test('les pièces du navire se construisent dans l\'ordre puis on part ensemble', () => {
  const g = new Game('TEST', 7);
  const a = g.addPlayer('A', 'ta'); a.ws = fakeWs();
  const b = g.addPlayer('B', 'tb'); b.ws = fakeWs();
  for (const r of S.RES) g.chest[r] = 500;
  a.x = g.camp.yard.x; a.y = g.camp.yard.y;
  g.handle(a, { t: 'build', id: 'coque' });
  assert.ok(!g.parts.coque, 'la coque attend la quille');
  for (const part of S.PARTS) g.handle(a, { t: 'build', id: part.id });
  assert.ok(S.PARTS.every((x) => g.parts[x.id]));
  b.x = g.camp.yard.x + 30; b.y = g.camp.yard.y;
  g.handle(a, { t: 'launch' });
  assert.strictEqual(g.state, 'playing', 'B est trop loin');
  b.x = g.camp.yard.x + 1;
  g.handle(a, { t: 'launch' });
  assert.strictEqual(g.state, 'won');
});

test('la nuit, le froid blesse loin du feu, pas près du feu', () => {
  const g = new Game('TEST', 7);
  const a = g.addPlayer('A', 'ta'); a.ws = fakeWs();
  const b = g.addPlayer('B', 'tb'); b.ws = fakeWs();
  a.tools.torches = 0; b.tools.torches = 0;
  g.time = 0.8; g.fire.fuel = 300;
  a.x = g.fire.x + 1; a.y = g.fire.y;
  b.x = g.fire.x + 30; b.y = g.fire.y;
  for (let i = 0; i < 20; i++) g.tick(0.5);
  assert.ok(a.hp >= 99, 'A au chaud');
  assert.ok(b.hp < 90, 'B a froid');
});

test('un joueur à terre peut être relevé, et l\'équipe perd si tout le monde tombe', () => {
  const g = new Game('TEST', 7);
  const a = g.addPlayer('A', 'ta'); a.ws = fakeWs();
  const b = g.addPlayer('B', 'tb'); b.ws = fakeWs();
  b.hp = 0.1; b.faim = 0; b.soif = 0;
  g.tick(0.5);
  assert.ok(b.downed);
  a.x = b.x + 0.5; a.y = b.y;
  g.handle(a, { t: 'revive', id: b.id });
  assert.ok(!b.downed && b.hp > 0);
  a.hp = b.hp = 0.1; a.faim = b.faim = 0;
  g.tick(0.5);
  assert.strictEqual(g.state, 'lost');
});

test('barque : embarquer, ramer sur l\'eau seulement, charger la cale, débarquer', () => {
  const g = new Game('TEST', 7);
  const p = g.addPlayer('A', 't'); p.ws = fakeWs();
  const boat = g.boats[0];
  p.x = boat.x - 0.8; p.y = boat.y;
  p.inv.bois = 5;
  g.handle(p, { t: 'cargo', id: boat.id });
  assert.strictEqual(boat.hold.bois, 5);
  g.handle(p, { t: 'board', id: boat.id });
  assert.strictEqual(p.boat, boat.id);
  // Déplacement sur la terre refusé.
  p.lastPos = Date.now() - 200;
  g.handle(p, { t: 'pos', x: g.camp.chest.x, y: g.camp.chest.y });
  assert.notStrictEqual(boat.x, g.camp.chest.x);
  // Petit déplacement sur l'eau accepté.
  const ox = boat.x, oy = boat.y;
  for (const [dx, dy] of [[0.3, 0], [-0.3, 0], [0, 0.3], [0, -0.3]]) {
    if (S.boatable(g.tileAt(ox + dx, oy + dy))) {
      p.lastPos = Date.now() - 200;
      g.handle(p, { t: 'pos', x: ox + dx, y: oy + dy, a: 0 });
      assert.strictEqual(boat.x, ox + dx); break;
    }
  }
  g.handle(p, { t: 'leave' });
  assert.strictEqual(p.boat, null);
  assert.ok(S.walkable(g.tileAt(p.x, p.y)));
});

test('feu : le bois du sac l\'alimente', () => {
  const g = new Game('TEST', 7);
  const p = g.addPlayer('A', 't'); p.ws = fakeWs();
  p.x = g.fire.x + 1; p.y = g.fire.y; p.inv.bois = 3; g.fire.fuel = 10;
  g.handle(p, { t: 'fuel' });
  assert.strictEqual(g.fire.fuel, 10 + 3 * S.C.FIRE_PER_WOOD);
  assert.strictEqual(p.inv.bois, 0);
});

console.log('Nouveau gameplay');
const tick = (g, secs, step = 0.05) => { for (let t = 0; t < secs; t += step) g.tick(step); };
const landNear = (g, x, y, rmin = 0.8, rmax = 3) => {
  for (let r = rmin; r <= rmax; r += 0.2) for (let a = 0; a < 6.28; a += 0.2) {
    const px = x + Math.cos(a) * r, py = y + Math.sin(a) * r;
    if (S.isLand(g.tileAt(px, py))) return { x: px, y: py };
  }
  return null;
};

test('la carte part blanche : seule l\'île du camp est connue, et on dessine en explorant', () => {
  const g = new Game('TEST', 11);
  const p = g.addPlayer('A', 't'); p.ws = fakeWs();
  assert.deepStrictEqual([...g.discovered], [0]);
  const far = g.world.islands.find((I) => I.ring === 2);
  const i = Math.floor(far.x) + Math.floor(far.y) * g.world.W;
  assert.strictEqual(g.seen[i], 0, 'île lointaine encore blanche');
  p.x = far.x; p.y = far.y;
  tick(g, 0.3);
  assert.strictEqual(g.seen[i], 1, 'tuiles aperçues');
  assert.ok(g.discovered.has(far.idx), 'île cartographiée');
  assert.ok(g.newSeen.length > 0, 'les nouvelles tuiles partent aux joueurs');
});

test('le monde : 11 îles, 7 fragments, le Phare et son Gardien, pour de nombreuses graines', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const g = new Game('TEST', seed);
    assert.ok(g.world.islands.length >= 10, `îles (graine ${seed})`);
    const frags = [...g.sites.values()].filter((s) => s.frag).map((s) => s.frag).sort();
    assert.deepStrictEqual(frags, [1, 2, 3, 4, 5, 6, 7], `fragments (graine ${seed})`);
    assert.ok(g.lantern && S.walkable(g.tileAt(g.lantern.x, g.lantern.y)), 'lanterne sur terre');
    assert.ok([...g.beasts.values()].some((b) => b.k === 'gardien'), 'gardien');
    for (const s of g.sites.values()) assert.ok(S.isLand(g.tileAt(s.x, s.y)), `site ${s.k} sur terre (graine ${seed})`);
  }
});

test('combat : la carapace du crabe encaisse de face, le dos est vulnérable, la viande va au chasseur', () => {
  const g = new Game('TEST', 7);
  const p = g.addPlayer('A', 't'); p.ws = fakeWs(); p.role = 'chasseur';
  const crab = [...g.beasts.values()].find((b) => b.k === 'crabe');
  crab.st = 0; crab.a = 0; // regarde vers l'est
  p.x = crab.x + 1; p.y = crab.y;
  p.atkAt = 0;
  g.handle(p, { t: 'atk', a: Math.PI });
  const front = crab.mhp - crab.hp;
  crab.hp = crab.mhp; crab.a = 0;
  p.x = crab.x - 1; p.atkAt = 0;
  g.handle(p, { t: 'atk', a: 0 });
  const back = crab.mhp - crab.hp;
  assert.ok(front > 0 && back > front * 2, `face ${front} < dos ${back}`);
  crab.hp = 1; p.atkAt = 0; crab.a = 0;
  g.handle(p, { t: 'atk', a: 0 });
  assert.ok(crab.dead);
  assert.strictEqual(p.inv.viande, 2, 'chasseur : double viande');
});

test('esquive : on ne prend pas de coup pendant l\'esquive', () => {
  const g = new Game('TEST', 7);
  const p = g.addPlayer('A', 't'); p.ws = fakeWs();
  const crab = [...g.beasts.values()].find((b) => b.k === 'crabe');
  g.hurt(p, 10, crab);
  assert.strictEqual(p.hp, 90);
  g.handle(p, { t: 'dodge' });
  g.hurt(p, 10, crab);
  assert.strictEqual(p.hp, 90, 'esquivé');
});

test('les bêtes n\'approchent pas du feu de camp allumé', () => {
  const g = new Game('TEST', 7);
  const crab = [...g.beasts.values()].find((b) => b.k === 'crabe');
  assert.ok(!g.beastCanWalk(crab, g.fire.x + 1, g.fire.y));
  g.fire.fuel = 0;
  const t = g.tileAt(g.fire.x + 1, g.fire.y);
  assert.strictEqual(g.beastCanWalk(crab, g.fire.x + 1, g.fire.y), t === S.TILE.SAND || t === S.TILE.SHALLOW || t === S.TILE.GRASS);
});

test('fragments : un carnet se lit, une stèle se relève à deux, une ruine s\'ouvre avec deux leviers', () => {
  const g = new Game('TEST', 3);
  const a = g.addPlayer('A', 'ta'); a.ws = fakeWs();
  const b = g.addPlayer('B', 'tb'); b.ws = fakeWs();
  const carnet = [...g.sites.values()].find((s) => s.k === 'carnet');
  a.x = carnet.x + 0.5; a.y = carnet.y; b.x = g.fire.x; b.y = g.fire.y;
  for (let t = 0; t < S.C.READ_TIME + 0.5; t += 0.2) { g.handle(a, { t: 'work', id: carnet.id }); tick(g, 0.2); }
  assert.ok(carnet.done && g.frags.has(carnet.frag), 'carnet lu');
  const stele = [...g.sites.values()].find((s) => s.k === 'stele');
  a.x = stele.x + 0.5; a.y = stele.y;
  for (let t = 0; t < S.C.LIFT_TIME + 1; t += 0.2) { g.handle(a, { t: 'work', id: stele.id }); tick(g, 0.2); }
  assert.ok(!stele.done, 'seul, la stèle ne bouge pas');
  b.x = stele.x - 0.5; b.y = stele.y;
  for (let t = 0; t < S.C.LIFT_TIME + 1; t += 0.2) { g.handle(a, { t: 'work', id: stele.id }); g.handle(b, { t: 'work', id: stele.id }); tick(g, 0.2); }
  assert.ok(stele.done, 'à deux, elle se relève');
  const ruine = [...g.sites.values()].find((s) => s.k === 'ruine');
  a.x = ruine.levers[0].x; a.y = ruine.levers[0].y;
  g.handle(a, { t: 'work', id: ruine.id, l: 0 });
  tick(g, 0.2);
  assert.ok(!ruine.open, 'un seul levier ne suffit pas');
  b.x = ruine.levers[1].x; b.y = ruine.levers[1].y;
  g.handle(a, { t: 'work', id: ruine.id, l: 0 }); g.handle(b, { t: 'work', id: ruine.id, l: 1 });
  tick(g, 0.1);
  assert.ok(ruine.open, 'deux leviers ouvrent la porte');
});

test('le banc de brume bloque la barque tant qu\'il manque des fragments', () => {
  const g = new Game('TEST', 5);
  const p = g.addPlayer('A', 't'); p.ws = fakeWs();
  const boat = g.boats[0];
  const ph = g.world.phare;
  // Une case d'eau juste à l'intérieur du banc.
  let spot = null;
  for (let a = 0; a < 6.28 && !spot; a += 0.05) {
    const x = ph.x + Math.cos(a) * (ph.zone - 0.5), y = ph.y + Math.sin(a) * (ph.zone - 0.5);
    if (S.boatable(g.tileAt(x, y)) && S.boatable(g.tileAt(x + Math.cos(a), y + Math.sin(a)))) spot = { x, y, a };
  }
  boat.x = spot.x + Math.cos(spot.a) * 0.6; boat.y = spot.y + Math.sin(spot.a) * 0.6;
  boat.seats = [p.id]; p.boat = boat.id; p.x = boat.x; p.y = boat.y;
  p.lastPos = Date.now() - 300;
  g.handle(p, { t: 'pos', x: spot.x, y: spot.y, a: 0 });
  assert.notStrictEqual(boat.x, spot.x, 'refusé sans fragments');
  for (let n = 1; n <= 3; n++) g.frags.add(n);
  p.lastPos = Date.now() - 300;
  g.handle(p, { t: 'pos', x: spot.x, y: spot.y, a: 0 });
  assert.strictEqual(boat.x, spot.x, 'accepté avec trois fragments');
});

test('récifs et tempêtes abîment la coque, et une barque qui coule rejette l\'équipage sur la côte', () => {
  const g = new Game('TEST', 5);
  const p = g.addPlayer('A', 't'); p.ws = fakeWs();
  const boat = g.boats[0];
  const reef = g.reefs[0];
  boat.x = reef.x - 0.3; boat.y = reef.y; boat.seats = [p.id]; p.boat = boat.id; p.x = boat.x; p.y = boat.y;
  p.lastPos = Date.now() - 200;
  g.handle(p, { t: 'pos', x: reef.x, y: reef.y, a: 0 });
  assert.strictEqual(boat.hull, S.C.HULL - S.C.REEF_DMG, 'choc sur le récif');
  assert.ok(g.spotted.has(reef.i), 'le récif est repéré');
  boat.hull = 1;
  g.sink(boat, 'Test');
  assert.strictEqual(p.boat, null);
  assert.ok(S.isLand(g.tileAt(p.x, p.y)), 'échoué sur la terre');
  assert.ok(boat.hull > 0 && boat.seats.length === 0, 'la barque revient au ponton');
  g.weather = { st: 'tempete', t: 30, next: 0, wx: 1, wy: 0 };
  let deep = null;
  for (let i = 0; i < g.world.tiles.length && !deep; i++) if (g.world.tiles[i] === S.TILE.DEEP && i % g.world.W > 5) deep = { x: (i % g.world.W) + 0.5, y: Math.floor(i / g.world.W) + 0.5 };
  boat.x = deep.x; boat.y = deep.y; boat.seats = [p.id]; p.boat = boat.id;
  const h = boat.hull;
  tick(g, 2);
  assert.ok(boat.hull < h, 'la tempête abîme la coque en haute mer');
});

test('fins : étouffer la flamme noire donne « La vérité », le rituel ouvre un vote', () => {
  const g = new Game('TEST', 5);
  const a = g.addPlayer('A', 'ta'); a.ws = fakeWs();
  for (let n = 1; n <= 3; n++) g.frags.add(n);
  a.x = g.lantern.x + 0.5; a.y = g.lantern.y;
  for (let t = 0; t < S.C.DOUSE_TIME + 0.5; t += 0.2) { g.handle(a, { t: 'work', id: g.lantern.id }); g.tickSites(0.2, Date.now()); }
  assert.strictEqual(g.state, 'won'); assert.strictEqual(g.ending, 'verite');

  const h = new Game('TEST', 5);
  const x = h.addPlayer('X', 'tx'); x.ws = fakeWs();
  const y = h.addPlayer('Y', 'ty'); y.ws = fakeWs();
  for (let n = 1; n <= 7; n++) h.frags.add(n);
  x.x = h.lantern.x + 0.5; x.y = h.lantern.y; y.x = h.lantern.x - 0.5; y.y = h.lantern.y;
  h.handle(x, { t: 'ritual' });
  assert.strictEqual(h.state, 'playing', 'le Gardien veille encore');
  h.gardienDead = true;
  h.handle(x, { t: 'ritual' });
  assert.strictEqual(h.state, 'playing', 'il manque les ressources');
  x.inv.bois = 6; y.inv.pierre = 3; y.inv.eau = 3;
  h.handle(x, { t: 'ritual' });
  assert.strictEqual(h.state, 'choice');
  h.handle(x, { t: 'vote', v: 'rester' });
  assert.strictEqual(h.state, 'choice', 'on attend tout le monde');
  h.handle(y, { t: 'vote', v: 'rester' });
  assert.strictEqual(h.state, 'won'); assert.strictEqual(h.ending, 'veilleurs_rester');
});

test('métiers : uniques dans l\'équipe ; l\'herboriste soigne les autres', () => {
  const g = new Game('TEST', 7);
  const a = g.addPlayer('A', 'ta'); a.ws = fakeWs();
  const b = g.addPlayer('B', 'tb'); b.ws = fakeWs();
  g.handle(a, { t: 'role', r: 'herboriste' });
  g.handle(b, { t: 'role', r: 'herboriste' });
  assert.strictEqual(a.role, 'herboriste'); assert.strictEqual(b.role, null);
  b.hp = 40; b.x = a.x + 0.5; b.y = a.y;
  g.handle(a, { t: 'heal', id: b.id });
  assert.strictEqual(b.hp, 70);
});

test('la fronde tire une pierre du sac qui touche une bête à distance', () => {
  const g = new Game('TEST', 7);
  const p = g.addPlayer('A', 't'); p.ws = fakeWs();
  p.tools.fronde = true; p.weapon = 'fronde'; p.inv.pierre = 2;
  const v = [...g.beasts.values()].find((b) => b.k === 'varan');
  v.st = 0;
  for (const b of [...g.beasts.values()]) if (b !== v) g.beasts.delete(b.id);
  p.x = v.x - 4; p.y = v.y + 0.3;
  g.handle(p, { t: 'atk', a: Math.atan2(v.y - (p.y - 0.3), v.x - p.x) });
  assert.strictEqual(p.inv.pierre, 1);
  for (let i = 0; i < 10; i++) g.tickProjectiles(0.05);
  assert.ok(v.hp < v.mhp, 'touché');
});

// ---------------------------------------------------------------- réseau
async function networkTest() {
  console.log('Réseau (deux joueurs simulés)');
  const PORT = 3999;
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(PORT) }, stdio: 'pipe' });
  await new Promise((r) => srv.stdout.once('data', r));
  const open = (join) => new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
    const box = { ws, msgs: [], init: null, last: null };
    ws.on('open', () => ws.send(JSON.stringify(join)));
    ws.on('message', (d) => {
      const m = JSON.parse(d); box.msgs.push(m);
      if (m.t === 'init') { box.init = m; resolve(box); }
      if (m.t === 's') box.last = m;
      if (m.t === 'error') resolve(Object.assign(box, { error: m.text }));
    });
    ws.on('error', reject);
  });
  try {
    const a = await open({ t: 'join', create: true, name: 'Yassine' });
    assert.ok(a.init && /^[A-Z]{4}$/.test(a.init.code), 'code de partie');
    const b = await open({ t: 'join', code: a.init.code, name: 'Ami' });
    assert.ok(b.init, 'le deuxième joueur rejoint');
    const bad = await open({ t: 'join', code: 'ZZZZ', name: 'X' });
    assert.ok(bad.error, 'code inconnu refusé');
    bad.ws.close();
    await new Promise((r) => setTimeout(r, 400));
    assert.strictEqual(a.last.players.length, 2, 'A voit deux joueurs');
    // A se déplace un peu : B le voit bouger.
    const pa = a.last.players.find((p) => p.id === a.init.you);
    a.ws.send(JSON.stringify({ t: 'pos', x: pa.x + 0.3, y: pa.y, d: 0 }));
    await new Promise((r) => setTimeout(r, 300));
    const seen = b.last.players.find((p) => p.id === a.init.you);
    assert.ok(Math.abs(seen.x - (pa.x + 0.3)) < 0.02, 'B voit A bouger');
    // Téléportation refusée.
    a.ws.send(JSON.stringify({ t: 'pos', x: pa.x + 20, y: pa.y, d: 0 }));
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(a.msgs.some((m) => m.t === 'correct'), 'position corrigée');
    // Reconnexion avec le jeton.
    const token = a.init.token, code = a.init.code, id = a.init.you;
    a.ws.close();
    await new Promise((r) => setTimeout(r, 200));
    const a2 = await open({ t: 'join', code, token, name: 'Yassine' });
    assert.strictEqual(a2.init.you, id, 'on retrouve son naufragé');
    passed += 1; console.log('  ok  connexion, synchronisation, triche refusée, reconnexion');
    a2.ws.close(); b.ws.close();
  } catch (e) {
    console.error('  ÉCHEC  réseau\n' + e.stack); process.exitCode = 1;
  } finally { srv.kill(); }
}

networkTest().then(() => console.log(`\n${passed} test(s) réussi(s)${process.exitCode ? ', avec des échecs' : ''}.`));
