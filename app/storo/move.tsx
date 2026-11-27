/**
 * Entrée / Sortie sur un article Storo (`?itemId=` ou `?code=`, `&mode=`).
 * Enregistrée hors ligne dans la file d'envoi, envoyée à Storo comme
 * mouvement `reception` / `sortie`. Aucune limite Stocky (licence) ici.
 */
import { useState } from 'react';
import { Alert, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { Alert as InlineAlert, Btn, Card, EmptyState, Muted, Screen, Segmented, Stepper } from '../../components/ui';
import { StoroBanner } from '../../components/storo/StoroBanner';
import { colors } from '../../constants/theme';
import { lookupCode } from '../../data/storo/mapping';
import { displayedQty, getAllOrgItems, getCurrentSiteId, getOrgItem, getSite } from '../../data/storo/orgStore';
import { enqueueMovement } from '../../data/storo/outbox';
import { useStoroSession, useStoroVersion } from '../../data/storo/useStoro';

export default function OrgMove() {
  useStoroVersion();
  const params = useLocalSearchParams<{ itemId?: string; code?: string; mode?: string }>();
  const { state } = useStoroSession();
  const item = typeof params.itemId === 'string' && params.itemId
    ? getOrgItem(params.itemId)
    : typeof params.code === 'string' ? lookupCode(getAllOrgItems(), getCurrentSiteId(), params.code) ?? undefined : undefined;
  const [mode, setMode] = useState<'Entrée' | 'Sortie'>(params.mode === 'Sortie' ? 'Sortie' : 'Entrée');
  const [qty, setQty] = useState(1);
  const [error, setError] = useState<string | null>(null);

  if (!item) {
    return (
      <Screen hasHeader>
        <EmptyState icon="search" title="Article introuvable" message={`Article inconnu sur ce site (${getSite(getCurrentSiteId())?.name ?? '—'}).`} primaryAction={{ label: 'Retour', onPress: () => router.back() }} />
      </Screen>
    );
  }

  const available = displayedQty(item.id);
  const writable = state === 'active';
  const localError = qty < 1 ? 'La quantité doit être supérieure à 0.' : mode === 'Sortie' && qty > available ? `Stock insuffisant. Disponible : ${Math.max(0, available)}.` : null;

  const submit = () => {
    const err = enqueueMovement(item.id, mode, qty);
    if (err) {
      setError(err);
      return;
    }
    Alert.alert(`${mode} enregistrée`, `${mode === 'Entrée' ? '+' : '−'}${qty} · ${item.name}. Elle sera envoyée à Storo dès que possible.`);
    router.back();
  };

  return (
    <Screen hasHeader>
      <StoroBanner />
      <Card style={{ gap: 6 }}>
        <Text style={{ fontSize: 18, fontWeight: '700', color: colors.text }}>{item.name}</Text>
        <Muted>{item.sku}{item.barcode ? ` · ${item.barcode}` : ''}</Muted>
        <Muted>{getSite(item.siteId)?.name ?? ''}</Muted>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 6 }}>
          <Text style={{ fontSize: 14, color: colors.text }}>Stock</Text>
          <Text style={{ fontSize: 16, fontWeight: '700', color: colors.text }}>{available}</Text>
        </View>
        {available !== item.serverQty && <Muted>Dont {available - item.serverQty > 0 ? '+' : ''}{available - item.serverQty} en attente d'envoi (Storo : {item.serverQty}).</Muted>}
      </Card>
      <Segmented options={['Entrée', 'Sortie']} value={mode} onChange={(m) => { setMode(m); setError(null); }} />
      <Card style={{ gap: 8 }}>
        <Muted style={{ fontWeight: '600', fontSize: 12 }}>Quantité</Muted>
        <Stepper value={qty} onChange={(n) => { setQty(Math.max(1, n)); setError(null); }} big />
      </Card>
      {(error ?? localError) && <InlineAlert message={(error ?? localError)!} />}
      <Btn title={`Valider la ${mode === 'Entrée' ? 'réception' : 'sortie'}`} disabled={!writable || localError !== null} onPress={submit} />
    </Screen>
  );
}
