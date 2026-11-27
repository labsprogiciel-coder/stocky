/**
 * Migration du stock local vers Storo (contrat §6.5) : aperçu de ce qui sera
 * envoyé, envoi, attente de la validation par un responsable (suivi toutes
 * les 30 s), résultat. Le stock local n'est jamais effacé.
 */
import { useCallback, useState } from 'react';
import { Alert, Text, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { Alert as InlineAlert, Btn, Card, H2, Muted, Row, Screen } from '../../components/ui';
import { BannerView } from '../../components/storo/StoroBanner';
import { colors } from '../../constants/theme';
import { MIGRATION_POLL_MS } from '../../constants/storo';
import { fmtCount, fmtDateTime } from '../../data/store';
import {
  REVIEW_NOTICE,
  SERIALS_WARNING,
  SUSPENDED_NOTICE,
  abandonMigrationLocally,
  cancelMigration,
  checkMigration,
  getLocalMigration,
  isMigrationSuspended,
  previewMigration,
  resetMigration,
  startMigration,
} from '../../data/storo/migration';
import { setWorkspaceChoice } from '../../data/storo/orgStore';
import { runSync } from '../../data/storo/sync';
import { useLocalMigration, useStoroSession } from '../../data/storo/useStoro';

export default function Migrate() {
  const { session } = useStoroSession();
  const { migration, archive } = useLocalMigration();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const preview = previewMigration();
  const org = session?.orgName || 'votre organisation';
  const state = migration?.state;
  // Migration validée puis stock local réactivé (archive supprimée) : un nouvel envoi est possible.
  const ended = state === 'rejected' || state === 'expired' || state === 'cancelled' || state === 'failed' || (state === 'approved' && !archive);

  // Suivi toutes les 30 s tant que l'écran est affiché et la migration en attente.
  useFocusEffect(
    useCallback(() => {
      if (state !== 'pending_review' && state !== 'submitting') return;
      const tick = async () => {
        if (state === 'submitting') { await runSync('migration'); return; }
        await checkMigration();
        // Validée : les articles créés arrivent par la synchronisation.
        if (getLocalMigration()?.state === 'approved') void runSync('migration');
      };
      void tick();
      const id = setInterval(() => { void tick(); }, MIGRATION_POLL_MS);
      return () => clearInterval(id);
    }, [state]),
  );

  const send = () => {
    Alert.alert(
      'Envoyer le stock à Storo ?',
      `${fmtCount(preview.items, 'article', 'articles')} et leurs quantités seront proposés à ${org}. ${REVIEW_NOTICE}`,
      [
        { text: 'Annuler', style: 'cancel' },
        {
          text: 'Envoyer',
          onPress: async () => {
            setBusy(true);
            setError(null);
            const err = await startMigration();
            setBusy(false);
            if (err) setError(err);
          },
        },
      ],
    );
  };

  const cancel = () => {
    Alert.alert('Annuler la migration ?', 'Le transfert ne sera pas proposé au responsable et votre stock local redevient modifiable.', [
      { text: 'Non', style: 'cancel' },
      { text: 'Annuler la migration', style: 'destructive', onPress: async () => { setBusy(true); const err = await cancelMigration(); setBusy(false); if (err) setError(err); } },
    ]);
  };

  const abandon = () => {
    Alert.alert(
      'Abandonner sur ce téléphone ?',
      "Storo est injoignable avec ce téléphone : la migration ne peut pas y être annulée. Si elle y attend encore une validation, demandez à un responsable de la rejeter.",
      [
        { text: 'Non', style: 'cancel' },
        { text: 'Abandonner', style: 'destructive', onPress: () => { const err = abandonMigrationLocally(); if (err) setError(err); } },
      ],
    );
  };

  const restart = () => {
    const err = resetMigration();
    if (err) setError(err);
  };

  // ── Résultat ─────────────────────────────────────────────────────────────
  if (migration && state === 'approved' && archive && migration.result) {
    const res = migration.result;
    const sum = res.result;
    const names = migration.names ?? {};
    return (
      <Screen hasHeader>
        <BannerView tone="info" text={sum ? `Transfert terminé : ${sum.created} créés, ${sum.linked} liés, ${sum.skipped} ignorés.` : 'Transfert terminé.'} />
        <Card style={{ gap: 4 }}>
          <Text style={{ fontSize: 15, fontWeight: '600', color: colors.text }}>Site : {res.siteName || '—'}</Text>
          {res.decidedAt ? <Muted>Validé le {fmtDateTime(res.decidedAt)}{res.decidedByName ? ` par ${res.decidedByName}` : ''}</Muted> : null}
          <Muted>Votre stock local est archivé (lecture seule) et reste consultable dans « Mon stock ».</Muted>
        </Card>
        <Btn title={`Ouvrir ${org}`} onPress={() => { setWorkspaceChoice('org'); void runSync('migration'); router.replace('/storo'); }} />
        {res.mapping.length > 0 && (
          <>
            <H2>Détail</H2>
            <Card style={{ padding: 0, overflow: 'hidden' }}>
              {res.mapping.map((m) => {
                const local = names[m.localItemId];
                return (
                  <Row key={m.localItemId}>
                    <View style={{ flex: 1, gap: 2 }}>
                      <Text style={{ fontSize: 14, fontWeight: '600', color: colors.text }}>{local?.name ?? m.localItemId}</Text>
                      <Muted style={{ fontSize: 12 }}>
                        {m.action === 'create' ? 'Créé' : m.action === 'link' ? 'Lié' : 'Ignoré'}
                        {local?.sku ? ` · ${local.sku}` : ''}
                        {m.qtyApplied !== null ? ` · quantité ${m.qtyApplied}` : ''}
                        {m.qtyPolicy === 'keep_storo' ? ' (stock Storo conservé)' : m.qtyPolicy === 'take_phone' ? ' (stock du téléphone)' : ''}
                      </Muted>
                    </View>
                  </Row>
                );
              })}
            </Card>
          </>
        )}
      </Screen>
    );
  }

  // ── En cours ─────────────────────────────────────────────────────────────
  if (migration && (state === 'submitting' || state === 'pending_review' || state === 'building')) {
    const suspended = isMigrationSuspended(migration);
    return (
      <Screen hasHeader>
        <BannerView tone={suspended ? 'warning' : 'info'} text={suspended ? SUSPENDED_NOTICE : 'Transfert vers Storo en attente de validation par un responsable.'} />
        <Card style={{ gap: 6 }}>
          <Text style={{ fontSize: 15, fontWeight: '600', color: colors.text }}>
            {state === 'submitting' ? 'Envoi en cours…' : 'Envoyé, en attente de validation'}
          </Text>
          {migration.itemCount > 0 && <Muted>{fmtCount(migration.itemCount, 'article', 'articles')} · {fmtCount(migration.totalQty, 'unité', 'unités')}</Muted>}
          {migration.submittedAt ? <Muted>Envoyé le {fmtDateTime(migration.submittedAt)}</Muted> : null}
          {migration.lastCheckedAt ? <Muted>Vérifié le {fmtDateTime(migration.lastCheckedAt)}</Muted> : null}
          {!suspended && <Muted>Votre stock local est en lecture seule jusqu'à la décision.</Muted>}
        </Card>
        {error && <InlineAlert message={error} />}
        <Btn title="Vérifier maintenant" variant="outline" disabled={busy} onPress={() => { void runSync('manual'); }} />
        {suspended
          ? <Btn title="Abandonner sur ce téléphone" variant="danger" disabled={busy} onPress={abandon} />
          : <Btn title={state === 'submitting' ? "Abandonner l'envoi" : 'Annuler la migration'} variant="danger" disabled={busy} onPress={cancel} />}
      </Screen>
    );
  }

  // ── Aperçu (et issue d'une précédente tentative) ─────────────────────────
  return (
    <Screen hasHeader>
      {migration && state === 'rejected' && (
        <InlineAlert message={`Transfert refusé par ${org}${migration.rejectReason ? ` : ${migration.rejectReason}` : '.'} Votre stock local est de nouveau modifiable.`} />
      )}
      {migration && state === 'expired' && <InlineAlert message="Le transfert n'a pas été validé à temps (14 jours) : il a expiré." />}
      {migration && state === 'cancelled' && <InlineAlert message="Transfert annulé." />}
      {migration && state === 'failed' && <InlineAlert message={migration.error ?? 'Le transfert a échoué.'} />}
      {migration && ended && (
        <Btn title="Recommencer" variant="outline" onPress={restart} />
      )}

      <Card style={{ gap: 8 }}>
        <H2>Ce qui sera envoyé</H2>
        <Text style={{ fontSize: 15, color: colors.text }}>{fmtCount(preview.items, 'article', 'articles')} · {fmtCount(preview.units, 'unité en stock', 'unités en stock')}</Text>
        <Muted>Nom, SKU, code-barres, dossier, stock minimum, prix unitaire et quantité de chaque article.</Muted>
      </Card>
      <BannerView tone="warning" text={SERIALS_WARNING} />
      {preview.serialized.length > 0 && (
        <Card style={{ gap: 4 }}>
          <Muted style={{ fontWeight: '600' }}>Articles suivis par numéro de série (seule la quantité est transférée)</Muted>
          {preview.serialized.map((s) => <Muted key={s.id}>· {s.name} : {fmtCount(s.inStock, 'appareil en stock', 'appareils en stock')}</Muted>)}
        </Card>
      )}
      <Muted style={{ fontSize: 14, lineHeight: 20 }}>{REVIEW_NOTICE} Le responsable choisit le site, et pour chaque article déjà présent dans Storo, s'il garde le stock Storo ou celui du téléphone.</Muted>
      {(error ?? preview.blocked) && <InlineAlert message={(error ?? preview.blocked)!} />}
      <Btn
        title={busy ? 'Envoi…' : 'Envoyer à Storo'}
        disabled={busy || preview.blocked !== null || (migration !== null && state !== undefined && !ended)}
        onPress={send}
      />
      {migration && ended && (
        <Muted>Touchez « Recommencer » pour préparer un nouvel envoi.</Muted>
      )}
    </Screen>
  );
}
