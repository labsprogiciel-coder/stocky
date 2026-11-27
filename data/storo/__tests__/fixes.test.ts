import { afterEach, describe, expect, it, vi } from 'vitest';
import { API, DEVICE, ORG, SITE, T0, apiError, itemRow, pairActive, reply, seed, setup, type Call, type Env, type Reply } from './helpers';

afterEach(() => { vi.restoreAllMocks(); });

const empty = { serverTime: T0, cursor: 'c-end', hasMore: false, sites: { upserts: [], deleted: [] }, stockTakes: { upserts: [], deleted: [] }, items: { upserts: [], deleted: [] } };

async function ready(handler?: (c: Call) => Reply | Promise<Reply>): Promise<Env> {
  const env = await setup(handler ? { handler } : {});
  await pairActive(env);
  seed(env);
  return env;
}

/** Remplace `set` / `remove` du stockage ; renvoie les originaux. */
function hook(env: Env) {
  const set = env.mem.set.bind(env.mem);
  const remove = env.mem.remove.bind(env.mem);
  return {
    set, remove,
    failSet: (pred: (key: string) => boolean) => { env.mem.set = (k: string, v: string) => { if (pred(k)) throw new Error('disk'); set(k, v); }; },
    failRemove: (pred: (key: string) => boolean) => { env.mem.remove = (k: string) => { if (pred(k)) throw new Error('disk'); remove(k); }; },
    restore: () => { env.mem.set = set; env.mem.remove = remove; },
  };
}

describe('orgStore journal', () => {
  it('a failed rollback leaves a journal of the old values (replayed at load)', async () => {
    const env = await ready();
    const k = env.kv.ORG_KEYS;
    env.outbox.recordCount('t1', 'i1', 5, 'Compté');
    const h = hook(env);
    let outboxWrites = 0;
    h.failSet((key) => key === k.counts || (key === k.outbox && ++outboxWrites > 1));
    expect(env.outbox.recordCount('t1', 'i1', 6, 'Compté')).toBe(env.orgStore.SAVE_ERROR);
    // Disque : nouvelle file, anciens comptages ; le journal doit rester.
    expect(env.mem.get(k.txn)).toBeDefined();
    h.restore();
    env.orgStore.reloadOrgStore();
    expect(env.orgStore.getOutboxRows().map((r) => r.ref?.rev)).toEqual([1]);
    expect(env.orgStore.getCount('t1')?.entries.i1).toMatchObject({ qty: 5, rev: 1 });
    expect(env.mem.get(k.txn)).toBeUndefined();
  });

  it('a failed rollback is finalized from memory before the next write (same session)', async () => {
    const env = await ready();
    const k = env.kv.ORG_KEYS;
    env.outbox.recordCount('t1', 'i1', 5, 'Compté');
    const h = hook(env);
    let outboxWrites = 0;
    h.failSet((key) => key === k.counts || (key === k.outbox && ++outboxWrites > 1) || key === k.txn && outboxWrites > 1);
    expect(env.outbox.recordCount('t1', 'i1', 6, 'Compté')).toBe(env.orgStore.SAVE_ERROR);
    h.restore();
    expect(env.outbox.enqueueMovement('i1', 'Entrée', 1)).toBeNull();
    expect(env.mem.get(k.txn)).toBeUndefined();
    env.orgStore.reloadOrgStore();
    expect(env.orgStore.getOutboxRows().map((r) => r.kind)).toEqual(['count', 'movement']);
    expect(env.orgStore.getCount('t1')?.entries.i1).toMatchObject({ qty: 5, rev: 1 });
  });

  it('a journal that cannot be removed blocks later writes until it is', async () => {
    const env = await ready();
    const k = env.kv.ORG_KEYS;
    const h = hook(env);
    h.failRemove((key) => key === k.txn);
    expect(env.outbox.recordCount('t1', 'i1', 5, 'Compté')).toBeNull();
    expect(env.mem.get(k.txn)).toBeDefined();
    // Écrire la file derrière ce journal perdrait le mouvement au redémarrage.
    expect(env.outbox.enqueueMovement('i1', 'Entrée', 1)).toBe(env.orgStore.SAVE_ERROR);
    h.restore();
    expect(env.outbox.enqueueMovement('i1', 'Entrée', 1)).toBeNull();
    expect(env.mem.get(k.txn)).toBeUndefined();
    env.orgStore.reloadOrgStore();
    expect(env.orgStore.getOutboxRows().map((r) => r.kind)).toEqual(['count', 'movement']);
  });

  it('a partial replay keeps the journal and exposes the journaled state', async () => {
    const env = await ready();
    const k = env.kv.ORG_KEYS;
    env.outbox.recordCount('t1', 'i1', 5, 'Compté');
    env.mem.set(k.txn, JSON.stringify({ parts: { outbox: [], counts: {} } }));
    const h = hook(env);
    h.failSet((key) => key === k.counts);
    env.orgStore.reloadOrgStore();
    expect(env.orgStore.getOutboxRows()).toEqual([]);
    expect(env.orgStore.getCount('t1')).toBeUndefined();
    expect(env.mem.get(k.txn)).toBeDefined();
    expect(env.outbox.enqueueMovement('i1', 'Entrée', 1)).toBe(env.orgStore.SAVE_ERROR);
    h.restore();
    expect(env.outbox.enqueueMovement('i1', 'Entrée', 1)).toBeNull();
    expect(env.mem.get(k.txn)).toBeUndefined();
    expect(JSON.parse(env.mem.get(k.counts)!)).toEqual({});
    env.orgStore.reloadOrgStore();
    expect(env.orgStore.getOutboxRows().map((r) => r.kind)).toEqual(['movement']);
  });
});

describe('outbox', () => {
  it('Modifier saves the swap in one write: the original row survives a storage failure', async () => {
    const env = await ready();
    env.outbox.enqueueMovement('i1', 'Sortie', 8);
    const row = env.orgStore.getOutboxRows()[0];
    const h = hook(env);
    h.failSet((key) => key === env.kv.ORG_KEYS.outbox);
    expect(env.outbox.editMovement(row.clientId, 3)).toBe(env.orgStore.SAVE_ERROR);
    expect(env.orgStore.getOutboxRows()).toEqual([row]);
    h.restore();
    // Le stock disponible ne compte pas la ligne remplacée.
    expect(env.outbox.editMovement(row.clientId, 11)).toBe('Stock insuffisant. Disponible : 10.');
    expect(env.outbox.editMovement(row.clientId, 10)).toBeNull();
    expect(env.orgStore.getOutboxRows().map((r) => r.body)).toMatchObject([{ qty: -10 }]);
  });

  it('countStatus follows the current revision, not an older refused one', async () => {
    const env = await ready();
    env.outbox.recordCount('t1', 'i1', 5, 'Compté');
    const [r1] = env.orgStore.getOutboxRows();
    env.outbox.setInFlight([r1.clientId]);
    env.outbox.recordCount('t1', 'i1', 6, 'Compté');
    env.outbox.setInFlight(null);
    const batch = env.outbox.chunkRows(env.orgStore.getOutboxRows())[0];
    const [c1, c2] = batch.countEntries;
    env.outbox.applyPushResults({ ...batch, rows: [batch.rows[0]], countEntries: [c1] }, {
      countEntries: [{ clientId: c1.clientId, status: 'error', error: { code: 'VALIDATION', details: {} } }],
    }, T0);
    expect(env.outbox.countStatus('t1', 'i1')).toBe('À envoyer');
    const b2 = env.outbox.chunkRows(env.orgStore.getOutboxRows().filter((r) => r.state === 'pending'))[0];
    env.outbox.applyPushResults(b2, { countEntries: [{ clientId: c2.clientId, status: 'created' }] }, T0);
    expect(env.outbox.countStatus('t1', 'i1')).toBe('Envoyé');
  });

  it('lookupCode matches a UPC-A read as a zero-prefixed EAN-13 (and back)', async () => {
    const env = await setup();
    seed(env, [itemRow('u', { barcode: '036000291452' }), itemRow('e', { barcode: '0012345678905', sku: 'E' })]);
    const items = env.orgStore.getAllOrgItems();
    expect(env.mapping.lookupCode(items, SITE, '0036000291452')?.id).toBe('u');
    expect(env.mapping.lookupCode(items, SITE, '036000291452')?.id).toBe('u');
    expect(env.mapping.lookupCode(items, SITE, '012345678905')?.id).toBe('e');
    expect(env.mapping.lookupCode(items, SITE, '36000291452')).toBeNull();
  });
});

describe('sync engine', () => {
  const created = (c: Call) => {
    const b = c.json as { countEntries: { clientId: string }[]; movements: { clientId: string }[] };
    return reply(200, {
      countEntries: b.countEntries.map((e) => ({ clientId: e.clientId, status: 'created' })),
      movements: b.movements.map((m) => ({ clientId: m.clientId, status: 'created' })),
    });
  };

  it('push results that cannot be saved stop the cycle without advancing lastPushAt', async () => {
    const env = await ready((c) => (c.path === '/sync/push' ? created(c) : c.path.startsWith('/sync/pull') ? reply(200, empty) : reply(404)));
    env.outbox.enqueueMovement('i1', 'Entrée', 1);
    const h = hook(env);
    h.failSet((key) => key === env.kv.ORG_KEYS.outbox);
    expect(await env.sync.runSync('manual')).toMatchObject({ ok: false, stopped: 'error', message: 'Enregistrement impossible sur ce téléphone.' });
    expect(env.orgStore.getSyncMeta().lastPushAt).toBeNull();
    expect(env.orgStore.getSyncMeta().lastOkAt).toBeNull();
    expect(env.orgStore.getOutboxRows()).toHaveLength(1);
  });

  it('Dissocier during a multi-batch push: no later batch nor pull with the old token', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const env = await ready(async (c) => {
      if (c.path === '/sync/push') { await gate; return created(c); }
      if (c.path.startsWith('/sync/pull')) return reply(200, empty);
      return reply(404);
    });
    for (let i = 0; i < 51; i++) env.outbox.enqueueMovement('i1', 'Entrée', 1);
    const running = env.sync.runSync('manual');
    await vi.waitFor(() => expect(env.calls.filter((c) => c.path === '/sync/push')).toHaveLength(1));
    await env.session.unpair();
    release();
    expect(await running).toMatchObject({ ok: false, stopped: 'no_session' });
    expect(env.calls.filter((c) => c.path === '/sync/push')).toHaveLength(1);
    expect(env.calls.filter((c) => c.path.startsWith('/sync/pull'))).toHaveLength(0);
    expect(env.orgStore.getOutboxRows()).toHaveLength(1);
  });

  it('each batch is built from the current outbox: a count skipped meanwhile is not sent', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let pushes = 0;
    const env = await ready(async (c) => {
      if (c.path === '/sync/push') { if (++pushes === 1) await gate; return created(c); }
      if (c.path.startsWith('/sync/pull')) return reply(200, empty);
      return reply(404);
    });
    for (let i = 0; i < 51; i++) env.outbox.enqueueMovement('i1', 'Entrée', 1);
    env.outbox.recordCount('t1', 'i1', 4, 'Compté');
    const running = env.sync.runSync('manual');
    await vi.waitFor(() => expect(pushes).toBe(1));
    expect(env.outbox.recordCount('t1', 'i1', 0, 'Passé')).toBeNull();
    release();
    expect(await running).toEqual({ ok: true });
    const sent = env.calls.filter((c) => c.path === '/sync/push').map((c) => c.json as { countEntries: unknown[]; movements: unknown[] });
    expect(sent.map((b) => [b.movements.length, b.countEntries.length])).toEqual([[50, 0], [1, 0]]);
    expect(env.orgStore.getCount('t1')?.entries.i1).toMatchObject({ status: 'Passé' });
    expect(env.orgStore.getCount('t1')?.entries.i1.sentRev).toBeUndefined();
  });

  it('a pull page answered after the session changed organisation is not applied', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const env = await ready(async (c) => {
      if (c.path.startsWith('/sync/pull')) { await gate; return reply(200, { ...empty, items: { upserts: [itemRow('old-org')] }, hasMore: true }); }
      return reply(404);
    });
    const running = env.sync.runSync('manual');
    await vi.waitFor(() => expect(env.calls.some((c) => c.path.startsWith('/sync/pull'))).toBe(true));
    const s = env.session.getSession()!;
    env.mem.set(env.kv.ORG_KEYS.session, JSON.stringify({ ...s, orgId: 'ORG-B' }));
    env.session.reloadSession();
    release();
    expect(await running).toMatchObject({ ok: false, stopped: 'busy' });
    expect(env.orgStore.getOrgItem('old-org')).toBeUndefined();
    expect(env.calls.filter((c) => c.path.startsWith('/sync/pull'))).toHaveLength(1);
  });

  it('parked no_attributed_member rows are re-sent whenever the cached /device/me is attributed', async () => {
    const env = await ready((c) => (c.path === '/sync/push' ? created(c) : c.path.startsWith('/sync/pull') ? reply(200, empty) : reply(404)));
    env.outbox.recordCount('t1', 'i1', 4, 'Compté');
    const b = env.outbox.chunkRows(env.orgStore.getOutboxRows())[0];
    env.outbox.applyPushResults(b, { countEntries: [{ clientId: b.countEntries[0].clientId, status: 'error', error: { code: 'FORBIDDEN', details: { reason: 'no_attributed_member' } } }] }, T0 - 1000);
    // /device/me (attribué) déjà en cache au début du cycle.
    expect(await env.sync.runSync('manual')).toEqual({ ok: true });
    expect(env.orgStore.getOutboxRows()).toHaveLength(0);
  });

  it('a refusal newer than the cached /device/me is not unparked', async () => {
    const env = await ready((c) => (c.path.startsWith('/sync/pull') ? reply(200, empty) : reply(404)));
    env.outbox.recordCount('t1', 'i1', 4, 'Compté');
    const b = env.outbox.chunkRows(env.orgStore.getOutboxRows())[0];
    env.outbox.applyPushResults(b, { countEntries: [{ clientId: b.countEntries[0].clientId, status: 'error', error: { code: 'FORBIDDEN', details: { reason: 'no_attributed_member' } } }] }, T0 + 1);
    await env.sync.runSync('manual');
    expect(env.orgStore.getOutboxRows()[0].state).toBe('error');
  });

  it('a failed cache clear for another organisation stops the cycle before pull', async () => {
    const env = await ready((c) => (c.path.startsWith('/sync/pull') ? reply(200, empty) : reply(404)));
    env.orgStore.updateSyncMeta({ orgId: 'ORG-A' });
    const h = hook(env);
    h.failSet((key) => key === env.kv.ORG_KEYS.sites);
    expect(await env.sync.runSync('manual')).toMatchObject({ ok: false, stopped: 'error', message: 'Enregistrement impossible sur ce téléphone.' });
    expect(env.calls.filter((c) => c.path.startsWith('/sync/pull'))).toHaveLength(0);
    expect(env.orgStore.getSyncMeta().orgId).toBe('ORG-A');
  });

  it('a failed cursor reset reports a storage error without resending the cursor', async () => {
    const env = await ready((c) => (c.path.startsWith('/sync/pull') ? apiError(400, 'VALIDATION', { fields: { cursor: 'Invalid' } }) : reply(404)));
    const h = hook(env);
    h.failSet((key) => key === env.kv.ORG_KEYS.sites);
    expect(await env.sync.runSync('manual')).toMatchObject({ ok: false, stopped: 'error', message: 'Enregistrement impossible sur ce téléphone.' });
    expect(env.calls.filter((c) => c.path.startsWith('/sync/pull'))).toHaveLength(1);
  });

  it('Synchroniser tapped during an automatic cycle reruns as manual (backoff ignored)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let pulls = 0;
    const env = await ready(async (c) => {
      if (c.path.startsWith('/sync/pull')) { if (++pulls === 1) await gate; return 'network'; }
      return reply(404);
    });
    const auto = env.sync.runSync('timer');
    await vi.waitFor(() => expect(pulls).toBe(1));
    const manual = env.sync.runSync('manual');
    release();
    expect(await manual).toMatchObject({ ok: false, stopped: 'transport' });
    expect(await auto).toMatchObject({ stopped: 'transport' });
    expect(pulls).toBe(2);
  });
});

describe('session', () => {
  const ME = { attributedMemberId: 'm1', entitlements: { stocklyMobile: true }, organization: { id: ORG, name: 'Pharmacie du Port' } };

  it('a /device/me answer arriving after Dissocier does not reactivate the session', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const env = await setup({ handler: async (c) => { if (c.path === '/device/me') { await gate; return reply(200, ME); } return reply(404); } });
    await pairActive(env);
    await env.session.setReadonly('entitlement');
    const p = env.session.refreshMe();
    await vi.waitFor(() => expect(env.calls).toHaveLength(1));
    await env.session.unpair();
    release();
    await p;
    expect(env.session.getSession()).toMatchObject({ state: 'readonly', readonlyReason: 'unpaired' });
    expect(env.session.isOrgWritable()).toBe(false);
  });

  it('a 401 to a heartbeat sent with the previous token does not unpair the new pairing', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const env = await setup({ handler: async (c) => {
      if (c.path === '/device/heartbeat') { await gate; return apiError(401, 'UNAUTHENTICATED', { reason: 'revoked' }); }
      if (c.path === '/device/me') return reply(200, ME);
      return reply(404);
    } });
    await pairActive(env);
    const hb = env.session.heartbeat();
    await vi.waitFor(() => expect(env.calls.some((c) => c.path === '/device/heartbeat')).toBe(true));
    expect(await env.session.completePairing({ deviceToken: 'tok-2', deviceId: DEVICE, orgId: ORG, apiBase: API })).toEqual({ kind: 'paired' });
    release();
    await hb;
    expect(env.session.getSession()?.state).toBe('active');
    expect(await env.sec.get(env.kv.TOKEN_KEY)).toBe('tok-2');
  });

  for (const status of [401, 403] as const) {
    it(`a ${status} to a cycle's /device/me sent with the previous token does not touch the new pairing`, async () => {
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      const env = await setup({ handler: async (c) => {
        if (c.path === '/device/me' && c.headers.Authorization === 'Device tok-1') {
          await gate;
          return status === 401 ? apiError(401, 'UNAUTHENTICATED', { reason: 'revoked' }) : apiError(403, 'FORBIDDEN', { reason: 'device_disabled' });
        }
        if (c.path === '/device/me') return reply(200, ME);
        return reply(200, empty);
      } });
      await pairActive(env);
      const metaBefore = env.orgStore.getSyncMeta();
      env.clock.advance(1_000_000);
      const run = env.sync.runSync('manual');
      await vi.waitFor(() => expect(env.calls.some((c) => c.path === '/device/me')).toBe(true));
      expect(await env.session.completePairing({ deviceToken: 'tok-2', deviceId: DEVICE, orgId: ORG, apiBase: API })).toEqual({ kind: 'paired' });
      release();
      expect(await run).toEqual({ ok: false, stopped: 'busy' });
      expect(env.session.getSession()?.state).toBe('active');
      expect(await env.sec.get(env.kv.TOKEN_KEY)).toBe('tok-2');
      expect(env.orgStore.getSyncMeta().lastError).toEqual(metaBefore.lastError);
    });
  }

  it('a 401 to a migration status check sent with the previous token does not unpair the new pairing', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const env = await setup({ handler: async (c) => {
      if (c.path === '/device/migrations/MIG1' && c.headers.Authorization === 'Device tok-1') { await gate; return apiError(401, 'UNAUTHENTICATED', { reason: 'revoked' }); }
      if (c.path === '/device/me') return reply(200, ME);
      return reply(404);
    } });
    await pairActive(env);
    env.mem.set(env.kv.ORG_KEYS.migration, JSON.stringify({ clientId: 'c', orgId: ORG, state: 'pending_review', migrationId: 'MIG1', body: {} }));
    env.migration.reloadMigration();
    const check = env.migration.checkMigration();
    await vi.waitFor(() => expect(env.calls.some((c) => c.path === '/device/migrations/MIG1')).toBe(true));
    expect(await env.session.completePairing({ deviceToken: 'tok-2', deviceId: DEVICE, orgId: ORG, apiBase: API })).toEqual({ kind: 'paired' });
    release();
    await check;
    expect(env.session.getSession()?.state).toBe('active');
    expect(await env.sec.get(env.kv.TOKEN_KEY)).toBe('tok-2');
  });

  const switchEnv = async () => {
    const env = await setup({ handler: (c) => {
      if (c.path === '/device-pairing/qr/claim') return reply(201, { deviceId: 'D2', deviceToken: 'tok-b', orgId: 'ORG-B', apiBase: API });
      if (c.path === '/device/me') return reply(200, { ...ME, organization: { id: 'ORG-B', name: 'Org B' } });
      return reply(404);
    } });
    await pairActive(env);
    seed(env);
    const out = await env.session.claimQr({ apiBase: API, token: 'pt', expiresAt: null });
    if (out.kind !== 'confirm') throw new Error('confirm expected');
    return { env, out };
  };

  it('org switch: a failed session save leaves the old cache untouched', async () => {
    const { env, out } = await switchEnv();
    const h = hook(env);
    h.failSet((key) => key === env.kv.ORG_KEYS.session);
    expect((await out.confirm()).kind).toBe('error');
    h.restore();
    expect(env.session.getSession()?.orgId).toBe(ORG);
    expect(env.orgStore.getAllOrgItems()).toHaveLength(2);
    expect(env.orgStore.getSyncMeta().orgId).toBe(ORG);
    expect(await env.sec.get(env.kv.TOKEN_KEY)).toBe('tok-1');
  });

  it('org switch: a failed cache clear restores the previous session and token', async () => {
    const { env, out } = await switchEnv();
    const h = hook(env);
    h.failSet((key) => key === env.kv.ORG_KEYS.sites);
    expect((await out.confirm()).kind).toBe('error');
    h.restore();
    env.session.reloadSession();
    expect(env.session.getSession()?.orgId).toBe(ORG);
    expect(env.orgStore.getAllOrgItems()).toHaveLength(2);
    expect(await env.sec.get(env.kv.TOKEN_KEY)).toBe('tok-1');
  });
});

describe('migration', () => {
  const dto = (status: string, extra: Record<string, unknown> = {}) => ({ id: 'MIG1', clientId: 'c', deviceId: DEVICE, status, itemCount: 1, totalQty: 0, ...extra });
  const addItem = (env: Env) => { const r = env.store.createItem({ name: 'Article', folder: 'F', qty: 1, min: 0, price: 0 } as never); if (r.error) throw new Error(r.error); };

  it('approval is not recorded when the archive cannot be saved (retried later)', async () => {
    const env = await setup({ handler: (c) => {
      if (c.path === '/device/migrations') return reply(201, { migration: dto('pending_review') });
      if (c.path === '/device/migrations/MIG1') return reply(200, { migration: dto('approved', { siteId: SITE }), mapping: [] });
      return reply(404);
    } });
    await pairActive(env);
    addItem(env);
    await env.migration.startMigration();
    const h = hook(env);
    h.failSet((key) => key === env.kv.ORG_KEYS.archive);
    expect(await env.migration.checkMigration()).toEqual({ ok: false, message: env.orgStore.SAVE_ERROR });
    expect(env.migration.getLocalMigration()?.state).toBe('pending_review');
    expect(env.migration.getArchive()).toBeNull();
    h.restore();
    const r = await env.migration.tickMigration();
    expect(r.approved).toBe(true);
    expect(env.migration.getArchive()).toMatchObject({ migrationId: 'MIG1' });
  });

  it('a late status answer for a cancelled migration does not overwrite the new one', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let posts = 0;
    let gets = 0;
    const env = await setup({ handler: async (c) => {
      if (c.path === '/device/migrations') { posts++; return reply(201, { migration: dto('pending_review', { id: posts === 1 ? 'MIG1' : 'MIG2' }) }); }
      if (c.path === '/device/migrations/MIG1') { if (++gets === 1) await gate; return reply(200, { migration: dto('pending_review'), mapping: null }); }
      if (c.path === '/device/migrations/MIG1/cancel') return reply(200, { migration: dto('cancelled') });
      return reply(404);
    } });
    await pairActive(env);
    addItem(env);
    await env.migration.startMigration();
    const late = env.migration.checkMigration();
    await vi.waitFor(() => expect(gets).toBe(1));
    expect(await env.migration.cancelMigration()).toBeNull();
    expect(env.migration.resetMigration()).toBeNull();
    expect(await env.migration.startMigration()).toBeNull();
    expect(env.migration.getLocalMigration()).toMatchObject({ state: 'pending_review', migrationId: 'MIG2' });
    release();
    expect(await late).toEqual({ ok: true });
    expect(env.migration.getLocalMigration()).toMatchObject({ state: 'pending_review', migrationId: 'MIG2' });
  });

  it('after reactivating the local stock, Recommencer clears the approved migration', async () => {
    const env = await setup({ handler: (c) => {
      if (c.path === '/device/migrations') return reply(201, { migration: dto('pending_review') });
      if (c.path === '/device/migrations/MIG1') return reply(200, { migration: dto('approved', { siteId: SITE }), mapping: [] });
      return reply(404);
    } });
    await pairActive(env);
    addItem(env);
    await env.migration.startMigration();
    await env.migration.checkMigration();
    expect(env.migration.resetMigration()).toBeNull();
    expect(env.migration.getLocalMigration()?.state).toBe('approved'); // archive présente : gardée
    expect(env.migration.reactivateStandalone()).toBeNull();
    expect(env.migration.resetMigration()).toBeNull();
    expect(env.migration.getLocalMigration()).toBeNull();
    expect(env.migration.canStartMigration()).toBeNull();
  });
});
