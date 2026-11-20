import { useCallback, useRef, useState } from 'react';
import { View, Text, Pressable, Alert } from 'react-native';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { Screen, H2, Card, Btn, Progress, Stepper, Thumb, Muted, Icon, Row, EmptyState, SerialBadge, Alert as InlineAlert } from '../../components/ui';
import { colors } from '../../constants/theme';
import {
  type CountEntry,
  type Item,
  type Unit,
  completeCount,
  consumePendingCountScan,
  findItemByCode,
  findUnitByCode,
  fmtCount,
  fmtDateTime,
  getCountDiscrepancies,
  getUnit,
  getUnits,
  markUnitFound,
  unmarkUnitFound,
  getCountItems,
  getCountSession,
  getCycleCount,
  restartCount,
  saveCountEntry,
  setCountIndex,
} from '../../data/store';
import { exportCountCsv } from '../../data/exportCount';

type Status = CountEntry['status'] | 'À compter';

export default function Count() {
  const { id: rawId } = useLocalSearchParams<{ id: string }>();
  const id = typeof rawId === 'string' ? rawId : '';
  const info = getCycleCount();
  const known = id === info.id;

  const [list, setList] = useState<Item[]>(() => getCountItems(id));
  const [counts, setCounts] = useState<Record<string, CountEntry>>(() => getCountSession(id)?.entries ?? {});
  const [idx, setIdx] = useState(() => Math.min(getCountSession(id)?.idx ?? 0, Math.max(0, list.length - 1)));
  const [qty, setQty] = useState(() => counts[list[idx]?.id ?? '']?.qty ?? 0);
  const [completedAt, setCompletedAt] = useState<number | undefined>(() => getCountSession(id)?.completedAt);
  const [error, setError] = useState<string | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [scanInfo, setScanInfo] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  // Index affiché, lu par le retour du scanner (qui a pu déplacer l'index enregistré).
  const idxRef = useRef(idx);
  idxRef.current = idx;

  const handleExport = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      await exportCountCsv(id);
    } finally {
      setExporting(false);
    }
  };

  const exportBtn = (
    <Btn
      title={exporting ? 'Export en cours…' : 'Exporter (CSV)'}
      variant="outline"
      accessibilityLabel="Exporter le comptage au format CSV"
      disabled={exporting}
      onPress={handleExport}
    />
  );

  const reload = () => {
    const session = getCountSession(id);
    const items = getCountItems(id);
    setList(items);
    setCounts(session?.entries ?? {});
    const i = Math.min(session?.idx ?? 0, Math.max(0, items.length - 1));
    setIdx(i);
    setQty(session?.entries[items[i]?.id ?? '']?.qty ?? 0);
    setCompletedAt(session?.completedAt);
    setError(null);
    setScanError(null);
    setScanInfo(null);
  };

  const jumpTo = (i: number, items: Item[] = list) => {
    const it = items[i];
    if (!it) return;
    setIdx(i);
    setCountIndex(id, i);
    setQty(counts[it.id]?.qty ?? 0);
    setError(null);
    setScanInfo(null);
  };

  // Au retour du scanner : rafraîchir les articles et les saisies (le scan
  // « Scanner les appareils » les a modifiées), puis traiter le code scanné :
  // numéro de série / IMEI → appareil trouvé ; code d'article → aller à l'article.
  useFocusEffect(
    useCallback(() => {
      const items = getCountItems(id);
      setList(items);
      const session = getCountSession(id);
      const entries = session?.entries ?? {};
      setCounts(entries);
      const goTo = (i: number, fresh: Record<string, CountEntry>) => {
        setIdx(i);
        setCountIndex(id, i);
        setQty(fresh[items[i]?.id ?? '']?.qty ?? 0);
        setError(null);
      };
      const code = consumePendingCountScan(id);
      if (!code) {
        // Index déplacé par le scan de plusieurs appareils.
        const saved = Math.min(session?.idx ?? 0, Math.max(0, items.length - 1));
        if (saved !== idxRef.current && items[saved]) {
          setIdx(saved);
          setQty(entries[items[saved].id]?.qty ?? 0);
          setError(null);
        }
        return;
      }
      setScanInfo(null);
      const unit = findUnitByCode(code);
      if (unit) {
        const res = markUnitFound(id, code);
        if (!res.ok) {
          setScanError(res.error);
          return;
        }
        const fresh = getCountSession(id)?.entries ?? {};
        setCounts(fresh);
        const i = items.findIndex((it) => it.id === res.itemId);
        if (i >= 0) goTo(i, fresh);
        setScanError(null);
        setScanInfo(res.duplicate ? `Déjà compté : ${unit.serial}` : `Appareil trouvé : ${unit.serial}`);
        return;
      }
      const found = findItemByCode(code);
      if (!found) {
        setScanError(`Code inconnu : ${code}`);
        return;
      }
      const i = items.findIndex((it) => it.id === found.id);
      if (i < 0) {
        setScanError(`Article hors comptage : ${found.name}`);
        return;
      }
      setScanError(null);
      goTo(i, entries);
    }, [id])
  );

  if (!known) {
    return (
      <Screen edges={['top', 'bottom']}>
        <Header title="Comptage" onClose={() => router.back()} />
        <EmptyState
          icon="alert-circle"
          title="Comptage introuvable"
          message="Ce comptage n'existe pas sur cet appareil."
          primaryAction={{ label: 'Retour', onPress: () => router.back(), accessibilityLabel: 'Retour à l\'écran précédent' }}
        />
      </Screen>
    );
  }

  // ── Inventaire vide : rien à compter ──────────────────────────────────────
  if (list.length === 0) {
    return (
      <Screen edges={['top', 'bottom']}>
        <Header title={info.name} onClose={() => router.back()} />
        <EmptyState
          icon="package"
          title="Aucun article à compter"
          message="Le comptage porte sur tous les articles de l'inventaire. Ajoutez un article pour commencer le comptage."
          primaryAction={{ label: 'Ajouter un article', onPress: () => router.push('/article/new'), accessibilityHint: 'Ouvre le formulaire de création d\'article' }}
          secondaryAction={{ label: 'Retour', onPress: () => router.back(), accessibilityLabel: 'Retour à l\'écran précédent' }}
        />
      </Screen>
    );
  }

  const doneCount = list.filter((i) => counts[i.id] !== undefined).length;
  const statusOf = (itemId: string): Status => counts[itemId]?.status ?? 'À compter';
  const countedN = list.filter((i) => statusOf(i.id) === 'Compté').length;
  const skippedN = list.filter((i) => statusOf(i.id) === 'Passé').length;

  // ── Comptage déjà terminé ──────────────────────────────────────────────────
  if (completedAt !== undefined) {
    const handleRestart = () => {
      Alert.alert(
        'Recommencer le comptage',
        'Les résultats de ce comptage seront effacés. Les ajustements de stock déjà appliqués sont conservés.',
        [
          { text: 'Annuler', style: 'cancel' },
          { text: 'Recommencer', style: 'destructive', onPress: () => { restartCount(id); reload(); } },
        ]
      );
    };
    return (
      <Screen edges={['top', 'bottom']}>
        <Header title={info.name} onClose={() => router.back()} />
        <Card style={{ gap: 12 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <Icon name="check-circle" color={colors.primary} />
            <Text style={{ fontSize: 16, fontWeight: '600', flex: 1 }}>Comptage terminé</Text>
          </View>
          <Muted>Terminé le {fmtDateTime(completedAt)}</Muted>
          <Muted>{countedN} article(s) compté(s) · {skippedN} passé(s) · {list.length - doneCount} non compté(s)</Muted>
          <Btn title="Recommencer" onPress={handleRestart} />
          {exportBtn}
          <Btn title="Fermer" variant="outline" onPress={() => router.back()} />
        </Card>
        <SerialDiscrepancies countId={id} items={list} />
      </Screen>
    );
  }

  const curIdx = Math.min(Math.max(0, idx), list.length - 1);
  const cur = list[curIdx];

  const curSerial = cur.serialized === true;
  const foundIds = counts[cur.id]?.serials ?? [];

  const next = (status: CountEntry['status']) => {
    if (!curSerial && status === 'Compté' && qty < 0) {
      setError('La quantité ne peut pas être négative.');
      return;
    }
    // Article suivi par numéro de série : les appareils trouvés (scannés) font foi.
    const entry: CountEntry = curSerial
      ? { qty: foundIds.length, status, serials: foundIds }
      : { qty: status === 'Compté' ? qty : 0, status };
    const err = saveCountEntry(id, cur.id, entry);
    if (err) { setError(err); return; }
    const nextCounts = getCountSession(id)?.entries ?? { ...counts, [cur.id]: entry };
    setCounts(nextCounts);
    setError(null);
    setScanError(null);
    setScanInfo(null);
    if (curIdx < list.length - 1) {
      const ni = curIdx + 1;
      setIdx(ni);
      setCountIndex(id, ni);
      setQty(nextCounts[list[ni].id]?.qty ?? 0);
    } else {
      setQty(nextCounts[cur.id]?.qty ?? entry.qty);
    }
  };

  const unmark = (unitId: string) => {
    const err = unmarkUnitFound(id, unitId);
    if (err) { setError(err); return; }
    setCounts(getCountSession(id)?.entries ?? {});
    setError(null);
    setScanInfo(null);
  };

  const finish = () => {
    const qtyDiffs = list.filter((i) => {
      const e = counts[i.id];
      return !i.serialized && e?.status === 'Compté' && e.qty !== i.qty;
    }).length;
    // Appareils : attendus = « En stock » maintenant (instantané pris à la clôture).
    const serialDiffs = getCountDiscrepancies(id).filter((d) => d.counted);
    const missingN = serialDiffs.reduce((n, d) => n + d.missing.length, 0);
    const unexpectedN = serialDiffs.reduce((n, d) => n + d.unexpected.length, 0);
    const diffs = qtyDiffs + serialDiffs.filter((d) => d.missing.length > 0 || d.unexpected.length > 0).length;
    const hasSerial = list.some((i) => i.serialized);

    const done = (apply: boolean) => {
      const res = completeCount(id, apply);
      if (!res.ok) { setError(res.error); return; }
      setCompletedAt(getCountSession(id)?.completedAt ?? Date.now());
      Alert.alert(
        'Comptage terminé',
        apply
          ? `${res.adjusted} ajustement(s) de stock appliqué(s).${res.unitsUpdated > 0 ? ` ${fmtCount(res.unitsUpdated, 'appareil mis à jour', 'appareils mis à jour')} (manquants ou remis en stock).` : ''}`
          : `Le stock n'a pas été modifié.${missingN + unexpectedN > 0 ? ' Les écarts d\'appareils restent consultables dans le comptage terminé et son export CSV.' : ''}`,
        [{ text: 'Fermer', onPress: () => router.back() }]
      );
    };

    const summary = `${countedN} compté(s) · ${skippedN} passé(s) · ${diffs} écart(s) avec le stock.`
      + (hasSerial
        ? `\nAppareils : ${fmtCount(missingN, 'manquant', 'manquants')} · ${fmtCount(unexpectedN, 'inattendu', 'inattendus')}.`
          + (missingN + unexpectedN > 0 ? '\nAppliquer les écarts : les appareils manquants passent « Manquant », les appareils inattendus reviennent « En stock ».' : '')
        : '');
    Alert.alert(
      'Terminer le comptage',
      summary,
      diffs > 0
        ? [
            { text: 'Annuler', style: 'cancel' },
            { text: 'Terminer sans ajuster', onPress: () => done(false) },
            { text: 'Appliquer les écarts au stock', onPress: () => done(true) },
          ]
        : [
            { text: 'Annuler', style: 'cancel' },
            { text: 'Terminer', onPress: () => done(false) },
          ]
    );
  };

  const handleFinish = () => {
    const remaining = list.length - doneCount;
    if (remaining > 0) {
      Alert.alert(
        'Comptage incomplet',
        `${remaining} article(s) n'ont pas encore été comptés. Terminer quand même ?`,
        [
          { text: 'Continuer le comptage', style: 'cancel' },
          { text: 'Terminer', style: 'destructive', onPress: finish },
        ]
      );
    } else {
      finish();
    }
  };

  const isLast = curIdx === list.length - 1;
  const allDone = doneCount === list.length;
  const curStatus = statusOf(cur.id);

  return (
    <Screen edges={['top', 'bottom']}>
      <Header title={info.name} onClose={() => router.back()} closeLabel="Quitter (progression enregistrée)" />

      {/* Progress */}
      <View>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 }}>
          <Text style={{ fontSize: 13 }}>Progression</Text>
          <Text style={{ fontSize: 13, fontWeight: '700' }}>{doneCount} / {list.length}</Text>
        </View>
        <Progress value={doneCount / list.length} />
      </View>

      {scanError && <InlineAlert message={scanError} />}
      {scanInfo && (
        <View accessibilityLiveRegion="polite" style={{ flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: colors.tint, borderRadius: 10, padding: 12 }}>
          <Icon name="check-circle" size={16} color={colors.primary} />
          <Text style={{ flex: 1, fontSize: 13, fontWeight: '600', color: colors.primary }}>{scanInfo}</Text>
        </View>
      )}

      {/* Current item card */}
      <Card style={{ gap: 14 }}>
        {/* Item info */}
        <View style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}>
          <Thumb size={72} photo={cur.photo} />
          <View style={{ flex: 1 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 2 }}>
              <Text style={{ fontSize: 13, color: colors.muted, fontWeight: '600' }}>{curIdx + 1} / {list.length}</Text>
              {curStatus !== 'À compter' && (
                <View style={{ paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999, backgroundColor: curStatus === 'Compté' ? colors.tint : colors.border }}>
                  <Text style={{ fontSize: 11, fontWeight: '700', color: curStatus === 'Compté' ? colors.primary : colors.muted }}>
                    {curStatus}
                  </Text>
                </View>
              )}
            </View>
            <Text style={{ fontSize: 18, fontWeight: '600' }}>{cur.name}</Text>
            <Muted>{cur.sku} · {cur.folder}</Muted>
            {curSerial && <SerialBadge style={{ marginTop: 4 }} />}
          </View>
        </View>

        {curSerial ? (
          <SerialCountPanel
            itemId={cur.id}
            foundIds={foundIds}
            blind={info.blind}
            onUnmark={unmark}
            onScan={() => { setScanError(null); setScanInfo(null); router.push({ pathname: '/scan', params: { countId: id, multi: '1' } }); }}
          />
        ) : (
        <>
        {info.blind && <Muted>Quantité attendue masquée (comptage à l'aveugle)</Muted>}

        <View>
          <Muted style={{ fontWeight: '600', fontSize: 12, marginBottom: 6 }}>Quantité comptée</Muted>
          <Stepper
            value={qty}
            onChange={(n) => { setQty(n); setError(null); }}
            big
          />
          {qty === 0 && (
            <Muted style={{ marginTop: 6, textAlign: 'center' }}>
              Quantité à 0 — utilisez « Passer » si l'article est absent.
            </Muted>
          )}
        </View>
        </>
        )}

        {error && <InlineAlert message={error} />}

        <Btn
          title={isLast && !allDone ? 'Valider' : 'Valider et suivant'}
          variant={curSerial ? 'outline' : 'primary'}
          accessibilityHint={curSerial ? `Enregistre ${fmtCount(foundIds.length, 'appareil trouvé', 'appareils trouvés')} pour cet article` : undefined}
          onPress={() => next('Compté')}
        />

        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Btn
            title="Scanner"
            variant="outline"
            style={{ flex: 1 }}
            onPress={() => { setScanError(null); router.push({ pathname: '/scan', params: { countId: id } }); }}
          />
          <Btn title="Passer" variant="outline" style={{ flex: 1 }} onPress={() => next('Passé')} />
        </View>
      </Card>

      {/* Item list */}
      <H2>Articles du comptage</H2>
      <Card style={{ padding: 0, overflow: 'hidden' }}>
        {list.map((it, i) => {
          const s = statusOf(it.id);
          return (
            <Row key={it.id} onPress={() => jumpTo(i)}>
              <Thumb size={40} photo={it.photo} />
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={{ fontSize: 14, fontWeight: i === curIdx ? '700' : '600' }}>{it.name}</Text>
                {it.serialized && <SerialBadge />}
              </View>
              <Text style={{
                fontSize: 12,
                fontWeight: '600',
                color: s === 'Compté' ? colors.primary : s === 'Passé' ? colors.warnText : colors.muted,
              }}>
                {s}
              </Text>
            </Row>
          );
        })}
      </Card>

      <Btn
        title={allDone ? 'Terminer le comptage' : `Terminer (${list.length - doneCount} restants)`}
        variant="outline"
        onPress={handleFinish}
      />
      {exportBtn}
    </Screen>
  );
}

function Header({ title, onClose, closeLabel = 'Fermer' }: { title: string; onClose: () => void; closeLabel?: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={closeLabel}
        onPress={onClose}
        style={{ width: 44, height: 44, justifyContent: 'center' }}
      >
        <Icon name="x" />
      </Pressable>
      <Text style={{ fontSize: 16, fontWeight: '600', flex: 1, textAlign: 'center' }} numberOfLines={1}>{title}</Text>
      <View style={{ width: 44 }} />
    </View>
  );
}

/** Carte de l'article courant suivi par numéro de série : appareils attendus / trouvés. */
function SerialCountPanel({
  itemId,
  foundIds,
  blind,
  onUnmark,
  onScan,
}: {
  itemId: string;
  foundIds: string[];
  blind: boolean;
  onUnmark: (unitId: string) => void;
  onScan: () => void;
}) {
  const found = foundIds.map((x) => getUnit(x)).filter((u): u is Unit => u !== undefined);
  const foundSet = new Set(found.map((u) => u.id));
  const expected = getUnits(itemId).filter((u) => u.status === 'in_stock');
  const expectedSet = new Set(expected.map((u) => u.id));
  const unexpected = found.filter((u) => !expectedSet.has(u.id));

  const unitLine = (u: Unit, ticked: boolean, removable: boolean, tag?: string) => (
    <View key={u.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44, borderTopWidth: 1, borderTopColor: colors.line }}>
      <Icon name={ticked ? 'check-square' : 'square'} size={18} color={ticked ? colors.primary : colors.muted} />
      <View
        style={{ flex: 1 }}
        accessible
        accessibilityLabel={`${u.serial}, ${ticked ? 'trouvé' : 'non trouvé'}${tag ? `, ${tag}` : ''}`}
      >
        <Text style={{ fontSize: 14, fontWeight: '600', color: colors.text }}>{u.serial}</Text>
        {u.imei !== undefined && <Muted style={{ fontSize: 12 }}>IMEI {u.imei}{u.imei2 !== undefined ? ` · IMEI 2 ${u.imei2}` : ''}</Muted>}
      </View>
      {tag && (
        <View style={{ paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999, backgroundColor: colors.warnBg }}>
          <Text style={{ fontSize: 11, fontWeight: '700', color: colors.warnText }}>{tag}</Text>
        </View>
      )}
      {removable && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Retirer ${u.serial} des appareils trouvés`}
          onPress={() => onUnmark(u.id)}
          style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}
        >
          <Icon name="x-circle" size={18} color={colors.muted} />
        </Pressable>
      )}
    </View>
  );

  return (
    <View style={{ gap: 10 }}>
      <View>
        <Muted style={{ fontWeight: '600', fontSize: 12 }}>Appareils trouvés</Muted>
        <Text style={{ fontSize: 34, fontWeight: '700', color: colors.text }}>
          {found.length}{blind ? '' : ` / ${expected.length}`}
        </Text>
        <Muted>
          {blind
            ? "Liste des appareils attendus masquée (comptage à l'aveugle) : les écarts s'affichent à la fin du comptage."
            : `${fmtCount(expected.length, 'appareil attendu', 'appareils attendus')} (« En stock »).`}
        </Muted>
      </View>

      {blind ? (
        found.length > 0 && (
          <View>
            {found.map((u) => unitLine(u, true, true))}
          </View>
        )
      ) : (
        <View>
          {expected.map((u) => unitLine(u, foundSet.has(u.id), foundSet.has(u.id)))}
          {unexpected.map((u) => unitLine(u, true, true, `Inattendu · ${UNIT_STATUS_LABEL_SHORT[u.status]}`))}
          {expected.length === 0 && unexpected.length === 0 && <Muted>Aucun appareil « En stock » attendu pour cet article.</Muted>}
        </View>
      )}

      <Btn
        title="Scanner les appareils"
        accessibilityHint="Ouvre le scanner : chaque numéro de série lu est marqué trouvé"
        onPress={onScan}
      />
      {found.length === 0 && (
        <Muted style={{ textAlign: 'center' }}>
          Aucun appareil trouvé — « Valider » enregistre 0 appareil ; utilisez « Passer » si l'article n'est pas compté.
        </Muted>
      )}
    </View>
  );
}

/** Libellés courts de statut pour la pastille « Inattendu ». */
const UNIT_STATUS_LABEL_SHORT: Record<Unit['status'], string> = {
  in_stock: 'en stock',
  assigned: 'attribué',
  repair: 'en réparation',
  retired: 'retiré',
  missing: 'manquant',
};

/** Comptage terminé : écarts des articles suivis par numéro de série. */
function SerialDiscrepancies({ countId, items }: { countId: string; items: Item[] }) {
  const disc = getCountDiscrepancies(countId);
  if (disc.length === 0) return null;
  const names = new Map(items.map((i) => [i.id, i.name]));
  const MAX = 20;
  const unitLinks = (units: Unit[], color: string) => (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
      {units.slice(0, MAX).map((u) => (
        <Pressable
          key={u.id}
          accessibilityRole="button"
          accessibilityLabel={`Appareil ${u.serial}`}
          accessibilityHint="Ouvre la fiche de l'appareil"
          onPress={() => router.push(`/unit/${u.id}`)}
          style={{ minHeight: 32, justifyContent: 'center', paddingHorizontal: 10, borderRadius: 999, borderWidth: 1, borderColor: colors.field, backgroundColor: '#fff' }}
        >
          <Text style={{ fontSize: 12, fontWeight: '600', color }}>{u.serial}</Text>
        </Pressable>
      ))}
      {units.length > MAX && <Muted style={{ alignSelf: 'center' }}>+{units.length - MAX} autre(s)</Muted>}
    </View>
  );
  return (
    <>
      <H2>Appareils (numéros de série)</H2>
      <Card style={{ padding: 0, overflow: 'hidden' }}>
        {disc.map((d, i) => {
          const ok = d.counted && d.missing.length === 0 && d.unexpected.length === 0;
          return (
            <View key={d.itemId} style={{ padding: 14, gap: 8, borderTopWidth: i === 0 ? 0 : 1, borderTopColor: colors.line }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Text style={{ flex: 1, fontSize: 15, fontWeight: '600', color: colors.text }}>{names.get(d.itemId) ?? d.itemId}</Text>
                {!d.counted ? (
                  <View style={{ paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999, backgroundColor: colors.line }}>
                    <Text style={{ fontSize: 11, fontWeight: '700', color: colors.muted }}>Non compté</Text>
                  </View>
                ) : ok ? (
                  <Icon name="check-circle" size={18} color={colors.primary} />
                ) : (
                  <Icon name="alert-triangle" size={18} color={colors.warnText} />
                )}
              </View>
              <Muted>
                {d.counted
                  ? `${fmtCount(d.found.length, 'trouvé', 'trouvés')} / ${fmtCount(d.expected.length, 'attendu', 'attendus')}${ok ? ' · aucun écart' : ''}`
                  : `Non compté · ${fmtCount(d.expected.length, 'appareil attendu', 'appareils attendus')}`}
              </Muted>
              {d.missing.length > 0 && (
                <>
                  <Text style={{ fontSize: 13, fontWeight: '600', color: '#B91C1C' }}>{fmtCount(d.missing.length, 'manquant', 'manquants')}</Text>
                  {unitLinks(d.missing, '#B91C1C')}
                </>
              )}
              {d.unexpected.length > 0 && (
                <>
                  <Text style={{ fontSize: 13, fontWeight: '600', color: colors.warnText }}>{fmtCount(d.unexpected.length, 'inattendu', 'inattendus')} (pas « En stock » à la clôture)</Text>
                  {unitLinks(d.unexpected, colors.warnText)}
                </>
              )}
            </View>
          );
        })}
      </Card>
    </>
  );
}
