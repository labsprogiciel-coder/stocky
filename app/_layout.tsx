import { useEffect } from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { colors } from '../constants/theme';
// Enregistre la suppression des fichiers photo auprès du store (voir data/photos.ts).
import { sweepOrphanPhotos } from '../data/photos';

export default function RootLayout() {
  // Supprime au démarrage les photos qu'aucun article ne référence.
  useEffect(() => {
    sweepOrphanPhotos();
  }, []);

  return (
    <>
      <StatusBar style="dark" />
      <Stack screenOptions={{ headerTintColor: colors.primary, headerStyle: { backgroundColor: colors.bg }, headerShadowVisible: false }}>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="scan" options={{ headerShown: false, presentation: 'fullScreenModal' }} />
        <Stack.Screen name="article/new" options={{ title: 'Nouvel article', headerBackTitle: 'Retour' }} />
        <Stack.Screen name="article/[id]" options={{ title: 'Détail', headerBackTitle: 'Retour' }} />
        <Stack.Screen name="article/edit/[id]" options={{ title: "Modifier l'article", headerBackTitle: 'Retour' }} />
        <Stack.Screen name="count/[id]" options={{ headerShown: false }} />
        <Stack.Screen name="unit/new" options={{ title: 'Nouvel appareil', headerBackTitle: 'Retour' }} />
        <Stack.Screen name="unit/[id]" options={{ title: 'Appareil', headerBackTitle: 'Retour' }} />
      </Stack>
    </>
  );
}
