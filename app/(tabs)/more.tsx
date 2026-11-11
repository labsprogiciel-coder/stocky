import { useState } from 'react';
import { View, Text, Pressable, Switch, Alert, ScrollView, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { colors } from '../../constants/theme';
import { fmtTime } from '../../data/store';

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
  const [vibration, setVibration] = useState(true);
  const [offlineMode, setOfflineMode] = useState(false);
  const [lastSync] = useState(Date.now() - 3 * 60_000); // 3 min ago

  const handleLogout = () => {
    Alert.alert(
      'Se déconnecter',
      'Toutes les modifications non synchronisées seront perdues.',
      [
        { text: 'Annuler', style: 'cancel' },
        { text: 'Se déconnecter', style: 'destructive', onPress: () => {} },
      ]
    );
  };

  const handleSync = () => {
    Alert.alert('Synchronisation', 'Données à jour — aucune modification en attente.');
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

        {/* ── SYNCHRONISATION ─────────────────────────────────────────── */}
        <SectionLabel label="SYNCHRONISATION" />
        <View style={[styles.card, { gap: 12 }]}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <View style={styles.onlineDot} />
            <Text style={{ fontSize: 14, fontWeight: '600', color: colors.text }}>En ligne</Text>
          </View>
          <Text style={{ fontSize: 13, color: colors.muted }}>
            Dernière synchronisation : {fmtTime(lastSync)} · 0 modification en attente
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={handleSync}
            style={styles.syncBtn}
          >
            <Feather name="refresh-cw" size={18} color={colors.primary} />
            <Text style={styles.syncBtnText}>Synchroniser maintenant</Text>
          </Pressable>
        </View>

        {/* ── PRÉFÉRENCES ─────────────────────────────────────────────── */}
        <SectionLabel label="PRÉFÉRENCES" />
        <SettingCard>
          <SettingRow icon="globe" label="Langue" value="Français" first onPress={() => {}} />
          <ToggleRow icon="activity" label="Vibration au scan" value={vibration} onValueChange={setVibration} />
          <ToggleRow icon="refresh-cw" label="Mode hors ligne" value={offlineMode} onValueChange={setOfflineMode} />
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

  // Sync card
  onlineDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.primary,
  },
  syncBtn: {
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
  syncBtnText: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.primary,
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
