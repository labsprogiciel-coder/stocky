/**
 * Articles du site courant (Storo), en lecture : recherche par nom, SKU ou
 * code-barres ; stock affiché = stock Storo + opérations en attente d'envoi.
 */
import { useState } from 'react';
import { FlatList, Text, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import { EmptyState, Icon, Muted, Row } from '../../components/ui';
import { colors } from '../../constants/theme';
import { displayedQty, getSiteItems } from '../../data/storo/orgStore';
import { useOrgData, useStoroSession } from '../../data/storo/useStoro';

export default function OrgItems() {
  const { siteId, site } = useOrgData();
  const { state } = useStoroSession();
  const [q, setQ] = useState('');
  const query = q.trim().toLowerCase();
  const items = getSiteItems(siteId).filter((i) =>
    !query || i.name.toLowerCase().includes(query) || i.sku.toLowerCase().includes(query) || (i.barcode ?? '').includes(query),
  );
  const writable = state === 'active';

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <View style={{ padding: 12, gap: 6 }}>
        <Muted>{site?.name ?? 'Aucun site choisi'} · lecture seule (les articles se gèrent dans Storo)</Muted>
        <TextInput
          value={q}
          onChangeText={setQ}
          placeholder="Nom, SKU ou code-barres"
          placeholderTextColor={colors.muted}
          accessibilityLabel="Rechercher un article"
          autoCorrect={false}
          style={{ height: 48, paddingHorizontal: 14, borderWidth: 1, borderColor: colors.field, borderRadius: 10, backgroundColor: '#fff', fontSize: 15, color: colors.text }}
        />
      </View>
      <FlatList
        data={items}
        keyExtractor={(i) => i.id}
        contentContainerStyle={{ paddingBottom: 32 }}
        ListEmptyComponent={<View style={{ padding: 12 }}><EmptyState icon="box" title="Aucun article" message={query ? 'Aucun article ne correspond à la recherche.' : 'Aucun article Storo sur ce site.'} /></View>}
        renderItem={({ item }) => {
          const qty = displayedQty(item.id);
          const low = item.reorderPoint !== null && qty <= item.reorderPoint;
          return (
            <View style={{ backgroundColor: '#fff' }}>
              <Row
                onPress={writable ? () => router.push({ pathname: '/storo/move', params: { itemId: item.id } }) : undefined}
                accessibilityLabel={`${item.name}, ${qty} en stock`}
                accessibilityHint={writable ? 'Ouvre Entrée / Sortie pour cet article' : undefined}
              >
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={{ fontSize: 15, fontWeight: '600', color: colors.text }}>{item.name}</Text>
                  <Muted>{item.sku}{item.barcode ? ` · ${item.barcode}` : ''}{item.category ? ` · ${item.category}` : ''}</Muted>
                </View>
                <Text style={{ fontSize: 16, fontWeight: '700', color: low ? colors.warnText : colors.text }}>{qty}</Text>
                {writable && <Icon name="chevron-right" size={18} color={colors.muted} />}
              </Row>
            </View>
          );
        }}
      />
    </View>
  );
}
