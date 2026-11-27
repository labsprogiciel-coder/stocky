/**
 * Corrections issues de la revue de l'intégration Storo : changement
 * d'organisation (jeton, migration), adresse du serveur, reprise après
 * attente, migration (annulation, reprise, suspension), comptages en cours
 * d'envoi, journal des écritures, conflits passagers.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { API, DEVICE, ORG, T0, apiError, itemRow, pairActive, reply, seed, setup, type Call, type Env } from './helpers';

afterEach(() => { vi.restoreAllMocks(); });

const ME = { device: { status: 'active' }, organization: { id: ORG, name: 'Pharmacie du Port', currency: 'XOF' }, attributedMemberId: 'm1', entitlements: { stocklyMobile: true }, serverTime: T0 };
const migration = (status: string, extra: Record<string, unknown> = {}) => ({ id: 'MIG1', clientId: 'c', deviceId: DEVICE, status, itemCount: 1, totalQty: 0, expiresAt: T0 + 14 * 86_400_000, ...extra });

function addItems(env: Env, n: number) {
  for (let i = 0; i < n; i++) {
    const r = env.store.createItem({ name: `Article ${i}`, folder: 'Pharmacie', qty: i, min: 0, price: 100 } as never);
    if (r.error) throw new Error(r.error);
  }
}

const empty = { serverTime: T0, cursor: 'c-end', hasMore: false, sites: { upserts: [] }, stockTakes: { upserts: [] }, items: { upserts: [] } };

describe('changement d\'organisation', () => {
  it('the new token is stored only on confirm; sync waits while the confirmation is open', async () => {
    const env = await setup({ handler: (c: Call) => {
      if (c.path === '/device-pairing/qr/claim') return reply(201, { deviceId: 'D2', deviceToken: 'tok-b', orgId: 'ORG-B', apiBase: API });
      if (c.path === '/device/me') return reply(200, { ...ME, organization: { id: 'ORG-B', name: 'Org B' } });
      if (c.path === '/sync/push') return reply(200, { countEntries: [], movements: [] });
      if (c.path.startsWith('/sync/pull')) return reply(200, empty);
      return reply(404);
    } });
    await pairActive(env);
    seed(env);
    env.outbox.enqueueMovement('i1', 'Entrée', 1);
    const out = await env.session.claimQr({ apiBase: API, token: 'pt', expiresAt: null });
    if (out.kind !== 'confirm') throw new Error('confirm expected');
    // Pendant la confirmation : ancien jeton intact, aucune requête de synchronisation.
    expect(await env.sec.get(env.kv.TOKEN_KEY)).toBe('tok-1');
    expect(await env.session.getToken()).toBe('tok-1');
    expect(await env.sync.runSync('foreground')).toEqual({ ok: false, stopped: 'busy' });
    expect(env.calls.some((c) => c.path === '/sync/push' || c.path.startsWith('/sync/pull'))).toBe(false);
    expect(env.session.getSession()?.orgName).toBe('Pharmacie du Port');
    await out.cancel();
    expect(await env.sync.runSync('foreground')).toEqual({ ok: true });
    const push = env.calls.find((c) => c.path === '/sync/push');
    expect(push?.headers.Authorization).toBe('Device tok-1');

    const again = await env.session.claimQr({ apiBase: API, token: 'pt', expiresAt: null });
    if (again.kind !== 'confirm') throw new Error('confirm expected');
    expect(await env.sec.get(env.kv.TOKEN_KEY)).toBe('tok-1');
    expect(await again.confirm()).toEqual({ kind: 'paired' });
    expect(await env.sec.get(env.kv.TOKEN_KEY)).toBe('tok-b');
    expect(env.session.getSession()).toMatchObject({ orgId: 'ORG-B', deviceId: 'D2' });
  });

  it('a pending migration blocks pairing to another organisation; a foreign migration is never sent', async () => {
    const env = await setup({ handler: (c: Call) => {
      if (c.path === '/device-pairing/qr/claim') return reply(201, { deviceId: 'D2', deviceToken: 'tok-b', orgId: 'ORG-B', apiBase: API });
      if (c.path === '/device/migrations') return 'network';
      return reply(404);
    } });
    await pairActive(env);
    addItems(env, 1);
    expect(await env.migration.startMigration()).toBeNull();
    expect(env.migration.getLocalMigration()?.state).toBe('submitting');
    const out = await env.session.claimQr({ apiBase: API, token: 'pt', expiresAt: null });
    expect(out).toEqual({ kind: 'error', message: env.session.MIGRATION_BLOCKS_SWITCH });
    expect(await env.sec.get(env.kv.TOKEN_KEY)).toBe('tok-1');
    expect(env.session.getSession()?.orgId).toBe(ORG);

    // Défense : une migration préparée pour une autre organisation n'est ni envoyée ni lue.
    const m = env.migration.getLocalMigration()!;
    env.mem.set(env.kv.ORG_KEYS.migration, JSON.stringify({ ...m, orgId: 'ORG-OTHER' }));
    env.migration.reloadMigration();
    const before = env.calls.filter((c) => c.path === '/device/migrations').length;
    const r = await env.migration.tickMigration();
    expect(r.ok).toBe(false);
    expect(env.calls.filter((c) => c.path === '/device/migrations').length).toBe(before);
    expect(env.migration.getLocalMigration()).toMatchObject({ state: 'failed', error: env.migration.OTHER_ORG });
  });
});

describe('apiBase de l\'association', () => {
  it('an http or foreign apiBase in the claim response is ignored; a stored unsafe one is refused', async () => {
    const env = await setup({ handler: (c: Call) => {
      if (c.path === '/device-pairing/qr/claim') return reply(201, { deviceId: DEVICE, deviceToken: 'tok-n', orgId: ORG, apiBase: 'http://storo.test/api/v1' });
      if (c.path === '/device/me') return reply(200, ME);
      return reply(404);
    } });
    expect(await env.session.claimQr({ apiBase: API, token: 'pt', expiresAt: null })).toEqual({ kind: 'paired' });
    expect(env.session.getSession()?.apiBase).toBe(API);
    expect(env.calls.filter((c) => c.path === '/device/me').every((c) => c.url.startsWith(API))).toBe(true);

    expect(env.session.pairingApiBase('https://evil.test/api/v1', API)).toBe(API);
    expect(env.session.pairingApiBase('https://storo.test/api/v2', API)).toBe('https://storo.test/api/v2');
    expect(env.session.pairingApiBase(undefined, API)).toBe(API);

    const stored = JSON.parse(env.mem.get(env.kv.ORG_KEYS.session)!);
    env.mem.set(env.kv.ORG_KEYS.session, JSON.stringify({ ...stored, apiBase: 'http://storo.test/api/v1' }));
    env.session.reloadSession();
    expect(env.session.getSession()).toBeNull();
  });
});

describe('reprise après une attente de transport', () => {
  it('network return / foreground lift the backoff, except a Retry-After; the global timer retries sendable rows', async () => {
    let down = true;
    const env = await setup({ handler: (c: Call) => {
      if (down) return 'network';
      if (c.path === '/sync/push') {
        const b = c.json as { movements: { clientId: string }[] };
        return reply(200, { countEntries: [], movements: b.movements.map((m) => ({ clientId: m.clientId, status: 'created' })) });
      }
      if (c.path.startsWith('/sync/pull')) return reply(200, empty);
      return reply(404);
    } });
    await pairActive(env);
    seed(env);
    env.outbox.enqueueMovement('i1', 'Entrée', 1);
    for (let i = 0; i < 4; i++) await env.sync.runSync('manual');
    expect(env.orgStore.getSyncMeta().nextTryAt).toBe(T0 + 600_000);
    expect(await env.sync.runSync('timer')).toMatchObject({ stopped: 'backoff' });
    expect(env.sync.shouldRetry(ORG, env.clock.now())).toBe(false);
    down = false;
    expect(await env.sync.runSync('online')).toEqual({ ok: true });
    expect(env.orgStore.getOutboxRows()).toHaveLength(0);

    // 429 Retry-After : respecté même au retour du réseau.
    env.setHandler(() => apiError(429, 'RATE_LIMITED', {}, { 'Retry-After': '120' }));
    env.outbox.enqueueMovement('i1', 'Entrée', 1);
    await env.sync.runSync('manual');
    expect(await env.sync.runSync('online')).toMatchObject({ stopped: 'backoff' });
    expect(await env.sync.runSync('foreground')).toMatchObject({ stopped: 'backoff' });
    env.clock.advance(121_000);
    expect(env.sync.shouldRetry(ORG, env.clock.now())).toBe(true);
  });
});

describe('migration : annulation, reprise, suspension', () => {
  it('cancelling an unconfirmed upload resends it, then cancels it in Storo (offline: refused)', async () => {
    let net = false;
    const env = await setup({ handler: (c: Call) => {
      if (!net) return 'network';
      if (c.path === '/device/migrations') return reply(200, { migration: migration('pending_review') }, { 'Idempotent-Replayed': 'true' });
      if (c.path === '/device/migrations/MIG1/cancel') return reply(200, { migration: migration('cancelled') });
      return reply(404);
    } });
    await pairActive(env);
    addItems(env, 1);
    await env.migration.startMigration();
    const body = env.migration.getLocalMigration()!.body;
    expect(await env.migration.cancelMigration()).toBe(env.migration.CANCEL_OFFLINE);
    expect(env.migration.getLocalMigration()?.state).toBe('submitting');
    expect(env.store.standaloneReadonlyMessage()).toBe(env.migration.GUARD_PENDING);
    net = true;
    expect(await env.migration.cancelMigration()).toBeNull();
    const posts = env.calls.filter((c) => c.path === '/device/migrations');
    expect(posts.at(-1)?.body).toBe(body);
    expect(env.calls.some((c) => c.path === '/device/migrations/MIG1/cancel')).toBe(true);
    expect(env.migration.getLocalMigration()).toMatchObject({ state: 'cancelled', migrationId: 'MIG1' });
  });

  it('an upload Storo never stored (400) is abandoned locally on cancel', async () => {
    let n = 0;
    const env = await setup({ handler: () => (n++ === 0 ? 'network' : apiError(400, 'VALIDATION', { fields: {} })) });
    await pairActive(env);
    addItems(env, 1);
    await env.migration.startMigration();
    expect(await env.migration.cancelMigration()).toBeNull();
    expect(env.migration.getLocalMigration()?.state).toBe('cancelled');
  });

  it('a stale /device/me pendingMigrationId does not re-adopt a cancelled or reset migration', async () => {
    const env = await setup({ handler: (c: Call) => {
      if (c.path === '/device/migrations') return reply(201, { migration: migration('pending_review') });
      if (c.path === '/device/migrations/MIG1/cancel') return reply(200, { migration: migration('cancelled') });
      if (c.path === '/device/migrations/MIG1') return reply(200, { migration: migration('cancelled'), mapping: null });
      return reply(404);
    } });
    await pairActive(env);
    addItems(env, 1);
    await env.migration.startMigration();
    const me = JSON.parse(env.mem.get(env.kv.ORG_KEYS.me)!);
    env.mem.set(env.kv.ORG_KEYS.me, JSON.stringify({ ...me, pendingMigrationId: 'MIG1' }));
    env.session.reloadSession();
    expect(await env.migration.cancelMigration()).toBeNull();
    expect(env.session.getMe()?.pendingMigrationId).toBeNull();

    // Cache encore périmé (ex. relu avant l'annulation) : pas de reprise de MIG1.
    env.mem.set(env.kv.ORG_KEYS.me, JSON.stringify({ ...me, pendingMigrationId: 'MIG1' }));
    env.session.reloadSession();
    await env.migration.tickMigration();
    expect(env.migration.getLocalMigration()).toMatchObject({ state: 'cancelled', migrationId: 'MIG1' });
    expect(env.store.standaloneReadonlyMessage()).toBeNull();

    // « Recommencer » efface aussi la mention en cache.
    expect(env.migration.resetMigration()).toBeNull();
    expect(env.session.getMe()?.pendingMigrationId).toBeNull();
    await env.migration.tickMigration();
    expect(env.migration.getLocalMigration()).toBeNull();
  });

  it('read-only session or expired copy: guard lifted (suspended), abandon locally keeps the outbox', async () => {
    const env = await setup({ handler: (c: Call) => (c.path === '/device/migrations' ? reply(201, { migration: migration('pending_review') }) : reply(404)) });
    await pairActive(env);
    seed(env);
    env.outbox.enqueueMovement('i1', 'Entrée', 1);
    addItems(env, 1);
    await env.migration.startMigration();
    expect(env.migration.getLocalMigration()).toMatchObject({ state: 'pending_review', expiresAt: T0 + 14 * 86_400_000 });
    expect(env.store.standaloneReadonlyMessage()).toBe(env.migration.GUARD_PENDING);
    expect(env.migration.abandonMigrationLocally()).not.toBeNull(); // session active : annuler, pas abandonner

    await env.session.setReadonly('entitlement', { feature: 'stockly_mobile' });
    expect(env.migration.isMigrationSuspended()).toBe(true);
    expect(env.store.standaloneReadonlyMessage()).toBeNull();
    expect(env.store.adjustStock(env.store.getItems()[0].id, 3)).toBeNull();

    expect(env.migration.abandonMigrationLocally()).toBeNull();
    expect(env.migration.getLocalMigration()).toMatchObject({ state: 'failed', error: env.migration.ABANDONED_LOCALLY });
    expect(env.orgStore.getOutboxRows()).toHaveLength(1);
  });

  it('a copy past its expiry no longer locks the local stock', async () => {
    const env = await setup({ handler: (c: Call) => (c.path === '/device/migrations' ? reply(201, { migration: migration('pending_review') }) : reply(404)) });
    await pairActive(env);
    addItems(env, 1);
    await env.migration.startMigration();
    env.clock.advance(14 * 86_400_000 + 1);
    expect(env.migration.isMigrationSuspended()).toBe(true);
    expect(env.store.standaloneReadonlyMessage()).toBeNull();
  });
});

describe('comptages en cours d\'envoi', () => {
  it('a recount or Passé during the push keeps the in-flight row (no silent duplicate)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const env = await setup({ handler: async (c: Call) => {
      if (c.path === '/sync/push') {
        await gate;
        const b = c.json as { countEntries: { clientId: string }[] };
        return reply(200, { countEntries: b.countEntries.map((e) => ({ clientId: e.clientId, status: 'created' })), movements: [] });
      }
      if (c.path.startsWith('/sync/pull')) return reply(200, empty);
      return reply(404);
    } });
    await pairActive(env);
    seed(env);
    env.outbox.recordCount('t1', 'i1', 5, 'Compté');
    env.outbox.recordCount('t1', 'i2', 7, 'Compté');
    const running = env.sync.runSync('manual');
    await vi.waitFor(() => expect(env.outbox.isInFlight(`${DEVICE}:ce:t1:i1:1`)).toBe(true));
    expect(env.outbox.recordCount('t1', 'i1', 6, 'Compté')).toBeNull();
    expect(env.outbox.recordCount('t1', 'i2', 0, 'Passé')).toBeNull();
    expect(env.orgStore.getOutboxRows().map((r) => r.clientId)).toEqual([`${DEVICE}:ce:t1:i1:1`, `${DEVICE}:ce:t1:i2:1`, `${DEVICE}:ce:t1:i1:2`]);
    release();
    await running;
    // rev 1 enregistrée par Storo ; la rev 2, saisie pendant l'envoi, part dans la requête suivante
    // (chaque requête est composée depuis la file actuelle) : rien n'est perdu ni caché.
    expect(env.orgStore.getOutboxRows()).toEqual([]);
    expect(await env.sync.runSync('manual')).toEqual({ ok: true });
    expect(env.orgStore.getCount('t1')?.entries.i1).toMatchObject({ rev: 2, sentRev: 2 });
    expect(env.orgStore.getCount('t1')?.entries.i2).toMatchObject({ status: 'Passé', sentRev: 1 });
    expect(env.outbox.isInFlight(`${DEVICE}:ce:t1:i1:1`)).toBe(false);
  });
});

describe('révisions et journal', () => {
  it('a recount never reuses a revision still in the outbox or already sent', async () => {
    const env = await setup();
    await pairActive(env);
    seed(env);
    env.outbox.recordCount('t1', 'i1', 5, 'Compté');
    // Comptages restés à l'état précédent (écriture perdue) alors que la file a la rév. 1.
    env.mem.set(env.kv.ORG_KEYS.counts, JSON.stringify({}));
    env.orgStore.reloadOrgStore();
    env.outbox.recordCount('t1', 'i1', 6, 'Compté');
    expect(env.orgStore.getOutboxRows().map((r) => r.clientId)).toEqual([`${DEVICE}:ce:t1:i1:2`]);
  });

  it('an outbox commit is journaled and replayed after an interruption', async () => {
    const env = await setup();
    await pairActive(env);
    seed(env);
    env.outbox.recordCount('t1', 'i1', 5, 'Compté');
    expect(env.mem.get(env.kv.ORG_KEYS.txn)).toBeUndefined();
    const outbox = JSON.parse(env.mem.get(env.kv.ORG_KEYS.outbox)!);
    const counts = JSON.parse(env.mem.get(env.kv.ORG_KEYS.counts)!);
    // Arrêt simulé : journal écrit, file écrite, comptages pas encore.
    env.mem.set(env.kv.ORG_KEYS.txn, JSON.stringify({ parts: { outbox: [], counts: {} } }));
    env.mem.set(env.kv.ORG_KEYS.outbox, JSON.stringify([]));
    env.orgStore.reloadOrgStore();
    expect(env.orgStore.getOutboxRows()).toEqual([]);
    expect(env.orgStore.getAllCounts()).toEqual({});
    expect(env.mem.get(env.kv.ORG_KEYS.txn)).toBeUndefined();
    expect(outbox).toHaveLength(1);
    expect(counts.t1.entries.i1.rev).toBe(1);
  });
});

describe('conflits passagers', () => {
  it('CONFLICT without a reason is retried; stock_take_closed is parked', async () => {
    const env = await setup();
    await pairActive(env);
    seed(env, [itemRow('i1'), itemRow('i2')]);
    env.outbox.recordCount('t1', 'i1', 5, 'Compté');
    env.outbox.recordCount('t1', 'i2', 7, 'Compté');
    const batch = env.outbox.chunkRows(env.orgStore.getOutboxRows())[0];
    const [c1, c2] = batch.countEntries;
    const out = env.outbox.applyPushResults(batch, {
      countEntries: [
        { clientId: c1.clientId, status: 'error', error: { code: 'CONFLICT', message: 'retry' } },
        { clientId: c2.clientId, status: 'error', error: { code: 'CONFLICT', message: 'closed', details: { reason: 'stock_take_closed' } } },
      ],
    }, T0 + 1000);
    expect(out).toEqual({ done: 0, parked: 1, retried: 1, saved: true });
    const rows = env.orgStore.getOutboxRows();
    expect(rows[0]).toMatchObject({ state: 'pending', attempts: 1, nextAttemptAt: T0 + 1000 + 30_000 });
    expect(rows[1]).toMatchObject({ state: 'error' });
  });
});
