import { useState, useRef, useCallback } from 'react';
import { View, Text, Pressable, StyleSheet, Alert, TextInput, Vibration, KeyboardAvoidingView, Platform, Linking } from 'react-native';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { CameraView, useCameraPermissions, type BarcodeType } from 'expo-camera';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Btn, Icon, Segmented, Stepper, Alert as InlineAlert } from '../components/ui';
import { colors } from '../constants/theme';
import { findItemByCode, commitMovement, getPrefs, setPendingCountScan } from '../data/store';

const BARCODE_TYPES: BarcodeType[] = ['ean13', 'ean8', 'upc_a', 'upc_e', 'code128', 'code39', 'qr'];

export default function Scan() {
  const { countId } = useLocalSearchParams<{ countId?: string }>();
  const countTarget = typeof countId === 'string' && countId.length > 0 ? countId : null;
  const countMode = countTarget !== null;

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
  // Verrou synchrone : la caméra peut émettre plusieurs lectures avant le rendu.
  const lockedRef = useRef(false);
  // Verrou synchrone contre le double appui sur Valider (le state est groupé par React).
  const committingRef = useRef(false);

  useFocusEffect(
    useCallback(() => {
      setRefresh((n) => n + 1);
    }, [])
  );

  const item = code ? findItemByCode(code) ?? null : null;
  const unknownCode = code !== null && item === null;

  // ── qty validation ────────────────────────────────────────────────────────
  const qtyError =
    qty <= 0
      ? 'La quantité doit être supérieure à 0.'
      : mode === 'Sortie' && item && qty > item.qty
      ? `Stock insuffisant — disponible : ${item.qty} unité(s).`
      : null;

  const canSubmit = !!item && !qtyError;

  // ── handlers ──────────────────────────────────────────────────────────────
  const handleCode = (raw: string, source: 'camera' | 'manual') => {
    const data = raw.trim();
    if (!data || lockedRef.current) return;
    lockedRef.current = true;
    if (source === 'camera' && getPrefs().vibration) Vibration.vibrate(60);

    if (countTarget) {
      setPendingCountScan(countTarget, data);
      router.back();
      return;
    }

    setCode(data);
    setManualOpen(false);
    setManualText('');
    setError(null);
    setQty(1);
    setMode('Entrée');
  };

  const handleReset = () => {
    lockedRef.current = false;
    committingRef.current = false;
    setCode(null);
    setQty(1);
    setMode('Entrée');
    setError(null);
  };

  const handleCreate = () => {
    if (!code) return;
    router.push({ pathname: '/article/new', params: { barcode: code } });
  };

  const handleValidate = () => {
    if (!item || !code || qtyError || committingRef.current) return;
    committingRef.current = true;
    const err = commitMovement(code, mode, qty);
    if (err) {
      committingRef.current = false;
      setError(err);
      return;
    }
    Alert.alert(
      'Mouvement enregistré',
      `${mode} · ${qty} × ${item.name}`,
      [
        { text: 'Scanner un autre', onPress: handleReset },
        { text: 'Fermer', style: 'cancel', onPress: () => router.back() },
      ]
    );
  };

  const camGranted = !!perm?.granted;
  const scanning = !code && !manualOpen;

  return (
    <View style={{ flex: 1, backgroundColor: '#101714' }}>
      {camGranted && (
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
          <View style={styles.maskBottom}>
            <Text style={styles.hintText}>
              {countMode ? 'Scannez un article du comptage' : 'Placez le code dans le cadre'}
            </Text>
            <ManualButton onPress={() => setManualOpen(true)} />
          </View>
        </View>
      )}

      {/* No camera access — manual entry stays available */}
      {scanning && !camGranted && perm && (
        <SafeAreaView edges={['bottom']} style={styles.permBox}>
          <Text style={{ color: '#fff', fontSize: 16, textAlign: 'center' }}>
            L'accès à la caméra est nécessaire pour scanner les codes-barres.
          </Text>
          {perm.canAskAgain ? (
            <Btn title="Autoriser la caméra" onPress={requestPerm} />
          ) : (
            <Btn title="Ouvrir les réglages" onPress={() => { void Linking.openSettings(); }} />
          )}
          <Btn title="Saisie manuelle" variant="outline" onPress={() => setManualOpen(true)} />
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
            <Text style={{ fontSize: 13, color: colors.muted }}>Saisissez le code-barres ou la référence (SKU).</Text>
            <TextInput
              value={manualText}
              onChangeText={setManualText}
              placeholder="Ex. 3760123450003 ou SKU-1000"
              placeholderTextColor={colors.muted}
              accessibilityLabel="Code-barres ou référence"
              autoFocus
              autoCapitalize="characters"
              autoCorrect={false}
              returnKeyType="search"
              onSubmitEditing={() => handleCode(manualText, 'manual')}
              style={styles.input}
            />
            <Btn
              title="Valider le code"
              onPress={() => handleCode(manualText, 'manual')}
              disabled={manualText.trim().length === 0}
            />
            <Btn
              title={camGranted ? 'Revenir au scanner' : 'Annuler'}
              variant="outline"
              onPress={() => { setManualOpen(false); setManualText(''); }}
            />
          </SafeAreaView>
        </KeyboardAvoidingView>
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
          <Text style={{ fontSize: 13, color: colors.muted }}>Aucun article ne correspond à ce code sur cet appareil.</Text>
          <Btn title="Créer l'article" onPress={handleCreate} />
          <Btn title="Scanner un autre article" variant="outline" onPress={handleReset} />
        </SafeAreaView>
      )}

      {/* Scanned item bottom sheet */}
      {item && (
        <SafeAreaView edges={['bottom']} style={styles.sheet}>
          {/* Header row */}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 13, color: colors.muted }}>Code scanné · {code}</Text>
              <Text style={{ fontSize: 18, fontWeight: '600', marginTop: 2 }}>{item.name}</Text>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Rescanner"
              onPress={handleReset}
              style={{ width: 36, height: 36, borderRadius: 10, borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center' }}
            >
              <Icon name="refresh-cw" size={16} color={colors.muted} />
            </Pressable>
          </View>

          {/* Stock context */}
          <Text style={{ fontSize: 13, color: colors.muted }}>
            Stock actuel : <Text style={{ fontWeight: '600', color: colors.text }}>{item.qty}</Text> unité(s)
            {item.qty <= item.min && (
              <Text style={{ color: colors.warnText }}> · ⚠ Sous le seuil ({item.min})</Text>
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
