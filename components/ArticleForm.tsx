/**
 * Formulaire d'article partagé par la création (`app/article/new.tsx`) et la
 * modification (`app/article/edit/[id].tsx`).
 *
 * - Création : tous les champs, dont la quantité initiale (masquée si le suivi
 *   par numéro de série est activé : le stock démarre à 0 et vient des appareils).
 * - Modification : champs préremplis, sans la quantité (le stock se modifie
 *   depuis la fiche article pour que chaque changement soit un mouvement).
 *   Activer / désactiver le suivi par numéro de série peut être refusé par
 *   `updateItem` (stock non nul, appareils enregistrés) : l'erreur s'affiche
 *   sous l'interrupteur.
 *
 * Photo : un fichier choisi ici n'appartient à l'article qu'après un
 * enregistrement réussi. Les fichiers choisis puis remplacés, retirés ou
 * abandonnés (Annuler, retour) sont supprimés au fur et à mesure / au
 * démontage. L'ancienne photo d'un article modifié est supprimée par
 * `updateItem` après l'enregistrement.
 */
import { useEffect, useRef, useState } from 'react';
import { View, Text, ScrollView, Switch } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Card, Btn, Chip, Muted, ItemPhoto, TextField as Field, Alert as InlineAlert } from './ui';
import { colors } from '../constants/theme';
import { createItem, fmtCount, getItems, updateItem, type Item, type NewItemInput } from '../data/store';
import { deletePhoto, pickPhoto, type PhotoSource } from '../data/photos';

type FieldKey = keyof NewItemInput;
type Errors = Partial<Record<FieldKey, string>>;

/** Entier ou décimal saisi au clavier ("1 500", "2,5"…) ; NaN si invalide. */
function parseNumber(text: string): number {
  const t = text.replace(/[\s  ]/g, '').replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(t)) return NaN;
  return Number(t);
}

/** Nombre affiché dans un champ, avec la virgule décimale française. */
const numberText = (n: number) => String(n).replace('.', ',');

export type ArticleFormProps = {
  /** Article à modifier ; absent pour une création. */
  item?: Item;
  /** Code-barres prérempli (création depuis le scanner). */
  initialBarcode?: string;
  /** Création : suivi par numéro de série activé d'emblée. */
  initialSerialized?: boolean;
  /** Appelé après un enregistrement réussi, ou sur « Annuler ». */
  onDone: () => void;
};

export function ArticleForm({ item, initialBarcode, initialSerialized, onDone }: ArticleFormProps) {
  const editing = item !== undefined;
  const [folders] = useState(() => Array.from(new Set(getItems().map((i) => i.folder))));

  const [name, setName] = useState(item?.name ?? '');
  const [barcode, setBarcode] = useState(item ? (item.barcode ?? '') : (initialBarcode ?? ''));
  const [sku, setSku] = useState(item?.sku ?? '');
  const [folder, setFolder] = useState(item?.folder ?? folders[0] ?? '');
  const [qty, setQty] = useState('0');
  const [min, setMin] = useState(item ? numberText(item.min) : '0');
  const [price, setPrice] = useState(item ? numberText(item.price) : '0');
  const [serialized, setSerialized] = useState(item ? item.serialized === true : initialSerialized === true);
  const [photo, setPhotoState] = useState<string | null>(item?.photo ?? null);
  // Copie synchrone de `photo`, lue après l'attente du sélecteur.
  const photoRef = useRef<string | null>(item?.photo ?? null);
  const [picking, setPicking] = useState(false);
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);

  // Verrou synchrone contre le double appui sur le bouton d'enregistrement.
  const submittingRef = useRef(false);
  // Photos choisies dans ce formulaire et pas encore enregistrées.
  const unsavedPhotosRef = useRef(new Set<string>());
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    const unsaved = unsavedPhotosRef.current;
    return () => {
      mountedRef.current = false;
      // Formulaire quitté sans enregistrer : pas de fichier orphelin.
      for (const n of unsaved) deletePhoto(n);
      unsaved.clear();
    };
  }, []);

  const clear = (k: FieldKey) => {
    setErrors((e) => ({ ...e, [k]: undefined }));
    setFormError(null);
  };

  /** Remplace la photo affichée ; supprime l'ancienne si elle n'a jamais été enregistrée. */
  const replacePhoto = (next: string | null) => {
    const prev = photoRef.current;
    if (prev !== null && prev !== next && unsavedPhotosRef.current.delete(prev)) deletePhoto(prev);
    photoRef.current = next;
    setPhotoState(next);
    clear('photo');
  };

  const handlePick = async (source: PhotoSource) => {
    if (picking || submittingRef.current) return;
    setPicking(true);
    const picked = await pickPhoto(source, item?.id);
    if (!mountedRef.current) {
      // Écran quitté pendant la prise de vue.
      if (picked) deletePhoto(picked);
      return;
    }
    setPicking(false);
    if (!picked) return;
    unsavedPhotosRef.current.add(picked);
    replacePhoto(picked);
  };

  const handleSubmit = () => {
    if (submittingRef.current || picking) return;
    const next: Errors = {};
    // Suivi par numéro de série : le stock démarre à 0 (il vient des appareils).
    const nQty = editing || serialized ? 0 : parseNumber(qty);
    const nMin = parseNumber(min);
    const nPrice = parseNumber(price);
    if (!name.trim()) next.name = 'Le nom est obligatoire.';
    if (!folder.trim()) next.folder = 'Choisissez ou saisissez un dossier.';
    if (!editing && !serialized && !Number.isInteger(nQty)) next.qty = 'Saisissez un nombre entier positif ou nul.';
    if (!Number.isInteger(nMin)) next.min = 'Saisissez un nombre entier positif ou nul.';
    if (Number.isNaN(nPrice)) next.price = 'Saisissez un prix positif ou nul.';
    if (Object.keys(next).length > 0) {
      setErrors(next);
      setFormError('Corrigez les champs signalés.');
      return;
    }

    submittingRef.current = true;
    const res = editing
      ? updateItem(item.id, { name, barcode, sku, folder, min: nMin, price: nPrice, photo, serialized })
      : createItem({ name, barcode, sku, folder, qty: nQty, min: nMin, price: nPrice, serialized, ...(photo !== null ? { photo } : {}) });
    if (res.error !== undefined) {
      submittingRef.current = false;
      const field = res.field;
      if (field !== undefined && field !== 'id') setErrors({ [field]: res.error });
      setFormError(res.error);
      return;
    }
    // La photo appartient désormais à l'article : ne pas la supprimer au démontage.
    if (photo !== null) unsavedPhotosRef.current.delete(photo);
    onDone();
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }} edges={['bottom']}>
      <ScrollView
        contentContainerStyle={{ paddingHorizontal: 12, paddingTop: 8, paddingBottom: 32, gap: 16 }}
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
      >
        <Card style={{ gap: 10 }}>
          <Muted style={{ fontWeight: '600', fontSize: 12 }}>Photo</Muted>
          <ItemPhoto
            photo={photo}
            height={180}
            accessibilityLabel={name.trim() ? `Photo de ${name.trim()}` : "Photo de l'article"}
            emptyLabel="Aucune photo"
          />
          <Btn
            title="Prendre une photo"
            variant="outline"
            disabled={picking}
            accessibilityHint="Ouvre l'appareil photo"
            onPress={() => { void handlePick('camera'); }}
          />
          <Btn
            title="Choisir dans la galerie"
            variant="outline"
            disabled={picking}
            accessibilityHint="Ouvre la galerie de photos"
            onPress={() => { void handlePick('library'); }}
          />
          {photo !== null && (
            <Btn
              title="Supprimer la photo"
              variant="danger"
              disabled={picking}
              accessibilityHint={editing ? "Retire la photo de l'article à l'enregistrement" : "Retire la photo choisie"}
              onPress={() => replacePhoto(null)}
            />
          )}
          {errors.photo && <InlineAlert message={errors.photo} />}
        </Card>

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

        <Card style={{ gap: 8 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 48 }}>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 15, fontWeight: '600', color: colors.text }}>Suivi par numéro de série</Text>
              <Muted style={{ fontSize: 12, marginTop: 2 }}>
                Pour les appareils : téléphones, ordinateurs, casques… Chaque appareil est enregistré avec son
                numéro de série (et son IMEI) ; le stock est le nombre d'appareils « En stock ».
              </Muted>
            </View>
            <Switch
              value={serialized}
              onValueChange={(v) => { setSerialized(v); clear('serialized'); clear('qty'); }}
              trackColor={{ false: colors.field, true: colors.primary }}
              thumbColor="#fff"
              accessibilityLabel="Suivi par numéro de série"
              accessibilityHint="Pour les appareils identifiés individuellement : téléphones, ordinateurs, casques"
            />
          </View>
          {!editing && serialized && (
            <Muted style={{ fontSize: 12 }}>
              L'article est créé avec un stock de 0 : ajoutez ensuite chaque appareil depuis sa fiche ou le scanner.
            </Muted>
          )}
          {editing && !errors.serialized && serialized !== (item.serialized === true) && (
            <Muted style={{ fontSize: 12 }}>
              {serialized
                ? item.qty > 0
                  ? `Le stock actuel (${item.qty}) doit d'abord être mis à 0 depuis la fiche article : les appareils seront ensuite ajoutés un par un.`
                  : 'Les appareils seront ajoutés un par un depuis la fiche article ou le scanner.'
                : 'Le stock redeviendra une simple quantité. Les numéros de série doivent avoir été supprimés.'}
            </Muted>
          )}
          {errors.serialized && (
            <Text accessibilityLiveRegion="polite" style={{ fontSize: 12, color: '#B91C1C', fontWeight: '500' }}>{errors.serialized}</Text>
          )}
        </Card>

        <Card style={{ gap: 14 }}>
          <View style={{ flexDirection: 'row', gap: 12 }}>
            {!editing && !serialized && (
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
            )}
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
          {editing && (item.serialized ? (
            <Muted style={{ fontSize: 12 }}>
              Stock actuel : {fmtCount(item.qty, 'appareil en stock', 'appareils en stock')}. Il est calculé à partir
              des numéros de série enregistrés sur la fiche article.
            </Muted>
          ) : (
            <Muted style={{ fontSize: 12 }}>
              Stock actuel : {fmtCount(item.qty, 'unité', 'unités')}. Il se modifie depuis la fiche article
              (« Ajuster le stock ») afin que chaque changement soit enregistré comme mouvement.
            </Muted>
          ))}
        </Card>

        {formError && <InlineAlert message={formError} />}

        <Btn
          title={editing ? 'Enregistrer les modifications' : "Créer l'article"}
          disabled={picking}
          onPress={handleSubmit}
        />
        <Btn title="Annuler" variant="outline" onPress={onDone} />
      </ScrollView>
    </SafeAreaView>
  );
}
