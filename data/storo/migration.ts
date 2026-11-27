/**
 * Migration du stock local (espace « Mon stock ») vers Storo (contrat §3,
 * §6.5, §8.4). En deux temps : le téléphone envoie ses articles (migration
 * « en attente »), un responsable la valide dans Storo ; le téléphone lit
 * alors la correspondance article local → article Storo, passe dans l'espace
 * organisation et archive le stock local (lecture seule, jamais effacé).
 *
 * Le stock local est en lecture seule pendant l'attente (garde enregistrée
 * auprès de `data/store.ts`). Module pur.
 */
import { MAX_MIGRATION_BYTES, MAX_MIGRATION_ITEMS, MIGRATION_TIMEOUT_MS } from '../../constants/storo';
import { getItems, isProActive, setStandaloneGuard, type Item } from '../store';
import { apiRequest, type ApiError } from './client';
import { errorMessage } from './errors';
import { ORG_KEYS, now, platform, readJSON, removeKey, writeJSON } from './kv';
import { buildMigrationPayload, localUid, utf8Length } from './mapping';
import { SAVE_ERROR, emit, setCurrentSiteId, setWorkspaceChoice } from './orgStore';
import { applyApiError, clearMePendingMigration, getMe, getSession, getSessionState, getToken, isOrgWritable } from './session';

export type LocalMigrationState =
  | 'building' | 'submitting' | 'pending_review' | 'approved' | 'rejected' | 'expired' | 'cancelled' | 'failed';

export type MappingRow = {
  localItemId: string;
  action: 'create' | 'link' | 'skip';
  storoItemId: string | null;
  qtyPolicy: 'keep_storo' | 'take_phone' | null;
  qtyApplied: number | null;
};

export type MigrationResultSummary = { created: number; linked: number; skipped: number; adjustments: number };

export type LocalMigration = {
  clientId: string;
  /** Corps exact de la requête : renvoyé à l'identique (même empreinte côté serveur). */
  body: string;
  state: LocalMigrationState;
  orgId: string;
  itemCount: number;
  totalQty: number;
  migrationId?: string;
  submittedAt?: number;
  /** Date d'expiration de la copie Storo (14 jours après l'envoi), si connue. */
  expiresAt?: number;
  status?: string;
  lastCheckedAt?: number;
  error?: string;
  rejectReason?: string | null;
  /** Nom et SKU des articles envoyés (affichage du résultat ; le corps n'est pas relu). */
  names?: Record<string, { name: string; sku: string }>;
  result?: {
    siteId: string;
    siteName: string;
    mapping: MappingRow[];
    result: MigrationResultSummary | null;
    decidedAt: number | null;
    decidedByName?: string | null;
  };
};

export type StandaloneArchive = { archivedAt: number; migrationId: string; orgId: string };

export const GUARD_PENDING =
  'Migration vers Storo en attente de validation : le stock local est en lecture seule. Annulez la migration pour le modifier.';
export const GUARD_ARCHIVED =
  'Ce stock local a été transféré dans Storo et est archivé (lecture seule). Vous pouvez le réactiver dans Profil › Storo.';
export const TOO_LARGE = 'Inventaire trop volumineux pour un transfert unique (1000 articles au maximum).';
export const SERIALS_WARNING =
  'Les numéros de série et IMEI ne sont pas transférés dans cette version : seuls les articles et leurs quantités le sont.';
export const OTHER_ORG =
  "Migration préparée pour une autre organisation Storo : elle n'est pas envoyée ici. Si elle attend encore une validation, demandez à un responsable de cette organisation de la rejeter.";
export const SUSPENDED_NOTICE =
  "Connexion à Storo en lecture seule : le transfert en attente est suspendu et votre stock local redevient modifiable. Il sera revérifié dès le retour de la connexion ; s'il est alors validé, le stock local sera archivé tel qu'il est à ce moment-là.";
export const ABANDONED_LOCALLY =
  "Migration abandonnée sur ce téléphone. Si elle attend encore une validation dans Storo, demandez à un responsable de la rejeter.";
export const CANCEL_OFFLINE =
  "Annulation impossible sans connexion : Storo a peut-être déjà reçu l'envoi. Réessayez une fois en ligne.";
export const REVIEW_NOTICE =
  'Un responsable doit valider le transfert dans Storo. En attendant, votre stock local passe en lecture seule.';

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

let _mig: LocalMigration | null | undefined;
let _archive: StandaloneArchive | null | undefined;

export function getLocalMigration(): LocalMigration | null {
  if (_mig === undefined) _mig = readJSON<LocalMigration | null>(ORG_KEYS.migration, null, (v) => isRecord(v) && typeof v.state === 'string');
  return _mig;
}

export function getArchive(): StandaloneArchive | null {
  if (_archive === undefined) _archive = readJSON<StandaloneArchive | null>(ORG_KEYS.archive, null, (v) => isRecord(v) && typeof v.migrationId === 'string');
  return _archive;
}

/** Pour les tests et après un effacement : relit le stockage au prochain accès. */
export function reloadMigration(): void {
  _mig = undefined;
  _archive = undefined;
}

function saveMigration(m: LocalMigration | null): boolean {
  const ok = m === null ? removeKey(ORG_KEYS.migration) : writeJSON(ORG_KEYS.migration, m);
  if (ok) {
    _mig = m;
    emit();
  }
  return ok;
}

function patchMigration(patch: Partial<LocalMigration>): boolean {
  const m = getLocalMigration();
  if (!m) return false;
  const next = { ...m, ...patch };
  for (const k of Object.keys(patch) as (keyof LocalMigration)[]) if (patch[k] === undefined) delete next[k];
  return saveMigration(next);
}

function saveArchive(a: StandaloneArchive | null): boolean {
  const ok = a === null ? removeKey(ORG_KEYS.archive) : writeJSON(ORG_KEYS.archive, a);
  if (ok) {
    _archive = a;
    emit();
  }
  return ok;
}

/** Migration envoyée ou en cours d'envoi, pas encore décidée. */
export function isMigrationPending(m: LocalMigration | null = getLocalMigration()): boolean {
  return m !== null && (m.state === 'building' || m.state === 'submitting' || m.state === 'pending_review');
}

/**
 * Migration en attente mais suspendue : session Storo en lecture seule ou
 * absente (jeton révoqué, droit perdu, appareil désactivé), ou copie Storo
 * expirée. Le stock local n'est alors plus bloqué (Stocky reste utilisable seul).
 */
export function isMigrationSuspended(m: LocalMigration | null = getLocalMigration()): boolean {
  if (!isMigrationPending(m)) return false;
  if (getSessionState() !== 'active') return true;
  return m!.expiresAt !== undefined && m!.expiresAt <= now();
}

/** Organisation d'une migration en attente (pour refuser une association à une autre). */
export function pendingMigrationOrg(): string | null {
  const m = getLocalMigration();
  return isMigrationPending(m) ? m!.orgId : null;
}

// ── Garde du stock local (§5.5) ────────────────────────────────────────────

export function standaloneGuardMessage(): string | null {
  if (isMigrationPending() && !isMigrationSuspended()) return GUARD_PENDING;
  if (getArchive()) return GUARD_ARCHIVED;
  return null;
}

setStandaloneGuard(standaloneGuardMessage);

// ── Aperçu et contenu (§6.5.1, §8.4) ───────────────────────────────────────

export type MigrationPreview = {
  items: number;
  units: number;
  serialized: { id: string; name: string; inStock: number }[];
  /** Raison pour laquelle la migration ne peut pas commencer (null : possible). */
  blocked: string | null;
};

export function canStartMigration(items: readonly Item[] = getItems()): string | null {
  if (!getSession()) return "Associez d'abord ce téléphone à une organisation Storo.";
  if (!isOrgWritable()) return "La connexion à Storo est en lecture seule : la migration n'est pas possible pour le moment.";
  if (isMigrationPending()) return 'Une migration est déjà en attente de validation.';
  if (getArchive()) return 'Le stock local a déjà été transféré dans Storo (archivé).';
  if (items.length === 0) return 'Le stock local est vide : aucun article à transférer.';
  if (items.length > MAX_MIGRATION_ITEMS) return TOO_LARGE;
  return null;
}

export function previewMigration(): MigrationPreview {
  const items = getItems();
  return {
    items: items.length,
    units: items.reduce((n, i) => n + (Number.isFinite(i.qty) ? i.qty : 0), 0),
    serialized: items.filter((i) => i.serialized).map((i) => ({ id: i.id, name: i.name, inStock: i.qty })),
    blocked: canStartMigration(items),
  };
}

/** Corps de la requête (chaîne exacte envoyée) ou message d'erreur. */
export function buildMigrationBody(items: readonly Item[], deviceId: string, localId: string = localUid('')): { clientId: string; body: string; totalQty: number } | { error: string } {
  if (items.length === 0 || items.length > MAX_MIGRATION_ITEMS) return { error: items.length === 0 ? 'Aucun article à transférer.' : TOO_LARGE };
  const info = platform().deviceInfo();
  const clientId = `${deviceId}:mig-${localId}`.slice(0, 128);
  const payload = buildMigrationPayload(items, clientId, {
    app: 'stocky',
    ...(info.appVersion ? { appVersion: info.appVersion } : {}),
    ...(info.platform ? { platform: info.platform } : {}),
    licensed: isProActive(),
  });
  const body = JSON.stringify(payload);
  if (utf8Length(body) > MAX_MIGRATION_BYTES) return { error: TOO_LARGE };
  return { clientId, body, totalQty: payload.items.reduce((n, i) => n + i.qty, 0) };
}

// ── Envoi, suivi, annulation ───────────────────────────────────────────────

type MigrationDto = {
  id?: string;
  status?: string;
  expiresAt?: number;
  siteId?: string | null;
  siteName?: string | null;
  decidedAt?: number | null;
  decidedByName?: string | null;
  rejectReason?: string | null;
  result?: MigrationResultSummary | null;
};

export type StepResult =
  | { ok: true }
  /** Réseau, 5xx, 429 : état conservé, nouvel essai par le moteur de synchronisation. */
  | { ok: false; transport: true; error: ApiError; retryAfterMs?: number }
  | { ok: false; transport?: false; message: string };

/**
 * Démarre une migration : contenu construit une fois, enregistré
 * (`submitting`) AVANT l'envoi, puis envoyé. Renvoie un message d'erreur ou null.
 */
export async function startMigration(): Promise<string | null> {
  const items = getItems();
  const blocked = canStartMigration(items);
  if (blocked) return blocked;
  const s = getSession()!;
  const built = buildMigrationBody(items, s.deviceId);
  if ('error' in built) return built.error;
  const names: Record<string, { name: string; sku: string }> = {};
  for (const i of items) names[i.id] = { name: i.name, sku: i.sku };
  const m: LocalMigration = {
    clientId: built.clientId, body: built.body, state: 'submitting', orgId: s.orgId, itemCount: items.length, totalQty: built.totalQty, names,
  };
  if (!saveMigration(m)) return SAVE_ERROR;
  const r = await submitMigration();
  if (!r.ok && !r.transport) return r.message;
  return null;
}

function applyDto(dto: MigrationDto): Partial<LocalMigration> {
  return {
    ...(dto.id ? { migrationId: dto.id } : {}),
    ...(dto.status ? { status: dto.status } : {}),
    ...(typeof dto.expiresAt === 'number' ? { expiresAt: dto.expiresAt } : {}),
    lastCheckedAt: now(),
  };
}

/**
 * La migration appartient à une autre organisation que la session : rien
 * n'est envoyé ni lu (son contenu n'irait jamais chez un autre client Storo).
 */
function foreignOrg(m: LocalMigration, orgId: string): StepResult | null {
  if (m.orgId === orgId) return null;
  if (isMigrationPending(m)) patchMigration({ state: 'failed', error: OTHER_ORG });
  return { ok: false, message: OTHER_ORG };
}

/** Envoie (ou renvoie à l'identique) une migration `submitting`. */
export async function submitMigration(): Promise<StepResult> {
  const m = getLocalMigration();
  const s = getSession();
  if (!m || m.state !== 'submitting') return { ok: true };
  if (!s) return { ok: false, message: "Ce téléphone n'est plus associé à Storo." };
  const foreign = foreignOrg(m, s.orgId);
  if (foreign) return foreign;
  const token = await getToken();
  if (!token) return { ok: false, message: "Ce téléphone n'est plus associé à Storo." };
  const r = await apiRequest<{ migration?: MigrationDto }>(s.apiBase, '/device/migrations', {
    method: 'POST', body: m.body, token, timeoutMs: MIGRATION_TIMEOUT_MS,
  });
  if (r.ok) {
    const dto = r.data?.migration ?? {};
    patchMigration({ ...applyDto(dto), state: 'pending_review', submittedAt: now() });
    // Réponse rejouée d'une migration déjà décidée : son état est lu tout de suite.
    if (dto.status && dto.status !== 'pending_review') return checkMigration();
    return { ok: true };
  }
  const action = await applyApiError(r);
  if (action.kind === 'transport') return { ok: false, transport: true, error: r, ...(action.retryAfterMs ? { retryAfterMs: action.retryAfterMs } : {}) };
  if (action.kind === 'readonly') return { ok: false, transport: true, error: r };
  if (r.status === 409 && r.code === 'CONFLICT' && r.reason === 'migration_pending' && typeof r.details.migrationId === 'string') {
    // Une autre migration de ce téléphone attend déjà : elle est reprise.
    patchMigration({ state: 'pending_review', migrationId: r.details.migrationId, submittedAt: now() });
    return checkMigration();
  }
  const message = action.kind === 'device_kind' ? "Ce téléphone n'est pas enregistré comme Stocky." : errorMessage(r);
  patchMigration({ state: 'failed', error: message });
  return { ok: false, message };
}

/** `GET /device/migrations/:id` : état courant ; une migration validée est appliquée. */
export async function checkMigration(): Promise<StepResult> {
  const m = getLocalMigration();
  const s = getSession();
  if (!m || !m.migrationId || !s) return { ok: true };
  const foreign = foreignOrg(m, s.orgId);
  if (foreign) return foreign;
  const token = await getToken();
  if (!token) return { ok: true };
  const r = await apiRequest<{ migration?: MigrationDto; mapping?: MappingRow[] | null }>(s.apiBase, `/device/migrations/${encodeURIComponent(m.migrationId)}`, { token });
  if (!r.ok) {
    const action = await applyApiError(r);
    if (action.kind === 'transport' || action.kind === 'readonly') return { ok: false, transport: true, error: r };
    if (r.status === 404) {
      const message = 'Migration introuvable dans Storo. Vous pouvez recommencer.';
      patchMigration({ state: 'failed', migrationId: undefined, error: message });
      return { ok: false, message };
    }
    return { ok: false, message: errorMessage(r) };
  }
  const dto = r.data?.migration ?? {};
  const base = applyDto(dto);
  switch (dto.status) {
    case 'approved':
      applyApproved(m, dto, Array.isArray(r.data?.mapping) ? r.data!.mapping! : []);
      return { ok: true };
    case 'rejected':
      patchMigration({ ...base, state: 'rejected', rejectReason: dto.rejectReason ?? null });
      clearMePendingMigration(m.migrationId);
      return { ok: true };
    case 'expired':
    case 'cancelled':
      patchMigration({ ...base, state: dto.status });
      clearMePendingMigration(m.migrationId);
      return { ok: true };
    default:
      patchMigration({ ...base, state: 'pending_review' });
      return { ok: true };
  }
}

/**
 * Migration validée : stock local archivé (lecture seule), site et espace
 * organisation choisis. Les articles créés arrivent par la synchronisation.
 */
function applyApproved(m: LocalMigration, dto: MigrationDto, mapping: MappingRow[]): void {
  const t = now();
  const migrationId = dto.id ?? m.migrationId ?? '';
  clearMePendingMigration(migrationId);
  saveArchive({ archivedAt: t, migrationId, orgId: m.orgId });
  const siteId = dto.siteId ?? '';
  patchMigration({
    ...applyDto(dto),
    state: 'approved',
    result: {
      siteId,
      siteName: dto.siteName ?? '',
      mapping,
      result: dto.result ?? null,
      decidedAt: dto.decidedAt ?? null,
      decidedByName: dto.decidedByName ?? null,
    },
  });
  if (siteId) setCurrentSiteId(siteId);
  setWorkspaceChoice('org');
}

/** « Annuler la migration » (en attente de validation). Renvoie un message d'erreur ou null. */
export async function cancelMigration(): Promise<string | null> {
  let m = getLocalMigration();
  const s = getSession();
  if (!m) return null;
  if (s && m.orgId !== s.orgId) return OTHER_ORG;
  if (m.state === 'submitting' && !m.migrationId) {
    // Réponse jamais reçue : Storo a peut-être enregistré l'envoi. Le même corps est
    // renvoyé (rejoué à l'identique s'il existe, sinon créé) pour connaître son
    // identifiant, puis la migration est annulée dans Storo. Seul un refus définitif
    // (l'envoi n'a jamais été enregistré) permet l'abandon purement local.
    if (!s) return "Ce téléphone n'est plus associé à Storo.";
    const r = await submitMigration();
    if (!r.ok && r.transport) return CANCEL_OFFLINE;
    m = getLocalMigration();
    if (!m) return null;
    if (m.state === 'failed') return patchMigration({ state: 'cancelled' }) ? null : SAVE_ERROR;
    if (m.state !== 'pending_review') return null; // déjà décidée (rejouée) : état lu par submitMigration
  }
  if (m.state !== 'pending_review' || !m.migrationId || !s) return null;
  const token = await getToken();
  if (!token) return "Ce téléphone n'est plus associé à Storo.";
  const r = await apiRequest<{ migration?: MigrationDto }>(s.apiBase, `/device/migrations/${encodeURIComponent(m.migrationId)}/cancel`, { method: 'POST', body: {}, token });
  if (r.ok) {
    clearMePendingMigration(m.migrationId);
    return patchMigration({ ...applyDto(r.data?.migration ?? {}), state: 'cancelled' }) ? null : SAVE_ERROR;
  }
  await applyApiError(r);
  if (r.status === 409 && r.code === 'INVALID_TRANSITION') {
    await checkMigration();
    return 'Cette migration a déjà été traitée dans Storo.';
  }
  return errorMessage(r);
}

/** « Recommencer » après un refus, une expiration, une annulation ou un échec. */
export function resetMigration(): string | null {
  const m = getLocalMigration();
  if (!m || isMigrationPending(m) || m.state === 'approved') return null;
  if (m.migrationId) clearMePendingMigration(m.migrationId);
  return saveMigration(null) ? null : SAVE_ERROR;
}

/**
 * « Abandonner sur ce téléphone » : seulement quand la migration est
 * suspendue (Storo injoignable avec ce jeton : annulation impossible). Le
 * stock local redevient modifiable ; la copie Storo, si elle existe, reste à
 * rejeter par un responsable. La file d'envoi n'est pas touchée.
 */
export function abandonMigrationLocally(): string | null {
  const m = getLocalMigration();
  if (!m || !isMigrationPending(m)) return null;
  if (!isMigrationSuspended(m)) return "Annulez la migration : la connexion à Storo est active.";
  return patchMigration({ state: 'failed', error: ABANDONED_LOCALLY }) ? null : SAVE_ERROR;
}

/** « Réactiver le stock local » : l'archive est supprimée (les modifications ne vont pas dans Storo). */
export function reactivateStandalone(): string | null {
  return saveArchive(null) ? null : SAVE_ERROR;
}

/**
 * Étape « migration » d'un cycle de synchronisation : renvoi si
 * `submitting`, suivi si `pending_review`. Une migration en attente connue
 * de Storo (`/device/me > pendingMigrationId`) mais absente du téléphone est
 * reprise. `approved` : la migration vient d'être validée (lire les données).
 */
export async function tickMigration(): Promise<StepResult & { approved?: boolean }> {
  let m = getLocalMigration();
  const pendingId = getMe()?.pendingMigrationId;
  const s = getSession();
  // Reprise d'une migration inconnue du téléphone : jamais celle qu'il vient de voir
  // décidée, annulée ou expirée (/device/me n'est relu que toutes les 15 min).
  if (s && typeof pendingId === 'string' && pendingId && pendingId !== m?.migrationId
    && (!m || (!isMigrationPending(m) && m.state !== 'approved')) && !getArchive()) {
    saveMigration({ clientId: '', body: '', state: 'pending_review', orgId: s.orgId, itemCount: 0, totalQty: 0, migrationId: pendingId });
    m = getLocalMigration();
  }
  if (!m) return { ok: true };
  if (m.state === 'submitting') {
    const r = await submitMigration();
    return { ...r, approved: getLocalMigration()?.state === 'approved' };
  }
  if (m.state === 'pending_review') {
    const r = await checkMigration();
    return { ...r, approved: getLocalMigration()?.state === 'approved' };
  }
  return { ok: true };
}

/** « Effacer les données Storo » : la migration est oubliée, l'archive reste (§10.3). */
export function forgetMigration(): void {
  saveMigration(null);
}
