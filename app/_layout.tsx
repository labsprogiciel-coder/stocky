import { useEffect, useRef } from 'react';
import { Stack, router, useRootNavigationState } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { colors } from '../constants/theme';
// Enregistre la suppression des fichiers photo auprès du store (voir data/photos.ts).
import { sweepOrphanPhotos } from '../data/photos';
// Enregistre la vérification de la licence Stockly Pro auprès du store (limites de la version gratuite).
import { getLicenseStatus } from '../data/license';
// Espace organisation (Storo) : stockage `stockly-org`, jeton sécurisé, garde du stock local, synchronisation.
import { startStoro } from '../data/storo/native';
import { getWorkspace } from '../data/storo/session';

export default function RootLayout() {
  const navState = useRootNavigationState();
  const reopened = useRef(false);

  // Synchronisation Storo : NetInfo, retour au premier plan, minuteries, premier cycle.
  useEffect(() => startStoro(), []);

  // Au lancement, l'application rouvre l'espace organisation s'il était le dernier choisi.
  useEffect(() => {
    if (reopened.current || !navState?.key) return;
    reopened.current = true;
    if (getWorkspace() === 'org') router.replace('/storo');
  }, [navState?.key]);

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
        <Stack.Screen name="storo" options={{ headerShown: false }} />
      </Stack>
    </>
  );
}
