// Règles et constantes partagées entre le serveur (Node) et le navigateur.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ARCHIPEL = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const TILE = { DEEP: 0, SHALLOW: 1, SAND: 2, GRASS: 3, ROCK: 4 };

  const RES = ['bois', 'pierre', 'fibre', 'nourriture', 'eau', 'ferraille'];
  const RES_LABEL = { bois: 'Bois', pierre: 'Pierre', fibre: 'Fibre', nourriture: 'Fruits', eau: 'Eau', ferraille: 'Ferraille' };

  // Ressources récoltables. dur = secondes de récolte, regrow = secondes pour regagner 1 unité.
  const NODES = {
    tree:   { res: 'bois',       max: 4, dur: 1.6, tool: 'hache',  regrow: 25, label: "Couper l'arbre",   solid: true },
    rock:   { res: 'pierre',     max: 5, dur: 2.0, tool: 'pioche', regrow: 60, label: 'Casser la roche',  solid: true },
    bush:   { res: 'nourriture', max: 3, dur: 1.0, regrow: 22, label: 'Cueillir des fruits' },
    flax:   { res: 'fibre',      max: 3, dur: 1.2, regrow: 20, label: 'Récolter le lin' },
    spring: { res: 'eau',        max: 99, dur: 0.9, regrow: 0, label: "Puiser de l'eau" },
    // Débris de l'épave : la ferraille ne repousse pas, il faut la ramener avant qu'il n'y en ait plus.
    wreck:  { res: 'ferraille',  max: 3, dur: 2.2, regrow: 0, label: "Fouiller l'épave", solid: true },
    // Caisse échouée à l'aube : un lot de ressources au hasard.
    crate:  { res: null,         max: 1, dur: 1.8, regrow: 0, label: 'Ouvrir la caisse' },
  };

  const RECIPES = {
    hache:       { label: 'Hache',       cost: { bois: 4, pierre: 3 },  desc: 'Coupe le bois deux fois plus vite.', personal: true },
    pioche:      { label: 'Pioche',      cost: { bois: 4, pierre: 4 },  desc: 'Casse la roche deux fois plus vite.', personal: true },
    torche:      { label: 'Torche',      cost: { bois: 2, fibre: 1 },   desc: "S'allume seule la nuit, loin du feu.", personal: true },
    barque:      { label: 'Barque',      cost: { bois: 18, fibre: 6 },  desc: 'Une barque de plus au ponton (3 max).' },
    recuperateur:{ label: "Récupérateur d'eau", cost: { bois: 10, fibre: 4 }, desc: "Remplit le coffre d'1 eau toutes les 25 s.", once: true },
  };

  // Pièces du navire, dans l'ordre de construction.
  const PARTS = [
    { id: 'quille', label: 'Quille', cost: { bois: 30 } },
    { id: 'coque',  label: 'Coque',  cost: { bois: 40, pierre: 12 } },
    { id: 'gouvernail', label: 'Gouvernail', cost: { bois: 8, ferraille: 6 } },
    { id: 'mat',    label: 'Mât',    cost: { bois: 20, fibre: 8 } },
    { id: 'voiles', label: 'Voiles', cost: { fibre: 30 } },
    { id: 'vivres', label: 'Vivres', cost: { nourriture: 20, eau: 20 } },
  ];

  const C = {
    W: 128, H: 96,
    SAC_CAP: 12, HOLD_CAP: 30, BOAT_SEATS: 2, MAX_BOATS: 3, MAX_PLAYERS: 6,
    DAY_LEN: 240,               // secondes réelles par journée complète
    SPEED_WALK: 4.2, SPEED_WADE: 2.3, SPEED_BOAT: 4.8, BOAT_CREW_BONUS: 1.45,
    REACH: 1.7,                 // distance d'interaction en tuiles
    FIRE_PER_WOOD: 20, FIRE_MAX: 360, FIRE_RADIUS: 7, TORCH_RADIUS: 4.5, TORCH_TIME: 110,
    FAIM_RATE: 100 / 300, SOIF_RATE: 100 / 220,
    EAT_GAIN: 32, DRINK_GAIN: 38,
    REVIVE_TIME: 2.5, CAMP_REACH: 3.2, LAUNCH_RADIUS: 8,
    RECUP_PERIOD: 25,
    SIGHT: 9,                   // rayon de découverte de la carte autour de chaque joueur
    STORM_WARN: 45, STORM_LEN: 50, STORM_CHILL: 0.9, STORM_FIRE: 2, STORM_SWAMP: 0.08,
    CRAB_PERIOD: 15, GUARD_RADIUS: 6, CRATES_PER_DAY: 2,
  };

  function walkable(t) { return t >= TILE.SHALLOW; }      // on marche sur le sable, l'herbe, la roche, et on patauge dans l'eau peu profonde
  function boatable(t) { return t <= TILE.SHALLOW; }

  // Obscurité de 0 (plein jour) à 1 (nuit noire) selon l'heure t dans [0, 1).
  function darkness(t) {
    if (t < 0.05) return 0.5 * (1 - t / 0.05);
    if (t < 0.6) return 0;
    if (t < 0.72) return (t - 0.6) / 0.12;
    if (t < 0.92) return 1;
    return 1 - ((t - 0.92) / 0.08) * 0.5;
  }
  function isCold(t) { return darkness(t) >= 0.75; }
  function phase(t) {
    if (t < 0.05) return 'Aube';
    if (t < 0.6) return 'Jour';
    if (t < 0.72) return 'Crépuscule';
    if (t < 0.92) return 'Nuit';
    return 'Aube';
  }

  function sacCount(inv) { let n = 0; for (const r of RES) n += inv[r] || 0; return n; }
  function canAfford(stock, cost) { for (const k in cost) if ((stock[k] || 0) < cost[k]) return false; return true; }

  return { TILE, RES, RES_LABEL, NODES, RECIPES, PARTS, C, walkable, boatable, darkness, isCold, phase, sacCount, canAfford };
});
