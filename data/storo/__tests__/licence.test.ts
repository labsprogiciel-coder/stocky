import { afterEach, describe, expect, it, vi } from 'vitest';
import { itemRow, pairActive, seed, setup, takeRow } from './helpers';

afterEach(() => { vi.restoreAllMocks(); });

/**
 * Règle de licence (§9) : la licence STK1 ne gouverne que « Mon stock » ;
 * l'espace organisation dépend uniquement du droit Storo (session active).
 */
describe('licence rule', () => {
  it('free licence: standalone limits apply, org workspace has none', async () => {
    const env = await setup();
    env.store.setLicenseCheck(() => false);
    for (let i = 0; i < env.store.FREE_LIMITS.items; i++) {
      const r = env.store.createItem({ name: `A${i}`, folder: 'f', qty: 1, min: 0, price: 0 } as never);
      if (r.error) throw new Error(r.error);
    }
    expect(env.store.createItem({ name: 'Trop', folder: 'f', qty: 1, min: 0, price: 0 } as never).limit).toBe('items');

    await pairActive(env);
    const many = Array.from({ length: 120 }, (_, i) => itemRow(`o${i}`, { qtyOnHand: 200 }));
    seed(env, many, [takeRow('t1')]);
    for (const it of many) expect(env.outbox.enqueueMovement(it.id, 'Entrée', 150)).toBeNull();
    for (const it of many) expect(env.outbox.recordCount('t1', it.id, 1, 'Compté')).toBeNull();
    expect(env.orgStore.getOutboxRows()).toHaveLength(240);
    // La licence n'a pas changé : le stock local reste limité.
    expect(env.store.itemLimitError()).not.toBeNull();
  });

  it('Pro licence does not unlock a read-only org workspace', async () => {
    const env = await setup();
    env.store.setLicenseCheck(() => true);
    await pairActive(env);
    seed(env);
    await env.session.setReadonly('entitlement');
    expect(env.outbox.enqueueMovement('i1', 'Entrée', 1)).toBe(env.outbox.READONLY_ERROR);
    expect(env.store.createItem({ name: 'Local', folder: 'f', qty: 1, min: 0, price: 0 } as never).error).toBeUndefined();
  });
});
