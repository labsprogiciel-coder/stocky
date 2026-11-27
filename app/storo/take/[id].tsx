/**
 * Comptage d'un inventaire Storo (contrat §8.1), hors ligne : comptage à
 * l'aveugle (le stock Storo n'est pas affiché) des articles du site ;
 * « Valider » enregistre une saisie envoyée à Storo, « Passer » n'envoie rien.
 */
import { useCallback, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { Alert as InlineAlert, Btn, Card, EmptyState, H2, Icon, Muted, Progress, Row, Screen, Stepper } from '../../../components/ui';
import { StoroBanner } from '../../../components/storo/StoroBanner';
import { colors } from '../../../constants/theme';
import { TAKE_TIMER_MS } from '../../../constants/storo';
import { lookupCode, takeItems } from '../../../data/storo/mapping';
import { consumePendingStoroScan, getAllOrgItems, getCount, getTake } from '../../../data/storo/orgStore';
import { countStatus, recordCount, setOrgCountIndex, type OrgCountStatus } from '../../../data/storo/outbox';
import { useStoroSession, useStoroVersion, useSyncTimer } from '../../../data/storo/useStoro';

const STATUS_COLORS: Record<OrgCountStatus, string> = {
  'À compter': colors.muted,
  'À envoyer': colors.warnText,
  'Envoyé': colors.primary,
  'Refusé': '#B91C1C',
  'Passé': colors.warnText,
};

export default function OrgTakeScreen() {
  useStoroVersion();
  const { id: rawId } = useLocalSearchParams<{ id: string }>();
  const id = typeof rawId === 'string' ? rawId : '';
  const { state } = useStoroSession();
  const take = getTake(id);
  const list = take ? takeItems(getAllOrgItems(), take.siteId) : [];
  const count = getCount(id);
  const [idx, setIdx] = useState(() => Math.min(count?.idx ?? 0, Math.max(0, list.length - 1)));
  const cur = list[Math.min(idx, Math.max(0, list.length - 1))];
  const entry = cur ? count?.entries[cur.id] : undefined;
  const [qty, setQty] = useState(entry?.status === 'Compté' ? entry.qty : 0);
  const [error, setError] = useState<string | null>(null);
  const [scanMsg, setScanMsg] = useState<string | null>(null);
  useSyncTimer(TAKE_TIMER_MS);

  const jumpTo = useCallback((i: number) => {
    const it = list[i];
    if (!it) return;
    setIdx(i);
    setOrgCountIndex(id, i);
    const e = getCount(id)?.entries[it.id];
    setQty(e?.status === 'Compté' ? e.qty : 0);
    setError(null);
  }, [id, list]);

  // Retour du scanner : l'article lu devient l'article courant.
  useFocusEffect(
    useCallback(() => {
      const code = consumePendingStoroScan(`take:${id}`);
      if (!code || !take) return;
      const item = lookupCode(getAllOrgItems(), take.siteId, code);
      if (!item) { setScanMsg(`Article inconnu sur ce site (${take.siteName || '—'}).`); return; }
      const i = list.findIndex((x) => x.id === item.id);
      setScanMsg(null);
      if (i >= 0) jumpTo(i);
    }, [id, take, list, jumpTo]),
  );

  if (!take) {
    return (
      <Screen>
        <Header title="Comptage" />
        <EmptyState icon="clipboard" title="Comptage introuvable" message="Ce comptage n'est plus ouvert dans Storo." primaryAction={{ label: 'Retour', onPress: () => router.back() }} />
      </Screen>
    );
  }

  const readonly = state !== 'active' || take.closed === true;
  const statuses = list.map((it) => countStatus(id, it.id));
  const doneCount = statuses.filter((s) => s !== 'À compter').length;

  const save = (status: 'Compté' | 'Passé') => {
    if (!cur) return;
    const err = recordCount(id, cur.id, qty, status);
    if (err) { setError(err); return; }
    const next = list.findIndex((it, i) => i > idx && countStatus(id, it.id) === 'À compter');
    if (next >= 0) jumpTo(next);
    else if (idx + 1 < list.length) jumpTo(idx + 1);
    else setError(null);
  };

  return (
    <Screen>
      <Header title={take.reference} />
      <StoroBanner />
      {take.closed && <InlineAlert message="Clôturé dans Storo : ce comptage est en lecture seule." />}
      <Card style={{ gap: 8 }}>
        <Muted>{take.siteName} · comptage à l'aveugle</Muted>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
          <Text style={{ fontSize: 13, color: colors.text }}>Progression</Text>
          <Text style={{ fontSize: 13, fontWeight: '700', color: colors.text }}>{doneCount} / {list.length}</Text>
        </View>
        <Progress value={list.length > 0 ? doneCount / list.length : 0} />
      </Card>

      {list.length === 0 ? (
        <EmptyState icon="box" title="Aucun article" message="Aucun article Storo sur le site de ce comptage. Synchronisez pour recevoir les articles." />
      ) : cur && (
        <Card style={{ gap: 12 }}>
          <View>
            <Text style={{ fontSize: 18, fontWeight: '700', color: colors.text }}>{cur.name}</Text>
            <Muted>{cur.sku}{cur.barcode ? ` · ${cur.barcode}` : ''}</Muted>
          </View>
          {entry?.sentRev !== undefined && !readonly && (
            <Muted style={{ color: colors.warnText }}>Déjà envoyé : une nouvelle saisie sera ajoutée dans Storo.</Muted>
          )}
          <View>
            <Muted style={{ fontWeight: '600', fontSize: 12, marginBottom: 6 }}>Quantité comptée</Muted>
            <Stepper value={qty} onChange={(n) => { if (!readonly) { setQty(n); setError(null); } }} big />
          </View>
          {error && <InlineAlert message={error} />}
          {scanMsg && <InlineAlert message={scanMsg} />}
          <Btn title="Valider et suivant" disabled={readonly} onPress={() => save('Compté')} />
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Btn title="Scanner" variant="outline" style={{ flex: 1 }} disabled={readonly} onPress={() => { setScanMsg(null); router.push({ pathname: '/scan', params: { storo: 'take', takeId: id } }); }} />
            <Btn title="Passer" variant="outline" style={{ flex: 1 }} disabled={readonly} onPress={() => save('Passé')} />
          </View>
        </Card>
      )}

      {list.length > 0 && (
        <>
          <H2>Articles du comptage</H2>
          <Card style={{ padding: 0, overflow: 'hidden' }}>
            {list.map((it, i) => (
              <Row key={it.id} onPress={() => jumpTo(i)} accessibilityLabel={`${it.name}, ${statuses[i]}`}>
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={{ fontSize: 14, fontWeight: it.id === cur?.id ? '700' : '600', color: colors.text }}>{it.name}</Text>
                  <Muted style={{ fontSize: 12 }}>{it.sku}</Muted>
                </View>
                <Text style={{ fontSize: 12, fontWeight: '600', color: STATUS_COLORS[statuses[i]] }}>{statuses[i]}</Text>
              </Row>
            ))}
          </Card>
          <Muted>Les saisies sont envoyées à Storo automatiquement. Un responsable clôture le comptage dans Storo.</Muted>
        </>
      )}
    </Screen>
  );
}

function Header({ title }: { title: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
      <Pressable accessibilityRole="button" accessibilityLabel="Fermer" onPress={() => router.back()} style={{ width: 44, height: 44, justifyContent: 'center' }}>
        <Icon name="x" />
      </Pressable>
      <Text style={{ fontSize: 16, fontWeight: '600', flex: 1, textAlign: 'center' }} numberOfLines={1}>{title}</Text>
      <View style={{ width: 44 }} />
    </View>
  );
}
