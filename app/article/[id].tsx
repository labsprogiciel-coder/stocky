import { useState, useCallback } from 'react';
import { View, Text, Alert } from 'react-native';
import { useLocalSearchParams, Stack, useFocusEffect } from 'expo-router';
import { Screen, Card, Btn, Stepper, Muted, Icon, Alert as InlineAlert } from '../../components/ui';
import { colors } from '../../constants/theme';
import { getItem, adjustStock } from '../../data/store';

const BARS = [2,1,1,3,1,2,2,1,3,1,1,2,1,1,3,2,1,2,1,1,3,1,2,1,1,2,3,1,1,2];

const Field = ({ label, value }: { label: string; value: string }) => (
  <View style={{ width: '50%', marginBottom: 16 }}>
    <Muted style={{ fontWeight: '600', fontSize: 12 }}>{label}</Muted>
    <Text style={{ fontSize: 15, marginTop: 3 }}>{value}</Text>
  </View>
);

export default function ArticleDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [item, setItem] = useState(() => getItem(id ?? '') ?? null);
  const [qty, setQty] = useState(item?.qty ?? 0);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Re-read from store when navigating back to this screen (e.g. after scan)
  useFocusEffect(
    useCallback(() => {
      const fresh = getItem(id ?? '');
      if (fresh) {
        setItem(fresh);
        setQty(fresh.qty);
        setError(null);
        setSaved(false);
      }
    }, [id])
  );

  if (!item) {
    return (
      <Screen hasHeader>
        <Muted>Article introuvable.</Muted>
      </Screen>
    );
  }

  const isDirty = qty !== item.qty;
  const qtyError = qty < 0 ? 'La quantité ne peut pas être négative.' : null;
  const canSave = isDirty && !qtyError;

  const handleAdjust = () => {
    if (!canSave) return;
    const err = adjustStock(item.id, qty);
    if (err) {
      setError(err);
      return;
    }
    // Refresh item from store
    const fresh = getItem(item.id);
    if (fresh) setItem(fresh);
    setError(null);
    setSaved(true);
    Alert.alert('Stock mis à jour', `${item.name} · ${qty} unité(s) enregistrée(s).`);
  };

  const handleQtyChange = (n: number) => {
    setQty(n);
    setError(null);
    setSaved(false);
  };

  const diff = qty - item.qty;
  const diffLabel =
    diff === 0 ? null : diff > 0 ? `+${diff} Entrée` : `${diff} Sortie`;

  return (
    <>
      <Stack.Screen options={{ title: item.name }} />
      <Screen hasHeader>
        {/* Photo placeholder */}
        <View style={{ height: 200, borderRadius: 14, borderWidth: 2, borderStyle: 'dashed', borderColor: '#C9C6BB', backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center' }}>
          <Muted>Photo de l'article</Muted>
        </View>

        {/* Thumbnails */}
        <View style={{ flexDirection: 'row', gap: 8 }}>
          {[0, 1, 2, 3].map((n) => (
            <View key={n} style={{ flex: 1, aspectRatio: 1, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: n === 0 ? colors.tint : '#fff', borderWidth: n === 0 ? 2 : 1, borderColor: n === 0 ? colors.primary : colors.field }}>
              <Icon name="image" color={n === 0 ? colors.primary : colors.muted} />
            </View>
          ))}
        </View>

        {/* Stock adjustment card */}
        <Card>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <Muted>Stock actuel</Muted>
            {item.qty <= item.min && (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: colors.warnBg, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999 }}>
                <Icon name="alert-triangle" size={12} color={colors.warnText} />
                <Text style={{ fontSize: 11, fontWeight: '700', color: colors.warnText }}>Sous seuil</Text>
              </View>
            )}
          </View>
          <Stepper value={qty} onChange={handleQtyChange} />
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 10 }}>
            <Muted>Seuil minimum : {item.min}</Muted>
            {diffLabel && (
              <Text style={{ fontSize: 13, fontWeight: '600', color: diff > 0 ? colors.primary : colors.warnText }}>
                {diffLabel}
              </Text>
            )}
          </View>
        </Card>

        {/* Fields */}
        <Card style={{ flexDirection: 'row', flexWrap: 'wrap', paddingBottom: 0 }}>
          <Field label="Dossier" value={item.folder} />
          <Field label="Référence (SKU)" value={item.sku} />
          <Field label="Prix unitaire (FCFA)" value={item.price.toLocaleString('fr-FR')} />
          <Field label="Valeur totale (FCFA)" value={(item.price * qty).toLocaleString('fr-FR')} />
        </Card>

        {/* Barcode */}
        <Card style={{ alignItems: 'center', gap: 10 }}>
          <Text style={{ fontSize: 17, fontWeight: '600', alignSelf: 'flex-start' }}>Code-barres</Text>
          <View accessibilityLabel="Aperçu du code-barres" style={{ flexDirection: 'row', height: 56 }}>
            {BARS.map((w, i) => <View key={i} style={{ width: w * 2, backgroundColor: i % 2 === 0 ? '#000' : '#fff' }} />)}
          </View>
          <Text style={{ fontFamily: 'Courier', letterSpacing: 3 }}>{item.sku}</Text>
          <Btn title="Imprimer l'étiquette" variant="outline" style={{ alignSelf: 'stretch' }} />
        </Card>

        {/* Inline errors */}
        {qtyError && <InlineAlert message={qtyError} />}
        {error && <InlineAlert message={error} />}

        {/* CTA */}
        <Btn
          title={saved ? '✓ Stock enregistré' : 'Ajuster le stock'}
          onPress={handleAdjust}
          disabled={!canSave}
        />
      </Screen>
    </>
  );
}
