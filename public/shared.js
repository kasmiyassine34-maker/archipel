// Règles et constantes partagées entre le serveur (Node) et le navigateur.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ARCHIPEL = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // REEF : un récif à fleur d'eau. Les barques passent dessus, mais il abîme la coque.
  const TILE = { DEEP: 0, SHALLOW: 1, SAND: 2, GRASS: 3, ROCK: 4, REEF: 5 };

  const RES = ['bois', 'pierre', 'fibre', 'nourriture', 'eau', 'viande'];
  const RES_LABEL = { bois: 'Bois', pierre: 'Pierre', fibre: 'Fibre', nourriture: 'Fruits', eau: 'Eau', viande: 'Viande' };

  // Ressources récoltables. dur = secondes de récolte, regrow = secondes pour regagner 1 unité.
  const NODES = {
    tree:   { res: 'bois',       max: 4, dur: 1.6, tool: 'hache',  regrow: 25, label: "Couper l'arbre",   solid: true },
    rock:   { res: 'pierre',     max: 5, dur: 2.0, tool: 'pioche', regrow: 60, label: 'Casser la roche',  solid: true },
    bush:   { res: 'nourriture', max: 3, dur: 1.0, regrow: 22, label: 'Cueillir des fruits' },
    flax:   { res: 'fibre',      max: 3, dur: 1.2, regrow: 20, label: 'Récolter le lin' },
    spring: { res: 'eau',        max: 99, dur: 0.9, regrow: 0, label: "Puiser de l'eau" },
  };

  // Armes. dmg = dégâts, reach = portée (tuiles), arc = ouverture du coup (radians), cd = secondes entre deux coups.
  const WEAPONS = {
    mains:  { label: 'Poings', dmg: 5,  reach: 1.15, arc: 1.7, cd: 0.45 },
    lance:  { label: 'Lance',  dmg: 15, reach: 1.85, arc: 0.85, cd: 0.6 },
    hache:  { label: 'Hache',  dmg: 12, reach: 1.35, arc: 1.5, cd: 0.55 },
    fronde: { label: 'Fronde', dmg: 9,  range: 9, cd: 0.8, speed: 15, ammo: 'pierre' },
  };
  const WEAPON_ORDER = ['mains', 'lance', 'hache', 'fronde'];

  const RECIPES = {
    lance:       { label: 'Lance',        cost: { bois: 3, pierre: 2 },  desc: 'Longue portée, coups précis.', personal: true },
    hache:       { label: 'Hache',        cost: { bois: 4, pierre: 3 },  desc: 'Coupe le bois deux fois plus vite. Bonne arme.', personal: true },
    pioche:      { label: 'Pioche',       cost: { bois: 4, pierre: 4 },  desc: 'Casse la roche deux fois plus vite.', personal: true },
    fronde:      { label: 'Fronde',       cost: { bois: 2, fibre: 3 },   desc: 'Tire une pierre du sac à distance.', personal: true },
    torche:      { label: 'Torche',       cost: { bois: 2, fibre: 1 },   desc: "S'allume seule la nuit. Les Pâles fuient sa lumière.", personal: true },
    bandage:     { label: 'Bandages',     cost: { fibre: 2, nourriture: 1 }, desc: 'Deux bandages. B pour se soigner.', personal: true },
    barque:      { label: 'Barque',       cost: { bois: 18, fibre: 6 },  desc: 'Une barque de deux places de plus au ponton.' },
    grande:      { label: 'Grande barque', cost: { bois: 40, fibre: 14, pierre: 8 }, desc: 'Trois places, coque renforcée contre les récifs et les tempêtes.', once: true },
    recuperateur:{ label: "Récupérateur d'eau", cost: { bois: 10, fibre: 4 }, desc: "Remplit le coffre d'eau de pluie, bien plus vite sous l'orage.", once: true },
  };

  // Pièces du navire (fin « La fuite »), dans l'ordre de construction.
  const PARTS = [
    { id: 'quille', label: 'Quille', cost: { bois: 35 } },
    { id: 'coque',  label: 'Coque',  cost: { bois: 45, pierre: 15 } },
    { id: 'mat',    label: 'Mât',    cost: { bois: 25, fibre: 10 } },
    { id: 'voiles', label: 'Voiles', cost: { fibre: 35 } },
    { id: 'vivres', label: 'Vivres', cost: { nourriture: 20, eau: 20, viande: 6 } },
  ];

  const ROLES = {
    cartographe: { label: 'Cartographe', short: 'voit loin', desc: 'Voit plus loin dans la brume, repère récifs et courants de plus loin, déchiffre les fragments deux fois plus vite.' },
    charpentier: { label: 'Charpentier', short: 'construit', desc: 'Coupe le bois plus vite, et peut réparer une coque en pleine mer (T) avec deux bois.' },
    chasseur:    { label: 'Chasseur',    short: 'combat',    desc: 'Frappe moitié plus fort, rapporte deux fois plus de viande, voit les bêtes sur la carte.' },
    herboriste:  { label: 'Herboriste',  short: 'soigne',    desc: "Soigne mieux et peut soigner les autres (maintenir E), relève deux fois plus vite, tire plus de la nourriture." },
  };

  // Bêtes. hp = vie, speed = tuiles/s, aggro = distance de repérage, wind = durée de l'attaque annoncée (s).
  const BEASTS = {
    crabe:   { label: 'Crabe de récif', hp: 40,  speed: 1.5, aggro: 4.5, reach: 1.2, wind: 0.7, dmg: 13, cd: 1.5, r: 0.45, meat: 1, armor: 0.35 },
    varan:   { label: 'Varan',          hp: 65,  speed: 2.1, aggro: 6.5, wind: 0.85, dmg: 22, cd: 2.4, r: 0.5, meat: 2, charge: 10, chargeT: 0.5, stun: 1.4 },
    pale:    { label: 'Pâle',           hp: 26,  speed: 3.2, aggro: 10, reach: 1.15, wind: 0.45, dmg: 10, cd: 1.1, r: 0.4, meat: 0 },
    gardien: { label: 'Le Gardien',     hp: 460, speed: 1.6, aggro: 9, reach: 2.6, wind: 1.0, dmg: 28, cd: 1.6, r: 0.9, meat: 0, armor: 0.15 },
  };

  // Les sept fragments de l'histoire du Phare noir.
  const FRAGMENTS = [
    { n: 1, site: 'carnet', title: "Carnet du capitaine Aubry, I",
      text: "Troisième nuit sur cette île qui ne figure sur aucune carte. Chaque nuit, une lumière brille au sud, au-delà du banc de brume. Ce n'est pas un navire. Elle ne bouge pas, elle attend." },
    { n: 2, site: 'epave', title: 'Journal de bord de la Mouette',
      text: "Le timonier jure avoir suivi les feux d'un port. Nous avons touché les récifs à minuit. Il n'y a pas de port. Il n'y a qu'une tour noire et cette flamme qui ne chauffe pas." },
    { n: 3, site: 'stele', title: 'Stèle des Veilleurs',
      text: "Nous gardons la flamme pour que la Brume dorme. Tant que la lumière est blanche, elle guide les marins. Qui la laisse noircir réveille ce qui dort sous la mer." },
    { n: 4, site: 'ruine', title: 'Fresque de la salle des gardiens',
      text: "La fresque montre des silhouettes portant du bois, de la pierre et de l'eau jusqu'au sommet d'une tour. Au-dessus d'elles, une flamme blanche repousse une marée de brume." },
    { n: 5, site: 'carnet', title: "Carnet du capitaine Aubry, II",
      text: "Mes hommes disparaissent dans la brume. Je les revois parfois la nuit, pâles, au bord du feu. Ils ne me reconnaissent plus. Ils craignent la lumière comme on craint un souvenir." },
    { n: 6, site: 'coffret', title: "Lettre d'une Veilleuse",
      text: "Le dernier d'entre nous refuse de quitter la flamme. Elle est devenue noire et il ne dort plus, il ne parle plus. Il garde. Si quelqu'un lit ceci : on ne l'éteint pas sans l'occuper." },
    { n: 7, site: 'stele', title: 'Le rituel de la flamme blanche',
      text: "Une flamme blanche naît du bois des pins, de la pierre du rocher et de l'eau des sources, portés ensemble au sommet, quand le gardien noir ne veille plus." },
  ];

  const C = {
    W: 150, H: 112,
    SAC_CAP: 12, HOLD_CAP: 30, GRANDE_HOLD: 60, MAX_BOATS: 3, MAX_PLAYERS: 6,
    DAY_LEN: 300,               // secondes réelles par journée complète
    SPEED_WALK: 4.2, SPEED_WADE: 2.3, SPEED_BOAT: 4.8, BOAT_CREW_BONUS: 1.45, DODGE_SPEED: 11, DODGE_TIME: 0.2, DODGE_CD: 0.9, DODGE_INVULN: 0.35,
    REACH: 1.7,                 // distance d'interaction en tuiles
    FIRE_PER_WOOD: 20, FIRE_MAX: 360, FIRE_RADIUS: 7, TORCH_RADIUS: 4.5, TORCH_TIME: 110,
    FAIM_RATE: 100 / 330, SOIF_RATE: 100 / 250,
    EAT_GAIN: 32, MEAT_GAIN: 45, DRINK_GAIN: 38, BANDAGE_HEAL: 35,
    REVIVE_TIME: 2.5, CAMP_REACH: 3.2, LAUNCH_RADIUS: 8,
    RECUP_PERIOD: 25,
    VIEW: 6.5, VIEW_SEA: 8, VIEW_CARTO: 3, REEF_SPOT: 2.5, REEF_SPOT_CARTO: 5.5,
    HULL: 100, GRANDE_HULL: 180, REEF_DMG: 26, GRANDE_REEF_DMG: 7,
    READ_TIME: 3, LIFT_TIME: 4, DOUSE_TIME: 6,
    FRAG_NEED: 3, FRAGS: 7,
  };

  // Places et vitesse selon le type de barque.
  const BOATS = {
    barque: { label: 'Barque', seats: 2, hold: C.HOLD_CAP, hull: C.HULL, reef: C.REEF_DMG, storm: 1.3,
      speed: (n) => C.SPEED_BOAT * (n >= 2 ? C.BOAT_CREW_BONUS : 1) },
    grande: { label: 'Grande barque', seats: 3, hold: C.GRANDE_HOLD, hull: C.GRANDE_HULL, reef: C.GRANDE_REEF_DMG, storm: 0.35,
      speed: (n) => C.SPEED_BOAT * (n >= 3 ? 1.55 : n === 2 ? 1.2 : 0.65) },
  };

  function walkable(t) { return t >= TILE.SHALLOW && t !== TILE.REEF; } // sable, herbe, roche, et l'eau peu profonde où l'on patauge
  function boatable(t) { return t <= TILE.SHALLOW || t === TILE.REEF; }
  function isLand(t) { return t >= TILE.SAND && t <= TILE.ROCK; }

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
  function angleDiff(a, b) { let d = a - b; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; }

  return { TILE, RES, RES_LABEL, NODES, WEAPONS, WEAPON_ORDER, RECIPES, PARTS, ROLES, BEASTS, FRAGMENTS, C, BOATS,
    walkable, boatable, isLand, darkness, isCold, phase, sacCount, canAfford, angleDiff };
});
