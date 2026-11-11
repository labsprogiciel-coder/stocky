import { useCallback, useState } from 'react';
import { View, Text, Pressable } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { Screen, H1, H2, Card, Btn, Progress, Row, Thumb, Muted, Icon } from '../../components/ui';
import { colors } from '../../constants/theme';
import { cycleCount } from '../../data/mock';
import { getItems, getMovements, fmtTime } from '../../data/store';

const actions = [
  { icon: 'maximize', label: 'Scanner', primary: true, go: () => router.push('/scan') },
  { icon: 'arrow-down-circle', label: 'Entrée', go: () => router.push('/scan') },
  { icon: 'arrow-up-circle', label: 'Sortie', go: () => router.push('/scan') },
  { icon: 'search', label: 'Chercher', go: () => router.push('/articles') },
] as const;

export default function Home() {
  const [items, setItems] = useState(() => getItems());
  const [movements, setMovements] = useState(() => getMovements());

  // Refresh live data whenever this tab becomes active
  useFocusEffect(
    useCallback(() => {
      setItems(getItems());
      setMovements(getMovements());
    }, [])
  );

  const lowCount = items.filter((i) => i.qty <= i.min).length;
  const recentMovements = movements.slice(0, 5);
  return (
    <Screen>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <H1>Aujourdhui</H1>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 999, backgroundColor: '#fff', borderWidth: 1, borderColor: colors.field }}>
          <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: colors.primary }} />
          <Text style={{ fontSize: 12, fontWeight: '600' }}>En ligne · 0 en attente</Text>
        </View>
      </View>

      <Card style={{ borderColor: colors.primary, borderWidth: 2, gap: 12 }}>
        <Text style={{ fontSize: 12, fontWeight: '700', color: colors.primary }}>COMPTAGE CYCLIQUE · AUJOURD'HUI</Text>
        <Text style={{ fontSize: 16, fontWeight: '600' }}>{cycleCount.name}</Text>
        <Muted>{cycleCount.folder} · {cycleCount.total} articles</Muted>
        <View>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 }}>
            <Text style={{ fontSize: 13 }}>Progression</Text>
            <Text style={{ fontSize: 13, fontWeight: '700' }}>{cycleCount.done} / {cycleCount.total}</Text>
          </View>
          <Progress value={cycleCount.done / cycleCount.total} />
        </View>
        <Btn title="Reprendre le comptage" onPress={() => router.push(`/count/${cycleCount.id}`)} />
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
