import { useState } from 'react';
import { View, Text } from 'react-native';
import { router } from 'expo-router';
import { Screen, H1, Card, Chip, Btn, Progress, Muted, Icon } from '../../components/ui';
import { colors } from '../../constants/theme';
import { cycleCount } from '../../data/mock';

export default function Tasks() {
  const [tab, setTab] = useState<'todo' | 'done'>('todo');
  return (
    <Screen>
      <H1>Tâches</H1>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Chip label="À faire" active={tab === 'todo'} onPress={() => setTab('todo')} />
        <Chip label="Terminées" active={tab === 'done'} onPress={() => setTab('done')} />
      </View>
      {tab === 'todo' ? (
        <>
          <Card style={{ borderColor: colors.primary, borderWidth: 2, gap: 12 }}>
            <View style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}>
              <View style={{ width: 44, height: 44, borderRadius: 10, backgroundColor: colors.tint, alignItems: 'center', justifyContent: 'center' }}><Icon name="list" color={colors.primary} /></View>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 12, fontWeight: '700', color: colors.primary }}>COMPTAGE CYCLIQUE</Text>
                <Text style={{ fontSize: 16, fontWeight: '600' }}>{cycleCount.name}</Text>
              </View>
            </View>
            <Muted>{cycleCount.folder} · {cycleCount.total} articles · Échéance : {cycleCount.due}</Muted>
            <View>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 }}>
                <Text style={{ fontSize: 13 }}>Progression</Text>
                <Text style={{ fontSize: 13, fontWeight: '700' }}>{cycleCount.done} / {cycleCount.total}</Text>
              </View>
              <Progress value={cycleCount.done / cycleCount.total} />
            </View>
            <Btn title="Commencer le comptage" onPress={() => router.push(`/count/${cycleCount.id}`)} />
          </Card>
        </>
      ) : (
        <Card><Muted>Aucune tâche terminée.</Muted></Card>
      )}
    </Screen>
  );
}
