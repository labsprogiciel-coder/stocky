import { useCallback, useState } from 'react';
import { View, Text, Pressable } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { Screen, H1, H2, Card, Btn, Progress, Row, Thumb, Muted, Icon } from '../../components/ui';
import { colors } from '../../constants/theme';
import { getItems, getMovements, getCycleCount, fmtTime, fmtDateTime } from '../../data/store';
import { isPersistent } from '../../data/storage';

const actions = [
  { icon: 'maximize', label: 'Scanner', primary: true, go: () => router.push('/scan') },
  { icon: 'arrow-down-circle', label: 'Entrée', go: () => router.push('/scan') },
  { icon: 'arrow-up-circle', label: 'Sortie', go: () => router.push('/scan') },
  { icon: 'search', label: 'Chercher', go: () => router.push('/articles') },
] as const;

export default function Home() {
  const [items, setItems] = useState(() => getItems());
  const [movements, setMovements] = useState(() => getMovements());
  const [count, setCount] = useState(() => getCycleCount());
  const persistent = isPersistent();

  // Refresh live data whenever this tab becomes active
  useFocusEffect(
    useCallback(() => {
      setItems(getItems());
      setMovements(getMovements());
      setCount(getCycleCount());
    }, [])
  );

  const lowCount = items.filter((i) => i.qty <= i.min).length;
  const recentMovements = movements.slice(0, 5);
  const countLabel = count.completedAt !== undefined
    ? 'Voir le comptage'
    : count.done > 0 ? 'Reprendre le comptage' : 'Commencer le comptage';
  return (
    <Screen>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <H1>Aujourd'hui</H1>
        <View
          accessible
          accessibilityLabel={persistent ? 'Hors ligne, données stockées sur l\'appareil' : 'Stockage temporaire, les données seront perdues à la fermeture'}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 999, flexShrink: 1, backgroundColor: persistent ? '#fff' : colors.warnBg, borderWidth: 1, borderColor: persistent ? colors.field : colors.warnBg }}
        >
          {persistent
            ? <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: colors.primary }} />
            : <Icon name="alert-triangle" size={12} color={colors.warnText} />}
          <Text numberOfLines={1} style={{ fontSize: 12, fontWeight: '600', flexShrink: 1, color: persistent ? colors.text : colors.warnText }}>
            {persistent ? 'Hors ligne · sur l\'appareil' : 'Stockage temporaire'}
          </Text>
        </View>
      </View>

      <Card style={{ borderColor: colors.primary, borderWidth: 2, gap: 12 }}>
        <Text style={{ fontSize: 12, fontWeight: '700', color: colors.primary }}>COMPTAGE CYCLIQUE · AUJOURD'HUI</Text>
        <Text style={{ fontSize: 16, fontWeight: '600' }}>{count.name}</Text>
        <Muted>
          {count.folder} · {count.total} articles
          {count.completedAt !== undefined ? ` · Terminé le ${fmtDateTime(count.completedAt)}` : ''}
        </Muted>
        <View>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 }}>
            <Text style={{ fontSize: 13 }}>Progression</Text>
            <Text style={{ fontSize: 13, fontWeight: '700' }}>{count.done} / {count.total}</Text>
          </View>
          <Progress value={count.total > 0 ? count.done / count.total : 0} />
        </View>
        <Btn title={countLabel} onPress={() => router.push(`/count/${count.id}`)} />
      </Card>

      <View style={{ flexDirection: 'row', gap: 8 }}>
        {actions.map((a) => (
          <Pressable key={a.label} accessibilityRole="button" onPress={a.go} style={{ flex: 1, minHeight: 88, borderRadius: 14, alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: 'primary' in a ? colors.primary : '#fff', borderWidth: 'primary' in a ? 0 : 1, borderColor: colors.field }}>
            <Icon name={a.icon} size={26} color={'primary' in a ? '#fff' : colors.text} />
            <Text style={{ fontSize: 12, fontWeight: '600', color: 'primary' in a ? '#fff' : colors.text }}>{a.label}</Text>
          </Pressable>
        ))}
      </View>

      <Pressable onPress={() => router.push('/articles')} style={{ minHeight: 52, borderRadius: 12, backgroundColor: colors.warnBg, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14 }}>
        <Icon name="alert-triangle" size={20} color={colors.warnText} />
        <Text style={{ flex: 1, fontSize: 14, fontWeight: '600', color: colors.warnText }}>{lowCount} articles sous le seuil minimum</Text>
        <Icon name="chevron-right" size={18} color={colors.warnText} />
      </Pressable>

      <H2>Activité récente</H2>
      <Card style={{ padding: 0, overflow: 'hidden' }}>
        {recentMovements.length === 0 && (
          <Muted style={{ padding: 16 }}>Aucune activité récente.</Muted>
        )}
        {recentMovements.map((m) => {
          const it = items.find((i) => i.id === m.itemId);
          if (!it) return null;
          return (
            <Row key={m.id} onPress={() => router.push(`/article/${it.id}`)}>
              <Thumb />
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 15, fontWeight: '600' }}>{it.name}</Text>
                <Muted>{m.mode} · {m.mode === 'Entrée' ? '+' : '−'}{m.qty} · {fmtTime(m.ts)}</Muted>
              </View>
              <Icon name="chevron-right" size={18} color={colors.muted} />
            </Row>
          );
        })}
      </Card>
    </Screen>
  );
}
