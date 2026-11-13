// Serveur de L'Archipel : sert les fichiers du jeu et synchronise les parties en temps réel (WebSocket).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { Game } = require('./src/game');
const { C } = require('./public/shared.js');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const TICK_MS = 50;        // simulation à 20 Hz
const SNAP_EVERY = 2;      // état envoyé aux joueurs à 10 Hz
const RECONNECT_GRACE = 120_000;
const ROOM_TTL = 20 * 60_000;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/healthz') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('ok'); }
  if (url.pathname === '/preview.json') { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'public, max-age=3600' }); return res.end(previewJSON()); }
  let file = path.normalize(path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('Introuvable'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(data);
  });
});

const rooms = new Map(); // code -> Game

// Archipel d'exemple affiché derrière l'écran d'accueil.
let preview = null;
function previewJSON() {
  if (!preview) {
    const g = new Game('APERCU', 20261113);
    const p = g.initPayload({ id: 0, token: '' });
    preview = JSON.stringify({ W: p.W, H: p.H, tiles: p.tiles, currents: p.currents, islands: p.islands, camp: p.camp, phare: p.phare, sites: p.sites, nodes: p.nodes, boats: p.snap.boats, reefs: g.reefs.map((f) => f.i) });
  }
  return preview;
}

function newCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let c;
  do { c = Array.from({ length: 4 }, () => A[crypto.randomInt(A.length)]).join(''); } while (rooms.has(c));
  return c;
}

function cleanName(n) {
  const s = String(n || '').replace(/[^\p{L}\p{N} _'-]/gu, '').trim().slice(0, 16);
  return s || 'Naufragé';
}

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4096 });

wss.on('connection', (ws) => {
  ws.sendJSON = (o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  let game = null, player = null;
  let budget = 60; // limite simple de messages par seconde

  ws.on('message', (raw) => {
    if (--budget < 0) return;
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!game) {
      if (m.t !== 'join') return;
      let code = String(m.code || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
      if (m.create || !code) {
        code = newCode();
        rooms.set(code, new Game(code));
      }
      game = rooms.get(code);
      if (!game) { ws.sendJSON({ t: 'error', text: `Aucune partie avec le code ${code}. Vérifie le code ou crée une partie.` }); game = null; return; }
      // Reconnexion : on retrouve son naufragé grâce au jeton.
      const token = typeof m.token === 'string' ? m.token.slice(0, 40) : '';
      player = token ? [...game.players.values()].find((p) => p.token === token) : null;
      if (player) {
        if (player.ws && player.ws !== ws) player.ws.close();
        player.online = true; player.offlineAt = null;
        game.log(`${player.name} est de retour.`, 'join');
      } else {
        if (game.onlinePlayers().length >= C.MAX_PLAYERS) { ws.sendJSON({ t: 'error', text: 'Cette partie est complète (6 joueurs).' }); game = null; return; }
        player = game.addPlayer(cleanName(m.name), crypto.randomUUID());
      }
      player.ws = ws;
      player.lastPos = Date.now();
      ws.sendJSON(game.initPayload(player));
      return;
    }
    const r = game.handle(player, m);
    if (r === 'reinit') for (const p of game.players.values()) if (p.ws) p.ws.sendJSON(game.initPayload(p));
  });

  ws.on('close', () => {
    if (!game || !player || player.ws !== ws) return;
    player.ws = null; player.online = false; player.offlineAt = Date.now();
    game.leaveBoat(player, true);
    game.log(`${player.name} a perdu la connexion.`, 'leave');
    if (game.onlinePlayers().length === 0) game.emptySince = Date.now();
  });

  const refill = setInterval(() => { budget = 60; }, 1000);
  ws.on('close', () => clearInterval(refill));
});

let tickNo = 0;
let last = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = Math.min(0.25, (now - last) / 1000);
  last = now;
  tickNo++;
  for (const [code, g] of rooms) {
    for (const p of [...g.players.values()]) if (!p.online && now - p.offlineAt > RECONNECT_GRACE) g.removePlayer(p);
    if (g.onlinePlayers().length === 0) {
      if (g.emptySince && now - g.emptySince > ROOM_TTL) rooms.delete(code);
      continue; // le temps s'arrête quand personne n'est là
    }
    g.tick(dt);
    if (tickNo % SNAP_EVERY === 0) {
      const msg = JSON.stringify(g.snapshot(false));
      for (const p of g.players.values()) if (p.ws && p.ws.readyState === 1) p.ws.send(msg);
      g.flush();
    }
  }
}, TICK_MS);

// Détecte les connexions mortes.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false; ws.ping();
  }
}, 15_000);

server.listen(PORT, () => console.log(`L'Archipel écoute sur le port ${PORT}`));
