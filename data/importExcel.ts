/**
 * Lecture d'un fichier Excel (.xlsx) ou CSV pour l'import (Stockly Pro).
 *
 * Module pur (aucune dépendance React Native) : il reçoit les octets du
 * fichier et produit des lignes interprétées (`ImportRecord`) que
 * `importInventory` (`data/store.ts`) valide et enregistre. Testable sous Node.
 *
 * - `.xlsx` : archive ZIP (décompressée par `fflate`, pur JavaScript) dont on
 *   lit le classeur, les chaînes partagées, les styles (pour reconnaître les
 *   dates) et la feuille choisie, avec un petit analyseur XML dédié. Les
 *   formules ne sont pas évaluées : on lit la dernière valeur calculée
 *   enregistrée par Excel.
 * - CSV : séparateur détecté (`;`, `,` ou tabulation), BOM, guillemets
 *   (`""`, retours à la ligne dans un champ), fins de ligne CRLF/LF/CR.
 *   Encodage : UTF-8 (avec ou sans BOM), UTF-16 (BOM) ou, à défaut,
 *   Windows-1252 (« CSV (séparateur : point-virgule) » d'Excel en français).
 * - `.xls` (ancien format binaire) : non pris en charge, message explicite.
 *
 * Les cellules écrites par les exports Stockly sont relues telles qu'elles :
 * `="0012345"` (identifiant numérique gardé en texte) devient `0012345`, et
 * l'apostrophe ajoutée devant `=`, `+`, `-`, `@` (neutralisation des
 * formules) est retirée.
 */
import { strFromU8, unzipSync } from 'fflate';
import type { ImportRecord } from './store';
import { NOTE_MAX_LENGTH, foldAccents, type UnitStatus } from './units';

// ── Tableau lu ─────────────────────────────────────────────────────────────

/**
 * Cellule de classeur dont la valeur texte n'est pas fiable comme identifiant :
 * `imprecise` = nombre de 16 chiffres ou plus (Excel ne garde que 15 chiffres
 * significatifs : les derniers sont perdus ou inventés), `decimal` = nombre non
 * entier, `formula` = formule sans résultat enregistré, `date` = nombre au
 * format date (converti en `jj/mm/aaaa` : le nombre d'origine n'est pas gardé).
 */
export type CellIssue = 'imprecise' | 'decimal' | 'formula' | 'date';

/**
 * Ligne non vide d'une feuille : `n` = numéro de ligne (comme dans Excel),
 * `cells` = valeurs texte, `issues` (classeur) = cellules douteuses par colonne.
 */
export type SheetRow = { n: number; cells: string[]; issues?: (CellIssue | undefined)[] };

export type Sheet = { name: string; rows: SheetRow[] };

/**
 * Fichier lu : une feuille (CSV) ou plusieurs (classeur Excel). `date1904` :
 * calendrier des dates du classeur. `notice` : avertissement à afficher
 * (encodage mélangé…).
 */
export type ImportFile = { kind: 'csv' | 'xlsx'; sheets: Sheet[]; delimiter?: string; date1904?: boolean; notice?: string };

export class ImportFileError extends Error {}

/** Limites de protection (fichier, nombre de lignes, colonnes lues). */
export const IMPORT_MAX_BYTES = 20 * 1024 * 1024;
export const IMPORT_MAX_ROWS = 10_000;
const MAX_COLUMNS = 256;
const MAX_UNZIPPED = 120 * 1024 * 1024;

/**
 * Lit un fichier (octets). `fileName` sert seulement à reconnaître un CSV
 * enregistré sous un autre nom ; le format est déterminé par le contenu.
 * Lève `ImportFileError` (message en français) si le fichier est illisible.
 */
export function readImportFile(bytes: Uint8Array, fileName = ''): ImportFile {
  if (bytes.length === 0) throw new ImportFileError('Le fichier est vide.');
  if (bytes.length > IMPORT_MAX_BYTES) {
    throw new ImportFileError(`Fichier trop volumineux (${Math.round(bytes.length / 1024 / 1024)} Mo, 20 Mo au maximum).`);
  }
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) return readXlsx(bytes);
  if (bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) {
    throw new ImportFileError(
      "Ce fichier est au format Excel 97-2003 (.xls) ou protégé par un mot de passe : il n'est pas pris en charge. Dans Excel, choisissez Fichier › Enregistrer sous › « Classeur Excel (.xlsx) » ou « CSV », sans mot de passe, puis réessayez."
    );
  }
  if (/\.(xlsx|xlsm)$/i.test(fileName)) throw new ImportFileError("Ce fichier .xlsx est illisible (archive invalide). Ouvrez-le dans Excel et enregistrez-le à nouveau.");
  const { text, notice } = decodeTextInfo(bytes);
  if (text.includes('\u0000')) throw new ImportFileError("Ce fichier n'est pas un fichier CSV ou Excel lisible.");
  const delimiter = detectDelimiter(text);
  const rows = csvSheetRows(text, delimiter);
  return { kind: 'csv', delimiter, sheets: [{ name: fileName.replace(/^.*[\\/]/, '') || 'CSV', rows }], ...(notice ? { notice } : {}) };
}

/**
 * Lignes non vides d'un CSV, lues au fil du découpage : les lignes vides ne
 * sont pas gardées (des millions de retours à la ligne ne créent pas des
 * millions de tableaux), les colonnes au-delà de `MAX_COLUMNS` ne sont pas
 * lues et la limite de lignes est vérifiée pendant la lecture. `n` = numéro
 * d'enregistrement dans le fichier (lignes vides comprises).
 */
function csvSheetRows(text: string, delimiter: string): SheetRow[] {
  const out: SheetRow[] = [];
  scanCsv(text, delimiter, MAX_COLUMNS, (cells, i) => {
    if (cells.some((c) => c.trim() !== '')) {
      out.push({ n: i + 1, cells });
      if (out.length > IMPORT_MAX_ROWS + 50) tooManyRows();
    }
    return true;
  });
  return out;
}

function tooManyRows(): never {
  throw new ImportFileError(`Le fichier contient plus de 10 000 lignes : découpez-le en plusieurs fichiers.`);
}

// ── Texte ──────────────────────────────────────────────────────────────────

/** Windows-1252, octets 0x80–0x9F (les autres octets ≥ 0xA0 = Latin-1). */
const CP1252 = [
  0x20ac, 0x81, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x8d, 0x017d, 0x8f,
  0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x9d, 0x017e, 0x0178,
];

function fromCodes(codes: number[], out: string[]): void {
  // Par blocs, pour ne pas dépasser la limite d'arguments de `fromCharCode`.
  for (let i = 0; i < codes.length; i += 8192) out.push(String.fromCharCode.apply(null, codes.slice(i, i + 8192)));
}

/** Décode de l'UTF-8 strict ; `null` si les octets ne sont pas de l'UTF-8 valide. */
export function decodeUtf8(b: Uint8Array, start = 0): string | null {
  const r = utf8Decode(b, start, false);
  return r && r.text;
}

/**
 * Décodeur UTF-8. `lenient` : un octet invalide est lu comme un caractère
 * Windows-1252 (fichier UTF-8 modifié par un logiciel en Windows-1252, ou
 * l'inverse) au lieu d'échouer (`null`). Compte les octets invalides et les
 * séquences multi-octets valides.
 */
function utf8Decode(b: Uint8Array, start: number, lenient: boolean): { text: string; invalid: number; multi: number } | null {
  const out: string[] = [];
  let codes: number[] = [];
  let i = start;
  let invalid = 0;
  let multi = 0;
  while (i < b.length) {
    const c = b[i];
    let cp: number = -1;
    if (c < 0x80) {
      cp = c;
      i++;
    } else if (c >= 0xc2 && c <= 0xdf) {
      const c1 = b[i + 1];
      if (c1 !== undefined && (c1 & 0xc0) === 0x80) {
        cp = ((c & 0x1f) << 6) | (c1 & 0x3f);
        i += 2;
      }
    } else if (c >= 0xe0 && c <= 0xef) {
      const c1 = b[i + 1], c2 = b[i + 2];
      if (c1 !== undefined && c2 !== undefined && (c1 & 0xc0) === 0x80 && (c2 & 0xc0) === 0x80) {
        const v = ((c & 0x0f) << 12) | ((c1 & 0x3f) << 6) | (c2 & 0x3f);
        if (!(v < 0x800 || (v >= 0xd800 && v <= 0xdfff))) {
          cp = v;
          i += 3;
        }
      }
    } else if (c >= 0xf0 && c <= 0xf4) {
      const c1 = b[i + 1], c2 = b[i + 2], c3 = b[i + 3];
      if (c1 !== undefined && c2 !== undefined && c3 !== undefined && (c1 & 0xc0) === 0x80 && (c2 & 0xc0) === 0x80 && (c3 & 0xc0) === 0x80) {
        const v = ((c & 0x07) << 18) | ((c1 & 0x3f) << 12) | ((c2 & 0x3f) << 6) | (c3 & 0x3f);
        if (!(v < 0x10000 || v > 0x10ffff)) {
          cp = v;
          i += 4;
        }
      }
    }
    if (cp === -1) {
      if (!lenient) return null;
      invalid++;
      cp = c >= 0x80 && c < 0xa0 ? CP1252[c - 0x80] : c;
      i++;
    } else if (c >= 0x80) {
      multi++;
    }
    if (cp >= 0x10000) {
      cp -= 0x10000;
      codes.push(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
    } else {
      codes.push(cp);
    }
    if (codes.length >= 8192) {
      fromCodes(codes, out);
      codes = [];
    }
  }
  fromCodes(codes, out);
  return { text: out.join(''), invalid, multi };
}

function decodeUtf16(b: Uint8Array, start: number, littleEndian: boolean): string {
  const codes: number[] = [];
  for (let i = start; i + 1 < b.length; i += 2) codes.push(littleEndian ? b[i] | (b[i + 1] << 8) : (b[i] << 8) | b[i + 1]);
  const out: string[] = [];
  fromCodes(codes, out);
  return out.join('');
}

function decodeCp1252(b: Uint8Array): string {
  const codes: number[] = new Array(b.length);
  for (let i = 0; i < b.length; i++) {
    const c = b[i];
    codes[i] = c >= 0x80 && c < 0xa0 ? CP1252[c - 0x80] : c;
  }
  const out: string[] = [];
  fromCodes(codes, out);
  return out.join('');
}

/** Texte d'un fichier CSV (voir `decodeTextInfo`). */
export function decodeText(b: Uint8Array): string {
  return decodeTextInfo(b).text;
}

const mixedNotice = (n: number) =>
  `Encodage mélangé : ${n === 1 ? '1 caractère n\'est' : `${n} caractères ne sont`} pas en UTF-8 (lu${n === 1 ? '' : 's'} en Windows-1252). Vérifiez les accents dans l'aperçu ; au besoin, réenregistrez le fichier en « CSV UTF-8 ».`;

/**
 * Texte d'un fichier CSV : BOM UTF-16 reconnu ; BOM UTF-8 → UTF-8 (un octet
 * invalide isolé est lu en Windows-1252, avec un avertissement, au lieu de
 * relire tout le fichier en Windows-1252) ; sans BOM : UTF-8 si valide,
 * Windows-1252 si aucun caractère UTF-8 n'y figure, sinon mélange des deux
 * octet par octet (avertissement).
 */
export function decodeTextInfo(b: Uint8Array): { text: string; notice?: string } {
  if (b[0] === 0xff && b[1] === 0xfe) return { text: decodeUtf16(b, 2, true) };
  if (b[0] === 0xfe && b[1] === 0xff) return { text: decodeUtf16(b, 2, false) };
  const bom = b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf;
  const r = utf8Decode(b, bom ? 3 : 0, true)!;
  if (r.invalid === 0) return { text: r.text };
  if (!bom && r.multi === 0) return { text: decodeCp1252(b) };
  return { text: r.text, notice: mixedNotice(r.invalid) };
}

// ── CSV ────────────────────────────────────────────────────────────────────

/**
 * Découpe un texte CSV (guillemets RFC 4180, `""` pour un guillemet, retours
 * à la ligne possibles dans un champ entre guillemets, fins de ligne CRLF,
 * LF ou CR). `maxRecords` limite la lecture (détection du séparateur).
 */
export function parseCsv(text: string, delimiter: string, maxRecords = Infinity): string[][] {
  const records: string[][] = [];
  scanCsv(text, delimiter, Infinity, (r) => {
    records.push(r);
    return records.length < maxRecords;
  });
  return records;
}

/**
 * Découpage CSV : `onRecord(champs, index)` est appelé pour chaque
 * enregistrement (index à partir de 0, lignes vides comprises) ; `false`
 * arrête la lecture. Au-delà de `maxFields` champs, les suivants sont ignorés.
 */
function scanCsv(text: string, delimiter: string, maxFields: number, onRecord: (record: string[], index: number) => boolean): void {
  let count = 0;
  let record: string[] = [];
  let field = '';
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const n = text.length;
  const d = delimiter;
  let quoted = false;
  let fieldStart = true;
  while (i < n) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      // Copie rapide jusqu'au prochain guillemet.
      const q = text.indexOf('"', i);
      const end = q === -1 ? n : q;
      field += text.slice(i, end);
      i = end;
      continue;
    }
    if (ch === '"' && fieldStart) {
      quoted = true;
      fieldStart = false;
      i++;
      continue;
    }
    if (ch === d) {
      if (record.length < maxFields) record.push(field);
      field = '';
      fieldStart = true;
      i++;
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      if (record.length < maxFields) record.push(field);
      if (!onRecord(record, count++)) return;
      record = [];
      field = '';
      fieldStart = true;
      i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    // Copie rapide jusqu'au prochain caractère spécial.
    let j = i + 1;
    while (j < n) {
      const c = text[j];
      if (c === d || c === '\r' || c === '\n' || c === '"') break;
      j++;
    }
    field += text.slice(i, j);
    fieldStart = false;
    i = j;
  }
  if (field !== '' || record.length > 0 || fieldStart === false) {
    if (record.length < maxFields) record.push(field);
    onRecord(record, count);
  }
}

/**
 * Séparateur le plus probable parmi `;`, `,` et tabulation : celui qui donne
 * le plus de lignes ayant le même nombre (> 1) de colonnes sur les premières
 * lignes. À égalité : `;` (Excel en français), puis tabulation, puis `,`.
 */
export function detectDelimiter(text: string): string {
  const sample = text.slice(0, 64 * 1024);
  let best = ';';
  let bestScore = -1;
  for (const d of [';', '\t', ',']) {
    const recs = parseCsv(sample, d, 30).filter((r) => r.some((c) => c.trim() !== ''));
    const counts = new Map<number, number>();
    for (const r of recs) if (r.length > 1) counts.set(r.length, (counts.get(r.length) ?? 0) + 1);
    let score = 0;
    for (const [cols, k] of counts) score = Math.max(score, k * 1000 + cols);
    if (score > bestScore) {
      best = d;
      bestScore = score;
    }
  }
  return best;
}

// ── XLSX ───────────────────────────────────────────────────────────────────

const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** Texte XML : entités, puis échappements OOXML `_xHHHH_`. */
function xmlText(s: string): string {
  let t = s.indexOf('&') === -1 ? s : s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_m, e: string) => {
    if (e[0] !== '#') return XML_ENTITIES[e];
    const cp = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
  });
  if (t.indexOf('_x') !== -1) t = t.replace(/_x([0-9A-Fa-f]{4})_/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)));
  return t;
}

function attrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const name = m[1];
    const local = name.includes(':') ? name.slice(name.indexOf(':') + 1) : name;
    const v = xmlText(m[2] ?? m[3] ?? '');
    out[name] = v;
    if (!(local in out)) out[local] = v;
  }
  return out;
}

/** Éléments `<prefix:tag …>…</prefix:tag>` ou `<tag …/>` (attributs, contenu). */
const TAG_RE = new Map<string, RegExp>();

function elements(xml: string, tag: string): { a: string; body: string }[] {
  let re = TAG_RE.get(tag);
  if (!re) {
    re = new RegExp(`<(?:[\\w.-]+:)?${tag}(?=[\\s/>])([^>]*?)(?:/>|>([\\s\\S]*?)</(?:[\\w.-]+:)?${tag}>)`, 'g');
    TAG_RE.set(tag, re);
  }
  re.lastIndex = 0;
  const out: { a: string; body: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) out.push({ a: m[1], body: m[2] ?? '' });
  return out;
}

/** Concatène les `<t>` d'un texte riche (hors indications phonétiques `<rPh>`). */
function richText(body: string): string {
  const clean = body.indexOf('rPh') === -1 ? body : body.replace(/<(?:[\w.-]+:)?rPh\b[\s\S]*?<\/(?:[\w.-]+:)?rPh>/g, '');
  let out = '';
  for (const t of elements(clean, 't')) out += xmlText(t.body);
  return out;
}

function colIndex(ref: string): number {
  let n = 0;
  for (let i = 0; i < ref.length; i++) {
    const c = ref.charCodeAt(i);
    if (c >= 65 && c <= 90) n = n * 26 + (c - 64);
    else if (c >= 97 && c <= 122) n = n * 26 + (c - 96);
    else break;
  }
  return n - 1;
}

/** Lettre de colonne Excel (0 → A, 26 → AA). */
export function columnLetter(i: number): string {
  let s = '';
  let n = i + 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);

/** Code de format Excel de date/heure (hors texte entre guillemets, couleurs et conditions). */
export function isDateFormatCode(code: string): boolean {
  const c = code.replace(/"[^"]*"/g, '').replace(/\\./g, '').replace(/\[(?!h\]|hh\]|m\]|mm\]|s\]|ss\])[^\]]*\]/gi, '');
  return /[dmyhs]/i.test(c) && !/^general$/i.test(c.trim());
}

/**
 * Nombre de chiffres d'un format « zéros de tête » (`000000` affiche 123 en
 * `000123`, format courant pour des numéros de série ou des codes) ; 0 sinon.
 */
export function zeroPadDigits(code: string): number {
  const c = code.split(';')[0].replace(/"[^"]*"/g, '').trim();
  return /^0{2,}$/.test(c) ? c.length : 0;
}

/** Styles de cellule (index `s`) : ceux qui affichent une date, et ceux à zéros de tête (nombre de chiffres). */
function cellStyles(stylesXml: string | undefined): { dates: Set<number>; pad: Map<number, number> } {
  const dates = new Set<number>();
  const pad = new Map<number, number>();
  if (!stylesXml) return { dates, pad };
  const custom = new Map<number, string>();
  for (const f of elements(stylesXml, 'numFmt')) {
    const a = attrs(f.a);
    custom.set(Number(a.numFmtId), a.formatCode ?? '');
  }
  const xfs = elements(stylesXml, 'cellXfs')[0];
  if (!xfs) return { dates, pad };
  elements(xfs.body, 'xf').forEach((xf, i) => {
    const id = Number(attrs(xf.a).numFmtId ?? 0);
    const code = custom.get(id);
    if (code !== undefined ? isDateFormatCode(code) : BUILTIN_DATE_FORMATS.has(id)) dates.add(i);
    else if (code !== undefined && zeroPadDigits(code) > 0) pad.set(i, zeroPadDigits(code));
  });
  return { dates, pad };
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** Date Excel (numéro de série, système 1900 ou 1904) → texte `jj/mm/aaaa[ HH:MM]`, sans fuseau. */
export function excelSerialToText(serial: number, date1904 = false): string | null {
  if (!Number.isFinite(serial) || serial < 1 || serial > 2_958_465) return null;
  const ms = Math.round((serial + (date1904 ? 1462 : 0) - 25569) * 86_400_000);
  const d = new Date(ms);
  const date = `${pad2(d.getUTCDate())}/${pad2(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
  const hasTime = d.getUTCHours() !== 0 || d.getUTCMinutes() !== 0;
  return hasTime ? `${date} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}` : date;
}

/** Nombre Excel → texte : entier sans exposant (IMEI de 15 chiffres, code-barres), sinon tel quel. */
function numberText(v: string): string {
  if (!/[eE]/.test(v)) return v;
  const n = Number(v);
  return Number.isInteger(n) && Math.abs(n) < 1e21 ? n.toFixed(0) : v;
}

function resolvePath(target: string): string {
  const t = target.replace(/\\/g, '/');
  if (t.startsWith('/')) return t.slice(1);
  const parts = `xl/${t}`.split('/');
  const out: string[] = [];
  for (const p of parts) {
    if (p === '..') out.pop();
    else if (p !== '.' && p !== '') out.push(p);
  }
  return out.join('/');
}

function readXlsx(bytes: Uint8Array): ImportFile {
  let files: Record<string, Uint8Array>;
  let total = 0;
  try {
    files = unzipSync(bytes, {
      filter: (f) => {
        if (!/^xl\/.*\.(xml|rels)$/i.test(f.name) || /^xl\/(media|printerSettings|drawings|charts|pivot|external|theme)/i.test(f.name)) return false;
        total += f.originalSize;
        if (f.originalSize > MAX_UNZIPPED || total > MAX_UNZIPPED) throw new ImportFileError('Classeur trop volumineux une fois décompressé.');
        return true;
      },
    });
  } catch (e) {
    if (e instanceof ImportFileError) throw e;
    throw new ImportFileError("Ce fichier .xlsx est illisible (archive endommagée ou format non pris en charge). Ouvrez-le dans Excel et enregistrez-le à nouveau.");
  }
  const text = (path: string): string | undefined => {
    const key = Object.keys(files).find((k) => k.toLowerCase() === path.toLowerCase());
    return key ? strFromU8(files[key]) : undefined;
  };
  const workbook = text('xl/workbook.xml');
  if (!workbook) throw new ImportFileError("Ce fichier .xlsx ne contient pas de classeur Excel lisible.");
  const date1904 = /date1904\s*=\s*["'](1|true)["']/i.test(elements(workbook, 'workbookPr')[0]?.a ?? '');
  const rels = new Map<string, string>();
  for (const r of elements(text('xl/_rels/workbook.xml.rels') ?? '', 'Relationship')) {
    const a = attrs(r.a);
    if (a.Id && a.Target) rels.set(a.Id, resolvePath(a.Target));
  }
  const shared = elements(text('xl/sharedStrings.xml') ?? '', 'si').map((si) => richText(si.body));
  const styles = cellStyles(text('xl/styles.xml'));

  const sheets: Sheet[] = [];
  for (const sh of elements(workbook, 'sheet')) {
    const a = attrs(sh.a);
    if (a.state === 'hidden' || a.state === 'veryHidden') continue;
    const path = rels.get(a.id ?? '');
    const xml = path ? text(path) : undefined;
    if (xml === undefined) continue; // feuille de graphique, macro…
    sheets.push({ name: a.name || `Feuille ${sheets.length + 1}`, rows: readSheetRows(xml, shared, styles, date1904) });
  }
  if (sheets.length === 0) throw new ImportFileError('Aucune feuille de calcul lisible dans ce classeur.');
  return { kind: 'xlsx', sheets, date1904 };
}

/** Plus grand entier qu'Excel enregistre sans perte (15 chiffres significatifs). */
const EXCEL_EXACT_LIMIT = 1e15;

function readSheetRows(
  xml: string,
  shared: string[],
  styles: { dates: Set<number>; pad: Map<number, number> },
  date1904: boolean
): SheetRow[] {
  const { dates, pad } = styles;
  const start = xml.search(/<(?:[\w.-]+:)?sheetData\b/);
  const data = start === -1 ? '' : xml.slice(start);
  const out: SheetRow[] = [];
  let next = 1;
  for (const row of elements(data, 'row')) {
    const ra = attrs(row.a);
    const n = ra.r !== undefined && /^\d+$/.test(ra.r) ? Number(ra.r) : next;
    next = n + 1;
    const cells: string[] = [];
    let issues: (CellIssue | undefined)[] | undefined;
    const flag = (c: number, issue: CellIssue) => {
      if (!issues) issues = [];
      issues[c] = issue;
    };
    let col = 0;
    for (const c of elements(row.body, 'c')) {
      const a = attrs(c.a);
      if (a.r) col = colIndex(a.r);
      if (col >= MAX_COLUMNS || col < 0) {
        col++;
        continue;
      }
      const t = a.t ?? 'n';
      let v = '';
      if (t === 'inlineStr') {
        const is = elements(c.body, 'is')[0];
        v = is ? richText(is.body) : '';
      } else {
        const raw = elements(c.body, 'v')[0];
        const val = raw ? xmlText(raw.body) : '';
        // Formule sans résultat enregistré : pas de `<v>`, ou `<v/>` vide (sauf texte vide calculé).
        if ((!raw || (val === '' && t !== 'str')) && elements(c.body, 'f').length > 0) flag(col, 'formula');
        if (t === 's') v = shared[Number(val)] ?? '';
        else if (t === 'str' || t === 'd') v = val;
        else if (t === 'b') v = val === '1' ? 'VRAI' : val === '0' ? 'FAUX' : '';
        else if (t === 'e') v = '';
        else if (val !== '' && dates.has(Number(a.s ?? -1)) && excelSerialToText(Number(val), date1904) !== null) {
          // Gardé pour une date de réception ; refusé comme identifiant.
          v = excelSerialToText(Number(val), date1904)!;
          flag(col, 'date');
        }
        else {
          // Nombre (y compris hors des dates possibles dans une cellule au format date).
          v = numberText(val);
          const num = Number(val);
          if (val !== '' && Number.isFinite(num)) {
            if (!Number.isInteger(num)) flag(col, 'decimal');
            else if (Math.abs(num) >= EXCEL_EXACT_LIMIT) flag(col, 'imprecise');
            else {
              // Format « 000000 » : zéros de tête affichés par Excel, gardés.
              const digits = pad.get(Number(a.s ?? -1));
              if (digits && num >= 0) v = v.padStart(digits, '0');
            }
          }
        }
      }
      while (cells.length < col) cells.push('');
      cells[col] = v;
      col++;
    }
    // Ligne entièrement vide (y compris formules sans résultat recopiées vers le bas) : ignorée.
    if (cells.some((x) => x.trim() !== '')) {
      out.push(issues ? { n, cells, issues } : { n, cells });
      if (out.length > IMPORT_MAX_ROWS + 50) tooManyRows();
    }
  }
  return out;
}

// ── Colonnes ───────────────────────────────────────────────────────────────

export type ImportField =
  | 'name' | 'folder' | 'serial' | 'imei' | 'status' | 'assignee' | 'qty' | 'sku' | 'barcode' | 'note' | 'received' | 'min' | 'price';

/** Champs proposés à l'écran, dans l'ordre d'affichage. */
export const IMPORT_FIELDS: readonly { key: ImportField; label: string }[] = [
  { key: 'name', label: 'Article' },
  { key: 'folder', label: 'Catégorie' },
  { key: 'serial', label: 'Numéro de série' },
  { key: 'imei', label: 'IMEI' },
  { key: 'status', label: 'Statut' },
  { key: 'assignee', label: 'Attribué à' },
  { key: 'received', label: 'Date de réception' },
  { key: 'note', label: 'Note' },
  { key: 'qty', label: 'Quantité' },
  { key: 'sku', label: 'SKU / Référence' },
  { key: 'barcode', label: 'Code-barres' },
  { key: 'min', label: 'Seuil minimum' },
  { key: 'price', label: 'Prix' },
];

/** Colonne de chaque champ (index dans la ligne d'en-tête) ; absent = « Ignorer ». */
export type ImportMapping = Partial<Record<ImportField, number>>;

/**
 * Noms de colonnes reconnus (normalisés par `normalizeHeader`), par ordre de
 * préférence : si deux colonnes conviennent (« Name » et « Model » de
 * l'export Jira Assets), la première de la liste l'emporte.
 */
const ALIASES: Record<ImportField, readonly string[]> = {
  name: ['article', 'designation', 'modele', 'model', 'nom de l article', 'nom article', 'produit', 'product', 'libelle', 'nom', 'name', 'item', 'item name', 'materiel', 'equipement', 'appareil', 'device'],
  folder: ['categorie', 'category', 'famille', 'type', 'dossier', 'folder', 'groupe', 'group', 'rayon'],
  serial: [
    'numero de serie', 'n de serie', 'no de serie', 'num de serie', 'n serie', 'no serie', 'numero serie', 'serie',
    's n', 'sn', 'serial', 'serial number', 'serial no', 'serial n', 'n s', 'ns',
  ],
  imei: ['imei', 'imei 1', 'imei1', 'numero imei', 'n imei', 'imei principal'],
  status: ['statut', 'status', 'etat', 'state', 'situation'],
  assignee: [
    'attribue a', 'attribuee a', 'utilisateur', 'assigned to', 'assignee', 'owner', 'affecte a', 'affectee a', 'attributaire',
    'proprietaire', 'detenteur', 'employe', 'beneficiaire', 'user', 'utilise par',
  ],
  qty: ['quantite', 'qte', 'qty', 'quantity', 'quantite en stock', 'stock', 'nombre', 'nb', 'stock actuel'],
  sku: ['sku', 'reference', 'ref', 'code article', 'reference article', 'part number', 'pn', 'code produit'],
  barcode: ['code barres', 'code barre', 'codebarre', 'codebarres', 'ean', 'ean13', 'ean 13', 'barcode', 'upc', 'gtin', 'code ean'],
  note: ['note', 'notes', 'commentaire', 'commentaires', 'remarque', 'remarques', 'comment', 'comments', 'observation', 'observations'],
  received: [
    'date de reception', 'recu le', 'received', 'date reception', 'reception', 'date d entree', 'date entree', 'entre le',
    'date d achat', 'purchase date', 'date', 'received date',
  ],
  min: ['seuil', 'seuil minimum', 'seuil d alerte', 'stock minimum', 'stock min', 'minimum', 'min', 'seuil mini'],
  price: ['prix', 'prix unitaire', 'price', 'unit price', 'cout', 'cout unitaire', 'prix d achat', 'valeur'],
};

/** Nom de colonne normalisé : sans accents, minuscules, ponctuation remplacée par des espaces. */
export function normalizeHeader(s: string): string {
  return foldAccents(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

type Candidate = { field: ImportField; rank: number; col: number };

function candidates(header: string, col: number): Candidate[] {
  const h = normalizeHeader(header);
  if (!h) return [];
  const out: Candidate[] = [];
  for (const field of Object.keys(ALIASES) as ImportField[]) {
    const list = ALIASES[field];
    for (let k = 0; k < list.length; k++) {
      const a = list[k];
      // Égalité exacte, ou nom plus long commençant par l'alias (« Quantité en stock », « Numéro de série (S/N) ») :
      // seulement pour un alias d'au moins 5 lettres et pas suivi d'un chiffre (« IMEI 2 » n'est pas « IMEI »).
      if (h === a) out.push({ field, rank: k, col });
      else if (a.length >= 5 && h.startsWith(`${a} `) && !/^\d/.test(h.slice(a.length + 1))) out.push({ field, rank: 100 + k, col });
    }
  }
  return out;
}

/** Correspondance automatique des colonnes d'une ligne d'en-tête. */
export function autoMap(header: readonly string[]): ImportMapping {
  const all: Candidate[] = [];
  header.forEach((h, col) => all.push(...candidates(h, col)));
  all.sort((a, b) => a.rank - b.rank || a.col - b.col);
  const mapping: ImportMapping = {};
  const used = new Set<number>();
  for (const c of all) {
    if (mapping[c.field] !== undefined || used.has(c.col)) continue;
    mapping[c.field] = c.col;
    used.add(c.col);
  }
  return mapping;
}

export type HeaderDetection = {
  /** Index (dans `sheet.rows`) de la ligne d'en-tête. */
  headerIndex: number;
  mapping: ImportMapping;
  /** `false` : aucune ligne d'en-tête reconnue (1re ligne prise par défaut, colonnes à choisir). */
  detected: boolean;
};

/**
 * Cherche la ligne d'en-tête parmi les 30 premières lignes non vides : celle
 * dont le plus de colonnes sont reconnues (au moins l'article ou le numéro de
 * série, et deux colonnes). Les lignes de titre au-dessus sont ignorées.
 */
export function detectHeader(rows: readonly SheetRow[]): HeaderDetection {
  let best: HeaderDetection = { headerIndex: 0, mapping: {}, detected: false };
  let bestScore = 0;
  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    const mapping = autoMap(rows[i].cells);
    const score = Object.keys(mapping).length;
    const usable = mapping.name !== undefined || mapping.serial !== undefined;
    if (usable && score >= 2 && score > bestScore) {
      best = { headerIndex: i, mapping, detected: true };
      bestScore = score;
    }
  }
  return best;
}

// ── Valeurs ────────────────────────────────────────────────────────────────

/**
 * Cellule nettoyée : espaces de bordure (y compris insécables) retirés,
 * formule texte `="…"` des exports déroulée, apostrophe de neutralisation
 * retirée devant `=`, `+`, `-`, `@`.
 */
export function cleanCell(raw: string | undefined): string {
  if (raw === undefined) return '';
  let s = raw.replace(/[\u00a0\u202f]/g, ' ').trim();
  const f = /^="((?:[^"]|"")*)"$/.exec(s);
  if (f) s = f[1].replace(/""/g, '"');
  if (/^'[=+\-@]/.test(s)) s = s.slice(1);
  return s;
}

/** Texte d'une cellule « nom » : espaces multiples réduits. */
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Entier positif ou nul (« 1 200 », « 12 », « 12,0 », « 1.2E+3 ») ; `null` si invalide. */
export function parseCount(s: string): number | null {
  const t = s.replace(/[\s\u00a0\u202f]/g, '');
  if (/^\+?\d+([.,]0+)?$/.test(t)) return Number(t.replace(/^\+/, '').replace(/[.,]0+$/, ''));
  if (/^\d+(\.\d+)?[eE]\+?\d+$/.test(t)) {
    const n = Number(t);
    return Number.isInteger(n) && n >= 0 && n <= Number.MAX_SAFE_INTEGER ? n : null;
  }
  return null;
}

/** Montant positif ou nul (« 12,50 », « 1 500 FCFA », « 1.234,56 », « 1,234.56 ») ; `null` si invalide. */
export function parseAmount(s: string): number | null {
  let t = s.replace(/[\s\u00a0\u202f]/g, '').replace(/(fcfa|cfa|xof|eur|€|\$|f)$/i, '');
  if (!t) return null;
  const lastDot = t.lastIndexOf('.');
  const lastComma = t.lastIndexOf(',');
  if (lastDot !== -1 && lastComma !== -1) {
    t = lastComma > lastDot ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '');
  } else if (lastComma !== -1) {
    t = t.replace(',', '.');
  }
  if (!/^\d+(\.\d+)?([eE][+-]?\d+)?$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Date de réception : `jj/mm/aaaa[ HH:MM[:SS]]` (aussi `-` ou `.`, année sur
 * 2 chiffres = 20xx), ISO `aaaa-mm-jj[THH:MM[:SS]][Z|±hh:mm]`, ou numéro de
 * série Excel (classeur). Heure locale si aucun fuseau. `null` si invalide.
 */
export function parseDate(s: string, kind: 'csv' | 'xlsx' = 'csv', date1904 = false, now: number = Date.now()): number | null {
  const t = s.trim();
  let m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})(?:[ T](\d{1,2})[:h](\d{2})(?::(\d{2}))?)?$/.exec(t);
  if (m) {
    // Année sur 2 chiffres : 20xx, sauf si cela tombe après l'année prochaine (« 99 » = 1999).
    const yy = Number(m[3]);
    const y = m[3].length === 2 ? (2000 + yy > new Date(now).getFullYear() + 1 ? 1900 + yy : 2000 + yy) : yy;
    return localDate(y, Number(m[2]), Number(m[1]), Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0));
  }
  m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.exec(t);
  if (m) {
    if (m[7]) {
      const ms = Date.parse(t.replace(' ', 'T'));
      return Number.isFinite(ms) ? ms : null;
    }
    return localDate(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0));
  }
  if (kind === 'xlsx' && /^\d+(\.\d+)?$/.test(t)) {
    const txt = excelSerialToText(Number(t), date1904);
    return txt ? parseDate(txt) : null;
  }
  return null;
}

function localDate(y: number, mo: number, d: number, h: number, mi: number, sec: number): number | null {
  if (y < 1970 || y > 2200 || mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || sec > 59) return null;
  const dt = new Date(y, mo - 1, d, h, mi, sec);
  return dt.getFullYear() === y && dt.getMonth() === mo - 1 && dt.getDate() === d ? dt.getTime() : null;
}

/** Libellés de statut reconnus (normalisés par `normalizeHeader`). */
const STATUS_WORDS: Record<UnitStatus, readonly string[]> = {
  in_stock: [
    'en stock', 'stock', 'in stock', 'instock', 'in_stock', 'disponible', 'dispo', 'available', 'en magasin', 'magasin', 'neuf', 'new',
    'libre', 'spare', 'en reserve', 'reserve', 'stocke',
  ],
  assigned: [
    'attribue', 'attribuee', 'assigned', 'affecte', 'affectee', 'en service', 'in use', 'en utilisation', 'utilise', 'utilisee',
    'deployed', 'deploye', 'deployee', 'pret', 'prete', 'loaned', 'remis', 'remise', 'actif', 'active',
  ],
  repair: [
    'en reparation', 'reparation', 'in repair', 'repair', 'sav', 'en sav', 'en panne', 'panne', 'broken', 'maintenance',
    'en maintenance', 'defectueux', 'defectueuse', 'hs', 'hors service', 'a reparer',
  ],
  retired: [
    'retire', 'retiree', 'retired', 'reforme', 'reformee', 'rebut', 'mis au rebut', 'au rebut', 'disposed', 'decommissioned',
    'archive', 'archived', 'vendu', 'vendue', 'sold', 'recycle', 'recyclee', 'detruit',
  ],
  missing: ['manquant', 'manquante', 'perdu', 'perdue', 'vole', 'volee', 'lost', 'stolen', 'missing', 'egare', 'egaree', 'introuvable'],
};

const STATUS_INDEX = new Map<string, UnitStatus>();
for (const [status, words] of Object.entries(STATUS_WORDS) as [UnitStatus, readonly string[]][]) {
  for (const w of words) STATUS_INDEX.set(normalizeHeader(w), status);
}

/** Statut d'appareil d'après un libellé français ou anglais ; `undefined` si inconnu. */
export function parseStatus(s: string): UnitStatus | undefined {
  return STATUS_INDEX.get(normalizeHeader(s));
}

// ── Lignes interprétées ────────────────────────────────────────────────────

/** Longueur maximale d'un nom d'article ou d'une catégorie importés. */
export const NAME_MAX_LENGTH = 200;

const FORMULA_NO_VALUE =
  "la cellule contient une formule sans résultat enregistré. Ouvrez le fichier dans Excel, enregistrez-le (le résultat est alors gardé), puis réessayez.";

/**
 * Numéro de série / IMEI que l'on ne peut pas importer tel quel, avec le
 * motif ; `null` s'il est utilisable.
 * - `3,56938E+14` : texte affiché par Excel pour un long nombre (CSV
 *   enregistré par Excel) ; les chiffres d'origine sont perdus.
 * - Classeur : nombre de 16 chiffres ou plus (Excel n'en garde que 15),
 *   nombre décimal, nombre au format date, formule sans résultat.
 */
export function identifierProblem(value: string, issue?: CellIssue): string | null {
  if (issue === 'formula' && !value) return `: ${FORMULA_NO_VALUE}`;
  if (!value) return null;
  if (/^\d[.,]\d+E\+\d{1,3}$/i.test(value)) {
    return "abîmé par Excel (notation scientifique) : les chiffres d'origine sont perdus. Dans le fichier d'origine, mettez la colonne au format « Texte », ressaisissez ou recollez les numéros, puis réenregistrez.";
  }
  if (issue === 'imprecise') {
    return "enregistré par Excel comme un nombre de plus de 15 chiffres : les derniers chiffres ne sont pas fiables. Mettez la colonne au format « Texte » et ressaisissez les numéros.";
  }
  if (issue === 'decimal') {
    return "enregistré par Excel comme un nombre décimal. Mettez la colonne au format « Texte » et ressaisissez les numéros.";
  }
  if (issue === 'date') {
    return "enregistré par Excel comme une date : le numéro d'origine n'est pas gardé. Mettez la colonne au format « Texte » et ressaisissez les numéros.";
  }
  return null;
}

/**
 * Lignes de données (sous la ligne d'en-tête) interprétées selon `mapping`.
 * Les lignes dont toutes les colonnes choisies sont vides sont ignorées.
 *
 * - Une ligne sans numéro de série alors qu'une colonne « Numéro de série »
 *   est choisie, et sans quantité, est écartée (« Numéro de série manquant »).
 * - Statut vide : « Attribué » si un attributaire est indiqué, sinon
 *   « En stock » ; statut inconnu : « En stock » avec un avertissement.
 * - Quantité illisible : ligne écartée ; seuil, prix ou date illisibles :
 *   valeur ignorée avec un avertissement. Note trop longue : tronquée.
 */
export function buildRecords(
  rows: readonly SheetRow[],
  headerIndex: number,
  mapping: ImportMapping,
  kind: 'csv' | 'xlsx' = 'csv',
  date1904 = false
): ImportRecord[] {
  const out: ImportRecord[] = [];
  const now = Date.now();
  const fields = (Object.keys(mapping) as ImportField[]).filter((f) => mapping[f] !== undefined && mapping[f]! >= 0);
  for (let i = headerIndex + 1; i < rows.length; i++) {
    const row = rows[i];
    const get = (f: ImportField): string => {
      const c = mapping[f];
      return c === undefined || c < 0 ? '' : cleanCell(row.cells[c]);
    };
    const issue = (f: ImportField): CellIssue | undefined => {
      const c = mapping[f];
      return c === undefined || c < 0 ? undefined : row.issues?.[c];
    };
    if (fields.every((f) => get(f) === '')) continue;
    const rec: ImportRecord = { row: row.n };
    const warnings: string[] = [];
    const fail = (message: string) => {
      if (rec.error === undefined) rec.error = message;
    };
    const name = oneLine(get('name'));
    if (name) rec.name = name;
    if (name.length > NAME_MAX_LENGTH) fail(`Nom d'article trop long (${name.length} caractères, ${NAME_MAX_LENGTH} au maximum).`);
    const folder = oneLine(get('folder'));
    if (folder) rec.folder = folder;
    if (folder.length > NAME_MAX_LENGTH) fail(`Catégorie trop longue (${folder.length} caractères, ${NAME_MAX_LENGTH} au maximum).`);
    const serial = get('serial');
    if (serial) rec.serial = serial;
    const imei = get('imei');
    if (imei) rec.imei = imei;
    // Identifiants abîmés par Excel : refusés (sinon un faux numéro serait
    // enregistré et les vrais appareils écartés comme doublons).
    for (const [f, label, value] of [['serial', 'Numéro de série', serial], ['imei', 'IMEI', imei]] as const) {
      const why = identifierProblem(value, issue(f));
      if (why) fail(`${label} ${value ? `« ${value} » ` : ''}${why}`);
    }
    const sku = get('sku');
    if (sku) rec.sku = sku;
    const barcode = get('barcode');
    if (barcode) rec.barcode = barcode;
    const assignee = oneLine(get('assignee'));
    if (assignee) rec.assignee = assignee;
    let note = get('note');
    if (note.length > NOTE_MAX_LENGTH) {
      note = note.slice(0, NOTE_MAX_LENGTH);
      warnings.push(`Note tronquée à ${NOTE_MAX_LENGTH} caractères.`);
    }
    if (note) rec.note = note;

    const qtyText = get('qty');
    if (!qtyText && issue('qty') === 'formula') fail(`Quantité : ${FORMULA_NO_VALUE}`);
    if (qtyText) {
      const q = parseCount(qtyText);
      if (q === null) {
        if (!serial) rec.error = `Quantité « ${qtyText} » invalide : indiquez un nombre entier positif ou nul.`;
      } else {
        rec.qty = q;
      }
    }
    if (!serial && mapping.serial !== undefined && mapping.serial >= 0 && !qtyText && rec.error === undefined) {
      rec.error = name ? 'Numéro de série manquant.' : "Nom de l'article et numéro de série manquants.";
    }

    if (serial) {
      const statusText = get('status');
      if (!statusText) {
        rec.status = assignee ? 'assigned' : 'in_stock';
      } else {
        const st = parseStatus(statusText);
        if (st) {
          rec.status = st;
        } else {
          rec.status = assignee ? 'assigned' : 'in_stock';
          warnings.push(`Statut « ${statusText} » inconnu : « ${assignee ? 'Attribué' : 'En stock'} » utilisé.`);
        }
      }
      if (rec.status !== 'assigned' && assignee) warnings.push(`Attributaire « ${assignee} » ignoré (statut autre que « Attribué »).`);
      const receivedText = get('received');
      if (receivedText) {
        const ts = parseDate(receivedText, kind, date1904, now);
        if (ts === null) warnings.push(`Date de réception « ${receivedText} » non reconnue : date du jour utilisée.`);
        else if (ts > now + 86_400_000) warnings.push(`Date de réception « ${receivedText} » dans le futur : date du jour utilisée.`);
        else rec.receivedAt = ts;
      }
    }
    const minText = get('min');
    if (minText) {
      const m = parseCount(minText);
      if (m === null) warnings.push(`Seuil « ${minText} » invalide : 0 utilisé.`);
      else rec.min = m;
    }
    const priceText = get('price');
    if (priceText) {
      const p = parseAmount(priceText);
      if (p === null) warnings.push(`Prix « ${priceText} » invalide : 0 utilisé.`);
      else rec.price = p;
    }
    if (warnings.length > 0) rec.warnings = warnings;
    out.push(rec);
  }
  return out;
}
