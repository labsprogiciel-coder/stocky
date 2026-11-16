/**
 * Scanner plein écran (caméra + saisie manuelle).
 *
 * Résolution d'un code : numéro de série / IMEI d'un appareil → code-barres /
 * SKU d'un article → code inconnu.
 * - Appareil : fiche rapide (article, n° de série, IMEI, statut, attributaire)
 *   et actions selon le statut (Attribuer, Envoyer en réparation, Retirer,
 *   Remettre en stock).
 * - Article suivi par numéro de série : Entrée = « Ajouter des appareils »
 *   (boucle : chaque code lu est ajouté comme numéro de série, le scanner reste
 *   prêt pour le suivant) ; la Sortie se fait en scannant l'appareil lui-même.
 * - Article suivi en quantité : panneau Entrée / Sortie inchangé.
 * - Code inconnu : « Créer l'article » ou « Ajouter comme appareil ».
 *
 * Paramètres :
 * - `?countId=…` : comptage. Le code est transmis à l'écran de comptage
 *   (`setPendingCountScan`), qui marque l'appareil trouvé ou va sur l'article.
 *   Avec `&multi=1` (« Scanner les appareils ») : le scanner reste ouvert et
 *   chaque numéro de série lu est marqué trouvé (`markUnitFound`).
 * - `?pick=serial|imei` : sélection pour un formulaire d'appareil ; le code lu
 *   est transmis au retour (`setPendingPick`).
 * - `?addItemId=…` : ouvre directement la boucle « Ajouter des appareils ».
 */
import { useState, useRef, useCallback, useEffect } from 'react';
import { View, Text, Pressable, StyleSheet, Alert, TextInput, Vibration, KeyboardAvoidingView, Platform, Linking, ScrollView } from 'react-native';
import { router, useFocusEffect, useIsFocused, useLocalSearchParams } from 'expo-router';
import { CameraView, useCameraPermissions, type BarcodeType } from 'expo-camera';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Btn, Icon, Segmented, Stepper, SerialBadge, UnitStatusChip, Alert as InlineAlert } from '../components/ui';
import { colors } from '../constants/theme';
import {
  UNIT_STATUS_LABELS,
  addUnit,
  commitMovement,
  findItemByCode,
  findUnitByCode,
  fmtCount,
  getCountItems,
  getItem,
  getItems,
  getPrefs,
  imeiDigits,
  isValidImei,
  markUnitFound,
  setCountIndex,
  setPendingCountScan,
  setPendingPick,
  updateUnit,
  type Item,
  type PickTarget,
  type Unit,
  type UnitStatus,
} from '../data/store';

const BARCODE_TYPES: BarcodeType[] = ['ean13', 'ean8', 'upc_a', 'upc_e', 'code128', 'code39', 'qr'];

/** Délai avant d'accepter une nouvelle lecture dans les modes « à la suite ». */
const LOOP_UNLOCK_MS = 700;
/**
 * Hors boucle, au retour au scanner : le code qui vient d'être traité est
 * ignoré tant qu'il reste dans le champ de la caméra (lu à moins de ce délai
 * de la lecture précédente).
 */
const SUPPRESS_GAP_MS = 1200;

type Match = { kind: 'unit'; unit: Unit; item: Item } | { kind: 'item'; item: Item } | null;

/** Appareil (n° de série / IMEI) d'abord, puis article (code-barres / SKU). */
function resolveCode(code: string): Match {
  const unit = findUnitByCode(code);
  const unitItem = unit ? getItem(unit.itemId) : undefined;
  if (unit && unitItem) return { kind: 'unit', unit, item: unitItem };
  const item = findItemByCode(code);
  return item ? { kind: 'item', item } : null;
}

type Feedback = { kind: 'ok' | 'error' | 'info'; text: string; unitId?: string };

export default function Scan() {
  const params = useLocalSearchParams<{ countId?: string; multi?: string; pick?: string; addItemId?: string }>();
  const countTarget = typeof params.countId === 'string' && params.countId.length > 0 ? params.countId : null;
  const countMode = countTarget !== null;
  const multiCount = countMode && params.multi === '1';
  const pickTarget: PickTarget | null = !countMode && (params.pick === 'serial' || params.pick === 'imei') ? params.pick : null;
  const launchedAddId =
    !countMode && !pickTarget && typeof params.addItemId === 'string' && params.addItemId.length > 0 ? params.addItemId : null;

  const [perm, requestPerm] = useCameraPermissions();
  const [torch, setTorch] = useState(false);
  const [code, setCode] = useState<string | null>(null);
  const [mode, setMode] = useState<'Entrée' | 'Sortie'>('Entrée');
  const [qty, setQty] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualText, setManualText] = useState('');
  // Incrémenté au retour sur l'écran pour relire le store (ex. article créé).
  const [, setRefresh] = useState(0);
  // Boucle « Ajouter des appareils » : article cible.
  const [addTargetId, setAddTargetId] = useState<string | null>(launchedAddId);
  const [addedCount, setAddedCount] = useState(0);
  // Comptage « Scanner les appareils » : appareils trouvés pendant ce scan.
  const [foundCount, setFoundCount] = useState(0);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  // Panneau appareil : saisie de l'attributaire.
  const [assigning, setAssigning] = useState(false);
  const [assignee, setAssignee] = useState('');
  // Code inconnu : choix de l'article pour « Ajouter comme appareil ».
  const [pickArticle, setPickArticle] = useState(false);
  // Verrou synchrone : la caméra peut émettre plusieurs lectures avant le rendu.
  const lockedRef = useRef(false);
  // Verrou synchrone contre le double appui sur Valider (le state est groupé par React).
  const committingRef = useRef(false);
  // Boucles (ajout d'appareils, comptage) : codes déjà lus par la caméra
  // pendant la boucle, ignorés ensuite. La caméra lit tout le champ, pas
  // seulement le cadre : les autres codes d'une étiquette (IMEI 1, IMEI 2…)
  // et le code-barres de la boîte ne sont traités qu'une fois.
  const loopSeenRef = useRef<Set<string>>(new Set());
  // Hors boucle : code qui vient d'être traité, ignoré tant qu'il reste visible.
  const suppressRef = useRef<{ code: string; lastSeen: number } | null>(null);
  // Écran recouvert (fiche appareil, autre scanner…) : caméra démontée, aucune lecture.
  const focused = useIsFocused();
  const unlockTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (unlockTimerRef.current) clearTimeout(unlockTimerRef.current);
  }, []);

  useFocusEffect(
    useCallback(() => {
      setRefresh((n) => n + 1);
    }, [])
  );

  const match = code ? resolveCode(code) : null;
  const unitMatch = match?.kind === 'unit' ? match : null;
  const item = match?.kind === 'item' ? match.item : null;
  const qtyItem = item && !item.serialized ? item : null;
  const serialItem = item?.serialized ? item : null;
  const unknownCode = code !== null && match === null;
  const addTargetRaw = addTargetId ? getItem(addTargetId) : undefined;
  const addTarget = addTargetRaw?.serialized ? addTargetRaw : null;
  const addLoop = addTarget !== null && !countMode && !pickTarget;
  const loop = addLoop || multiCount;

  // ── qty validation ────────────────────────────────────────────────────────
  const qtyError =
    qty <= 0
      ? 'La quantité doit être supérieure à 0.'
      : mode === 'Sortie' && qtyItem && qty > qtyItem.qty
      ? `Stock insuffisant — disponible : ${qtyItem.qty} unité(s).`
      : null;

  const canSubmit = !!qtyItem && !qtyError;

  // ── handlers ──────────────────────────────────────────────────────────────
  const scheduleUnlock = () => {
    if (unlockTimerRef.current) clearTimeout(unlockTimerRef.current);
    unlockTimerRef.current = setTimeout(() => {
      unlockTimerRef.current = null;
      lockedRef.current = false;
    }, LOOP_UNLOCK_MS);
  };

  /** Boucle « Ajouter des appareils » : le code lu devient un numéro de série de `target`. */
  const addSerial = (target: Item, data: string, source: 'camera' | 'manual') => {
    // Un IMEI (15 chiffres, clé de Luhn valide) lu sur l'étiquette n'est pas
    // un numéro de série. La saisie manuelle reste possible.
    if (source === 'camera' && isValidImei(imeiDigits(data)) && !findUnitByCode(data)) {
      setFeedback({
        kind: 'info',
        text: `Code ${data} ignoré : il ressemble à un IMEI. Scannez le numéro de série (S/N) ; l'IMEI s'ajoute depuis « Compléter ».`,
      });
      return;
    }
    const asItem = findItemByCode(data);
    if (asItem) {
      // Le code-barres de l'article lui-même, encore dans le cadre : ignoré.
      if (asItem.id === target.id && source === 'camera') return;
      setFeedback({
        kind: 'error',
        text: asItem.id === target.id
          ? "C'est le code de l'article lui-même : saisissez le numéro de série de l'appareil."
          : `Ce code est celui de l'article « ${asItem.name} », pas un numéro de série.`,
      });
      return;
    }
    const res = addUnit(target.id, { serial: data });
    if (res.error !== undefined) {
      setFeedback({ kind: 'error', text: res.error });
      return;
    }
    setAddedCount((n) => n + 1);
    setFeedback({ kind: 'ok', text: `Ajouté : ${res.unit.serial}`, unitId: res.unit.id });
    setRefresh((n) => n + 1);
  };

  /** Comptage « Scanner les appareils » : marque l'appareil trouvé, sans quitter le scanner. */
  const countSerial = (countId: string, data: string) => {
    const unit = findUnitByCode(data);
    if (unit) {
      const res = markUnitFound(countId, data);
      if (!res.ok) {
        setFeedback({ kind: 'error', text: res.error });
        return;
      }
      const name = getItem(res.itemId)?.name;
      const i = getCountItems(countId).findIndex((x) => x.id === res.itemId);
      // L'écran de comptage s'ouvrira sur cet article au retour.
      if (i >= 0) setCountIndex(countId, i);
      if (res.duplicate) {
        setFeedback({ kind: 'info', text: `Déjà compté : ${unit.serial}${name ? ` · ${name}` : ''}` });
      } else {
        setFoundCount((n) => n + 1);
        setFeedback({ kind: 'ok', text: `Trouvé : ${unit.serial}${name ? ` · ${name}` : ''}` });
      }
      return;
    }
    const it = findItemByCode(data);
    if (it) {
      const i = getCountItems(countId).findIndex((x) => x.id === it.id);
      if (i < 0) {
        setFeedback({ kind: 'error', text: `Article hors comptage : ${it.name}` });
        return;
      }
      setCountIndex(countId, i);
      setFeedback({
        kind: 'info',
        text: it.serialized
          ? `Article « ${it.name} » : scannez le numéro de série de chaque appareil.`
          : `« ${it.name} » est suivi en quantité : saisissez sa quantité dans le comptage.`,
      });
      return;
    }
    setFeedback({ kind: 'error', text: `Code inconnu : ${data}` });
  };

  const handleCode = (raw: string, source: 'camera' | 'manual') => {
    const data = raw.trim();
    if (!data || !focused) return;
    if (source === 'camera') {
      // Dans une boucle, chaque code n'est lu qu'une fois.
      if (loop && loopSeenRef.current.has(data)) return;
      // Hors boucle : le code tout juste traité, encore dans le champ, est ignoré.
      const sup = suppressRef.current;
      if (!loop && sup && sup.code === data) {
        const now = Date.now();
        const stillInView = now - sup.lastSeen < SUPPRESS_GAP_MS;
        sup.lastSeen = now;
        if (stillInView) return;
      }
    }
    if (lockedRef.current) return;
    lockedRef.current = true;
    if (source === 'camera') {
      if (loop) loopSeenRef.current.add(data);
      suppressRef.current = null;
      if (getPrefs().vibration) Vibration.vibrate(60);
    }

    if (pickTarget) {
      setPendingPick(pickTarget, data);
      router.back();
      return;
    }

    if (countTarget) {
      if (!multiCount) {
        setPendingCountScan(countTarget, data);
        router.back();
        return;
      }
      countSerial(countTarget, data);
      if (source === 'manual') setManualText('');
      scheduleUnlock();
      return;
    }

    if (addLoop) {
      addSerial(addTarget, data, source);
      if (source === 'manual') setManualText('');
      scheduleUnlock();
      return;
    }

    setCode(data);
    setManualOpen(false);
    setManualText('');
    setError(null);
    setQty(1);
    setMode('Entrée');
    setAssigning(false);
    setAssignee('');
    setPickArticle(false);
  };

  const handleReset = () => {
    // Le code qui vient d'être traité (souvent encore devant la caméra) n'est
    // relu qu'après être sorti du champ.
    if (code) suppressRef.current = { code, lastSeen: Date.now() };
    lockedRef.current = false;
    committingRef.current = false;
    setCode(null);
    setQty(1);
    setMode('Entrée');
    setError(null);
    setAssigning(false);
    setAssignee('');
    setPickArticle(false);
  };

  const startAddLoop = (target: Item) => {
    // Le code-barres de l'article, encore dans le cadre, ne doit pas être ajouté.
    loopSeenRef.current = new Set(code ? [code] : []);
    setAddTargetId(target.id);
    setAddedCount(0);
    setFeedback(null);
    handleReset();
  };

  const finishLoop = () => {
    if (multiCount || launchedAddId) {
      router.back();
      return;
    }
    if (unlockTimerRef.current) clearTimeout(unlockTimerRef.current);
    unlockTimerRef.current = null;
    loopSeenRef.current = new Set();
    setAddTargetId(null);
    setFeedback(null);
    setManualOpen(false);
    setManualText('');
    handleReset();
  };

  const handleCreate = () => {
    if (!code) return;
    router.push({ pathname: '/article/new', params: { barcode: code } });
  };

  const handleValidate = () => {
    if (!qtyItem || !code || qtyError || committingRef.current) return;
    committingRef.current = true;
    const err = commitMovement(code, mode, qty);
    if (err) {
      committingRef.current = false;
      setError(err);
      return;
    }
    Alert.alert(
      'Mouvement enregistré',
      `${mode} · ${qty} × ${qtyItem.name}`,
      [
        { text: 'Scanner un autre', onPress: handleReset },
        { text: 'Fermer', style: 'cancel', onPress: () => router.back() },
      ]
    );
  };

  const applyUnitStatus = (unit: Unit, unitItem: Item, status: UnitStatus) => {
    if (committingRef.current) return;
    committingRef.current = true;
    const res = updateUnit(unit.id, status === 'assigned' ? { status, assignee } : { status });
    if (res.error !== undefined) {
      committingRef.current = false;
      setError(res.error);
      return;
    }
    setAssigning(false);
    setAssignee('');
    setError(null);
    setRefresh((n) => n + 1);
    const detail = status === 'assigned' && res.unit.assignee
      ? `Attribué à ${res.unit.assignee}`
      : UNIT_STATUS_LABELS[status];
    Alert.alert(
      'Appareil mis à jour',
      `${unitItem.name}\nN° de série ${res.unit.serial} · ${detail}`,
      [
        { text: 'Scanner un autre', onPress: handleReset },
        { text: 'Fermer', style: 'cancel', onPress: () => router.back() },
      ]
    );
  };

  const camGranted = !!perm?.granted;
  const scanning = !code && !manualOpen;

  const hint = pickTarget === 'serial'
    ? "Scannez le numéro de série de l'appareil"
    : pickTarget === 'imei'
    ? "Scannez l'IMEI de l'appareil"
    : multiCount
    ? 'Scannez les numéros de série des appareils'
    : countMode
    ? 'Scannez un article ou un appareil du comptage'
    : addLoop
    ? "Scannez le numéro de série de l'appareil à ajouter"
    : 'Placez le code dans le cadre';

  const manualHelp = pickTarget === 'serial'
    ? "Saisissez le numéro de série de l'appareil."
    : pickTarget === 'imei'
    ? "Saisissez l'IMEI (15 chiffres)."
    : multiCount
    ? "Saisissez le numéro de série ou l'IMEI de l'appareil trouvé."
    : addLoop
    ? `Saisissez le numéro de série de l'appareil à ajouter à « ${addTarget.name} ».`
    : "Saisissez le code-barres, la référence (SKU), le numéro de série ou l'IMEI.";

  const serialItems = unknownCode && pickArticle ? getItems().filter((i) => i.serialized) : [];

  return (
    <View style={{ flex: 1, backgroundColor: '#101714' }}>
      {camGranted && focused && (
        <CameraView
          style={StyleSheet.absoluteFill}
          facing="back"
          enableTorch={torch}
          barcodeScannerSettings={{ barcodeTypes: BARCODE_TYPES }}
          onBarcodeScanned={scanning ? (r) => handleCode(r.data, 'camera') : undefined}
        />
      )}

      {/* Top action bar */}
      <SafeAreaView style={styles.topBar}>
        <Pressable accessibilityRole="button" accessibilityLabel="Fermer" onPress={() => router.back()} style={styles.iconBtn}>
          <Icon name="x" color="#fff" />
        </Pressable>
        {camGranted && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Lampe torche"
            accessibilityState={{ selected: torch }}
            onPress={() => setTorch((t) => !t)}
            style={[styles.iconBtn, torch && styles.iconBtnActive]}
          >
            <Icon name="zap" color={torch ? colors.primary : '#fff'} />
          </Pressable>
        )}
      </SafeAreaView>

      {/* Viewfinder overlay — shown while no code locked */}
      {scanning && camGranted && (
        <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
          <View style={styles.maskTop} />
          <View style={styles.centerRow}>
            <View style={styles.maskSide} />
            <View style={styles.frame}>
              <View style={[styles.corner, styles.cornerTL]} />
              <View style={[styles.corner, styles.cornerTR]} />
              <View style={[styles.corner, styles.cornerBL]} />
              <View style={[styles.corner, styles.cornerBR]} />
              <View style={styles.laserLine} />
            </View>
            <View style={styles.maskSide} />
          </View>
          <View style={[styles.maskBottom, loop && styles.maskBottomLoop]}>
            <Text style={styles.hintText}>{hint}</Text>
            {!loop && <ManualButton onPress={() => setManualOpen(true)} />}
          </View>
        </View>
      )}

      {/* No camera access — manual entry stays available */}
      {scanning && !camGranted && perm && (
        <SafeAreaView edges={['bottom']} style={[styles.permBox, loop && { justifyContent: 'flex-start', paddingTop: 80 }]}>
          <Text style={{ color: '#fff', fontSize: 16, textAlign: 'center' }}>
            L'accès à la caméra est nécessaire pour scanner les codes-barres.
          </Text>
          {perm.canAskAgain ? (
            <Btn title="Autoriser la caméra" onPress={requestPerm} />
          ) : (
            <Btn title="Ouvrir les réglages" onPress={() => { void Linking.openSettings(); }} />
          )}
          {!loop && <Btn title="Saisie manuelle" variant="outline" onPress={() => setManualOpen(true)} />}
        </SafeAreaView>
      )}

      {/* Manual entry sheet */}
      {!code && manualOpen && (
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.sheetHost}
          pointerEvents="box-none"
        >
          <SafeAreaView edges={['bottom']} style={styles.sheetBody}>
            <Text style={{ fontSize: 17, fontWeight: '600', color: colors.text }}>Saisie manuelle</Text>
            <Text style={{ fontSize: 13, color: colors.muted }}>{manualHelp}</Text>
            {loop && feedback && <FeedbackBanner feedback={feedback} />}
            <TextInput
              value={manualText}
              onChangeText={setManualText}
              placeholder={pickTarget === 'imei' ? 'Ex. 356938035643809' : pickTarget || loop ? 'Ex. R58W1A2B3C' : 'Ex. 3760123450003 ou SKU-1000'}
              placeholderTextColor={colors.muted}
              accessibilityLabel={pickTarget === 'imei' ? 'IMEI' : pickTarget || loop ? 'Numéro de série' : 'Code-barres, référence ou numéro de série'}
              autoFocus
              autoCapitalize="characters"
              autoCorrect={false}
              keyboardType={pickTarget === 'imei' ? 'number-pad' : 'default'}
              returnKeyType={loop ? 'done' : 'search'}
              blurOnSubmit={!loop}
              onSubmitEditing={() => handleCode(manualText, 'manual')}
              style={styles.input}
            />
            <Btn
              title={addLoop ? "Ajouter l'appareil" : multiCount ? "Marquer l'appareil trouvé" : 'Valider le code'}
              onPress={() => handleCode(manualText, 'manual')}
              disabled={manualText.trim().length === 0}
            />
            <Btn
              title={camGranted ? 'Revenir au scanner' : loop ? 'Fermer la saisie' : 'Annuler'}
              variant="outline"
              onPress={() => { setManualOpen(false); setManualText(''); }}
            />
          </SafeAreaView>
        </KeyboardAvoidingView>
      )}

      {/* Add-devices loop */}
      {addLoop && !code && !manualOpen && (
        <SafeAreaView edges={['bottom']} style={styles.sheet}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <Icon name="plus-circle" size={20} color={colors.primary} />
            <View style={{ flex: 1 }}>
              <Text accessibilityRole="header" style={{ fontSize: 17, fontWeight: '600', color: colors.text }}>Ajouter des appareils</Text>
              <Text style={{ fontSize: 13, color: colors.muted, marginTop: 2 }}>{addTarget.name}</Text>
            </View>
          </View>
          <Text style={{ fontSize: 13, color: colors.muted }}>
            Scannez le numéro de série de chaque appareil reçu : il est ajouté « En stock » et le scanner reste prêt pour le suivant.
          </Text>
          {feedback && (
            <FeedbackBanner
              feedback={feedback}
              action={feedback.unitId ? { label: 'Compléter (IMEI, statut…)', onPress: () => router.push(`/unit/${feedback.unitId}`) } : undefined}
            />
          )}
          <Text style={{ fontSize: 13, color: colors.text }}>
            {fmtCount(addedCount, 'appareil ajouté', 'appareils ajoutés')} · Stock : {addTarget.qty} en stock
          </Text>
          <Btn title="Saisir un numéro de série" variant="outline" onPress={() => setManualOpen(true)} />
          <Btn title="Terminer" onPress={finishLoop} />
        </SafeAreaView>
      )}

      {/* Count: scan several devices */}
      {multiCount && !manualOpen && (
        <SafeAreaView edges={['bottom']} style={styles.sheet}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <Icon name="check-square" size={20} color={colors.primary} />
            <Text accessibilityRole="header" style={{ flex: 1, fontSize: 17, fontWeight: '600', color: colors.text }}>Comptage des appareils</Text>
          </View>
          <Text style={{ fontSize: 13, color: colors.muted }}>
            Scannez le numéro de série (ou l'IMEI) de chaque appareil présent. Le scanner reste prêt pour le suivant.
          </Text>
          {feedback && <FeedbackBanner feedback={feedback} />}
          <Text style={{ fontSize: 13, color: colors.text }}>{fmtCount(foundCount, 'appareil trouvé', 'appareils trouvés')} pendant ce scan</Text>
          <Btn title="Saisir un numéro de série" variant="outline" onPress={() => setManualOpen(true)} />
          <Btn title="Terminer" accessibilityHint="Retour au comptage" onPress={finishLoop} />
        </SafeAreaView>
      )}

      {/* Unknown code banner */}
      {unknownCode && (
        <SafeAreaView edges={['bottom']} style={styles.sheet}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <Icon name="alert-circle" size={20} color={colors.warnText} />
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 15, fontWeight: '600', color: colors.warnText }}>Code non reconnu</Text>
              <Text selectable style={{ fontSize: 13, color: colors.muted, marginTop: 2 }}>{code}</Text>
            </View>
          </View>
          {!pickArticle ? (
            <>
              <Text style={{ fontSize: 13, color: colors.muted }}>Aucun article ni appareil ne correspond à ce code sur cet appareil.</Text>
              <Btn title="Créer l'article" accessibilityHint="Crée un article avec ce code-barres" onPress={handleCreate} />
              <Btn
                title="Ajouter comme appareil"
                variant="outline"
                accessibilityHint="Enregistre ce code comme numéro de série d'un article suivi par numéro de série"
                onPress={() => setPickArticle(true)}
              />
              <Btn title="Scanner un autre code" variant="outline" onPress={handleReset} />
            </>
          ) : (
            <>
              <Text style={{ fontSize: 13, color: colors.text }}>
                Ajouter « {code} » comme numéro de série de :
              </Text>
              {serialItems.length === 0 ? (
                <>
                  <Text style={{ fontSize: 13, color: colors.muted }}>
                    Aucun article n'est suivi par numéro de série. Créez d'abord l'article de l'appareil (ex. le modèle de téléphone).
                  </Text>
                  <Btn
                    title="Créer un article suivi par n° de série"
                    onPress={() => router.push({ pathname: '/article/new', params: { serialized: '1' } })}
                  />
                </>
              ) : (
                <ScrollView style={{ maxHeight: 260 }} keyboardShouldPersistTaps="handled">
                  {serialItems.map((it) => (
                    <Pressable
                      key={it.id}
                      accessibilityRole="button"
                      accessibilityLabel={`${it.name}, ${it.qty} en stock`}
                      accessibilityHint="Ouvre le formulaire d'appareil prérempli avec ce numéro de série"
                      onPress={() => router.push({ pathname: '/unit/new', params: { itemId: it.id, serial: code ?? '' } })}
                      style={styles.pickRow}
                    >
                      <View style={{ flex: 1 }}>
                        <Text style={{ fontSize: 15, fontWeight: '600', color: colors.text }}>{it.name}</Text>
                        <Text style={{ fontSize: 13, color: colors.muted }}>{it.folder} · {it.qty} en stock</Text>
                      </View>
                      <Icon name="chevron-right" size={18} color={colors.muted} />
                    </Pressable>
                  ))}
                </ScrollView>
              )}
              <Btn title="Retour" variant="outline" onPress={() => setPickArticle(false)} />
            </>
          )}
        </SafeAreaView>
      )}

      {/* Scanned device */}
      {unitMatch && (
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.sheetHost}
          pointerEvents="box-none"
        >
          <SafeAreaView edges={['bottom']} style={styles.sheetBody}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 13, color: colors.muted }}>Appareil scanné · {code}</Text>
                <Text style={{ fontSize: 18, fontWeight: '600', marginTop: 2 }}>{unitMatch.item.name}</Text>
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Rescanner"
                onPress={handleReset}
                style={styles.smallBtn}
              >
                <Icon name="refresh-cw" size={16} color={colors.muted} />
              </Pressable>
            </View>

            <View style={{ gap: 4 }}>
              <Text style={{ fontSize: 14, color: colors.text }}>
                N° de série : <Text selectable style={{ fontWeight: '600' }}>{unitMatch.unit.serial}</Text>
              </Text>
              {unitMatch.unit.imei !== undefined && (
                <Text style={{ fontSize: 14, color: colors.text }}>
                  IMEI : <Text selectable style={{ fontWeight: '600' }}>{unitMatch.unit.imei}</Text>
                </Text>
              )}
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 2 }}>
                <UnitStatusChip status={unitMatch.unit.status} />
                {unitMatch.unit.assignee !== undefined && (
                  <Text style={{ fontSize: 13, color: colors.muted, flexShrink: 1 }}>Attribué à {unitMatch.unit.assignee}</Text>
                )}
              </View>
            </View>

            {assigning ? (
              <>
                <TextInput
                  value={assignee}
                  onChangeText={(t) => { setAssignee(t); setError(null); }}
                  placeholder="Nom de la personne"
                  placeholderTextColor={colors.muted}
                  accessibilityLabel="Attribué à"
                  autoFocus
                  autoCapitalize="words"
                  returnKeyType="done"
                  onSubmitEditing={() => { if (assignee.trim()) applyUnitStatus(unitMatch.unit, unitMatch.item, 'assigned'); }}
                  style={styles.input}
                />
                <Btn
                  title="Confirmer l'attribution"
                  disabled={assignee.trim().length === 0}
                  onPress={() => applyUnitStatus(unitMatch.unit, unitMatch.item, 'assigned')}
                />
                <Btn title="Annuler" variant="outline" onPress={() => { setAssigning(false); setAssignee(''); setError(null); }} />
              </>
            ) : unitMatch.unit.status === 'in_stock' ? (
              <>
                <Btn title="Attribuer" accessibilityHint="Demande le nom de la personne à qui l'appareil est remis" onPress={() => { setAssigning(true); setError(null); }} />
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <Btn title="Envoyer en réparation" variant="outline" style={{ flex: 1, paddingHorizontal: 8 }} onPress={() => applyUnitStatus(unitMatch.unit, unitMatch.item, 'repair')} />
                  <Btn title="Retirer" variant="outline" style={{ flex: 1, paddingHorizontal: 8 }} accessibilityHint="Passe l'appareil au statut Retiré (hors service)" onPress={() => applyUnitStatus(unitMatch.unit, unitMatch.item, 'retired')} />
                </View>
              </>
            ) : (
              <Btn title="Remettre en stock" onPress={() => applyUnitStatus(unitMatch.unit, unitMatch.item, 'in_stock')} />
            )}

            {error && <InlineAlert message={error} />}

            {!assigning && (
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <Btn title="Voir l'appareil" variant="outline" style={{ flex: 1, paddingHorizontal: 8 }} onPress={() => router.push(`/unit/${unitMatch.unit.id}`)} />
                <Btn title="Scanner un autre" variant="outline" style={{ flex: 1, paddingHorizontal: 8 }} onPress={handleReset} />
              </View>
            )}
          </SafeAreaView>
        </KeyboardAvoidingView>
      )}

      {/* Scanned serial-tracked article */}
      {serialItem && (
        <SafeAreaView edges={['bottom']} style={styles.sheet}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={{ fontSize: 13, color: colors.muted }}>Code scanné · {code}</Text>
              <Text style={{ fontSize: 18, fontWeight: '600' }}>{serialItem.name}</Text>
              <SerialBadge />
            </View>
            <Pressable accessibilityRole="button" accessibilityLabel="Rescanner" onPress={handleReset} style={styles.smallBtn}>
              <Icon name="refresh-cw" size={16} color={colors.muted} />
            </Pressable>
          </View>
          <Text style={{ fontSize: 13, color: colors.muted }}>
            Stock actuel : <Text style={{ fontWeight: '600', color: colors.text }}>{serialItem.qty}</Text> en stock
            {serialItem.qty <= serialItem.min && (
              <Text style={{ color: colors.warnText }}> · ⚠ Sous le seuil ({serialItem.min})</Text>
            )}
          </Text>
          <Segmented options={['Entrée', 'Sortie']} value={mode} onChange={setMode} />
          {mode === 'Entrée' ? (
            <>
              <Text style={{ fontSize: 13, color: colors.muted }}>
                Article suivi par numéro de série : ajoutez les appareils reçus un par un en scannant ou en saisissant le numéro de série de chacun.
              </Text>
              <Btn title="Ajouter des appareils" onPress={() => startAddLoop(serialItem)} />
            </>
          ) : (
            <>
              <Text style={{ fontSize: 13, color: colors.muted }}>
                Pour une sortie, scannez le numéro de série (ou l'IMEI) de l'appareil qui sort : vous pourrez l'attribuer, l'envoyer en réparation ou le retirer.
              </Text>
              <Btn title="Scanner l'appareil" onPress={handleReset} />
            </>
          )}
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Btn title="Voir l'article" variant="outline" style={{ flex: 1, paddingHorizontal: 8 }} onPress={() => router.push(`/article/${serialItem.id}`)} />
            <Btn title="Scanner un autre" variant="outline" style={{ flex: 1, paddingHorizontal: 8 }} onPress={handleReset} />
          </View>
        </SafeAreaView>
      )}

      {/* Scanned item bottom sheet */}
      {qtyItem && (
        <SafeAreaView edges={['bottom']} style={styles.sheet}>
          {/* Header row */}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 13, color: colors.muted }}>Code scanné · {code}</Text>
              <Text style={{ fontSize: 18, fontWeight: '600', marginTop: 2 }}>{qtyItem.name}</Text>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Rescanner"
              onPress={handleReset}
              style={styles.smallBtn}
            >
              <Icon name="refresh-cw" size={16} color={colors.muted} />
            </Pressable>
          </View>

          {/* Stock context */}
          <Text style={{ fontSize: 13, color: colors.muted }}>
            Stock actuel : <Text style={{ fontWeight: '600', color: colors.text }}>{qtyItem.qty}</Text> unité(s)
            {qtyItem.qty <= qtyItem.min && (
              <Text style={{ color: colors.warnText }}> · ⚠ Sous le seuil ({qtyItem.min})</Text>
            )}
          </Text>

          <Segmented options={['Entrée', 'Sortie']} value={mode} onChange={(v) => { setMode(v); setError(null); }} />
          <Stepper value={qty} onChange={(n) => { setQty(n); setError(null); }} />

          {/* Validation feedback */}
          {qtyError && <InlineAlert message={qtyError} />}
          {error && <InlineAlert message={error} />}

          <Btn title="Valider" onPress={handleValidate} disabled={!canSubmit} />
          <Btn title="Scanner un autre article" variant="outline" onPress={handleReset} />
        </SafeAreaView>
      )}
    </View>
  );
}

function FeedbackBanner({ feedback, action }: { feedback: Feedback; action?: { label: string; onPress: () => void } }) {
  const palette = feedback.kind === 'ok'
    ? { bg: colors.tint, fg: colors.primary, icon: 'check-circle' as const }
    : feedback.kind === 'info'
    ? { bg: colors.warnBg, fg: colors.warnText, icon: 'info' as const }
    : { bg: '#FEE2E2', fg: '#B91C1C', icon: 'alert-circle' as const };
  return (
    <View accessibilityLiveRegion="polite" style={{ backgroundColor: palette.bg, borderRadius: 10, padding: 12, gap: 6 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Icon name={palette.icon} size={16} color={palette.fg} />
        <Text style={{ flex: 1, fontSize: 13, fontWeight: '600', color: palette.fg }}>{feedback.text}</Text>
      </View>
      {action && (
        <Pressable accessibilityRole="button" onPress={action.onPress} style={{ minHeight: 32, justifyContent: 'center' }}>
          <Text style={{ fontSize: 13, fontWeight: '600', color: colors.primary, textDecorationLine: 'underline' }}>{action.label}</Text>
        </Pressable>
      )}
    </View>
  );
}

function ManualButton({ onPress }: { onPress: () => void }) {
  return (
    <View style={styles.captureContainer}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Saisie manuelle du code"
        onPress={onPress}
        style={({ pressed }) => [
          styles.captureBtnOuter,
          pressed && { transform: [{ scale: 0.94 }], opacity: 0.9 },
        ]}
      >
        <View style={styles.captureBtnInner}>
          <Icon name="edit-3" size={24} color="#fff" />
        </View>
      </Pressable>
      <Text style={styles.captureLabel}>Saisie manuelle</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  topBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    zIndex: 10,
  },
  iconBtn: {
    width: 44,
    height: 44,
    borderRadius: 12,
    backgroundColor: 'rgba(0,0,0,0.4)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.2)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconBtnActive: {
    backgroundColor: '#fff',
    borderColor: '#fff',
  },
  maskTop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  centerRow: {
    flexDirection: 'row',
    height: 180,
  },
  maskSide: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  frame: {
    width: 280,
    height: 180,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.25)',
    justifyContent: 'center',
    alignItems: 'center',
    position: 'relative',
  },
  corner: {
    position: 'absolute',
    width: 28,
    height: 28,
    borderColor: '#fff',
    borderWidth: 3.5,
  },
  cornerTL: { top: -2, left: -2, borderBottomWidth: 0, borderRightWidth: 0, borderTopLeftRadius: 18 },
  cornerTR: { top: -2, right: -2, borderBottomWidth: 0, borderLeftWidth: 0, borderTopRightRadius: 18 },
  cornerBL: { bottom: -2, left: -2, borderTopWidth: 0, borderRightWidth: 0, borderBottomLeftRadius: 18 },
  cornerBR: { bottom: -2, right: -2, borderTopWidth: 0, borderLeftWidth: 0, borderBottomRightRadius: 18 },
  laserLine: {
    width: '90%',
    height: 2,
    backgroundColor: colors.primary,
    borderRadius: 1,
    shadowColor: colors.primary,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.9,
    shadowRadius: 4,
    elevation: 3,
  },
  maskBottom: {
    flex: 1.5,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    paddingTop: 18,
    justifyContent: 'space-between',
    paddingBottom: 40,
  },
  maskBottomLoop: {
    // Cadre plus haut : la fiche du mode « à la suite » occupe le bas de l'écran.
    flex: 3,
  },
  smallBtn: {
    width: 36,
    height: 36,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pickRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    minHeight: 56,
    paddingVertical: 8,
    borderTopWidth: 1,
    borderTopColor: colors.line,
  },
  hintText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '500',
    backgroundColor: 'rgba(0,0,0,0.3)',
    paddingHorizontal: 16,
    paddingVertical: 6,
    borderRadius: 999,
    overflow: 'hidden',
  },
  captureContainer: {
    alignItems: 'center',
    gap: 8,
  },
  captureBtnOuter: {
    width: 76,
    height: 76,
    borderRadius: 38,
    borderWidth: 4,
    borderColor: '#fff',
    backgroundColor: 'rgba(255,255,255,0.2)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  captureBtnInner: {
    width: 58,
    height: 58,
    borderRadius: 29,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  captureLabel: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
    letterSpacing: 0.3,
  },
  permBox: {
    flex: 1,
    justifyContent: 'center',
    padding: 24,
    gap: 16,
  },
  sheetHost: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'flex-end',
  },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: '#fff',
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    padding: 20,
    gap: 12,
  },
  sheetBody: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    padding: 20,
    gap: 12,
  },
  input: {
    height: 48,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: colors.field,
    borderRadius: 10,
    backgroundColor: '#fff',
    fontSize: 16,
    color: colors.text,
  },
});
