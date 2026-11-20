import { useCallback, useMemo, useState } from 'react';
import { View, TextInput, Pressable, Text } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { Screen, H1, Card, Chip, Row, Thumb, Muted, Icon, EmptyState, SerialBadge, Btn } from '../../components/ui';
import { colors } from '../../constants/theme';
import { fmtCount, getItems, getUnits, isProActive, serialKey } from '../../data/store';

export default function Articles() {
  const [items, setItems] = useState(() => getItems());
  const [units, setUnits] = useState(() => getUnits());
  const [q, setQ] = useState('');
  const [folder, setFolder] = useState('Tous');
  // Pas de vérification de licence au premier rendu : mise à jour au focus.
  const [pro, setPro] = useState(true);

  // Refresh when tab gains focus (after scan / stock adjustment)
  useFocusEffect(
    useCallback(() => {
      setItems(getItems());
      setUnits(getUnits());
      setPro(isProActive());
    }, [])
  );
  const folders = ['Tous', ...Array.from(new Set(items.map((i) => i.folder)))];
  // Dossier sélectionné disparu (ex. après une réinitialisation) : retour à « Tous ».
  const activeFolder = folders.includes(folder) ? folder : 'Tous';
  const hasItems = items.length > 0;
  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    // Articles dont un appareil correspond (numéro de série ou IMEI).
    const key = serialKey(q);
    const digits = q.replace(/[\s-]+/g, '');
    const byUnit = new Set(
      key
        ? units
            .filter((u) => serialKey(u.serial).includes(key) || (/^\d+$/.test(digits) && ((u.imei !== undefined && u.imei.includes(digits)) || (u.imei2 !== undefined && u.imei2.includes(digits)))))
            .map((u) => u.itemId)
        : []
    );
    return items.filter((i) =>
      (activeFolder === 'Tous' || i.folder === activeFolder) &&
      (!needle ||
        i.name.toLowerCase().includes(needle) ||
        i.sku.toLowerCase().includes(needle) ||
        (i.barcode ?? '').toLowerCase().includes(needle) ||
        byUnit.has(i.id))
    );
  }, [items, units, q, activeFolder]);
  const clearFilters = () => {
    setQ('');
    setFolder('Tous');
  };
  return (
    <View style={{ flex: 1 }}>
      <Screen>
        <H1>Articles</H1>
        {!hasItems ? (
          <>
          <EmptyState
            icon="package"
            title="Aucun article"
            message="Votre inventaire est vide. Ajoutez un article ou scannez son code-barres pour le créer."
            primaryAction={{ label: 'Ajouter un article', onPress: () => router.push('/article/new'), accessibilityHint: 'Ouvre le formulaire de création d\'article' }}
            secondaryAction={{ label: 'Scanner', onPress: () => router.push('/scan'), accessibilityLabel: 'Scanner un code', accessibilityHint: 'Ouvre le scanner de codes-barres' }}
          />
          <Btn
            title={pro ? 'Importer depuis Excel' : 'Importer depuis Excel · Pro'}
            variant="outline"
            onPress={() => router.push('/import')}
            accessibilityHint="Importe des articles et des appareils depuis un fichier Excel ou CSV"
          />
          </>
        ) : (
          <>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <TextInput value={q} onChangeText={setQ} placeholder="Nom, SKU, code-barres, n° de série" accessibilityLabel="Rechercher un article" placeholderTextColor={colors.muted} style={{ flex: 1, height: 48, paddingHorizontal: 14, borderWidth: 1, borderColor: colors.field, borderRadius: 10, backgroundColor: '#fff', fontSize: 15 }} />
              <Pressable accessibilityRole="button" accessibilityLabel="Scanner un code" onPress={() => router.push('/scan')} style={{ width: 48, height: 48, borderRadius: 10, backgroundColor: '#fff', borderWidth: 1, borderColor: colors.field, alignItems: 'center', justifyContent: 'center' }}>
                <Icon name="maximize" />
              </Pressable>
              <Pressable accessibilityRole="button" accessibilityLabel={pro ? 'Importer depuis Excel' : 'Importer depuis Excel, réservé à Stockly Pro'} accessibilityHint="Importe des articles et des appareils depuis un fichier Excel ou CSV" onPress={() => router.push('/import')} style={{ width: 48, height: 48, borderRadius: 10, backgroundColor: '#fff', borderWidth: 1, borderColor: colors.field, alignItems: 'center', justifyContent: 'center' }}>
                <Icon name="upload" />
                {!pro && (
                  <Text style={{ position: 'absolute', top: 2, right: 3, fontSize: 9, fontWeight: '800', color: colors.warnText }}>PRO</Text>
                )}
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
                    <View style={{ flex: 1, gap: 2 }}>
                      <Text style={{ fontSize: 15, fontWeight: '600' }}>{it.name}</Text>
                      <Muted>{it.folder} · {it.serialized ? `${it.qty} en stock` : fmtCount(it.qty, 'unité', 'unités')}</Muted>
                      {it.serialized && <SerialBadge />}
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
