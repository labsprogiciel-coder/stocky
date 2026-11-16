import { useCallback, useState } from 'react';
import { View, Text, Pressable, Alert } from 'react-native';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { Screen, H2, Card, Btn, Progress, Stepper, Thumb, Muted, Icon, Row, EmptyState, Alert as InlineAlert } from '../../components/ui';
import { colors } from '../../constants/theme';
import {
  type CountEntry,
  type Item,
  completeCount,
  consumePendingCountScan,
  findItemByCode,
  fmtDateTime,
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
  const [exporting, setExporting] = useState(false);

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
  };

  const jumpTo = (i: number, items: Item[] = list) => {
    const it = items[i];
    if (!it) return;
    setIdx(i);
    setCountIndex(id, i);
    setQty(counts[it.id]?.qty ?? 0);
    setError(null);
  };

  // Au retour du scanner : rafraîchir les articles et traiter le code scanné.
  useFocusEffect(
    useCallback(() => {
      const items = getCountItems(id);
      setList(items);
      const code = consumePendingCountScan(id);
      if (!code) return;
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
      setIdx(i);
      setCountIndex(id, i);
      const entries = getCountSession(id)?.entries ?? {};
      setQty(entries[found.id]?.qty ?? 0);
      setError(null);
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
      </Screen>
    );
  }

  const curIdx = Math.min(Math.max(0, idx), list.length - 1);
  const cur = list[curIdx];

  const next = (status: CountEntry['status']) => {
    if (status === 'Compté' && qty < 0) {
      setError('La quantité ne peut pas être négative.');
      return;
    }
    const entry: CountEntry = { qty: status === 'Compté' ? qty : 0, status };
    const err = saveCountEntry(id, cur.id, entry);
    if (err) { setError(err); return; }
    const nextCounts = { ...counts, [cur.id]: entry };
    setCounts(nextCounts);
    setError(null);
    setScanError(null);
    if (curIdx < list.length - 1) {
      const ni = curIdx + 1;
      setIdx(ni);
      setCountIndex(id, ni);
      setQty(nextCounts[list[ni].id]?.qty ?? 0);
    } else {
      setQty(entry.qty);
    }
  };

  const finish = () => {
    const diffs = list.filter((i) => {
      const e = counts[i.id];
      return e?.status === 'Compté' && e.qty !== i.qty;
    }).length;

    const done = (apply: boolean) => {
      const res = completeCount(id, apply);
      if (!res.ok) { setError(res.error); return; }
      setCompletedAt(getCountSession(id)?.completedAt ?? Date.now());
      Alert.alert(
        'Comptage terminé',
        apply
          ? `${res.adjusted} ajustement(s) de stock appliqué(s).`
          : 'Le stock n\'a pas été modifié.',
        [{ text: 'Fermer', onPress: () => router.back() }]
      );
    };

    const summary = `${countedN} compté(s) · ${skippedN} passé(s) · ${diffs} écart(s) avec le stock.`;
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
          </View>
        </View>

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

        {error && <InlineAlert message={error} />}

        <Btn
          title={isLast && !allDone ? 'Valider' : 'Valider et suivant'}
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
              <Text style={{ flex: 1, fontSize: 14, fontWeight: i === curIdx ? '700' : '600' }}>{it.name}</Text>
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
