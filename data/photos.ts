/**
 * Photos des articles, stockées localement dans `Documents/photos/`.
 *
 * Un article ne mémorise que le NOM du fichier (`Item.photo`), jamais un URI :
 * sur iOS, le chemin du conteneur de l'application change entre deux mises à
 * jour. L'URI est recalculé à l'affichage avec `photoUri()`.
 *
 * `expo-image-picker` et `expo-file-system` sont des modules natifs : comme
 * MMKV et l'export CSV, ils sont chargés paresseusement (un module absent
 * lèverait dès son évaluation). Ils sont inclus dans Expo Go ; s'ils manquent
 * (ancien build sans ces modules), l'ajout de photo est refusé avec l'alerte
 * « Photo indisponible » et les photos ne s'affichent pas (vignette par défaut).
 *
 * Les fichiers qu'aucun article ne référence sont supprimés au démarrage
 * (`sweepOrphanPhotos`, appelé par `app/_layout.tsx`).
 *
 * Au chargement, ce module enregistre ses fonctions de suppression auprès de
 * `data/store.ts` (`setPhotoFileHooks`) : le store supprime ainsi le fichier
 * d'un article supprimé ou dont la photo est remplacée, et toutes les photos
 * lors d'une réinitialisation, sans importer lui-même de module natif ; il
 * vérifie aussi qu'une photo existe (`hasPhoto`) avant de garder sa référence
 * lors de la restauration d'une sauvegarde.
 * `app/_layout.tsx` importe ce module pour garantir cet enregistrement.
 */
import { Alert, Linking } from 'react-native';
import type * as FileSystemModule from 'expo-file-system';
import type * as ImagePickerModule from 'expo-image-picker';
import { getItems, isMemoryTrusted, isPhotoName, setPhotoFileHooks } from './store';

export type PhotoSource = 'camera' | 'library';

const PHOTOS_DIR = 'photos';
const EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'heic', 'heif', 'webp']);

let _fs: typeof FileSystemModule | null | undefined;
/** Noms créés par `pickPhoto` depuis le lancement (épargnés par le nettoyage). */
const _pickedThisLaunch = new Set<string>();
let _swept = false;
let _picker: typeof ImagePickerModule | null | undefined;

function loadFileSystem(): typeof FileSystemModule | null {
  if (_fs !== undefined) return _fs;
  try {
    _fs = require('expo-file-system') as typeof FileSystemModule;
  } catch (e) {
    console.warn('[photos] expo-file-system indisponible.', e);
    _fs = null;
  }
  return _fs;
}

function loadImagePicker(): typeof ImagePickerModule | null {
  if (_picker !== undefined) return _picker;
  try {
    _picker = require('expo-image-picker') as typeof ImagePickerModule;
  } catch (e) {
    console.warn('[photos] expo-image-picker indisponible.', e);
    _picker = null;
  }
  return _picker;
}

/** Dossier des photos (créé si absent). Lève si le système de fichiers échoue. */
function ensurePhotosDir(fs: typeof FileSystemModule): FileSystemModule.Directory {
  const dir = new fs.Directory(fs.Paths.document, PHOTOS_DIR);
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  return dir;
}

function photoFile(fs: typeof FileSystemModule, name: string): FileSystemModule.File {
  return new fs.File(fs.Paths.document, PHOTOS_DIR, name);
}

/** URI affichable d'une photo, ou `null` si le nom est invalide ou le fichier absent. */
export function photoUri(name: string | null | undefined): string | null {
  if (!isPhotoName(name)) return null;
  const fs = loadFileSystem();
  if (!fs) return null;
  try {
    const file = photoFile(fs, name);
    return file.exists ? file.uri : null;
  } catch {
    return null;
  }
}

/** Supprime une photo (best effort, ne lève jamais). */
export function deletePhoto(name: string | null | undefined): void {
  if (!isPhotoName(name)) return;
  const fs = loadFileSystem();
  if (!fs) return;
  try {
    const file = photoFile(fs, name);
    if (file.exists) file.delete();
  } catch (e) {
    console.warn('[photos] Suppression de la photo impossible.', e);
  }
}

/** Supprime toutes les photos (best effort, ne lève jamais). */
export function deleteAllPhotos(): void {
  const fs = loadFileSystem();
  if (!fs) return;
  try {
    const dir = new fs.Directory(fs.Paths.document, PHOTOS_DIR);
    if (dir.exists) dir.delete();
  } catch (e) {
    console.warn('[photos] Suppression des photos impossible.', e);
  }
}

/**
 * Supprime les fichiers du dossier des photos qu'aucun article ne référence
 * (best effort, ne lève jamais, une seule fois par lancement). Ces orphelins
 * apparaissent quand les articles ne sont pas conservés (stockage temporaire
 * d'Expo Go, données stockées illisibles) ou quand l'app est tuée entre le
 * choix d'une photo et l'enregistrement du formulaire. Les photos choisies
 * depuis le lancement (formulaire en cours) sont épargnées. Rien n'est
 * supprimé tant que la mémoire du store n'est pas fiable (`isMemoryTrusted`).
 * Appelé au démarrage par `app/_layout.tsx`.
 */
export function sweepOrphanPhotos(): void {
  if (_swept) return;
  // Mémoire non fiable (lecture du stockage refusée au chargement) : la liste
  // des articles peut être vide alors que le stockage en contient. Aucun
  // fichier n'est supprimé ; le nettoyage sera retenté au prochain appel.
  if (!isMemoryTrusted()) return;
  _swept = true;
  const fs = loadFileSystem();
  if (!fs) return;
  try {
    const dir = new fs.Directory(fs.Paths.document, PHOTOS_DIR);
    if (!dir.exists) return;
    const used = new Set<string>();
    for (const i of getItems()) if (i.photo) used.add(i.photo);
    for (const entry of dir.list()) {
      if (!(entry instanceof fs.File)) continue;
      if (used.has(entry.name) || _pickedThisLaunch.has(entry.name)) continue;
      try {
        entry.delete();
      } catch (e) {
        console.warn('[photos] Suppression d\'une photo orpheline impossible.', e);
      }
    }
  } catch (e) {
    console.warn('[photos] Nettoyage des photos impossible.', e);
  }
}

function extensionOf(asset: ImagePickerModule.ImagePickerAsset): string {
  const fromName = /\.([A-Za-z0-9]+)$/.exec(asset.fileName ?? '')?.[1];
  const fromUri = /\.([A-Za-z0-9]+)(?:\?.*)?$/.exec(asset.uri)?.[1];
  const fromMime = asset.mimeType?.startsWith('image/') ? asset.mimeType.slice(6) : undefined;
  for (const c of [fromUri, fromName, fromMime]) {
    const ext = c?.toLowerCase();
    if (ext && EXTENSIONS.has(ext)) return ext === 'jpeg' ? 'jpg' : ext;
  }
  return 'jpg';
}

/** Nom unique, ex. `item-12-m3k9x1a-4f2c.jpg` (`item-new-…` à la création). */
function uniqueName(itemId: string | undefined, ext: string): string {
  const id = itemId?.replace(/[^A-Za-z0-9-]/g, '').slice(0, 40) || 'new';
  const rand = Math.random().toString(36).slice(2, 6);
  return `item-${id}-${Date.now().toString(36)}-${rand}.${ext}`;
}

function alertDenied(source: PhotoSource) {
  const what = source === 'camera' ? 'à la caméra' : 'à vos photos';
  Alert.alert(
    'Autorisation requise',
    `Stockly n'a pas accès ${what}. Autorisez l'accès dans les réglages de l'appareil pour ajouter une photo à l'article.`,
    [
      { text: 'Annuler', style: 'cancel' },
      {
        text: 'Ouvrir les réglages',
        onPress: () => {
          Linking.openSettings().catch(() => undefined);
        },
      },
    ]
  );
}

/**
 * Prend une photo (`camera`) ou en choisit une dans la galerie (`library`),
 * recadrée au carré, puis la copie dans le dossier des photos.
 * Renvoie le NOM du fichier créé, ou `null` si l'utilisateur annule, refuse
 * l'autorisation ou en cas d'erreur (signalée par une alerte). Ne lève jamais.
 */
export async function pickPhoto(source: PhotoSource, itemId?: string): Promise<string | null> {
  const picker = loadImagePicker();
  const fs = loadFileSystem();
  if (!picker || !fs) {
    Alert.alert(
      'Photo indisponible',
      "L'ajout de photos n'est pas disponible dans cette version de l'application. Installez un build de développement ou la dernière version de l'application."
    );
    return null;
  }

  try {
    const permission = source === 'camera'
      ? await picker.requestCameraPermissionsAsync()
      : await picker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      alertDenied(source);
      return null;
    }

    const options: ImagePickerModule.ImagePickerOptions = {
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.6,
    };
    const result = source === 'camera'
      ? await picker.launchCameraAsync(options)
      : await picker.launchImageLibraryAsync(options);
    if (result.canceled) return null;
    const asset = result.assets[0];
    if (!asset) return null;

    const dir = ensurePhotosDir(fs);
    const name = uniqueName(itemId, extensionOf(asset));
    _pickedThisLaunch.add(name);
    const dest = new fs.File(dir, name);
    await new fs.File(asset.uri).copy(dest);
    if (!dest.exists) throw new Error('Copie de la photo introuvable.');
    return name;
  } catch (e) {
    console.warn('[photos] Ajout de la photo impossible.', e);
    Alert.alert('Photo non enregistrée', "La photo n'a pas pu être ajoutée. Réessayez.");
    return null;
  }
}

setPhotoFileHooks({ deletePhoto, deleteAllPhotos, hasPhoto: (name) => photoUri(name) !== null });
