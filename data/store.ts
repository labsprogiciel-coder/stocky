import { Item, items as seedItems, recent as seedRecent } from './mock';

export type Movement = {
  id: string;
  itemId: string;
  sku: string;
  mode: 'Entrée' | 'Sortie';
  qty: number;
  ts: number; // epoch ms
};

export type CountEntry = { qty: number; status: 'Compté' | 'Passé' };

// ── Mutable in-memory state ────────────────────────────────────────────────
let _items: Item[] = seedItems.map((i) => ({ ...i }));

let _movements: Movement[] = seedRecent.map((r, idx) => ({
  id: r.id,
  itemId: r.itemId,
  sku: _items.find((i) => i.id === r.itemId)?.sku ?? '',
  mode: r.label.startsWith('Entrée') ? 'Entrée' : 'Sortie',
  qty: idx === 0 ? 2 : 10,
  ts: Date.now() - (idx + 1) * 60_000,
}));

// ── Accessors ──────────────────────────────────────────────────────────────
export function getItems(): Item[] {
  return _items;
}

export function getItem(id: string): Item | undefined {
  return _items.find((i) => i.id === id);
}

export function findItemBySku(sku: string): Item | undefined {
  return _items.find((i) => i.sku === sku);
}

export function getMovements(): Movement[] {
  return [..._movements].sort((a, b) => b.ts - a.ts);
}

// ── Mutations ──────────────────────────────────────────────────────────────

/** Commit a scan movement (Entrée/Sortie). Returns error string or null. */
export function commitMovement(
  sku: string,
  mode: 'Entrée' | 'Sortie',
  qty: number
): string | null {
  const item = _items.find((i) => i.sku === sku);
  if (!item) return 'Article introuvable.';
  if (qty <= 0) return 'La quantité doit être supérieure à 0.';
  if (mode === 'Sortie' && qty > item.qty) {
    return `Stock insuffisant. Disponible : ${item.qty} unité(s).`;
  }

  item.qty = mode === 'Entrée' ? item.qty + qty : item.qty - qty;

  _movements.unshift({
    id: `m${Date.now()}`,
    itemId: item.id,
    sku,
    mode,
    qty,
    ts: Date.now(),
  });

  return null;
}

/** Adjust stock directly from the article detail screen. Returns error or null. */
export function adjustStock(itemId: string, newQty: number): string | null {
  const item = _items.find((i) => i.id === itemId);
  if (!item) return 'Article introuvable.';
  if (newQty < 0) return 'La quantité ne peut pas être négative.';

  const diff = newQty - item.qty;
  if (diff === 0) return null;

  const mode: 'Entrée' | 'Sortie' = diff > 0 ? 'Entrée' : 'Sortie';
  _movements.unshift({
    id: `m${Date.now()}`,
    itemId: item.id,
    sku: item.sku,
    mode,
    qty: Math.abs(diff),
    ts: Date.now(),
  });

  item.qty = newQty;
  return null;
}

/** Format a movement timestamp as HH:MM */
export function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}
