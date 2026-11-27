/**
 * File d'envoi vers Storo (contrat §7.3, §7.4) : comptages et Entrées /
 * Sorties de l'espace organisation, enregistrés hors ligne avec un
 * identifiant client, envoyés par `sync.ts`. Module pur.
 */
import {
  OUTBOX_CAP,
  PUSH_MAX_ENTRIES,
  PUSH_MAX_MOVEMENTS,
  ROW_BACKOFF_MS,
  ROW_MAX_ATTEMPTS,
  TRANSPORT_BACKOFF_MS,
} from '../../constants/storo';
import { frMessage } from './errors';
import { now } from './kv';
import {
  countClientId,
  countEntryBody,
  localUid,
  movementBody,
  movementClientId,
  type OrgCount,
  type OrgCountEntry,
  type OrgItem,
  type PushCountEntry,
  type PushMovement,
} from './mapping';
import {
  SAVE_ERROR,
  commitCounts,
  commitOutbox,
  displayedQty,
  getAllCounts,
  getAllOrgItems,
  getCount,
  getOrgItem,
  getOutboxRows,
  getSite,
  getSyncMeta,
  getTake,
  notifyEnqueued,
  type OutboxRecord,
} from './orgStore';
import { getSession, isOrgWritable } from './session';

export type { OutboxRecord } from './orgStore';

export const OUTBOX_FULL = "Trop d'opérations en attente : connectez le téléphone à Internet pour les envoyer.";
export const READONLY_ERROR = 'Espace organisation en lecture seule : aucune opération ne peut être enregistrée pour le moment.';

/** Attente de transport (réseau, 5xx, 429) pour l'étape `step` (0 = premier échec). */
export function transportBackoffMs(step: number): number {
  return TRANSPORT_BACKOFF_MS[Math.min(Math.max(step, 0), TRANSPORT_BACKOFF_MS.length - 1)];
}

/** Attente avant de renvoyer une ligne refusée avec `INTERNAL` (`attempts` ≥ 1). */
export function rowBackoffMs(attempts: number): number {
  return ROW_BACKOFF_MS[Math.min(Math.max(attempts - 1, 0), ROW_BACKOFF_MS.length - 1)];
}

function writable(): { deviceId: string; orgId: string } | string {
  const s = getSession();
  if (!s || !isOrgWritable()) return READONLY_ERROR;
  const dataOrg = getSyncMeta().orgId;
  if (dataOrg !== null && dataOrg !== s.orgId) return READONLY_ERROR;
  return { deviceId: s.deviceId, orgId: s.orgId };
}

// ── Mouvements (§8.2) ──────────────────────────────────────────────────────

/**
 * Ligne d'une Entrée / Sortie, ajoutée à `rows` (file actuelle) ; `without` :
 * ligne remplacée (« Modifier »), exclue du stock disponible. Message d'erreur sinon.
 */
function buildMovement(itemId: string, mode: 'Entrée' | 'Sortie', n: number, rows: readonly OutboxRecord[], without?: OutboxRecord): OutboxRecord | string {
  const w = writable();
  if (typeof w === 'string') return w;
  const item = getOrgItem(itemId);
  if (!item) return 'Article introuvable.';
  if (!Number.isInteger(n) || n < 1) return 'La quantité doit être un entier supérieur à 0.';
  if (mode === 'Sortie') {
    let available = displayedQty(itemId);
    if (without && without.kind === 'movement' && without.state === 'pending' && without.orgId === getSyncMeta().orgId
      && (without.body as PushMovement).itemId === itemId) available -= (without.body as PushMovement).qty;
    if (n > available) return `Stock insuffisant. Disponible : ${Math.max(0, available)}.`;
  }
  if (rows.length >= OUTBOX_CAP) return OUTBOX_FULL;
  const clientId = movementClientId(w.deviceId, localUid('m'));
  return {
    clientId,
    orgId: w.orgId,
    kind: 'movement',
    body: movementBody(clientId, itemId, mode, n),
    createdAt: now(),
    attempts: 0,
    nextAttemptAt: 0,
    state: 'pending',
    label: { itemName: item.name, sku: item.sku, ...(getSite(item.siteId)?.name ? { siteName: getSite(item.siteId)!.name } : {}), mode, qty: n },
  };
}

/** Entrée / Sortie de `n` sur un article Storo. Renvoie un message d'erreur ou null. */
export function enqueueMovement(itemId: string, mode: 'Entrée' | 'Sortie', n: number): string | null {
  const rows = getOutboxRows();
  const row = buildMovement(itemId, mode, n, rows);
  if (typeof row === 'string') return row;
  if (!commitOutbox([...rows, row])) return SAVE_ERROR;
  notifyEnqueued();
  return null;
}

// ── Comptages (§8.1) ───────────────────────────────────────────────────────

export type OrgCountStatus = 'À compter' | 'À envoyer' | 'Envoyé' | 'Refusé' | 'Passé';

// ── Lignes en cours d'envoi (mémoire seulement) ────────────────────────────

const _inFlight = new Set<string>();

/** `sync.ts` : lignes de la requête `/sync/push` en cours (`null` : fin de la requête). */
export function setInFlight(clientIds: readonly string[] | null): void {
  _inFlight.clear();
  for (const id of clientIds ?? []) _inFlight.add(id);
}

export const isInFlight = (clientId: string): boolean => _inFlight.has(clientId);

const rowsOf = (rows: readonly OutboxRecord[], takeId: string, itemId: string) =>
  rows.filter((r) => r.kind === 'count' && r.ref?.takeId === takeId && r.ref.itemId === itemId);

/** État d'un article dans un comptage Storo (liste de l'écran de comptage). */
export function countStatus(takeId: string, itemId: string): OrgCountStatus {
  const e = getCount(takeId)?.entries[itemId];
  if (!e) return 'À compter';
  if (e.status === 'Passé') return 'Passé';
  const rows = rowsOf(getOutboxRows(), takeId, itemId);
  // Ligne de la saisie courante d'abord : une ancienne révision refusée ne la masque pas.
  const orgId = getSyncMeta().orgId;
  const cur = rows.find((r) => r.ref?.rev === e.rev && r.orgId === orgId);
  if (cur) return cur.state === 'error' ? 'Refusé' : 'À envoyer';
  if (e.sentRev !== undefined && e.sentRev === e.rev) return 'Envoyé';
  const row = rows[0];
  if (row) return row.state === 'error' ? 'Refusé' : 'À envoyer';
  return 'À compter';
}

function itemOfTake(takeId: string, itemId: string): { item: OrgItem; ref: string; siteName: string } | string {
  const take = getTake(takeId);
  if (!take) return 'Comptage introuvable.';
  if (take.closed) return 'Ce comptage a été clôturé dans Storo : il ne peut plus être modifié.';
  const item = getOrgItem(itemId);
  if (!item || item.siteId !== take.siteId) return 'Article hors comptage.';
  return { item, ref: take.reference, siteName: take.siteName };
}

/** Position courante d'un comptage (aucune erreur si l'écriture échoue : simple confort). */
export function setOrgCountIndex(takeId: string, idx: number): void {
  const counts = getAllCounts();
  const prev = counts[takeId] ?? { takeId, idx: 0, startedAt: now(), entries: {} };
  if (prev.idx === idx && counts[takeId]) return;
  commitCounts({ ...counts, [takeId]: { ...prev, idx } });
}

/**
 * « Valider » (Compté, nouvelle révision, ligne en attente remplacée) ou
 * « Passer » (rien n'est envoyé, la ligne en attente est retirée).
 */
export function recordCount(takeId: string, itemId: string, qty: number, status: 'Compté' | 'Passé'): string | null {
  const w = writable();
  if (typeof w === 'string') return w;
  const t = itemOfTake(takeId, itemId);
  if (typeof t === 'string') return t;
  if (status === 'Compté' && (!Number.isInteger(qty) || qty < 0)) return 'La quantité doit être un entier positif ou nul.';

  const ts = now();
  const counts = getAllCounts();
  const count: OrgCount = counts[takeId] ?? { takeId, idx: 0, startedAt: ts, entries: {} };
  const prev = count.entries[itemId];
  const rows = getOutboxRows();
  // Une ligne en cours d'envoi n'est ni remplacée ni retirée : Storo l'enregistre
  // peut-être déjà ; la réponse la règle, et la nouvelle saisie suit comme après un envoi.
  const existing = rowsOf(rows, takeId, itemId).find((r) => !_inFlight.has(r.clientId));
  let nextRows = rows;
  let entry: OrgCountEntry;

  if (status === 'Passé') {
    if (existing?.state === 'pending') nextRows = rows.filter((r) => r !== existing);
    entry = { qty: 0, status: 'Passé', rev: prev?.rev ?? 0, capturedAt: ts, ...(prev?.sentRev !== undefined ? { sentRev: prev.sentRev, sentQty: prev.sentQty ?? 0 } : {}) };
  } else {
    // Une saisie en attente ou refusée est remplacée (nouvelle révision, nouvel identifiant).
    nextRows = existing ? rows.filter((r) => r !== existing) : rows;
    if (nextRows.length >= OUTBOX_CAP) return OUTBOX_FULL;
    // Révision jamais réutilisée (même identifiant client = autre quantité refusée par Storo).
    const known = rowsOf(rows, takeId, itemId).reduce((n, r) => Math.max(n, r.ref?.rev ?? 0), 0);
    const rev = Math.max(prev?.rev ?? 0, prev?.sentRev ?? 0, known) + 1;
    entry = { qty, status: 'Compté', rev, capturedAt: ts, ...(prev?.sentRev !== undefined ? { sentRev: prev.sentRev, sentQty: prev.sentQty ?? 0 } : {}) };
    const clientId = countClientId(w.deviceId, takeId, itemId, rev);
    const body = countEntryBody({ clientId, takeId, item: t.item, qty, capturedAt: ts, serverOffsetMs: getSyncMeta().serverOffsetMs, now: ts });
    nextRows = [...nextRows, {
      clientId,
      orgId: w.orgId,
      kind: 'count',
      body,
      createdAt: ts,
      attempts: 0,
      nextAttemptAt: 0,
      state: 'pending',
      label: { itemName: t.item.name, sku: t.item.sku, siteName: t.siteName, takeRef: t.ref, qty },
      ref: { takeId, itemId, rev },
    }];
  }
  const nextCounts = { ...counts, [takeId]: { ...count, entries: { ...count.entries, [itemId]: entry } } };
  if (!commitOutbox(nextRows, { counts: nextCounts })) return SAVE_ERROR;
  if (status === 'Compté') notifyEnqueued();
  return null;
}

// ── Lignes refusées (§7.4, écran « Opérations ») ───────────────────────────

/** « Abandonner » : ligne retirée ; un comptage revient à sa dernière saisie envoyée (ou « À compter »). */
export function discardRow(clientId: string): string | null {
  const rows = getOutboxRows();
  const row = rows.find((r) => r.clientId === clientId);
  if (!row) return null;
  const nextRows = rows.filter((r) => r !== row);
  let counts: Record<string, OrgCount> | undefined;
  if (row.kind === 'count' && row.ref) {
    const all = getAllCounts();
    const c = all[row.ref.takeId];
    const e = c?.entries[row.ref.itemId];
    if (c && e && e.rev === row.ref.rev) {
      const entries = { ...c.entries };
      if (e.sentRev !== undefined) entries[row.ref.itemId] = { qty: e.sentQty ?? 0, status: 'Compté', rev: e.sentRev, sentRev: e.sentRev, sentQty: e.sentQty ?? 0, capturedAt: e.capturedAt };
      else delete entries[row.ref.itemId];
      counts = { ...all, [row.ref.takeId]: { ...c, entries } };
    }
  }
  return commitOutbox(nextRows, counts ? { counts } : {}) ? null : SAVE_ERROR;
}

/** « Réessayer » : la ligne refusée repart telle quelle (même identifiant : rien n'a été enregistré). */
export function retryRow(clientId: string): string | null {
  const rows = getOutboxRows();
  const i = rows.findIndex((r) => r.clientId === clientId);
  if (i < 0) return null;
  const next = [...rows];
  const r = { ...rows[i], state: 'pending' as const, attempts: 0, nextAttemptAt: 0 };
  delete r.error;
  next[i] = r;
  if (!commitOutbox(next)) return SAVE_ERROR;
  notifyEnqueued();
  return null;
}

/** « Modifier » (mouvements) : la ligne est remplacée par une nouvelle (nouvel identifiant client). */
export function editMovement(clientId: string, n: number): string | null {
  const rows = getOutboxRows();
  const row = rows.find((r) => r.clientId === clientId);
  if (!row || row.kind !== 'movement') return 'Opération introuvable.';
  const body = row.body as PushMovement;
  const mode = body.type === 'reception' ? 'Entrée' : 'Sortie';
  // Remplacement en un seul enregistrement : en cas d'échec, la ligne d'origine reste.
  const base = rows.filter((r) => r !== row);
  const next = buildMovement(body.itemId, mode, n, base, row);
  if (typeof next === 'string') return next;
  if (!commitOutbox([...base, next])) return SAVE_ERROR;
  notifyEnqueued();
  return null;
}

/**
 * Lignes refusées « aucun membre attribué » remises en attente (le téléphone
 * est attribué). `before` : seulement les refus antérieurs à ce `/device/me`
 * (un refus plus récent ne repart pas en boucle sur un `/device/me` périmé).
 */
export function unparkNoAttributedMember(before = Infinity): number {
  const rows = getOutboxRows();
  let n = 0;
  const next = rows.map((r) => {
    if (r.state !== 'error' || r.error?.code !== 'FORBIDDEN' || r.error.reason !== 'no_attributed_member' || !(r.error.at < before)) return r;
    n++;
    const copy = { ...r, state: 'pending' as const, attempts: 0, nextAttemptAt: 0 };
    delete copy.error;
    return copy;
  });
  if (n > 0 && !commitOutbox(next)) return 0;
  return n;
}

// ── Envoi ──────────────────────────────────────────────────────────────────

/** Lignes à envoyer pour `orgId`, plus anciennes d'abord. */
export function sendableRows(orgId: string, nowMs: number): OutboxRecord[] {
  return getOutboxRows()
    .filter((r) => r.orgId === orgId && r.state === 'pending' && r.nextAttemptAt <= nowMs)
    .sort((a, b) => a.createdAt - b.createdAt);
}

export type PushBatch = { rows: OutboxRecord[]; countEntries: PushCountEntry[]; movements: PushMovement[] };

/** Découpe en requêtes d'au plus 200 comptages et 50 mouvements, dans l'ordre. */
export function chunkRows(rows: readonly OutboxRecord[], maxEntries = PUSH_MAX_ENTRIES, maxMovements = PUSH_MAX_MOVEMENTS): PushBatch[] {
  const out: PushBatch[] = [];
  let cur: PushBatch = { rows: [], countEntries: [], movements: [] };
  for (const r of rows) {
    const full = r.kind === 'count' ? cur.countEntries.length >= maxEntries : cur.movements.length >= maxMovements;
    if (full) {
      out.push(cur);
      cur = { rows: [], countEntries: [], movements: [] };
    }
    cur.rows.push(r);
    if (r.kind === 'count') cur.countEntries.push(r.body as PushCountEntry);
    else cur.movements.push(r.body as PushMovement);
  }
  if (cur.rows.length > 0) out.push(cur);
  return out;
}

type PushRowResult = {
  clientId?: string | null;
  status?: string;
  error?: { code?: string; message?: string; details?: Record<string, unknown> };
  movements?: { qtyAfter?: number; createdAt?: number }[];
};
export type PushResponse = { serverTime?: number; countEntries?: PushRowResult[]; movements?: PushRowResult[] };

/** `saved` : résultats enregistrés sur le téléphone (sinon rien n'a changé localement). */
export type PushApplied = { done: number; parked: number; retried: number; saved: boolean };

/**
 * Applique les résultats d'une requête (§7.4) : `created` / `duplicate`
 * retirées, `INTERNAL` réessayée plus tard (garée après 8 essais), autres
 * erreurs garées pour l'utilisateur. Les lignes remplacées ou abandonnées
 * pendant l'envoi ne sont pas recréées.
 */
export function applyPushResults(batch: PushBatch, res: PushResponse, nowMs: number): PushApplied {
  const results = new Map<string, PushRowResult>();
  const take = (list: PushRowResult[] | undefined, sent: { clientId: string }[]) => {
    (list ?? []).forEach((r, i) => {
      const id = typeof r?.clientId === 'string' ? r.clientId : sent[i]?.clientId;
      if (id) results.set(id, r);
    });
  };
  take(res.countEntries, batch.countEntries);
  take(res.movements, batch.movements);

  const out: PushApplied = { done: 0, parked: 0, retried: 0, saved: false };
  const removed = new Set<string>();
  const updated = new Map<string, OutboxRecord>();
  const items: Record<string, OrgItem> = {};
  const allCounts = getAllCounts();
  let counts: Record<string, OrgCount> | null = null;

  for (const row of batch.rows) {
    const r = results.get(row.clientId);
    if (!r) continue;
    if (r.status === 'created' || r.status === 'duplicate') {
      out.done++;
      removed.add(row.clientId);
      if (row.kind === 'movement') {
        const m = r.movements?.[0];
        const itemId = (row.body as PushMovement).itemId;
        const item = items[itemId] ?? getOrgItem(itemId);
        if (item && m && typeof m.qtyAfter === 'number' && typeof m.createdAt === 'number' && m.createdAt > item.serverQtyAt) {
          items[itemId] = { ...item, serverQty: m.qtyAfter, serverQtyAt: m.createdAt };
        }
      } else if (row.ref) {
        counts = counts ?? { ...allCounts };
        const c = counts[row.ref.takeId];
        const e = c?.entries[row.ref.itemId];
        if (c && e && (e.sentRev === undefined || e.sentRev < row.ref.rev)) {
          counts[row.ref.takeId] = { ...c, entries: { ...c.entries, [row.ref.itemId]: { ...e, sentRev: row.ref.rev, sentQty: row.label.qty } } };
        }
      }
      continue;
    }
    const code = r.error?.code ?? 'INTERNAL';
    const details = r.error?.details ?? {};
    const reason = typeof details.reason === 'string' ? details.reason : undefined;
    const attempts = row.attempts + 1;
    // INTERNAL, ou CONFLICT sans raison (« le comptage a changé pendant l'enregistrement ; réessayez ») :
    // passager, renvoyé plus tard. Les conflits avec une raison (comptage clôturé…) sont garés.
    const transient = code === 'INTERNAL' || (code === 'CONFLICT' && reason === undefined);
    if (transient && attempts < ROW_MAX_ATTEMPTS) {
      out.retried++;
      updated.set(row.clientId, { ...row, attempts, nextAttemptAt: nowMs + rowBackoffMs(attempts) });
      continue;
    }
    out.parked++;
    updated.set(row.clientId, {
      ...row,
      attempts,
      state: 'error',
      error: { code, ...(reason ? { reason } : {}), message: frMessage(code, reason, details), details, at: nowMs },
    });
  }

  const next: OutboxRecord[] = [];
  for (const row of getOutboxRows()) {
    if (removed.has(row.clientId)) continue;
    next.push(updated.get(row.clientId) ?? row);
  }
  const extra: { counts?: Record<string, OrgCount>; items?: Record<string, OrgItem> } = {};
  if (counts) extra.counts = counts;
  if (Object.keys(items).length > 0) {
    const all: Record<string, OrgItem> = {};
    for (const i of getAllOrgItems()) all[i.id] = i;
    extra.items = { ...all, ...items };
  }
  out.saved = commitOutbox(next, extra);
  return out;
}

// ── Résumé (bandeaux, écran « Opérations ») ────────────────────────────────

export type OutboxSummary = { pending: number; parked: number; foreign: number; total: number };

export function outboxSummary(orgId: string | null = getSession()?.orgId ?? null): OutboxSummary {
  const rows = getOutboxRows();
  let pending = 0;
  let parked = 0;
  let foreign = 0;
  for (const r of rows) {
    if (orgId === null || r.orgId !== orgId) foreign++;
    else if (r.state === 'error') parked++;
    else pending++;
  }
  return { pending, parked, foreign, total: rows.length };
}
