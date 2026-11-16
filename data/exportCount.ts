/**
 * Export d'un comptage cyclique au format CSV : écriture du fichier dans le
 * cache puis ouverture de la feuille de partage.
 *
 * `expo-file-system` et `expo-sharing` sont des modules natifs : comme MMKV,
 * ils sont chargés paresseusement (un module absent lèverait dès son
 * évaluation). S'ils sont indisponibles, le CSV est partagé en texte via
 * `Share` de React Native.
 */
import { Alert, Share } from 'react-native';
import type * as FileSystemModule from 'expo-file-system';
import type * as SharingModule from 'expo-sharing';
import { assetsCsvFilename, buildAssetsCsv } from './assetsCsv';
import { buildCountCsv, countCsvFilename } from './csv';
import { getCountDiscrepancies, getCountItems, getCountSession, getCycleCount, getItems, getUnits, hasCountSession } from './store';

const MIME = 'text/csv';
const UTI = 'public.comma-separated-values-text';

function loadFileSystem(): typeof FileSystemModule | null {
  try {
    return require('expo-file-system') as typeof FileSystemModule;
  } catch (e) {
    console.warn('[export] expo-file-system indisponible.', e);
    return null;
  }
}

function loadSharing(): typeof SharingModule | null {
  try {
    return require('expo-sharing') as typeof SharingModule;
  } catch (e) {
    console.warn('[export] expo-sharing indisponible.', e);
    return null;
  }
}

/** Écrit le CSV dans le cache. Renvoie l'URI du fichier, ou `null` en cas d'échec. */
async function writeCacheFile(name: string, content: string): Promise<string | null> {
  const fs = loadFileSystem();
  if (!fs) return null;
  try {
    const file = new fs.File(fs.Paths.cache, name);
    file.create({ overwrite: true });
    await file.write(content);
    return file.uri;
  } catch (e) {
    console.warn('[export] Écriture du fichier CSV impossible.', e);
    return null;
  }
}

/** Partage via la feuille de partage d'expo-sharing. Renvoie `false` si indisponible. */
async function shareFile(uri: string, dialogTitle: string): Promise<boolean> {
  const sharing = loadSharing();
  if (!sharing) return false;
  let available = false;
  try {
    available = await sharing.isAvailableAsync();
  } catch {
    available = false;
  }
  if (!available) return false;
  await sharing.shareAsync(uri, { mimeType: MIME, UTI, dialogTitle });
  return true;
}

/**
 * Exporte le comptage `id` en CSV et ouvre la feuille de partage.
 * Ne lève jamais : une erreur est signalée par une alerte.
 */
export async function exportCountCsv(id: string): Promise<void> {
  try {
    const info = getCycleCount();
    const session = getCountSession(id);
    if (id !== info.id || !session) {
      Alert.alert('Export impossible', 'Comptage introuvable.');
      return;
    }
    const items = getCountItems(id);
    if (items.length === 0) {
      Alert.alert('Export impossible', "Aucun article à exporter : l'inventaire est vide.");
      return;
    }

    const now = new Date();
    const csv = buildCountCsv({
      count: { id: info.id, name: info.name, folder: info.folder, blind: info.blind },
      // Session non enregistrée : pas de date de démarrage fictive.
      session: hasCountSession(id) ? session : { entries: session.entries },
      items,
      exportedAt: now.getTime(),
      serialDetails: getCountDiscrepancies(id),
    });
    const title = `Export CSV – ${info.name}`;

    const uri = await writeCacheFile(countCsvFilename(id, now), csv);
    if (uri && (await shareFile(uri, title))) return;

    // Repli : partage du contenu en texte (sans BOM).
    await Share.share({ message: csv.replace(/^﻿/, ''), title });
  } catch (e) {
    console.warn('[export] Export CSV impossible.', e);
    Alert.alert('Export impossible', "Le fichier CSV n'a pas pu être créé ou partagé. Réessayez.");
  }
}

/**
 * Exporte les appareils (numéros de série) au format CSV d'import de Jira
 * Service Management Assets et ouvre la feuille de partage : tous les
 * appareils, ou seulement ceux de l'article `itemId`.
 * Ne lève jamais : une erreur est signalée par une alerte.
 */
export async function exportAssetsCsv(itemId?: string): Promise<void> {
  try {
    const units = getUnits(itemId);
    if (units.length === 0) {
      Alert.alert(
        'Export impossible',
        itemId === undefined
          ? "Aucun appareil à exporter : ajoutez des numéros de série à un article suivi par numéro de série."
          : "Aucun appareil à exporter pour cet article : ajoutez d'abord ses numéros de série."
      );
      return;
    }
    const now = new Date();
    const items = getItems();
    const csv = buildAssetsCsv(units, items);
    const itemName = itemId === undefined ? undefined : items.find((i) => i.id === itemId)?.name;
    const title = itemName ? `Export CSV – ${itemName} (Jira Assets)` : 'Export CSV – Appareils (Jira Assets)';
    const uri = await writeCacheFile(assetsCsvFilename(now), csv);
    if (uri && (await shareFile(uri, title))) return;
    await Share.share({ message: csv, title });
  } catch (e) {
    console.warn('[export] Export CSV des appareils impossible.', e);
    Alert.alert('Export impossible', "Le fichier CSV n'a pas pu être créé ou partagé. Réessayez.");
  }
}
