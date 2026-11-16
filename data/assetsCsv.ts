/**
 * Export CSV des appareils (unités suivies par numéro de série) pour l'import
 * dans Jira Service Management Assets : un objet par appareil, clé = numéro
 * de série.
 *
 * Module pur (aucune dépendance React Native), testable unitairement.
 *
 * Format (import CSV d'Assets, et non Excel) : UTF-8 SANS BOM, séparateur
 * virgule, fins de ligne CRLF, guillemets RFC 4180 (champ entre guillemets
 * s'il contient `,`, `"`, CR, LF ou des espaces en bordure ; `""` pour un
 * guillemet). Dates ISO 8601 en UTC (`yyyy-MM-ddTHH:mm:ssZ`). Statuts en
 * anglais (`UNIT_STATUS_JIRA_LABELS`).
 *
 * Injection de formules : un texte commençant par `=`, `+`, `@`, tabulation
 * ou retour chariot est préfixé d'une apostrophe. Le `-` n'est volontairement
 * PAS neutralisé : un numéro de série peut commencer par un tiret.
 */
import { UNIT_STATUS_JIRA_LABELS, serialKey, type Unit } from './units';

/** Champs d'article utilisés par l'export. */
export type AssetsCsvItem = { id: string; name: string; folder: string };

export const ASSETS_CSV_HEADER = [
  'Name', 'Serial Number', 'IMEI', 'Model', 'Category', 'Status', 'Assigned To', 'Received', 'Last Updated', 'Note',
] as const;

const SEP = ',';
const EOL = '\r\n';

function neutralize(text: string): string {
  return /^[=+@\t\r]/.test(text) ? `'${text}` : text;
}

function quote(field: string): string {
  if (/[,"\r\n]/.test(field) || /^\s|\s$/.test(field)) return `"${field.replace(/"/g, '""')}"`;
  return field;
}

/** Cellule CSV Assets (texte neutralisé puis échappé ; `undefined` = vide). */
export function assetsCsvCell(value: string | undefined): string {
  if (value === undefined || value === '') return '';
  return quote(neutralize(value));
}

/** Date-heure ISO 8601 UTC à la seconde : `2026-11-16T13:05:09Z` (vide si invalide). */
export function isoUtc(ts: number): string {
  const d = new Date(ts);
  if (!Number.isFinite(d.getTime())) return '';
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

const collator = (a: string, b: string) => a.localeCompare(b, 'fr', { sensitivity: 'base', numeric: true });

/**
 * Construit le CSV Assets : une ligne par unité, triées par nom d'article
 * puis par numéro de série. Les unités dont l'article est inconnu sont ignorées.
 */
export function buildAssetsCsv(units: readonly Unit[], items: readonly AssetsCsvItem[]): string {
  const byId = new Map(items.map((i) => [i.id, i]));
  const rows = units
    .map((unit) => ({ unit, item: byId.get(unit.itemId) }))
    .filter((r): r is { unit: Unit; item: AssetsCsvItem } => r.item !== undefined)
    .sort((a, b) => {
      const byName = collator(a.item.name, b.item.name) || (a.item.name < b.item.name ? -1 : a.item.name > b.item.name ? 1 : 0);
      if (byName !== 0) return byName;
      const ka = serialKey(a.unit.serial);
      const kb = serialKey(b.unit.serial);
      return collator(ka, kb) || (ka < kb ? -1 : ka > kb ? 1 : 0);
    });

  const lines = [ASSETS_CSV_HEADER.join(SEP)];
  for (const { unit, item } of rows) {
    lines.push(
      [
        `${item.name} - ${unit.serial}`,
        unit.serial,
        unit.imei,
        item.name,
        item.folder,
        UNIT_STATUS_JIRA_LABELS[unit.status],
        unit.status === 'assigned' ? unit.assignee : undefined,
        isoUtc(unit.receivedAt),
        isoUtc(unit.updatedAt),
        unit.note,
      ]
        .map(assetsCsvCell)
        .join(SEP)
    );
  }
  return lines.join(EOL) + EOL;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** Nom de fichier ASCII : `stockly-assets-<aaaammjj>-<hhmm>.csv` (heure locale). */
export function assetsCsvFilename(date: Date = new Date()): string {
  const ymd = `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}`;
  const hm = `${pad2(date.getHours())}${pad2(date.getMinutes())}`;
  return `stockly-assets-${ymd}-${hm}.csv`;
}
