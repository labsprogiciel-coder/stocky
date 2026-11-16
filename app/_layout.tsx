import { useEffect } from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { colors } from '../constants/theme';
// Enregistre la suppression des fichiers photo auprès du store (voir data/photos.ts).
import { sweepOrphanPhotos } from '../data/photos';
// Enregistre la vérification de la licence Stockly Pro auprès du store (limites de la version gratuite).
import { getLicenseStatus } from '../data/license';

export default function RootLayout() {
  // Supprime au démarrage les photos qu'aucun article ne référence.
  useEffect(() => {
    sweepOrphanPhotos();
    // Vérifie la licence (signature Ed25519, quelques dizaines à centaines de
    // ms sur un téléphone modeste) une fois le premier écran affiché, plutôt
    // qu'au premier formulaire ou scan ouvert. Résultat mis en cache pour la journée.
    const timer = setTimeout(() => {
      getLicenseStatus();
    }, 400);
    return () => clearTimeout(timer);
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
        <Stack.Screen name="import" options={{ title: 'Importer depuis Excel', headerBackTitle: 'Retour' }} />
      </Stack>
    </>
  );
}
