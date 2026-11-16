/**
 * Formulaire d'appareil (unité suivie par numéro de série), partagé par
 * `app/unit/new.tsx` (ajout) et `app/unit/[id].tsx` (modification).
 *
 * - Numéro de série obligatoire, avec un bouton « Scanner » qui ouvre
 *   `/scan?pick=serial` : le code lu est transmis au retour par
 *   `setPendingPick`/`consumePendingPick` (même principe que le scan de comptage).
 * - IMEI facultatif (clavier numérique, contrôle de Luhn en direct), lui aussi scannable.
 * - Statut, attributaire (obligatoire pour « Attribué »), note.
 * - Enregistrement par `addUnit`/`updateUnit` ; les erreurs du store s'affichent
 *   sous le champ concerné. Verrou contre le double appui.
 */
import { useCallback, useRef, useState } from 'react';
import { View, Text, Pressable, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useFocusEffect } from 'expo-router';
import { Card, Btn, Chip, Muted, Icon, Thumb, SerialBadge, TextField, Alert as InlineAlert } from './ui';
import { colors } from '../constants/theme';
import {
  UNIT_STATUSES,
  UNIT_STATUS_LABELS,
  addUnit,
  consumePendingPick,
  normalizeImei,
  updateUnit,
  type Item,
  type PickTarget,
  type Unit,
  type UnitField,
  type UnitStatus,
} from '../data/store';

type Errors = Partial<Record<UnitField, string>>;

/** Aide en direct sur l'IMEI saisi : texte et couleur. */
function imeiFeedback(text: string): { hint: string; color?: string } {
  const d = text.replace(/[\s-]+/g, '');
  if (!d) return { hint: "Facultatif — 15 chiffres, pour les téléphones (composez *#06# pour l'afficher)." };
  if (!/^\d+$/.test(d)) return { hint: "L'IMEI ne doit contenir que des chiffres.", color: '#B91C1C' };
  if (d.length < 15) return { hint: `${d.length} / 15 chiffres` };
  const r = normalizeImei(d);
  if (r.error !== undefined) return { hint: r.error, color: '#B91C1C' };
  return { hint: '✓ IMEI valide (clé de contrôle correcte)', color: colors.primary };
}

function ScanAccessory({ label, onPress, disabled }: { label: string; onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint="Ouvre le scanner ; le code lu remplit ce champ"
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={{ height: 48, paddingHorizontal: 12, borderRadius: 10, borderWidth: 1, borderColor: colors.primary, backgroundColor: '#fff', flexDirection: 'row', alignItems: 'center', gap: 6, opacity: disabled ? 0.4 : 1 }}
    >
      <Icon name="maximize" size={18} color={colors.primary} />
      <Text style={{ fontSize: 14, fontWeight: '600', color: colors.primary }}>Scanner</Text>
    </Pressable>
  );
}

export type UnitFormProps = {
  /** Article (suivi par numéro de série) de l'appareil. */
  item: Item;
  /** Appareil à modifier ; absent pour un ajout. */
  unit?: Unit;
  /** Ajout : numéro de série prérempli (code scanné). */
  initialSerial?: string;
  /** Appelé après un enregistrement réussi, ou sur « Annuler ». */
  onDone: () => void;
  /** Contenu affiché sous les boutons (historique, suppression…). */
  children?: React.ReactNode;
};

export function UnitForm({ item, unit, initialSerial, onDone, children }: UnitFormProps) {
  const editing = unit !== undefined;
  const [serial, setSerial] = useState(unit?.serial ?? initialSerial ?? '');
  const [imei, setImei] = useState(unit?.imei ?? '');
  const [status, setStatus] = useState<UnitStatus>(unit?.status ?? 'in_stock');
  const [assignee, setAssignee] = useState(unit?.assignee ?? '');
  const [note, setNote] = useState(unit?.note ?? '');
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Appareils déjà enregistrés par « Ajouter et saisir un autre ».
  const [addedCount, setAddedCount] = useState(0);

  // Verrou synchrone contre le double appui sur l'enregistrement.
  const submittingRef = useRef(false);
  // Champ pour lequel le scanner a été ouvert depuis ce formulaire.
  const pickRef = useRef<PickTarget | null>(null);

  const clear = (k: UnitField) => {
    setErrors((e) => ({ ...e, [k]: undefined }));
    setFormError(null);
    setNotice(null);
  };

  // Au retour du scanner (`/scan?pick=…`) : reprendre le code lu.
  useFocusEffect(
    useCallback(() => {
      const target = pickRef.current;
      if (!target) return;
      pickRef.current = null;
      const code = consumePendingPick(target);
      if (code === null) return;
      if (target === 'serial') {
        setSerial(code);
        setErrors((e) => ({ ...e, serial: undefined }));
      } else {
        setImei(code);
        setErrors((e) => ({ ...e, imei: undefined }));
      }
      setFormError(null);
      setNotice(null);
    }, [])
  );

  const openScanner = (target: PickTarget) => {
    if (submittingRef.current) return;
    // Un éventuel code resté en attente d'une sélection abandonnée est ignoré.
    consumePendingPick(target);
    pickRef.current = target;
    router.push({ pathname: '/scan', params: { pick: target } });
  };

  const submit = (addAnother: boolean) => {
    if (submittingRef.current) return;
    submittingRef.current = true;
    const assigneeValue = status === 'assigned' ? assignee : '';
    const res = editing
      ? updateUnit(unit.id, { serial, imei, status, assignee: assigneeValue, note })
      : addUnit(item.id, { serial, imei, status, assignee: assigneeValue, note });
    if (res.error !== undefined) {
      submittingRef.current = false;
      const field = res.field;
      setErrors(field !== undefined && field !== 'id' && field !== 'itemId' ? { [field]: res.error } : {});
      setFormError(res.error);
      setNotice(null);
      return;
    }
    if (addAnother) {
      // Prêt pour l'appareil suivant (statut et attributaire conservés).
      setNotice(`✓ Appareil ${res.unit.serial} ajouté. Saisissez ou scannez le suivant.`);
      setAddedCount((n) => n + 1);
      setSerial('');
      setImei('');
      setNote('');
      setErrors({});
      setFormError(null);
      submittingRef.current = false;
      return;
    }
    onDone();
  };

  const imeiInfo = imeiFeedback(imei);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }} edges={['bottom']}>
      <ScrollView
        contentContainerStyle={{ paddingHorizontal: 12, paddingTop: 8, paddingBottom: 32, gap: 16 }}
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
      >
        <Card style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <Thumb photo={item.photo} />
          <View style={{ flex: 1, gap: 4 }}>
            <Text style={{ fontSize: 15, fontWeight: '600', color: colors.text }}>{item.name}</Text>
            <Muted>{item.sku} · {item.folder}</Muted>
            <SerialBadge />
          </View>
        </Card>

        <Card style={{ gap: 14 }}>
          <TextField
            label="Numéro de série *"
            value={serial}
            onChangeText={(t) => { setSerial(t); clear('serial'); }}
            placeholder="Ex. R58W1A2B3C"
            autoCapitalize="characters"
            autoCorrect={false}
            error={errors.serial}
            hint="Identifiant unique de l'appareil (clé de l'import Jira Assets)."
            accessory={<ScanAccessory label="Scanner le numéro de série" onPress={() => openScanner('serial')} />}
          />
          <TextField
            label="IMEI"
            value={imei}
            onChangeText={(t) => { setImei(t); clear('imei'); }}
            placeholder="15 chiffres"
            keyboardType="number-pad"
            maxLength={20}
            autoCorrect={false}
            error={errors.imei}
            hint={imeiInfo.hint}
            hintColor={imeiInfo.color}
            accessory={<ScanAccessory label="Scanner l'IMEI" onPress={() => openScanner('imei')} />}
          />
        </Card>

        <Card style={{ gap: 12 }}>
          <Muted style={{ fontWeight: '600', fontSize: 12 }}>Statut</Muted>
          <View accessibilityRole="radiogroup" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {UNIT_STATUSES.map((s) => (
              <Chip
                key={s}
                label={UNIT_STATUS_LABELS[s]}
                active={s === status}
                accessibilityLabel={`Statut : ${UNIT_STATUS_LABELS[s]}`}
                onPress={() => { setStatus(s); clear('status'); clear('assignee'); }}
              />
            ))}
          </View>
          {errors.status && <InlineAlert message={errors.status} />}
          {editing && unit.status === 'in_stock' && status !== 'in_stock' && (
            <Muted style={{ fontSize: 12 }}>L'appareil sortira du stock : une sortie de 1 sera enregistrée.</Muted>
          )}
          {editing && unit.status !== 'in_stock' && status === 'in_stock' && (
            <Muted style={{ fontSize: 12 }}>L'appareil reviendra en stock : une entrée de 1 sera enregistrée.</Muted>
          )}
          {status === 'assigned' && (
            <TextField
              label="Attribué à *"
              value={assignee}
              onChangeText={(t) => { setAssignee(t); clear('assignee'); }}
              placeholder="Ex. Camille Martin"
              autoCapitalize="words"
              error={errors.assignee}
              hint="Personne à qui l'appareil est remis."
            />
          )}
          <TextField
            label="Note"
            value={note}
            onChangeText={(t) => { setNote(t); clear('note'); }}
            placeholder="Facultatif — ex. écran fissuré"
            multiline
            error={errors.note}
          />
        </Card>

        {notice && (
          <View accessibilityLiveRegion="polite" style={{ flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: colors.tint, borderRadius: 10, padding: 12 }}>
            <Icon name="check-circle" size={16} color={colors.primary} />
            <Text style={{ flex: 1, fontSize: 13, color: colors.primary, fontWeight: '600' }}>{notice}</Text>
          </View>
        )}
        {formError && <InlineAlert message={formError} />}

        <Btn title={editing ? 'Enregistrer les modifications' : "Ajouter l'appareil"} onPress={() => submit(false)} />
        {!editing && (
          <Btn
            title="Ajouter et saisir un autre"
            variant="outline"
            accessibilityHint="Enregistre l'appareil puis vide le formulaire pour le suivant"
            onPress={() => submit(true)}
          />
        )}
        <Btn
          title={addedCount > 0 ? 'Terminer' : 'Annuler'}
          variant="outline"
          accessibilityHint={addedCount > 0 ? `${addedCount} appareil(s) déjà enregistré(s) ; le formulaire en cours est abandonné` : undefined}
          onPress={onDone}
        />

        {children}
      </ScrollView>
    </SafeAreaView>
  );
}
