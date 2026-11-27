import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => { vi.restoreAllMocks(); });

const MSG = 'Lecture seule (test).';

async function freshStore() {
  vi.resetModules();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const store = await import('../../store');
  store.setLicenseCheck(() => true);
  return store;
}

describe('standalone guard (§5.5)', () => {
  it('every guarded mutation refuses with the guard message before any change; reads still work', async () => {
    const store = await freshStore();
    const created = store.createItem({ name: 'Paracétamol', folder: 'Pharmacie', qty: 5, min: 1, price: 100 } as never);
    if (!created.item) throw new Error(created.error);
    const serial = store.createItem({ name: 'Téléphone', folder: 'Tél', qty: 0, min: 0, price: 1, serialized: true } as never);
    if (!serial.item) throw new Error(serial.error);
    const unit = store.addUnit(serial.item.id, { serial: 'R58W1A2B3C' });
    if (!unit.unit) throw new Error(unit.error);
    const countId = store.getCycleCount().id;
    const backup = store.getBackupData();
    if (!backup.ok) throw new Error(backup.error);
    const plan = store.prepareRestore(backup.data);
    if (!plan.ok) throw new Error(plan.error);
    const before = JSON.stringify([store.getItems(), store.getUnits(), store.getMovements()]);

    store.setStandaloneGuard(() => MSG);
    const id = created.item.id;
    const results: unknown[] = [
      store.createItem({ name: 'X', folder: 'Y', qty: 1, min: 0, price: 0 } as never).error,
      store.updateItem(id, { name: 'Z' }).error,
      (store.deleteItem(id) as { error?: string }).error,
      store.commitMovement(created.item.sku, 'Entrée', 1),
      store.adjustStock(id, 9),
      store.addUnit(serial.item.id, { serial: 'OTHER-1' }).error,
      store.updateUnit(unit.unit.id, { note: 'x' }).error,
      (store.deleteUnit(unit.unit.id) as { error?: string }).error,
      (store.markUnitFound(countId, 'R58W1A2B3C') as { error?: string }).error,
      store.unmarkUnitFound(countId, unit.unit.id),
      store.saveCountEntry(countId, id, { qty: 1, status: 'Compté' }),
      (store.completeCount(countId, true) as { error?: string }).error,
      store.restartCount(countId),
      (store.importInventory([{ name: 'A', qty: 1 } as never]) as { error?: string }).error,
      (store.applyRestore(plan.plan) as { error?: string }).error,
      store.loadSampleData(),
      store.resetAllData(),
    ];
    expect(results).toEqual(Array(17).fill(MSG));
    expect(JSON.stringify([store.getItems(), store.getUnits(), store.getMovements()])).toBe(before);

    // Lectures, sauvegarde et simulation d'import restent possibles.
    expect(store.getItems()).toHaveLength(2);
    expect(store.findItemByCode(created.item.sku)?.id).toBe(id);
    expect(store.getBackupData().ok).toBe(true);
    expect(store.importInventory([{ name: 'A', qty: 1 } as never], { dryRun: true }).ok).toBe(true);

    store.setStandaloneGuard(null);
    expect(store.adjustStock(id, 9)).toBeNull();
  });
});
