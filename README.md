# Stockly mobile (Expo)

Application de terrain pour la gestion de stock : accueil orienté tâches, liste des articles, fiche détail, scanner de codes-barres (entrées / sorties), tâches et comptage cyclique.

L'application fonctionne **entièrement hors ligne**, sans serveur : articles, mouvements, comptages et préférences sont enregistrés sur l'appareil. Au premier lancement, elle démarre **vide** (aucun article, aucun mouvement, aucun comptage) ; les données d'exemple de `data/mock.ts` ne sont chargées qu'à la demande (Profil › Stockage local › « Charger les données d'exemple »).

## Premier lancement et états vides

Tant qu'une liste ou une carte n'a pas de contenu, l'écran affiche un état vide (composant `EmptyState` de `components/ui.tsx` : icône, titre, message et actions) :

- **Accueil** : sans article, un message de bienvenue « Aucun article » remplace le comptage, les raccourcis et les indicateurs, avec « Ajouter un article » et « Scanner un code ». Avec des articles mais sans mouvement, « Activité récente » affiche « Aucun mouvement pour l'instant » et un bouton « Scanner ».
- **Articles** : sans article, « Ajouter un article » et « Scanner » ; une recherche sans résultat affiche « Aucun résultat » avec « Effacer la recherche ».
- **Tâches** : sans article, le comptage est remplacé par une explication et « Ajouter un article » ; l'onglet « Terminées » a son propre état vide.
- **Comptage** : sans article, « Ajouter un article » et « Retour » (pas d'export CSV possible).
- **Fiche article** et **modification** : identifiant inconnu → « Article introuvable » et « Retour aux articles ».
- **Scan** : un code inconnu propose toujours « Créer l'article », y compris avec un inventaire vide.

## Stockage hors ligne

- Les données sont persistées avec **react-native-mmkv** (v4, Nitro Modules) via `data/storage.ts` ; `data/store.ts` expose une API synchrone aux écrans et enregistre chaque modification immédiatement.
- Clés versionnées (`schemaVersion` = 1, données sous `v1.items`, `v1.movements`, `v1.countSessions`, `v1.prefs`, `v1.meta`). Les entrées invalides sont ignorées ; si les articles stockés sont absents, illisibles ou tous invalides, l'application démarre avec un inventaire vide (préférences conservées) — aucune donnée d'exemple n'est injectée. Une liste d'articles vide est valide. Les données existantes valides ne sont jamais écrasées.
- MMKV est un module natif : il faut un **build de développement** (`eas build --profile development` ou `npx expo run:android`). Dans **Expo Go**, le module est absent : l'application fonctionne quand même mais avec un **stockage temporaire** en mémoire (bandeau « Stockage temporaire » sur l'accueil et dans Profil), perdu à la fermeture.
- **Réinitialiser** : Profil › Stockage local › « Réinitialiser les données » efface tout (articles, photos, mouvements, comptages et préférences) : l'application repart vide.
- **Données d'exemple** : Profil › Stockage local › « Charger les données d'exemple » remplace, après confirmation, les articles, mouvements et comptages actuels par le jeu d'exemple de `data/mock.ts` (8 articles, 2 mouvements) ; les préférences sont conservées.

## Modifier et supprimer un article

- **Modifier** : bouton « Modifier » de la fiche article → écran `article/edit/[id]` (« Modifier l'article »). Il réutilise le formulaire de création (`components/ArticleForm.tsx`), prérempli : nom, code-barres, référence (SKU), dossier, seuil minimum, prix et photo. Les règles de validation sont celles de la création (nom et dossier obligatoires, seuil entier positif ou nul, prix positif ou nul, code-barres et SKU uniques — l'article lui-même excepté — et SKU différent du code-barres ; un SKU vidé est régénéré). Les erreurs s'affichent sous les champs concernés.
- Le **stock n'est pas modifiable** depuis ce formulaire : il se règle avec « Ajuster le stock » sur la fiche (ou par le scanner / un comptage), pour que chaque changement soit enregistré comme mouvement.
- **Supprimer** : « Supprimer l'article » sur la fiche, après confirmation. Sont supprimés avec l'article : sa photo, tous ses mouvements, ses saisies dans les comptages en cours et terminés (il disparaît aussi du stock attendu figé d'un comptage terminé, donc de son écran et de son export CSV) et un éventuel scan de comptage en attente. L'application revient ensuite à la liste des articles. Cette action est irréversible.

## Photos des articles

- Le formulaire de création / modification propose « Prendre une photo » (appareil photo) et « Choisir dans la galerie » (**expo-image-picker**, recadrage carré, compression ~60 %), ainsi que « Supprimer la photo ». En cas de refus d'autorisation, une alerte propose d'ouvrir les réglages de l'appareil.
- La photo est copiée dans le dossier `photos` des **documents de l'application** (`Paths.document` d'**expo-file-system**), uniquement sur l'appareil. L'article n'enregistre que le **nom du fichier** (ex. `item-12-…jpg`), jamais un chemin absolu (le chemin du conteneur iOS change entre deux mises à jour) ; l'URI est recalculé à l'affichage (`data/photos.ts`).
- La photo s'affiche dans la liste des articles, la fiche article, l'activité récente de l'accueil et le comptage ; à défaut (aucune photo, fichier absent ou module natif indisponible), la vignette par défaut est affichée.
- Fichiers : une photo remplacée ou retirée est supprimée après l'enregistrement ; une photo choisie puis abandonnée (Annuler, retour) est supprimée ; la suppression d'un article supprime sa photo ; « Réinitialiser les données » et « Charger les données d'exemple » suppriment toutes les photos. Au démarrage, les fichiers photo qu'aucun article ne référence (articles perdus en stockage temporaire, application fermée avant l'enregistrement du formulaire…) sont supprimés.
- Les photos ne font pas partie de l'export CSV (colonnes inchangées).
- `data/store.ts` n'importe aucun module natif de fichiers : `data/photos.ts` (importé par `app/_layout.tsx`) lui fournit ses fonctions de suppression via `setPhotoFileHooks()`. Sans elles (tests Node), la suppression des fichiers est ignorée.
- ⚠️ Le plugin **expo-image-picker** a été ajouté à `app.json` (textes d'autorisation photos / caméra en français) : cela modifie le *fingerprint* natif, il faut donc **un nouveau build natif** (`eas build`) — une mise à jour OTA ne suffit pas. Les textes d'autorisation en français n'apparaissent que dans ce nouveau build. Dans **Expo Go**, l'ajout de photo fonctionne (avec les textes d'autorisation d'Expo Go), mais comme les articles n'y sont gardés qu'en mémoire, ils sont perdus au relancement. « Photo indisponible » ne s'affiche que si le module natif manque (ancien build sans expo-image-picker).

## Comptage cyclique

- Le comptage « Comptage de l'inventaire » porte sur **tous les articles** (tous les dossiers), dans l'ordre de la liste ; un article créé en cours de comptage y est ajouté. Une fois le comptage terminé, sa liste est figée : les articles créés après la clôture n'y apparaissent pas (écran, totaux, export CSV).
- Avec un inventaire vide, le comptage contient 0 article : il ne peut être ni saisi, ni terminé, ni exporté.
- Les entrées d'une session enregistrée qui concernent des articles inexistants sont ignorées dans la progression et l'export.

## Scan

- `app/scan.tsx` lit les codes avec **expo-camera** (EAN-13, EAN-8, UPC-A, UPC-E, Code 128, Code 39, QR) et vibre brièvement à chaque lecture (désactivable : Profil › Vibration au scan).
- **Saisie manuelle** : bouton sur l'écran de scan pour taper un code-barres ou un SKU (utile sur simulateur ou sans caméra).
- Le code est recherché par code-barres ou SKU. Code inconnu → « Créer l'article » ouvre le formulaire `article/new` prérempli ; au retour, l'article créé est retrouvé et le mouvement Entrée / Sortie peut être saisi.
- Pendant un comptage cyclique, « Scanner » ouvre `/scan?countId=…` : le code lu renvoie directement sur l'article correspondant du comptage. La progression du comptage est enregistrée ; à la fin, les écarts peuvent être appliqués au stock ou ignorés.
- **Export CSV d'un comptage** : bouton « Exporter (CSV) » sur l'écran de comptage (en cours ou terminé) et sur la carte du comptage dans Tâches › Terminées. Le fichier (`stockly-comptage-<id>-<aaaammjj>-<hhmm>.csv`) est écrit dans le cache avec **expo-file-system** puis partagé avec **expo-sharing** (repli : partage du texte si ces modules natifs sont absents). Format prévu pour Excel en français : séparateur `;`, **UTF-8 avec BOM**, fins de ligne CRLF. Il contient un en-tête (comptage, dossier, statut, dates, comptage à l'aveugle), une ligne par article (SKU, code-barres, article, dossier, stock attendu, quantité comptée, écart, statut) et les totaux. Le stock attendu est celui mémorisé à la clôture du comptage (avant ajustement) ; pour un comptage en cours, c'est le stock actuel, sauf en comptage à l'aveugle où le stock attendu et les écarts ne sont exportés qu'une fois le comptage terminé. Les SKU et codes-barres composés uniquement de chiffres sont écrits `="…"` pour qu'Excel les garde en texte (zéros de tête conservés).

## Stack

- **Expo SDK 58**, React Native 0.88, React 19, nouvelle architecture activée
- **expo-router** (routes basées sur les fichiers, routes typées)
- **expo-camera** pour le scan, **expo-image-picker** + **expo-file-system** pour les photos d'articles, **expo-location** pour la géolocalisation
- **expo-updates** pour les mises à jour OTA (EAS Update, `runtimeVersion` basé sur le *fingerprint*)
- Gestionnaire de paquets : **pnpm** (`pnpm-lock.yaml`)

## Démarrage

```bash
pnpm install
npx expo install --check   # vérifie que les versions correspondent au SDK
npx expo start
```

## Structure

```
app/
  _layout.tsx          Stack racine
  (tabs)/              Onglets : Accueil, Articles, Scanner, Tâches, Profil
  scan.tsx             Scanner plein écran (mouvement Entrée / Sortie, saisie manuelle)
  article/new.tsx      Création d'un article
  article/[id].tsx     Détail d'un article (ajustement du stock, modifier, supprimer)
  article/edit/[id].tsx Modification d'un article
  count/[id].tsx       Comptage cyclique (progression enregistrée)
components/ui.tsx      Composants partagés (Btn, Stepper, Segmented, EmptyState, Thumb, ItemPhoto…)
components/ArticleForm.tsx Formulaire d'article (création et modification, photo)
constants/theme.ts     Couleurs et thème
data/mock.ts           Données de démonstration (chargées uniquement via « Charger les données d'exemple »)
data/storage.ts        Accès MMKV (repli en mémoire si indisponible)
data/store.ts          État de l'app persisté (articles, mouvements, comptages, préférences)
data/csv.ts            Construction du CSV d'un comptage (module pur, testable)
data/exportCount.ts    Export CSV d'un comptage (fichier + feuille de partage)
data/photos.ts         Photos des articles (appareil photo / galerie, fichiers locaux)
assets/images/         Icône, icône adaptative, splash, favicon
.eas/workflows/        Workflows EAS (CI/CD)
```

## Builds et déploiement (EAS)

Profils définis dans `eas.json` :

| Profil        | Canal         | Distribution | Android |
|---------------|---------------|--------------|---------|
| `development` | `development` | interne      | APK (dev client) |
| `preview`     | `preview`     | interne      | APK |
| `production`  | `production`  | stores       | AAB |

```bash
eas build --platform android --profile preview
```

Workflows EAS :

- **`ship.yml`** — à chaque push sur `main` : calcule le *fingerprint* natif ; si un build `preview` compatible existe, publie une mise à jour OTA sur le canal `preview`, sinon lance un nouveau build `preview`.
- **`create-production-builds.yml`** — à lancer manuellement (`eas workflow:run create-production-builds.yml`) pour produire un build Android de production.

### Ajouter un config plugin

Tout plugin listé dans `app.json > expo.plugins` **doit être installé** dans `package.json`, sinon `expo config` échoue et l'étape *fingerprint* d'EAS Build plante. Installez toujours le paquet avant d'ajouter son plugin :

```bash
npx expo install <paquet>
npx expo config --json > /dev/null   # vérification rapide
```

## À faire

- Sauvegarde des données (aucune synchronisation serveur pour l'instant).
- Remplacer les icônes provisoires de `assets/images/` par les visuels définitifs.
- Le code-barres affiché sur la fiche détail est décoratif ; utilisez `react-native-svg` avec une bibliothèque de codes-barres pour un vrai rendu.
- Sentry : `@sentry/react-native` et son plugin sont installés, mais le SDK n'est pas encore initialisé. Ajoutez `Sentry.init({ dsn: '…' })` dans `app/_layout.tsx`, un `metro.config.js` basé sur `getSentryExpoConfig`, et le secret `SENTRY_AUTH_TOKEN` dans EAS pour l'envoi des source maps.
