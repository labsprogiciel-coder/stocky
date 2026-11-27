import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEVICE, ORG, T0, itemRow, pairActive, seed, setup } from './helpers';
import type { PushMovement } from '../mapping';

afterEach(() => { vi.restoreAllMocks(); });

async function ready() {
  const env = await setup();
  await pairActive(env);
  seed(env);
  return env;
}

describe('client ids', () => {
  it('follow the contract format and regex', async () => {
    const env = await ready();
    env.outbox.enqueueMovement('i1', 'Entrée', 3);
    env.outbox.recordCount('t1', 'i2', 5, 'Compté');
    const [mv, ce] = env.orgStore.getOutboxRows();
    expect(mv.clientId).toMatch(new RegExp(`^${DEVICE}:mv:m[0-9a-z]+-[0-9a-z]+-[0-9a-z]{4}$`));
    expect(ce.clientId).toBe(`${DEVICE}:ce:t1:i2:1`);
    for (const r of [mv, ce]) {
      expect(r.clientId).toMatch(env.mapping.CLIENT_ID_RE);
      expect(r.clientId.length).toBeLessThanOrEqual(128);
    }
    // Longueur réelle avec des ULID (26 caractères).
    const ulid = '01JAAAAAAAAAAAAAAAAAAAAAAA';
    expect(env.mapping.countClientId(ulid, ulid, ulid, 12).length).toBeLessThan(100);
  });
});

describe('movements', () => {
  it('maps Entrée / Sortie to reception / sortie and the displayed quantity', async () => {
    const env = await ready();
    expect(env.outbox.enqueueMovement('i1', 'Entrée', 4)).toBeNull();
    expect(env.outbox.enqueueMovement('i1', 'Sortie', 3)).toBeNull();
    const bodies = env.orgStore.getOutboxRows().map((r) => r.body as PushMovement);
    expect(bodies[0]).toMatchObject({ itemId: 'i1', type: 'reception', qty: 4, reason: 'stocky' });
    expect(bodies[1]).toMatchObject({ itemId: 'i1', type: 'sortie', qty: -3, reason: 'stocky' });
    expect(env.orgStore.displayedQty('i1')).toBe(11);
    expect(env.outbox.enqueueMovement('i1', 'Sortie', 12)).toBe('Stock insuffisant. Disponible : 11.');
    expect(env.outbox.enqueueMovement('i1', 'Entrée', 0)).toMatch(/entier/);
  });

  it('is refused when the session is read-only', async () => {
    const env = await ready();
    await env.session.setReadonly('org_suspended');
    expect(env.outbox.enqueueMovement('i1', 'Entrée', 1)).toBe(env.outbox.READONLY_ERROR);
  });

  it('refuses new operations beyond the cap', async () => {
    const env = await ready();
    const row = { clientId: 'x', orgId: ORG, kind: 'movement' as const, body: { clientId: 'x', itemId: 'i1', type: 'reception' as const, qty: 1, reason: 'stocky' as const }, createdAt: T0, attempts: 0, nextAttemptAt: 0, state: 'pending' as const, label: { itemName: 'a', sku: 'b', qty: 1 } };
    env.orgStore.commitOutbox(Array.from({ length: 5000 }, (_, i) => ({ ...row, clientId: `x${i}` })));
    expect(env.outbox.enqueueMovement('i1', 'Entrée', 1)).toBe(env.outbox.OUTBOX_FULL);
  });
});

describe('counts', () => {
  it('replaces the pending row of a recount; Passé removes it', async () => {
    const env = await ready();
    env.outbox.recordCount('t1', 'i1', 5, 'Compté');
    env.outbox.recordCount('t1', 'i1', 6, 'Compté');
    let rows = env.orgStore.getOutboxRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].clientId).toBe(`${DEVICE}:ce:t1:i1:2`);
    expect(rows[0].body).toMatchObject({ stockTakeId: 't1', sku: 'SKU-i1', countedQty: 6, description: 'Article i1' });
    expect(env.outbox.countStatus('t1', 'i1')).toBe('À envoyer');
    env.outbox.recordCount('t1', 'i1', 0, 'Passé');
    rows = env.orgStore.getOutboxRows();
    expect(rows).toHaveLength(0);
    expect(env.outbox.countStatus('t1', 'i1')).toBe('Passé');
  });

  it('timestamp uses the server offset and never goes in the future', async () => {
    const env = await ready();
    env.orgStore.updateSyncMeta({ serverOffsetMs: 4000 });
    env.outbox.recordCount('t1', 'i1', 1, 'Compté');
    expect(env.orgStore.getOutboxRows()[0].body).toMatchObject({ timestamp: T0 + 4000 });
  });

  it('refuses a closed take', async () => {
    const env = await ready();
    env.outbox.recordCount('t1', 'i1', 1, 'Compté');
    env.orgStore.applyPullPage({ stockTakes: { deleted: ['t1'] } }, ORG, T0);
    expect(env.orgStore.getTake('t1')?.closed).toBe(true);
    expect(env.outbox.recordCount('t1', 'i1', 2, 'Compté')).toMatch(/clôturé/);
  });
});

describe('chunking', () => {
  it('splits into requests of at most 200 count entries and 50 movements, in order', async () => {
    const env = await ready();
    const mk = (i: number, kind: 'count' | 'movement') => ({
      clientId: `${kind}${i}`, orgId: ORG, kind, body: { clientId: `${kind}${i}` } as never, createdAt: i, attempts: 0, nextAttemptAt: 0, state: 'pending' as const, label: { itemName: '', sku: '', qty: 1 },
    });
    const rows = [...Array.from({ length: 450 }, (_, i) => mk(i, 'count')), ...Array.from({ length: 120 }, (_, i) => mk(1000 + i, 'movement'))];
    const batches = env.outbox.chunkRows(rows);
    expect(batches.map((b) => [b.countEntries.length, b.movements.length])).toEqual([[200, 0], [200, 0], [50, 50], [0, 50], [0, 20]]);
    expect(batches.flatMap((b) => b.rows).map((r) => r.clientId)).toEqual(rows.map((r) => r.clientId));
  });
});

describe('applyPushResults', () => {
  it('handles created, duplicate, INTERNAL and other errors', async () => {
    const env = await ready();
    env.outbox.enqueueMovement('i1', 'Sortie', 2);
    env.outbox.enqueueMovement('i2', 'Entrée', 1);
    env.outbox.recordCount('t1', 'i1', 5, 'Compté');
    env.outbox.recordCount('t1', 'i2', 7, 'Compté');
    const rows = env.orgStore.getOutboxRows();
    const batch = env.outbox.chunkRows(rows)[0];
    const [m1, m2] = batch.movements;
    const [c1, c2] = batch.countEntries;
    const now = T0 + 10_000;
    const out = env.outbox.applyPushResults(batch, {
      movements: [
        { clientId: m1.clientId, status: 'created', movements: [{ qtyAfter: 8, createdAt: T0 + 9000 }] },
        { clientId: m2.clientId, status: 'error', error: { code: 'INSUFFICIENT_STOCK', message: 'x', details: { available: 0, requested: 1 } } },
      ],
      countEntries: [
        { clientId: c1.clientId, status: 'duplicate' },
        { clientId: c2.clientId, status: 'error', error: { code: 'INTERNAL', message: 'boom' } },
      ],
    }, now);
    expect(out).toEqual({ done: 2, parked: 1, retried: 1 });
    const left = env.orgStore.getOutboxRows();
    expect(left.map((r) => r.clientId)).toEqual([m2.clientId, c2.clientId]);
    expect(left[0]).toMatchObject({ state: 'error', error: { code: 'INSUFFICIENT_STOCK', message: 'Stock insuffisant dans Storo (disponible : 0).' } });
    expect(left[1]).toMatchObject({ state: 'pending', attempts: 1, nextAttemptAt: now + 30_000 });
    expect(env.orgStore.getOrgItem('i1')).toMatchObject({ serverQty: 8, serverQtyAt: T0 + 9000 });
    expect(env.orgStore.displayedQty('i1')).toBe(8);
    expect(env.orgStore.displayedQty('i2')).toBe(10); // ligne garée exclue
    expect(env.orgStore.getCount('t1')?.entries.i1).toMatchObject({ sentRev: 1, sentQty: 5 });
    expect(env.outbox.countStatus('t1', 'i1')).toBe('Envoyé');
  });

  it('parks a row after 8 INTERNAL attempts, with growing row backoff', async () => {
    const env = await ready();
    env.outbox.recordCount('t1', 'i1', 5, 'Compté');
    const internal = (b: ReturnType<typeof env.outbox.chunkRows>[0]) => ({ countEntries: [{ clientId: b.countEntries[0].clientId, status: 'error', error: { code: 'INTERNAL' } }] });
    const waits: number[] = [];
    for (let i = 0; i < 8; i++) {
      const b = env.outbox.chunkRows(env.orgStore.getOutboxRows())[0];
      env.outbox.applyPushResults(b, internal(b), T0);
      const r = env.orgStore.getOutboxRows()[0];
      if (r.state === 'pending') waits.push(r.nextAttemptAt - T0);
    }
    expect(waits).toEqual([30_000, 120_000, 600_000, 1_800_000, 1_800_000, 1_800_000, 1_800_000]);
    expect(env.orgStore.getOutboxRows()[0]).toMatchObject({ state: 'error', attempts: 8 });
  });

  it('a movement older than the known stock does not overwrite it', async () => {
    const env = await ready();
    env.outbox.enqueueMovement('i1', 'Entrée', 1);
    const b = env.outbox.chunkRows(env.orgStore.getOutboxRows())[0];
    env.outbox.applyPushResults(b, { movements: [{ clientId: b.movements[0].clientId, status: 'created', movements: [{ qtyAfter: 99, createdAt: T0 - 1 }] }] }, T0);
    expect(env.orgStore.getOrgItem('i1')?.serverQty).toBe(10);
  });
});

describe('parked rows', () => {
  it('Réessayer keeps the client id; Abandonner reverts a count; Modifier replaces a movement', async () => {
    const env = await ready();
    env.outbox.recordCount('t1', 'i1', 5, 'Compté');
    env.outbox.enqueueMovement('i1', 'Entrée', 2);
    const b = env.outbox.chunkRows(env.orgStore.getOutboxRows())[0];
    env.outbox.applyPushResults(b, {
      countEntries: [{ clientId: b.countEntries[0].clientId, status: 'error', error: { code: 'CONFLICT', details: { reason: 'stock_take_closed' } } }],
      movements: [{ clientId: b.movements[0].clientId, status: 'error', error: { code: 'NOT_FOUND' } }],
    }, T0);
    expect(env.outbox.outboxSummary()).toMatchObject({ parked: 2, pending: 0 });
    expect(env.outbox.countStatus('t1', 'i1')).toBe('Refusé');

    const mv = env.orgStore.getOutboxRows()[1];
    expect(env.outbox.retryRow(mv.clientId)).toBeNull();
    expect(env.orgStore.getOutboxRows()[1]).toMatchObject({ clientId: mv.clientId, state: 'pending', attempts: 0 });

    expect(env.outbox.editMovement(mv.clientId, 3)).toBeNull();
    const after = env.orgStore.getOutboxRows().find((r) => r.kind === 'movement')!;
    expect(after.clientId).not.toBe(mv.clientId);
    expect(after.body).toMatchObject({ qty: 3 });

    const ce = env.orgStore.getOutboxRows().find((r) => r.kind === 'count')!;
    expect(env.outbox.discardRow(ce.clientId)).toBeNull();
    expect(env.orgStore.getCount('t1')?.entries.i1).toBeUndefined();
    expect(env.outbox.countStatus('t1', 'i1')).toBe('À compter');
  });

  it('no_attributed_member rows go back to pending', async () => {
    const env = await ready();
    env.outbox.recordCount('t1', 'i1', 5, 'Compté');
    const b = env.outbox.chunkRows(env.orgStore.getOutboxRows())[0];
    env.outbox.applyPushResults(b, { countEntries: [{ clientId: b.countEntries[0].clientId, status: 'error', error: { code: 'FORBIDDEN', details: { reason: 'no_attributed_member' } } }] }, T0);
    expect(env.orgStore.getOutboxRows()[0].state).toBe('error');
    expect(env.outbox.unparkNoAttributedMember()).toBe(1);
    expect(env.orgStore.getOutboxRows()[0].state).toBe('pending');
  });
});

describe('backoff', () => {
  it('transport backoff is capped at 10 minutes', async () => {
    const env = await setup();
    expect([0, 1, 2, 3, 4, 9].map(env.outbox.transportBackoffMs)).toEqual([5_000, 30_000, 120_000, 600_000, 600_000, 600_000]);
  });
});

describe('foreign rows', () => {
  it('rows of another organisation are counted apart and never sendable', async () => {
    const env = await ready();
    env.outbox.enqueueMovement('i1', 'Entrée', 1);
    expect(env.outbox.sendableRows('ORG-B', T0)).toHaveLength(0);
    expect(env.outbox.outboxSummary('ORG-B')).toMatchObject({ foreign: 1, pending: 0 });
    void itemRow;
  });
});
