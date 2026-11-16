import { useCallback, useMemo, useState } from 'react';
import { View, TextInput, Pressable, Text } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { Screen, H1, Card, Chip, Row, Thumb, Muted, Icon, EmptyState } from '../../components/ui';
import { colors } from '../../constants/theme';
import { fmtCount, getItems } from '../../data/store';

export default function Articles() {
  const [items, setItems] = useState(() => getItems());
  const [q, setQ] = useState('');
  const [folder, setFolder] = useState('Tous');

  // Refresh when tab gains focus (after scan / stock adjustment)
  useFocusEffect(
    useCallback(() => {
      setItems(getItems());
    }, [])
  );
  const folders = ['Tous', ...Array.from(new Set(items.map((i) => i.folder)))];
  // Dossier sélectionné disparu (ex. après une réinitialisation) : retour à « Tous ».
  const activeFolder = folders.includes(folder) ? folder : 'Tous';
  const hasItems = items.length > 0;
  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return items.filter((i) =>
      (activeFolder === 'Tous' || i.folder === activeFolder) &&
      (!needle ||
        i.name.toLowerCase().includes(needle) ||
        i.sku.toLowerCase().includes(needle) ||
        (i.barcode ?? '').toLowerCase().includes(needle))
    );
  }, [items, q, activeFolder]);
  const clearFilters = () => {
    setQ('');
    setFolder('Tous');
  };
  return (
    <View style={{ flex: 1 }}>
      <Screen>
        <H1>Articles</H1>
        {!hasItems ? (
          <EmptyState
            icon="package"
            title="Aucun article"
            message="Votre inventaire est vide. Ajoutez un article ou scannez son code-barres pour le créer."
            primaryAction={{ label: 'Ajouter un article', onPress: () => router.push('/article/new'), accessibilityHint: 'Ouvre le formulaire de création d\'article' }}
            secondaryAction={{ label: 'Scanner', onPress: () => router.push('/scan'), accessibilityLabel: 'Scanner un code', accessibilityHint: 'Ouvre le scanner de codes-barres' }}
          />
        ) : (
          <>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <TextInput value={q} onChangeText={setQ} placeholder="Nom, SKU ou code-barres" accessibilityLabel="Rechercher un article" placeholderTextColor={colors.muted} style={{ flex: 1, height: 48, paddingHorizontal: 14, borderWidth: 1, borderColor: colors.field, borderRadius: 10, backgroundColor: '#fff', fontSize: 15 }} />
              <Pressable accessibilityRole="button" accessibilityLabel="Scanner un code" onPress={() => router.push('/scan')} style={{ width: 48, height: 48, borderRadius: 10, backgroundColor: '#fff', borderWidth: 1, borderColor: colors.field, alignItems: 'center', justifyContent: 'center' }}>
                <Icon name="maximize" />
              </Pressable>
            </View>
            <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
              {folders.map((f) => <Chip key={f} label={f} active={f === activeFolder} onPress={() => setFolder(f)} />)}
            </View>
            {list.length === 0 ? (
              <EmptyState
                icon="search"
                title="Aucun résultat"
                message={q.trim()
                  ? `Aucun article ne correspond à « ${q.trim()} »${activeFolder !== 'Tous' ? ` dans ${activeFolder}` : ''}.`
                  : 'Aucun article ne correspond à ce filtre.'}
                primaryAction={{ label: 'Effacer la recherche', onPress: clearFilters, accessibilityHint: 'Efface la recherche et le filtre de dossier' }}
              />
            ) : (
              <Card style={{ padding: 0, overflow: 'hidden' }}>
                {list.map((it) => (
                  <Row key={it.id} onPress={() => router.push(`/article/${it.id}`)}>
                    <Thumb photo={it.photo} />
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontSize: 15, fontWeight: '600' }}>{it.name}</Text>
                      <Muted>{it.folder} · {fmtCount(it.qty, 'unité', 'unités')}</Muted>
                    </View>
                    <Icon name="chevron-right" size={18} color={colors.muted} />
                  </Row>
                ))}
              </Card>
            )}
          </>
        )}
      </Screen>
      <Pressable accessibilityRole="button" accessibilityLabel="Ajouter un article" onPress={() => router.push('/article/new')} style={{ position: 'absolute', right: 12, bottom: 20, width: 56, height: 56, borderRadius: 28, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center', elevation: 4 }}>
        <Icon name="plus" size={28} color="#fff" />
      </Pressable>
    </View>
  );
}
