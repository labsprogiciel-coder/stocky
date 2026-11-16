import { useCallback, useState } from 'react';
import { View, Text, Pressable, Switch, Alert, ScrollView, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useFocusEffect } from 'expo-router';
import { colors } from '../../constants/theme';
import { fmtCount, fmtTime, getPrefs, setPrefs, getStorageInfo, loadSampleData, resetAllData } from '../../data/store';
import { exportAssetsCsv } from '../../data/exportCount';

// ── Mock user data (replace with real auth context later) ──────────────────
const USER = {
  initials: 'PN',
  name: 'Prénom Nom',
  email: 'adresse@entreprise.com',
  role: 'Opérateur terrain',
  site: 'Entrepôt Central',
};

// ── Reusable sub-components ────────────────────────────────────────────────

function SectionLabel({ label }: { label: string }) {
  return (
    <Text style={styles.sectionLabel}>{label}</Text>
  );
}

function SettingRow({
  icon,
  label,
  value,
  onPress,
  chevron = true,
  first = false,
}: {
  icon: React.ComponentProps<typeof Feather>['name'];
  label: string;
  value?: string;
  onPress?: () => void;
  chevron?: boolean;
  first?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole={onPress ? 'button' : 'none'}
      onPress={onPress}
      style={[styles.row, !first && styles.rowBorder]}
    >
      <Feather name={icon} size={20} color={colors.primary} />
      <Text style={styles.rowLabel}>{label}</Text>
      {value && <Text style={styles.rowValue}>{value}</Text>}
      {chevron && <Feather name="chevron-right" size={18} color={colors.muted} />}
    </Pressable>
  );
}

function ToggleRow({
  icon,
  label,
  value,
  onValueChange,
  first = false,
}: {
  icon: React.ComponentProps<typeof Feather>['name'];
  label: string;
  value: boolean;
  onValueChange: (v: boolean) => void;
  first?: boolean;
}) {
  return (
    <View style={[styles.row, !first && styles.rowBorder]}>
      <Feather name={icon} size={20} color={colors.primary} />
      <Text style={[styles.rowLabel, { flex: 1 }]}>{label}</Text>
      <Switch
        value={value}
        onValueChange={onValueChange}
        trackColor={{ false: colors.field, true: colors.primary }}
        thumbColor="#fff"
        accessibilityLabel={label}
      />
    </View>
  );
}

function SettingCard({ children }: { children: React.ReactNode }) {
  return <View style={styles.card}>{children}</View>;
}

// ── Screen ─────────────────────────────────────────────────────────────────

export default function Profile() {
  const [vibration, setVibration] = useState(() => getPrefs().vibration);
  const [info, setInfo] = useState(() => getStorageInfo());
  const [exporting, setExporting] = useState(false);

  const handleExportAssets = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      await exportAssetsCsv();
    } finally {
      setExporting(false);
    }
  };

  // Rafraîchir les compteurs à chaque retour sur l'onglet
  useFocusEffect(
    useCallback(() => {
      setInfo(getStorageInfo());
      setVibration(getPrefs().vibration);
    }, [])
  );

  const handleVibration = (v: boolean) => {
    setVibration(v);
    setPrefs({ vibration: v });
    setInfo(getStorageInfo());
  };

  const handleLogout = () => {
    Alert.alert(
      'Se déconnecter',
      'Vos données restent enregistrées sur cet appareil.',
      [
        { text: 'Annuler', style: 'cancel' },
        { text: 'Se déconnecter', style: 'destructive', onPress: () => {} },
      ]
    );
  };

  const handleReset = () => {
    Alert.alert(
      'Réinitialiser les données',
      'Tous les articles, appareils (numéros de série), photos, mouvements et comptages enregistrés sur cet appareil seront supprimés, et les préférences remises par défaut. L\'application sera vide. Cette action est irréversible.',
      [
        { text: 'Annuler', style: 'cancel' },
        {
          text: 'Réinitialiser',
          style: 'destructive',
          onPress: () => {
            resetAllData();
            setInfo(getStorageInfo());
            setVibration(getPrefs().vibration);
            Alert.alert('Données réinitialisées', 'L\'application est maintenant vide.');
          },
        },
      ]
    );
  };

  const handleLoadSample = () => {
    Alert.alert(
      'Charger les données d\'exemple',
      'Les articles, appareils (numéros de série), photos, mouvements et comptages actuels seront supprimés et remplacés par des données d\'exemple. Vos préférences sont conservées. Cette action est irréversible.',
      [
        { text: 'Annuler', style: 'cancel' },
        {
          text: 'Remplacer les données',
          style: 'destructive',
          onPress: () => {
            loadSampleData();
            const next = getStorageInfo();
            setInfo(next);
            Alert.alert('Données d\'exemple chargées', `${fmtCount(next.itemCount, 'article d\'exemple a été ajouté', 'articles d\'exemple ont été ajoutés')}.`);
          },
        },
      ]
    );
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>

        {/* Title */}
        <Text style={styles.pageTitle}>Profil</Text>

        {/* ── User card ──────────────────────────────────────────────── */}
        <View style={styles.userCard}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>{USER.initials}</Text>
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={styles.userName}>{USER.name}</Text>
            <Text style={styles.userEmail} numberOfLines={1}>{USER.email}</Text>
            <View style={styles.roleBadge}>
              <Text style={styles.roleBadgeText}>{USER.role}</Text>
            </View>
          </View>
        </View>

        {/* ── COMPTE ─────────────────────────────────────────────────── */}
        <SectionLabel label="COMPTE" />
        <SettingCard>
          <SettingRow icon="user" label="Informations personnelles" first onPress={() => {}} />
          <SettingRow icon="lock" label="Mot de passe et code PIN" onPress={() => {}} />
        </SettingCard>

        {/* ── SITE ET ÉQUIPE ──────────────────────────────────────────── */}
        <SectionLabel label="SITE ET ÉQUIPE" />
        <SettingCard>
          <SettingRow icon="map-pin" label="Site actuel" value={USER.site} first onPress={() => {}} />
        </SettingCard>

        {/* ── STOCKAGE LOCAL ──────────────────────────────────────────── */}
        <SectionLabel label="STOCKAGE LOCAL" />
        <View style={[styles.card, { gap: 12 }]}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            {info.persistent
              ? <View style={styles.statusDot} />
              : <Feather name="alert-triangle" size={16} color={colors.warnText} />}
            <Text style={{ fontSize: 14, fontWeight: '600', color: info.persistent ? colors.text : colors.warnText }}>
              {info.persistent ? 'Hors ligne · enregistré sur l\'appareil' : 'Stockage temporaire'}
            </Text>
          </View>
          {!info.persistent && (
            <Text style={styles.warnBox}>
              Les données seront perdues à la fermeture de l'application. L'enregistrement local
              nécessite un build de développement (Expo Go ne peut pas conserver les données).
            </Text>
          )}
          <Text style={{ fontSize: 13, color: colors.muted }}>
            {fmtCount(info.itemCount, 'article', 'articles')}
            {info.unitCount > 0 ? ` · ${fmtCount(info.unitCount, 'appareil', 'appareils')}` : ''}
            {' · '}{fmtCount(info.movementCount, 'mouvement', 'mouvements')}
            {info.lastSavedAt !== undefined ? ` · Dernier enregistrement : ${fmtTime(info.lastSavedAt)}` : ''}
          </Text>
          {info.itemCount === 0 && (
            <Text style={{ fontSize: 13, color: colors.muted }}>
              Aucune donnée pour l'instant. Chargez les données d'exemple pour découvrir l'application.
            </Text>
          )}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Charger les données d'exemple"
            accessibilityHint="Remplace les données actuelles par des données d'exemple"
            onPress={handleLoadSample}
            style={styles.sampleBtn}
          >
            <Feather name="download" size={18} color={colors.primary} />
            <Text style={styles.sampleBtnText}>Charger les données d'exemple</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Réinitialiser les données"
            accessibilityHint="Supprime toutes les données de l'appareil ; l'application repart vide"
            onPress={handleReset}
            style={styles.resetBtn}
          >
            <Feather name="trash-2" size={18} color="#8A2A1B" />
            <Text style={styles.resetBtnText}>Réinitialiser les données</Text>
          </Pressable>
        </View>

        {/* ── EXPORT ──────────────────────────────────────────────────── */}
        {info.unitCount > 0 && (
          <>
            <SectionLabel label="EXPORT" />
            <View style={[styles.card, { gap: 12 }]}>
              <Text style={{ fontSize: 13, color: colors.muted }}>
                {fmtCount(info.unitCount, 'appareil suivi', 'appareils suivis')} par numéro de série. Le fichier CSV
                (UTF-8, virgule) s'importe dans Jira Service Management Assets : un objet par appareil, clé « Serial Number ».
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Exporter les appareils pour Jira Assets"
                accessibilityHint="Crée un fichier CSV de tous les appareils et ouvre le partage"
                accessibilityState={{ disabled: exporting, busy: exporting }}
                disabled={exporting}
                onPress={() => { void handleExportAssets(); }}
                style={[styles.sampleBtn, exporting && { opacity: 0.4 }]}
              >
                <Feather name="share" size={18} color={colors.primary} />
                <Text style={styles.sampleBtnText}>{exporting ? 'Export en cours…' : 'Exporter les appareils (Jira Assets)'}</Text>
              </Pressable>
            </View>
          </>
        )}

        {/* ── PRÉFÉRENCES ─────────────────────────────────────────────── */}
        <SectionLabel label="PRÉFÉRENCES" />
        <SettingCard>
          <SettingRow icon="globe" label="Langue" value="Français" first onPress={() => {}} />
          <ToggleRow icon="activity" label="Vibration au scan" value={vibration} onValueChange={handleVibration} />
        </SettingCard>

        {/* ── AIDE ────────────────────────────────────────────────────── */}
        <SectionLabel label="AIDE" />
        <SettingCard>
          <SettingRow icon="help-circle" label="Aide et support" first onPress={() => {}} />
        </SettingCard>

        {/* ── Logout ──────────────────────────────────────────────────── */}
        <Pressable
          accessibilityRole="button"
          onPress={handleLogout}
          style={styles.logoutBtn}
        >
          <Feather name="log-out" size={18} color="#8A2A1B" />
          <Text style={styles.logoutBtnText}>Se déconnecter</Text>
        </Pressable>

        {/* ── Version ─────────────────────────────────────────────────── */}
        <Text style={styles.version}>Stockly · version 1.0.0</Text>

      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  scroll: {
    paddingHorizontal: 12,
    paddingTop: 16,
    paddingBottom: 40,
    gap: 14,
  },
  pageTitle: {
    fontSize: 24,
    fontWeight: '700',
    color: colors.text,
    minHeight: 48,
    textAlignVertical: 'center',
  },

  // User card
  userCard: {
    backgroundColor: colors.card,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 20,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
  },
  avatar: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: colors.tint,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  avatarText: {
    fontSize: 22,
    fontWeight: '700',
    color: colors.primary,
  },
  userName: {
    fontSize: 18,
    fontWeight: '600',
    color: colors.text,
  },
  userEmail: {
    fontSize: 13,
    color: colors.muted,
    marginTop: 2,
  },
  roleBadge: {
    alignSelf: 'flex-start',
    marginTop: 8,
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 999,
    backgroundColor: colors.tint,
  },
  roleBadgeText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.primary,
  },

  // Section label
  sectionLabel: {
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.08 * 12,
    color: colors.muted,
    marginTop: 4,
  },

  // Setting card
  card: {
    backgroundColor: colors.card,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
    padding: 16,
  },

  // Setting row
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    minHeight: 56,
    marginHorizontal: -16,
    paddingVertical: 6,
  },
  rowBorder: {
    borderTopWidth: 1,
    borderTopColor: colors.line,
  },
  rowLabel: {
    flex: 1,
    fontSize: 15,
    color: colors.text,
  },
  rowValue: {
    fontSize: 14,
    color: colors.muted,
  },

  // Local storage card
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.primary,
  },
  warnBox: {
    fontSize: 13,
    color: colors.warnText,
    backgroundColor: colors.warnBg,
    borderRadius: 10,
    padding: 12,
    overflow: 'hidden',
  },
  sampleBtn: {
    minHeight: 48,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.primary,
    backgroundColor: '#fff',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  sampleBtnText: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.primary,
  },
  resetBtn: {
    minHeight: 48,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#8A2A1B',
    backgroundColor: '#fff',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  resetBtnText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#8A2A1B',
  },

  // Logout
  logoutBtn: {
    minHeight: 48,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#8A2A1B',
    backgroundColor: '#fff',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  logoutBtnText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#8A2A1B',
  },

  // Version
  version: {
    textAlign: 'center',
    fontSize: 12,
    color: colors.muted,
  },
});
