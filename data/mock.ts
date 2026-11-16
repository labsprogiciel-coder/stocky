export type Item = { id: string; name: string; sku: string; barcode?: string; folder: string; qty: number; min: number; price: number };

// Codes EAN-13 d'exemple (clé de contrôle valide), un par article.
const BARCODES = [
  '3760123450003', '3760123450379', '3760123450744', '3760123451116',
  '3760123451482', '3760123451857', '3760123452229', '3760123452595',
];

export const items: Item[] = Array.from({ length: 8 }, (_, i) => ({
  id: String(i + 1), name: `Article ${String(i + 1).padStart(3, '0')}`, sku: `SKU-${1000 + i}`, barcode: BARCODES[i],
  folder: i % 2 ? 'Dossier B' : 'Dossier A', qty: 40 - i * 4, min: 10, price: 2500 + i * 500,
}));

// Métadonnées statiques du comptage cyclique. La progression est calculée par
// data/store.ts à partir de la session enregistrée sur l'appareil.
// `maxItems` : nombre d'articles inclus dans le comptage (les N premiers).
export const cycleCount = { id: 'c1', name: 'Comptage hebdomadaire – Dossier A', folder: 'Dossier A', maxItems: items.length, due: 'Aujourd\'hui', blind: true };

export const recent = [
  { id: 'r1', itemId: '1', label: 'Sortie · −2 · 09:42' },
  { id: 'r2', itemId: '3', label: 'Entrée · +10 · 09:15' },
];
