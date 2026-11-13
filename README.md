# L'Archipel

Jeu de survie **coopératif en ligne**, en 2D vue du dessus, jouable dans le navigateur à 1 à 6 joueurs.

Direction artistique : un **carnet de cartographe**. La carte est peinte à l'aquarelle sur papier ancien, avec le trait de côte et les courbes de profondeur à l'encre, des hachures pour les rochers et des pointillés pour les plages. Les personnages, les arbres et le navire sont dessinés à la plume. La nuit tombe comme un lavis d'encre indigo que seuls le feu et les torches percent.

Votre navire s'est brisé sur les récifs d'un archipel. Chaque île a sa ressource : il faut ramer de l'une à l'autre, tenir le feu allumé la nuit, manger, boire, et reconstruire ensemble un navire pour s'échapper.

## Jouer

1. Ouvrir le jeu, choisir un nom, cliquer **Créer une partie**.
2. Cliquer **Copier le lien** et l'envoyer à ses amis : le lien contient le code de la partie (4 lettres).

| Touche | Action |
| --- | --- |
| `ZQSD`, `WASD` ou flèches | marcher |
| En barque : `Z` / `S` | ramer en avant / reculer (pour se dégager d'une côte) |
| En barque : `Q` / `D` | tourner |
| `E` | interagir : monter ou descendre d'une barque, déposer au coffre, nourrir le feu. **Maintenir** pour récolter ou relever un coéquipier |
| `R` | près d'une barque : vider son sac dans la cale, ou reprendre la cale si le sac est vide |
| `F` / `G` | manger / boire (depuis son sac, au coffre du camp, ou directement à une source) |
| Clic droit | poser un signal visible par toute l'équipe |
| `M` / `H` | grande carte / aide |

## Règles

- **L'archipel** : l'Île du Naufrage (le camp), l'Île aux Pins (bois), le Rocher (pierre), l'Île Verte (fruits, lin, eau douce) et l'Îlot des Sables (un peu de tout). Les ressources repoussent avec le temps.
- **Survie** : la faim et la soif baissent en continu. À zéro, la santé diminue. La nuit, le froid blesse toute personne loin du feu ou d'une torche. Le feu brûle 20 secondes par bois.
- **Coopération** : un joueur à terre peut être relevé par un autre (maintenir `E` 2,5 s). Si toute l'équipe est à terre, la partie est perdue. Une barque a deux places et rame 45 % plus vite à deux. Sa cale contient 30 ressources, le sac 12.
- **Atelier** (au camp, avec les ressources du coffre commun) : hache, pioche, torche, barque supplémentaire, récupérateur d'eau de pluie.
- **Navire** : quille, coque, gouvernail, mât, voiles, vivres, dans cet ordre. Quand tout est construit, toute l'équipe se réunit au chantier et largue les amarres pour gagner.
- **Carte à découvrir** : la carte ne montre que ce que l'équipe a déjà vu. Elle se complète à mesure que chacun explore, et chaque nouvelle île est annoncée à tous.
- **L'Épave** : au large, au sud-ouest, gît la carcasse de votre ancien navire. C'est la seule source de **ferraille**, indispensable au gouvernail, et elle ne repousse pas.
- **Tempêtes** : annoncées 45 secondes à l'avance, elles durent 50 secondes. Le feu se consume trois fois plus vite, le froid blesse quiconque est loin du feu, et en pleine mer les vagues emportent la cargaison des barques et les poussent.
- **Caisses échouées** : chaque matin, la mer dépose deux caisses sur des plages lointaines (croix rouges sur la carte une fois repérées). Une caisse donne 4 à 6 ressources au hasard, dont parfois de la ferraille.
- **Crabes** : la nuit, si personne ne reste de garde près du coffre, les crabes y volent des fruits.
- Une journée dure 4 minutes. Une partie complète prend environ 30 à 45 minutes.

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
src/world.js       génération de l'archipel (îles, ressources, camp, ponton)
src/game.js        règles du jeu : survie, récolte, barques, atelier, navire, victoire et défaite
public/shared.js   constantes et règles partagées entre serveur et navigateur
public/paper.js    peinture de la carte (papier, aquarelle, encre), rose des vents, icônes
public/client.js   rendu à la plume (canvas), nuit, commandes, interface
public/index.html  écran d'accueil et interface
public/style.css   style de l'interface
test/              tests automatiques
```

Le serveur fait autorité : il vérifie les distances, les vitesses et les coûts, et corrige un joueur qui triche ou qui désynchronise. Chaque joueur déplace son personnage (ou sa barque s'il rame) localement pour que le jeu reste fluide, et le serveur valide.

## Pistes pour la suite

- Rôles au départ (charpentier, pêcheur, éclaireur, soigneur) et tâches à faire à deux.
- Marée qui ouvre et ferme des passages à pied.
- Outils améliorés en ferraille.
- Commandes tactiles pour jouer sur téléphone.
- Sons et musique d'ambiance.
- Sauvegarde des parties dans une base de données.
