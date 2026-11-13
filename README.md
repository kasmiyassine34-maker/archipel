# L'Archipel

Jeu de survie **coopératif en ligne**, en 2D vue du dessus, jouable dans le navigateur. Pensé pour 3 ou 4 joueurs (de 1 à 6), pour des parties de 1 à 2 heures.

Direction artistique : un **carnet de cartographe**. La carte est peinte à l'aquarelle sur papier ancien, avec le trait de côte et les courbes de profondeur à l'encre. Ce que personne n'a encore exploré reste du papier vierge, quadrillé, qui se remplit à mesure que l'équipe avance. La nuit tombe comme un lavis d'encre indigo que seuls le feu et les torches percent.

Votre navire s'est brisé sur les récifs d'un archipel qui ne figure sur aucune carte. Au-delà d'un banc de brume, une flamme noire brille chaque nuit. Il faut survivre, explorer, affronter les bêtes et percer le secret du Phare noir.

## Jouer

1. Ouvrir le jeu, choisir un nom, cliquer **Créer une partie**.
2. Cliquer **Copier le lien** et l'envoyer à ses amis : le lien contient le code de la partie (4 lettres).
3. Chacun choisit un métier : cartographe, charpentier, chasseur ou herboriste.

| Touche | Action |
| --- | --- |
| `ZQSD`, `WASD` ou flèches | marcher ; en barque : ramer, reculer, tourner |
| Clic gauche | frapper dans la direction de la souris |
| `Espace` | esquiver (aucun coup ne porte pendant l'esquive) |
| `1` à `4` | poings, lance, hache, fronde |
| `E` | interagir ; **maintenir** pour récolter, lire un fragment, tenir un levier, relever ou soigner |
| `F` / `G` / `B` | manger / boire / bandage |
| `R` / `T` | cale de la barque / réparer une coque |
| `J` / `M` / `H` | carnet des fragments / grande carte / aide |
| Clic droit | poser une croix visible par toute l'équipe |

## Règles

- **La carte vivante** : au départ, seule l'Île du Naufrage est connue. Chaque côte aperçue s'ajoute à la carte commune. L'archipel (11 îles) change à chaque partie.
- **Le mystère** : sept fragments (carnets, épave, stèles, ruine, coffret) racontent l'histoire du Phare noir. Une stèle se relève à deux, la porte d'une ruine s'ouvre avec deux leviers tenus en même temps. Avec trois fragments, un cap traverse le banc de brume qui cache le Phare.
- **Les fins** : construire le navire au camp (« La fuite ») ; étouffer la flamme noire au sommet du Phare (« La vérité ») ; avec les sept fragments et le Gardien vaincu, accomplir le rituel et voter : partir ou rester (« Les Veilleurs »).
- **Les bêtes** : crabes sur les plages, varans dans les forêts, Pâles la nuit (ils fuient la lumière), et le Gardien du Phare. Chaque attaque est annoncée par un trait rouge. Crabes et Gardien ont une face blindée : frappez-les de dos. Les bêtes n'approchent pas du feu de camp.
- **La mer** : récifs cachés qui abîment les coques, courants qui déportent les barques, tempêtes annoncées par le baromètre. Une barque qui coule rejette son équipage sur la côte et perd sa cale. La grande barque (trois places) résiste mieux.
- **Survie** : faim, soif, froid la nuit loin du feu. Un joueur à terre peut être relevé. Si toute l'équipe tombe, la partie est perdue.
- Une journée dure 5 minutes.

## Lancer en local

```bash
npm install
npm start          # http://localhost:3000
npm test           # règles du jeu + test réseau avec deux joueurs simulés
```

Pour tester à plusieurs en local, ouvrir deux onglets sur `http://localhost:3000`.

## Déployer sur Render (offre gratuite)

Le fichier `render.yaml` décrit le service.

1. Sur [dashboard.render.com](https://dashboard.render.com), cliquer **New**, puis **Blueprint**.
2. Choisir ce dépôt GitHub et valider. Render installe et lance le serveur, puis donne une adresse en `onrender.com`.
3. Chaque `git push` sur `main` redéploie automatiquement.

Limites de l'offre gratuite : le serveur s'endort après environ 15 minutes sans joueur et met jusqu'à une minute à se réveiller (l'écran d'accueil l'indique). Les parties vivent en mémoire : elles disparaissent si le serveur redémarre.

## Organisation du code

```
server.js          serveur HTTP + WebSocket, boucle de simulation à 20 Hz, état envoyé à 10 Hz
src/world.js       génération de l'archipel (îles, ressources, récifs, courants, sites des fragments, bêtes)
src/game.js        règles du jeu : brume, survie, combat, bêtes, fragments, tempêtes, barques, fins
public/shared.js   constantes et règles partagées entre serveur et navigateur
public/paper.js    peinture de la carte (papier, aquarelle, encre), rose des vents, icônes
public/client.js   rendu à la plume (canvas), nuit, commandes, interface
public/index.html  écran d'accueil et interface
public/style.css   style de l'interface
test/              tests automatiques
```

Le serveur fait autorité : il vérifie les distances, les vitesses et les coûts, et corrige un joueur qui triche ou qui désynchronise. Chaque joueur déplace son personnage (ou sa barque s'il rame) localement pour que le jeu reste fluide, et le serveur valide.

## Pistes pour la suite

- Sauvegarde des parties pour les reprendre un autre jour.
- Commandes tactiles pour jouer sur téléphone.
- Sons et musique d'ambiance.
