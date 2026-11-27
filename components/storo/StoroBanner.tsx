/**
 * Bandeaux de l'espace organisation (contrat §10.2) : lecture seule,
 * téléphone non attribué, opérations refusées ou en attente hors ligne,
 * accès refusé, migration en attente. `standalone` : écrans « Mon stock »
 * (seulement la migration en attente et le stock archivé).
 */
import { Pressable, Text, View } from 'react-native';
import { router } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import { colors } from '../../constants/theme';
import { fmtCount } from '../../data/store';
import { GUARD_ARCHIVED, isMigrationPending, isMigrationSuspended } from '../../data/storo/migration';
import { runSync } from '../../data/storo/sync';
import { useLocalMigration, useOrgData, useOutboxSummary, useStoroSession } from '../../data/storo/useStoro';

type Tone = 'error' | 'warning' | 'info';

const TONES: Record<Tone, { bg: string; fg: string; icon: React.ComponentProps<typeof Feather>['name'] }> = {
  error: { bg: '#FEE2E2', fg: '#B91C1C', icon: 'alert-circle' },
  warning: { bg: colors.warnBg, fg: colors.warnText, icon: 'alert-triangle' },
  info: { bg: colors.tint, fg: colors.primary, icon: 'info' },
};

const STATUS_LABELS: Record<string, string> = { maintenance: 'en maintenance', lost: 'déclaré perdu', decommissioned: 'retiré' };

export function BannerView({ tone, text, action }: { tone: Tone; text: string; action?: { label: string; onPress: () => void } }) {
  const t = TONES[tone];
  return (
    <View accessibilityLiveRegion="polite" style={{ flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: t.bg, borderRadius: 12, padding: 12 }}>
      <Feather name={t.icon} size={18} color={t.fg} />
      <Text style={{ flex: 1, fontSize: 13, fontWeight: '600', color: t.fg, lineHeight: 18 }}>{text}</Text>
      {action && (
        <Pressable accessibilityRole="button" onPress={action.onPress} style={{ minHeight: 40, paddingHorizontal: 12, borderRadius: 8, borderWidth: 1, borderColor: t.fg, justifyContent: 'center' }}>
          <Text style={{ fontSize: 13, fontWeight: '700', color: t.fg }}>{action.label}</Text>
        </Pressable>
      )}
    </View>
  );
}

export function StoroBanner({ standalone = false }: { standalone?: boolean }) {
  const { session, me, state } = useStoroSession();
  const { sync, online } = useOrgData();
  const box = useOutboxSummary();
  const { migration, archive } = useLocalMigration();
  const org = session?.orgName || 'l’organisation';
  const banners: { key: string; tone: Tone; text: string; action?: { label: string; onPress: () => void } }[] = [];

  if (isMigrationPending(migration)) {
    const suspended = isMigrationSuspended(migration);
    banners.push({
      key: 'mig',
      tone: suspended ? 'warning' : 'info',
      text: suspended ? 'Transfert vers Storo suspendu (connexion en lecture seule) : votre stock local reste modifiable.' : 'Transfert vers Storo en attente de validation par un responsable.',
      action: { label: 'Voir', onPress: () => router.push('/storo/migrate') },
    });
  } else if (standalone && archive) {
    banners.push({ key: 'archive', tone: 'info', text: GUARD_ARCHIVED });
  }

  if (!standalone && session) {
    const probe = { label: 'Vérifier', onPress: () => { void runSync('manual'); } };
    if (state === 'readonly') {
      const reason = session.readonlyReason;
      if (reason === 'unpaired') {
        banners.unshift({ key: 'ro', tone: 'error', text: `Ce téléphone n'est plus associé à ${org}. Les données affichées sont en lecture seule.`, action: { label: 'Associer à nouveau', onPress: () => router.push('/storo/connect') } });
      } else if (reason === 'device_inactive') {
        const st = typeof session.readonlyDetails?.status === 'string' ? STATUS_LABELS[session.readonlyDetails.status] ?? session.readonlyDetails.status : 'désactivé';
        banners.unshift({ key: 'ro', tone: 'warning', text: `Ce téléphone est désactivé dans Storo (${st}). Lecture seule.`, action: probe });
      } else if (reason === 'org_suspended') {
        banners.unshift({ key: 'ro', tone: 'error', text: `L'organisation ${org} est suspendue. Lecture seule.` });
      } else {
        banners.unshift({ key: 'ro', tone: 'warning', text: `L'abonnement de ${org} n'inclut plus l'application mobile. Lecture seule.`, action: probe });
      }
    } else if (me && !me.attributedMemberId) {
      banners.push({ key: 'member', tone: 'warning', text: "Ce téléphone n'est attribué à aucun membre : les comptages ne pourront pas être envoyés. Demandez à un responsable de l'attribuer dans Storo (Paramètres › Appareils)." });
    }
    if (box.parked > 0) {
      banners.push({ key: 'parked', tone: 'error', text: `${fmtCount(box.parked, 'opération refusée', 'opérations refusées')} par Storo.`, action: { label: 'Voir', onPress: () => router.push('/storo/outbox') } });
    }
    if (online === false && box.pending > 0) {
      banners.push({ key: 'offline', tone: 'info', text: `Hors ligne · ${fmtCount(box.pending, 'opération', 'opérations')} en attente d'envoi.` });
    }
    if (sync.deniedPermission) {
      banners.push({ key: 'perm', tone: 'warning', text: `Accès refusé par l'organisation (${sync.deniedPermission}).` });
    }
  }

  if (banners.length === 0) return null;
  return (
    <View style={{ gap: 8 }}>
      {banners.map((b) => <BannerView key={b.key} tone={b.tone} text={b.text} action={b.action} />)}
    </View>
  );
}
