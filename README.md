# Stockly mobile (Expo)

Application de terrain : accueil orienté tâches, articles, détail, scanner, tâches et comptage cyclique.
Les données sont des **données d'exemple** dans `data/mock.ts` ; remplacez-les par votre API.

```bash
npm install
npx expo install --fix   # aligne les versions sur votre SDK Expo
npx expo start
```

Structure : `app/` (routes expo-router), `components/ui.tsx` (composants partagés), `constants/theme.ts` (couleurs).
À brancher : API articles/tâches, envoi des quantités comptées (export vers votre système), mode hors ligne et file de synchronisation.
Le code-barres affiché sur le détail est décoratif ; utilisez react-native-svg + une bibliothèque de codes-barres pour un rendu réel.
