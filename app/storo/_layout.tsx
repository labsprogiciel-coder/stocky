import { Stack } from 'expo-router';
import { colors } from '../../constants/theme';

/** Espace organisation (Storo) : pile d'écrans propre, en-têtes comme le reste de l'application. */
export default function StoroLayout() {
  return (
    <Stack screenOptions={{ headerTintColor: colors.primary, headerStyle: { backgroundColor: colors.bg }, headerShadowVisible: false, headerBackTitle: 'Retour' }}>
      <Stack.Screen name="index" options={{ headerShown: false }} />
      <Stack.Screen name="connect" options={{ title: 'Connexion à Storo' }} />
      <Stack.Screen name="otp" options={{ title: 'Code d\'association' }} />
      <Stack.Screen name="items" options={{ title: 'Articles du site' }} />
      <Stack.Screen name="take/[id]" options={{ headerShown: false }} />
      <Stack.Screen name="move" options={{ title: 'Entrée / Sortie' }} />
      <Stack.Screen name="outbox" options={{ title: 'Opérations à envoyer' }} />
      <Stack.Screen name="migrate" options={{ title: 'Migrer vers Storo' }} />
      <Stack.Screen name="settings" options={{ title: 'Storo' }} />
    </Stack>
  );
}
