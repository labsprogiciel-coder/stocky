/**
 * Export CSV d'un comptage cyclique.
 *
 * Module pur (aucune dépendance React Native) : il ne fait que construire des
 * chaînes, ce qui le rend testable unitairement.
 *
 * Format pensé pour Excel en français : UTF-8 avec BOM, séparateur `;`,
 * fins de ligne CRLF, champs entre guillemets si nécessaire (`""` pour un
 * guillemet), entiers sans séparateur de milliers.
 *
 * Identifiants numériques : Excel convertit tout champ composé uniquement de
 * chiffres en nombre (notation scientifique, zéros de tête perdus), même entre
 * guillemets. Un SKU ou code-barres composé uniquement de chiffres est donc
 * écrit sous forme de formule texte `="0012345678905"` (sûre : elle ne
 * contient que des chiffres), qu'Excel affiche comme du texte.
 *
 * Comptage à l'aveugle en cours : le stock attendu et les écarts ne sont pas
 * exportés (ils restent masqués tant que le comptage n'est pas terminé).
 */
import type { CountSession, CountStatus } from './store';

export type CsvCountInfo = {
  id: string;
  name: string;
  folder: string;
  blind: boolean;
};

export type CsvCountItem = {
  id: string;
  sku: string;
  barcode?: string;
  name: string;
  folder: string;
  /** Stock actuel de l'article. */
  qty: number;
};

export type BuildCountCsvInput = {
  count: CsvCountInfo;
  /** `startedAt` absent : comptage non démarré (aucune session enregistrée). */
  session: Pick<CountSession, 'entries' | 'completedAt' | 'expected'> & { startedAt?: number };
  /** Articles du comptage, dans l'ordre du comptage. */
  items: readonly CsvCountItem[];
  /** Date de l'export (epoch ms). */
  exportedAt: number;
};

export type CountRowStatus = CountStatus | 'À compter';

const SEP = ';';
const EOL = '\r\n';
const BOM = '﻿';

const COLUMNS = ['SKU', 'Code-barres', 'Article', 'Dossier', 'Stock attendu', 'Quantité comptée', 'Écart', 'Statut'];

type Cell = string | number | undefined;

/**
 * Neutralise l'injection de formules : un texte commençant par `=`, `+`, `-`,
 * `@`, tabulation ou retour chariot est préfixé d'une apostrophe.
 */
function neutralize(text: string): string {
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}

/** Entier (ou nombre fini) écrit tel quel ; sinon champ vide. */
function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return '';
  return Number.isInteger(n) ? n.toFixed(0) : String(n);
}

/** Met un champ entre guillemets s'il contient `;`, `"`, CR, LF ou des espaces en bordure. */
function quote(field: string): string {
  if (/[;"\r\n]/.test(field) || /^\s|\s$/.test(field)) return `"${field.replace(/"/g, '""')}"`;
  return field;
}

/**
 * Cellule CSV. Les textes sont neutralisés (injection de formules) puis
 * échappés ; les nombres, générés par l'application, sont écrits tels quels
 * (un écart négatif reste donc `-3`).
 */
export function csvCell(value: Cell): string {
  if (value === undefined) return '';
  if (typeof value === 'number') return formatNumber(value);
  return quote(neutralize(value));
}

/**
 * Cellule d'identifiant (SKU, code-barres) : une valeur composée uniquement de
 * chiffres est écrite `="…"` pour qu'Excel la garde en texte.
 */
export function csvIdCell(value: string): string {
  if (/^[0-9]+$/.test(value)) return quote(`="${value}"`);
  return csvCell(value);
}

function csvLine(cells: readonly Cell[]): string {
  return cells.map(csvCell).join(SEP);
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** Date et heure locales au format `jj/mm/aaaa HH:MM` (indépendant de l'Intl). */
export function formatCsvDateTime(ts: number): string {
  const d = new Date(ts);
  return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** Nom de fichier ASCII : `stockly-comptage-<id>-<aaaammjj>-<hhmm>.csv`. */
export function countCsvFilename(id: string, date: Date = new Date()): string {
  const safeId = id.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'comptage';
  const ymd = `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}`;
  const hm = `${pad2(date.getHours())}${pad2(date.getMinutes())}`;
  return `stockly-comptage-${safeId}-${ymd}-${hm}.csv`;
}

/** Construit le contenu CSV complet (BOM inclus) d'un comptage. */
export function buildCountCsv({ count, session, items, exportedAt }: BuildCountCsvInput): string {
  const lines: string[] = [
    csvLine(['Comptage', count.name]),
    csvLine(['Dossier', count.folder]),
    csvLine(['Statut', session.completedAt !== undefined ? 'Terminé' : 'En cours']),
    csvLine(['Démarré le', session.startedAt !== undefined ? formatCsvDateTime(session.startedAt) : 'Non démarré']),
  ];
  if (session.completedAt !== undefined) lines.push(csvLine(['Terminé le', formatCsvDateTime(session.completedAt)]));
  lines.push(
    csvLine(["Comptage à l'aveugle", count.blind ? 'Oui' : 'Non']),
    csvLine(['Exporté le', formatCsvDateTime(exportedAt)]),
    '',
    csvLine(COLUMNS),
  );

  // Comptage à l'aveugle en cours : ne pas révéler le stock attendu.
  const hideExpected = count.blind && session.completedAt === undefined;
  let counted = 0;
  let skipped = 0;
  let withDiff = 0;
  let diffSum = 0;

  for (const item of items) {
    const entry = session.entries[item.id];
    const status: CountRowStatus = entry?.status ?? 'À compter';
    const expected = session.expected?.[item.id] ?? item.qty;
    let countedQty: number | undefined;
    let diff: number | undefined;
    if (entry?.status === 'Compté') {
      counted++;
      countedQty = entry.qty;
      if (!hideExpected) {
        diff = entry.qty - expected;
        if (diff !== 0) withDiff++;
        diffSum += diff;
      }
    } else if (entry?.status === 'Passé') {
      skipped++;
    }
    const rest = csvLine([item.name, item.folder, hideExpected ? undefined : expected, countedQty, diff, status]);
    lines.push([csvIdCell(item.sku), csvIdCell(item.barcode ?? ''), rest].join(SEP));
  }

  lines.push(
    '',
    csvLine(['Articles', items.length]),
    csvLine(['Comptés', counted]),
    csvLine(['Passés', skipped]),
    csvLine(['À compter', items.length - counted - skipped]),
    csvLine(['Articles avec écart', hideExpected ? undefined : withDiff]),
    csvLine(['Somme des écarts', hideExpected ? undefined : diffSum]),
  );

  return BOM + lines.join(EOL) + EOL;
}
