/**
 * Opérations à envoyer à Storo (contrat §7.4) : en attente et refusées.
 * Lignes refusées : « Réessayer », « Modifier » (mouvements), « Abandonner ».
 */
import { useState } from 'react';
import { Alert, Text, View } from 'react-native';
import { Btn, Card, EmptyState, H2, Muted, Screen, Stepper } from '../../components/ui';
import { StoroBanner } from '../../components/storo/StoroBanner';
import { colors } from '../../constants/theme';
import { fmtCount, fmtDateTime } from '../../data/store';
import { errorDetailsLine } from '../../data/storo/errors';
import { getOutboxRows, type OutboxRecord } from '../../data/storo/orgStore';
import { discardRow, editMovement, retryRow } from '../../data/storo/outbox';
import { runSync } from '../../data/storo/sync';
import { useOrgData, useStoroSession, useStoroVersion } from '../../data/storo/useStoro';

function title(r: OutboxRecord): string {
  if (r.kind === 'count') return `Comptage ${r.label.takeRef ?? ''} · ${r.label.qty}`;
  return `${r.label.mode ?? ''} ${r.label.mode === 'Sortie' ? '−' : '+'}${r.label.qty}`;
}

export default function OutboxScreen() {
  useStoroVersion();
  const { session } = useStoroSession();
  const { syncing } = useOrgData();
  const [editing, setEditing] = useState<{ clientId: string; qty: number } | null>(null);
  const rows = getOutboxRows();
  const orgId = session?.orgId ?? null;
  const parked = rows.filter((r) => r.orgId === orgId && r.state === 'error');
  const pending = rows.filter((r) => r.orgId === orgId && r.state === 'pending');
  const foreign = rows.filter((r) => r.orgId !== orgId);

  const report = (err: string | null) => { if (err) Alert.alert('Opération non modifiée', err); };

  const abandon = (r: OutboxRecord) => {
    Alert.alert(
      'Abandonner cette opération ?',
      r.kind === 'count' ? 'La saisie ne sera pas envoyée à Storo ; l\'article redevient « À compter ».' : 'Le mouvement ne sera pas envoyé à Storo.',
      [{ text: 'Annuler', style: 'cancel' }, { text: 'Abandonner', style: 'destructive', onPress: () => report(discardRow(r.clientId)) }],
    );
  };

  const rowCard = (r: OutboxRecord, kind: 'parked' | 'pending' | 'foreign') => {
    const closed = r.error?.code === 'CONFLICT' && r.error.reason === 'stock_take_closed';
    const isEditing = editing?.clientId === r.clientId;
    return (
      <Card key={r.clientId} style={{ gap: 8 }}>
        <Text style={{ fontSize: 15, fontWeight: '600', color: colors.text }}>{r.label.itemName}</Text>
        <Muted>{title(r)} · {r.label.sku}{r.label.siteName ? ` · ${r.label.siteName}` : ''}</Muted>
        <Muted style={{ fontSize: 12 }}>Enregistrée le {fmtDateTime(r.createdAt)}{r.attempts > 0 ? ` · ${fmtCount(r.attempts, 'essai', 'essais')}` : ''}</Muted>
        {r.error && (
          <>
            <Text style={{ fontSize: 13, fontWeight: '600', color: '#B91C1C' }}>{r.error.message}</Text>
            <Muted style={{ fontSize: 11 }}>{errorDetailsLine(r.error)}</Muted>
          </>
        )}
        {isEditing && (
          <View style={{ gap: 8 }}>
            <Stepper value={editing.qty} onChange={(n) => setEditing({ clientId: r.clientId, qty: Math.max(1, n) })} />
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Btn title="Enregistrer" style={{ flex: 1 }} onPress={() => { report(editMovement(r.clientId, editing.qty)); setEditing(null); }} />
              <Btn title="Annuler" variant="outline" style={{ flex: 1 }} onPress={() => setEditing(null)} />
            </View>
          </View>
        )}
        {kind === 'parked' && !isEditing && (
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
            {!closed && <Btn title="Réessayer" variant="outline" style={{ flexGrow: 1 }} onPress={() => report(retryRow(r.clientId))} />}
            {!closed && r.kind === 'movement' && <Btn title="Modifier" variant="outline" style={{ flexGrow: 1 }} onPress={() => setEditing({ clientId: r.clientId, qty: r.label.qty })} />}
            <Btn title="Abandonner" variant="danger" style={{ flexGrow: 1 }} onPress={() => abandon(r)} />
          </View>
        )}
        {kind === 'foreign' && <Btn title="Abandonner" variant="danger" onPress={() => abandon(r)} />}
      </Card>
    );
  };

  return (
    <Screen hasHeader>
      <StoroBanner />
      {rows.length === 0 ? (
        <EmptyState icon="check-circle" title="Tout est envoyé" message="Aucune opération en attente d'envoi à Storo." />
      ) : (
        <>
          <Btn title={syncing ? 'Envoi en cours…' : 'Envoyer maintenant'} disabled={syncing || pending.length === 0} onPress={() => { void runSync('manual'); }} />
          {parked.length > 0 && <><H2>Refusées par Storo ({parked.length})</H2>{parked.map((r) => rowCard(r, 'parked'))}</>}
          {pending.length > 0 && <><H2>En attente d'envoi ({pending.length})</H2>{pending.slice(0, 200).map((r) => rowCard(r, 'pending'))}</>}
          {pending.length > 200 && <Muted>… et {pending.length - 200} autres.</Muted>}
          {foreign.length > 0 && (
            <>
              <H2>Autre organisation ({foreign.length})</H2>
              <Muted>Ces opérations appartiennent à une organisation dont ce téléphone n'est plus membre : elles ne seront pas envoyées.</Muted>
              {foreign.map((r) => rowCard(r, 'foreign'))}
            </>
          )}
        </>
      )}
    </Screen>
  );
}
