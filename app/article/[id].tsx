import { useState, useCallback, useMemo } from 'react';
import { View, Text, Alert, TextInput, Pressable } from 'react-native';
import { router, useLocalSearchParams, Stack, useFocusEffect } from 'expo-router';
import { Screen, Card, Btn, Stepper, Muted, Icon, EmptyState, ItemPhoto, Row, SerialBadge, UnitStatusChip, H2, Alert as InlineAlert } from '../../components/ui';
import { colors } from '../../constants/theme';
import { getItem, getUnits, adjustStock, deleteItem, fmtCount, serialKey, UNIT_STATUSES, UNIT_STATUS_LABELS, type Unit, type UnitStatus } from '../../data/store';
import { exportAssetsCsv } from '../../data/exportCount';

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
  // Appareils (article suivi par numéro de série).
  const [units, setUnits] = useState<Unit[]>(() => getUnits(id ?? ''));
  const [q, setQ] = useState('');
  const [statusFilter, setStatusFilter] = useState<UnitStatus | null>(null);
  const [exporting, setExporting] = useState(false);

  const visibleUnits = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const key = serialKey(q);
    const digits = q.replace(/[\s-]+/g, '');
    return units.filter((u) =>
      (statusFilter === null || u.status === statusFilter) &&
      (!needle ||
        serialKey(u.serial).includes(key) ||
        (digits.length > 0 && u.imei !== undefined && u.imei.includes(digits)) ||
        (u.assignee ?? '').toLowerCase().includes(needle) ||
        (u.note ?? '').toLowerCase().includes(needle))
    );
  }, [units, q, statusFilter]);

  // Re-read from store when navigating back to this screen (e.g. after scan)
  useFocusEffect(
    useCallback(() => {
      const fresh = getItem(id ?? '');
      setUnits(getUnits(id ?? ''));
      if (fresh) {
        setItem(fresh);
        setQty(fresh.qty);
        setError(null);
        setSaved(false);
      } else {
        // Article disparu entre-temps (ex. données réinitialisées).
        setItem(null);
      }
    }, [id])
  );

  if (!item) {
    return (
      <>
        <Stack.Screen options={{ title: 'Article introuvable' }} />
        <Screen hasHeader>
          <EmptyState
            icon="search"
            title="Article introuvable"
            message="Cet article n'existe pas ou n'est plus enregistré sur cet appareil."
            primaryAction={{ label: 'Retour aux articles', onPress: () => router.dismissTo('/articles'), accessibilityHint: 'Affiche la liste des articles' }}
          />
        </Screen>
      </>
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

  const handleExport = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      await exportAssetsCsv(item.id);
    } finally {
      setExporting(false);
    }
  };

  const handleDelete = () => {
    Alert.alert(
      "Supprimer l'article",
      `« ${item.name} » sera supprimé de cet appareil, ainsi que ${item.photo ? 'sa photo, ' : ''}${units.length > 0 ? `ses ${fmtCount(units.length, 'numéro de série', 'numéros de série')}, ` : ''}tous ses mouvements de stock et ses saisies dans les comptages (y compris les comptages terminés et leur export CSV). Cette action est irréversible.`,
      [
        { text: 'Annuler', style: 'cancel' },
        {
          text: 'Supprimer',
          style: 'destructive',
          onPress: () => {
            const res = deleteItem(item.id);
            if (!res.ok) {
              setError(res.error);
              return;
            }
            router.dismissTo('/articles');
          },
        },
      ]
    );
  };

  const diff = qty - item.qty;
  const diffLabel =
    diff === 0 ? null : diff > 0 ? `+${diff} Entrée` : `${diff} Sortie`;

  return (
    <>
      <Stack.Screen options={{ title: item.name }} />
      <Screen hasHeader>
        {/* Photo */}
        <ItemPhoto
          photo={item.photo}
          accessibilityLabel={`Photo de ${item.name}`}
          emptyLabel="Aucune photo — ajoutez-en une avec « Modifier »"
        />

        {item.serialized ? (
          <UnitsSection
            itemId={item.id}
            qty={item.qty}
            min={item.min}
            units={units}
            visibleUnits={visibleUnits}
            q={q}
            onChangeQ={setQ}
            statusFilter={statusFilter}
            onChangeStatusFilter={setStatusFilter}
            exporting={exporting}
            onExport={handleExport}
          />
        ) : (
          <>
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
          </>
        )}

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
          <Text selectable style={{ fontFamily: 'Courier', letterSpacing: 3 }}>{item.barcode ?? item.sku}</Text>
          {!item.barcode && <Muted>Aucun code-barres enregistré — le SKU est utilisé.</Muted>}
          <Btn title="Imprimer l'étiquette" variant="outline" style={{ alignSelf: 'stretch' }} />
        </Card>

        {/* Inline errors */}
        {qtyError && <InlineAlert message={qtyError} />}
        {error && <InlineAlert message={error} />}

        {/* CTA */}
        {!item.serialized && (
          <Btn
            title={saved ? '✓ Stock enregistré' : 'Ajuster le stock'}
            onPress={handleAdjust}
            disabled={!canSave}
          />
        )}

        <View style={{ gap: 8, marginTop: 8 }}>
          <Btn
            title="Modifier"
            variant="outline"
            accessibilityLabel="Modifier l'article"
            accessibilityHint="Modifier le nom, les codes, le dossier, le suivi par numéro de série, le seuil, le prix et la photo"
            onPress={() => router.push(`/article/edit/${item.id}`)}
          />
          <Btn
            title="Supprimer l'article"
            variant="danger"
            accessibilityHint="Demande une confirmation avant de supprimer l'article et son historique"
            onPress={handleDelete}
          />
        </View>
      </Screen>
    </>
  );
}

/** Nombre maximal d'appareils affichés dans la liste (affiner avec la recherche). */
const MAX_VISIBLE_UNITS = 100;

function UnitsSection({
  itemId,
  qty,
  min,
  units,
  visibleUnits,
  q,
  onChangeQ,
  statusFilter,
  onChangeStatusFilter,
  exporting,
  onExport,
}: {
  itemId: string;
  qty: number;
  min: number;
  units: Unit[];
  visibleUnits: Unit[];
  q: string;
  onChangeQ: (q: string) => void;
  statusFilter: UnitStatus | null;
  onChangeStatusFilter: (s: UnitStatus | null) => void;
  exporting: boolean;
  onExport: () => void;
}) {
  const addUnit = () => router.push({ pathname: '/unit/new', params: { itemId } });
  const scan = () => router.push({ pathname: '/scan', params: { addItemId: itemId } });
  const countsByStatus = UNIT_STATUSES.map((s) => ({ s, n: units.filter((u) => u.status === s).length })).filter((c) => c.n > 0);
  const shown = visibleUnits.slice(0, MAX_VISIBLE_UNITS);

  return (
    <>
      <Card style={{ gap: 12 }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <Muted>Stock actuel</Muted>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <SerialBadge />
            {qty <= min && (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: colors.warnBg, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999 }}>
                <Icon name="alert-triangle" size={12} color={colors.warnText} />
                <Text style={{ fontSize: 11, fontWeight: '700', color: colors.warnText }}>Sous seuil</Text>
              </View>
            )}
          </View>
        </View>
        <Text accessibilityRole="header" style={{ fontSize: 30, fontWeight: '700', color: colors.text }}>
          {qty} en stock
        </Text>
        <Muted>
          {fmtCount(units.length, 'appareil enregistré', 'appareils enregistrés')} · Seuil minimum : {min}
        </Muted>
        {countsByStatus.length > 0 && (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            {countsByStatus.map(({ s, n }) => <UnitStatusChip key={s} status={s} count={n} />)}
          </View>
        )}
        <Muted style={{ fontSize: 12 }}>
          Le stock est calculé à partir des appareils « En stock ». Pour une sortie, scannez le numéro de série de
          l'appareil, ou ouvrez-le ci-dessous pour changer son statut.
        </Muted>
        <Btn title="Ajouter un appareil" accessibilityHint="Ouvre le formulaire d'ajout d'un numéro de série" onPress={addUnit} />
        <Btn title="Scanner des appareils" variant="outline" accessibilityHint="Ouvre le scanner pour ajouter des appareils à la suite" onPress={scan} />
      </Card>

      <H2>Appareils</H2>
      {units.length === 0 ? (
        <EmptyState
          icon="smartphone"
          title="Aucun appareil"
          message="Cet article est suivi par numéro de série. Ajoutez chaque appareil avec son numéro de série (et son IMEI pour un téléphone)."
          primaryAction={{ label: 'Ajouter un appareil', onPress: addUnit, accessibilityHint: "Ouvre le formulaire d'ajout d'un numéro de série" }}
          secondaryAction={{ label: 'Scanner', onPress: scan, accessibilityLabel: 'Scanner des numéros de série', accessibilityHint: 'Ouvre le scanner pour ajouter des appareils à la suite' }}
        />
      ) : (
        <>
          <TextInput
            value={q}
            onChangeText={onChangeQ}
            placeholder="N° de série, IMEI, attributaire…"
            accessibilityLabel="Rechercher un appareil"
            placeholderTextColor={colors.muted}
            autoCapitalize="none"
            autoCorrect={false}
            style={{ height: 48, paddingHorizontal: 14, borderWidth: 1, borderColor: colors.field, borderRadius: 10, backgroundColor: '#fff', fontSize: 15, color: colors.text }}
          />
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            <FilterChip label="Tous" active={statusFilter === null} onPress={() => onChangeStatusFilter(null)} />
            {countsByStatus.map(({ s }) => (
              <FilterChip key={s} label={UNIT_STATUS_LABELS[s]} active={statusFilter === s} onPress={() => onChangeStatusFilter(statusFilter === s ? null : s)} />
            ))}
          </View>
          {shown.length === 0 ? (
            <Card>
              <Muted>Aucun appareil ne correspond à cette recherche.</Muted>
            </Card>
          ) : (
            <Card style={{ padding: 0, overflow: 'hidden' }}>
              {shown.map((u) => (
                <Row
                  key={u.id}
                  onPress={() => router.push(`/unit/${u.id}`)}
                  accessibilityLabel={`Numéro de série ${u.serial}${u.imei ? `, IMEI ${u.imei}` : ''}, ${UNIT_STATUS_LABELS[u.status]}${u.assignee ? `, attribué à ${u.assignee}` : ''}`}
                  accessibilityHint="Ouvre la fiche de l'appareil"
                >
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={{ fontSize: 15, fontWeight: '600', color: colors.text }}>{u.serial}</Text>
                    {u.imei !== undefined && <Muted>IMEI {u.imei}</Muted>}
                    {u.assignee !== undefined && <Muted>Attribué à {u.assignee}</Muted>}
                    <UnitStatusChip status={u.status} />
                  </View>
                  <Icon name="chevron-right" size={18} color={colors.muted} />
                </Row>
              ))}
            </Card>
          )}
          {visibleUnits.length > shown.length && (
            <Muted style={{ textAlign: 'center' }}>
              {shown.length} appareils affichés sur {visibleUnits.length} — affinez la recherche.
            </Muted>
          )}
          <Btn
            title={exporting ? 'Export en cours…' : 'Exporter ces appareils (CSV Jira Assets)'}
            variant="outline"
            accessibilityLabel="Exporter les appareils de cet article au format CSV pour Jira Assets"
            disabled={exporting}
            onPress={onExport}
          />
        </>
      )}
    </>
  );
}

function FilterChip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Filtrer : ${label}`}
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={{ minHeight: 36, paddingHorizontal: 12, borderRadius: 999, justifyContent: 'center', backgroundColor: active ? colors.primary : '#fff', borderWidth: active ? 0 : 1, borderColor: colors.field }}
    >
      <Text style={{ fontSize: 13, fontWeight: '600', color: active ? '#fff' : colors.muted }}>{label}</Text>
    </Pressable>
  );
}
