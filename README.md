# Stockly mobile (Expo)

Application de terrain pour la gestion de stock : accueil orienté tâches, liste des articles, fiche détail, scanner de codes-barres (entrées / sorties), tâches et comptage cyclique.

> Les données sont des **données d'exemple** (`data/mock.ts`), gardées en mémoire par `data/store.ts`. Remplacez-les par votre API.

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
  scan.tsx             Scanner plein écran (mouvement Entrée / Sortie)
  article/[id].tsx     Détail d'un article
  count/[id].tsx       Comptage cyclique
components/ui.tsx      Composants partagés (Btn, Stepper, Segmented…)
constants/theme.ts     Couleurs et thème
data/mock.ts           Données d'exemple
data/store.ts          État en mémoire (articles, mouvements, ajustements)
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

- Brancher l'API articles / tâches et l'envoi des quantités comptées.
- Mode hors ligne et file de synchronisation.
- Remplacer les icônes provisoires de `assets/images/` par les visuels définitifs.
- Le code-barres affiché sur la fiche détail est décoratif ; utilisez `react-native-svg` avec une bibliothèque de codes-barres pour un vrai rendu.
- Sentry : `@sentry/react-native` et son plugin sont installés, mais le SDK n'est pas encore initialisé. Ajoutez `Sentry.init({ dsn: '…' })` dans `app/_layout.tsx`, un `metro.config.js` basé sur `getSentryExpoConfig`, et le secret `SENTRY_AUTH_TOKEN` dans EAS pour l'envoi des source maps.
