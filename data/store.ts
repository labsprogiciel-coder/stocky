/**
 * État de l'application, entièrement local (aucun serveur).
 *
 * L'API reste synchrone : l'état est chargé une seule fois depuis le stockage
 * (MMKV) au premier accès, puis chaque mutation est écrite immédiatement.
 * Au premier lancement, ou si les articles stockés sont absents, corrompus ou
 * tous invalides, l'application démarre avec un inventaire vide (préférences
 * conservées). Les données d'exemple de `data/mock.ts` ne sont chargées qu'à
 * la demande, via `loadSampleData()`.
 */
import { items as sampleItems, recent as sampleRecent } from './mock';
import { KEYS, clearAll, isPersistent, readJSON, writeJSON } from './storage';

export type Item = { id: string; name: string; sku: string; barcode?: string; folder: string; qty: number; min: number; price: number };

export type MovementMode = 'Entrée' | 'Sortie';

export type Movement = {
  id: string;
  itemId: string;
  sku: string;
  mode: MovementMode;
  qty: number;
  ts: number; // epoch ms
};

export type CountStatus = 'Compté' | 'Passé';
export type CountEntry = { qty: number; status: CountStatus };

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
};

export type NewItemInput = {
  name: string;
  barcode?: string;
  sku?: string;
  folder: string;
  qty: number;
  min: number;
  price: number;
};

export type CreateItemResult =
  | { item: Item; error?: undefined; field?: undefined }
  | { item?: undefined; error: string; field?: keyof NewItemInput };

export type CompleteCountResult =
  | { ok: true; adjusted: number }
  | { ok: false; error: string };

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
    isFiniteNumber(v.price) && v.price >= 0
  );
}

function isMovement(v: unknown): v is Movement {
  return (
    isRecord(v) &&
    isNonEmptyString(v.id) &&
    isNonEmptyString(v.itemId) &&
    typeof v.sku === 'string' &&
    isMode(v.mode) &&
    isFiniteNumber(v.qty) &&
    isFiniteNumber(v.ts)
  );
}

function isCountEntry(v: unknown): v is CountEntry {
  return isRecord(v) && isFiniteNumber(v.qty) && v.qty >= 0 && isCountStatus(v.status);
}

function toCountSession(v: unknown): CountSession | null {
  if (!isRecord(v) || !isNonEmptyString(v.id) || !isFiniteNumber(v.idx) || !isFiniteNumber(v.startedAt)) return null;
  if (!isRecord(v.entries)) return null;
  if (v.completedAt !== undefined && !isFiniteNumber(v.completedAt)) return null;
  const entries: Record<string, CountEntry> = {};
  for (const [itemId, e] of Object.entries(v.entries)) {
    if (isCountEntry(e)) entries[itemId] = { qty: e.qty, status: e.status };
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
  return {
    id: v.id,
    entries,
    idx: Math.max(0, Math.floor(v.idx)),
    startedAt: v.startedAt,
    ...(v.completedAt !== undefined ? { completedAt: v.completedAt } : {}),
    ...(expected ? { expected } : {}),
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
  movements: Movement[]; // trié du plus récent au plus ancien
  sessions: Record<string, CountSession>;
  prefs: Prefs;
  lastSavedAt?: number;
};

let _state: State | null = null;
const _pendingCountScans = new Map<string, string>();

let _seq = 0;
/** Identifiant unique, même pour plusieurs appels dans la même milliseconde. */
function uid(prefix: string): string {
  _seq = (_seq + 1) % 1_679_616; // 36^4
  return `${prefix}${Date.now().toString(36)}-${_seq.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** État vierge : aucun article, aucun mouvement, aucun comptage. */
function blankState(prefs: Prefs = DEFAULT_PREFS): State {
  return { items: [], movements: [], sessions: {}, prefs: { ...prefs } };
}

/** Jeu de données d'exemple (`data/mock.ts`), chargé uniquement à la demande. */
function sampleState(prefs: Prefs): State {
  const items = sampleItems.map((i) => ({ ...i }));
  const now = Date.now();
  const movements: Movement[] = sampleRecent.map((r, idx) => ({
    id: `seed-${r.id}`,
    itemId: r.itemId,
    sku: items.find((i) => i.id === r.itemId)?.sku ?? '',
    mode: r.label.startsWith('Entrée') ? 'Entrée' : 'Sortie',
    qty: idx === 0 ? 2 : 10,
    ts: now - (idx + 1) * 60_000,
  }));
  return { items, movements, sessions: {}, prefs: { ...prefs } };
}

function loadPrefs(): Prefs {
  const rawPrefs = readJSON<unknown>(KEYS.prefs, {});
  return {
    vibration: isRecord(rawPrefs) && typeof rawPrefs.vibration === 'boolean' ? rawPrefs.vibration : DEFAULT_PREFS.vibration,
  };
}

function loadState(): State {
  const prefs = loadPrefs();
  const rawItems = readJSON<unknown>(KEYS.items, null);
  const items = validList(rawItems, isItem);
  // Absents (premier lancement), illisibles, ou liste non vide sans aucune
  // entrée valide : on démarre avec un inventaire vide, en conservant les
  // préférences, et on l'enregistre pour qu'un relancement reste vide.
  // Une liste vide `[]` est valide (inventaire vide) et suit le chemin normal.
  const unusable = !Array.isArray(rawItems) || (rawItems.length > 0 && items.length === 0);
  if (unusable) {
    const blank = blankState(prefs);
    _state = blank;
    persist('items', 'movements', 'sessions');
    return blank;
  }

  const itemIds = new Set(items.map((i) => i.id));
  const rawMovements = readJSON<unknown>(KEYS.movements, []);
  const movements = validList(rawMovements, isMovement)
    .filter((m) => itemIds.has(m.itemId))
    .sort((a, b) => b.ts - a.ts)
    .slice(0, MAX_MOVEMENTS);
  // Entrées invalides écartées : on réécrit les listes nettoyées au chargement.
  const dirty: Part[] = [];
  if (!Array.isArray(rawItems) || items.length !== rawItems.length) dirty.push('items');
  if (!Array.isArray(rawMovements) || movements.length !== rawMovements.length) dirty.push('movements');

  const sessions: Record<string, CountSession> = {};
  const rawSessions = readJSON<unknown>(KEYS.countSessions, {});
  if (isRecord(rawSessions)) {
    for (const v of Object.values(rawSessions)) {
      const s = toCountSession(v);
      if (s) sessions[s.id] = s;
    }
  }

  const rawMeta = readJSON<unknown>(KEYS.meta, {});
  const lastSavedAt = isRecord(rawMeta) && isFiniteNumber(rawMeta.lastSavedAt) ? rawMeta.lastSavedAt : undefined;

  const loaded: State = { items, movements, sessions, prefs, lastSavedAt };
  if (dirty.length > 0) {
    _state = loaded;
    persist(...dirty);
  }
  return loaded;
}

function state(): State {
  if (!_state) _state = loadState();
  return _state;
}

// ── Écriture ───────────────────────────────────────────────────────────────

type Part = 'items' | 'movements' | 'sessions' | 'prefs';

function persist(...parts: Part[]) {
  const s = state();
  let ok = true;
  for (const p of parts) {
    if (p === 'items') ok = writeJSON(KEYS.items, s.items) && ok;
    else if (p === 'movements') ok = writeJSON(KEYS.movements, s.movements) && ok;
    else if (p === 'sessions') ok = writeJSON(KEYS.countSessions, s.sessions) && ok;
    else ok = writeJSON(KEYS.prefs, s.prefs) && ok;
  }
  // N'avancer la date du dernier enregistrement que si tout a été écrit.
  if (!ok) return;
  s.lastSavedAt = Date.now();
  writeJSON(KEYS.meta, { lastSavedAt: s.lastSavedAt });
}

function persistAll() {
  persist('items', 'movements', 'sessions', 'prefs');
}

function replaceItem(updated: Item) {
  const s = state();
  s.items = s.items.map((i) => (i.id === updated.id ? updated : i));
}

function pushMovement(item: Item, mode: MovementMode, qty: number) {
  const s = state();
  const m: Movement = { id: uid('m'), itemId: item.id, sku: item.sku, mode, qty, ts: Date.now() };
  s.movements = [m, ...s.movements].slice(0, MAX_MOVEMENTS);
}

// ── Articles ───────────────────────────────────────────────────────────────

export function getItems(): Item[] {
  return state().items;
}

export function getItem(id: string): Item | undefined {
  return state().items.find((i) => i.id === id);
}

const norm = (s: string) => s.trim().toLowerCase();

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

/** `true` si `code` est déjà utilisé comme code-barres ou SKU d'un article. */
function isCodeTaken(code: string): boolean {
  const c = codeKey(code);
  return state().items.some((i) => codeKey(i.sku) === c || (i.barcode !== undefined && codeKey(i.barcode) === c));
}

function nextSku(): string {
  let n = 1000;
  for (const i of state().items) {
    const m = /^SKU-(\d+)$/i.exec(i.sku);
    if (m) n = Math.max(n, Number(m[1]) + 1);
  }
  while (isCodeTaken(`SKU-${n}`)) n++;
  return `SKU-${n}`;
}

function nextItemId(): string {
  const ids = new Set(state().items.map((i) => i.id));
  let n = state().items.reduce((max, i) => (/^\d+$/.test(i.id) ? Math.max(max, Number(i.id)) : max), 0) + 1;
  while (ids.has(String(n))) n++;
  return String(n);
}

export function createItem(input: NewItemInput): CreateItemResult {
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

  const item: Item = {
    id: nextItemId(),
    name,
    sku: sku || nextSku(),
    ...(barcode ? { barcode } : {}),
    folder,
    qty: input.qty,
    min: input.min,
    price: input.price,
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

// ── Mouvements ─────────────────────────────────────────────────────────────

/** Mouvements du plus récent au plus ancien (500 au maximum). */
export function getMovements(): Movement[] {
  return state().movements;
}

/** Enregistre un mouvement Entrée/Sortie. Renvoie un message d'erreur ou null. */
export function commitMovement(code: string, mode: MovementMode, qty: number): string | null {
  const item = findItemByCode(code);
  if (!item) return 'Article introuvable.';
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
  const item = getItem(itemId);
  if (!item) return 'Article introuvable.';
  if (!Number.isInteger(newQty) || newQty < 0) return 'La quantité doit être un entier positif ou nul.';

  const diff = newQty - item.qty;
  if (diff === 0) return null;

  const updated: Item = { ...item, qty: newQty };
  replaceItem(updated);
  pushMovement(updated, diff > 0 ? 'Entrée' : 'Sortie', Math.abs(diff));
  persist('items', 'movements');
  return null;
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
  return { ...s, entries: { ...s.entries }, ...(s.expected ? { expected: { ...s.expected } } : {}) };
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

/** Enregistre le résultat d'un article. Renvoie un message d'erreur ou null. */
export function saveCountEntry(id: string, itemId: string, entry: CountEntry): string | null {
  if (id !== CYCLE_COUNT.id) return 'Comptage introuvable.';
  const list = getCountItems(id);
  if (list.length === 0) return 'Aucun article à compter. Ajoutez des articles à l\'inventaire.';
  if (!list.some((i) => i.id === itemId)) return 'Article hors comptage.';
  if (!Number.isInteger(entry.qty) || entry.qty < 0) return 'La quantité ne peut pas être négative.';
  if (!isCountStatus(entry.status)) return 'Statut invalide.';
  const session = writableSession(id);
  if (typeof session === 'string') return session;
  session.entries = { ...session.entries, [itemId]: { qty: entry.qty, status: entry.status } };
  persist('sessions');
  return null;
}

export function setCountIndex(id: string, idx: number): void {
  const len = getCountItems(id).length;
  if (len === 0 || !Number.isFinite(idx)) return;
  const session = writableSession(id);
  if (typeof session === 'string') return;
  session.idx = Math.min(Math.max(0, Math.floor(idx)), len - 1);
  persist('sessions');
}

/**
 * Clôture le comptage. Le stock de chaque article est d'abord mémorisé dans
 * `session.expected` (stock attendu de l'export CSV). Si `applyAdjustments`,
 * chaque article « Compté » dont la quantité diffère du stock est ajusté,
 * avec un mouvement Entrée/Sortie.
 */
export function completeCount(id: string, applyAdjustments: boolean): CompleteCountResult {
  if (id !== CYCLE_COUNT.id) return { ok: false, error: 'Comptage introuvable.' };
  if (getCountItems(id).length === 0) {
    return { ok: false, error: 'Aucun article à compter. Ajoutez des articles avant de terminer le comptage.' };
  }
  const session = writableSession(id);
  if (typeof session === 'string') return { ok: false, error: session };

  const expected: Record<string, number> = {};
  for (const item of getCountItems(id)) expected[item.id] = item.qty;
  session.expected = expected;

  let adjusted = 0;
  if (applyAdjustments) {
    for (const item of getCountItems(id)) {
      const e = session.entries[item.id];
      if (!e || e.status !== 'Compté' || e.qty === item.qty) continue;
      const diff = e.qty - item.qty;
      const updated: Item = { ...item, qty: e.qty };
      replaceItem(updated);
      pushMovement(updated, diff > 0 ? 'Entrée' : 'Sortie', Math.abs(diff));
      adjusted++;
    }
  }
  session.completedAt = Date.now();
  persist('items', 'movements', 'sessions');
  return { ok: true, adjusted };
}

/** Démarre une nouvelle session (la précédente est effacée). */
export function restartCount(id: string): void {
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

// ── Préférences ────────────────────────────────────────────────────────────

export function getPrefs(): Prefs {
  return { ...state().prefs };
}

export function setPrefs(partial: Partial<Prefs>): void {
  const s = state();
  s.prefs = { ...s.prefs, ...partial };
  persist('prefs');
}

// ── Stockage ───────────────────────────────────────────────────────────────

/**
 * Efface toutes les données de l'appareil (préférences comprises) :
 * l'application repart vide.
 */
export function resetAllData(): void {
  clearAll();
  _pendingCountScans.clear();
  _state = blankState();
  persistAll();
}

/**
 * Remplace les articles, mouvements et comptages actuels par les données
 * d'exemple de `data/mock.ts` (préférences conservées).
 * Utilisé uniquement depuis Profil › Stockage local.
 */
export function loadSampleData(): void {
  const prev = state();
  _pendingCountScans.clear();
  _state = { ...sampleState(prev.prefs), ...(prev.lastSavedAt !== undefined ? { lastSavedAt: prev.lastSavedAt } : {}) };
  persist('items', 'movements', 'sessions');
}

export function getStorageInfo(): StorageInfo {
  const s = state();
  return {
    persistent: isPersistent(),
    ...(s.lastSavedAt !== undefined ? { lastSavedAt: s.lastSavedAt } : {}),
    itemCount: s.items.length,
    movementCount: s.movements.length,
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
