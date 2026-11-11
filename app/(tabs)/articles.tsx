import { useCallback, useMemo, useState } from 'react';
import { View, TextInput, Pressable, Text } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { Screen, H1, Card, Chip, Row, Thumb, Muted, Icon } from '../../components/ui';
import { colors } from '../../constants/theme';
import { getItems } from '../../data/store';

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
  const list = useMemo(() => items.filter((i) => (folder === 'Tous' || i.folder === folder) && i.name.toLowerCase().includes(q.toLowerCase())), [q, folder]);
  return (
    <View style={{ flex: 1 }}>
      <Screen>
        <H1>Articles</H1>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <TextInput value={q} onChangeText={setQ} placeholder="Rechercher un article" accessibilityLabel="Rechercher un article" placeholderTextColor={colors.muted} style={{ flex: 1, height: 48, paddingHorizontal: 14, borderWidth: 1, borderColor: colors.field, borderRadius: 10, backgroundColor: '#fff', fontSize: 15 }} />
          <Pressable accessibilityLabel="Scanner un code" onPress={() => router.push('/scan')} style={{ width: 48, height: 48, borderRadius: 10, backgroundColor: '#fff', borderWidth: 1, borderColor: colors.field, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="maximize" />
          </Pressable>
        </View>
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
          {folders.map((f) => <Chip key={f} label={f} active={f === folder} onPress={() => setFolder(f)} />)}
        </View>
        <Card style={{ padding: 0, overflow: 'hidden' }}>
          {list.map((it) => (
            <Row key={it.id} onPress={() => router.push(`/article/${it.id}`)}>
              <Thumb />
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 15, fontWeight: '600' }}>{it.name}</Text>
                <Muted>{it.folder} · {it.qty} unités</Muted>
              </View>
              <Icon name="chevron-right" size={18} color={colors.muted} />
            </Row>
          ))}
        </Card>
      </Screen>
      <Pressable accessibilityLabel="Ajouter un article" style={{ position: 'absolute', right: 12, bottom: 20, width: 56, height: 56, borderRadius: 28, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center', elevation: 4 }}>
        <Icon name="plus" size={28} color="#fff" />
      </Pressable>
    </View>
  );
}
