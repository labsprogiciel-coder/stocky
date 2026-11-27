import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEVICE, SITE, apiError, pairActive, reply, setup, type Env } from './helpers';

afterEach(() => { vi.restoreAllMocks(); });

function addItems(env: Env, n: number) {
  for (let i = 0; i < n; i++) {
    const r = env.store.createItem({ name: `Article ${i}`, folder: 'Pharmacie', qty: i, min: 2, price: 1500, ...(i === 0 ? { barcode: '3760123450010' } : {}) } as never);
    if (r.error) throw new Error(r.error);
  }
}

describe('payload (§8.4)', () => {
  it('maps every standalone item field', async () => {
    const env = await setup();
    env.store.setLicenseCheck(() => true);
    addItems(env, 2);
    const items = env.store.getItems();
    const built = env.migration.buildMigrationBody(items, DEVICE, 'abc');
    if ('error' in built) throw new Error(built.error);
    expect(built.clientId).toBe(`${DEVICE}:mig-abc`);
    const p = JSON.parse(built.body);
    expect(p.source).toEqual({ app: 'stocky', appVersion: '1.0.0', platform: 'android 14', licensed: true });
    expect(p.items[0]).toEqual({ localItemId: items[0].id, name: 'Article 0', sku: items[0].sku, barcode: '3760123450010', folder: 'Pharmacie', minQty: 2, unitPrice: 1500, qty: 0, serialized: false });
    expect(p.items[1]).not.toHaveProperty('barcode');
    expect(built.totalQty).toBe(1);
  });

  it('refuses more than 1000 items or more than 512 KiB', async () => {
    const env = await setup();
    const item = (i: number) => ({ id: String(i), name: 'x'.repeat(400), sku: `S${i}`, folder: 'f', qty: 1, min: 0, price: 0 });
    expect(env.migration.buildMigrationBody(Array.from({ length: 1001 }, (_, i) => item(i)), DEVICE)).toEqual({ error: env.migration.TOO_LARGE });
    expect(env.migration.buildMigrationBody(Array.from({ length: 1000 }, (_, i) => ({ ...item(i), name: 'é'.repeat(300) })), DEVICE)).toEqual({ error: env.migration.TOO_LARGE });
  });
});

describe('submission and review', () => {
  const migration = (status: string, extra: Record<string, unknown> = {}) => ({ id: 'MIG1', clientId: 'c', deviceId: DEVICE, status, itemCount: 2, totalQty: 1, ...extra });

  it('stores the body before sending, resends it byte for byte, then waits for review (guard on)', async () => {
    let n = 0;
    const env = await setup({ handler: (c) => {
      if (c.path === '/device/migrations') { n++; return n === 1 ? 'network' : reply(201, { migration: migration('pending_review') }); }
      return reply(404);
    } });
    await pairActive(env);
    addItems(env, 2);
    expect(await env.migration.startMigration()).toBeNull();
    const m = env.migration.getLocalMigration()!;
    expect(m.state).toBe('submitting');
    expect(JSON.parse(env.mem.get(env.kv.ORG_KEYS.migration)!).body).toBe(m.body);
    expect(env.store.createItem({ name: 'Nouveau', folder: 'x', qty: 0, min: 0, price: 0 } as never).error).toBe(env.migration.GUARD_PENDING);

    const r = await env.migration.tickMigration();
    expect(r.ok).toBe(true);
    const posts = env.calls.filter((c) => c.path === '/device/migrations');
    expect(posts).toHaveLength(2);
    expect(posts[0].body).toBe(posts[1].body);
    expect(posts[1].body).toBe(m.body);
    expect(env.migration.getLocalMigration()).toMatchObject({ state: 'pending_review', migrationId: 'MIG1' });
    expect(env.store.standaloneReadonlyMessage()).toBe(env.migration.GUARD_PENDING);
  });

  it('409 migration_pending adopts the existing migration', async () => {
    const env = await setup({ handler: (c) => {
      if (c.path === '/device/migrations') return apiError(409, 'CONFLICT', { reason: 'migration_pending', migrationId: 'MIG0' });
      if (c.path === '/device/migrations/MIG0') return reply(200, { migration: migration('pending_review', { id: 'MIG0' }), mapping: null });
      return reply(404);
    } });
    await pairActive(env);
    addItems(env, 1);
    await env.migration.startMigration();
    expect(env.migration.getLocalMigration()).toMatchObject({ state: 'pending_review', migrationId: 'MIG0' });
  });

  it('400 / IDEMPOTENCY_MISMATCH → failed and the user may restart', async () => {
    const env = await setup({ handler: () => apiError(400, 'VALIDATION', { fields: { 'items.0.sku': 'Required' } }) });
    await pairActive(env);
    addItems(env, 1);
    expect(await env.migration.startMigration()).toBe('Donnée refusée par Storo : Required.');
    expect(env.migration.getLocalMigration()?.state).toBe('failed');
    expect(env.store.standaloneReadonlyMessage()).toBeNull();
    expect(env.migration.resetMigration()).toBeNull();
    expect(env.migration.getLocalMigration()).toBeNull();
  });

  it('approved → archive, current site, org workspace, mapping kept, standalone data kept', async () => {
    const env = await setup({ handler: (c) => {
      if (c.path === '/device/migrations') return reply(201, { migration: migration('pending_review') });
      if (c.path === '/device/migrations/MIG1') {
        return reply(200, {
          migration: migration('approved', { siteId: SITE, siteName: 'Dépôt central', decidedAt: 5, decidedByName: 'Awa Diop', result: { created: 1, linked: 1, skipped: 0, adjustments: 1 } }),
          mapping: [{ localItemId: 'x', action: 'create', storoItemId: 'S1', qtyPolicy: null, qtyApplied: 0 }],
        });
      }
      return reply(404);
    } });
    await pairActive(env);
    addItems(env, 2);
    await env.migration.startMigration();
    const r = await env.migration.tickMigration();
    expect(r.approved).toBe(true);
    expect(env.migration.getLocalMigration()).toMatchObject({ state: 'approved', result: { siteId: SITE, mapping: [{ storoItemId: 'S1' }], result: { created: 1 } } });
    expect(env.migration.getArchive()).toMatchObject({ migrationId: 'MIG1' });
    expect(env.orgStore.getCurrentSiteId()).toBe(SITE);
    expect(env.session.getWorkspace()).toBe('org');
    expect(env.store.getItems()).toHaveLength(2);
    expect(env.store.adjustStock(env.store.getItems()[1].id, 9)).toBe(env.migration.GUARD_ARCHIVED);
    expect(env.migration.reactivateStandalone()).toBeNull();
    expect(env.store.adjustStock(env.store.getItems()[1].id, 9)).toBeNull();
  });

  it('rejected → guard released, Recommencer allowed', async () => {
    const env = await setup({ handler: (c) => {
      if (c.path === '/device/migrations') return reply(201, { migration: migration('pending_review') });
      if (c.path === '/device/migrations/MIG1') return reply(200, { migration: migration('rejected', { rejectReason: 'Doublons' }), mapping: null });
      return reply(404);
    } });
    await pairActive(env);
    addItems(env, 1);
    await env.migration.startMigration();
    await env.migration.checkMigration();
    expect(env.migration.getLocalMigration()).toMatchObject({ state: 'rejected', rejectReason: 'Doublons' });
    expect(env.store.standaloneReadonlyMessage()).toBeNull();
    expect(env.migration.canStartMigration()).toBeNull();
  });

  it('cancel while pending', async () => {
    const env = await setup({ handler: (c) => {
      if (c.path === '/device/migrations') return reply(201, { migration: migration('pending_review') });
      if (c.path === '/device/migrations/MIG1/cancel') return reply(200, { migration: migration('cancelled') });
      return reply(404);
    } });
    await pairActive(env);
    addItems(env, 1);
    await env.migration.startMigration();
    expect(await env.migration.cancelMigration()).toBeNull();
    expect(env.migration.getLocalMigration()?.state).toBe('cancelled');
    expect(env.store.standaloneReadonlyMessage()).toBeNull();
  });

  it('403 device_kind → failed with the Stocky message', async () => {
    const env = await setup({ handler: () => apiError(403, 'FORBIDDEN', { reason: 'device_kind' }) });
    await pairActive(env);
    addItems(env, 1);
    expect(await env.migration.startMigration()).toBe("Ce téléphone n'est pas enregistré comme Stocky.");
  });

  it('does not require Stockly Pro', async () => {
    const env = await setup({ handler: () => reply(201, { migration: migration('pending_review') }) });
    env.store.setLicenseCheck(() => false);
    await pairActive(env);
    addItems(env, 3);
    expect(await env.migration.startMigration()).toBeNull();
    expect(JSON.parse(env.migration.getLocalMigration()!.body).source.licensed).toBe(false);
  });
});
