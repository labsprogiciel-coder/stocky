/**
 * Accueil de l'espace organisation (Storo) : espace de travail, bandeaux,
 * site courant, synchronisation, comptages ouverts, Entrée / Sortie.
 */
import { useCallback, useRef, useState } from 'react';
import { Alert, Pressable, Text, View } from 'react-native';
import { Redirect, router, useFocusEffect } from 'expo-router';
import { Btn, Card, EmptyState, H1, H2, Icon, Muted, Progress, Row, Screen } from '../../components/ui';
import { StoroBanner } from '../../components/storo/StoroBanner';
import { WorkspaceSwitcher } from '../../components/storo/WorkspaceSwitcher';
import { colors } from '../../constants/theme';
import { ORG_TIMER_MS } from '../../constants/storo';
import { fmtCount, fmtDateTime } from '../../data/store';
import { lookupCode } from '../../data/storo/mapping';
import { consumePendingStoroScan, getAllOrgItems, getSites, getSiteItems, getSiteTakes, setCurrentSiteId, setWorkspaceChoice } from '../../data/storo/orgStore';
import { runSync } from '../../data/storo/sync';
import { useOrgData, useOutboxSummary, useStoroSession, useSyncTimer } from '../../data/storo/useStoro';
import type { OrgTake } from '../../data/storo/mapping';

export default function OrgHome() {
  const { session, me, state, writable: canWrite } = useStoroSession();
  const { siteId, site, sync, syncing, online } = useOrgData();
  const box = useOutboxSummary();
  const [picking, setPicking] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const moveMode = useRef<'Entrée' | 'Sortie'>('Entrée');
  useSyncTimer(ORG_TIMER_MS);

  // Dernier espace choisi : rouvert au prochain lancement (app/_layout.tsx).
  useFocusEffect(
    useCallback(() => {
      if (session) setWorkspaceChoice('org');
    }, [session]),
  );

  // Retour du scanner (Entrée / Sortie) : code recherché parmi les articles du site.
  useFocusEffect(
    useCallback(() => {
      const code = consumePendingStoroScan('move');
      if (!code) return;
      const item = lookupCode(getAllOrgItems(), siteId, code);
      if (!item) {
        Alert.alert('Article inconnu', `Article inconnu sur ce site (${site?.name ?? '—'}).`);
        return;
      }
      router.push({ pathname: '/storo/move', params: { itemId: item.id, mode: moveMode.current } });
    }, [siteId, site?.name]),
  );

  if (!session) return <Redirect href="/(tabs)" />;

  const writable = canWrite;
  const sites = getSites();
  const takes = getSiteTakes(siteId);
  const memberId = me?.attributedMemberId ?? null;
  const mine = takes.filter((t) => memberId !== null && (t.teamLeadId === memberId || t.memberIds.includes(memberId)));
  const others = takes.filter((t) => !mine.includes(t));
  const itemCount = siteId ? getSiteItems(siteId).length : 0;

  const syncNow = async () => {
    setSyncMsg(null);
    const r = await runSync('manual');
    if (!r.ok && r.message) setSyncMsg(r.message);
  };

  const startMove = (mode: 'Entrée' | 'Sortie') => {
    moveMode.current = mode;
    router.push({ pathname: '/scan', params: { storo: 'move' } });
  };

  const showPicker = picking || (!siteId && sites.length > 0);

  return (
    <Screen>
      <View style={{ gap: 10 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <WorkspaceSwitcher current="org" />
          <Pressable accessibilityRole="button" accessibilityLabel="Réglages Storo" onPress={() => router.push('/storo/settings')} style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="settings" color={colors.primary} />
          </Pressable>
        </View>
        <H1>{site?.name ?? 'Choisissez un site'}</H1>
        {site?.address ? <Muted>{site.address}</Muted> : null}
      </View>

      <StoroBanner />

      {showPicker && (
        <Card style={{ padding: 0, overflow: 'hidden' }}>
          <View style={{ padding: 12 }}><H2>Site</H2></View>
          {sites.map((s) => (
            <Row key={s.id} onPress={() => { setCurrentSiteId(s.id); setPicking(false); }} accessibilityLabel={`Site ${s.name}`}>
              <Icon name="map-pin" size={18} color={colors.primary} />
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 15, fontWeight: s.id === siteId ? '700' : '600', color: colors.text }}>{s.name}</Text>
                {s.address ? <Muted>{s.address}</Muted> : null}
              </View>
              {s.id === siteId && <Icon name="check" size={18} color={colors.primary} />}
            </Row>
          ))}
        </Card>
      )}
      {sites.length === 0 && (
        <EmptyState
          icon="cloud"
          title={syncing ? 'Synchronisation…' : 'Aucune donnée Storo'}
          message="Les sites, articles et comptages de l'organisation apparaîtront après la première synchronisation."
          primaryAction={{ label: 'Synchroniser', onPress: () => { void syncNow(); } }}
        />
      )}

      {siteId && (
        <>
          {!showPicker && sites.length > 1 && <Btn title="Changer de site" variant="outline" onPress={() => setPicking(true)} />}

          <View style={{ flexDirection: 'row', gap: 8 }}>
            {(['Entrée', 'Sortie'] as const).map((m) => (
              <Pressable
                key={m}
                accessibilityRole="button"
                accessibilityLabel={`${m} de stock`}
                accessibilityState={{ disabled: !writable }}
                disabled={!writable}
                onPress={() => startMove(m)}
                style={{ flex: 1, minHeight: 88, borderRadius: 14, alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: m === 'Entrée' ? colors.primary : '#fff', borderWidth: m === 'Entrée' ? 0 : 1, borderColor: colors.field, opacity: writable ? 1 : 0.4 }}
              >
                <Icon name={m === 'Entrée' ? 'arrow-down-circle' : 'arrow-up-circle'} size={26} color={m === 'Entrée' ? '#fff' : colors.text} />
                <Text style={{ fontSize: 13, fontWeight: '600', color: m === 'Entrée' ? '#fff' : colors.text }}>{m}</Text>
              </Pressable>
            ))}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Articles du site"
              onPress={() => router.push('/storo/items')}
              style={{ flex: 1, minHeight: 88, borderRadius: 14, alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: '#fff', borderWidth: 1, borderColor: colors.field }}
            >
              <Icon name="box" size={26} />
              <Text style={{ fontSize: 13, fontWeight: '600', color: colors.text }}>{fmtCount(itemCount, 'article', 'articles')}</Text>
            </Pressable>
          </View>

          <H2>Mes comptages</H2>
          {mine.length === 0 ? (
            <Muted>{memberId ? 'Aucun comptage ouvert ne vous est attribué sur ce site.' : 'Ce téléphone n’est attribué à aucun membre : les comptages ouverts sont listés ci-dessous.'}</Muted>
          ) : (
            mine.map((t) => <TakeCard key={t.id} take={t} />)
          )}
          {others.length > 0 && (
            <>
              <H2>Autres comptages ouverts</H2>
              {others.map((t) => <TakeCard key={t.id} take={t} />)}
            </>
          )}
        </>
      )}

      <Card style={{ gap: 10 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: online === false ? colors.warnText : colors.primary }} />
          <Text style={{ flex: 1, fontSize: 14, fontWeight: '600', color: colors.text }}>
            {syncing ? 'Synchronisation en cours…' : sync.lastOkAt ? `Synchronisé le ${fmtDateTime(sync.lastOkAt)}` : 'Jamais synchronisé'}
          </Text>
        </View>
        <Muted>
          {box.pending > 0 ? `${fmtCount(box.pending, 'opération', 'opérations')} en attente d'envoi` : 'Aucune opération en attente'}
          {box.parked > 0 ? ` · ${fmtCount(box.parked, 'refusée', 'refusées')}` : ''}
        </Muted>
        {sync.lastError && !syncing ? <Muted style={{ color: colors.warnText }}>{sync.lastError.message}</Muted> : null}
        {syncMsg ? <Muted style={{ color: colors.warnText }}>{syncMsg}</Muted> : null}
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Btn title="Synchroniser" style={{ flex: 1 }} disabled={syncing || session.readonlyReason === 'unpaired'} onPress={() => { void syncNow(); }} />
          <Btn title="Opérations" variant="outline" style={{ flex: 1 }} onPress={() => router.push('/storo/outbox')} />
        </View>
      </Card>
    </Screen>
  );
}

function TakeCard({ take }: { take: OrgTake }) {
  const done = take.totalItems > 0 ? Math.min(1, take.countedItems / take.totalItems) : 0;
  return (
    <Card style={{ gap: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Text style={{ flex: 1, fontSize: 16, fontWeight: '600', color: colors.text }}>{take.reference}</Text>
        <Text style={{ fontSize: 12, fontWeight: '700', color: take.closed ? colors.muted : take.status === 'in_progress' ? colors.primary : colors.warnText }}>
          {take.closed ? 'Clôturé dans Storo' : take.status === 'in_progress' ? 'En cours' : 'Planifié'}
        </Text>
      </View>
      <Muted>{take.scheduledDate ? `Prévu le ${take.scheduledDate.split('-').reverse().join('/')}` : 'Sans date'} · {take.countedItems} / {take.totalItems} articles comptés dans Storo</Muted>
      <Progress value={done} />
      <Btn title={take.closed ? 'Voir' : 'Compter'} variant={take.closed ? 'outline' : 'primary'} onPress={() => router.push(`/storo/take/${take.id}`)} />
    </Card>
  );
}

