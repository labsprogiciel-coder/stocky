import { afterEach, describe, expect, it, vi } from 'vitest';
import { ORG, SITE, T0, itemRow, pairActive, seed, setup, siteRow, takeRow } from './helpers';

afterEach(() => { vi.restoreAllMocks(); });

describe('applyPullPage', () => {
  it('upserts, deletes, and keeps a closed take that has a local count', async () => {
    const env = await setup();
    await pairActive(env);
    seed(env, [itemRow('i1'), itemRow('i2')], [takeRow('t1'), takeRow('t2')]);
    env.outbox.recordCount('t1', 'i1', 3, 'Compté');
    env.orgStore.applyPullPage({
      items: { upserts: [itemRow('i2', { description: 'Renommé' }), { sku: 'no-id' }], deleted: ['i1'] },
      stockTakes: { deleted: ['t1', 't2', 'unknown'] },
      cursor: 'c2',
    }, ORG, T0 + 1);
    expect(env.orgStore.getOrgItem('i1')).toBeUndefined();
    expect(env.orgStore.getOrgItem('i2')?.name).toBe('Renommé');
    expect(env.orgStore.getAllOrgItems()).toHaveLength(1);
    expect(env.orgStore.getTake('t1')).toMatchObject({ closed: true });
    expect(env.orgStore.getTake('t2')).toBeUndefined();
    expect(env.orgStore.getSyncMeta().cursor).toBe('c2');
  });

  it('rejects a malformed page without applying it or moving the cursor', async () => {
    const env = await setup();
    await pairActive(env);
    seed(env);
    const bad = [
      { items: { upserts: {} } },
      { sites: { upserts: 'abc' } },
      { items: { deleted: {} } },
      { stockTakes: 'x' },
    ];
    for (const b of bad) {
      expect(() => env.orgStore.applyPullPage({ ...(b as object), cursor: 'c-bad' } as never, ORG, T0)).toThrow(env.orgStore.InvalidPullPageError);
    }
    expect(env.orgStore.getSyncMeta().cursor).toBe('c1');
  });

  it('writes the cursor last, and nothing changes in memory when a write fails', async () => {
    const env = await setup();
    await pairActive(env);
    const order: string[] = [];
    const set = env.mem.set.bind(env.mem);
    env.mem.set = (k: string, v: string) => { order.push(k); set(k, v); };
    seed(env);
    const k = env.kv.ORG_KEYS;
    expect(order.slice(0, 4)).toEqual([k.sites, k.items, k.takes, k.sync]);

    env.mem.set = (key: string, v: string) => { if (key === k.sync) throw new Error('disk full'); set(key, v); };
    const r = env.orgStore.applyPullPage({ items: { upserts: [itemRow('i9')] }, cursor: 'c-new' }, ORG, T0);
    expect(r.ok).toBe(false);
    expect(env.orgStore.getOrgItem('i9')).toBeUndefined();
    expect(env.orgStore.getSyncMeta().cursor).toBe('c1');
    // Restauré : un rechargement relit les anciennes valeurs.
    env.orgStore.reloadOrgStore();
    expect(env.orgStore.getOrgItem('i9')).toBeUndefined();
  });

  it('keeps a newer local serverQty (serverQtyAt rule)', async () => {
    const env = await setup();
    seed(env, [itemRow('i1', { qtyOnHand: 10, updatedAt: T0 })]);
    const item = env.orgStore.getOrgItem('i1')!;
    env.orgStore.commitOutbox([], { items: { i1: { ...item, serverQty: 7, serverQtyAt: T0 + 500 } } });
    env.orgStore.applyPullPage({ items: { upserts: [itemRow('i1', { qtyOnHand: 10, updatedAt: T0 + 100 })] } }, ORG, T0);
    expect(env.orgStore.getOrgItem('i1')).toMatchObject({ serverQty: 7, serverQtyAt: T0 + 500 });
    env.orgStore.applyPullPage({ items: { upserts: [itemRow('i1', { qtyOnHand: 4, updatedAt: T0 + 900 })] } }, ORG, T0);
    expect(env.orgStore.getOrgItem('i1')).toMatchObject({ serverQty: 4, serverQtyAt: T0 + 900 });
  });

  it('clears the current site when it is deleted', async () => {
    const env = await setup();
    seed(env);
    const r = env.orgStore.applyPullPage({ sites: { deleted: [SITE] } }, ORG, T0);
    expect(r).toEqual({ ok: true, siteCleared: true });
    expect(env.orgStore.getCurrentSiteId()).toBeNull();
  });

  it('resetPullState clears the cache and cursor but not counts nor outbox', async () => {
    const env = await setup();
    await pairActive(env);
    seed(env);
    env.outbox.recordCount('t1', 'i1', 2, 'Compté');
    env.orgStore.resetPullState();
    expect(env.orgStore.getAllOrgItems()).toHaveLength(0);
    expect(env.orgStore.getSyncMeta().cursor).toBeNull();
    expect(env.orgStore.getOutboxRows()).toHaveLength(1);
    expect(env.orgStore.getCount('t1')).toBeDefined();
  });
});

describe('displayedQty', () => {
  it('adds pending movements of this organisation only', async () => {
    const env = await setup();
    await pairActive(env);
    seed(env);
    env.outbox.enqueueMovement('i1', 'Entrée', 5);
    env.outbox.enqueueMovement('i1', 'Sortie', 2);
    expect(env.orgStore.displayedQty('i1')).toBe(13);
    const rows = env.orgStore.getOutboxRows();
    env.orgStore.commitOutbox([{ ...rows[0], orgId: 'OTHER' }, rows[1]]);
    expect(env.orgStore.displayedQty('i1')).toBe(8);
  });
});

describe('lookupCode (§8.3)', () => {
  it('barcode first, then SKU case-insensitively, current site only', async () => {
    const env = await setup();
    seed(env, [
      itemRow('a', { sku: 'B-2', barcode: '376' }),
      itemRow('b', { sku: 'A-1', barcode: '376' }),
      itemRow('c', { sku: 'Para-500' }),
      itemRow('d', { sku: 'OTHER', siteId: 'S2', barcode: '999' }),
    ]);
    const items = env.orgStore.getAllOrgItems();
    expect(env.mapping.lookupCode(items, SITE, ' 376 ')?.id).toBe('b'); // deux codes-barres : le premier par SKU
    expect(env.mapping.lookupCode(items, SITE, 'para-500')?.id).toBe('c');
    expect(env.mapping.lookupCode(items, SITE, '999')).toBeNull();
    expect(env.mapping.lookupCode(items, SITE, '')).toBeNull();
  });
});

describe('pull row mapping (§8.5)', () => {
  it('maps rows and ignores extras', async () => {
    const env = await setup();
    expect(env.mapping.toOrgSite(siteRow())).toEqual({ id: SITE, name: 'Dépôt central', address: 'Rue 1' });
    expect(env.mapping.toOrgItem(itemRow('x', { barcode: ' 123 ', reorderPoint: 4, extra: 1 }))).toMatchObject({
      id: 'x', sku: 'SKU-x', barcode: '123', name: 'Article x', reorderPoint: 4, serverQty: 10, serverQtyAt: T0,
    });
    expect(env.mapping.toOrgTake(takeRow('t', { memberIds: ['m2', 3] }))).toMatchObject({ id: 't', status: 'in_progress', memberIds: ['m2'] });
    expect(env.mapping.toOrgItem({ sku: 'x' })).toBeNull();
  });
});

describe('pending scans and workspace', () => {
  it('hand-off is read once', async () => {
    const env = await setup();
    env.orgStore.setPendingStoroScan('take:t1', '376');
    expect(env.orgStore.consumePendingStoroScan('take:t1')).toBe('376');
    expect(env.orgStore.consumePendingStoroScan('take:t1')).toBeNull();
  });

  it('workspace is org only with a session and the org choice', async () => {
    const env = await setup();
    env.orgStore.setWorkspaceChoice('org');
    expect(env.session.getWorkspace()).toBe('standalone');
    await pairActive(env);
    expect(env.session.getWorkspace()).toBe('org');
    await env.session.setReadonly('entitlement');
    expect(env.session.getWorkspace()).toBe('org');
  });
});
