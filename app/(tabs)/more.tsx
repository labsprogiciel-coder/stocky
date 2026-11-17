import { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, Switch, Alert, ScrollView, StyleSheet, TextInput, Share, type ScrollViewInstance } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { useFocusEffect, useLocalSearchParams, router } from 'expo-router';
import { colors } from '../../constants/theme';
import { FREE_LIMITS, applyRestore, fmtCount, fmtTime, getPlanUsage, getPrefs, isProActive, setPrefs, getStorageInfo, loadSampleData, resetAllData } from '../../data/store';
import { exportArticlesExcel, exportAssetsCsv, exportDevicesExcel } from '../../data/exportCount';
import type { BackupPreview } from '../../data/backup';
import { pickBackup, shareBackup } from '../../data/backupFile';
import {
  PRO_PRICE_TEXT,
  activateLicense,
  frDate,
  getLicenseContact,
  getLicenseStatus,
  getPhoneCode,
  removeLicense,
} from '../../data/license';
import { alertProFeature } from '../../components/ProNotice';

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

function ExportButton({ label, a11y, hint, busy, disabled, onPress }: {
  label: string; a11y: string; hint: string; busy: boolean; disabled: boolean; onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={a11y}
      accessibilityHint={hint}
      accessibilityState={{ disabled, busy }}
      disabled={disabled}
      onPress={onPress}
      style={[styles.sampleBtn, disabled && { opacity: 0.4 }]}
    >
      <Feather name="share" size={18} color={colors.primary} />
      <Text style={styles.sampleBtnText}>{busy ? 'Export en cours…' : label}</Text>
    </Pressable>
  );
}

// ── Stockly Pro ────────────────────────────────────────────────────────────

function ProSection({ onChange, refreshKey }: { onChange: () => void; refreshKey: number }) {
  const [status, setStatus] = useState(() => getLicenseStatus());
  const [usage, setUsage] = useState(() => getPlanUsage());
  const [phoneCode] = useState(() => getPhoneCode());
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const contact = getLicenseContact();

  const refresh = useCallback(() => {
    setStatus(getLicenseStatus());
    setUsage(getPlanUsage());
  }, []);

  useFocusEffect(refresh);
  // Données remplacées (restauration) : utilisation x/50 · y/100 à jour.
  useEffect(() => { refresh(); }, [refreshKey, refresh]);

  const handleCopy = async () => {
    try {
      await Clipboard.setStringAsync(phoneCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      Alert.alert('Copie impossible', `Notez le code du téléphone : ${phoneCode}`);
    }
  };

  const handleShare = () => {
    Share.share({
      message: `Demande de licence Stockly Pro\nSociété : \nCode du téléphone : ${phoneCode}`,
      title: 'Code du téléphone Stockly',
    }).catch(() => {});
  };

  const handlePaste = async () => {
    try {
      const text = await Clipboard.getStringAsync();
      if (text) { setCode(text.trim()); setError(null); }
    } catch {
      // Presse-papiers indisponible : saisie manuelle.
    }
  };

  const handleActivate = () => {
    const res = activateLicense(code);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setError(null);
    setCode('');
    refresh();
    onChange();
    Alert.alert(
      'Stockly Pro activé',
      `${res.status.license.company} · valable jusqu'au ${res.status.expiresLabel} inclus.${res.warning ? `\n\n${res.warning}` : ''}`
    );
  };

  const handleRemove = () => {
    Alert.alert(
      'Retirer la licence',
      'Ce téléphone repassera en version gratuite (les données sont conservées). Le même code d\'activation pourra être collé à nouveau.',
      [
        { text: 'Annuler', style: 'cancel' },
        { text: 'Retirer', style: 'destructive', onPress: () => {
          const res = removeLicense();
          refresh();
          onChange();
          if (!res.ok) Alert.alert('Licence non retirée', res.error);
        } },
      ]
    );
  };

  return (
    <View style={[styles.card, { gap: 12 }]}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Feather name="star" size={18} color={status.pro ? colors.primary : colors.muted} />
        <Text accessibilityRole="header" style={{ flex: 1, fontSize: 16, fontWeight: '700', color: colors.text }}>
          {status.pro ? `Pro jusqu'au ${status.expiresLabel}` : 'Gratuit'}
        </Text>
      </View>
      {status.pro && (
        <Text style={{ fontSize: 14, color: colors.text }}>{status.license.company}</Text>
      )}
      {!status.pro && status.problem && (
        <Text style={styles.warnBox}>{status.problem}</Text>
      )}

      {usage.maxItems !== null && usage.maxUnits !== null ? (
        <Text style={{ fontSize: 13, color: colors.muted }}>
          {usage.items}/{usage.maxItems} articles · {usage.units}/{usage.maxUnits} appareils
        </Text>
      ) : (
        <Text style={{ fontSize: 13, color: colors.muted }}>
          Articles et appareils illimités · import et export Excel · export Jira Assets
        </Text>
      )}

      {!status.pro && (
        <View style={{ gap: 4 }}>
          <Text style={{ fontSize: 14, fontWeight: '600', color: colors.text }}>Stockly Pro : {PRO_PRICE_TEXT}</Text>
          <Text style={{ fontSize: 13, color: colors.muted }}>
            Articles et appareils illimités, import Excel, export Excel des appareils et export Jira Assets.
            Chaque téléphone garde son propre inventaire. La sauvegarde reste gratuite.
          </Text>
        </View>
      )}

      <View style={{ gap: 6 }}>
        <Text style={{ fontSize: 13, color: colors.muted }}>Code de ce téléphone (à envoyer au fournisseur)</Text>
        <Text
          selectable
          accessibilityLabel={`Code du téléphone : ${phoneCode.split('').join(' ')}`}
          style={styles.phoneCode}
        >
          {phoneCode}
        </Text>
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <Pressable accessibilityRole="button" onPress={() => { void handleCopy(); }} style={[styles.sampleBtn, { flex: 1 }]}>
            <Feather name={copied ? 'check' : 'copy'} size={18} color={colors.primary} />
            <Text style={styles.sampleBtnText}>{copied ? 'Copié' : 'Copier'}</Text>
          </Pressable>
          <Pressable accessibilityRole="button" onPress={handleShare} style={[styles.sampleBtn, { flex: 1 }]}>
            <Feather name="share-2" size={18} color={colors.primary} />
            <Text style={styles.sampleBtnText}>Partager</Text>
          </Pressable>
        </View>
      </View>

      <Text style={{ fontSize: 13, color: colors.text }}>
        {contact ?? 'Pour obtenir un code d\'activation, contactez votre fournisseur Stockly en lui indiquant le nom de votre société et le code de ce téléphone.'}
      </Text>

      <View style={{ gap: 8 }}>
        <Text style={{ fontSize: 13, color: colors.muted }}>
          {status.pro ? 'Renouvellement : collez le nouveau code d\'activation' : 'Code d\'activation reçu'}
        </Text>
        <TextInput
          value={code}
          onChangeText={(t) => { setCode(t); setError(null); }}
          placeholder="STK1.…"
          placeholderTextColor={colors.muted}
          accessibilityLabel="Code d'activation Stockly Pro"
          autoCapitalize="none"
          autoCorrect={false}
          multiline
          style={styles.codeInput}
        />
        {error && <Text accessibilityLiveRegion="polite" style={styles.errorText}>{error}</Text>}
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <Pressable accessibilityRole="button" onPress={() => { void handlePaste(); }} style={[styles.sampleBtn, { flex: 1 }]}>
            <Feather name="clipboard" size={18} color={colors.primary} />
            <Text style={styles.sampleBtnText}>Coller</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: code.trim().length === 0 }}
            disabled={code.trim().length === 0}
            onPress={handleActivate}
            style={[styles.primaryBtn, { flex: 1 }, code.trim().length === 0 && { opacity: 0.4 }]}
          >
            <Text style={styles.primaryBtnText}>Activer</Text>
          </Pressable>
        </View>
      </View>

      {status.pro && (
        <Pressable accessibilityRole="button" onPress={handleRemove} style={{ minHeight: 40, justifyContent: 'center' }}>
          <Text style={{ fontSize: 13, color: colors.muted, textDecorationLine: 'underline', textAlign: 'center' }}>
            Retirer la licence de ce téléphone
          </Text>
        </Pressable>
      )}
      {!status.pro && status.license && (
        <Text style={{ fontSize: 12, color: colors.muted }}>
          Dernière licence : {status.license.company} · jusqu'au {frDate(status.license.expires)}
        </Text>
      )}
    </View>
  );
}

// ── Données : sauvegarde / restauration (gratuit) ─────────────────────────

const frDateTime = (ts: number) => {
  const d = new Date(ts);
  return `${d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' })} à ${fmtTime(ts)}`;
};

function DataSection({ onChange }: { onChange: () => void }) {
  const [busy, setBusy] = useState<null | 'backup' | 'pick' | 'restore'>(null);
  const [preview, setPreview] = useState<BackupPreview | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleBackup = async () => {
    if (busy) return;
    setBusy('backup');
    setError(null);
    try {
      const r = await shareBackup();
      if (!r.ok) Alert.alert('Sauvegarde impossible', r.error);
    } finally {
      setBusy(null);
    }
  };

  const handlePick = async () => {
    if (busy) return;
    setBusy('pick');
    setError(null);
    setPreview(null);
    try {
      const r = await pickBackup();
      if (r.ok) setPreview(r.preview);
      else if (!('cancelled' in r)) setError(r.error);
    } finally {
      setBusy(null);
    }
  };

  const doRestore = (p: BackupPreview) => {
    setBusy('restore');
    // Laisser le rendu afficher l'indicateur avant l'enregistrement (synchrone).
    setTimeout(() => {
      const r = applyRestore(p.plan);
      setBusy(null);
      onChange();
      if (!r.ok) {
        Alert.alert('Restauration impossible', r.error);
        return;
      }
      setPreview(null);
      Alert.alert(
        'Données restaurées',
        `${fmtCount(p.plan.counts.items, 'article', 'articles')} · ${fmtCount(p.plan.counts.units, 'appareil', 'appareils')} · ${fmtCount(p.plan.counts.movements, 'mouvement', 'mouvements')}.`
      );
    }, 30);
  };

  const confirmRestore = () => {
    if (!preview || busy) return;
    const p = preview;
    Alert.alert(
      'Remplacer toutes les données ?',
      'Tous les articles, appareils, mouvements, comptages et préférences de ce téléphone seront remplacés par ceux de la sauvegarde. Les photos des articles remplacés seront supprimées. Cette action est irréversible.',
      [
        { text: 'Annuler', style: 'cancel' },
        { text: 'Remplacer', style: 'destructive', onPress: () => doRestore(p) },
      ]
    );
  };

  const plan = preview?.plan;
  return (
    <View style={[styles.card, { gap: 12 }]}>
      <Text style={{ fontSize: 13, color: colors.muted }}>
        Sauvegardez l'inventaire de ce téléphone dans un fichier à garder hors du téléphone (Drive, e-mail, WhatsApp…).
        Il permet de le retrouver sur un nouveau téléphone, ou de copier l'inventaire sur le second téléphone de la
        société. Gratuit. Les photos des articles ne sont pas incluses ; la licence Stockly Pro non plus (elle est
        propre à chaque téléphone).
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Sauvegarder les données"
        accessibilityHint="Crée un fichier de sauvegarde et ouvre le partage"
        accessibilityState={{ disabled: busy !== null, busy: busy === 'backup' }}
        disabled={busy !== null}
        onPress={() => { void handleBackup(); }}
        style={[styles.sampleBtn, busy !== null && { opacity: 0.4 }]}
      >
        <Feather name="save" size={18} color={colors.primary} />
        <Text style={styles.sampleBtnText}>{busy === 'backup' ? 'Sauvegarde en cours…' : 'Sauvegarder les données'}</Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Restaurer une sauvegarde"
        accessibilityHint="Choisit un fichier de sauvegarde et affiche son contenu avant toute modification"
        accessibilityState={{ disabled: busy !== null, busy: busy === 'pick' }}
        disabled={busy !== null}
        onPress={() => { void handlePick(); }}
        style={[styles.sampleBtn, busy !== null && { opacity: 0.4 }]}
      >
        <Feather name="rotate-ccw" size={18} color={colors.primary} />
        <Text style={styles.sampleBtnText}>{busy === 'pick' ? 'Lecture du fichier…' : 'Restaurer une sauvegarde'}</Text>
      </Pressable>
      {error && <Text accessibilityLiveRegion="polite" style={styles.errorText}>{error}</Text>}

      {preview && plan && (
        <View accessibilityLiveRegion="polite" style={{ gap: 8, borderTopWidth: 1, borderTopColor: colors.field, paddingTop: 12 }}>
          <Text accessibilityRole="header" style={{ fontSize: 15, fontWeight: '700', color: colors.text }}>
            Sauvegarde du {frDateTime(preview.createdAt)}
          </Text>
          <Text style={{ fontSize: 14, color: colors.text }}>
            {fmtCount(plan.counts.items, 'article', 'articles')} · {fmtCount(plan.counts.units, 'appareil', 'appareils')} ·{' '}
            {fmtCount(plan.counts.movements, 'mouvement', 'mouvements')}
            {plan.counts.sessions > 0 ? ` · ${fmtCount(plan.counts.sessions, 'comptage', 'comptages')}` : ''}
          </Text>
          {preview.appVersion && (
            <Text style={{ fontSize: 12, color: colors.muted }}>Créée avec Stockly {preview.appVersion}</Text>
          )}
          {plan.warnings.map((w) => (
            <Text key={w} style={{ fontSize: 13, color: colors.warnText }}>• {w}</Text>
          ))}
          {plan.photosMissing > 0 && (
            <Text style={{ fontSize: 13, color: colors.muted }}>
              {fmtCount(plan.photosMissing, 'article perdra sa photo', 'articles perdront leur photo')} (photos non incluses
              dans la sauvegarde et absentes de ce téléphone).
            </Text>
          )}
          {plan.overFreeLimits && (
            <Text style={styles.warnBox}>
              Version gratuite : la restauration est possible, mais ces données dépassent {FREE_LIMITS.items} articles ou{' '}
              {FREE_LIMITS.units} appareils. Vous pourrez les consulter et les modifier, pas en ajouter de nouveaux sans
              Stockly Pro.
            </Text>
          )}
          <Text style={{ fontSize: 13, color: colors.text }}>
            Toutes les données actuelles de ce téléphone seront remplacées (aucune fusion).
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Remplacer toutes les données de ce téléphone"
            accessibilityState={{ disabled: busy !== null, busy: busy === 'restore' }}
            disabled={busy !== null}
            onPress={confirmRestore}
            style={[styles.resetBtn, busy !== null && { opacity: 0.4 }]}
          >
            <Feather name="alert-triangle" size={18} color="#8A2A1B" />
            <Text style={styles.resetBtnText}>
              {busy === 'restore' ? 'Restauration en cours…' : 'Remplacer toutes les données de ce téléphone'}
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            disabled={busy !== null}
            onPress={() => setPreview(null)}
            style={{ minHeight: 40, justifyContent: 'center' }}
          >
            <Text style={{ fontSize: 13, color: colors.muted, textDecorationLine: 'underline', textAlign: 'center' }}>Annuler</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

// ── Screen ─────────────────────────────────────────────────────────────────

export default function Profile() {
  const [vibration, setVibration] = useState(() => getPrefs().vibration);
  const [info, setInfo] = useState(() => getStorageInfo());
  const [exporting, setExporting] = useState<null | 'assets' | 'devices' | 'articles'>(null);
  const [pro, setPro] = useState(() => isProActive());
  const [dataVersion, setDataVersion] = useState(0);
  const params = useLocalSearchParams<{ section?: string }>();
  const scrollRef = useRef<ScrollViewInstance>(null);
  const proY = useRef<number | null>(null);

  // Lien « Découvrir Stockly Pro » (`/more?section=pro`) : défiler jusqu'à la section.
  useEffect(() => {
    if (params.section !== 'pro') return;
    const t = setTimeout(() => {
      if (proY.current !== null) scrollRef.current?.scrollTo({ y: Math.max(0, proY.current - 8), animated: true });
      router.setParams({ section: undefined });
    }, 50);
    return () => clearTimeout(t);
  }, [params.section]);

  /** Exports réservés à Stockly Pro : alerte « Découvrir Stockly Pro » en version gratuite. */
  const runExport = async (kind: 'assets' | 'devices' | 'articles') => {
    if (exporting) return;
    if (!isProActive()) {
      alertProFeature(kind === 'assets' ? "L'export des appareils pour Jira Assets" : "L'export Excel");
      return;
    }
    setExporting(kind);
    try {
      if (kind === 'assets') await exportAssetsCsv();
      else if (kind === 'devices') await exportDevicesExcel();
      else await exportArticlesExcel();
    } finally {
      setExporting(null);
    }
  };

  // Rafraîchir les compteurs à chaque retour sur l'onglet
  useFocusEffect(
    useCallback(() => {
      setInfo(getStorageInfo());
      setVibration(getPrefs().vibration);
      setPro(isProActive());
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
      'Tous les articles, appareils (numéros de série), photos, mouvements et comptages enregistrés sur cet appareil seront supprimés, et les préférences remises par défaut. L\'application sera vide. Cette action est irréversible. Pensez à sauvegarder vos données avant (Profil › Données).',
      [
        { text: 'Annuler', style: 'cancel' },
        {
          text: 'Réinitialiser',
          style: 'destructive',
          onPress: () => {
            resetAllData();
            setInfo(getStorageInfo());
            setVibration(getPrefs().vibration);
            setDataVersion((n) => n + 1); // utilisation x/50 · y/100 de Stockly Pro
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
            const error = loadSampleData();
            const next = getStorageInfo();
            setInfo(next);
            setDataVersion((n) => n + 1);
            if (error) {
              Alert.alert('Données d\'exemple non chargées', error);
              return;
            }
            Alert.alert('Données d\'exemple chargées', `${fmtCount(next.itemCount, 'article d\'exemple a été ajouté', 'articles d\'exemple ont été ajoutés')}.`);
          },
        },
      ]
    );
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView ref={scrollRef} contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>

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

        {/* ── STOCKLY PRO ─────────────────────────────────────────────── */}
        <View
          style={{ gap: 14 }}
          onLayout={(e) => {
            proY.current = e.nativeEvent.layout.y;
            if (params.section === 'pro') scrollRef.current?.scrollTo({ y: Math.max(0, e.nativeEvent.layout.y - 8), animated: true });
          }}
        >
          <SectionLabel label="STOCKLY PRO" />
          <ProSection refreshKey={dataVersion} onChange={() => { setPro(isProActive()); setInfo(getStorageInfo()); }} />
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

        {/* ── DONNÉES (sauvegarde / restauration) ────────────────────────── */}
        <SectionLabel label="DONNÉES" />
        <DataSection onChange={() => { setInfo(getStorageInfo()); setVibration(getPrefs().vibration); setPro(isProActive()); setDataVersion((n) => n + 1); }} />

        {/* ── IMPORT / EXPORT ─────────────────────────────────────────── */}
        <SectionLabel label="IMPORT / EXPORT" />
        <View style={[styles.card, { gap: 12 }]}>
          <Text style={{ fontSize: 13, color: colors.muted }}>
            Importez votre inventaire depuis un fichier Excel (.xlsx) ou CSV, ou exportez-le vers Excel (CSV, séparateur
            point-virgule : un fichier pour les appareils, un pour les articles suivis en quantité). Pour copier tout
            l'inventaire sur un autre téléphone, utilisez plutôt la sauvegarde (Données, plus bas).
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Importer depuis Excel"
            accessibilityHint="Ouvre l'import d'un fichier Excel ou CSV"
            onPress={() => router.push('/import')}
            style={styles.sampleBtn}
          >
            <Feather name="upload" size={18} color={colors.primary} />
            <Text style={styles.sampleBtnText}>{`Importer depuis Excel${pro ? '' : ' · Pro'}`}</Text>
          </Pressable>
          {info.unitCount > 0 && (
            <ExportButton
              label={`Exporter les appareils (Excel)${pro ? '' : ' · Pro'}`}
              a11y="Exporter les appareils vers Excel"
              hint="Crée un fichier CSV de tous les appareils pour Excel et ouvre le partage"
              busy={exporting === 'devices'}
              disabled={exporting !== null}
              onPress={() => { void runExport('devices'); }}
            />
          )}
          {info.itemCount > 0 && (
            <ExportButton
              label={`Exporter les articles (Excel)${pro ? '' : ' · Pro'}`}
              a11y="Exporter les articles vers Excel"
              hint="Crée un fichier CSV des articles suivis en quantité pour Excel et ouvre le partage"
              busy={exporting === 'articles'}
              disabled={exporting !== null}
              onPress={() => { void runExport('articles'); }}
            />
          )}
          {info.unitCount > 0 && (
            <>
              <Text style={{ fontSize: 13, color: colors.muted }}>
                {fmtCount(info.unitCount, 'appareil suivi', 'appareils suivis')} par numéro de série. Le fichier Jira Assets
                (UTF-8, virgule) s'importe dans Jira Service Management Assets : un objet par appareil, clé « Serial Number ».
              </Text>
              <ExportButton
                label={`Exporter les appareils (Jira Assets)${pro ? '' : ' · Pro'}`}
                a11y="Exporter les appareils pour Jira Assets"
                hint="Crée un fichier CSV de tous les appareils et ouvre le partage"
                busy={exporting === 'assets'}
                disabled={exporting !== null}
                onPress={() => { void runExport('assets'); }}
              />
            </>
          )}
        </View>

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
  phoneCode: {
    fontSize: 20,
    fontWeight: '700',
    letterSpacing: 1.5,
    color: colors.text,
    fontVariant: ['tabular-nums'],
    textAlign: 'center',
    backgroundColor: colors.tint,
    borderRadius: 10,
    paddingVertical: 12,
    overflow: 'hidden',
  },
  codeInput: {
    minHeight: 72,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: '#fff',
    padding: 12,
    fontSize: 13,
    color: colors.text,
    textAlignVertical: 'top',
  },
  errorText: {
    fontSize: 13,
    color: '#B91C1C',
    fontWeight: '500',
  },
  primaryBtn: {
    minHeight: 48,
    borderRadius: 10,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryBtnText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#fff',
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
