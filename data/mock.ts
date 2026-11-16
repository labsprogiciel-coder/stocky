/**
 * DONNÉES DE DÉMONSTRATION UNIQUEMENT.
 *
 * L'application démarre avec un inventaire vide : ces données ne sont jamais
 * chargées automatiquement. Elles ne servent qu'à l'action
 * Profil › Stockage local › « Charger les données d'exemple »
 * (`loadSampleData()` dans `data/store.ts`), qui remplace les données
 * actuelles par ce jeu d'exemple.
 */
import type { Item, Unit } from './store';

// Codes EAN-13 d'exemple (clé de contrôle valide), un par article.
const BARCODES = [
  '3760123450003', '3760123450379', '3760123450744', '3760123451116',
  '3760123451482', '3760123451857', '3760123452229', '3760123452595',
];

/** Articles d'exemple suivis en quantité. */
const quantityItems: Item[] = Array.from({ length: 8 }, (_, i) => ({
  id: String(i + 1), name: `Article ${String(i + 1).padStart(3, '0')}`, sku: `SKU-${1000 + i}`, barcode: BARCODES[i],
  folder: i % 2 ? 'Dossier B' : 'Dossier A', qty: 40 - i * 4, min: 10, price: 2500 + i * 500,
}));

/**
 * Appareils suivis par numéro de série (téléphone, ordinateur, casque) et un
 * accessoire suivi en quantité (coque). Le stock des articles suivis est
 * recalculé à partir des unités par `loadSampleData()` (`qty: 0` ici).
 */
const deviceItems: Item[] = [
  { id: '9', name: 'Smartphone 5G 128 Go', sku: 'SKU-1008', barcode: '3760123453226', folder: 'Téléphonie', qty: 0, min: 2, price: 34900, serialized: true },
  { id: '10', name: 'Ordinateur portable 14 pouces', sku: 'SKU-1009', barcode: '3760123453691', folder: 'Informatique', qty: 0, min: 1, price: 119900, serialized: true },
  { id: '11', name: 'Casque sans fil', sku: 'SKU-1010', barcode: '3760123453905', folder: 'Audio', qty: 0, min: 1, price: 15900, serialized: true },
  { id: '12', name: 'Coque smartphone 5G', sku: 'SKU-1011', barcode: '3760123454131', folder: 'Téléphonie', qty: 25, min: 5, price: 1500 },
];

/** Articles d'exemple. */
export const items: Item[] = [...quantityItems, ...deviceItems];

/** Unités d'exemple (IMEI à clé de Luhn valide) ; dates fixées par `loadSampleData()`. */
export const units: Omit<Unit, 'receivedAt' | 'updatedAt'>[] = [
  { id: 'su1', itemId: '9', serial: 'R58W1A2B3C', imei: '356938035643809', status: 'in_stock' },
  { id: 'su2', itemId: '9', serial: 'R58W1A2B3D', imei: '356938035643817', status: 'in_stock' },
  { id: 'su3', itemId: '9', serial: 'R58W1A2B3E', imei: '356938035643825', status: 'repair', note: 'Écran fissuré' },
  { id: 'su4', itemId: '10', serial: 'PF4K7Z91', status: 'in_stock' },
  { id: 'su5', itemId: '10', serial: 'PF4K7Z92', status: 'assigned', assignee: 'Camille Martin' },
  { id: 'su6', itemId: '11', serial: 'JB-2391-0045', status: 'in_stock' },
  { id: 'su7', itemId: '11', serial: 'JB-2391-0046', status: 'in_stock' },
];

/** Mouvements d'exemple (convertis en mouvements datés par `loadSampleData()`). */
export const recent = [
  { id: 'r1', itemId: '1', label: 'Sortie · −2 · 09:42' },
  { id: 'r2', itemId: '3', label: 'Entrée · +10 · 09:15' },
];
