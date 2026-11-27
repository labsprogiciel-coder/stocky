/**
 * Données de l'espace organisation (Storo) sur le téléphone : sites,
 * articles, comptages ouverts, comptages locaux, file d'envoi (lignes),
 * site courant, choix de l'espace de travail. Contrat §5.3.
 *
 * Comme `data/store.ts`, l'API est synchrone : l'état est chargé une fois
 * depuis l'instance MMKV `stockly-org` (via `kv.ts`), puis chaque changement
 * est écrit immédiatement. Une écriture qui échoue laisse la mémoire telle
 * qu'avant et renvoie une erreur à l'écran. Module pur.
 */
import { ORG_KEYS, readJSON, removeKey, writeJSON } from './kv';
import {
  toOrgItem,
  toOrgSite,
  toOrgTake,
  type OrgCount,
  type OrgItem,
  type OrgSite,
  type OrgTake,
  type PushCountEntry,
  type PushMovement,
} from './mapping';

export type Workspace = 'standalone' | 'org';

/** Ligne de la file d'envoi (§7.3). */
export type OutboxRecord = {
  clientId: string;
  orgId: string;
  kind: 'count' | 'movement';
  body: PushCountEntry | PushMovement;
  createdAt: number;
  attempts: number;
  nextAttemptAt: number;
  state: 'pending' | 'error';
  error?: { code: string; reason?: string; message: string; details?: Record<string, unknown>; at: number };
  label: { itemName: string; sku: string; siteName?: string; takeRef?: string; mode?: 'Entrée' | 'Sortie'; qty: number };
  /** Comptage : identifiants locaux (pour remplacer / abandonner la saisie). */
  ref?: { takeId: string; itemId: string; rev: number };
};

export type SyncMeta = {
  /** Organisation à laquelle appartiennent les données (`data.*`, comptages, curseur). */
  orgId: string | null;
  cursor: string | null;
  lastPullAt: number | null;
  lastPushAt: number | null;
  lastOkAt: number | null;
  lastError?: { code: string; message: string; requestId?: string; at: number };
  backoffStep: number;
  nextTryAt: number;
  /** Fin d'un `Retry-After` (429 / 503) : respecté même au retour du réseau ou au premier plan. */
  retryAfterUntil?: number;
  serverOffsetMs: number;
  /** Lecture refusée par l'organisation (`details.permission`) jusqu'à la prochaine lecture réussie. */
  deniedPermission?: string;
};

const BLANK_SYNC: SyncMeta = {
  orgId: null, cursor: null, lastPullAt: null, lastPushAt: null, lastOkAt: null, backoffStep: 0, nextTryAt: 0, serverOffsetMs: 0,
};

type State = {
  sites: OrgSite[];
  items: Record<string, OrgItem>;
  takes: Record<string, OrgTake>;
  counts: Record<string, OrgCount>;
  outbox: OutboxRecord[];
  siteId: string | null;
  workspace: Workspace;
  sync: SyncMeta;
};

type Part = keyof State;

const PART_KEYS: Record<Part, string> = {
  sites: ORG_KEYS.sites,
  items: ORG_KEYS.items,
  takes: ORG_KEYS.takes,
  counts: ORG_KEYS.counts,
  outbox: ORG_KEYS.outbox,
  siteId: ORG_KEYS.siteId,
  workspace: ORG_KEYS.workspace,
  sync: ORG_KEYS.sync,
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export const SAVE_ERROR = "Enregistrement impossible sur ce téléphone. Réessayez ; si le problème persiste, redémarrez l'application.";

let _s: State | null = null;

/**
 * Journal des écritures en plusieurs clés qui touchent la file d'envoi
 * (file + comptages + articles) : l'état complet est écrit d'abord sous une
 * seule clé, puis chaque partie, puis le journal est effacé. Au chargement,
 * un journal resté (arrêt de l'application entre deux écritures) est rejoué :
 * file et comptages ne divergent jamais (même révision réutilisée sinon).
 */
type Journal = { parts: Partial<Record<Part, unknown>> };

/**
 * Parties d'un journal resté sur le disque (effacement ou rejeu impossible) :
 * avant toute autre écriture, ces parties sont réécrites depuis la mémoire
 * puis le journal effacé ; sinon rien n'est écrit (une écriture derrière un
 * vieux journal serait écrasée par son rejeu au prochain démarrage).
 */
let _txnParts: Part[] | null = null;

/** Rejoue un journal resté ; renvoie ses parties (état voulu, à garder en mémoire). */
function replayJournal(): Journal['parts'] | null {
  const j = readJSON<Journal | null>(ORG_KEYS.txn, null, (v) => isRecord(v) && isRecord((v as Journal).parts));
  if (!j) return null;
  const parts = (Object.keys(j.parts) as Part[]).filter((p) => PART_KEYS[p]);
  let ok = true;
  for (const p of parts) {
    const v = j.parts[p];
    if (!writeJSON(PART_KEYS[p], v === null ? undefined : v)) ok = false;
  }
  // Journal gardé tant que toutes ses parties ne sont pas écrites (nouvel essai au prochain chargement).
  if (!ok || !removeKey(ORG_KEYS.txn)) {
    console.warn('[storo] Journal non finalisé : les écritures attendent.');
    _txnParts = parts;
  }
  const out: Journal['parts'] = {};
  for (const p of parts) out[p] = j.parts[p];
  return out;
}

function load(): State {
  const journal = replayJournal();
  const sync = readJSON<SyncMeta>(ORG_KEYS.sync, BLANK_SYNC, isRecord);
  const siteId = readJSON<string | null>(ORG_KEYS.siteId, null, (v) => typeof v === 'string');
  const state: State = {
    sites: readJSON<OrgSite[]>(ORG_KEYS.sites, [], Array.isArray),
    items: readJSON<Record<string, OrgItem>>(ORG_KEYS.items, {}, isRecord),
    takes: readJSON<Record<string, OrgTake>>(ORG_KEYS.takes, {}, isRecord),
    counts: readJSON<Record<string, OrgCount>>(ORG_KEYS.counts, {}, isRecord),
    outbox: readJSON<OutboxRecord[]>(ORG_KEYS.outbox, [], Array.isArray),
    siteId,
    workspace: readJSON<Workspace>(ORG_KEYS.workspace, 'standalone', (v) => v === 'org' || v === 'standalone'),
    sync: { ...BLANK_SYNC, ...sync },
  };
  // Rejeu incomplet : la mémoire suit le journal (jamais l'état mélangé du disque).
  if (journal && _txnParts) {
    Object.assign(state, journal);
    state.sync = { ...BLANK_SYNC, ...(isRecord(state.sync) ? state.sync : {}) };
  }
  return state;
}

/** Réécrit depuis la mémoire les parties d'un journal resté, puis l'efface. */
function finalizeJournal(s: State): boolean {
  if (!_txnParts) return true;
  for (const p of _txnParts) {
    if (!writeJSON(PART_KEYS[p], s[p] === null ? undefined : s[p])) return false;
  }
  if (!removeKey(ORG_KEYS.txn)) return false;
  _txnParts = null;
  return true;
}

function st(): State {
  if (!_s) _s = load();
  return _s;
}

/** Pour les tests (et après un effacement) : relit tout depuis le stockage au prochain accès. */
export function reloadOrgStore(): void {
  _s = null;
  _txnParts = null;
}

/**
 * Écrit les parties données dans l'ordre (la dernière en dernier : curseur
 * d'une page lue, comptages après la file d'envoi). En cas d'échec, les
 * parties déjà écrites sont restaurées (au mieux) et la mémoire ne change pas.
 */
function commit(next: Partial<State>, order?: readonly Part[]): boolean {
  const s = st();
  if (!finalizeJournal(s)) return false;
  const parts = (order ?? (Object.keys(next) as Part[])).filter((p) => p in next);
  const journaled = parts.length > 1 && parts.includes('outbox');
  if (journaled) {
    const j: Journal = { parts: {} };
    for (const p of parts) j.parts[p] = next[p] ?? null;
    if (!writeJSON(ORG_KEYS.txn, j)) return false;
  }
  const written: Part[] = [];
  for (const p of parts) {
    const value = next[p];
    if (!writeJSON(PART_KEYS[p], value === null ? undefined : value)) {
      let restored = true;
      for (const w of written) {
        if (!writeJSON(PART_KEYS[w], s[w] === null ? undefined : s[w])) restored = false;
      }
      if (journaled) {
        if (!restored) {
          // Retour arrière : le journal reçoit les anciennes valeurs (celles de la
          // mémoire, annoncées à l'appelant), rejouées au prochain chargement. S'il ne
          // peut pas être réécrit, le journal d'origine reste (jamais d'état mélangé).
          const back: Journal = { parts: {} };
          for (const q of parts) back.parts[q] = s[q] ?? null;
          writeJSON(ORG_KEYS.txn, back);
          _txnParts = parts;
        } else if (!removeKey(ORG_KEYS.txn)) _txnParts = parts;
      }
      return false;
    }
    written.push(p);
  }
  if (journaled && !removeKey(ORG_KEYS.txn)) _txnParts = parts;
  _s = { ...s, ...next };
  emit();
  return true;
}

// ── Notifications (hooks React, moteur de synchronisation) ─────────────────

let _version = 0;
const _listeners = new Set<() => void>();

/** Signale un changement (données, session, file, migration, état de synchronisation). */
export function emit(): void {
  _version++;
  for (const l of [..._listeners]) {
    try { l(); } catch (e) { console.warn('[storo] listener', e); }
  }
}

export function subscribe(fn: () => void): () => void {
  _listeners.add(fn);
  return () => { _listeners.delete(fn); };
}

export const getVersion = (): number => _version;

const _enqueueListeners = new Set<() => void>();
/** Une opération vient d'être ajoutée à la file d'envoi (synchronisation différée de 2 s). */
export function onEnqueue(fn: () => void): () => void {
  _enqueueListeners.add(fn);
  return () => { _enqueueListeners.delete(fn); };
}
export function notifyEnqueued(): void {
  for (const l of [..._enqueueListeners]) {
    try { l(); } catch (e) { console.warn('[storo] enqueue listener', e); }
  }
}

// ── État réseau et synchronisation en cours (mémoire seulement) ────────────

let _online: boolean | null = null;
let _syncing = false;

export const isOnline = (): boolean | null => _online;
export function setOnline(v: boolean): void {
  if (_online === v) return;
  _online = v;
  emit();
}
export const isSyncing = (): boolean => _syncing;
export function setSyncing(v: boolean): void {
  if (_syncing === v) return;
  _syncing = v;
  emit();
}

// ── Lecture ────────────────────────────────────────────────────────────────

export const getSites = (): OrgSite[] => [...st().sites].sort((a, b) => a.name.localeCompare(b.name, 'fr'));
export const getSite = (id: string | null | undefined): OrgSite | undefined => (id ? st().sites.find((x) => x.id === id) : undefined);
export const getOrgItem = (id: string): OrgItem | undefined => st().items[id];
export const getAllOrgItems = (): OrgItem[] => Object.values(st().items);
export function getSiteItems(siteId: string | null): OrgItem[] {
  return getAllOrgItems()
    .filter((i) => i.siteId === siteId)
    .sort((a, b) => a.name.localeCompare(b.name, 'fr') || (a.sku < b.sku ? -1 : 1));
}
export const getTake = (id: string): OrgTake | undefined => st().takes[id];
export function getSiteTakes(siteId: string | null): OrgTake[] {
  return Object.values(st().takes)
    .filter((t) => t.siteId === siteId)
    .sort((a, b) => (a.scheduledDate ?? '').localeCompare(b.scheduledDate ?? '') || a.reference.localeCompare(b.reference));
}
export const getCount = (takeId: string): OrgCount | undefined => st().counts[takeId];
export const getAllCounts = (): Record<string, OrgCount> => st().counts;
export const getOutboxRows = (): OutboxRecord[] => st().outbox;
export const getCurrentSiteId = (): string | null => st().siteId;
export const getWorkspaceChoice = (): Workspace => st().workspace;
export const getSyncMeta = (): SyncMeta => st().sync;

/** `true` si des données (comptages, file d'envoi, cache) d'une organisation sont présentes. */
export function hasOrgData(): boolean {
  const s = st();
  return s.outbox.length > 0 || Object.keys(s.counts).length > 0 || Object.keys(s.items).length > 0 || s.sites.length > 0;
}

/**
 * Stock affiché d'un article = stock connu de Storo + mouvements en attente
 * d'envoi (les lignes refusées sont exclues : elles n'ont pas eu lieu dans Storo).
 */
export function displayedQty(itemId: string): number {
  const s = st();
  const item = s.items[itemId];
  let qty = item?.serverQty ?? 0;
  for (const r of s.outbox) {
    if (r.kind !== 'movement' || r.state !== 'pending' || r.orgId !== s.sync.orgId) continue;
    const b = r.body as PushMovement;
    if (b.itemId === itemId) qty += b.qty;
  }
  return qty;
}

// ── Écriture ───────────────────────────────────────────────────────────────

export function setCurrentSiteId(id: string | null): boolean {
  return commit({ siteId: id });
}

export function setWorkspaceChoice(w: Workspace): boolean {
  if (st().workspace === w) return true;
  return commit({ workspace: w });
}

export function updateSyncMeta(patch: Partial<SyncMeta>): boolean {
  const next: SyncMeta = { ...st().sync, ...patch };
  for (const k of Object.keys(patch) as (keyof SyncMeta)[]) if (patch[k] === undefined) delete next[k];
  return commit({ sync: next });
}

/** Remplace la file d'envoi (et, le cas échéant, les comptages locaux et les articles) en un enregistrement. */
export function commitOutbox(outbox: OutboxRecord[], extra: { counts?: Record<string, OrgCount>; items?: Record<string, OrgItem> } = {}): boolean {
  return commit({ outbox, ...extra }, ['outbox', 'counts', 'items']);
}

export function commitCounts(counts: Record<string, OrgCount>): boolean {
  return commit({ counts });
}

/** Les données appartiennent désormais à `orgId` (première association). */
export function adoptOrg(orgId: string): boolean {
  if (st().sync.orgId === orgId) return true;
  return commit({ sync: { ...st().sync, orgId } });
}

// ── Lecture des changements (/sync/pull, §7.2) ─────────────────────────────

export type PullTable = { upserts?: unknown[]; deleted?: unknown[] };
export type PullPage = {
  serverTime?: number;
  cursor?: string;
  hasMore?: boolean;
  sites?: PullTable;
  stockTakes?: PullTable;
  items?: PullTable;
};

const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/**
 * Applique une page : une seule mise à jour en mémoire, puis les données
 * (sites, articles, comptages ouverts) et EN DERNIER le curseur. Rejouer une
 * page depuis l'ancien curseur est sans effet (remplacements par `id`).
 * `siteCleared` : le site courant a disparu (choisir un autre site).
 */
export function applyPullPage(page: PullPage, orgId: string, nowMs: number): { ok: boolean; siteCleared: boolean } {
  const s = st();
  const sites = new Map(s.sites.map((x) => [x.id, x]));
  for (const row of page.sites?.upserts ?? []) {
    const site = toOrgSite(row);
    if (site) sites.set(site.id, site);
  }
  for (const id of ids(page.sites?.deleted)) sites.delete(id);

  const items: Record<string, OrgItem> = { ...s.items };
  for (const row of page.items?.upserts ?? []) {
    const id = isRecord(row) && typeof row.id === 'string' ? row.id : null;
    const item = toOrgItem(row, id ? items[id] : undefined);
    if (item) items[item.id] = item;
  }
  for (const id of ids(page.items?.deleted)) delete items[id];

  const takes: Record<string, OrgTake> = { ...s.takes };
  for (const row of page.stockTakes?.upserts ?? []) {
    const take = toOrgTake(row);
    if (take) takes[take.id] = take;
  }
  for (const id of ids(page.stockTakes?.deleted)) {
    const prev = takes[id];
    if (!prev) continue;
    const local = s.counts[id];
    if (local && Object.keys(local.entries).length > 0) takes[id] = { ...prev, closed: true };
    else delete takes[id];
  }

  // Site courant supprimé dans Storo (un site pas encore reçu n'est pas « disparu »).
  const siteCleared = s.siteId !== null && !sites.has(s.siteId) && ids(page.sites?.deleted).includes(s.siteId);
  const sync: SyncMeta = {
    ...s.sync,
    orgId,
    cursor: typeof page.cursor === 'string' ? page.cursor : s.sync.cursor,
    lastPullAt: nowMs,
  };
  delete sync.deniedPermission;
  const next: Partial<State> = { sites: [...sites.values()], items, takes, sync };
  if (siteCleared) next.siteId = null;
  const ok = commit(next, ['sites', 'items', 'takes', 'siteId', 'sync']);
  return { ok, siteCleared: ok && siteCleared };
}

/** Curseur refusé (400) : cache et curseur effacés (ni comptages, ni file d'envoi). */
export function resetPullState(): boolean {
  const s = st();
  return commit({ sites: [], items: {}, takes: {}, sync: { ...s.sync, cursor: null, lastPullAt: null } }, ['sites', 'items', 'takes', 'sync']);
}

/**
 * Association à une autre organisation : cache, comptages, site et curseur
 * effacés ; les lignes de la file d'envoi de l'ancienne organisation restent
 * (marquées étrangères : jamais envoyées, seulement abandonnables).
 */
export function clearForOrgSwitch(newOrgId: string): boolean {
  return commit(
    { sites: [], items: {}, takes: {}, counts: {}, siteId: null, sync: { ...BLANK_SYNC, orgId: newOrgId } },
    ['sites', 'items', 'takes', 'counts', 'siteId', 'sync'],
  );
}

/** « Effacer les données Storo » : tout, sauf l'archive du stock local (gérée par `migration.ts`). */
export function clearAllOrgState(): boolean {
  return commit(
    { sites: [], items: {}, takes: {}, counts: {}, outbox: [], siteId: null, workspace: 'standalone', sync: { ...BLANK_SYNC } },
    ['outbox', 'counts', 'sites', 'items', 'takes', 'siteId', 'workspace', 'sync'],
  );
}

// ── Code lu par le scanner, transmis à l'écran appelant (mémoire seulement) ─

const _pendingScans = new Map<string, string>();

/** `target` : `pair`, `take:<takeId>` ou `move`. */
export function setPendingStoroScan(target: string, code: string): void {
  _pendingScans.set(target, code);
}

export function consumePendingStoroScan(target: string): string | null {
  const v = _pendingScans.get(target);
  _pendingScans.delete(target);
  return v ?? null;
}
