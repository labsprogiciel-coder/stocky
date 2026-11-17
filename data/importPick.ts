/**
 * Choix et lecture du fichier à importer (Excel ou CSV).
 *
 * `expo-document-picker` et `expo-file-system` sont des modules natifs :
 * chargés paresseusement (comme dans `data/exportCount.ts`), pour qu'un module
 * absent (build sans `expo-document-picker`) donne un message clair au lieu
 * de faire planter l'écran.
 */
import type * as DocumentPickerModule from 'expo-document-picker';
import type * as FileSystemModule from 'expo-file-system';
import { IMPORT_MAX_BYTES } from './importExcel';

export type PickedFile = { name: string; bytes: Uint8Array };
export type PickResult = { ok: true; file: PickedFile } | { ok: false; cancelled: true } | { ok: false; cancelled?: false; error: string };

/**
 * Types proposés dans le sélecteur. Android signale souvent un CSV comme
 * `application/vnd.ms-excel` ou `application/octet-stream` (pièce jointe
 * WhatsApp…) : le format réel est de toute façon déterminé par le contenu.
 */
const TYPES = [
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel.sheet.macroEnabled.12',
  'application/vnd.ms-excel',
  'text/csv',
  'text/comma-separated-values',
  'application/csv',
  'text/tab-separated-values',
  'text/plain',
  'application/octet-stream',
];

/** Ouvre le sélecteur de fichiers puis lit le fichier choisi (Excel ou CSV). Ne lève jamais. */
export function pickImportFile(): Promise<PickResult> {
  return pickDocument({ types: TYPES, maxBytes: IMPORT_MAX_BYTES });
}

/**
 * Ouvre le sélecteur de fichiers (`types` : types MIME proposés) puis lit le
 * fichier choisi, refusé au-delà de `maxBytes`. La copie faite dans le cache
 * est supprimée une fois lue. Ne lève jamais.
 */
export async function pickDocument(opts: { types: string[]; maxBytes: number }): Promise<PickResult> {
  let picker: typeof DocumentPickerModule;
  let fs: typeof FileSystemModule;
  try {
    picker = require('expo-document-picker') as typeof DocumentPickerModule;
    fs = require('expo-file-system') as typeof FileSystemModule;
  } catch (e) {
    console.warn('[import] Sélecteur de fichiers indisponible.', e);
    return { ok: false, error: "Le choix de fichiers n'est pas disponible dans cette version de l'application. Installez la dernière version." };
  }
  const maxMb = Math.round(opts.maxBytes / 1024 / 1024);
  try {
    const res = await picker.getDocumentAsync({ type: opts.types, copyToCacheDirectory: true, multiple: false });
    if (res.canceled) return { ok: false, cancelled: true };
    const asset = res.assets[0];
    if (!asset) return { ok: false, cancelled: true };
    const file = new fs.File(asset.uri);
    const discard = () => {
      // `copyToCacheDirectory` : l'URI est une copie dans le cache de l'application,
      // supprimée une fois lue (best effort ; le cache est de toute façon purgeable).
      try {
        file.delete();
      } catch {
        // ignorée
      }
    };
    const tooBig = (size: number): PickResult => ({
      ok: false,
      error: `Fichier trop volumineux (${Math.round(size / 1024 / 1024)} Mo, ${maxMb} Mo au maximum).`,
    });
    // Taille signalée par le sélecteur, sinon celle de la copie (0 si illisible) ;
    // vérifiée de toute façon sur les octets lus.
    let size = asset.size;
    if (size === undefined) {
      try {
        size = file.size;
      } catch {
        size = undefined;
      }
    }
    if (typeof size === 'number' && size > opts.maxBytes) {
      discard();
      return tooBig(size);
    }
    const bytes = await file.bytes();
    discard();
    if (bytes.length > opts.maxBytes) return tooBig(bytes.length);
    return { ok: true, file: { name: asset.name ?? 'fichier', bytes } };
  } catch (e) {
    console.warn('[import] Lecture du fichier impossible.', e);
    return { ok: false, error: "Le fichier n'a pas pu être lu. Réessayez ou enregistrez-le d'abord sur le téléphone." };
  }
}
