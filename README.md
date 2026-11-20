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
- **Écritures sur plusieurs clés** : MMKV n'écrit pas plusieurs clés de façon atomique. Chaque enregistrement écrit d'abord un journal (`v1.txn`, valeurs brutes avant/après de chaque clé), puis les clés, puis supprime le journal. Si l'application s'arrête ou si une écriture échoue en cours de route, le journal restant est traité au lancement suivant (avant toute lecture) ou au prochain enregistrement : toutes les clés à « après » → enregistrement terminé ; sinon toutes sont remises à « avant ». Le stockage ne garde donc jamais une moitié d'opération (par ex. un appareil sans son mouvement). Clé absente = aucun enregistrement en cours (ajout rétrocompatible, schéma inchangé). Si le journal ou une clé ne peut pas être lu, rien n'est décidé : le journal est conservé, rien n'est réécrit depuis la mémoire chargée, et celle-ci est rechargée depuis le stockage une fois la réparation faite.
- MMKV est un module natif : il faut un **build de développement** (`eas build --profile development` ou `npx expo run:android`). Dans **Expo Go**, le module est absent : l'application fonctionne quand même mais avec un **stockage temporaire** en mémoire (bandeau « Stockage temporaire » sur l'accueil et dans Profil), perdu à la fermeture.
- **Réinitialiser** : Profil › Stockage local › « Réinitialiser les données » efface tout (articles, photos, mouvements, comptages et préférences) : l'application repart vide. La licence Stockly Pro est conservée. Pensez à faire une sauvegarde avant (voir « Sauvegarde et restauration »).
- **Données d'exemple** : Profil › Stockage local › « Charger les données d'exemple » remplace, après confirmation, les articles, appareils, mouvements et comptages actuels par le jeu d'exemple de `data/mock.ts` (8 articles suivis en quantité, 3 articles suivis par numéro de série avec 7 appareils — un smartphone avec IMEI dont un double SIM (IMEI 2) et un en réparation, un ordinateur portable dont un attribué, un casque —, une coque suivie en quantité, et 2 mouvements) ; les préférences sont conservées.
- **Volume** : MMKV garde tout l'état en mémoire et réécrit la liste concernée à chaque modification ; c'est adapté à quelques milliers d'appareils (et d'articles) par appareil mobile. Au-delà (dizaines de milliers de numéros de série), il faudrait passer à une base locale indexée (ex. SQLite).

## Sauvegarde et restauration (gratuit)

Profil › **Données**. Gratuit dans les deux versions (sécurité des données). Cas d'usage : **passer à un nouveau téléphone**, ou **copier l'inventaire d'un téléphone sur le second téléphone** de la société (chaque téléphone garde ensuite son propre inventaire : aucune fusion, aucune synchronisation).

- **Sauvegarder les données** (`data/backup.ts`, `data/backupFile.ts`) : un fichier JSON `stockly-sauvegarde-<aaaammjj>-<hhmm>.json` est écrit dans le cache (les sauvegardes précédentes du cache sont supprimées) puis partagé (Drive, e-mail, WhatsApp…). Contenu :

  ```json
  { "format": "stockly-backup", "version": 1, "schemaVersion": 1,
    "createdAt": "2026-11-16T13:05:00.000Z", "appVersion": "1.0.0",
    "data": { "items": [], "units": [], "movements": [], "countSessions": {}, "prefs": {} } }
  ```

  Ni licence Stockly Pro ni code du téléphone (une licence est propre à un téléphone). **Les photos ne sont pas incluses** (version 1, indiqué dans l'écran) : les articles gardent le nom de leur photo, conservé à la restauration seulement si le fichier existe sur ce téléphone (restauration sur le même téléphone) ; sinon la référence est retirée (nouveau téléphone) et l'article s'affiche avec la vignette par défaut. Refusé si les données du téléphone n'ont pas pu être lues (mémoire non fiable) : la sauvegarde serait vide ou incomplète. Refusé aussi si le fichier dépasserait 50 Mo (UTF-8), la taille maximale acceptée à la restauration : un fichier qui ne pourrait pas être restauré n'est pas proposé.
- **Restaurer une sauvegarde** : choix du fichier (expo-document-picker, tous types proposés car un `.json` reçu par WhatsApp ou Drive est souvent signalé comme `application/octet-stream`), puis vérification **sans rien modifier** :
  - en-tête strict : `format`, `version` et `schemaVersion` entiers (une version plus récente est refusée : « Mettez l'application à jour »), date ISO ; un classeur Excel, un CSV, un JSON étranger ou un fichier tronqué sont refusés avec un message en français ;
  - contenu validé avec **les mêmes règles qu'au chargement** (`loadStateFromStorage` appliqué aux valeurs du fichier au lieu du stockage, aucune règle dupliquée) : articles, appareils (doublons de numéro de série / d'IMEI, article inconnu… ; un IMEI 2 invalide ou en double est seulement retiré, l'appareil est gardé), mouvements (500 au plus), comptages, préférences. Les entrées invalides sont écartées et **signalées** ; un fichier sans aucun article valide est refusé (un inventaire vide sauvegardé reste restaurable). Le fichier pouvant avoir été modifié à la main, les **règles de la saisie** s'appliquent en plus : SKU vide ou en double remplacé par un `SKU-n` libre, code-barres déjà utilisé retiré (aucun code ambigu au scan), article sans nom renommé « Article sans nom », quantité non entière arrondie, mouvement de quantité négative ou non entière écarté ; une section du mauvais type (ex. « appareils » qui n'est pas une liste) fait refuser le fichier.
  - Résumé affiché : date de la sauvegarde, nombre d'articles, d'appareils, de mouvements et de comptages, entrées écartées, photos absentes. En version gratuite, si la sauvegarde dépasse 50 articles ou 100 appareils, la restauration reste **permise** (ce sont les données de l'utilisateur) mais l'écran prévient que les nouvelles créations seront refusées sans Stockly Pro.
  - Bouton **« Remplacer toutes les données de ce téléphone »**, puis confirmation. Tout est remplacé (articles, appareils, mouvements, comptages, préférences) en **un seul enregistrement sous journal** (`applyRestore`) : tout ou rien, même en cas de stockage plein ou d'arrêt de l'application pendant l'écriture (le journal remet l'état précédent au lancement suivant). Les photos que plus aucun article ne référence ne sont supprimées **qu'après** l'enregistrement réussi. Refusé si la mémoire n'est pas fiable.

## Modifier et supprimer un article

- **Modifier** : bouton « Modifier » de la fiche article → écran `article/edit/[id]` (« Modifier l'article »). Il réutilise le formulaire de création (`components/ArticleForm.tsx`), prérempli : nom, code-barres, référence (SKU), dossier, seuil minimum, prix et photo. Les règles de validation sont celles de la création (nom et dossier obligatoires, seuil entier positif ou nul, prix positif ou nul, code-barres et SKU uniques — l'article lui-même excepté — et SKU différent du code-barres ; un SKU vidé est régénéré). Les erreurs s'affichent sous les champs concernés.
- Le **stock n'est pas modifiable** depuis ce formulaire : il se règle avec « Ajuster le stock » sur la fiche (ou par le scanner / un comptage), pour que chaque changement soit enregistré comme mouvement.
- **Supprimer** : « Supprimer l'article » sur la fiche, après confirmation. Sont supprimés avec l'article : sa photo, ses appareils (numéros de série), tous ses mouvements, ses saisies dans les comptages en cours et terminés (il disparaît aussi du stock attendu figé d'un comptage terminé, donc de son écran et de son export CSV) et un éventuel scan de comptage en attente. L'application revient ensuite à la liste des articles. Cette action est irréversible.

## Photos des articles

- Le formulaire de création / modification propose « Prendre une photo » (appareil photo) et « Choisir dans la galerie » (**expo-image-picker**, recadrage carré, compression ~60 %), ainsi que « Supprimer la photo ». En cas de refus d'autorisation, une alerte propose d'ouvrir les réglages de l'appareil.
- La photo est copiée dans le dossier `photos` des **documents de l'application** (`Paths.document` d'**expo-file-system**), uniquement sur l'appareil. L'article n'enregistre que le **nom du fichier** (ex. `item-12-…jpg`), jamais un chemin absolu (le chemin du conteneur iOS change entre deux mises à jour) ; l'URI est recalculé à l'affichage (`data/photos.ts`).
- La photo s'affiche dans la liste des articles, la fiche article, l'activité récente de l'accueil et le comptage ; à défaut (aucune photo, fichier absent ou module natif indisponible), la vignette par défaut est affichée.
- Fichiers : une photo remplacée ou retirée est supprimée après l'enregistrement ; une photo choisie puis abandonnée (Annuler, retour) est supprimée ; la suppression d'un article supprime sa photo ; « Réinitialiser les données » et « Charger les données d'exemple » suppriment toutes les photos. Au démarrage, les fichiers photo qu'aucun article ne référence (articles perdus en stockage temporaire, application fermée avant l'enregistrement du formulaire…) sont supprimés.
- Les photos ne font pas partie de l'export CSV (colonnes inchangées) ni de la sauvegarde (version 1).
- `data/store.ts` n'importe aucun module natif de fichiers : `data/photos.ts` (importé par `app/_layout.tsx`) lui fournit ses fonctions de suppression via `setPhotoFileHooks()`. Sans elles (tests Node), la suppression des fichiers est ignorée.
- ⚠️ Le plugin **expo-image-picker** a été ajouté à `app.json` (textes d'autorisation photos / caméra en français) : cela modifie le *fingerprint* natif, il faut donc **un nouveau build natif** (`eas build`) — une mise à jour OTA ne suffit pas. Les textes d'autorisation en français n'apparaissent que dans ce nouveau build. Dans **Expo Go**, l'ajout de photo fonctionne (avec les textes d'autorisation d'Expo Go), mais comme les articles n'y sont gardés qu'en mémoire, ils sont perdus au relancement. « Photo indisponible » ne s'affiche que si le module natif manque (ancien build sans expo-image-picker).

## Suivi par numéro de série (appareils)

Les articles sont importés dans **Jira Service Management Assets**, qui gère **un objet par appareil, identifié par son numéro de série**. Le suivi est donc un **choix propre à chaque article** :

- **Suivi par numéro de série** : téléphones, ordinateurs, casques… Chaque appareil physique est une *unité* avec son numéro de série (obligatoire, unique, 64 caractères au plus, ne commençant pas par `=`, `+` ou `@` pour arriver tel quel dans Jira Assets) et, pour un téléphone, son **IMEI** (facultatif, 15 chiffres, clé de contrôle de Luhn vérifiée en direct pendant la saisie). Un téléphone double SIM peut recevoir un **IMEI 2** (facultatif, mêmes contrôles) : seulement si l'IMEI 1 est renseigné (sinon « Renseignez d'abord l'IMEI 1. ») et différent de lui. Un scan de l'IMEI 1 ou de l'IMEI 2 retrouve l'appareil. Champ ajouté de façon rétrocompatible (`Unit.imei2`, schéma inchangé) : les données existantes se chargent telles quelles ; un IMEI 2 stocké invalide ou en double est retiré au chargement sans perdre l'appareil.
- **Suivi en quantité** : consommables et accessoires (ex. coques) — fonctionnement inchangé (quantité, « Ajuster le stock », Entrée / Sortie au scanner).

Activation : interrupteur « Suivi par numéro de série » du formulaire d'article. À la création, la quantité initiale est masquée (le stock démarre à 0). En modification, l'activation exige un stock à 0 et la désactivation exige qu'aucun numéro de série ne soit enregistré ; sinon l'erreur s'affiche sous l'interrupteur. Les articles suivis portent un badge « N° série » (Accueil, Articles, comptage) et leur stock s'affiche « 3 en stock ».

**Stock dérivé** : le stock d'un article suivi est le nombre de ses appareils « En stock ». Il n'est pas modifiable à la main (« Ajuster le stock » et la saisie de quantité au scanner sont remplacés par la gestion des appareils). Chaque passage de la frontière « En stock » est tracé par un mouvement de 1 portant le numéro de série (entrée en stock = Entrée, sortie du stock = Sortie). Supprimer un appareil « En stock » enregistre une Sortie de 1. Le seuil minimum (« Sous seuil ») continue de s'appliquer à ce stock.

Un numéro de série ou un IMEI (1 ou 2) ne peut pas être égal au code-barres ou au SKU d'un article (et inversement), pour qu'un scan reste non ambigu. Les IMEI 1 et IMEI 2 de tous les appareils sont uniques ensemble : l'IMEI 2 d'un appareil ne peut être ni l'IMEI 1 ni l'IMEI 2 d'un autre, ni un numéro de série.

### Statuts d'un appareil

| Statut (app)    | Statut exporté (Jira) | En stock ? | Remarque |
|-----------------|-----------------------|------------|----------|
| En stock        | In Stock              | oui        | statut par défaut à l'ajout |
| Attribué        | Assigned              | non        | « Attribué à » obligatoire |
| En réparation   | In Repair             | non        | |
| Retiré          | Retired               | non        | hors service |
| Manquant        | Missing               | non        | posé par un comptage (appareil attendu non trouvé) |

### Écrans

- **Fiche article** (article suivi) : la carte de stock est remplacée par la section « Appareils » : stock dérivé, nombre d'appareils par statut, liste recherchable (numéro de série, IMEI 1 et 2, attributaire, note) et filtrable par statut, « Ajouter un appareil », « Scanner des appareils » et « Exporter ces appareils (CSV Jira Assets) ». Sans appareil : état vide « Aucun appareil » avec « Ajouter un appareil » / « Scanner ».
- **Nouvel appareil** (`/unit/new?itemId=…&serial=…&imei=…&imei2=…`) et **Appareil** (`/unit/[id]`) : formulaire `components/UnitForm.tsx` — numéro de série (bouton « Scanner » : le scanner s'ouvre en mode sélection `/scan?pick=serial` et renvoie le code lu dans le champ), IMEI (clavier numérique, contrôle de Luhn en direct, scannable aussi : `/scan?pick=imei`), IMEI 2 facultatif pour les téléphones double SIM (mêmes contrôles, « Renseignez d'abord l'IMEI 1. » sans IMEI 1, scannable : `/scan?pick=imei2`), statut, attributaire (si « Attribué »), note. « Ajouter et saisir un autre » enchaîne les saisies. La fiche Appareil affiche aussi l'historique des mouvements de l'appareil et « Supprimer l'appareil » (avec confirmation).

### Scan

Ordre de résolution d'un code : **numéro de série / IMEI 1 / IMEI 2 d'un appareil → code-barres / SKU d'un article → code inconnu**.

- **Appareil scanné** : fiche rapide (article, numéro de série, IMEI, IMEI 2, statut, attributaire). Appareil « En stock » : « Attribuer » (demande le nom), « Envoyer en réparation », « Retirer ». Autre statut : « Remettre en stock ». Après chaque action : « Scanner un autre » ou « Fermer ».
- **Article suivi par numéro de série scanné** (son code-barres ou SKU) : *Entrée* → « Ajouter des appareils » : chaque code lu par la caméra est proposé (« Ajouter » / « Ignorer », un code ignoré n'est plus proposé pendant l'ajout), un numéro saisi à la main est ajouté directement ; l'appareil est ajouté « En stock » et le scanner reste prêt pour le suivant ; « Compléter (IMEI, statut…) » ouvre l'appareil ajouté. *Sortie* → se fait en scannant le numéro de série de l'appareil lui-même (puis Attribuer / Réparation / Retirer).
- **Article suivi en quantité** : panneau Entrée / Sortie inchangé.
- **Code inconnu** : « Créer l'article » ou « Ajouter comme appareil » (choix d'un article suivi par numéro de série, puis formulaire d'appareil prérempli avec le code comme numéro de série).

#### Scanner une boîte

La plupart des appareils arrivent dans une boîte dont l'étiquette porte plusieurs codes-barres (numéro de série, IMEI 1, IMEI 2, code produit EAN/UPC, référence / modèle). « **Scanner une boîte** » les lit tous d'un coup : bouton de la fiche d'un article suivi (sous « Scanner des appareils »), du panneau « Ajouter des appareils », de l'*Entrée* d'un article suivi scanné, et du scanner au repos (`/scan?box=1`, avec `&addItemId=…` pour fixer l'article).

- La caméra reste active : chaque **nouveau** code distinct est ajouté à la liste (courte vibration si elle est activée), un code relu est ignoré. Un QR ou Code 128 à plusieurs champs (lignes, `;`, `,`, `|`, tabulation, `SN:…`, `IMEI1=…`, `S/N …`, `IMEI1 3569…` sans deux-points, contenu JSON, chaîne GS1 `(01)…(21)…`) est découpé en champs. Un QR Wi-Fi ou carte de visite n'est jamais proposé comme numéro de série.
- Chaque code reçoit une pastille : **N° de série**, **IMEI 1**, **IMEI 2**, **Code produit**, **Autre**. Toucher un code en fait le numéro de série (le toucher à nouveau annule le choix) ; ce choix l'emporte sur la proposition automatique et reste valable pour les codes lus ensuite (un code choisi n'est plus utilisé comme IMEI ou code produit).
- **Article** : celui de la fiche d'origine (ou choisi dans la liste), sinon celui dont le code-barres (ou SKU) est le code produit de la boîte, sinon « Choisir l'article » (liste des articles suivis par numéro de série). Un article déduit du code produit n'est repris pour la boîte suivante que si celle-ci n'a pas de code produit lisible. Un code produit d'article suivi en quantité, ou inconnu, est signalé.
- « **Ajouter l'appareil** » (actif quand un numéro de série et un article sont connus) enregistre l'appareil « En stock » avec les mêmes contrôles que la saisie (doublons, limite de la version gratuite avec lien vers Stockly Pro, journal d'écriture) : numéro de série, **IMEI 1** dans le champ IMEI, **IMEI 2 dans le champ IMEI 2** (la note n'est plus utilisée pour l'IMEI 2 ; un IMEI 2 lu sans IMEI 1 devient l'IMEI 1). Un numéro de série ou un IMEI (1 ou 2) déjà enregistré comme numéro de série, IMEI 1 ou IMEI 2 d'un appareil est signalé avant l'ajout (« Appareil déjà enregistré : … · article »). Après l'ajout (« Appareil ajouté : … », compteur de la session), la liste se vide pour la boîte suivante et l'article est conservé ; les codes de la boîte précédente encore devant la caméra sont ignorés.
- « **Boîte suivante** » vide la liste sans rien enregistrer ; « **Modifier** » ouvre le formulaire d'appareil prérempli (numéro de série, IMEI, IMEI 2) ; « **Saisir** » ajoute un code à la main.

Règles de reconnaissance (`data/boxLabel.ts`, **génériques** pour l'instant) : IMEI = 15 chiffres à clé de Luhn valide (aussi précédé de « IMEI », « IMEI1 », « IMEI 2 », « MEID ») ; code produit = symbologie EAN/UPC, ou 8/12/13/14 chiffres à clé GTIN valide ; une clé explicite l'emporte sur la forme de la valeur (une valeur « S/N » n'est jamais prise pour un IMEI ou un code produit ; « MEID », « IMEISV », lot, dates, référence et modèle ne sont jamais des numéros de série) ; numéro de série = candidat le mieux noté (clé « S/N », « SN », « Serial No », « N° de série » ; Code 128 / 39 ; 6 à 20 caractères mêlant lettres et chiffres), pénalisé s'il ne contient que des chiffres, contient `/`, `#`, `+` ou des espaces, ressemble à une référence / modèle (`SM-A155F/DSN`, `…ZD/A`, `-EU`), à une adresse web, à une adresse MAC (codes « Wi-Fi ID » / « Bluetooth ID » des boîtes Apple, 12 caractères hexadécimaux), ou est le code d'un article. Un Code 128 commençant par « S » (convention Apple « (S) Serial No. ») est proposé **sans** ce « S » en premier, puis avec. Quelques indices de format par fabricant (Samsung, Dell, HP, Apple) ne servent qu'à départager. Vérifié sur des étiquettes réelles : Samsung Galaxy A07 (S/N `R8…`, IMEI 1 et 2, EAN), MacBook (S/N sans le « S », référence `1P…`, adresses Wi-Fi / Bluetooth écartées), casques Jabra (S/N de 11 chiffres, UPC + EAN), hub UGREEN (code `SN…` de l'étiquette anti-contrefaçon). Les autres marques restent à vérifier.

### Comptage par numéro de série

- Pour un article suivi, la carte du comptage affiche les appareils trouvés et « Scanner les appareils » (`/scan?countId=…&multi=1`) : le scanner reste ouvert, chaque numéro de série (ou IMEI 1 / IMEI 2) lu est marqué trouvé et l'article passe « Compté » ; un second scan du même appareil est signalé « Déjà compté ». Un appareil scanné par erreur se retire de la liste. Le bouton « Scanner » habituel accepte aussi un numéro de série.
- Comptage **à l'aveugle** : la liste des appareils attendus est masquée jusqu'à la clôture (seuls le nombre et la liste des appareils trouvés sont affichés). Sinon, les appareils attendus (« En stock ») sont listés et cochés au fur et à mesure ; un appareil trouvé qui n'était pas « En stock » est signalé « Inattendu ».
- **Terminer** : le résumé indique les appareils manquants et inattendus. « Appliquer les écarts au stock » passe les appareils attendus non trouvés en « Manquant » (Sortie de 1) et remet « En stock » les appareils trouvés qui ne l'étaient pas (Entrée de 1, attributaire retiré). « Terminer sans ajuster » ne modifie rien. Le comptage terminé liste les écarts par article (manquants, inattendus, non compté) ; l'export CSV du comptage les détaille (Article, Numéro de série, IMEI, IMEI 2, Statut, Résultat : Trouvé / Manquant / Inattendu).

### Export pour Jira Service Management Assets

**Réservé à Stockly Pro.** Profil › Import / Export › « Exporter les appareils (Jira Assets) » (visible dès qu'un appareil existe ; en version gratuite, le bouton propose Stockly Pro) exporte tous les appareils ; la fiche d'un article suivi exporte ses seuls appareils. Le fichier `stockly-assets-<aaaammjj>-<hhmm>.csv` est écrit dans le cache puis partagé (repli : partage du texte).

- Format d'import CSV d'Assets (et non Excel) : **UTF-8 sans BOM**, séparateur **virgule**, fins de ligne CRLF, guillemets RFC 4180 (`""` pour un guillemet). Un texte commençant par `=`, `+`, `@`, tabulation ou retour chariot est préfixé d'une apostrophe (le `-` est conservé : un numéro de série peut commencer par un tiret).
- Une ligne par appareil, triée par article puis numéro de série. Colonnes :

| Colonne | Contenu |
|---------|---------|
| `Name` | « Article - numéro de série » (libellé de l'objet) |
| `Serial Number` | numéro de série — **identifiant unique** : à choisir comme attribut d'identification (*identifier*) dans le mapping de l'import Assets, pour qu'un nouvel import mette à jour les objets existants au lieu de les dupliquer |
| `IMEI` | 15 chiffres (vide si absent) |
| `IMEI 2` | second IMEI d'un téléphone double SIM, 15 chiffres (vide si absent) |
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

## Import et export Excel (Stockly Pro)

La plupart des équipes suivent leur parc dans Excel : l'import reprend ce fichier tel quel, et l'export le régénère (un fichier exporté se réimporte, dans n'importe quel ordre, avec les SKU, codes-barres, seuils et prix). **Pour copier tout l'inventaire d'un téléphone vers le second téléphone de la société, ou vers un nouveau téléphone, utilisez plutôt la sauvegarde** (Profil › Données, gratuite) : elle reprend aussi les articles suivis par numéro de série sans appareil (absents des exports Excel), l'historique des mouvements et les comptages.

### Importer (`app/import.tsx`, `data/importExcel.ts`, `importInventory` dans `data/store.ts`)

Entrées : Profil › Import / Export › « Importer depuis Excel », et l'onglet Articles (bouton d'en-tête, et sous l'état vide).

1. **Fichier** : `.xlsx` (Excel, LibreOffice, Google Sheets…) ou CSV, choisi avec **expo-document-picker** (module natif : **nouveau build EAS nécessaire**). Le format est reconnu au contenu. CSV : séparateur `;`, `,` ou tabulation détecté, BOM, guillemets, CRLF ; encodage UTF-8, UTF-16 (« Texte Unicode ») ou Windows-1252 (« CSV (séparateur : point-virgule) » d'Excel) ; un fichier mélangeant UTF-8 et Windows-1252 (ex. un caractère isolé après une modification) est lu caractère par caractère, avec un avertissement, au lieu d'être entièrement mal décodé. `.xls` (Excel 97-2003) et classeurs protégés par mot de passe : refusés avec la marche à suivre (« Enregistrer sous » .xlsx ou CSV). 20 Mo et 10 000 lignes au maximum. Formules : la dernière valeur calculée par Excel est lue (formule sans résultat enregistré dans la colonne du numéro de série, de l'IMEI ou de la quantité : ligne ignorée avec la marche à suivre). Format de cellule à zéros de tête (`000000`) : les zéros affichés par Excel sont gardés.
2. **Feuille et ligne d'en-tête** : feuilles masquées ignorées ; la ligne d'en-tête est cherchée dans les 30 premières lignes (les lignes de titre au-dessus sont ignorées) et peut être changée (‹ ›).
3. **Colonnes** : reconnues sans tenir compte des accents, de la casse, des espaces ni de la ponctuation ; chaque champ peut être réaffecté ou « Ignorer ». Aperçu des 3 premières lignes.
4. **Vérifier l'import** : simulation complète (rien n'est enregistré) avec les règles de la saisie (`validateNewItem`, `validateUnit`) : articles à créer, articles existants complétés, appareils à ajouter, articles déjà présents, **lignes ignorées avec leur numéro et le motif** (numéro de série ou IMEI (1 ou 2) en double dans le fichier ou déjà enregistré, IMEI ou IMEI 2 invalide, IMEI 2 sans IMEI 1, numéro de série commençant par `=`, `+` ou `@` (ou par `-` suivi d'un opérateur de formule), **numéro de série ou IMEI abîmé par Excel** (affiché en notation scientifique `3,56938E+14` dans un CSV, nombre de plus de 15 chiffres, décimal ou au format date dans un classeur : mettre la colonne au format « Texte »), nom ou numéro de série manquant, nom d'article ou catégorie de plus de 200 caractères, appareil attribué sans attributaire, quantité invalide, SKU / code-barres déjà utilisés, limite de la version gratuite…) et avertissements (statut inconnu → « En stock », date illisible ou dans le futur → date du jour, note tronquée…). Année sur 2 chiffres : 20xx, sauf au-delà de l'année prochaine (« 99 » = 1999). Possible en version gratuite.
5. **Importer** (Stockly Pro) : tout est enregistré en **une seule opération** (journal d'écriture : tout ou rien, même en cas de stockage plein ou d'arrêt de l'application).

| Champ | Noms de colonnes reconnus (exemples) |
|---|---|
| Article (obligatoire) | Article, Désignation, Modèle, Model, Produit, Libellé, Nom, Name |
| Catégorie | Catégorie, Category, Famille, Type, Dossier |
| Numéro de série | Numéro de série, N° de série, S/N, SN, Serial, Serial Number |
| IMEI | IMEI, IMEI 1, IMEI SIM 1, IMEI (SIM 1), First IMEI, Premier IMEI |
| IMEI 2 | IMEI 2, IMEI2, IMEI-2, Second IMEI, IMEI SIM 2, IMEI secondaire — mêmes contrôles que l'IMEI (ligne ignorée si invalide, en double, égal à l'IMEI 1 ou sans IMEI 1) |
| Statut | Statut, Status, État — valeurs : En stock / Disponible / In Stock, Attribué / En service / Assigned, En réparation / SAV / Hors service / In Repair, Retiré / Réformé / Retired, Manquant / Perdu / Volé / Missing |
| Attribué à | Attribué à, Utilisateur, Affecté à, Assigned To, Owner |
| Date de réception | Date de réception, Reçu le, Received, Date d'achat (jj/mm/aaaa [HH:MM], aaaa-mm-jj, ou date Excel) |
| Note | Note, Commentaire, Remarque, Observations |
| Quantité | Quantité, Qté, Qty, Stock |
| SKU / Référence | SKU, Référence, Réf., Code article |
| Code-barres | Code-barres, EAN, Barcode, GTIN |
| Seuil minimum | Seuil, Seuil minimum, Stock minimum, Min |
| Prix | Prix, Prix unitaire, Price (« 1 500 FCFA », « 12,50 ») |

Règles :

- **Ligne avec numéro de série** → appareil d'un article **suivi par numéro de série**, retrouvé par son nom (casse, accents et espaces ignorés) ou créé (catégorie de la ligne, sinon « Sans catégorie »). Un article existant suivi en quantité ne reçoit pas d'appareils (ligne ignorée : activer d'abord le suivi sur sa fiche). Statut vide : « Attribué » si un attributaire est indiqué, sinon « En stock ».
- **Ligne sans numéro de série** → **article suivi en quantité**, créé avec la quantité indiquée (0 si vide). **Si un article du même nom existe déjà, rien n'est modifié** (« existe déjà ») : réimporter le même fichier ne double pas le stock, et le stock d'un article existant ne change que par un mouvement ou un comptage tracés. Si une colonne « Numéro de série » est choisie, une ligne sans numéro de série ni quantité est ignorée (« Numéro de série manquant »).
- Réimporter un fichier déjà importé n'ajoute rien (doublons signalés).
- **Mouvements** : un mouvement d'entrée récapitulatif par article (quantité initiale, ou nombre d'appareils « En stock » ajoutés), et non un par appareil, pour ne pas remplacer l'historique (500 mouvements conservés) par des milliers de lignes. La date de réception de chaque appareil reprend la colonne « Date de réception ».
- **Version gratuite** : la vérification montre les lignes qui dépasseraient 50 articles / 100 appareils ; l'import propose Stockly Pro.

Exemple de feuille (une ligne de titre au-dessus est acceptée) :

| Désignation | Catégorie | N° de série | IMEI | État | Utilisateur | Date de réception | Qté |
|---|---|---|---|---|---|---|---|
| iPhone 15 | Téléphonie | F2LX0001 | 356938035643809 | Attribué | Awa Diop | 14/03/2025 | |
| iPhone 15 | Téléphonie | F2LX0002 | | En stock | | 15/03/2025 | |
| Câble USB-C | Accessoires | | | | | | 25 |

### Exporter (`data/devicesCsv.ts`)

Profil › Import / Export : « Exporter les appareils (Excel) » (`stockly-appareils-<aaaammjj>-<hhmm>.csv` : Article, Catégorie, Numéro de série, IMEI, IMEI 2, Statut, Attribué à, Reçu le, Modifié le, Note, puis SKU, Code-barres, Seuil et Prix de l'article) et « Exporter les articles (Excel) » (`stockly-articles-….csv`, articles suivis en quantité : Article, SKU, Code-barres, Catégorie, Quantité, Seuil, Prix). Un article suivi par numéro de série sans aucun appareil ne figure dans aucun des deux fichiers (voir la sauvegarde). Même format que l'export des comptages (`;`, UTF-8 avec BOM, CRLF, formules neutralisées, identifiants numériques `="…"`). **Deux fichiers, un tableau chacun**, plutôt qu'un fichier à deux sections : Excel ouvre un CSV comme une seule feuille, et trier ou filtrer une feuille qui contient deux tableaux mélange les lignes ; chaque fichier se trie et se filtre directement, et se réimporte tel quel.

## Stockly Pro (licence hors ligne)

Offre : **150 000 FCFA / an, pour 1 société et jusqu'à 2 téléphones**. Chaque téléphone garde son propre inventaire (aucun serveur, aucune synchronisation) : une licence = un code d'activation par téléphone.

| | Gratuit | Pro |
|---|---|---|
| Articles | 50 au maximum | illimité |
| Appareils (numéros de série) | 100 au maximum | illimité |
| Export CSV des comptages, photos, scan, comptages… | oui | oui |
| Export Jira Assets | — | oui |
| Import Excel (.xlsx, CSV), export Excel des appareils et des articles | — (vérification possible) | oui |
| Sauvegarde / restauration | oui (sécurité des données) | oui |

**Limites** (`data/store.ts`, `FREE_LIMITS`) : seules les **créations** sont refusées au-delà (`createItem`, `addUnit` — formulaire, « Ajouter et saisir un autre », boucle « Ajouter des appareils » du scanner ; l'import Excel applique les mêmes limites ligne par ligne), avec un message mentionnant Stockly Pro (`limit: 'items' | 'units'` dans le résultat) et le lien « Découvrir Stockly Pro » (`components/ProNotice.tsx`). Des données au-delà des limites (licence expirée) restent lisibles, modifiables et supprimables. « Charger les données d'exemple » n'est pas limité. `getPlanUsage()` donne l'utilisation (x/50, y/100).

**Profil › Stockly Pro** : statut (« Gratuit » ou « Pro jusqu'au JJ/MM/AAAA » et la société), utilisation, prix, **code du téléphone** (Copier / Partager), texte de contact (`constants/license.ts > LICENSE_CONTACT`), champ pour coller le **code d'activation** (« Coller », « Activer »), « Retirer la licence de ce téléphone ».

### Fonctionnement (`data/licenseCode.ts`, `data/license.ts`)

- **Code du téléphone** : 75 bits aléatoires créés une seule fois, gardés dans **expo-secure-store** (Keychain iOS « cet appareil uniquement » : jamais copié vers un autre iPhone par iCloud ou une sauvegarde) et recopiés dans une instance MMKV dédiée (`stockly-license`, non effacée par « Réinitialiser les données ») ; repli en mémoire. iOS : les fichiers MMKV font partie des sauvegardes iCloud / Finder ; une copie MMKV restaurée sur un autre iPhone (Keychain vide alors que le code y avait été écrit) est ignorée et un nouveau code est créé : la licence de l'autre iPhone ne s'y applique pas. Android : SecureStore et MMKV sont exclus de la sauvegarde automatique ; la copie MMKV sert de secours si le Keystore devient illisible. Une réinstallation ou « Effacer les données » sur Android crée un nouveau code (nouveau code d'activation à émettre). Affiché en base 32 de Crockford, par groupes de 4, avec un caractère de contrôle (Luhn mod 32) : ex. `0W3G-E1R7-0W3G-E1RS`. Saisie tolérante (minuscules, espaces, O→0, I/L→1) ; une faute de frappe est détectée.
- **Code d'activation** : `STK1.<charge>.<signature>` en base64url ; charge = JSON `{"v":1,"c":société,"d":code téléphone,"e":"AAAA-MM-JJ","n":numéro}`, signature **Ed25519** (bibliothèque **tweetnacl**) vérifiée hors ligne avec `app.json > expo.extra.licensePublicKey`. Les retours à la ligne d'une messagerie sont ignorés au collage.
- À chaque lancement (et à chaque changement de jour), le code enregistré est revérifié : signature, téléphone, expiration (valable jusqu'au jour `e` **inclus**). Expiré → version gratuite, données conservées.
- **Stockage illisible** : si le code du téléphone ne peut pas être lu (Keychain / Keystore sans code valide et copie MMKV illisible), aucun nouveau code n'est créé (il remplacerait celui de la licence émise) : version gratuite pour le moment, activation refusée avec « Réessayez », nouvelle lecture à l'appel suivant (rien n'est mis en cache).
- **Retirer la licence** : vérifié par relecture ; si une copie lisible du code d'activation subsiste (stockage en erreur), l'écran affiche « Licence non retirée » au lieu d'un faux succès.
- **Horloge** : la date la plus récente déjà vue (toutes copies confondues) est mémorisée ; reculer l'horloge ne prolonge donc jamais une licence au-delà d'une date déjà atteinte. Limite : reculer l'horloge *avant* l'expiration et ne plus l'avancer n'est pas détectable sans serveur.
- Clé publique absente ou encore provisoire → l'activation affiche « la clé publique de licence n'est pas configurée… ».

### Émettre des licences (propriétaire, Node ≥ 22.18)

`scripts/license.mjs` (non inclus dans l'application) importe directement `data/licenseCode.ts` : même code que l'application.

```bash
pnpm license:keygen                       # écrit ~/.stockly/stockly-license-private.key (ou --out chemin, ou $STOCKLY_LICENSE_KEY), affiche la clé publique
# → coller la clé publique dans app.json > expo.extra.licensePublicKey AVANT le build, renseigner constants/license.ts > LICENSE_CONTACT
pnpm license:issue --company "Ets Diallo" --phone 0W3G-E1R7-0W3G-E1RS --expires 2027-11-16 [--key chemin] [--serial ID]
# → affiche le code d'activation STK1.… à envoyer au client (WhatsApp, SMS…)
```

- **Gardez la clé privée secrète et sauvegardée** (par défaut hors du projet, dans `~/.stockly/` ; `stockly-license-private.key` et `*.key` sont aussi dans `.gitignore`). Perdue, aucun nouveau code ne peut être émis pour les builds existants ; régénérée, la nouvelle clé publique invalide tous les codes existants.
- Deux téléphones = deux codes (un par code téléphone). Un renouvellement = un nouveau code avec une nouvelle date, collé par-dessus.
- **`licensePublicKey` doit être la vraie clé dès le premier build vendu** : `expo.extra` fait partie du *fingerprint* (`runtimeVersion`), donc une modification de `app.json` exige un **nouveau build** (une mise à jour OTA n'atteint pas les builds existants). Un build publié avec la valeur provisoire ne peut jamais activer Pro.
- `LICENSE_CONTACT` (`constants/license.ts`) est du JavaScript : il se modifie par une mise à jour OTA (EAS Update) ou un build.

## Stack

- **Expo SDK 58**, React Native 0.88, React 19, nouvelle architecture activée
- **expo-router** (routes basées sur les fichiers, routes typées)
- **expo-camera** pour le scan, **expo-image-picker** + **expo-file-system** pour les photos d'articles, **expo-location** pour la géolocalisation
- **expo-document-picker** (choix du fichier à importer) et **fflate** (décompression des .xlsx, pur JavaScript)
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
  import.tsx           Import depuis Excel / CSV (colonnes, aperçu, vérification, import)
components/ui.tsx      Composants partagés (Btn, Stepper, Segmented, EmptyState, Thumb, ItemPhoto, TextField, SerialBadge, UnitStatusChip…)
components/ArticleForm.tsx Formulaire d'article (création et modification, photo, suivi par numéro de série)
components/UnitForm.tsx Formulaire d'appareil (numéro de série, IMEI, IMEI 2, statut, attributaire, note)
constants/theme.ts     Couleurs et thème
constants/license.ts   Texte de contact « comment acheter Stockly Pro » (LICENSE_CONTACT, modifiable par OTA)
data/mock.ts           Données de démonstration (chargées uniquement via « Charger les données d'exemple »)
data/storage.ts        Accès MMKV (repli en mémoire si indisponible)
data/store.ts          État de l'app persisté (articles, appareils, mouvements, comptages, préférences)
data/units.ts          Appareils : types, statuts, validation du numéro de série et de l'IMEI / IMEI 2 (module pur)
data/csv.ts            Construction du CSV d'un comptage (module pur, testable)
data/assetsCsv.ts      Construction du CSV d'import Jira Service Management Assets (module pur)
data/exportCount.ts    Exports CSV (comptage, Jira Assets, Excel) : fichier + feuille de partage
data/devicesCsv.ts     Export Excel des appareils et des articles en quantité (module pur)
data/importExcel.ts    Import : lecture .xlsx (fflate) et CSV, en-têtes, correspondance, lignes interprétées (module pur)
data/importPick.ts     Choix et lecture d'un fichier (import, restauration : expo-document-picker, expo-file-system)
data/backup.ts         Sauvegarde / restauration : création et vérification du fichier JSON (module pur)
data/backupFile.ts     Sauvegarde / restauration : partage du fichier et choix du fichier à restaurer
data/licenseCode.ts    Licence Pro : code téléphone, code d'activation signé Ed25519 (module pur, partagé avec le script)
data/license.ts        Licence Pro : stockage (SecureStore + MMKV), vérification au lancement, limites gratuites
components/ProNotice.tsx Encart / alerte « Stockly Pro » avec lien vers Profil › Stockly Pro
scripts/license.mjs    Outil du propriétaire : keygen, issue (non inclus dans l'application)
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

- Inclure les photos dans la sauvegarde (archive ZIP, version 2 du format) ; aucune synchronisation serveur pour l'instant.
- Remplacer les icônes provisoires de `assets/images/` par les visuels définitifs.
- Le code-barres affiché sur la fiche détail est décoratif ; utilisez `react-native-svg` avec une bibliothèque de codes-barres pour un vrai rendu.
- Sentry : `@sentry/react-native` et son plugin sont installés, mais le SDK n'est pas encore initialisé. Ajoutez `Sentry.init({ dsn: '…' })` dans `app/_layout.tsx`, un `metro.config.js` basé sur `getSentryExpoConfig`, et le secret `SENTRY_AUTH_TOKEN` dans EAS pour l'envoi des source maps.
