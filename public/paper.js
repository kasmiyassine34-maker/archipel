// L'Archipel : rendu « carnet de cartographe ».
// La carte est peinte une fois, pixel par pixel : papier ancien, lavis d'aquarelle,
// trait de côte à l'encre, courbes de profondeur, pointillés de plage et hachures de roche.
(function (root) {
  'use strict';
  const PX = 20; // pixels de carte par tuile

  // Encre et lavis. Les lavis sont des facteurs multipliés au papier, comme une aquarelle.
  const INK = [46, 36, 26];
  const RED = [158, 58, 36];
  const PAPER = [238, 226, 197];
  const WASH = {
    seaNear: [176, 206, 198], seaFar: [118, 160, 166],
    sand: [246, 228, 182], grass: [196, 204, 150], forest: [164, 182, 128], rock: [206, 198, 182],
  };
  const PALETTE = {
    ink: 'rgb(46,36,26)', inkSoft: 'rgba(46,36,26,.55)', red: 'rgb(158,58,36)', paper: 'rgb(238,226,197)',
    paperDark: 'rgb(222,206,170)', sea: 'rgb(132,170,172)', blue: 'rgb(58,98,128)',
    wood: 'rgb(150,104,62)', woodDark: 'rgb(104,70,40)', leaf: 'rgb(132,156,88)', leafDark: 'rgb(98,124,66)',
    pine: 'rgb(92,120,80)', stone: 'rgb(170,162,148)', fire: 'rgb(214,120,48)', flame: 'rgb(236,178,74)',
    berry: 'rgb(176,52,42)', flax: 'rgb(88,124,170)', skin: 'rgb(232,200,160)',
  };

  // ---------------------------------------------------------------- bruit
  function hash(x, y, s = 0) {
    let h = (x * 374761393 + y * 668265263 + s * 2147483647) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }
  function makeNoise(seed) {
    const N = 128, g = new Float32Array(N * N);
    for (let i = 0; i < g.length; i++) g[i] = hash(i % N, (i / N) | 0, seed);
    return (x, y) => {
      const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
      const a = ((xi % N) + N) % N, b = ((yi % N) + N) % N, a1 = (a + 1) % N, b1 = (b + 1) % N;
      const u = xf * xf * (3 - 2 * xf), w = yf * yf * (3 - 2 * yf);
      const v00 = g[a + b * N], v10 = g[a1 + b * N], v01 = g[a + b1 * N], v11 = g[a1 + b1 * N];
      return (v00 + (v10 - v00) * u) + ((v01 + (v11 - v01) * u) - (v00 + (v10 - v00) * u)) * w;
    };
  }
  const n1 = makeNoise(11), n2 = makeNoise(23), n3 = makeNoise(37);
  const fbm = (x, y) => n1(x, y) * 0.6 + n2(x * 2.1, y * 2.1) * 0.3 + n3(x * 4.3, y * 4.3) * 0.1;

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const smooth = (a, b, v) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

  // Distance signée (en tuiles) à une région : négative dedans, positive dehors.
  function signedField(W, H, inside) {
    const INF = 1e9;
    const dIn = new Float32Array(W * H), dOut = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) { dIn[i] = inside[i] ? INF : 0; dOut[i] = inside[i] ? 0 : INF; }
    const chamfer = (d) => {
      const s2 = Math.SQRT2;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = x + y * W; let v = d[i];
        if (x > 0) v = Math.min(v, d[i - 1] + 1);
        if (y > 0) { v = Math.min(v, d[i - W] + 1); if (x > 0) v = Math.min(v, d[i - W - 1] + s2); if (x < W - 1) v = Math.min(v, d[i - W + 1] + s2); }
        d[i] = v;
      }
      for (let y = H - 1; y >= 0; y--) for (let x = W - 1; x >= 0; x--) {
        const i = x + y * W; let v = d[i];
        if (x < W - 1) v = Math.min(v, d[i + 1] + 1);
        if (y < H - 1) { v = Math.min(v, d[i + W] + 1); if (x < W - 1) v = Math.min(v, d[i + W + 1] + s2); if (x > 0) v = Math.min(v, d[i + W - 1] + s2); }
        d[i] = v;
      }
    };
    chamfer(dIn); chamfer(dOut);
    const f = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) f[i] = inside[i] ? -(dIn[i] - 0.5) : dOut[i] - 0.5;
    return f;
  }
  function sampler(W, H, f) {
    return (x, y) => { // x, y en tuiles ; centres des tuiles en +0.5
      const fx = clamp(x - 0.5, 0, W - 1.001), fy = clamp(y - 0.5, 0, H - 1.001);
      const xi = fx | 0, yi = fy | 0, u = fx - xi, v = fy - yi, i = xi + yi * W;
      const a = f[i], b = f[i + 1], c = f[i + W], d = f[i + W + 1];
      return (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v;
    };
  }

  // ---------------------------------------------------------------- carte
  // world: { W, H, tiles, islands }. scale: pixels par tuile.
  function paintMap(world, scale = PX, opts = {}) {
    const { W, H, tiles } = world;
    const T = { DEEP: 0, SHALLOW: 1, SAND: 2, GRASS: 3, ROCK: 4 };
    const land = new Uint8Array(W * H), green = new Uint8Array(W * H), rock = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) { land[i] = tiles[i] >= T.SAND; green[i] = tiles[i] >= T.GRASS; rock[i] = tiles[i] === T.ROCK; }
    const sdLand = sampler(W, H, signedField(W, H, land));
    const sdGreen = sampler(W, H, signedField(W, H, green));
    const sdRock = sampler(W, H, signedField(W, H, rock));
    const pines = world.islands.find((I) => I.id === 'pins');

    const cw = W * scale, ch = H * scale;
    const c = document.createElement('canvas'); c.width = cw; c.height = ch;
    const g = c.getContext('2d');
    const img = g.createImageData(cw, ch);
    const d = img.data;
    const inv = 1 / scale;
    const lineW = 0.9 / scale; // demi-épaisseur d'un trait en tuiles

    for (let py = 0; py < ch; py++) {
      const ty = (py + 0.5) * inv;
      for (let px = 0; px < cw; px++) {
        const tx = (px + 0.5) * inv;
        const wob = (fbm(tx * 0.45, ty * 0.45) - 0.5) * 0.9 + (n3(tx * 2.2, ty * 2.2) - 0.5) * 0.18;
        const s = sdLand(tx, ty) + wob;
        // Papier : grain fin, fibres et grandes taches.
        const grain = 1 + (hash(px, py, 5) - 0.5) * 0.05 + (n2(tx * 3, ty * 0.6) - 0.5) * 0.03;
        const stain = 1 - smooth(0.62, 0.9, n1(tx * 0.08 + 40, ty * 0.08)) * 0.1;
        let r = PAPER[0] * grain * stain, gg = PAPER[1] * grain * stain, b = PAPER[2] * grain * stain;
        let wr, wg, wb;
        const tone = (n2(tx * 0.3 + 9, ty * 0.3) - 0.5) * 0.08; // irrégularité du lavis
        if (s > 0) {
          const k = smooth(0, 7, s);
          wr = WASH.seaNear[0] + (WASH.seaFar[0] - WASH.seaNear[0]) * k;
          wg = WASH.seaNear[1] + (WASH.seaFar[1] - WASH.seaNear[1]) * k;
          wb = WASH.seaNear[2] + (WASH.seaFar[2] - WASH.seaNear[2]) * k;
          const pool = s < 0.5 ? (1 - s / 0.5) * 0.09 : 0; // l'aquarelle se dépose au bord
          const f = (1 - pool + tone) / 255;
          r *= wr * f; gg *= wg * f; b *= wb * f;
        } else {
          const sg = sdGreen(tx, ty) + wob * 0.8;
          const sr = sdRock(tx, ty) + wob * 0.7;
          let w = WASH.sand;
          if (sg < 0) w = pines && Math.hypot(tx - pines.x, ty - pines.y) < pines.r * 1.5 ? WASH.forest : WASH.grass;
          if (sr < 0) w = WASH.rock;
          const edge = (s > -0.35 ? (1 + s / 0.35) * 0.06 : 0) + (sg < 0 && sg > -0.3 ? (1 + sg / 0.3) * 0.06 : 0);
          const f = (1 - edge + tone) / 255;
          r *= w[0] * f; gg *= w[1] * f; b *= w[2] * f;
          let ink = 0;
          // Pointillés de plage.
          if (sg > 0.1 && hash(px, py, 9) < 0.016) ink = 0.32;
          // Hachures de roche.
          if (sr < -0.1 && ((px - py) % 6 + 6) % 6 === 0 && n3(tx * 1.5, ty * 1.5) > 0.35) ink = Math.max(ink, 0.3);
          // Trait léger en lisière de l'herbe.
          const gl = 1 - Math.abs(sg) / (lineW * 1.1);
          if (gl > 0 && n1(tx * 3, ty * 3) > 0.3) ink = Math.max(ink, gl * 0.28);
          if (ink) { r += (INK[0] - r) * ink; gg += (INK[1] - gg) * ink; b += (INK[2] - b) * ink; }
        }
        // Trait de côte, puis courbes de profondeur parallèles au rivage.
        let ink = clamp(1 - Math.abs(s) / (lineW * 1.6), 0, 1) * 0.92;
        if (s > 0) {
          for (const [k, a] of [[0.55, 0.42], [1.15, 0.3], [1.9, 0.2], [2.9, 0.12]]) {
            const l = 1 - Math.abs(s - k) / lineW;
            if (l > 0 && n3(tx * 0.9 + k * 7, ty * 0.9) > 0.28) ink = Math.max(ink, l * a);
          }
        }
        if (ink > 0) { r += (INK[0] - r) * ink; gg += (INK[1] - gg) * ink; b += (INK[2] - b) * ink; }
        const o = (px + py * cw) * 4;
        d[o] = r; d[o + 1] = gg; d[o + 2] = b; d[o + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    // Touffes d'herbe tracées à la plume, et quelques cailloux sur les plages.
    g.strokeStyle = 'rgba(46,36,26,.38)'; g.lineWidth = Math.max(0.6, scale / 26); g.lineCap = 'round';
    g.beginPath();
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const t = tiles[x + y * W];
      if (t !== T.GRASS) continue;
      for (let k = 0; k < 2; k++) {
        if (hash(x, y, 60 + k) > 0.3) continue;
        const tx = x + 0.15 + hash(x, y, 70 + k) * 0.7, ty = y + 0.2 + hash(x, y, 80 + k) * 0.6;
        if (sdGreen(tx, ty) > -0.4) continue;
        const px = tx * scale, py = ty * scale, u = scale * 0.11;
        g.moveTo(px - u, py); g.lineTo(px - u * 1.4, py - u * 1.3);
        g.moveTo(px, py); g.lineTo(px, py - u * 1.7);
        g.moveTo(px + u, py); g.lineTo(px + u * 1.4, py - u * 1.3);
      }
    }
    g.stroke();
    if (opts.vignette) {
      const gr = g.createRadialGradient(cw / 2, ch / 2, Math.min(cw, ch) * 0.35, cw / 2, ch / 2, Math.max(cw, ch) * 0.75);
      gr.addColorStop(0, 'rgba(90,60,30,0)'); gr.addColorStop(1, 'rgba(90,60,30,0.28)');
      g.fillStyle = gr; g.fillRect(0, 0, cw, ch);
    }
    return c;
  }

  // ---------------------------------------------------------------- dessin à l'encre
  // Petits outils pour dessiner « à la main » : traits légèrement tremblés.
  function wobblyCircle(g, x, y, r, seed, wob = 0.12, steps = 14) {
    g.beginPath();
    for (let i = 0; i <= steps; i++) {
      const a = (i / steps) * Math.PI * 2;
      const rr = r * (1 + (hash(seed, i % steps, 3) - 0.5) * wob * 2);
      const px = x + Math.cos(a) * rr, py = y + Math.sin(a) * rr;
      if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
    }
    g.closePath();
  }
  function wobblyPoly(g, pts, seed, wob = 0.35) {
    g.beginPath();
    pts.forEach(([x, y], i) => {
      const jx = (hash(seed, i, 7) - 0.5) * wob, jy = (hash(seed, i, 8) - 0.5) * wob;
      if (i === 0) g.moveTo(x + jx, y + jy); else g.lineTo(x + jx, y + jy);
    });
    g.closePath();
  }
  function hatch(g, x0, y0, x1, y1, step, len) {
    g.beginPath();
    for (let x = x0; x <= x1; x += step) { g.moveTo(x, y0); g.lineTo(x - len, y1); }
    g.stroke();
  }

  // Compas (rose des vents) dessiné à l'encre.
  function compass(g, x, y, r) {
    g.save(); g.translate(x, y);
    g.strokeStyle = PALETTE.ink; g.lineWidth = Math.max(1, r / 40);
    g.beginPath(); g.arc(0, 0, r, 0, Math.PI * 2); g.stroke();
    g.beginPath(); g.arc(0, 0, r * 0.86, 0, Math.PI * 2); g.stroke();
    for (let i = 0; i < 32; i++) {
      const a = (i / 32) * Math.PI * 2, l = i % 8 === 0 ? 0.14 : i % 4 === 0 ? 0.1 : 0.06;
      g.beginPath(); g.moveTo(Math.cos(a) * r * 0.86, Math.sin(a) * r * 0.86); g.lineTo(Math.cos(a) * r * (0.86 - l), Math.sin(a) * r * (0.86 - l)); g.stroke();
    }
    const point = (a, len, w, fillA, fillB) => {
      const cx = Math.cos(a), cy = Math.sin(a), nx = -cy, ny = cx;
      g.beginPath(); g.moveTo(0, 0); g.lineTo(cx * len, cy * len); g.lineTo(nx * w, ny * w); g.closePath();
      g.fillStyle = fillA; g.fill(); g.stroke();
      g.beginPath(); g.moveTo(0, 0); g.lineTo(cx * len, cy * len); g.lineTo(-nx * w, -ny * w); g.closePath();
      g.fillStyle = fillB; g.fill(); g.stroke();
    };
    for (let i = 0; i < 4; i++) point(Math.PI / 4 + i * Math.PI / 2, r * 0.55, r * 0.09, PALETTE.paper, PALETTE.inkSoft);
    for (let i = 0; i < 4; i++) point(-Math.PI / 2 + i * Math.PI / 2, r * 0.8, r * 0.13, i === 0 ? PALETTE.red : PALETTE.paper, PALETTE.ink);
    g.fillStyle = PALETTE.paper; g.beginPath(); g.arc(0, 0, r * 0.06, 0, Math.PI * 2); g.fill(); g.stroke();
    g.fillStyle = PALETTE.ink; g.font = `${Math.round(r * 0.26)}px "IM Fell English", Georgia, serif`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('N', 0, -r * 1.15); g.fillText('S', 0, r * 1.15); g.fillText('E', r * 1.15, 0); g.fillText('O', -r * 1.15, 0);
    g.restore();
  }

  // Icônes des ressources (24 px, encre et lavis).
  function icons() {
    const out = {};
    const make = (fn) => {
      const c = document.createElement('canvas'); c.width = c.height = 48;
      const g = c.getContext('2d'); g.scale(2, 2);
      g.lineWidth = 1.3; g.lineJoin = 'round'; g.lineCap = 'round'; g.strokeStyle = PALETTE.ink;
      fn(g); return c.toDataURL();
    };
    out.bois = make((g) => {
      g.fillStyle = PALETTE.wood; wobblyPoly(g, [[3, 9], [19, 7], [21, 13], [5, 16]], 1, 0.6); g.fill(); g.stroke();
      g.fillStyle = 'rgb(222,190,140)'; g.beginPath(); g.ellipse(20, 10, 2, 3, -0.2, 0, Math.PI * 2); g.fill(); g.stroke();
      g.beginPath(); g.moveTo(7, 11); g.lineTo(15, 10); g.stroke();
    });
    out.pierre = make((g) => {
      g.fillStyle = PALETTE.stone; wobblyPoly(g, [[4, 17], [5, 9], [11, 5], [18, 7], [21, 14], [17, 19]], 2, 0.5); g.fill(); g.stroke();
      g.lineWidth = 0.8; hatch(g, 13, 11, 19, 17, 2.2, 3);
    });
    out.fibre = make((g) => {
      g.strokeStyle = 'rgb(96,120,64)';
      for (const x of [7, 10, 13, 16]) { g.beginPath(); g.moveTo(x, 21); g.quadraticCurveTo(x - 1, 12, x + 1, 4); g.stroke(); }
      g.strokeStyle = PALETTE.ink; g.fillStyle = 'rgb(214,190,120)'; g.fillRect(5, 13, 14, 3); g.strokeRect(5, 13, 14, 3);
    });
    out.nourriture = make((g) => {
      g.fillStyle = PALETTE.berry; wobblyCircle(g, 12, 14, 7, 4, 0.06); g.fill(); g.stroke();
      g.fillStyle = 'rgba(255,220,200,.6)'; g.beginPath(); g.arc(9.5, 11.5, 1.8, 0, Math.PI * 2); g.fill();
      g.strokeStyle = PALETTE.ink; g.beginPath(); g.moveTo(12, 7); g.lineTo(13, 3); g.stroke();
      g.fillStyle = PALETTE.leaf; g.beginPath(); g.ellipse(16, 5, 3, 1.6, -0.4, 0, Math.PI * 2); g.fill(); g.stroke();
    });
    out.eau = make((g) => {
      g.fillStyle = 'rgb(120,166,196)';
      g.beginPath(); g.moveTo(12, 3); g.bezierCurveTo(14, 8, 19, 11, 19, 15); g.arc(12, 15, 7, 0, Math.PI); g.bezierCurveTo(5, 11, 10, 8, 12, 3); g.closePath(); g.fill(); g.stroke();
      g.strokeStyle = 'rgba(255,255,255,.8)'; g.beginPath(); g.arc(12, 15, 4, Math.PI * 0.9, Math.PI * 1.3); g.stroke();
    });
    return out;
  }

  root.PAPER_ART = { PX, PALETTE, INK, hash, makeNoise, fbm, paintMap, wobblyCircle, wobblyPoly, hatch, compass, icons };
})(window);
