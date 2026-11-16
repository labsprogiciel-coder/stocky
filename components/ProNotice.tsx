/**
 * Invitation à passer à Stockly Pro : encart (limite de la version gratuite
 * atteinte) et alerte (fonction réservée à Pro), avec un lien vers
 * Profil › Stockly Pro.
 */
import { Alert, Pressable, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { router } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import { colors } from '../constants/theme';

/**
 * Ouvre Profil, défilé jusqu'à la section « Stockly Pro ». `dismissTo` revient
 * aux onglets existants en fermant les écrans ouverts au-dessus (scanner,
 * formulaire, import) ; `navigate` empilerait une seconde copie des onglets
 * (le routeur de pile ne réutilise une route existante qu'avec `pop`).
 */
export function openProSection(): void {
  router.dismissTo({ pathname: '/more', params: { section: 'pro' } });
}

/** Alerte d'une fonction réservée à Stockly Pro, avec « Découvrir Stockly Pro ». */
export function alertProFeature(feature: string): void {
  Alert.alert(
    'Stockly Pro',
    `${feature} est réservé à Stockly Pro (150 000 FCFA / an · 1 société · jusqu'à 2 téléphones).`,
    [
      { text: 'Fermer', style: 'cancel' },
      { text: 'Découvrir Stockly Pro', onPress: openProSection },
    ]
  );
}

export function ProNotice({ message, style }: { message: string; style?: StyleProp<ViewStyle> }) {
  return (
    <View
      accessibilityLiveRegion="polite"
      style={[{ backgroundColor: colors.warnBg, borderRadius: 10, padding: 12, gap: 8 }, style]}
    >
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}>
        <Feather name="star" size={16} color={colors.warnText} style={{ marginTop: 1 }} />
        <Text style={{ flex: 1, fontSize: 13, color: colors.warnText, fontWeight: '600' }}>{message}</Text>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityHint="Ouvre la section Stockly Pro du profil"
        onPress={openProSection}
        style={{ minHeight: 32, justifyContent: 'center' }}
      >
        <Text style={{ fontSize: 13, fontWeight: '700', color: colors.primary, textDecorationLine: 'underline' }}>
          Découvrir Stockly Pro
        </Text>
      </Pressable>
    </View>
  );
}
