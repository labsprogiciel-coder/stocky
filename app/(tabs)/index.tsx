import { useCallback, useState } from 'react';
import { View, Text, Pressable } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { Screen, H1, H2, Card, Btn, Progress, Row, Thumb, Muted, Icon, EmptyState, SerialBadge } from '../../components/ui';
import { colors } from '../../constants/theme';
import { getItems, getMovements, getCycleCount, fmtCount, fmtTime, fmtDateTime } from '../../data/store';
import { isPersistent } from '../../data/storage';
import { WorkspaceSwitcher } from '../../components/storo/WorkspaceSwitcher';
import { StoroBanner } from '../../components/storo/StoroBanner';

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

  const hasItems = items.length > 0;
  const lowCount = items.filter((i) => i.qty <= i.min).length;
  const itemsById = new Map(items.map((i) => [i.id, i]));
  const recentMovements = movements.filter((m) => itemsById.has(m.itemId)).slice(0, 5);
  const lowLabel = lowCount === 0
    ? 'Aucun article sous le seuil minimum'
    : `${fmtCount(lowCount, 'article', 'articles')} sous le seuil minimum`;
  const lowColor = lowCount > 0 ? colors.warnText : colors.primary;
  const countLabel = count.completedAt !== undefined
    ? 'Voir le comptage'
    : count.done > 0 ? 'Reprendre le comptage' : 'Commencer le comptage';
  return (
    <Screen>
      {/* Espace de travail (affiché seulement si le téléphone est associé à Storo). */}
      <WorkspaceSwitcher current="standalone" />
      <StoroBanner standalone />
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

      {!hasItems ? (
        <>
          <EmptyState
            icon="package"
            title="Aucun article"
            message="Votre inventaire est vide. Ajoutez votre premier article ou scannez un code-barres pour commencer à suivre votre stock."
            primaryAction={{ label: 'Ajouter un article', onPress: () => router.push('/article/new'), accessibilityHint: 'Ouvre le formulaire de création d\'article' }}
            secondaryAction={{ label: 'Scanner un code', onPress: () => router.push('/scan'), accessibilityHint: 'Ouvre le scanner de codes-barres' }}
          />
          <Muted style={{ textAlign: 'center' }}>
            Pour découvrir l'application, chargez les données d'exemple depuis Profil › Stockage local.
          </Muted>
        </>
      ) : (
        <>
          <Card style={{ borderColor: colors.primary, borderWidth: 2, gap: 12 }}>
            <Text style={{ fontSize: 12, fontWeight: '700', color: colors.primary }}>COMPTAGE CYCLIQUE · AUJOURD'HUI</Text>
            <Text style={{ fontSize: 16, fontWeight: '600' }}>{count.name}</Text>
            <Muted>
              {count.folder} · {fmtCount(count.total, 'article', 'articles')}
              {count.completedAt !== undefined ? ` · Terminé le ${fmtDateTime(count.completedAt)}` : ''}
            </Muted>
            <View>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 }}>
                <Text style={{ fontSize: 13 }}>Progression</Text>
                <Text style={{ fontSize: 13, fontWeight: '700' }}>{count.done} / {count.total}</Text>
              </View>
              <Progress value={count.progress} />
            </View>
            <Btn title={countLabel} onPress={() => router.push(`/count/${count.id}`)} />
          </Card>

          <View style={{ flexDirection: 'row', gap: 8 }}>
            {actions.map((a) => (
              <Pressable key={a.label} accessibilityRole="button" accessibilityLabel={a.label} onPress={a.go} style={{ flex: 1, minHeight: 88, borderRadius: 14, alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: 'primary' in a ? colors.primary : '#fff', borderWidth: 'primary' in a ? 0 : 1, borderColor: colors.field }}>
                <Icon name={a.icon} size={26} color={'primary' in a ? '#fff' : colors.text} />
                <Text style={{ fontSize: 12, fontWeight: '600', color: 'primary' in a ? '#fff' : colors.text }}>{a.label}</Text>
              </Pressable>
            ))}
          </View>

          <Pressable
            accessibilityRole="button"
            accessibilityLabel={lowLabel}
            onPress={() => router.push('/articles')}
            style={{ minHeight: 52, borderRadius: 12, backgroundColor: lowCount > 0 ? colors.warnBg : colors.tint, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14 }}
          >
            <Icon name={lowCount > 0 ? 'alert-triangle' : 'check-circle'} size={20} color={lowColor} />
            <Text style={{ flex: 1, fontSize: 14, fontWeight: '600', color: lowColor }}>{lowLabel}</Text>
            <Icon name="chevron-right" size={18} color={lowColor} />
          </Pressable>

          <H2>Activité récente</H2>
          {recentMovements.length === 0 ? (
            <EmptyState
              icon="activity"
              title="Aucun mouvement pour l'instant"
              message="Les entrées et sorties de stock apparaîtront ici. Scannez un article pour enregistrer un premier mouvement."
              primaryAction={{ label: 'Scanner', onPress: () => router.push('/scan'), accessibilityLabel: 'Scanner un article', accessibilityHint: 'Ouvre le scanner pour enregistrer une entrée ou une sortie' }}
            />
          ) : (
            <Card style={{ padding: 0, overflow: 'hidden' }}>
              {recentMovements.map((m) => {
                const it = itemsById.get(m.itemId);
                if (!it) return null;
                return (
                  <Row key={m.id} onPress={() => router.push(`/article/${it.id}`)}>
                    <Thumb photo={it.photo} />
                    <View style={{ flex: 1, gap: 2 }}>
                      <Text style={{ fontSize: 15, fontWeight: '600' }}>{it.name}</Text>
                      <Muted>
                        {m.mode} · {m.mode === 'Entrée' ? '+' : '−'}{m.qty}
                        {m.serial !== undefined ? ` · n° ${m.serial}` : ''} · {fmtTime(m.ts)}
                      </Muted>
                      {it.serialized && <SerialBadge />}
                    </View>
                    <Icon name="chevron-right" size={18} color={colors.muted} />
                  </Row>
                );
              })}
            </Card>
          )}
        </>
      )}
    </Screen>
  );
}
