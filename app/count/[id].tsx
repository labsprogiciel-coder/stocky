import { useState } from 'react';
import { View, Text, Pressable, Alert } from 'react-native';
import { router } from 'expo-router';
import { Screen, H2, Card, Btn, Progress, Stepper, Thumb, Muted, Icon, Row, Alert as InlineAlert } from '../../components/ui';
import { colors } from '../../constants/theme';
import { getItems } from '../../data/store';
import { cycleCount } from '../../data/mock';

type Status = 'Compté' | 'Passé' | 'À compter';
type CountEntry = { qty: number; status: Status };

export default function Count() {
  const allItems = getItems();
  const list = allItems.slice(0, cycleCount.total);

  const [counts, setCounts] = useState<Record<string, CountEntry>>({});
  const [idx, setIdx] = useState(Math.min(cycleCount.done, list.length - 1));
  const [qty, setQty] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const cur = list[idx];
  const doneCount = Object.keys(counts).length;
  const statusOf = (id: string): Status => counts[id]?.status ?? 'À compter';

  // ── Validation ─────────────────────────────────────────────────────────────
  // "Valider et suivant" requires the user to have intentionally set a qty
  // (even 0 is acceptable only if they tap the minus from 1, so we just check
  //  that the user hasn't left it at 0 when counting — they should use "Passer"
  //  to skip deliberately).
  const validateCount = (): string | null => {
    if (qty < 0) return 'La quantité ne peut pas être négative.';
    // qty === 0 is technically valid (item really has 0 in stock),
    // but we surface a soft warning so the user thinks twice.
    return null;
  };

  const next = (status: Status) => {
    if (status === 'Compté') {
      const err = validateCount();
      if (err) { setError(err); return; }
    }
    setCounts((c) => ({ ...c, [cur.id]: { qty: status === 'Compté' ? qty : 0, status } }));
    setQty(0);
    setError(null);
    if (idx < list.length - 1) {
      setIdx(idx + 1);
    }
  };

  const handleJump = (item: typeof list[0]) => {
    setIdx(list.indexOf(item));
    setQty(counts[item.id]?.qty ?? 0);
    setError(null);
  };

  const handleFinish = () => {
    const remaining = list.filter((i) => statusOf(i.id) === 'À compter').length;
    if (remaining > 0) {
      Alert.alert(
        'Comptage incomplet',
        `${remaining} article(s) n'ont pas encore été comptés. Terminer quand même ?`,
        [
          { text: 'Continuer le comptage', style: 'cancel' },
          { text: 'Terminer', style: 'destructive', onPress: () => router.back() },
        ]
      );
    } else {
      const counted = list.filter((i) => statusOf(i.id) === 'Compté').length;
      const skipped = list.filter((i) => statusOf(i.id) === 'Passé').length;
      Alert.alert(
        'Comptage terminé',
        `${counted} article(s) comptés · ${skipped} passé(s).`,
        [{ text: 'Fermer', onPress: () => router.back() }]
      );
    }
  };

  const isLast = idx === list.length - 1;
  const allDone = doneCount === list.length;

  return (
    <Screen edges={['top', 'bottom']}>
      {/* Header */}
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Quitter le comptage"
          onPress={handleFinish}
          style={{ width: 44, height: 44, justifyContent: 'center' }}
        >
          <Icon name="x" />
        </Pressable>
        <Text style={{ fontSize: 16, fontWeight: '600' }}>{cycleCount.name}</Text>
        <View style={{ width: 44 }} />
      </View>

      {/* Progress */}
      <View>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 }}>
          <Text style={{ fontSize: 13 }}>Progression</Text>
          <Text style={{ fontSize: 13, fontWeight: '700' }}>{doneCount} / {list.length}</Text>
        </View>
        <Progress value={doneCount / list.length} />
      </View>

      {/* Current item card */}
      <Card style={{ gap: 14 }}>
        {/* Item info */}
        <View style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}>
          <Thumb size={72} />
          <View style={{ flex: 1 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 2 }}>
              <Text style={{ fontSize: 13, color: colors.muted, fontWeight: '600' }}>{idx + 1} / {list.length}</Text>
              {statusOf(cur.id) !== 'À compter' && (
                <View style={{ paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999, backgroundColor: statusOf(cur.id) === 'Compté' ? colors.tint : colors.border }}>
                  <Text style={{ fontSize: 11, fontWeight: '700', color: statusOf(cur.id) === 'Compté' ? colors.primary : colors.muted }}>
                    {statusOf(cur.id)}
                  </Text>
                </View>
              )}
            </View>
            <Text style={{ fontSize: 18, fontWeight: '600' }}>{cur.name}</Text>
            <Muted>{cur.sku} · {cur.folder}</Muted>
          </View>
        </View>

        {cycleCount.blind && <Muted>Quantité attendue masquée (comptage à l'aveugle)</Muted>}

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
          <Btn title="Scanner" variant="outline" style={{ flex: 1 }} onPress={() => router.push('/scan')} />
          <Btn title="Passer" variant="outline" style={{ flex: 1 }} onPress={() => next('Passé')} />
        </View>
      </Card>

      {/* Item list */}
      <H2>Articles du comptage</H2>
      <Card style={{ padding: 0, overflow: 'hidden' }}>
        {list.map((it) => {
          const s = statusOf(it.id);
          return (
            <Row key={it.id} onPress={() => handleJump(it)}>
              <Thumb size={40} />
              <Text style={{ flex: 1, fontSize: 14, fontWeight: '600' }}>{it.name}</Text>
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
    </Screen>
  );
}
