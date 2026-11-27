import { afterEach, describe, expect, it, vi } from 'vitest';
import { ORG, SITE, T0, apiError, itemRow, pairActive, reply, seed, setup, siteRow, takeRow, type Call } from './helpers';

afterEach(() => { vi.restoreAllMocks(); });

const page = (p: Record<string, unknown>) => reply(200, { serverTime: T0 + 2000, cursor: 'c-end', hasMore: false, sites: { upserts: [], deleted: [] }, stockTakes: { upserts: [], deleted: [] }, items: { upserts: [], deleted: [] }, ...p });

describe('runSync', () => {
  it('pushes pending rows then pulls every page with the cursor', async () => {
    const pulls: string[] = [];
    const env = await setup({ handler: (c: Call) => {
      if (c.path === '/sync/push') {
        const b = c.json as { movements: { clientId: string }[] };
        return reply(200, { serverTime: T0, countEntries: [], movements: b.movements.map((m) => ({ clientId: m.clientId, status: 'created', movements: [{ qtyAfter: 11, createdAt: T0 + 1 }] })) });
      }
      if (c.path.startsWith('/sync/pull')) {
        pulls.push(c.path);
        return pulls.length === 1
          ? page({ hasMore: true, cursor: 'c-mid', sites: { upserts: [siteRow()] }, items: { upserts: [itemRow('i3')] } })
          : page({ stockTakes: { upserts: [takeRow('t9')] } });
      }
      return reply(404);
    } });
    await pairActive(env);
    seed(env);
    env.outbox.enqueueMovement('i1', 'Entrée', 1);
    const r = await env.sync.runSync('manual');
    expect(r).toEqual({ ok: true });
    expect(env.orgStore.getOutboxRows()).toHaveLength(0);
    expect(pulls[0]).toContain('tables=sites,stockTakes,items');
    expect(pulls[0]).toContain('limit=500');
    expect(pulls[0]).toContain('cursor=c1');
    expect(pulls[1]).toContain('cursor=c-mid');
    expect(env.orgStore.getSyncMeta()).toMatchObject({ cursor: 'c-end', backoffStep: 0, lastOkAt: T0 });
    expect(env.orgStore.getOrgItem('i3')).toBeDefined();
    expect(env.orgStore.getTake('t9')).toBeDefined();
    expect(env.orgStore.getOrgItem('i1')?.serverQty).toBe(11);
  });

  it('is single-flight: a second call during a cycle reruns it once', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let pulls = 0;
    const env = await setup({ handler: async (c) => {
      if (c.path.startsWith('/sync/pull')) { pulls++; if (pulls === 1) await gate; return page({}); }
      return reply(404);
    } });
    await pairActive(env);
    const a = env.sync.runSync('manual');
    const b = env.sync.runSync('enqueue');
    expect(a).toBe(b);
    release();
    await a;
    expect(pulls).toBe(2);
  });

  it('network error: transport backoff 5 s, then 30 s; manual ignores it', async () => {
    const env = await setup({ handler: () => 'network' });
    await pairActive(env);
    expect(await env.sync.runSync('timer')).toMatchObject({ ok: false, stopped: 'transport' });
    expect(env.orgStore.getSyncMeta()).toMatchObject({ backoffStep: 1, nextTryAt: T0 + 5000 });
    expect(await env.sync.runSync('timer')).toMatchObject({ ok: false, stopped: 'backoff' });
    await env.sync.runSync('manual');
    expect(env.orgStore.getSyncMeta()).toMatchObject({ backoffStep: 2, nextTryAt: T0 + 30_000 });
  });

  it('429 waits Retry-After', async () => {
    const env = await setup({ handler: () => apiError(429, 'RATE_LIMITED', {}, { 'Retry-After': '42' }) });
    await pairActive(env);
    await env.sync.runSync('manual');
    expect(env.orgStore.getSyncMeta().nextTryAt).toBe(T0 + 42_000);
  });

  it('400 on the cursor clears the cache and pulls from scratch once', async () => {
    const seen: string[] = [];
    const env = await setup({ handler: (c) => {
      if (!c.path.startsWith('/sync/pull')) return reply(404);
      seen.push(c.path);
      return c.path.includes('cursor=') ? apiError(400, 'VALIDATION', { fields: { cursor: 'Invalid cursor' } }) : page({ items: { upserts: [itemRow('fresh')] } });
    } });
    await pairActive(env);
    seed(env);
    env.outbox.recordCount('t1', 'i1', 1, 'Compté');
    env.setHandler((c) => {
      if (c.path === '/sync/push') return reply(200, { countEntries: [], movements: [] });
      if (!c.path.startsWith('/sync/pull')) return reply(404);
      seen.push(c.path);
      return c.path.includes('cursor=') ? apiError(400, 'VALIDATION', { fields: { cursor: 'Invalid cursor' } }) : page({ items: { upserts: [itemRow('fresh')] } });
    });
    expect(await env.sync.runSync('manual')).toEqual({ ok: true });
    expect(seen).toHaveLength(2);
    expect(seen[1]).not.toContain('cursor=');
    expect(env.orgStore.getAllOrgItems().map((i) => i.id)).toEqual(['fresh']);
    expect(env.orgStore.getCount('t1')).toBeDefined();
    expect(env.orgStore.getOutboxRows()).toHaveLength(1);
  });

  it('403 permission on pull keeps the session active and flags the banner', async () => {
    const env = await setup({ handler: (c) => c.path.startsWith('/sync/pull') ? apiError(403, 'FORBIDDEN', { permission: 'inventory.read' }) : reply(404) });
    await pairActive(env);
    await env.sync.runSync('manual');
    expect(env.session.getSessionState()).toBe('active');
    expect(env.orgStore.getSyncMeta().deniedPermission).toBe('inventory.read');
  });

  it('401 during push → unpaired, rows kept, sync stops', async () => {
    const env = await setup({ handler: () => apiError(401, 'UNAUTHENTICATED', { reason: 'revoked' }) });
    await pairActive(env);
    seed(env);
    env.outbox.enqueueMovement('i1', 'Entrée', 1);
    expect(await env.sync.runSync('manual')).toMatchObject({ ok: false, stopped: 'readonly' });
    expect(env.session.getSession()).toMatchObject({ readonlyReason: 'unpaired' });
    expect(env.orgStore.getOutboxRows()).toHaveLength(1);
    expect(await env.sync.runSync('manual')).toMatchObject({ ok: false, stopped: 'no_session' });
  });

  it('read-only (entitlement): a probe 200 reactivates and the cycle continues', async () => {
    const env = await setup({ handler: (c) => {
      if (c.path === '/device/me') return reply(200, { attributedMemberId: 'm1', entitlements: { stocklyMobile: true }, organization: { id: ORG, name: 'Pharmacie du Port' } });
      if (c.path.startsWith('/sync/pull')) return page({});
      return reply(404);
    } });
    await pairActive(env);
    await env.session.setReadonly('entitlement');
    expect(await env.sync.runSync('foreground')).toEqual({ ok: true });
    expect(env.session.getSessionState()).toBe('active');
  });

  it('erase is refused while active and keeps the archive', async () => {
    const env = await setup();
    await pairActive(env);
    seed(env);
    expect(await env.sync.eraseStoroData()).toMatch(/Dissociez/);
    env.mem.set(env.kv.ORG_KEYS.archive, JSON.stringify({ archivedAt: T0, migrationId: 'M', orgId: ORG }));
    await env.session.unpair();
    expect(await env.sync.eraseStoroData()).toBeNull();
    expect(env.session.getSession()).toBeNull();
    expect(env.orgStore.getAllOrgItems()).toHaveLength(0);
    expect(env.mem.get(env.kv.ORG_KEYS.archive)).toBeDefined();
    void SITE;
  });
});

describe('attribution', () => {
  it('re-sends no_attributed_member rows once the phone gets a member', async () => {
    const env = await setup({ handler: (c) => {
      if (c.path === '/device/me') return reply(200, { attributedMemberId: 'm9', entitlements: { stocklyMobile: true } });
      if (c.path === '/sync/push') {
        const b = c.json as { countEntries: { clientId: string }[] };
        return reply(200, { countEntries: b.countEntries.map((e) => ({ clientId: e.clientId, status: 'created' })), movements: [] });
      }
      if (c.path.startsWith('/sync/pull')) return page({});
      return reply(404);
    } });
    await pairActive(env, { attributed: null });
    seed(env);
    env.outbox.recordCount('t1', 'i1', 4, 'Compté');
    const b = env.outbox.chunkRows(env.orgStore.getOutboxRows())[0];
    env.outbox.applyPushResults(b, { countEntries: [{ clientId: b.countEntries[0].clientId, status: 'error', error: { code: 'FORBIDDEN', details: { reason: 'no_attributed_member' } } }] }, T0);
    env.clock.advance(16 * 60_000); // /device/me périmé
    expect(await env.sync.runSync('manual')).toEqual({ ok: true });
    expect(env.orgStore.getOutboxRows()).toHaveLength(0);
  });
});
