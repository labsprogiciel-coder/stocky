/**
 * Sauvegarde et restauration des données de ce téléphone (gratuit).
 *
 * Module pur (aucune dépendance React Native, testable sous Node) : il produit
 * et lit le fichier ; le partage et le choix du fichier sont dans
 * `data/backupFile.ts`.
 *
 * Fichier : un JSON UTF-8 `stockly-sauvegarde-<aaaammjj>-<hhmm>.json` :
 *
 *   { "format": "stockly-backup", "version": 1, "schemaVersion": 1,
 *     "createdAt": "2026-11-16T14:05:00.000Z", "appVersion": "1.0.0",
 *     "data": { "items": [...], "units": [...], "movements": [...],
 *               "countSessions": {...}, "prefs": {...} } }
 *
 * - Ni licence Stockly Pro, ni code du téléphone : une licence est propre à
 *   un téléphone, et restaurer sur l'autre téléphone de la société ne doit pas
 *   la copier.
 * - Les fichiers photo ne sont PAS inclus (version 1) ; les articles gardent le
 *   nom de leur photo, conservé à la restauration seulement si le fichier
 *   existe sur ce téléphone (voir `prepareRestore` dans `data/store.ts`).
 * - Restauration : en-tête vérifié strictement (format, version, date), puis
 *   contenu validé avec les règles du chargement (`prepareRestore`) : entrées
 *   invalides écartées et signalées. La restauration remplace tout (aucune
 *   fusion), en un seul enregistrement sous journal (`applyRestore`).
 */
import { decodeUtf8 } from './importExcel';
import { SCHEMA_VERSION } from './storage';
import { getBackupData, prepareRestore, type RestorePlan } from './store';

export const BACKUP_FORMAT = 'stockly-backup';
export const BACKUP_VERSION = 1;
/** Taille maximale d'un fichier de sauvegarde lu (les plus gros inventaires font quelques Mo). */
export const BACKUP_MAX_BYTES = 50 * 1024 * 1024;

export type BackupFile = {
  format: typeof BACKUP_FORMAT;
  version: number;
  schemaVersion: number;
  /** Date ISO 8601 (UTC). */
  createdAt: string;
  appVersion?: string;
  data: unknown;
};

const pad = (n: number) => String(n).padStart(2, '0');

/** `stockly-sauvegarde-aaaammjj-hhmm.json` (heure locale). */
export function backupFilename(d: Date = new Date()): string {
  return `stockly-sauvegarde-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.json`;
}

export type BuiltBackup = {
  ok: true;
  json: string;
  filename: string;
  counts: { items: number; units: number; movements: number };
};

/** Crée le contenu du fichier de sauvegarde. Ne lève pas. */
export function buildBackup(opts: { now?: Date; appVersion?: string } = {}): BuiltBackup | { ok: false; error: string } {
  const got = getBackupData();
  if (!got.ok) return got;
  const now = opts.now ?? new Date();
  const file: BackupFile = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    schemaVersion: SCHEMA_VERSION,
    createdAt: now.toISOString(),
    ...(opts.appVersion ? { appVersion: opts.appVersion } : {}),
    data: got.data,
  };
  let json: string;
  try {
    json = JSON.stringify(file);
  } catch (e) {
    console.warn('[backup] Sérialisation impossible.', e);
    return { ok: false, error: "La sauvegarde n'a pas pu être créée. Réessayez." };
  }
  return {
    ok: true,
    json,
    filename: backupFilename(now),
    counts: { items: got.data.items.length, units: got.data.units.length, movements: got.data.movements.length },
  };
}

// ── Lecture ────────────────────────────────────────────────────────────────

export type BackupPreview = {
  /** Date de création de la sauvegarde (epoch ms). */
  createdAt: number;
  appVersion?: string;
  plan: RestorePlan;
};

export type ReadBackupResult = { ok: true; preview: BackupPreview } | { ok: false; error: string };

const NOT_A_BACKUP =
  "Ce fichier n'est pas une sauvegarde Stockly. Choisissez un fichier « stockly-sauvegarde-….json » créé par Profil › Données › Sauvegarder.";
const DAMAGED =
  "Sauvegarde illisible : le fichier est abîmé ou incomplet (par exemple coupé pendant l'envoi). Refaites la sauvegarde sur le téléphone d'origine.";
const DAMAGED_HEADER = 'Sauvegarde abîmée : son en-tête est invalide. Refaites la sauvegarde sur le téléphone d\'origine.';
const NEWER =
  "Cette sauvegarde a été créée par une version plus récente de Stockly. Mettez l'application à jour sur ce téléphone, puis réessayez.";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isPositiveInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1;
/** Date ISO 8601 complète, comme l'écrit `Date.prototype.toISOString`. */
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

/** Lit et valide les octets d'un fichier de sauvegarde (rien n'est écrit). Ne lève pas. */
export function readBackupBytes(bytes: Uint8Array): ReadBackupResult {
  if (bytes.length === 0) return { ok: false, error: 'Le fichier est vide.' };
  if (bytes.length > BACKUP_MAX_BYTES) return { ok: false, error: 'Fichier trop volumineux pour une sauvegarde Stockly (50 Mo au maximum).' };
  // Classeur Excel (.xlsx = ZIP, .xls = OLE) : erreur fréquente, message dédié.
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    return { ok: false, error: "Ce fichier est un classeur Excel, pas une sauvegarde Stockly. Pour importer un tableau, utilisez « Importer depuis Excel »." };
  }
  if (bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) {
    return { ok: false, error: "Ce fichier est un classeur Excel, pas une sauvegarde Stockly." };
  }
  const start = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  const text = decodeUtf8(bytes, start);
  if (text === null) return { ok: false, error: NOT_A_BACKUP };
  return readBackupText(text);
}

/** Comme `readBackupBytes`, pour un texte déjà décodé. */
export function readBackupText(text: string): ReadBackupResult {
  const t = text.replace(/^﻿/, '').trim();
  if (!t.startsWith('{')) return { ok: false, error: NOT_A_BACKUP };
  let v: unknown;
  try {
    v = JSON.parse(t);
  } catch {
    return { ok: false, error: DAMAGED };
  }
  return readBackupObject(v);
}

/** Valide un fichier de sauvegarde déjà analysé (`JSON.parse`). */
export function readBackupObject(v: unknown): ReadBackupResult {
  if (!isRecord(v) || v.format !== BACKUP_FORMAT) return { ok: false, error: NOT_A_BACKUP };
  if (!isPositiveInt(v.version) || !isPositiveInt(v.schemaVersion)) return { ok: false, error: DAMAGED_HEADER };
  if (v.version > BACKUP_VERSION || v.schemaVersion > SCHEMA_VERSION) return { ok: false, error: NEWER };
  if (v.schemaVersion !== SCHEMA_VERSION) return { ok: false, error: DAMAGED_HEADER };
  if (typeof v.createdAt !== 'string' || !ISO_RE.test(v.createdAt)) return { ok: false, error: DAMAGED_HEADER };
  const createdAt = Date.parse(v.createdAt);
  if (!Number.isFinite(createdAt)) return { ok: false, error: DAMAGED_HEADER };
  if (v.appVersion !== undefined && (typeof v.appVersion !== 'string' || v.appVersion.length > 40)) return { ok: false, error: DAMAGED_HEADER };
  if (!isRecord(v.data)) return { ok: false, error: DAMAGED };
  const prepared = prepareRestore(v.data);
  if (!prepared.ok) return prepared;
  return {
    ok: true,
    preview: { createdAt, ...(v.appVersion ? { appVersion: v.appVersion } : {}), plan: prepared.plan },
  };
}
