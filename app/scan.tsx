import { useState, useRef } from 'react';
import { View, Text, Pressable, StyleSheet, Alert } from 'react-native';
import { router } from 'expo-router';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Btn, Icon, Segmented, Stepper, Alert as InlineAlert } from '../components/ui';
import { colors } from '../constants/theme';
import { findItemBySku, commitMovement } from '../data/store';

export default function Scan() {
  const [perm, requestPerm] = useCameraPermissions();
  const [torch, setTorch] = useState(false);
  const [code, setCode] = useState<string | null>(null);
  const [mode, setMode] = useState<'Entrée' | 'Sortie'>('Entrée');
  const [qty, setQty] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const cameraRef = useRef<CameraView>(null);

  const item = code ? findItemBySku(code) : null;
  const unknownCode = code !== null && item === null;

  // ── qty validation ────────────────────────────────────────────────────────
  const qtyError =
    qty <= 0
      ? 'La quantité doit être supérieure à 0.'
      : mode === 'Sortie' && item && qty > item.qty
      ? `Stock insuffisant — disponible : ${item.qty} unité(s).`
      : null;

  const canSubmit = !!item && !qtyError && !submitting;

  // ── handlers ──────────────────────────────────────────────────────────────
  const handleBarcodeScanned = (data: string) => {
    if (code) return; // already locked
    setCode(data);
    setError(null);
    setQty(1);
    setMode('Entrée');
  };

  const handleManualCapture = async () => {
    try {
      if (cameraRef.current) {
        await cameraRef.current.takePictureAsync({ skipProcessing: true }).catch(() => {});
      }
    } catch {
      // Simulator / unsupported — no-op
    }
    if (!code) {
      // Dev/sim fallback: resolve first item
      handleBarcodeScanned('SKU-1000');
    }
  };

  const handleReset = () => {
    setCode(null);
    setQty(1);
    setMode('Entrée');
    setError(null);
    setSubmitting(false);
  };

  const handleValidate = () => {
    if (!item || !code || qtyError) return;
    setSubmitting(true);
    const err = commitMovement(code, mode, qty);
    setSubmitting(false);
    if (err) {
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

  // ── Permission gate ────────────────────────────────────────────────────────
  if (!perm?.granted) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: '#101714', justifyContent: 'center', padding: 24, gap: 16 }}>
        <Text style={{ color: '#fff', fontSize: 16, textAlign: 'center' }}>
          L'accès à la caméra est nécessaire pour scanner les codes-barres.
        </Text>
        <Btn title="Autoriser la caméra" onPress={requestPerm} />
        <Btn title="Fermer" variant="outline" onPress={() => router.back()} />
      </SafeAreaView>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: '#101714' }}>
      <CameraView
        ref={cameraRef}
        style={StyleSheet.absoluteFill}
        facing="back"
        enableTorch={torch}
        onBarcodeScanned={code ? undefined : (r) => handleBarcodeScanned(r.data)}
      />

      {/* Top action bar */}
      <SafeAreaView style={styles.topBar}>
        <Pressable accessibilityRole="button" accessibilityLabel="Fermer" onPress={() => router.back()} style={styles.iconBtn}>
          <Icon name="x" color="#fff" />
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Lampe torche"
          onPress={() => setTorch((t) => !t)}
          style={[styles.iconBtn, torch && styles.iconBtnActive]}
        >
          <Icon name="zap" color={torch ? colors.primary : '#fff'} />
        </Pressable>
      </SafeAreaView>

      {/* Viewfinder overlay — shown while no code locked */}
      {!code && (
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
            <Text style={styles.hintText}>Placez le code dans le cadre</Text>
            <View style={styles.captureContainer}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Capturer manuellement"
                onPress={handleManualCapture}
                style={({ pressed }) => [
                  styles.captureBtnOuter,
                  pressed && { transform: [{ scale: 0.94 }], opacity: 0.9 },
                ]}
              >
                <View style={styles.captureBtnInner}>
                  <Icon name="maximize" size={24} color="#fff" />
                </View>
              </Pressable>
              <Text style={styles.captureLabel}>Capturer</Text>
            </View>
          </View>
        </View>
      )}

      {/* Unknown code banner */}
      {unknownCode && (
        <SafeAreaView edges={['bottom']} style={styles.bottomSheet}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <Icon name="alert-circle" size={20} color={colors.warnText} />
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 15, fontWeight: '600', color: colors.warnText }}>Code non reconnu</Text>
              <Text style={{ fontSize: 13, color: colors.muted, marginTop: 2 }}>{code}</Text>
            </View>
          </View>
          <Btn title="Scanner un autre article" variant="outline" onPress={handleReset} />
        </SafeAreaView>
      )}

      {/* Scanned item bottom sheet */}
      {item && (
        <SafeAreaView edges={['bottom']} style={styles.bottomSheet}>
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

          <Btn title={submitting ? 'Enregistrement…' : 'Valider'} onPress={handleValidate} disabled={!canSubmit} />
          <Btn title="Scanner un autre article" variant="outline" onPress={handleReset} />
        </SafeAreaView>
      )}
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
  bottomSheet: {
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
});
