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
