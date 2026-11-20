/**
 * Export Excel (Stockly Pro) : appareils et articles suivis en quantité.
 *
 * Module pur (aucune dépendance React Native), testable unitairement.
 *
 * Même format que l'export du comptage (`data/csv.ts`), pensé pour Excel en
 * français : UTF-8 avec BOM, séparateur `;`, fins de ligne CRLF, guillemets
 * si nécessaire, neutralisation des formules (`'` devant `=`, `+`, `-`, `@`),
 * identifiants composés uniquement de chiffres écrits `="…"` (numéro de
 * série, IMEI 1 et 2, SKU, code-barres : zéros de tête et 15 chiffres conservés).
 *
 * DEUX fichiers, un tableau chacun, plutôt qu'un fichier à deux sections :
 * Excel ouvre un CSV comme une seule feuille, et le tri ou le filtre
 * automatique d'une feuille contenant deux tableaux (colonnes différentes,
 * lignes de titre au milieu) mélange les lignes. Avec une ligne d'en-tête
 * unique en première ligne, chaque fichier se trie et se filtre directement,
 * et se réimporte tel quel (« Importer depuis Excel »). Le fichier des
 * appareils reprend aussi le SKU, le code-barres, le seuil et le prix de leur
 * article, et celui des articles leur prix : réimportés (dans n'importe quel
 * ordre), les articles gardent leurs codes.
 *
 * Pour COPIER un téléphone (second téléphone, changement de téléphone),
 * utiliser plutôt la sauvegarde (Profil › Données) : elle reprend tout, y
 * compris les articles suivis par numéro de série sans appareil (absents de
 * ces deux fichiers), l'historique et les comptages.
 */
import { csvCell, csvIdCell, formatCsvDateTime } from './csv';
import { UNIT_STATUS_LABELS, serialKey, type Unit } from './units';

/** Champs d'article utilisés par les exports. */
export type ExportItem = {
  id: string;
  name: string;
  sku: string;
  barcode?: string;
  folder: string;
  qty: number;
  min: number;
  price?: number;
  serialized?: boolean;
};

export const DEVICES_CSV_HEADER = [
  'Article', 'Catégorie', 'Numéro de série', 'IMEI', 'IMEI 2', 'Statut', 'Attribué à', 'Reçu le', 'Modifié le', 'Note',
  'SKU', 'Code-barres', 'Seuil', 'Prix',
] as const;

export const ARTICLES_CSV_HEADER = ['Article', 'SKU', 'Code-barres', 'Catégorie', 'Quantité', 'Seuil', 'Prix'] as const;

/** Prix : entier tel quel, décimal avec une virgule (lu comme un nombre par Excel en français). */
function priceCell(p: number | undefined): string {
  if (p === undefined || !Number.isFinite(p)) return '';
  return Number.isInteger(p) ? csvCell(p) : csvCell(String(p).replace('.', ','));
}

const SEP = ';';
const EOL = '\r\n';
const BOM = '\ufeff';

const collator = (a: string, b: string) => a.localeCompare(b, 'fr', { sensitivity: 'base', numeric: true }) || (a < b ? -1 : a > b ? 1 : 0);

/**
 * Tous les appareils, triés par article puis par numéro de série. Les
 * appareils dont l'article est inconnu sont ignorés.
 */
export function buildDevicesCsv(units: readonly Unit[], items: readonly ExportItem[]): string {
  const byId = new Map(items.map((i) => [i.id, i]));
  const rows = units
    .map((unit) => ({ unit, item: byId.get(unit.itemId) }))
    .filter((r): r is { unit: Unit; item: ExportItem } => r.item !== undefined)
    .sort((a, b) => collator(a.item.name, b.item.name) || collator(serialKey(a.unit.serial), serialKey(b.unit.serial)));
  const lines = [DEVICES_CSV_HEADER.map(csvCell).join(SEP)];
  for (const { unit, item } of rows) {
    lines.push(
      [
        csvCell(item.name),
        csvCell(item.folder),
        csvIdCell(unit.serial),
        csvIdCell(unit.imei ?? ''),
        csvIdCell(unit.imei2 ?? ''),
        csvCell(UNIT_STATUS_LABELS[unit.status] ?? unit.status),
        csvCell(unit.status === 'assigned' ? unit.assignee : undefined),
        csvCell(Number.isFinite(unit.receivedAt) ? formatCsvDateTime(unit.receivedAt) : undefined),
        csvCell(Number.isFinite(unit.updatedAt) ? formatCsvDateTime(unit.updatedAt) : undefined),
        csvCell(unit.note),
        csvIdCell(item.sku),
        csvIdCell(item.barcode ?? ''),
        csvCell(item.min),
        priceCell(item.price),
      ].join(SEP)
    );
  }
  return BOM + lines.join(EOL) + EOL;
}

/** Articles suivis en quantité (les articles suivis par numéro de série sont dans l'export des appareils), triés par nom. */
export function buildArticlesCsv(items: readonly ExportItem[]): string {
  const rows = items.filter((i) => !i.serialized).sort((a, b) => collator(a.name, b.name));
  const lines = [ARTICLES_CSV_HEADER.map(csvCell).join(SEP)];
  for (const i of rows) {
    lines.push([csvCell(i.name), csvIdCell(i.sku), csvIdCell(i.barcode ?? ''), csvCell(i.folder), csvCell(i.qty), csvCell(i.min), priceCell(i.price)].join(SEP));
  }
  return BOM + lines.join(EOL) + EOL;
}

const pad2 = (n: number) => String(n).padStart(2, '0');
const stamp = (d: Date) =>
  `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}`;

/** `stockly-appareils-<aaaammjj>-<hhmm>.csv` (heure locale). */
export function devicesCsvFilename(date: Date = new Date()): string {
  return `stockly-appareils-${stamp(date)}.csv`;
}

/** `stockly-articles-<aaaammjj>-<hhmm>.csv` (heure locale). */
export function articlesCsvFilename(date: Date = new Date()): string {
  return `stockly-articles-${stamp(date)}.csv`;
}
