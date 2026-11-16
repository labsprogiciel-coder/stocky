# Stockly mobile (Expo)

Application de terrain pour la gestion de stock : accueil orienté tâches, liste des articles, fiche détail, scanner de codes-barres (entrées / sorties), tâches et comptage cyclique.

L'application fonctionne **entièrement hors ligne**, sans serveur : articles, mouvements, comptages et préférences sont enregistrés sur l'appareil. Au premier lancement, elle est initialisée avec les données d'exemple de `data/mock.ts`.

## Stockage hors ligne

- Les données sont persistées avec **react-native-mmkv** (v4, Nitro Modules) via `data/storage.ts` ; `data/store.ts` expose une API synchrone aux écrans et enregistre chaque modification immédiatement.
- Clés versionnées (`schemaVersion` = 1, données sous `v1.items`, `v1.movements`, `v1.countSessions`, `v1.prefs`, `v1.meta`). Les données absentes, corrompues ou invalides sont ignorées et remplacées par les données d'exemple.
- MMKV est un module natif : il faut un **build de développement** (`eas build --profile development` ou `npx expo run:android`). Dans **Expo Go**, le module est absent : l'application fonctionne quand même mais avec un **stockage temporaire** en mémoire (bandeau « Stockage temporaire » sur l'accueil et dans Profil), perdu à la fermeture.
- **Réinitialiser** : Profil › Stockage local › « Réinitialiser les données » efface tout et recharge les données d'exemple.

## Scan

- `app/scan.tsx` lit les codes avec **expo-camera** (EAN-13, EAN-8, UPC-A, UPC-E, Code 128, Code 39, QR) et vibre brièvement à chaque lecture (désactivable : Profil › Vibration au scan).
- **Saisie manuelle** : bouton sur l'écran de scan pour taper un code-barres ou un SKU (utile sur simulateur ou sans caméra).
- Le code est recherché par code-barres ou SKU. Code inconnu → « Créer l'article » ouvre le formulaire `article/new` prérempli ; au retour, l'article créé est retrouvé et le mouvement Entrée / Sortie peut être saisi.
- Pendant un comptage cyclique, « Scanner » ouvre `/scan?countId=…` : le code lu renvoie directement sur l'article correspondant du comptage. La progression du comptage est enregistrée ; à la fin, les écarts peuvent être appliqués au stock ou ignorés.

## Stack

- **Expo SDK 58**, React Native 0.88, React 19, nouvelle architecture activée
- **expo-router** (routes basées sur les fichiers, routes typées)
- **expo-camera** pour le scan, **expo-location** pour la géolocalisation
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
  article/[id].tsx     Détail d'un article
  count/[id].tsx       Comptage cyclique (progression enregistrée)
components/ui.tsx      Composants partagés (Btn, Stepper, Segmented…)
constants/theme.ts     Couleurs et thème
data/mock.ts           Données d'exemple (chargées au premier lancement)
data/storage.ts        Accès MMKV (repli en mémoire si indisponible)
data/store.ts          État de l'app persisté (articles, mouvements, comptages, préférences)
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

- Export / sauvegarde des données (aucune synchronisation serveur pour l'instant).
- Remplacer les icônes provisoires de `assets/images/` par les visuels définitifs.
- Le code-barres affiché sur la fiche détail est décoratif ; utilisez `react-native-svg` avec une bibliothèque de codes-barres pour un vrai rendu.
- Sentry : `@sentry/react-native` et son plugin sont installés, mais le SDK n'est pas encore initialisé. Ajoutez `Sentry.init({ dsn: '…' })` dans `app/_layout.tsx`, un `metro.config.js` basé sur `getSentryExpoConfig`, et le secret `SENTRY_AUTH_TOKEN` dans EAS pour l'envoi des source maps.
