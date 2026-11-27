/**
 * Réglages Storo : appareil, organisation, membre attribué, serveur,
 * « Dissocier », « Effacer les données Storo », stock local archivé.
 */
import { useState } from 'react';
import { Alert, Text, View } from 'react-native';
import { router } from 'expo-router';
import { Alert as InlineAlert, Btn, Card, H2, Muted, Screen } from '../../components/ui';
import { StoroBanner } from '../../components/storo/StoroBanner';
import { colors } from '../../constants/theme';
import { fmtCount, fmtDateTime } from '../../data/store';
import { canStartMigration, reactivateStandalone } from '../../data/storo/migration';
import { outboxSummary } from '../../data/storo/outbox';
import { setWorkspaceChoice } from '../../data/storo/orgStore';
import { unpair } from '../../data/storo/session';
import { eraseStoroData, runSync } from '../../data/storo/sync';
import { useLocalMigration, useOrgData, useStoroSession } from '../../data/storo/useStoro';

const STATE_LABELS: Record<string, string> = {
  unpaired: 'dissocié',
  device_inactive: 'appareil désactivé',
  org_suspended: 'organisation suspendue',
  entitlement: 'abonnement sans application mobile',
};

function Line({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 12, paddingVertical: 6 }}>
      <Muted>{label}</Muted>
      <Text selectable style={{ flexShrink: 1, textAlign: 'right', fontSize: 14, fontWeight: '600', color: colors.text }}>{value}</Text>
    </View>
  );
}

export default function StoroSettings() {
  const { session, me, state } = useStoroSession();
  const { sync } = useOrgData();
  const { archive, migration } = useLocalMigration();
  const [error, setError] = useState<string | null>(null);
  const org = session?.orgName || 'l’organisation';

  const doUnpair = () => {
    const n = outboxSummary().pending + outboxSummary().parked;
    Alert.alert(
      'Dissocier ce téléphone',
      `Dissocier ce téléphone de ${org} ? Les opérations non envoyées (${n}) seront conservées et envoyées si vous l'associez à nouveau.`,
      [{ text: 'Annuler', style: 'cancel' }, { text: 'Dissocier', style: 'destructive', onPress: () => { void unpair(); } }],
    );
  };

  const doErase = () => {
    const n = outboxSummary().total;
    Alert.alert(
      'Effacer les données Storo',
      `Effacer les données de ${org} de ce téléphone ? ${fmtCount(n, 'opération non envoyée sera perdue', 'opérations non envoyées seront perdues')}.`,
      [
        { text: 'Annuler', style: 'cancel' },
        {
          text: 'Effacer', style: 'destructive', onPress: async () => {
            const err = await eraseStoroData();
            if (err) { setError(err); return; }
            router.replace('/(tabs)');
          },
        },
      ],
    );
  };

  const doReactivate = () => {
    Alert.alert('Réactiver le stock local', 'Les modifications du stock local ne seront pas envoyées à Storo.', [
      { text: 'Annuler', style: 'cancel' },
      { text: 'Réactiver', onPress: () => { const err = reactivateStandalone(); if (err) setError(err); } },
    ]);
  };

  return (
    <Screen hasHeader>
      <StoroBanner />
      {session ? (
        <Card style={{ gap: 2 }}>
          <H2>{org}</H2>
          <Line label="État" value={state === 'active' ? 'connecté' : `lecture seule (${STATE_LABELS[session.readonlyReason ?? ''] ?? '—'})`} />
          <Line label="Membre attribué" value={me?.attributedMemberName ?? (me?.attributedMemberId ? 'oui' : 'aucun')} />
          <Line label="Code du téléphone" value={session.serialNumber || '—'} />
          <Line label="Appareil" value={me?.device?.name ?? session.deviceId} />
          <Line label="Serveur" value={session.apiBase.replace(/^https:\/\//, '').split('/')[0]} />
          <Line label="Associé le" value={fmtDateTime(session.pairedAt)} />
          <Line label="Dernière synchronisation" value={sync.lastOkAt ? fmtDateTime(sync.lastOkAt) : 'jamais'} />
          {me?.entitlements?.stocklyMobileValidUntil ? <Line label="Abonnement mobile jusqu'au" value={fmtDateTime(me.entitlements.stocklyMobileValidUntil)} /> : null}
        </Card>
      ) : (
        <Card style={{ gap: 10 }}>
          <Muted>Ce téléphone n'est associé à aucune organisation Storo.</Muted>
          <Btn title="Connecter à Storo" onPress={() => router.push('/storo/connect')} />
        </Card>
      )}

      {session && (
        <View style={{ gap: 8 }}>
          {state === 'active' && <Btn title="Synchroniser" variant="outline" onPress={() => { void runSync('manual'); }} />}
          <Btn title={state === 'active' ? "Changer d'organisation" : 'Associer à nouveau'} variant="outline" onPress={() => router.push('/storo/connect')} />
          {session.readonlyReason !== 'unpaired' && <Btn title="Dissocier ce téléphone" variant="danger" onPress={doUnpair} />}
          {state !== 'active' && <Btn title="Effacer les données Storo" variant="danger" onPress={doErase} />}
        </View>
      )}

      <H2>Mon stock (local)</H2>
      {archive ? (
        <Card style={{ gap: 8 }}>
          <Muted>Transféré dans Storo le {fmtDateTime(archive.archivedAt)} : le stock local est archivé (lecture seule) et reste consultable.</Muted>
          <Btn title="Ouvrir Mon stock" variant="outline" onPress={() => { setWorkspaceChoice('standalone'); router.replace('/(tabs)'); }} />
          <Btn title="Réactiver le stock local" variant="outline" onPress={doReactivate} />
        </Card>
      ) : (
        <Card style={{ gap: 8 }}>
          <Muted>
            {migration?.state === 'pending_review' || migration?.state === 'submitting'
              ? 'Transfert vers Storo en attente de validation par un responsable.'
              : 'Transférez vos articles et leurs quantités dans Storo ; un responsable valide le transfert.'}
          </Muted>
          <Btn title="Migrer mon stock vers Storo" variant="outline" disabled={!session || (canStartMigration() !== null && !migration)} onPress={() => router.push('/storo/migrate')} />
        </Card>
      )}
      {error && <InlineAlert message={error} />}
    </Screen>
  );
}
