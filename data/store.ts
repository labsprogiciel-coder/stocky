/**
 * État de l'application, entièrement local (aucun serveur).
 *
 * L'API reste synchrone : l'état est chargé une seule fois depuis le stockage
 * (MMKV) au premier accès, puis chaque mutation est écrite immédiatement.
 * Au premier lancement, ou si les articles stockés sont absents, corrompus ou
 * tous invalides, l'application démarre avec un inventaire vide (préférences
 * conservées). Les données d'exemple de `data/mock.ts` ne sont chargées qu'à
 * la demande, via `loadSampleData()`.
 *
 * Photos des articles : `Item.photo` ne contient que le NOM du fichier
 * (jamais un chemin absolu, qui change sur iOS entre deux mises à jour). Les
 * fichiers sont gérés par `data/photos.ts`, qui enregistre ses fonctions de
 * suppression via `setPhotoFileHooks()`. Ce module n'importe ainsi aucun
 * module natif de fichiers et reste exécutable hors de React Native (tests) :
 * sans hooks enregistrés, la suppression des fichiers est simplement ignorée.
 *
 * Suivi par numéro de série (`Item.serialized`, choix propre à chaque
 * article) : un article suivi est composé d'unités (`Unit`, une par appareil,
 * clé = numéro de série, IMEI facultatif), stockées sous `v1.units` (ajout
 * rétrocompatible : clé absente = aucune unité, pas de changement de schéma).
 * Le stock d'un tel article est DÉRIVÉ : `item.qty` = nombre de ses unités
 * « En stock », recalculé après chaque mutation d'unité. `adjustStock` et
 * `commitMovement` le refusent ; on passe par `addUnit`/`updateUnit`/
 * `deleteUnit`, qui tracent chaque entrée/sortie de stock par un mouvement
 * portant `unitId`/`serial`. Choix documenté : supprimer une unité « En stock »
 * enregistre une Sortie de 1 (le stock diminue, le changement reste tracé) ;
 * supprimer une unité d'un autre statut n'enregistre rien.
 *
 * Un numéro de série ou un IMEI ne peut pas être égal au code-barres ou au SKU
 * d'un article (et inversement), pour qu'un scan reste non ambigu.
 */
import { items as sampleItems, recent as sampleRecent, units as sampleUnits } from './mock';
import { KEYS, clearAll, isPersistent, readRaw, removeKey, writeJSON, writeRaw } from './storage';
import {
  ASSIGNEE_MAX_LENGTH,
  NOTE_MAX_LENGTH,
  SERIAL_MAX_LENGTH,
  imeiDigits,
  isUnitStatus,
  isValidImei,
  normalizeImei,
  normalizeSerial,
  serialKey,
  type Unit,
  type UnitStatus,
} from './units';

export {
  UNIT_STATUSES,
  UNIT_STATUS_JIRA_LABELS,
  UNIT_STATUS_LABELS,
  imeiDigits,
  isUnitStatus,
  isValidImei,
  luhnValid,
  normalizeImei,
  normalizeSerial,
  serialKey,
} from './units';
export type { Unit, UnitStatus } from './units';

export type Item = {
  id: string;
  name: string;
  sku: string;
  barcode?: string;
  folder: string;
  qty: number;
  min: number;
  price: number;
  /** Nom du fichier photo (dossier `photos` des documents de l'app), jamais un URI. */
  photo?: string;
  /**
   * Suivi par numéro de série (absent = `false`). Si `true`, `qty` est dérivé :
   * nombre d'unités « En stock » de l'article.
   */
  serialized?: boolean;
};

export type MovementMode = 'Entrée' | 'Sortie';

export type Movement = {
  id: string;
  itemId: string;
  sku: string;
  mode: MovementMode;
  qty: number;
  ts: number; // epoch ms
  /** Unité concernée (article suivi par numéro de série) ; absent sinon. */
  unitId?: string;
  /** Numéro de série de l'unité au moment du mouvement (reste lisible si l'unité est supprimée). */
  serial?: string;
};

export type CountStatus = 'Compté' | 'Passé';
export type CountEntry = {
  qty: number;
  status: CountStatus;
  /**
   * Article suivi par numéro de série : identifiants des unités trouvées
   * (`qty` = leur nombre). Absent pour un article suivi en quantité.
   */
  serials?: string[];
};

export type CountSession = {
  id: string;
  entries: Record<string, CountEntry>;
  idx: number;
  startedAt: number;
  completedAt?: number;
  /**
   * Stock de chaque article au moment de la clôture, avant ajustement
   * (absent des sessions en cours et de celles enregistrées avant son ajout).
   */
  expected?: Record<string, number>;
  /**
   * Articles suivis par numéro de série : unités « En stock » de chaque article
   * au moment de la clôture (identifiants), avant ajustement.
   */
  expectedUnits?: Record<string, string[]>;
  /**
   * Copie, à la clôture (après ajustement), des unités attendues et trouvées,
   * par identifiant : un appareil supprimé ensuite reste dans le rapport d'un
   * comptage terminé (écarts, export CSV).
   */
  unitSnapshot?: Record<string, Unit>;
};

export type CycleCountInfo = {
  id: string;
  name: string;
  folder: string;
  due: string;
  blind: boolean;
  total: number;
  done: number;
  /** Avancement entre 0 et 1 (0 si le comptage ne contient aucun article). */
  progress: number;
  completedAt?: number;
};

export type Prefs = { vibration: boolean };

export type StorageInfo = {
  persistent: boolean;
  lastSavedAt?: number;
  itemCount: number;
  movementCount: number;
  unitCount: number;
};

export type NewItemInput = {
  name: string;
  barcode?: string;
  sku?: string;
  folder: string;
  qty: number;
  min: number;
  price: number;
  /** Nom du fichier photo renvoyé par `pickPhoto()` (facultatif). */
  photo?: string;
  /** Suivi par numéro de série : exige `qty === 0` (le stock vient ensuite des unités). */
  serialized?: boolean;
};

export type CreateItemResult =
  | { item: Item; error?: undefined; field?: undefined }
  | { item?: undefined; error: string; field?: keyof NewItemInput };

/**
 * Champs modifiables d'un article. Le stock (`qty`) n'en fait pas partie :
 * il ne change que via `adjustStock`/`commitMovement`, pour que chaque
 * changement soit tracé par un mouvement.
 * - `barcode: ''` retire le code-barres ; `sku: ''` génère une nouvelle référence ;
 * - `photo: null` retire la photo ;
 * - `serialized: true` n'est accepté que si le stock est à 0, `false` que si
 *   l'article n'a aucune unité.
 */
export type UpdateItemPatch = {
  name?: string;
  barcode?: string;
  sku?: string;
  folder?: string;
  min?: number;
  price?: number;
  photo?: string | null;
  serialized?: boolean;
};

export type UpdateItemResult =
  | { item: Item; error?: undefined; field?: undefined }
  | { item?: undefined; error: string; field?: keyof UpdateItemPatch | 'id' };

export type DeleteItemResult = { ok: true } | { ok: false; error: string };

/** Suppression des fichiers photo, fournie par `data/photos.ts`. */
export type PhotoFileHooks = {
  deletePhoto: (name: string) => void;
  deleteAllPhotos: () => void;
};

export type CompleteCountResult =
  /** `adjusted` : articles dont le stock a changé ; `unitsUpdated` : unités dont le statut a changé. */
  | { ok: true; adjusted: number; unitsUpdated: number }
  | { ok: false; error: string };

export type NewUnitInput = {
  serial: string;
  imei?: string;
  /** Par défaut `'in_stock'`. */
  status?: UnitStatus;
  /** Obligatoire si `status === 'assigned'`. */
  assignee?: string;
  note?: string;
};

/**
 * Champs modifiables d'une unité. `imei: ''`, `assignee: ''` et `note: ''`
 * retirent la valeur. L'attributaire n'est conservé que pour le statut
 * « Attribué » : passer à un autre statut le retire.
 */
export type UpdateUnitPatch = {
  serial?: string;
  imei?: string;
  status?: UnitStatus;
  assignee?: string;
  note?: string;
};

export type UnitField = 'serial' | 'imei' | 'status' | 'assignee' | 'note' | 'itemId' | 'id';

export type UnitResult =
  | { unit: Unit; error?: undefined; field?: undefined }
  | { unit?: undefined; error: string; field?: UnitField };

export type DeleteUnitResult = { ok: true } | { ok: false; error: string };

/** Résultat d'un scan de numéro de série pendant un comptage. */
export type MarkUnitFoundResult =
  /** `duplicate` : l'unité était déjà comptée (aucun changement). */
  | { ok: true; itemId: string; unitId: string; duplicate: boolean; error?: undefined }
  | { ok: false; error: string; itemId?: undefined; unitId?: undefined };

/**
 * Écarts d'un article suivi par numéro de série dans un comptage.
 * - `expected` : unités attendues (« En stock » à la clôture pour un comptage
 *   terminé, sinon actuellement « En stock ») ;
 * - `found` : unités trouvées (scannées) ;
 * - `missing` : attendues mais non trouvées (vide si l'article n'est pas compté) ;
 * - `unexpected` : trouvées mais non attendues (statut autre que « En stock »).
 * Les unités supprimées depuis sont ignorées.
 */
export type CountDiscrepancy = {
  itemId: string;
  /** `true` si l'article a le statut « Compté » dans la session. */
  counted: boolean;
  expected: Unit[];
  found: Unit[];
  missing: Unit[];
  unexpected: Unit[];
};

/** Résolution d'un code scanné : unité (numéro de série ou IMEI) ou article (code-barres ou SKU). */
export type CodeMatch =
  | { kind: 'unit'; unit: Unit; item: Item }
  | { kind: 'item'; item: Item };

const MAX_MOVEMENTS = 500;
const DEFAULT_PREFS: Prefs = { vibration: true };

/**
 * Comptage cyclique unique : il porte sur tout l'inventaire (tous les
 * articles, dans l'ordre de la liste). La progression est calculée à partir
 * de la session enregistrée sur l'appareil.
 */
const CYCLE_COUNT = {
  id: 'c1',
  name: "Comptage de l'inventaire",
  folder: 'Tous les dossiers',
  due: "Aujourd'hui",
  blind: true,
} as const;

// ── Validation des données stockées ────────────────────────────────────────

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isMode = (v: unknown): v is MovementMode => v === 'Entrée' || v === 'Sortie';
const isCountStatus = (v: unknown): v is CountStatus => v === 'Compté' || v === 'Passé';

/**
 * Nom de fichier photo valide : un simple nom (pas de séparateur de chemin,
 * pas de `.`/`..`), jamais un URI ou un chemin absolu.
 */
export function isPhotoName(v: unknown): v is string {
  return typeof v === 'string' && v.length <= 200 && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(v);
}

function isItem(v: unknown): v is Item {
  return (
    isRecord(v) &&
    isNonEmptyString(v.id) &&
    typeof v.name === 'string' &&
    typeof v.sku === 'string' &&
    (v.barcode === undefined || typeof v.barcode === 'string') &&
    typeof v.folder === 'string' &&
    isFiniteNumber(v.qty) && v.qty >= 0 &&
    isFiniteNumber(v.min) && v.min >= 0 &&
    isFiniteNumber(v.price) && v.price >= 0 &&
    (v.photo === undefined || isPhotoName(v.photo)) &&
    (v.serialized === undefined || v.serialized === true)
  );
}

/**
 * Retire d'un article stocké un champ `photo` invalide (non-chaîne ou chemin)
 * et un champ `serialized` autre que `true` (`false` = absent), plutôt que de
 * rejeter l'article. Renvoie la valeur d'origine si rien n'est retiré.
 */
function withoutInvalidPhoto(v: unknown): unknown {
  if (!isRecord(v)) return v;
  const badPhoto = v.photo !== undefined && !isPhotoName(v.photo);
  const badSerialized = v.serialized !== undefined && v.serialized !== true;
  if (!badPhoto && !badSerialized) return v;
  const { photo, serialized, ...rest } = v;
  return { ...rest, ...(badPhoto ? {} : { photo }), ...(badSerialized ? {} : { serialized }) };
}

function isMovement(v: unknown): v is Movement {
  return (
    isRecord(v) &&
    isNonEmptyString(v.id) &&
    isNonEmptyString(v.itemId) &&
    typeof v.sku === 'string' &&
    isMode(v.mode) &&
    isFiniteNumber(v.qty) &&
    isFiniteNumber(v.ts) &&
    (v.unitId === undefined || typeof v.unitId === 'string') &&
    (v.serial === undefined || typeof v.serial === 'string')
  );
}

function isCountEntry(v: unknown): v is CountEntry {
  return isRecord(v) && isFiniteNumber(v.qty) && v.qty >= 0 && isCountStatus(v.status);
}

/** Copie validée d'une saisie de comptage (identifiants d'unités dédoublonnés). */
function toCountEntry(e: CountEntry): CountEntry {
  const raw: unknown = (e as { serials?: unknown }).serials;
  if (!Array.isArray(raw)) return { qty: e.qty, status: e.status };
  const serials = [...new Set(raw.filter(isNonEmptyString))];
  return { qty: e.qty, status: e.status, serials };
}

const isOptString = (v: unknown, max: number) => v === undefined || (typeof v === 'string' && v.length <= max);

function isUnit(v: unknown): v is Unit {
  if (!isRecord(v)) return false;
  if (!isNonEmptyString(v.id) || !isNonEmptyString(v.itemId)) return false;
  if (typeof v.serial !== 'string') return false;
  const serial = normalizeSerial(v.serial);
  if (serial.error !== undefined || serial.serial !== v.serial) return false;
  return (
    (v.imei === undefined || isValidImei(v.imei)) &&
    isUnitStatus(v.status) &&
    isOptString(v.assignee, ASSIGNEE_MAX_LENGTH) &&
    // Même règle qu'à l'écriture : un appareil attribué a un attributaire.
    (v.status !== 'assigned' || (typeof v.assignee === 'string' && v.assignee.trim().length > 0)) &&
    isOptString(v.note, NOTE_MAX_LENGTH) &&
    isFiniteNumber(v.receivedAt) &&
    isFiniteNumber(v.updatedAt)
  );
}

function toCountSession(v: unknown): CountSession | null {
  if (!isRecord(v) || !isNonEmptyString(v.id) || !isFiniteNumber(v.idx) || !isFiniteNumber(v.startedAt)) return null;
  if (!isRecord(v.entries)) return null;
  if (v.completedAt !== undefined && !isFiniteNumber(v.completedAt)) return null;
  const entries: Record<string, CountEntry> = {};
  for (const [itemId, e] of Object.entries(v.entries)) {
    if (isCountEntry(e)) entries[itemId] = toCountEntry(e);
  }
  // `expected` est facultatif (sessions antérieures) : une valeur invalide est
  // ignorée plutôt que de rejeter la session.
  let expected: Record<string, number> | undefined;
  if (isRecord(v.expected)) {
    expected = {};
    for (const [itemId, q] of Object.entries(v.expected)) {
      if (isFiniteNumber(q) && q >= 0) expected[itemId] = q;
    }
  }
  let expectedUnits: Record<string, string[]> | undefined;
  if (isRecord(v.expectedUnits)) {
    expectedUnits = {};
    for (const [itemId, ids] of Object.entries(v.expectedUnits)) {
      if (Array.isArray(ids)) expectedUnits[itemId] = [...new Set(ids.filter(isNonEmptyString))];
    }
  }
  let unitSnapshot: Record<string, Unit> | undefined;
  if (isRecord(v.unitSnapshot)) {
    unitSnapshot = {};
    for (const [unitId, u] of Object.entries(v.unitSnapshot)) {
      if (isUnit(u) && u.id === unitId) unitSnapshot[unitId] = u;
    }
  }
  return {
    id: v.id,
    entries,
    idx: Math.max(0, Math.floor(v.idx)),
    startedAt: v.startedAt,
    ...(v.completedAt !== undefined ? { completedAt: v.completedAt } : {}),
    ...(expected ? { expected } : {}),
    ...(expectedUnits ? { expectedUnits } : {}),
    ...(unitSnapshot ? { unitSnapshot } : {}),
  };
}

/** Garde les éléments valides d'un tableau (et dédoublonne par id). */
function validList<T extends { id: string }>(v: unknown, guard: (x: unknown) => x is T): T[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  const out: T[] = [];
  for (const x of v) {
    if (guard(x) && !seen.has(x.id)) {
      seen.add(x.id);
      out.push(x);
    }
  }
  return out;
}

// ── État ───────────────────────────────────────────────────────────────────

type State = {
  items: Item[];
  /** Unités des articles suivis par numéro de série, par ordre de réception. */
  units: Unit[];
  movements: Movement[]; // trié du plus récent au plus ancien
  sessions: Record<string, CountSession>;
  prefs: Prefs;
  lastSavedAt?: number;
};

let _state: State | null = null;
const _pendingCountScans = new Map<string, string>();
/** Codes lus par le scanner pour un champ de formulaire (voir `setPendingPick`), en mémoire seulement. */
const _pendingPicks = new Map<string, string>();
let _photoHooks: PhotoFileHooks | null = null;

/** Enregistré par `data/photos.ts` au chargement du module. */
export function setPhotoFileHooks(hooks: PhotoFileHooks | null): void {
  _photoHooks = hooks;
}

/** Supprime un fichier photo (best effort, ne lève jamais). */
function removePhotoFile(name: string | undefined): void {
  if (!name) return;
  try {
    _photoHooks?.deletePhoto(name);
  } catch (e) {
    console.warn('[store] Suppression de la photo impossible.', e);
  }
}

/** Supprime toutes les photos (best effort, ne lève jamais). */
function removeAllPhotoFiles(): void {
  try {
    _photoHooks?.deleteAllPhotos();
  } catch (e) {
    console.warn('[store] Suppression des photos impossible.', e);
  }
}

let _seq = 0;
/** Identifiant unique, même pour plusieurs appels dans la même milliseconde. */
function uid(prefix: string): string {
  _seq = (_seq + 1) % 1_679_616; // 36^4
  return `${prefix}${Date.now().toString(36)}-${_seq.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** État vierge : aucun article, aucun mouvement, aucun comptage. */
function blankState(prefs: Prefs = DEFAULT_PREFS): State {
  return { items: [], units: [], movements: [], sessions: {}, prefs: { ...prefs } };
}

/** Jeu de données d'exemple (`data/mock.ts`), chargé uniquement à la demande. */
function sampleState(prefs: Prefs): State {
  const now = Date.now();
  const units: Unit[] = sampleUnits.map((u, idx) => ({
    ...u,
    receivedAt: now - (30 - idx) * 86_400_000,
    updatedAt: now - (10 - idx) * 3_600_000,
  }));
  // Stock dérivé des unités pour les articles suivis par numéro de série.
  const items = sampleItems.map((i) =>
    i.serialized ? { ...i, qty: units.filter((u) => u.itemId === i.id && u.status === 'in_stock').length } : { ...i }
  );
  const movements: Movement[] = sampleRecent.map((r, idx) => ({
    id: `seed-${r.id}`,
    itemId: r.itemId,
    sku: items.find((i) => i.id === r.itemId)?.sku ?? '',
    mode: r.label.startsWith('Entrée') ? 'Entrée' : 'Sortie',
    qty: idx === 0 ? 2 : 10,
    ts: now - (idx + 1) * 60_000,
  }));
  return { items, units, movements, sessions: {}, prefs: { ...prefs } };
}

function loadPrefs(): Prefs {
  const rawPrefs = readData(KEYS.prefs, {});
  return {
    vibration: isRecord(rawPrefs) && typeof rawPrefs.vibration === 'boolean' ? rawPrefs.vibration : DEFAULT_PREFS.vibration,
  };
}

/**
 * Valeurs à lire à la place du stockage pendant `loadState` : les valeurs
 * « avant » d'un journal dont la réparation a échoué (voir `recoverJournal`).
 */
let _loadOverlay: Map<string, string | null> | null = null;

/**
 * Vrai si une lecture de `readData` a échoué (lecture refusée, distincte d'une
 * clé absente ou d'un JSON corrompu) depuis le début du chargement en cours.
 */
let _loadReadFailed = false;

/**
 * Lit une clé de données pour le chargement (journal non réparé pris en
 * compte). Renvoie `fallback` si la clé est absente ou son JSON corrompu ; si
 * la lecture elle-même échoue, renvoie aussi `fallback` mais lève
 * `_loadReadFailed` : la valeur par défaut ne reflète alors pas le stockage et
 * ne doit jamais y être écrite.
 */
function readData(key: string, fallback: unknown): unknown {
  let raw: string | null;
  if (_loadOverlay?.has(key)) {
    raw = _loadOverlay.get(key) ?? null;
  } else {
    const r = readRaw(key);
    if (!r.ok) {
      _loadReadFailed = true;
      return fallback;
    }
    raw = r.value;
  }
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return fallback;
  }
}

/**
 * Résultat d'un chargement depuis le stockage. `writes` : parties à réécrire
 * (premier lancement, entrées invalides écartées) ; `readFailed` : une lecture
 * a échoué, l'état n'est pas fiable et rien ne doit être écrit.
 */
type Loaded = { state: State; writes: Part[]; readFailed: boolean };

function loadState(): State {
  // Enregistrement interrompu (journal présent) : réparé AVANT toute lecture.
  // Si la réparation échoue, le journal est conservé (nouvel essai au prochain
  // enregistrement ou lancement) et le chargement lit ses valeurs « avant »,
  // pour que la mémoire reparte de l'état cohérent précédant l'opération.
  // Si le journal n'a pas pu être lu ni évalué (lecture refusée), on ne sait
  // pas si le stockage est cohérent : la mémoire chargée n'est pas fiable
  // (`_memoryUntrusted`), rien n'est réécrit au chargement et la mémoire est
  // rechargée depuis le stockage dès qu'une réparation aboutit (voir `save`).
  // De même si une clé de données n'a pas pu être lue : ses valeurs par défaut
  // ne reflètent pas le stockage et ne doivent pas y être écrites.
  const rec = recoverJournal();
  if (!rec.ok) {
    _storageInconsistent = true;
    if (rec.journal) {
      _loadOverlay = new Map(Object.entries(rec.journal.keys).map(([k, e]) => [k, e.before]));
    } else {
      _memoryUntrusted = true;
    }
  }
  let loaded: Loaded;
  try {
    loaded = loadStateFromStorage();
  } finally {
    _loadOverlay = null;
  }
  // Mémoire affectée AVANT toute écriture : `save` (via `state()`) écrit cet
  // état et ne relance pas de chargement.
  _state = loaded.state;
  if (loaded.readFailed) {
    _memoryUntrusted = true;
    _storageInconsistent = true;
  } else if (loaded.writes.length > 0) {
    // Mémoire non fiable : ne pas réécrire (le prochain enregistrement, après
    // rechargement, s'en charge).
    if (_memoryUntrusted) _storageInconsistent = true;
    else persist(...loaded.writes);
  }
  return _state;
}

/**
 * Lit l'état depuis le stockage. N'écrit rien et ne modifie ni `_state` ni les
 * indicateurs : l'appelant décide des écritures (voir `Loaded`).
 */
function loadStateFromStorage(): Loaded {
  _loadReadFailed = false;
  const prefs = loadPrefs();
  const rawItems = readData(KEYS.items, null);
  const cleanedItems = Array.isArray(rawItems) ? rawItems.map(withoutInvalidPhoto) : rawItems;
  const photoDropped = Array.isArray(rawItems) && Array.isArray(cleanedItems) && cleanedItems.some((x, i) => x !== rawItems[i]);
  const items = validList(cleanedItems, isItem);
  // Absents (premier lancement), illisibles, ou liste non vide sans aucune
  // entrée valide : on démarre avec un inventaire vide, en conservant les
  // préférences, et on l'enregistre pour qu'un relancement reste vide.
  // Une liste vide `[]` est valide (inventaire vide) et suit le chemin normal.
  const unusable = !Array.isArray(rawItems) || (rawItems.length > 0 && items.length === 0);
  if (unusable) {
    if (_loadReadFailed) return { state: blankState(prefs), writes: [], readFailed: true };
    return { state: blankState(prefs), writes: ['items', 'units', 'movements', 'sessions'], readFailed: false };
  }

  const itemIds = new Set(items.map((i) => i.id));
  // Unités : clé absente (installation antérieure) = aucune unité. On écarte
  // les unités invalides, celles d'un article inconnu ou non suivi, et les
  // doublons de numéro de série / d'IMEI (la première est conservée).
  // Mêmes règles qu'à l'écriture (`validateUnit`) : un numéro de série ne
  // peut pas être l'IMEI d'un autre appareil (tirets et espaces ignorés), ni le
  // code-barres ou le SKU d'un article.
  const rawUnits = readData(KEYS.units, []);
  const serializedIds = new Set(items.filter((i) => i.serialized).map((i) => i.id));
  const itemCodes = new Set<string>();
  for (const i of items) {
    itemCodes.add(looseKey(i.sku));
    if (i.barcode !== undefined) itemCodes.add(looseKey(i.barcode));
  }
  itemCodes.delete('');
  // Formes IMEI des codes d'articles (même équivalence que `findUnitByCode`).
  const itemImeis = new Set<string>();
  for (const i of items) {
    itemImeis.add(imeiForm(i.sku));
    if (i.barcode !== undefined) itemImeis.add(imeiForm(i.barcode));
  }
  itemImeis.delete('');
  const serialKeys = new Set<string>(); // serialKey des numéros de série conservés
  const serialDigits = new Set<string>(); // les mêmes, tirets retirés (forme IMEI)
  const imeis = new Set<string>(); // IMEI conservés
  const units = validList(rawUnits, isUnit).filter((u) => {
    if (!serializedIds.has(u.itemId)) return false;
    const sk = serialKey(u.serial);
    const sd = imeiDigits(sk);
    if (serialKeys.has(sk) || imeis.has(sd)) return false;
    if (u.imei !== undefined && (imeis.has(u.imei) || serialDigits.has(u.imei))) return false;
    if (itemCodes.has(looseKey(u.serial)) || (u.imei !== undefined && itemImeis.has(u.imei))) return false;
    serialKeys.add(sk);
    serialDigits.add(sd);
    if (u.imei !== undefined) imeis.add(u.imei);
    return true;
  });
  // Stock dérivé : resynchronisé s'il diffère des unités stockées.
  let qtyFixed = false;
  for (let n = 0; n < items.length; n++) {
    const it = items[n];
    if (!it?.serialized) continue;
    const q = units.filter((u) => u.itemId === it.id && u.status === 'in_stock').length;
    if (it.qty !== q) {
      items[n] = { ...it, qty: q };
      qtyFixed = true;
    }
  }
  const rawMovements = readData(KEYS.movements, []);
  const movements = validList(rawMovements, isMovement)
    .filter((m) => itemIds.has(m.itemId))
    .sort((a, b) => b.ts - a.ts)
    .slice(0, MAX_MOVEMENTS);
  // Entrées invalides écartées : on réécrit les listes nettoyées au chargement.
  const dirty: Part[] = [];
  if (!Array.isArray(rawItems) || items.length !== rawItems.length || photoDropped || qtyFixed) dirty.push('items');
  if (!Array.isArray(rawMovements) || movements.length !== rawMovements.length) dirty.push('movements');
  if (!Array.isArray(rawUnits) || units.length !== rawUnits.length) dirty.push('units');

  const sessions: Record<string, CountSession> = {};
  const rawSessions = readData(KEYS.countSessions, {});
  if (isRecord(rawSessions)) {
    for (const v of Object.values(rawSessions)) {
      const s = toCountSession(v);
      if (s) sessions[s.id] = s;
    }
  }

  const rawMeta = readData(KEYS.meta, {});
  const lastSavedAt = isRecord(rawMeta) && isFiniteNumber(rawMeta.lastSavedAt) ? rawMeta.lastSavedAt : undefined;

  const loaded: State = { items, units, movements, sessions, prefs, lastSavedAt };
  // Lecture refusée : l'état lu est incomplet (par ex. articles sans leurs
  // unités, stock dérivé faux). On affiche un inventaire vide, jamais
  // enregistré, jusqu'à un rechargement complet (voir `save`).
  if (_loadReadFailed) return { state: blankState(prefs), writes: [], readFailed: true };
  return { state: loaded, writes: dirty, readFailed: false };
}

function state(): State {
  if (!_state) _state = loadState();
  return _state;
}

// ── Écriture ───────────────────────────────────────────────────────────────

type Part = 'items' | 'units' | 'movements' | 'sessions' | 'prefs';

const ALL_PARTS: readonly Part[] = ['items', 'units', 'movements', 'sessions', 'prefs'];

/**
 * Clé de stockage de chaque partie de l'état.
 */
const PART_KEYS: Record<Part, string> = {
  items: KEYS.items,
  units: KEYS.units,
  movements: KEYS.movements,
  sessions: KEYS.countSessions,
  prefs: KEYS.prefs,
};

const DATA_KEYS: ReadonlySet<string> = new Set(Object.values(PART_KEYS));

function partValue(s: State, p: Part): unknown {
  return p === 'items' ? s.items
    : p === 'units' ? s.units
    : p === 'movements' ? s.movements
    : p === 'sessions' ? s.sessions
    : s.prefs;
}

/**
 * Journal d'écriture (clé `KEYS.txn`). MMKV n'écrit pas plusieurs clés de
 * façon atomique : avant d'écrire les clés de données, `save` enregistre pour
 * chacune sa valeur brute précédente (`before`, `null` = clé absente) et la
 * nouvelle (`after`). Le journal est supprimé une fois l'enregistrement
 * terminé ou annulé. S'il reste présent (annulation impossible, arrêt de
 * l'application en cours d'écriture, suppression du journal refusée), il est
 * traité au lancement suivant, avant toute lecture, ou au début du prochain
 * enregistrement (`recoverJournal`) :
 * - toutes les clés valent `after` : l'enregistrement était terminé, le
 *   journal est simplement supprimé ;
 * - sinon chaque clé est remise à `before` (l'opération est annulée en
 *   entier), puis le journal est supprimé.
 * Le stockage n'est ainsi jamais laissé avec une partie seulement d'une
 * opération (par ex. une unité sans son mouvement). Les valeurs brutes rendent
 * la comparaison exacte ; la réparation est idempotente (une clé déjà à
 * `before` n'est pas réécrite) et peut donc être interrompue et relancée.
 */
type JournalEntry = { before: string | null; after: string };
type Journal = { id: string; keys: Record<string, JournalEntry> };

function parseJournal(raw: string): Journal | null {
  try {
    const v: unknown = JSON.parse(raw);
    if (!isRecord(v) || typeof v.id !== 'string' || !isRecord(v.keys)) return null;
    const keys: Record<string, JournalEntry> = {};
    for (const [k, e] of Object.entries(v.keys)) {
      // Seules les clés de données peuvent être restaurées.
      if (!DATA_KEYS.has(k) || !isRecord(e)) return null;
      if (typeof e.after !== 'string' || (e.before !== null && typeof e.before !== 'string')) return null;
      keys[k] = { before: e.before, after: e.after };
    }
    return { id: v.id, keys };
  } catch {
    return null;
  }
}

/** Vrai si un journal est (peut-être) présent dans le stockage : à traiter avant le prochain enregistrement. */
let _journalPending = false;

/** Remet `key` à la valeur brute `value` (`null` = clé supprimée), sauf si elle l'a déjà. */
function restoreKey(key: string, value: string | null): boolean {
  const cur = readRaw(key);
  if (cur.ok && cur.value === value) return true;
  return value === null ? removeKey(key) : writeRaw(key, value);
}

/**
 * Traite le journal éventuellement présent (voir `Journal`). `ok` vaut `true`
 * si le stockage est cohérent (aucun journal, enregistrement terminé ou
 * annulé), même si la suppression du journal a échoué (`_journalPending`
 * reste alors levé : le journal, devenu sans effet, sera supprimé ou remplacé
 * plus tard). `ok` vaut `false` si la restauration a échoué : le journal est
 * conservé et renvoyé dans `journal` ; `journal` vaut `null` si le journal ou
 * une clé n'a pas pu être lu (rien n'a été décidé ni écrit). Ne lève pas.
 */
function recoverJournal(): { ok: true } | { ok: false; journal: Journal | null } {
  const raw = readRaw(KEYS.txn);
  if (!raw.ok) {
    _journalPending = true;
    return { ok: false, journal: null };
  }
  if (raw.value === null) {
    _journalPending = false;
    return { ok: true };
  }
  const journal = parseJournal(raw.value);
  if (journal) {
    const entries = Object.entries(journal.keys);
    // Une lecture refusée ne permet pas de décider : on ne touche à rien (annuler
    // un enregistrement peut-être terminé et déjà signalé comme réussi serait
    // une perte), le journal est conservé pour un nouvel essai.
    let completed = true;
    for (const [k, e] of entries) {
      const cur = readRaw(k);
      if (!cur.ok) {
        _journalPending = true;
        return { ok: false, journal: null };
      }
      if (cur.value !== e.after) completed = false;
    }
    if (!completed) {
      let restored = true;
      for (const [k, e] of entries) if (!restoreKey(k, e.before)) restored = false;
      if (!restored) {
        _journalPending = true;
        return { ok: false, journal };
      }
    }
  } else {
    console.warn('[store] Journal d\'écriture illisible, ignoré.');
  }
  _journalPending = !removeKey(KEYS.txn);
  return { ok: true };
}

/**
 * Vrai si la mémoire peut différer du stockage : écriture refusée sans retour
 * arrière de la mémoire (`persist`), annulation impossible (journal
 * conservé), ou journal non réparé au chargement. Le prochain enregistrement
 * réécrit alors toutes les clés, et l'indicateur n'est baissé que si cette
 * réécriture complète réussit.
 */
let _storageInconsistent = false;

/**
 * Vrai si la mémoire a été chargée sans que le journal ait pu être évalué
 * (lecture refusée au chargement) : elle peut refléter une opération à moitié
 * écrite. Après la première réparation réussie, la mémoire est rechargée
 * depuis le stockage (redevenu cohérent) au lieu d'y être réécrite.
 */
let _memoryUntrusted = false;

type SaveResult =
  | { ok: true; written: Part[] }
  /**
   * `unchanged` : le stockage est resté (ou revenu) à son état précédent, sans journal en attente.
   * `reloaded` : rien n'a été écrit, la mémoire a été rechargée depuis le stockage
   * (voir `_memoryUntrusted`) : l'opération en cours est abandonnée.
   * `untrusted` : rien n'a été écrit, la mémoire n'est toujours pas fiable
   * (rechargement impossible, lecture refusée) : l'opération en cours est abandonnée.
   */
  | { ok: false; written: Part[]; unchanged: boolean; reloaded?: boolean; untrusted?: boolean };

/**
 * Écrit `parts` (toutes les parties si le stockage est peut-être incohérent)
 * sous journal (voir `Journal`) puis, si tout a été écrit, supprime le journal
 * et écrit la date du dernier enregistrement. Si une écriture échoue, les clés
 * déjà écrites sont remises à leur valeur précédente ; si cette remise échoue,
 * le journal est conservé pour réparation. Ne touche pas à la mémoire.
 */
function save(parts: readonly Part[]): SaveResult {
  // Journal précédent non traité : le réparer avant d'en écrire un nouveau
  // (sinon ses valeurs « avant » seraient perdues). Échec : on n'écrit rien.
  if (_journalPending && !recoverJournal().ok) return { ok: false, written: [], unchanged: false };
  if (_memoryUntrusted) {
    // Réparation aboutie : le stockage est cohérent, la mémoire peut ne pas
    // l'être. On la recharge (sans écrire la mémoire douteuse) et l'opération
    // en cours échoue. Si une lecture échoue encore, la mémoire reste non
    // fiable et rien n'est écrit (nouvel essai au prochain enregistrement).
    const loaded = loadStateFromStorage();
    if (loaded.readFailed) return { ok: false, written: [], unchanged: true, untrusted: true };
    _memoryUntrusted = false;
    // Nettoyage éventuel (premier lancement, entrées invalides) : fait par le
    // prochain enregistrement, qui réécrira alors toutes les clés.
    _storageInconsistent = loaded.writes.length > 0;
    _state = loaded.state;
    return { ok: false, written: [], unchanged: true, reloaded: true };
  }
  const full = _storageInconsistent;
  const list = full ? ALL_PARTS : parts;
  const s = state();
  const keys: Record<string, JournalEntry> = {};
  for (const p of list) {
    const key = PART_KEYS[p];
    const before = readRaw(key);
    if (!before.ok) return { ok: false, written: [], unchanged: true };
    let after: string;
    try {
      after = JSON.stringify(partValue(s, p));
    } catch (e) {
      console.warn(`[store] Sérialisation impossible (${key}).`, e);
      return { ok: false, written: [], unchanged: true };
    }
    keys[key] = { before: before.value, after };
  }
  // Journal refusé : rien d'autre n'est écrit (un éventuel ancien journal,
  // déjà traité ci-dessus, reste sans effet).
  const journal: Journal = { id: uid('t'), keys };
  if (!writeRaw(KEYS.txn, JSON.stringify(journal))) {
    return { ok: false, written: [], unchanged: true };
  }
  _journalPending = true;
  const written: Part[] = [];
  for (const p of list) {
    if (!writeRaw(PART_KEYS[p], keys[PART_KEYS[p]].after)) break;
    written.push(p);
  }
  if (written.length < list.length) {
    // On remet les clés écrites et, par précaution, celle dont l'écriture a été
    // refusée (`restoreKey` n'écrit que si sa valeur a changé).
    let restored = true;
    for (const p of list.slice(0, written.length + 1).reverse()) {
      const key = PART_KEYS[p];
      if (!restoreKey(key, keys[key].before)) restored = false;
    }
    if (restored) _journalPending = !removeKey(KEYS.txn);
    return { ok: false, written, unchanged: restored };
  }
  // Échec de la suppression du journal sans conséquence : toutes les clés
  // valent `after`, il sera reconnu comme terminé.
  _journalPending = !removeKey(KEYS.txn);
  if (full) _storageInconsistent = false;
  s.lastSavedAt = Date.now();
  writeJSON(KEYS.meta, { lastSavedAt: s.lastSavedAt });
  return { ok: true, written };
}

/**
 * Écrit les parties demandées ; renvoie `false` si une écriture a échoué.
 * La mémoire n'est PAS remise à l'état précédent (contrairement à `commit`) :
 * le stockage, lui, est revenu à l'état d'avant l'opération (ou le sera à la
 * réparation du journal). La mémoire en diffère donc : `_storageInconsistent`
 * est levé et le prochain enregistrement réussi réécrit toutes les clés
 * (stockage = mémoire). Si l'application s'arrête avant, l'opération est
 * perdue en entier, jamais à moitié.
 */
function persist(...parts: Part[]): boolean {
  const r = save(parts);
  if (!r.ok && !r.reloaded && !r.untrusted) _storageInconsistent = true;
  return r.ok;
}

function persistAll() {
  persist(...ALL_PARTS);
}

const SAVE_ERROR =
  "Impossible d'enregistrer la modification sur l'appareil (stockage plein ou indisponible). Rien n'a été modifié.";

const PARTIAL_SAVE_ERROR =
  "Enregistrement incomplet : les données de l'appareil peuvent être partiellement enregistrées. Réessayez l'opération.";

/**
 * Mémoire non fiable (voir `_memoryUntrusted`) : les opérations qui modifient
 * la mémoire avant `persist` (sans retour arrière) sont refusées d'emblée, sans
 * rien modifier ni écrire. On tente au passage la réparation et le
 * rechargement (`save` n'écrit aucune donnée tant que la mémoire n'est pas
 * fiable). Renvoie `true` si l'opération doit échouer avec `SAVE_ERROR`.
 */
/**
 * Faux tant que la mémoire n'est pas fiable (voir `_memoryUntrusted`) : les
 * listes affichées peuvent alors être vides alors que le stockage contient des
 * articles. Utilisé par le nettoyage des photos orphelines, qui ne doit rien
 * supprimer d'après une mémoire non fiable.
 */
export function isMemoryTrusted(): boolean {
  state();
  return !_memoryUntrusted;
}

function refuseUntrusted(): boolean {
  state();
  if (!_memoryUntrusted) return false;
  save([]);
  return true;
}

type Snapshot = Pick<State, 'items' | 'units' | 'movements' | 'sessions'>;

/**
 * Copie de l'état avant une mutation, pour l'annuler si l'écriture échoue.
 * Les sessions sont copiées une à une : `writableSession` renvoie l'objet
 * session enregistré, que les fonctions de comptage modifient sur place.
 */
function snapshot(): Snapshot {
  const s = state();
  const sessions: Record<string, CountSession> = {};
  for (const [sid, session] of Object.entries(s.sessions)) sessions[sid] = { ...session };
  return { items: s.items, units: s.units, movements: s.movements, sessions };
}

/**
 * Écrit `parts`. En cas d'échec, rétablit l'état `snap` en mémoire ; `save`
 * a remis les clés déjà écrites à leur valeur précédente, sans avancer la date
 * du dernier enregistrement. Renvoie `null` si tout a été enregistré, sinon le
 * message d'erreur : `SAVE_ERROR` si le stockage est revenu à l'état précédent,
 * `PARTIAL_SAVE_ERROR` s'il peut différer de la mémoire (voir
 * `_storageInconsistent` ; le journal conservé le ramènera à l'état précédent
 * au prochain enregistrement ou lancement). Ne lève pas.
 */
function commit(snap: Snapshot, ...parts: Part[]): string | null {
  const r = save(parts);
  if (r.ok) return null;
  if (r.reloaded) return SAVE_ERROR; // mémoire rechargée depuis le stockage : `snap` en est antérieur
  Object.assign(state(), snap);
  if (r.untrusted) return SAVE_ERROR; // rien n'a été écrit, mémoire rétablie
  if (!r.unchanged) _storageInconsistent = true;
  return _storageInconsistent ? PARTIAL_SAVE_ERROR : SAVE_ERROR;
}

function replaceItem(updated: Item) {
  const s = state();
  s.items = s.items.map((i) => (i.id === updated.id ? updated : i));
}

function pushMovement(item: Item, mode: MovementMode, qty: number, unit?: Unit) {
  const s = state();
  const m: Movement = {
    id: uid('m'), itemId: item.id, sku: item.sku, mode, qty, ts: Date.now(),
    ...(unit ? { unitId: unit.id, serial: unit.serial } : {}),
  };
  s.movements = [m, ...s.movements].slice(0, MAX_MOVEMENTS);
}

/** Recalcule le stock dérivé d'un article suivi par numéro de série. */
function syncDerivedQty(itemId: string): void {
  const s = state();
  const item = s.items.find((i) => i.id === itemId);
  if (!item?.serialized) return;
  const qty = s.units.filter((u) => u.itemId === itemId && u.status === 'in_stock').length;
  if (qty !== item.qty) replaceItem({ ...item, qty });
}

// ── Articles ───────────────────────────────────────────────────────────────

export function getItems(): Item[] {
  return state().items;
}

export function getItem(id: string): Item | undefined {
  return state().items.find((i) => i.id === id);
}

const norm = (s: string) => s.trim().toLowerCase();

const UNIT_CODE_CONFLICT = "Ce code est déjà utilisé comme numéro de série ou IMEI d'un appareil.";

/**
 * Clé de comparaison d'un code : un EAN-13 commençant par 0 est le même code
 * que sa forme UPC-A à 12 chiffres (iOS retire ce 0 lors de la lecture).
 */
function codeKey(s: string): string {
  const c = norm(s);
  return /^0\d{12}$/.test(c) ? c.slice(1) : c;
}

/** Recherche par code-barres OU SKU (espaces ignorés, insensible à la casse). */
export function findItemByCode(code: string): Item | undefined {
  const c = codeKey(code);
  if (!c) return undefined;
  const items = state().items;
  return items.find((i) => i.barcode !== undefined && codeKey(i.barcode) === c) ?? items.find((i) => codeKey(i.sku) === c);
}

/** @deprecated Utiliser `findItemByCode`. */
export const findItemBySku = findItemByCode;

/**
 * `true` si `code` est déjà utilisé comme code-barres ou SKU d'un article
 * (hors article `exceptId`, pour la modification).
 */
function isCodeTaken(code: string, exceptId?: string): boolean {
  const c = codeKey(code);
  return state().items.some(
    (i) => i.id !== exceptId && (codeKey(i.sku) === c || (i.barcode !== undefined && codeKey(i.barcode) === c))
  );
}

/**
 * Clé « large » pour détecter les ambiguïtés entre codes d'articles et codes
 * d'unités : espaces retirés, puis `codeKey` (casse et 0 de tête EAN-13/UPC-A).
 */
const looseKey = (s: string) => codeKey(s.replace(/\s+/g, ''));

/**
 * Forme IMEI d'un code : 15 chiffres une fois espaces et tirets retirés
 * (même règle que la recherche par IMEI de `findUnitByCode`), sinon `''`.
 */
function imeiForm(code: string): string {
  const d = imeiDigits(code.trim());
  return /^\d{15}$/.test(d) ? d : '';
}

/** `true` si `code` correspond au code-barres ou au SKU d'un article. */
function isItemCode(code: string): boolean {
  const c = looseKey(code);
  if (!c) return false;
  return state().items.some((i) => looseKey(i.sku) === c || (i.barcode !== undefined && looseKey(i.barcode) === c));
}

/**
 * `true` si l'IMEI normalisé `imei` serait aussi trouvé par un code-barres ou
 * un SKU d'article (ex. SKU `356-938035643809`) : tirets et espaces ignorés.
 */
function isItemImei(imei: string): boolean {
  return state().items.some((i) => imeiForm(i.sku) === imei || (i.barcode !== undefined && imeiForm(i.barcode) === imei));
}

/**
 * `true` si `code` correspond au numéro de série ou à l'IMEI d'une unité,
 * avec les équivalences de `findUnitByCode` (IMEI : tirets et espaces ignorés).
 */
function isUnitCode(code: string): boolean {
  const c = looseKey(code);
  if (!c) return false;
  const imei = imeiForm(code);
  return state().units.some((u) => looseKey(u.serial) === c || (u.imei !== undefined && u.imei === imei));
}

/** Prochaine référence `SKU-n` libre (et différente de `avoid`, le code-barres saisi). */
function nextSku(avoid?: string): string {
  let n = 1000;
  for (const i of state().items) {
    const m = /^SKU-(\d+)$/i.exec(i.sku);
    if (m) n = Math.max(n, Number(m[1]) + 1);
  }
  const avoidKey = avoid ? codeKey(avoid) : '';
  while (isCodeTaken(`SKU-${n}`) || isUnitCode(`SKU-${n}`) || codeKey(`SKU-${n}`) === avoidKey) n++;
  return `SKU-${n}`;
}

function nextItemId(): string {
  const ids = new Set(state().items.map((i) => i.id));
  let n = state().items.reduce((max, i) => (/^\d+$/.test(i.id) ? Math.max(max, Number(i.id)) : max), 0) + 1;
  while (ids.has(String(n))) n++;
  return String(n);
}

export function createItem(input: NewItemInput): CreateItemResult {
  if (refuseUntrusted()) return { error: SAVE_ERROR };
  const name = input.name.trim();
  const folder = input.folder.trim();
  const barcode = input.barcode?.trim() ?? '';
  const sku = input.sku?.trim() ?? '';

  if (!name) return { error: 'Le nom est obligatoire.', field: 'name' };
  if (!folder) return { error: 'Choisissez ou saisissez un dossier.', field: 'folder' };
  if (!Number.isInteger(input.qty) || input.qty < 0) return { error: 'La quantité initiale doit être un entier positif ou nul.', field: 'qty' };
  if (!Number.isInteger(input.min) || input.min < 0) return { error: 'Le seuil minimum doit être un entier positif ou nul.', field: 'min' };
  if (!Number.isFinite(input.price) || input.price < 0) return { error: 'Le prix doit être un nombre positif ou nul.', field: 'price' };
  if (barcode && isCodeTaken(barcode)) return { error: 'Ce code-barres est déjà utilisé par un autre article.', field: 'barcode' };
  if (sku && isCodeTaken(sku)) return { error: 'Cette référence (SKU) est déjà utilisée.', field: 'sku' };
  if (barcode && sku && codeKey(barcode) === codeKey(sku)) return { error: 'Le SKU doit être différent du code-barres.', field: 'sku' };
  if (barcode && isUnitCode(barcode)) return { error: UNIT_CODE_CONFLICT, field: 'barcode' };
  if (sku && isUnitCode(sku)) return { error: UNIT_CODE_CONFLICT, field: 'sku' };
  if (input.photo !== undefined && !isPhotoName(input.photo)) return { error: 'Photo invalide.', field: 'photo' };
  if (input.serialized === true && input.qty !== 0) {
    return {
      error: 'Un article suivi par numéro de série démarre avec un stock de 0 : ajoutez ensuite les numéros de série de chaque appareil.',
      field: 'qty',
    };
  }

  const item: Item = {
    id: nextItemId(),
    name,
    sku: sku || nextSku(barcode),
    ...(barcode ? { barcode } : {}),
    folder,
    qty: input.qty,
    min: input.min,
    price: input.price,
    ...(input.photo !== undefined ? { photo: input.photo } : {}),
    ...(input.serialized === true ? { serialized: true } : {}),
  };

  const s = state();
  s.items = [...s.items, item];
  if (item.qty > 0) {
    pushMovement(item, 'Entrée', item.qty);
    persist('items', 'movements');
  } else {
    persist('items');
  }
  return { item };
}

/**
 * Modifie un article (mêmes règles de validation que `createItem`). Le stock
 * n'est pas modifiable ici. Si la photo est remplacée ou retirée, l'ancien
 * fichier est supprimé après l'enregistrement.
 */
export function updateItem(id: string, patch: UpdateItemPatch): UpdateItemResult {
  if (refuseUntrusted()) return { error: SAVE_ERROR };
  const current = getItem(id);
  if (!current) return { error: 'Article introuvable.', field: 'id' };

  const name = patch.name !== undefined ? patch.name.trim() : current.name;
  const folder = patch.folder !== undefined ? patch.folder.trim() : current.folder;
  const barcode = patch.barcode !== undefined ? patch.barcode.trim() : (current.barcode ?? '');
  const skuInput = patch.sku !== undefined ? patch.sku.trim() : current.sku;
  const min = patch.min ?? current.min;
  const price = patch.price ?? current.price;
  const photo = patch.photo === undefined ? current.photo : (patch.photo ?? undefined);

  if (!name) return { error: 'Le nom est obligatoire.', field: 'name' };
  if (!folder) return { error: 'Choisissez ou saisissez un dossier.', field: 'folder' };
  if (!Number.isInteger(min) || min < 0) return { error: 'Le seuil minimum doit être un entier positif ou nul.', field: 'min' };
  if (!Number.isFinite(price) || price < 0) return { error: 'Le prix doit être un nombre positif ou nul.', field: 'price' };
  if (barcode && isCodeTaken(barcode, id)) return { error: 'Ce code-barres est déjà utilisé par un autre article.', field: 'barcode' };
  if (skuInput && isCodeTaken(skuInput, id)) return { error: 'Cette référence (SKU) est déjà utilisée.', field: 'sku' };
  if (barcode && skuInput && codeKey(barcode) === codeKey(skuInput)) return { error: 'Le SKU doit être différent du code-barres.', field: 'sku' };
  if (barcode && barcode !== current.barcode && isUnitCode(barcode)) return { error: UNIT_CODE_CONFLICT, field: 'barcode' };
  if (skuInput && skuInput !== current.sku && isUnitCode(skuInput)) return { error: UNIT_CODE_CONFLICT, field: 'sku' };
  if (photo !== undefined && !isPhotoName(photo)) return { error: 'Photo invalide.', field: 'photo' };

  const wasSerialized = current.serialized === true;
  const serialized = patch.serialized ?? wasSerialized;
  if (serialized && !wasSerialized && current.qty !== 0) {
    return {
      error: `Mettez le stock à 0 avant d'activer le suivi par numéro de série (stock actuel : ${current.qty}). Les appareils seront ensuite ajoutés un par un avec leur numéro de série.`,
      field: 'serialized',
    };
  }
  if (!serialized && wasSerialized) {
    const n = state().units.filter((u) => u.itemId === id).length;
    if (n > 0) {
      return {
        error: `Supprimez d'abord les ${n} numéro(s) de série de cet article avant de désactiver le suivi par numéro de série.`,
        field: 'serialized',
      };
    }
  }

  // SKU vidé : nouvelle référence, comme à la création.
  const sku = skuInput || nextSku(barcode);

  const { barcode: _oldBarcode, photo: _oldPhoto, serialized: _oldSerialized, ...base } = current;
  const updated: Item = {
    ...base,
    name,
    sku,
    ...(barcode ? { barcode } : {}),
    folder,
    min,
    price,
    ...(photo !== undefined ? { photo } : {}),
    ...(serialized ? { serialized: true } : {}),
  };
  replaceItem(updated);
  // Changement de mode de suivi : la saisie de comptage en cours de l'article
  // (quantité ↔ numéros de série) n'a plus de sens ; il redevient « À compter ».
  let sessionsChanged = false;
  if (serialized !== wasSerialized) {
    const st = state();
    const sessions: Record<string, CountSession> = {};
    for (const [sid, session] of Object.entries(st.sessions)) {
      if (session.completedAt === undefined && session.entries[id] !== undefined) {
        const { [id]: _entry, ...entries } = session.entries;
        sessions[sid] = { ...session, entries };
        sessionsChanged = true;
      } else {
        sessions[sid] = session;
      }
    }
    st.sessions = sessions;
  }
  // L'ancienne photo n'est supprimée qu'une fois l'article enregistré : en cas
  // d'échec d'écriture, l'article stocké la référence encore.
  const saved = sessionsChanged ? persist('items', 'sessions') : persist('items');
  if (saved && current.photo !== undefined && current.photo !== photo) removePhotoFile(current.photo);
  return { item: updated };
}

/**
 * Supprime un article avec ses unités (numéros de série), ses mouvements, ses
 * saisies dans les comptages (et son stock attendu dans les comptages
 * terminés), un éventuel scan de comptage en attente pointant vers lui ou
 * l'une de ses unités, et sa photo.
 */
export function deleteItem(id: string): DeleteItemResult {
  if (refuseUntrusted()) return { ok: false, error: SAVE_ERROR };
  const item = getItem(id);
  if (!item) return { ok: false, error: 'Article introuvable.' };
  const s = state();

  // Position de l'article dans chaque comptage, avant suppression.
  const positions = new Map<string, { pos: number; len: number }>();
  for (const sid of Object.keys(s.sessions)) {
    const list = getCountItems(sid);
    positions.set(sid, { pos: list.findIndex((i) => i.id === id), len: list.length });
  }

  const itemUnits = s.units.filter((u) => u.itemId === id);
  s.items = s.items.filter((i) => i.id !== id);
  s.units = s.units.filter((u) => u.itemId !== id);
  s.movements = s.movements.filter((m) => m.itemId !== id);

  const sessions: Record<string, CountSession> = {};
  for (const [sid, session] of Object.entries(s.sessions)) {
    const { [id]: _entry, ...entries } = session.entries;
    const next: CountSession = { ...session, entries };
    if (session.expected) {
      const { [id]: _expected, ...expected } = session.expected;
      next.expected = expected;
    }
    if (session.expectedUnits) {
      const { [id]: _expectedUnits, ...expectedUnits } = session.expectedUnits;
      next.expectedUnits = expectedUnits;
    }
    if (session.unitSnapshot) {
      next.unitSnapshot = Object.fromEntries(Object.entries(session.unitSnapshot).filter(([, u]) => u.itemId !== id));
    }
    if (session.completedAt === undefined) {
      // Comptage en cours : l'index reste sur le même article, dans les bornes.
      const { pos, len } = positions.get(sid) ?? { pos: -1, len: 0 };
      const newLen = pos >= 0 ? len - 1 : len;
      const idx = pos >= 0 && pos < session.idx ? session.idx - 1 : session.idx;
      next.idx = Math.min(Math.max(0, idx), Math.max(0, newLen - 1));
    }
    sessions[sid] = next;
  }
  s.sessions = sessions;

  const codes = new Set([codeKey(item.sku), ...(item.barcode !== undefined ? [codeKey(item.barcode)] : [])]);
  const unitIds = new Set(itemUnits.map((u) => u.id));
  for (const [countId, code] of _pendingCountScans) {
    const unit = findUnitIn(itemUnits, code);
    if (codes.has(codeKey(code)) || (unit && unitIds.has(unit.id))) _pendingCountScans.delete(countId);
  }

  if (persist('items', 'units', 'movements', 'sessions')) removePhotoFile(item.photo);
  return { ok: true };
}

// ── Mouvements ─────────────────────────────────────────────────────────────

const SERIALIZED_MOVEMENT_ERROR =
  'Cet article est suivi par numéro de série : scannez le numéro de série (ou l\'IMEI) de chaque appareil au lieu de saisir une quantité.';
const SERIALIZED_ADJUST_ERROR =
  'Cet article est suivi par numéro de série : son stock est calculé à partir des appareils « En stock ». Ajoutez ou modifiez les numéros de série au lieu d\'ajuster la quantité.';

/** Mouvements du plus récent au plus ancien (500 au maximum). */
export function getMovements(): Movement[] {
  return state().movements;
}

/** Enregistre un mouvement Entrée/Sortie. Renvoie un message d'erreur ou null. */
export function commitMovement(code: string, mode: MovementMode, qty: number): string | null {
  if (refuseUntrusted()) return SAVE_ERROR;
  const item = findItemByCode(code);
  if (!item) return findUnitByCode(code) ? SERIALIZED_MOVEMENT_ERROR : 'Article introuvable.';
  if (item.serialized) return SERIALIZED_MOVEMENT_ERROR;
  if (!Number.isInteger(qty) || qty <= 0) return 'La quantité doit être un entier supérieur à 0.';
  if (mode === 'Sortie' && qty > item.qty) {
    return `Stock insuffisant. Disponible : ${item.qty} unité(s).`;
  }

  const updated: Item = { ...item, qty: mode === 'Entrée' ? item.qty + qty : item.qty - qty };
  replaceItem(updated);
  pushMovement(updated, mode, qty);
  persist('items', 'movements');
  return null;
}

/** Ajuste le stock depuis la fiche article. Renvoie un message d'erreur ou null. */
export function adjustStock(itemId: string, newQty: number): string | null {
  if (refuseUntrusted()) return SAVE_ERROR;
  const item = getItem(itemId);
  if (!item) return 'Article introuvable.';
  if (item.serialized) return SERIALIZED_ADJUST_ERROR;
  if (!Number.isInteger(newQty) || newQty < 0) return 'La quantité doit être un entier positif ou nul.';

  const diff = newQty - item.qty;
  if (diff === 0) return null;

  const updated: Item = { ...item, qty: newQty };
  replaceItem(updated);
  pushMovement(updated, diff > 0 ? 'Entrée' : 'Sortie', Math.abs(diff));
  persist('items', 'movements');
  return null;
}

// ── Unités (numéros de série) ──────────────────────────────────────────────

/** Unités, par ordre de réception ; filtrées sur un article si `itemId` est fourni. */
export function getUnits(itemId?: string): Unit[] {
  const units = state().units;
  return itemId === undefined ? units : units.filter((u) => u.itemId === itemId);
}

export function getUnit(id: string): Unit | undefined {
  return state().units.find((u) => u.id === id);
}

/** Recherche par numéro de série (`serialKey`) puis par IMEI (espaces et tirets ignorés). */
function findUnitIn(units: readonly Unit[], code: string): Unit | undefined {
  const k = serialKey(code);
  if (!k) return undefined;
  const bySerial = units.find((u) => serialKey(u.serial) === k);
  if (bySerial) return bySerial;
  const d = imeiDigits(code.trim());
  return /^\d{15}$/.test(d) ? units.find((u) => u.imei === d) : undefined;
}

/** Unité dont le numéro de série ou l'IMEI correspond à `code`. */
export function findUnitByCode(code: string): Unit | undefined {
  return findUnitIn(state().units, code);
}

/**
 * Résout un code scanné : article (code-barres ou SKU) ou unité (numéro de
 * série ou IMEI, avec son article). `null` si le code est inconnu.
 */
export function findByCode(code: string): CodeMatch | null {
  const item = findItemByCode(code);
  if (item) return { kind: 'item', item };
  const unit = findUnitByCode(code);
  const unitItem = unit ? getItem(unit.itemId) : undefined;
  return unit && unitItem ? { kind: 'unit', unit, item: unitItem } : null;
}

type UnitFields = Pick<Unit, 'serial' | 'imei' | 'status' | 'assignee' | 'note'>;
type UnitDraft = { serial: string; imei?: string; status: UnitStatus; assignee?: string; note?: string };

const itemLabel = (itemId: string) => {
  const name = getItem(itemId)?.name;
  return name ? ` (article « ${name} »)` : '';
};

/** Valide une unité (hors unité `exceptId`). */
function validateUnit(d: UnitDraft, exceptId?: string): { fields: UnitFields } | { error: string; field: UnitField } {
  const others = state().units.filter((u) => u.id !== exceptId);

  const sr = normalizeSerial(d.serial);
  if (sr.error !== undefined) return { error: sr.error, field: 'serial' };
  const serial = sr.serial;
  const sk = serialKey(serial);
  // Un numéro de série qui, tirets retirés, est l'IMEI d'un autre appareil
  // rendrait le scan ambigu (l'IMEI est aussi recherché sans tirets).
  const sd = imeiDigits(sk);
  const dupSerial = others.find((u) => serialKey(u.serial) === sk || u.imei === sd);
  if (dupSerial) return { error: `Ce numéro de série est déjà enregistré${itemLabel(dupSerial.itemId)}.`, field: 'serial' };
  if (isItemCode(serial)) return { error: "Ce numéro de série est déjà utilisé comme code-barres ou SKU d'un article.", field: 'serial' };
  // Le numéro de série est l'identifiant de l'import Jira Assets : il doit y
  // arriver tel quel, sans la neutralisation des formules (`'` ajoutée devant
  // = + @). Un numéro déjà enregistré ainsi reste modifiable.
  const currentSerial = exceptId !== undefined ? state().units.find((u) => u.id === exceptId)?.serial : undefined;
  if (/^[=+@]/.test(serial) && serial !== currentSerial) {
    return { error: 'Le numéro de série ne peut pas commencer par =, + ou @.', field: 'serial' };
  }

  let imei: string | undefined;
  const rawImei = d.imei?.trim() ?? '';
  if (rawImei) {
    const ir = normalizeImei(rawImei);
    if (ir.error !== undefined) return { error: ir.error, field: 'imei' };
    imei = ir.imei;
    const dupImei = others.find((u) => u.imei === imei || imeiDigits(serialKey(u.serial)) === imei);
    if (dupImei) return { error: `Cet IMEI est déjà enregistré${itemLabel(dupImei.itemId)}.`, field: 'imei' };
    if (isItemImei(imei)) return { error: "Cet IMEI est déjà utilisé comme code-barres ou SKU d'un article.", field: 'imei' };
  }

  if (!isUnitStatus(d.status)) return { error: 'Statut invalide.', field: 'status' };

  const assignee = d.assignee?.trim() ?? '';
  if (d.status === 'assigned' && !assignee) return { error: "Indiquez à qui l'appareil est attribué.", field: 'assignee' };
  if (assignee.length > ASSIGNEE_MAX_LENGTH) {
    return { error: `Le nom de l'attributaire ne doit pas dépasser ${ASSIGNEE_MAX_LENGTH} caractères.`, field: 'assignee' };
  }
  const note = d.note?.trim() ?? '';
  if (note.length > NOTE_MAX_LENGTH) return { error: `La note ne doit pas dépasser ${NOTE_MAX_LENGTH} caractères.`, field: 'note' };

  return {
    fields: {
      serial,
      ...(imei !== undefined ? { imei } : {}),
      status: d.status,
      // L'attributaire n'a de sens que pour un appareil attribué.
      ...(d.status === 'assigned' ? { assignee } : {}),
      ...(note ? { note } : {}),
    },
  };
}

/**
 * Remplace une unité et trace le passage de la frontière « En stock » :
 * sortie du stock = Sortie de 1, entrée dans le stock = Entrée de 1.
 * Le stock dérivé de l'article est recalculé. N'écrit rien.
 */
function applyUnit(prev: Unit, next: Unit): boolean {
  const s = state();
  s.units = s.units.map((u) => (u.id === prev.id ? next : u));
  const item = getItem(next.itemId);
  const moved = (prev.status === 'in_stock') !== (next.status === 'in_stock');
  if (item && moved) pushMovement(item, next.status === 'in_stock' ? 'Entrée' : 'Sortie', 1, next);
  syncDerivedQty(next.itemId);
  return moved;
}

/**
 * Ajoute un appareil (numéro de série) à un article suivi par numéro de
 * série. Un appareil « En stock » enregistre une Entrée de 1.
 */
export function addUnit(itemId: string, input: NewUnitInput): UnitResult {
  const item = getItem(itemId);
  if (!item) return { error: 'Article introuvable.', field: 'itemId' };
  if (!item.serialized) {
    return { error: "Cet article n'est pas suivi par numéro de série. Activez d'abord le suivi dans la fiche de l'article.", field: 'itemId' };
  }
  const v = validateUnit({ ...input, status: input.status ?? 'in_stock' });
  if ('error' in v) return v;

  const now = Date.now();
  const unit: Unit = { id: uid('u'), itemId, ...v.fields, receivedAt: now, updatedAt: now };
  const snap = snapshot();
  const s = state();
  s.units = [...s.units, unit];
  if (unit.status === 'in_stock') pushMovement(item, 'Entrée', 1, unit);
  syncDerivedQty(itemId);
  const err = commit(snap, 'items', 'units', 'movements');
  if (err) return { error: err };
  return { unit };
}

/**
 * Modifie un appareil (mêmes règles que `addUnit`, hors lui-même). Un
 * changement de statut qui fait sortir l'appareil du stock enregistre une
 * Sortie de 1 ; un retour en stock, une Entrée de 1.
 */
export function updateUnit(id: string, patch: UpdateUnitPatch): UnitResult {
  const current = getUnit(id);
  if (!current) return { error: 'Numéro de série introuvable.', field: 'id' };
  const status = patch.status ?? current.status;
  const v = validateUnit(
    {
      serial: patch.serial ?? current.serial,
      imei: patch.imei ?? current.imei,
      status,
      // Passage à « Attribué » sans attributaire fourni : on reprend l'éventuel attributaire actuel.
      assignee: patch.assignee ?? current.assignee,
      note: patch.note ?? current.note,
    },
    id
  );
  if ('error' in v) return v;

  const { imei: _i, assignee: _a, note: _n, ...base } = current;
  const unit: Unit = { ...base, ...v.fields, updatedAt: Date.now() };
  const snap = snapshot();
  applyUnit(current, unit);
  const err = commit(snap, 'items', 'units', 'movements');
  if (err) return { error: err };
  return { unit };
}

/**
 * Supprime un appareil. Choix : s'il était « En stock », une Sortie de 1 est
 * enregistrée (le stock dérivé baisse, le changement reste tracé) ; sinon
 * aucun mouvement. Il est retiré des comptages en cours (quantité trouvée
 * recalculée) ; les comptages terminés gardent leur instantané.
 */
export function deleteUnit(id: string): DeleteUnitResult {
  const unit = getUnit(id);
  if (!unit) return { ok: false, error: 'Numéro de série introuvable.' };
  const snap = snapshot();
  const s = state();
  s.units = s.units.filter((u) => u.id !== id);
  const item = getItem(unit.itemId);
  if (item && unit.status === 'in_stock') pushMovement(item, 'Sortie', 1, unit);
  syncDerivedQty(unit.itemId);

  const sessions: Record<string, CountSession> = {};
  for (const [sid, session] of Object.entries(s.sessions)) {
    const e = session.entries[unit.itemId];
    if (session.completedAt === undefined && e?.serials?.includes(id)) {
      const serials = e.serials.filter((x) => x !== id);
      sessions[sid] = { ...session, entries: { ...session.entries, [unit.itemId]: { ...e, serials, qty: serials.length } } };
    } else {
      sessions[sid] = session;
    }
  }
  s.sessions = sessions;
  const err = commit(snap, 'items', 'units', 'movements', 'sessions');
  if (err) return { ok: false, error: err };
  for (const [countId, code] of _pendingCountScans) {
    if (findUnitIn([unit], code)) _pendingCountScans.delete(countId);
  }
  return { ok: true };
}

// ── Comptage cyclique ──────────────────────────────────────────────────────

/**
 * Articles inclus dans le comptage : tout l'inventaire, dans l'ordre de la
 * liste (source unique pour l'écran, la progression et l'export). Un comptage
 * terminé reste limité aux articles figés dans `session.expected` : les
 * articles créés après la clôture n'y sont pas ajoutés.
 */
export function getCountItems(id: string = CYCLE_COUNT.id): Item[] {
  if (id !== CYCLE_COUNT.id) return [];
  const s = state();
  const session = s.sessions[id];
  const expected = session?.completedAt !== undefined ? session.expected : undefined;
  if (expected) return s.items.filter((i) => expected[i.id] !== undefined);
  return s.items.slice();
}

function freshSession(id: string): CountSession {
  return { id, entries: {}, idx: 0, startedAt: Date.now() };
}

/** Session enregistrée, ou une session vierge (non enregistrée) si aucune. */
export function getCountSession(id: string): CountSession | undefined {
  if (id !== CYCLE_COUNT.id) return undefined;
  const s = state().sessions[id];
  if (!s) return freshSession(id);
  return {
    ...s,
    entries: { ...s.entries },
    ...(s.expected ? { expected: { ...s.expected } } : {}),
    ...(s.expectedUnits ? { expectedUnits: { ...s.expectedUnits } } : {}),
    ...(s.unitSnapshot ? { unitSnapshot: { ...s.unitSnapshot } } : {}),
  };
}

/** Vrai si une session est enregistrée (comptage démarré). */
export function hasCountSession(id: string): boolean {
  return id === CYCLE_COUNT.id && state().sessions[id] !== undefined;
}

export function getCycleCount(): CycleCountInfo {
  const { id, name, folder, due, blind } = CYCLE_COUNT;
  const list = getCountItems(id);
  const session = state().sessions[id];
  // Seules les entrées des articles existants comptent (une session peut
  // référencer des articles qui n'existent plus).
  const done = session ? list.filter((i) => session.entries[i.id] !== undefined).length : 0;
  const total = list.length;
  return {
    id, name, folder, due, blind,
    total,
    done,
    progress: total > 0 ? Math.min(1, done / total) : 0,
    ...(session?.completedAt !== undefined ? { completedAt: session.completedAt } : {}),
  };
}

function writableSession(id: string): CountSession | string {
  if (id !== CYCLE_COUNT.id) return 'Comptage introuvable.';
  const s = state();
  const session = s.sessions[id] ?? freshSession(id);
  if (session.completedAt !== undefined) return 'Ce comptage est terminé.';
  s.sessions = { ...s.sessions, [id]: session };
  return session;
}

/**
 * Enregistre le résultat d'un article. Renvoie un message d'erreur ou null.
 * Article suivi par numéro de série : `entry.serials` liste les identifiants
 * des unités trouvées (absent = aucune) et `qty` est ignoré (= leur nombre).
 */
export function saveCountEntry(id: string, itemId: string, entry: CountEntry): string | null {
  if (refuseUntrusted()) return SAVE_ERROR;
  if (id !== CYCLE_COUNT.id) return 'Comptage introuvable.';
  const list = getCountItems(id);
  if (list.length === 0) return 'Aucun article à compter. Ajoutez des articles à l\'inventaire.';
  const item = list.find((i) => i.id === itemId);
  if (!item) return 'Article hors comptage.';
  if (!isCountStatus(entry.status)) return 'Statut invalide.';
  let next: CountEntry;
  if (item.serialized) {
    const serials = [...new Set(Array.isArray(entry.serials) ? entry.serials : [])];
    for (const uidFound of serials) {
      const u = getUnit(uidFound);
      if (!u) return 'Numéro de série introuvable.';
      if (u.itemId !== itemId) return 'Ce numéro de série appartient à un autre article.';
    }
    next = { qty: serials.length, status: entry.status, serials };
  } else {
    if (!Number.isInteger(entry.qty) || entry.qty < 0) return 'La quantité ne peut pas être négative.';
    next = { qty: entry.qty, status: entry.status };
  }
  const session = writableSession(id);
  if (typeof session === 'string') return session;
  session.entries = { ...session.entries, [itemId]: next };
  persist('sessions');
  return null;
}

/**
 * Scan d'un numéro de série (ou IMEI) pendant le comptage : l'unité est
 * ajoutée aux unités trouvées de son article, qui passe « Compté ». Un
 * second scan de la même unité ne change rien (`duplicate: true`).
 */
export function markUnitFound(countId: string, code: string): MarkUnitFoundResult {
  if (countId !== CYCLE_COUNT.id) return { ok: false, error: 'Comptage introuvable.' };
  const unit = findUnitByCode(code);
  if (!unit) return { ok: false, error: `Numéro de série inconnu : ${code.trim()}` };
  const item = getCountItems(countId).find((i) => i.id === unit.itemId);
  if (!item) return { ok: false, error: `Article hors comptage : ${getItem(unit.itemId)?.name ?? unit.serial}` };
  if (!item.serialized) return { ok: false, error: "Cet article n'est pas suivi par numéro de série." };
  const snap = snapshot();
  const session = writableSession(countId);
  if (typeof session === 'string') return { ok: false, error: session };

  const prev = session.entries[item.id];
  const serials = prev?.serials ?? [];
  const duplicate = serials.includes(unit.id) && prev?.status === 'Compté';
  if (!duplicate) {
    const next = serials.includes(unit.id) ? serials : [...serials, unit.id];
    session.entries = { ...session.entries, [item.id]: { qty: next.length, status: 'Compté', serials: next } };
    const err = commit(snap, 'sessions');
    if (err) return { ok: false, error: err };
  }
  return { ok: true, itemId: item.id, unitId: unit.id, duplicate };
}

/** Retire une unité des unités trouvées (scan par erreur). Renvoie un message d'erreur ou null. */
export function unmarkUnitFound(countId: string, unitId: string): string | null {
  if (countId !== CYCLE_COUNT.id) return 'Comptage introuvable.';
  const unit = getUnit(unitId);
  if (!unit) return 'Numéro de série introuvable.';
  const snap = snapshot();
  const session = writableSession(countId);
  if (typeof session === 'string') return session;
  const prev = session.entries[unit.itemId];
  if (!prev?.serials?.includes(unitId)) return null;
  const serials = prev.serials.filter((x) => x !== unitId);
  session.entries = { ...session.entries, [unit.itemId]: { ...prev, serials, qty: serials.length } };
  return commit(snap, 'sessions');
}

/**
 * Écarts par article suivi par numéro de série, dans l'ordre du comptage
 * (voir `CountDiscrepancy`). Comptage terminé : les unités attendues sont
 * celles figées à la clôture (`expectedUnits`) ; un article sans instantané
 * (suivi en quantité à la clôture) n'apparaît pas.
 */
export function getCountDiscrepancies(countId: string = CYCLE_COUNT.id): CountDiscrepancy[] {
  if (countId !== CYCLE_COUNT.id) return [];
  const s = state();
  const session = s.sessions[countId];
  const completed = session?.completedAt !== undefined;
  const byId = new Map(s.units.map((u) => [u.id, u]));
  // Comptage terminé : un appareil supprimé depuis la clôture est repris de l'instantané.
  const snapshot = completed ? session?.unitSnapshot : undefined;
  const resolve = (ids: readonly string[]) =>
    ids.map((x) => byId.get(x) ?? snapshot?.[x]).filter((u): u is Unit => u !== undefined);
  const out: CountDiscrepancy[] = [];
  for (const item of getCountItems(countId)) {
    let expectedIds: string[];
    if (completed) {
      const snap = session?.expectedUnits?.[item.id];
      if (snap === undefined) continue;
      expectedIds = snap;
    } else {
      if (!item.serialized) continue;
      expectedIds = s.units.filter((u) => u.itemId === item.id && u.status === 'in_stock').map((u) => u.id);
    }
    const e = session?.entries[item.id];
    const counted = e?.status === 'Compté';
    const foundIds = e?.serials ?? [];
    const foundSet = new Set(foundIds);
    const expectedSet = new Set(expectedIds);
    const expected = resolve(expectedIds);
    const found = resolve(foundIds);
    out.push({
      itemId: item.id,
      counted,
      expected,
      found,
      missing: counted ? expected.filter((u) => !foundSet.has(u.id)) : [],
      unexpected: found.filter((u) => !expectedSet.has(u.id)),
    });
  }
  return out;
}

export function setCountIndex(id: string, idx: number): void {
  if (refuseUntrusted()) return;
  const len = getCountItems(id).length;
  if (len === 0 || !Number.isFinite(idx)) return;
  const session = writableSession(id);
  if (typeof session === 'string') return;
  session.idx = Math.min(Math.max(0, Math.floor(idx)), len - 1);
  persist('sessions');
}

/**
 * Clôture le comptage. Le stock de chaque article est d'abord mémorisé dans
 * `session.expected` (stock attendu de l'export CSV) et, pour les articles
 * suivis par numéro de série, la liste des unités « En stock » dans
 * `session.expectedUnits`. Si `applyAdjustments`, pour chaque article « Compté » :
 * - suivi en quantité : le stock est ajusté s'il diffère, avec un mouvement ;
 * - suivi par numéro de série : chaque unité attendue non trouvée passe
 *   « Manquant » (Sortie de 1) et chaque unité trouvée qui n'était pas
 *   « En stock » y revient (Entrée de 1, attributaire retiré) ; le stock
 *   dérivé est recalculé.
 */
export function completeCount(id: string, applyAdjustments: boolean): CompleteCountResult {
  if (id !== CYCLE_COUNT.id) return { ok: false, error: 'Comptage introuvable.' };
  if (getCountItems(id).length === 0) {
    return { ok: false, error: 'Aucun article à compter. Ajoutez des articles avant de terminer le comptage.' };
  }
  const snap = snapshot();
  const session = writableSession(id);
  if (typeof session === 'string') return { ok: false, error: session };

  const s = state();
  const expected: Record<string, number> = {};
  const expectedUnits: Record<string, string[]> = {};
  for (const item of getCountItems(id)) {
    expected[item.id] = item.qty;
    if (item.serialized) {
      expectedUnits[item.id] = s.units.filter((u) => u.itemId === item.id && u.status === 'in_stock').map((u) => u.id);
    }
  }
  session.expected = expected;
  if (Object.keys(expectedUnits).length > 0) session.expectedUnits = expectedUnits;
  else delete session.expectedUnits;

  let adjusted = 0;
  let unitsUpdated = 0;
  if (applyAdjustments) {
    for (const item of getCountItems(id)) {
      const e = session.entries[item.id];
      if (!e || e.status !== 'Compté') continue;
      if (item.serialized) {
        const found = new Set(e.serials ?? []);
        const exp = new Set(expectedUnits[item.id] ?? []);
        const now = Date.now();
        let changed = false;
        for (const unit of s.units.filter((u) => u.itemId === item.id)) {
          let status: UnitStatus | null = null;
          if (unit.status === 'in_stock' && exp.has(unit.id) && !found.has(unit.id)) status = 'missing';
          else if (unit.status !== 'in_stock' && found.has(unit.id)) status = 'in_stock';
          if (!status) continue;
          const { assignee: _a, ...rest } = unit;
          applyUnit(unit, { ...rest, status, updatedAt: now });
          unitsUpdated++;
          changed = true;
        }
        if (changed) adjusted++;
        continue;
      }
      if (e.qty === item.qty) continue;
      const diff = e.qty - item.qty;
      const updated: Item = { ...item, qty: e.qty };
      replaceItem(updated);
      pushMovement(updated, diff > 0 ? 'Entrée' : 'Sortie', Math.abs(diff));
      adjusted++;
    }
  }
  // Instantané des unités attendues et trouvées (état après ajustement).
  const snapIds = new Set<string>();
  for (const ids of Object.values(expectedUnits)) ids.forEach((x) => snapIds.add(x));
  for (const item of getCountItems(id)) {
    if (item.serialized) session.entries[item.id]?.serials?.forEach((x) => snapIds.add(x));
  }
  const unitSnapshot: Record<string, Unit> = {};
  for (const u of s.units) if (snapIds.has(u.id)) unitSnapshot[u.id] = u;
  if (Object.keys(unitSnapshot).length > 0) session.unitSnapshot = unitSnapshot;
  else delete session.unitSnapshot;
  session.completedAt = Date.now();
  const err = commit(snap, 'items', 'units', 'movements', 'sessions');
  if (err) return { ok: false, error: err };
  return { ok: true, adjusted, unitsUpdated };
}

/** Démarre une nouvelle session (la précédente est effacée). */
export function restartCount(id: string): void {
  if (refuseUntrusted()) return;
  if (id !== CYCLE_COUNT.id) return;
  const s = state();
  s.sessions = { ...s.sessions, [id]: freshSession(id) };
  _pendingCountScans.delete(id);
  persist('sessions');
}

/** Code scanné pendant un comptage, transmis à l'écran de comptage au retour. */
export function setPendingCountScan(countId: string, code: string): void {
  _pendingCountScans.set(countId, code);
}

export function consumePendingCountScan(countId: string): string | null {
  const code = _pendingCountScans.get(countId) ?? null;
  _pendingCountScans.delete(countId);
  return code;
}

/** Champ d'un formulaire d'appareil rempli par le scanner (`/scan?pick=…`). */
export type PickTarget = 'serial' | 'imei';

/** Code lu par le scanner en mode « sélection », transmis au formulaire au retour. */
export function setPendingPick(target: PickTarget, code: string): void {
  _pendingPicks.set(target, code);
}

/** Lit et efface le code en attente pour `target` (`null` si aucun). */
export function consumePendingPick(target: PickTarget): string | null {
  const code = _pendingPicks.get(target) ?? null;
  _pendingPicks.delete(target);
  return code;
}

// ── Préférences ────────────────────────────────────────────────────────────

export function getPrefs(): Prefs {
  return { ...state().prefs };
}

export function setPrefs(partial: Partial<Prefs>): void {
  if (refuseUntrusted()) return;
  const s = state();
  s.prefs = { ...s.prefs, ...partial };
  persist('prefs');
}

// ── Stockage ───────────────────────────────────────────────────────────────

/**
 * Efface toutes les données de l'appareil (préférences et photos comprises) :
 * l'application repart vide.
 */
export function resetAllData(): void {
  removeAllPhotoFiles();
  clearAll(); // efface aussi le journal d'écriture
  // Si l'effacement a échoué, un journal peut subsister : `save` le traite
  // d'abord, puis réécrit toutes les clés.
  _journalPending = true;
  _storageInconsistent = true;
  _pendingCountScans.clear();
  _pendingPicks.clear();
  _state = blankState();
  persistAll();
}

/**
 * Remplace les articles, unités, mouvements et comptages actuels par les données
 * d'exemple de `data/mock.ts` (préférences conservées, photos supprimées).
 * Utilisé uniquement depuis Profil › Stockage local.
 */
export function loadSampleData(): string | null {
  // Mémoire non fiable : refusé sans rien modifier (ni données, ni photos).
  if (refuseUntrusted()) return SAVE_ERROR;
  const prev = state();
  _pendingCountScans.clear();
  _pendingPicks.clear();
  _state = { ...sampleState(prev.prefs), ...(prev.lastSavedAt !== undefined ? { lastSavedAt: prev.lastSavedAt } : {}) };
  // Photos supprimées seulement une fois les données d'exemple enregistrées :
  // si l'écriture échoue, le stockage garde les anciens articles et leurs
  // photos (les fichiers devenus orphelins sont nettoyés au lancement suivant).
  if (persist('items', 'units', 'movements', 'sessions')) removeAllPhotoFiles();
  return null;
}

export function getStorageInfo(): StorageInfo {
  const s = state();
  return {
    persistent: isPersistent(),
    ...(s.lastSavedAt !== undefined ? { lastSavedAt: s.lastSavedAt } : {}),
    itemCount: s.items.length,
    movementCount: s.movements.length,
    unitCount: s.units.length,
  };
}

// ── Formatage ──────────────────────────────────────────────────────────────

/** Nombre suivi du nom accordé à la française : 0 et 1 au singulier (« 0 article »). */
export function fmtCount(n: number, singular: string, plural: string): string {
  return `${n} ${Math.abs(n) <= 1 ? singular : plural}`;
}

/** Heure d'un horodatage, au format HH:MM. */
export function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

/** Date et heure courtes, ex. « 16/11 à 14:05 ». */
export function fmtDateTime(ts: number): string {
  const d = new Date(ts);
  return `${d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' })} à ${fmtTime(ts)}`;
}
