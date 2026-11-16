import { useState, useRef } from 'react';
import { View, Text, TextInput, ScrollView, type TextInputProps } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Card, Btn, Chip, Muted, Alert as InlineAlert } from '../../components/ui';
import { colors } from '../../constants/theme';
import { createItem, getItems, type NewItemInput } from '../../data/store';

type FieldKey = keyof NewItemInput;

/** Entier ou décimal saisi au clavier ("1 500", "2,5"…) ; NaN si invalide. */
function parseNumber(text: string): number {
  const t = text.replace(/[\s  ]/g, '').replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(t)) return NaN;
  return Number(t);
}

function Field({
  label,
  error,
  hint,
  ...input
}: { label: string; error?: string; hint?: string } & TextInputProps) {
  return (
    <View style={{ gap: 6 }}>
      <Muted style={{ fontWeight: '600', fontSize: 12 }}>{label}</Muted>
      <TextInput
        accessibilityLabel={label}
        placeholderTextColor={colors.muted}
        {...input}
        style={{
          height: 48,
          paddingHorizontal: 14,
          borderWidth: 1,
          borderColor: error ? '#B91C1C' : colors.field,
          borderRadius: 10,
          backgroundColor: '#fff',
          fontSize: 15,
          color: colors.text,
        }}
      />
      {error ? (
        <Text style={{ fontSize: 12, color: '#B91C1C', fontWeight: '500' }}>{error}</Text>
      ) : hint ? (
        <Muted style={{ fontSize: 12 }}>{hint}</Muted>
      ) : null}
    </View>
  );
}

export default function NewArticle() {
  const params = useLocalSearchParams<{ barcode?: string }>();
  const folders = Array.from(new Set(getItems().map((i) => i.folder)));

  const [name, setName] = useState('');
  const [barcode, setBarcode] = useState(typeof params.barcode === 'string' ? params.barcode : '');
  const [sku, setSku] = useState('');
  const [folder, setFolder] = useState(folders[0] ?? '');
  const [qty, setQty] = useState('0');
  const [min, setMin] = useState('0');
  const [price, setPrice] = useState('0');
  const [errors, setErrors] = useState<Partial<Record<FieldKey, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);

  // Verrou synchrone contre le double appui sur « Créer l'article ».
  const submittingRef = useRef(false);

  const clear = (k: FieldKey) => {
    setErrors((e) => ({ ...e, [k]: undefined }));
    setFormError(null);
  };

  const handleSubmit = () => {
    if (submittingRef.current) return;
    const next: Partial<Record<FieldKey, string>> = {};
    const nQty = parseNumber(qty);
    const nMin = parseNumber(min);
    const nPrice = parseNumber(price);
    if (!name.trim()) next.name = 'Le nom est obligatoire.';
    if (!folder.trim()) next.folder = 'Choisissez ou saisissez un dossier.';
    if (!Number.isInteger(nQty)) next.qty = 'Saisissez un nombre entier positif ou nul.';
    if (!Number.isInteger(nMin)) next.min = 'Saisissez un nombre entier positif ou nul.';
    if (Number.isNaN(nPrice)) next.price = 'Saisissez un prix positif ou nul.';
    if (Object.keys(next).length > 0) {
      setErrors(next);
      setFormError('Corrigez les champs signalés.');
      return;
    }

    submittingRef.current = true;
    const res = createItem({ name, barcode, sku, folder, qty: nQty, min: nMin, price: nPrice });
    if (res.error !== undefined) {
      submittingRef.current = false;
      if (res.field) setErrors({ [res.field]: res.error });
      setFormError(res.error);
      return;
    }
    router.back();
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }} edges={['bottom']}>
      <ScrollView
        contentContainerStyle={{ paddingHorizontal: 12, paddingTop: 8, paddingBottom: 32, gap: 16 }}
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
      >
        <Card style={{ gap: 14 }}>
          <Field
            label="Nom *"
            value={name}
            onChangeText={(t) => { setName(t); clear('name'); }}
            placeholder="Ex. Câble USB-C 1 m"
            error={errors.name}
            returnKeyType="next"
          />
          <Field
            label="Code-barres"
            value={barcode}
            onChangeText={(t) => { setBarcode(t); clear('barcode'); }}
            placeholder="EAN, UPC, QR…"
            autoCapitalize="none"
            autoCorrect={false}
            error={errors.barcode}
            hint="Facultatif — utilisé par le scanner."
          />
          <Field
            label="Référence (SKU)"
            value={sku}
            onChangeText={(t) => { setSku(t); clear('sku'); }}
            placeholder="Générée automatiquement si vide"
            autoCapitalize="characters"
            autoCorrect={false}
            error={errors.sku}
          />
        </Card>

        <Card style={{ gap: 10 }}>
          <Field
            label="Dossier *"
            value={folder}
            onChangeText={(t) => { setFolder(t); clear('folder'); }}
            placeholder="Nom du dossier"
            error={errors.folder}
          />
          {folders.length > 0 && (
            <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
              {folders.map((f) => (
                <Chip key={f} label={f} active={f === folder.trim()} onPress={() => { setFolder(f); clear('folder'); }} />
              ))}
            </View>
          )}
        </Card>

        <Card style={{ gap: 14 }}>
          <View style={{ flexDirection: 'row', gap: 12 }}>
            <View style={{ flex: 1 }}>
              <Field
                label="Quantité initiale"
                value={qty}
                onChangeText={(t) => { setQty(t); clear('qty'); }}
                keyboardType="number-pad"
                selectTextOnFocus
                error={errors.qty}
              />
            </View>
            <View style={{ flex: 1 }}>
              <Field
                label="Seuil minimum"
                value={min}
                onChangeText={(t) => { setMin(t); clear('min'); }}
                keyboardType="number-pad"
                selectTextOnFocus
                error={errors.min}
              />
            </View>
          </View>
          <Field
            label="Prix unitaire (FCFA)"
            value={price}
            onChangeText={(t) => { setPrice(t); clear('price'); }}
            keyboardType="decimal-pad"
            selectTextOnFocus
            error={errors.price}
          />
        </Card>

        {formError && <InlineAlert message={formError} />}

        <Btn title="Créer l'article" onPress={handleSubmit} />
        <Btn title="Annuler" variant="outline" onPress={() => router.back()} />
      </ScrollView>
    </SafeAreaView>
  );
}
