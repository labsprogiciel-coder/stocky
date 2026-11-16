# Stockly mobile (Expo)

Application de terrain pour la gestion de stock : accueil orienté tâches, liste des articles, fiche détail, scanner de codes-barres (entrées / sorties), suivi des appareils par numéro de série (export Jira Service Management Assets), tâches et comptage cyclique.

L'application fonctionne **entièrement hors ligne**, sans serveur : articles, mouvements, comptages et préférences sont enregistrés sur l'appareil. Au premier lancement, elle démarre **vide** (aucun article, aucun mouvement, aucun comptage) ; les données d'exemple de `data/mock.ts` ne sont chargées qu'à la demande (Profil › Stockage local › « Charger les données d'exemple »).

## Premier lancement et états vides

Tant qu'une liste ou une carte n'a pas de contenu, l'écran affiche un état vide (composant `EmptyState` de `components/ui.tsx` : icône, titre, message et actions) :

- **Accueil** : sans article, un message de bienvenue « Aucun article » remplace le comptage, les raccourcis et les indicateurs, avec « Ajouter un article » et « Scanner un code ». Avec des articles mais sans mouvement, « Activité récente » affiche « Aucun mouvement pour l'instant » et un bouton « Scanner ».
- **Articles** : sans article, « Ajouter un article » et « Scanner » ; une recherche sans résultat affiche « Aucun résultat » avec « Effacer la recherche ».
- **Tâches** : sans article, le comptage est remplacé par une explication et « Ajouter un article » ; l'onglet « Terminées » a son propre état vide.
- **Comptage** : sans article, « Ajouter un article » et « Retour » (pas d'export CSV possible).
- **Fiche article** et **modification** : identifiant inconnu → « Article introuvable » et « Retour aux articles ».
- **Scan** : un code inconnu propose toujours « Créer l'article », y compris avec un inventaire vide (et « Ajouter comme appareil », qui propose de créer un article suivi par numéro de série s'il n'en existe aucun).
- **Fiche d'un article suivi par numéro de série** sans appareil : « Aucun appareil » avec « Ajouter un appareil » et « Scanner ». **Appareil** inconnu : « Appareil introuvable ».

## Stockage hors ligne

- Les données sont persistées avec **react-native-mmkv** (v4, Nitro Modules) via `data/storage.ts` ; `data/store.ts` expose une API synchrone aux écrans et enregistre chaque modification immédiatement.
- Clés versionnées (`schemaVersion` = 1, données sous `v1.items`, `v1.units`, `v1.movements`, `v1.countSessions`, `v1.prefs`, `v1.meta`). `v1.units` (appareils suivis par numéro de série) est un ajout rétrocompatible : une installation existante sans cette clé démarre simplement sans appareil, sans changement de schéma. Les entrées invalides sont ignorées ; si les articles stockés sont absents, illisibles ou tous invalides, l'application démarre avec un inventaire vide (préférences conservées) — aucune donnée d'exemple n'est injectée. Une liste d'articles vide est valide. Les données existantes valides ne sont jamais écrasées.
- MMKV est un module natif : il faut un **build de développement** (`eas build --profile development` ou `npx expo run:android`). Dans **Expo Go**, le module est absent : l'application fonctionne quand même mais avec un **stockage temporaire** en mémoire (bandeau « Stockage temporaire » sur l'accueil et dans Profil), perdu à la fermeture.
- **Réinitialiser** : Profil › Stockage local › « Réinitialiser les données » efface tout (articles, photos, mouvements, comptages et préférences) : l'application repart vide.
- **Données d'exemple** : Profil › Stockage local › « Charger les données d'exemple » remplace, après confirmation, les articles, appareils, mouvements et comptages actuels par le jeu d'exemple de `data/mock.ts` (8 articles suivis en quantité, 3 articles suivis par numéro de série avec 7 appareils — un smartphone avec IMEI dont un en réparation, un ordinateur portable dont un attribué, un casque —, une coque suivie en quantité, et 2 mouvements) ; les préférences sont conservées.
- **Volume** : MMKV garde tout l'état en mémoire et réécrit la liste concernée à chaque modification ; c'est adapté à quelques milliers d'appareils (et d'articles) par appareil mobile. Au-delà (dizaines de milliers de numéros de série), il faudrait passer à une base locale indexée (ex. SQLite).

## Modifier et supprimer un article

- **Modifier** : bouton « Modifier » de la fiche article → écran `article/edit/[id]` (« Modifier l'article »). Il réutilise le formulaire de création (`components/ArticleForm.tsx`), prérempli : nom, code-barres, référence (SKU), dossier, seuil minimum, prix et photo. Les règles de validation sont celles de la création (nom et dossier obligatoires, seuil entier positif ou nul, prix positif ou nul, code-barres et SKU uniques — l'article lui-même excepté — et SKU différent du code-barres ; un SKU vidé est régénéré). Les erreurs s'affichent sous les champs concernés.
- Le **stock n'est pas modifiable** depuis ce formulaire : il se règle avec « Ajuster le stock » sur la fiche (ou par le scanner / un comptage), pour que chaque changement soit enregistré comme mouvement.
- **Supprimer** : « Supprimer l'article » sur la fiche, après confirmation. Sont supprimés avec l'article : sa photo, ses appareils (numéros de série), tous ses mouvements, ses saisies dans les comptages en cours et terminés (il disparaît aussi du stock attendu figé d'un comptage terminé, donc de son écran et de son export CSV) et un éventuel scan de comptage en attente. L'application revient ensuite à la liste des articles. Cette action est irréversible.

## Photos des articles

- Le formulaire de création / modification propose « Prendre une photo » (appareil photo) et « Choisir dans la galerie » (**expo-image-picker**, recadrage carré, compression ~60 %), ainsi que « Supprimer la photo ». En cas de refus d'autorisation, une alerte propose d'ouvrir les réglages de l'appareil.
- La photo est copiée dans le dossier `photos` des **documents de l'application** (`Paths.document` d'**expo-file-system**), uniquement sur l'appareil. L'article n'enregistre que le **nom du fichier** (ex. `item-12-…jpg`), jamais un chemin absolu (le chemin du conteneur iOS change entre deux mises à jour) ; l'URI est recalculé à l'affichage (`data/photos.ts`).
- La photo s'affiche dans la liste des articles, la fiche article, l'activité récente de l'accueil et le comptage ; à défaut (aucune photo, fichier absent ou module natif indisponible), la vignette par défaut est affichée.
- Fichiers : une photo remplacée ou retirée est supprimée après l'enregistrement ; une photo choisie puis abandonnée (Annuler, retour) est supprimée ; la suppression d'un article supprime sa photo ; « Réinitialiser les données » et « Charger les données d'exemple » suppriment toutes les photos. Au démarrage, les fichiers photo qu'aucun article ne référence (articles perdus en stockage temporaire, application fermée avant l'enregistrement du formulaire…) sont supprimés.
- Les photos ne font pas partie de l'export CSV (colonnes inchangées).
- `data/store.ts` n'importe aucun module natif de fichiers : `data/photos.ts` (importé par `app/_layout.tsx`) lui fournit ses fonctions de suppression via `setPhotoFileHooks()`. Sans elles (tests Node), la suppression des fichiers est ignorée.
- ⚠️ Le plugin **expo-image-picker** a été ajouté à `app.json` (textes d'autorisation photos / caméra en français) : cela modifie le *fingerprint* natif, il faut donc **un nouveau build natif** (`eas build`) — une mise à jour OTA ne suffit pas. Les textes d'autorisation en français n'apparaissent que dans ce nouveau build. Dans **Expo Go**, l'ajout de photo fonctionne (avec les textes d'autorisation d'Expo Go), mais comme les articles n'y sont gardés qu'en mémoire, ils sont perdus au relancement. « Photo indisponible » ne s'affiche que si le module natif manque (ancien build sans expo-image-picker).

## Suivi par numéro de série (appareils)

Les articles sont importés dans **Jira Service Management Assets**, qui gère **un objet par appareil, identifié par son numéro de série**. Le suivi est donc un **choix propre à chaque article** :

- **Suivi par numéro de série** : téléphones, ordinateurs, casques… Chaque appareil physique est une *unité* avec son numéro de série (obligatoire, unique, 64 caractères au plus, ne commençant pas par `=`, `+` ou `@` pour arriver tel quel dans Jira Assets) et, pour un téléphone, son **IMEI** (facultatif, 15 chiffres, clé de contrôle de Luhn vérifiée en direct pendant la saisie).
- **Suivi en quantité** : consommables et accessoires (ex. coques) — fonctionnement inchangé (quantité, « Ajuster le stock », Entrée / Sortie au scanner).

Activation : interrupteur « Suivi par numéro de série » du formulaire d'article. À la création, la quantité initiale est masquée (le stock démarre à 0). En modification, l'activation exige un stock à 0 et la désactivation exige qu'aucun numéro de série ne soit enregistré ; sinon l'erreur s'affiche sous l'interrupteur. Les articles suivis portent un badge « N° série » (Accueil, Articles, comptage) et leur stock s'affiche « 3 en stock ».

**Stock dérivé** : le stock d'un article suivi est le nombre de ses appareils « En stock ». Il n'est pas modifiable à la main (« Ajuster le stock » et la saisie de quantité au scanner sont remplacés par la gestion des appareils). Chaque passage de la frontière « En stock » est tracé par un mouvement de 1 portant le numéro de série (entrée en stock = Entrée, sortie du stock = Sortie). Supprimer un appareil « En stock » enregistre une Sortie de 1. Le seuil minimum (« Sous seuil ») continue de s'appliquer à ce stock.

Un numéro de série ou un IMEI ne peut pas être égal au code-barres ou au SKU d'un article (et inversement), pour qu'un scan reste non ambigu.

### Statuts d'un appareil

| Statut (app)    | Statut exporté (Jira) | En stock ? | Remarque |
|-----------------|-----------------------|------------|----------|
| En stock        | In Stock              | oui        | statut par défaut à l'ajout |
| Attribué        | Assigned              | non        | « Attribué à » obligatoire |
| En réparation   | In Repair             | non        | |
| Retiré          | Retired               | non        | hors service |
| Manquant        | Missing               | non        | posé par un comptage (appareil attendu non trouvé) |

### Écrans

- **Fiche article** (article suivi) : la carte de stock est remplacée par la section « Appareils » : stock dérivé, nombre d'appareils par statut, liste recherchable (numéro de série, IMEI, attributaire, note) et filtrable par statut, « Ajouter un appareil », « Scanner des appareils » et « Exporter ces appareils (CSV Jira Assets) ». Sans appareil : état vide « Aucun appareil » avec « Ajouter un appareil » / « Scanner ».
- **Nouvel appareil** (`/unit/new?itemId=…&serial=…`) et **Appareil** (`/unit/[id]`) : formulaire `components/UnitForm.tsx` — numéro de série (bouton « Scanner » : le scanner s'ouvre en mode sélection `/scan?pick=serial` et renvoie le code lu dans le champ), IMEI (clavier numérique, contrôle de Luhn en direct, scannable aussi), statut, attributaire (si « Attribué »), note. « Ajouter et saisir un autre » enchaîne les saisies. La fiche Appareil affiche aussi l'historique des mouvements de l'appareil et « Supprimer l'appareil » (avec confirmation).

### Scan

Ordre de résolution d'un code : **numéro de série / IMEI d'un appareil → code-barres / SKU d'un article → code inconnu**.

- **Appareil scanné** : fiche rapide (article, numéro de série, IMEI, statut, attributaire). Appareil « En stock » : « Attribuer » (demande le nom), « Envoyer en réparation », « Retirer ». Autre statut : « Remettre en stock ». Après chaque action : « Scanner un autre » ou « Fermer ».
- **Article suivi par numéro de série scanné** (son code-barres ou SKU) : *Entrée* → « Ajouter des appareils » : chaque numéro de série scanné (ou saisi) est ajouté « En stock » et le scanner reste prêt pour le suivant ; « Compléter (IMEI, statut…) » ouvre l'appareil ajouté. *Sortie* → se fait en scannant le numéro de série de l'appareil lui-même (puis Attribuer / Réparation / Retirer).
- **Article suivi en quantité** : panneau Entrée / Sortie inchangé.
- **Code inconnu** : « Créer l'article » ou « Ajouter comme appareil » (choix d'un article suivi par numéro de série, puis formulaire d'appareil prérempli avec le code comme numéro de série).

### Comptage par numéro de série

- Pour un article suivi, la carte du comptage affiche les appareils trouvés et « Scanner les appareils » (`/scan?countId=…&multi=1`) : le scanner reste ouvert, chaque numéro de série (ou IMEI) lu est marqué trouvé et l'article passe « Compté » ; un second scan du même appareil est signalé « Déjà compté ». Un appareil scanné par erreur se retire de la liste. Le bouton « Scanner » habituel accepte aussi un numéro de série.
- Comptage **à l'aveugle** : la liste des appareils attendus est masquée jusqu'à la clôture (seuls le nombre et la liste des appareils trouvés sont affichés). Sinon, les appareils attendus (« En stock ») sont listés et cochés au fur et à mesure ; un appareil trouvé qui n'était pas « En stock » est signalé « Inattendu ».
- **Terminer** : le résumé indique les appareils manquants et inattendus. « Appliquer les écarts au stock » passe les appareils attendus non trouvés en « Manquant » (Sortie de 1) et remet « En stock » les appareils trouvés qui ne l'étaient pas (Entrée de 1, attributaire retiré). « Terminer sans ajuster » ne modifie rien. Le comptage terminé liste les écarts par article (manquants, inattendus, non compté) ; l'export CSV du comptage les détaille (Trouvé / Manquant / Inattendu).

### Export pour Jira Service Management Assets

Profil › Export › « Exporter les appareils (Jira Assets) » (visible dès qu'un appareil existe) exporte tous les appareils ; la fiche d'un article suivi exporte ses seuls appareils. Le fichier `stockly-assets-<aaaammjj>-<hhmm>.csv` est écrit dans le cache puis partagé (repli : partage du texte).

- Format d'import CSV d'Assets (et non Excel) : **UTF-8 sans BOM**, séparateur **virgule**, fins de ligne CRLF, guillemets RFC 4180 (`""` pour un guillemet). Un texte commençant par `=`, `+`, `@`, tabulation ou retour chariot est préfixé d'une apostrophe (le `-` est conservé : un numéro de série peut commencer par un tiret).
- Une ligne par appareil, triée par article puis numéro de série. Colonnes :

| Colonne | Contenu |
|---------|---------|
| `Name` | « Article - numéro de série » (libellé de l'objet) |
| `Serial Number` | numéro de série — **identifiant unique** : à choisir comme attribut d'identification (*identifier*) dans le mapping de l'import Assets, pour qu'un nouvel import mette à jour les objets existants au lieu de les dupliquer |
| `IMEI` | 15 chiffres (vide si absent) |
| `Model` | nom de l'article |
| `Category` | dossier de l'article |
| `Status` | `In Stock`, `Assigned`, `In Repair`, `Retired`, `Missing` |
| `Assigned To` | attributaire (seulement pour `Assigned`) |
| `Received` | date de réception, ISO 8601 UTC (`2026-11-16T13:05:09Z`) |
| `Last Updated` | dernière modification, ISO 8601 UTC |
| `Note` | note libre |

- Dans Jira : *Assets › schéma › Import › CSV*, encodage UTF-8, délimiteur virgule ; associer chaque colonne à un attribut du type d'objet (ex. *Hardware*), `Serial Number` comme identifiant. Les statuts doivent exister dans le type de statut du schéma, et `Assigned To` est un texte (à rapprocher d'un utilisateur Jira si besoin).

## Comptage cyclique

- Le comptage « Comptage de l'inventaire » porte sur **tous les articles** (tous les dossiers), dans l'ordre de la liste ; un article créé en cours de comptage y est ajouté. Une fois le comptage terminé, sa liste est figée : les articles créés après la clôture n'y apparaissent pas (écran, totaux, export CSV).
- Avec un inventaire vide, le comptage contient 0 article : il ne peut être ni saisi, ni terminé, ni exporté.
- Les entrées d'une session enregistrée qui concernent des articles inexistants sont ignorées dans la progression et l'export.

## Scan

- `app/scan.tsx` lit les codes avec **expo-camera** (EAN-13, EAN-8, UPC-A, UPC-E, Code 128, Code 39, QR) et vibre brièvement à chaque lecture (désactivable : Profil › Vibration au scan).
- **Saisie manuelle** : bouton sur l'écran de scan pour taper un code-barres ou un SKU (utile sur simulateur ou sans caméra).
- Le code est recherché par numéro de série / IMEI d'appareil, puis par code-barres ou SKU (voir « Suivi par numéro de série » ci-dessus). Code inconnu → « Créer l'article » ouvre le formulaire `article/new` prérempli ; au retour, l'article créé est retrouvé et le mouvement Entrée / Sortie peut être saisi. « Ajouter comme appareil » l'enregistre comme numéro de série.
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
  scan.tsx             Scanner plein écran (Entrée / Sortie, appareils, comptage, saisie manuelle)
  article/new.tsx      Création d'un article
  article/[id].tsx     Détail d'un article (ajustement du stock ou appareils, modifier, supprimer)
  article/edit/[id].tsx Modification d'un article
  unit/new.tsx         Ajout d'un appareil (numéro de série)
  unit/[id].tsx        Fiche d'un appareil (modification, historique, suppression)
  count/[id].tsx       Comptage cyclique (progression enregistrée, comptage par numéro de série)
components/ui.tsx      Composants partagés (Btn, Stepper, Segmented, EmptyState, Thumb, ItemPhoto, TextField, SerialBadge, UnitStatusChip…)
components/ArticleForm.tsx Formulaire d'article (création et modification, photo, suivi par numéro de série)
components/UnitForm.tsx Formulaire d'appareil (numéro de série, IMEI, statut, attributaire, note)
constants/theme.ts     Couleurs et thème
data/mock.ts           Données de démonstration (chargées uniquement via « Charger les données d'exemple »)
data/storage.ts        Accès MMKV (repli en mémoire si indisponible)
data/store.ts          État de l'app persisté (articles, appareils, mouvements, comptages, préférences)
data/units.ts          Appareils : types, statuts, validation du numéro de série et de l'IMEI (module pur)
data/csv.ts            Construction du CSV d'un comptage (module pur, testable)
data/assetsCsv.ts      Construction du CSV d'import Jira Service Management Assets (module pur)
data/exportCount.ts    Exports CSV (comptage, appareils) : fichier + feuille de partage
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
