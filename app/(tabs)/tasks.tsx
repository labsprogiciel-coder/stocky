import { useCallback, useState } from 'react';
import { View, Text } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { Screen, H1, Card, Chip, Btn, Progress, Muted, Icon, EmptyState } from '../../components/ui';
import { colors } from '../../constants/theme';
import { getCycleCount, fmtCount, fmtDateTime, type CycleCountInfo } from '../../data/store';
import { exportCountCsv } from '../../data/exportCount';

function CountHeader({ count, done }: { count: CycleCountInfo; done?: boolean }) {
  return (
    <View style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}>
      <View style={{ width: 44, height: 44, borderRadius: 10, backgroundColor: colors.tint, alignItems: 'center', justifyContent: 'center' }}>
        <Icon name={done ? 'check-circle' : 'list'} color={colors.primary} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: 12, fontWeight: '700', color: colors.primary }}>COMPTAGE CYCLIQUE</Text>
        <Text style={{ fontSize: 16, fontWeight: '600' }}>{count.name}</Text>
      </View>
    </View>
  );
}

export default function Tasks() {
  const [tab, setTab] = useState<'todo' | 'done'>('todo');
  const [count, setCount] = useState(() => getCycleCount());
  const [exporting, setExporting] = useState(false);

  useFocusEffect(
    useCallback(() => {
      setCount(getCycleCount());
    }, [])
  );

  const completed = count.completedAt !== undefined;
  const hasItems = count.total > 0;
  const open = () => router.push(`/count/${count.id}`);
  const handleExport = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      await exportCountCsv(count.id);
    } finally {
      setExporting(false);
    }
  };

  return (
    <Screen>
      <H1>Tâches</H1>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Chip label="À faire" active={tab === 'todo'} onPress={() => setTab('todo')} />
        <Chip label="Terminées" active={tab === 'done'} onPress={() => setTab('done')} />
      </View>
      {tab === 'todo' ? (
        !hasItems ? (
          <EmptyState
            icon="clipboard"
            title="Aucun comptage à réaliser"
            message="Le comptage cyclique porte sur tous les articles de l'inventaire. Ajoutez un article pour pouvoir lancer un comptage."
            primaryAction={{ label: 'Ajouter un article', onPress: () => router.push('/article/new'), accessibilityHint: 'Ouvre le formulaire de création d\'article' }}
          />
        ) : !completed ? (
          <Card style={{ borderColor: colors.primary, borderWidth: 2, gap: 12 }}>
            <CountHeader count={count} />
            <Muted>{count.folder} · {fmtCount(count.total, 'article', 'articles')} · Échéance : {count.due}</Muted>
            <View>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 }}>
                <Text style={{ fontSize: 13 }}>Progression</Text>
                <Text style={{ fontSize: 13, fontWeight: '700' }}>{count.done} / {count.total}</Text>
              </View>
              <Progress value={count.progress} />
            </View>
            <Btn title={count.done > 0 ? 'Reprendre le comptage' : 'Commencer le comptage'} onPress={open} />
          </Card>
        ) : (
          <EmptyState
            icon="check-circle"
            title="Aucune tâche à faire"
            message="Le comptage de l'inventaire est terminé. Retrouvez-le dans l'onglet « Terminées »."
            primaryAction={{ label: 'Voir les tâches terminées', onPress: () => setTab('done') }}
          />
        )
      ) : completed && count.completedAt !== undefined ? (
        <Card style={{ gap: 12 }}>
          <CountHeader count={count} done />
          <Muted>{count.folder} · {count.done} / {fmtCount(count.total, 'article traité', 'articles traités')}</Muted>
          <Muted>Terminé le {fmtDateTime(count.completedAt)}</Muted>
          <Btn title="Voir le comptage" variant="outline" onPress={open} />
          {hasItems && (
            <Btn
              title={exporting ? 'Export en cours…' : 'Exporter (CSV)'}
              variant="outline"
              accessibilityLabel="Exporter le comptage au format CSV"
              disabled={exporting}
              onPress={handleExport}
            />
          )}
        </Card>
      ) : (
        <EmptyState
          icon="inbox"
          title="Aucune tâche terminée"
          message="Les comptages terminés apparaîtront ici, avec leur export CSV."
          primaryAction={hasItems
            ? { label: 'Voir les tâches à faire', onPress: () => setTab('todo') }
            : { label: 'Ajouter un article', onPress: () => router.push('/article/new'), accessibilityHint: 'Ouvre le formulaire de création d\'article' }}
        />
      )}
    </Screen>
  );
}
