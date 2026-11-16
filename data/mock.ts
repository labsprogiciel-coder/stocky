/**
 * DONNÉES DE DÉMONSTRATION UNIQUEMENT.
 *
 * L'application démarre avec un inventaire vide : ces données ne sont jamais
 * chargées automatiquement. Elles ne servent qu'à l'action
 * Profil › Stockage local › « Charger les données d'exemple »
 * (`loadSampleData()` dans `data/store.ts`), qui remplace les données
 * actuelles par ce jeu d'exemple.
 */
import type { Item } from './store';

// Codes EAN-13 d'exemple (clé de contrôle valide), un par article.
const BARCODES = [
  '3760123450003', '3760123450379', '3760123450744', '3760123451116',
  '3760123451482', '3760123451857', '3760123452229', '3760123452595',
];

/** Articles d'exemple. */
export const items: Item[] = Array.from({ length: 8 }, (_, i) => ({
  id: String(i + 1), name: `Article ${String(i + 1).padStart(3, '0')}`, sku: `SKU-${1000 + i}`, barcode: BARCODES[i],
  folder: i % 2 ? 'Dossier B' : 'Dossier A', qty: 40 - i * 4, min: 10, price: 2500 + i * 500,
}));

/** Mouvements d'exemple (convertis en mouvements datés par `loadSampleData()`). */
export const recent = [
  { id: 'r1', itemId: '1', label: 'Sortie · −2 · 09:42' },
  { id: 'r2', itemId: '3', label: 'Entrée · +10 · 09:15' },
];
