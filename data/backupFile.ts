/**
 * Partage d'une sauvegarde et choix du fichier à restaurer (`data/backup.ts`).
 *
 * `expo-file-system`, `expo-sharing` et `expo-constants` sont chargés
 * paresseusement, comme dans `data/exportCount.ts` : un module absent donne un
 * message clair au lieu de faire planter l'écran.
 */
import type * as FileSystemModule from 'expo-file-system';
import type * as SharingModule from 'expo-sharing';
import { BACKUP_MAX_BYTES, buildBackup, readBackupBytes, type ReadBackupResult } from './backup';
import { pickDocument } from './importPick';

export type ShareBackupResult =
  | { ok: true; filename: string; counts: { items: number; units: number; movements: number } }
  | { ok: false; error: string };

function appVersion(): string | undefined {
  try {
    const Constants = (require('expo-constants') as typeof import('expo-constants')).default;
    const v = Constants.expoConfig?.version;
    return typeof v === 'string' ? v : undefined;
  } catch {
    return undefined;
  }
}

/** Sauvegardes précédentes laissées dans le cache : supprimées (best effort). */
function removeOldBackups(fs: typeof FileSystemModule): void {
  try {
    const dir = new fs.Directory(fs.Paths.cache);
    for (const entry of dir.list()) {
      if (entry instanceof fs.File && /^stockly-sauvegarde-.*\.json$/.test(entry.name)) {
        try {
          entry.delete();
        } catch {
          // ignorée
        }
      }
    }
  } catch {
    // ignorée
  }
}

/**
 * Crée le fichier de sauvegarde dans le cache et ouvre la feuille de partage
 * (Drive, e-mail, WhatsApp…). Ne lève jamais.
 */
export async function shareBackup(): Promise<ShareBackupResult> {
  const built = buildBackup({ appVersion: appVersion() });
  if (!built.ok) return built;
  let fs: typeof FileSystemModule;
  let sharing: typeof SharingModule;
  try {
    fs = require('expo-file-system') as typeof FileSystemModule;
    sharing = require('expo-sharing') as typeof SharingModule;
  } catch (e) {
    console.warn('[backup] Partage indisponible.', e);
    return { ok: false, error: "Le partage de fichiers n'est pas disponible dans cette version de l'application. Installez la dernière version." };
  }
  try {
    if (!(await sharing.isAvailableAsync())) {
      return { ok: false, error: "Le partage de fichiers n'est pas disponible sur ce téléphone." };
    }
    removeOldBackups(fs);
    const file = new fs.File(fs.Paths.cache, built.filename);
    file.create({ overwrite: true });
    await file.write(built.json);
    await sharing.shareAsync(file.uri, { mimeType: 'application/json', UTI: 'public.json', dialogTitle: 'Sauvegarde Stockly' });
    return { ok: true, filename: built.filename, counts: built.counts };
  } catch (e) {
    console.warn('[backup] Sauvegarde impossible.', e);
    return { ok: false, error: "La sauvegarde n'a pas pu être créée ou partagée. Vérifiez l'espace libre du téléphone et réessayez." };
  }
}

/**
 * Choisit un fichier de sauvegarde et le valide (rien n'est modifié).
 * Tous les types sont proposés : selon l'application d'origine (WhatsApp,
 * Drive…), un `.json` peut être signalé comme `application/octet-stream` ou
 * `text/plain`. Le contenu est de toute façon vérifié. Ne lève jamais.
 */
export async function pickBackup(): Promise<ReadBackupResult | { ok: false; cancelled: true }> {
  const picked = await pickDocument({ types: ['*/*'], maxBytes: BACKUP_MAX_BYTES });
  if (!picked.ok) return picked.cancelled ? { ok: false, cancelled: true } : { ok: false, error: picked.error };
  return readBackupBytes(picked.file.bytes);
}
