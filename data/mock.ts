export type Item = { id: string; name: string; sku: string; folder: string; qty: number; min: number; price: number };

export const items: Item[] = Array.from({ length: 8 }, (_, i) => ({
  id: String(i + 1), name: `Article ${String(i + 1).padStart(3, '0')}`, sku: `SKU-${1000 + i}`,
  folder: i % 2 ? 'Dossier B' : 'Dossier A', qty: 40 - i * 4, min: 10, price: 2500 + i * 500,
}));

export const cycleCount = { id: 'c1', name: 'Comptage hebdomadaire – Dossier A', folder: 'Dossier A', total: items.length, done: 3, due: 'Aujourd\'hui', blind: true };

export const recent = [
  { id: 'r1', itemId: '1', label: 'Sortie · −2 · 09:42' },
  { id: 'r2', itemId: '3', label: 'Entrée · +10 · 09:15' },
];
