/**
 * Session Storo du téléphone (contrat §6) : association par code (OTP) ou
 * QR code, jeton de l'appareil (expo-secure-store, seul secret), état
 * `active` / `readonly`, rafraîchissement de `/device/me`, dissociation.
 * Module pur (stockage et `fetch` injectés).
 */
import { QR_RETRY_DELAY_MS } from '../../constants/storo';
import { apiRequest, type ApiError } from './client';
import { classify, errorMessage, frMessage, type ErrorAction, type ReadonlyReason } from './errors';
import { ORG_KEYS, TOKEN_KEY, now, platform, readJSON, removeKey, secureKv, writeJSON } from './kv';
import { adoptOrg, clearForOrgSwitch, emit, getOutboxRows, getSyncMeta, getWorkspaceChoice, hasOrgData, updateSyncMeta, type Workspace } from './orgStore';

export type { ReadonlyReason } from './errors';

export type StoroSession = {
  apiBase: string;
  deviceId: string;
  orgId: string;
  orgName: string;
  serialNumber: string;
  pairedAt: number;
  state: 'active' | 'readonly';
  readonlyReason?: ReadonlyReason;
  readonlyDetails?: Record<string, unknown>;
};

export type SessionState = 'none' | 'active' | 'readonly';

export type DeviceMe = {
  device?: { id?: string; name?: string; status?: string; serialNumber?: string; model?: string; assignedToName?: string | null };
  organization?: { id?: string; name?: string; currency?: string };
  actingMemberId?: string | null;
  assignedMemberId?: string | null;
  attributedMemberId: string | null;
  attributedMemberName?: string | null;
  entitlements?: { stocklyMobile?: boolean; stocklyMobileValidUntil?: number | null };
  pendingMigrationId?: string | null;
  serverTime?: number;
  fetchedAt: number;
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

// ── Lecture ────────────────────────────────────────────────────────────────

let _session: StoroSession | null | undefined;
let _me: DeviceMe | null | undefined;
let _token: string | null | undefined;
/**
 * Génération de la session : avance à chaque changement de jeton ou
 * dissociation. Une réponse à une requête partie avant (ancien jeton,
 * session dissociée) n'est jamais appliquée à la session actuelle.
 */
let _generation = 0;

// ── Serveurs acceptés ──────────────────────────────────────────────────────

const ORIGIN_RE = /^(https:\/\/([^/:?#]+)(?::\d+)?)(?:[/?#]|$)/i;

/** Origine `https://hôte[:port]` (en minuscules) d'une adresse https, sinon null. */
function httpsOrigin(url: string): { origin: string; host: string } | null {
  const m = ORIGIN_RE.exec(url);
  return m ? { origin: m[1].toLowerCase(), host: m[2].toLowerCase() } : null;
}

/**
 * Adresse de serveur à laquelle le jeton peut être envoyé : https, et hôte
 * autorisé (`allowedHosts`) ou celui du serveur configuré pour l'OTP.
 */
export function isTrustedApiBase(url: unknown): url is string {
  if (typeof url !== 'string') return false;
  const o = httpsOrigin(url);
  if (!o) return false;
  const cfg = platform();
  if (cfg.allowedHosts.map((h) => h.toLowerCase()).includes(o.host)) return true;
  return httpsOrigin(cfg.apiBase)?.origin === o.origin;
}

/**
 * `apiBase` renvoyé par Storo à la fin d'une association : retenu seulement
 * s'il est sûr ET sur la même origine que le serveur qui vient de répondre
 * (`base`, déjà vérifié) ; sinon `base`.
 */
export function pairingApiBase(candidate: unknown, base: string): string {
  if (typeof candidate !== 'string' || !candidate || !isTrustedApiBase(candidate)) return base;
  return httpsOrigin(candidate)?.origin === httpsOrigin(base)?.origin ? candidate : base;
}

function isSession(v: unknown): v is StoroSession {
  return isRecord(v) && typeof v.apiBase === 'string' && typeof v.deviceId === 'string' && typeof v.orgId === 'string'
    && (v.state === 'active' || v.state === 'readonly');
}

export function getSession(): StoroSession | null {
  if (_session === undefined) {
    const s = readJSON<StoroSession | null>(ORG_KEYS.session, null, isSession);
    // Serveur enregistré non sûr (http, hôte inconnu) : le jeton n'y est jamais envoyé.
    if (s && !isTrustedApiBase(s.apiBase)) {
      console.warn('[storo] Serveur enregistré refusé (https et hôte autorisé requis).');
      _session = null;
    } else _session = s;
  }
  return _session;
}

export function getSessionState(): SessionState {
  return getSession()?.state ?? 'none';
}

/**
 * Espace de travail affiché : `org` seulement si une session existe (même en
 * lecture seule) et que c'était le dernier choix ; sinon « Mon stock » (§5.4).
 */
export function getWorkspace(): Workspace {
  return getSession() !== null && getWorkspaceChoice() === 'org' ? 'org' : 'standalone';
}

/** Espace organisation modifiable (Entrée / Sortie, comptages) : session `active`. */
export const isOrgWritable = (): boolean => getSessionState() === 'active';

export function getMe(): DeviceMe | null {
  if (_me === undefined) _me = readJSON<DeviceMe | null>(ORG_KEYS.me, null, isRecord);
  return _me;
}

/** Pour les tests et après un effacement : relit le stockage au prochain accès. */
export function reloadSession(): void {
  _session = undefined;
  _me = undefined;
  _token = undefined;
}

export async function getToken(): Promise<string | null> {
  if (_token !== undefined) return _token;
  try {
    _token = await secureKv().get(TOKEN_KEY);
  } catch (e) {
    console.warn('[storo] Lecture du jeton impossible.', e);
    return null; // illisible : non mis en cache, relu au prochain appel
  }
  return _token;
}

async function setToken(token: string | null): Promise<boolean> {
  try {
    if (token === null) await secureKv().remove(TOKEN_KEY);
    else await secureKv().set(TOKEN_KEY, token);
    _token = token;
    _generation++;
    return true;
  } catch (e) {
    console.warn('[storo] Écriture du jeton impossible.', e);
    return false;
  }
}

function saveSession(s: StoroSession | null): boolean {
  const ok = s === null ? removeKey(ORG_KEYS.session) : writeJSON(ORG_KEYS.session, s);
  if (ok) {
    _session = s;
    emit();
  }
  return ok;
}

function saveMe(me: DeviceMe | null): void {
  if (me === null ? removeKey(ORG_KEYS.me) : writeJSON(ORG_KEYS.me, me)) _me = me;
}

/**
 * La migration `id` vient d'être vue annulée, refusée, expirée, validée ou
 * oubliée : le `/device/me` en cache (relu toutes les 15 min) ne la signale
 * plus comme en attente, pour qu'elle ne soit pas reprise.
 */
export function clearMePendingMigration(id: string | undefined): void {
  const me = getMe();
  if (!me || !id || me.pendingMigrationId !== id) return;
  saveMe({ ...me, pendingMigrationId: null });
}

// ── Association en cours ───────────────────────────────────────────────────

const PAIRING_PAUSE_MS = 10 * 60_000;
let _pairingSince: number | null = null;

/**
 * Une association est en cours de finalisation (confirmation affichée) : la
 * synchronisation attend, pour ne jamais mélanger l'ancienne session et le
 * nouveau jeton. Levée automatiquement après 10 min (écran abandonné).
 */
export function isPairingInProgress(): boolean {
  if (_pairingSince === null) return false;
  if (now() - _pairingSince > PAIRING_PAUSE_MS) _pairingSince = null;
  return _pairingSince !== null;
}

/** Organisation d'une migration du stock local en attente (lue telle qu'enregistrée). */
function pendingMigrationOrgId(): string | null {
  const m = readJSON<{ state?: unknown; orgId?: unknown } | null>(ORG_KEYS.migration, null, isRecord);
  if (!m || (m.state !== 'building' && m.state !== 'submitting' && m.state !== 'pending_review')) return null;
  return typeof m.orgId === 'string' ? m.orgId : null;
}

export const MIGRATION_BLOCKS_SWITCH =
  "Une migration du stock local attend une validation dans l'organisation actuelle. Annulez-la (Profil › Storo › Migrer vers Storo) avant d'associer ce téléphone à une autre organisation.";

// ── États ──────────────────────────────────────────────────────────────────

/**
 * Passe en lecture seule. `unpaired` : l'état est enregistré AVANT la
 * suppression du jeton. La file d'envoi n'est jamais effacée.
 */
export async function setReadonly(reason: ReadonlyReason, details: Record<string, unknown> = {}): Promise<void> {
  const s = getSession();
  if (!s) return;
  if (reason === 'unpaired') _generation++;
  const same = s.state === 'readonly' && s.readonlyReason === reason && JSON.stringify(s.readonlyDetails ?? {}) === JSON.stringify(details);
  if (!same) saveSession({ ...s, state: 'readonly', readonlyReason: reason, readonlyDetails: details });
  if (reason === 'unpaired') await setToken(null);
}

function setActive(): void {
  const s = getSession();
  if (!s || s.state === 'active') return;
  const next: StoroSession = { ...s, state: 'active' };
  delete next.readonlyReason;
  delete next.readonlyDetails;
  saveSession(next);
}

/**
 * Applique à la session une erreur d'un appel Storo (401 → dissocié, 403 →
 * lecture seule) et renvoie son classement pour la suite propre à l'appel.
 */
export async function applyApiError(e: ApiError, gen?: number): Promise<ErrorAction> {
  const action = classify(e);
  // Requête partie avant un changement de jeton (nouvelle association, dissociation) : rien n'est appliqué.
  if (gen !== undefined && gen !== _generation) return action;
  if (action.kind === 'readonly') await setReadonly(action.reason, action.details);
  return action;
}

/** Génération actuelle de la session (à relever avant la lecture du jeton d'une requête). */
export function sessionGeneration(): number {
  return _generation;
}

/** Au démarrage : une session sans jeton (Keychain vidé, réinstallation) est dissociée. */
export async function checkTokenAtStart(): Promise<void> {
  const s = getSession();
  if (!s || s.readonlyReason === 'unpaired') return;
  try {
    const t = await secureKv().get(TOKEN_KEY);
    _token = t;
    if (!t) await setReadonly('unpaired');
  } catch {
    // Keychain illisible : rien n'est décidé, l'appel suivant réessaie.
  }
}

/** `stale` : jeton remplacé ou session dissociée pendant la requête, rien n'a été appliqué. */
export type MeResult = { ok: true; me: DeviceMe } | { ok: false; error: ApiError; action: ErrorAction; stale?: true };

/**
 * `GET /device/me` : attribution, droit `stockly_mobile`, nom de
 * l'organisation, décalage d'horloge. Une réponse 200 avec
 * `stocklyMobile: true` (ré)active la session.
 */
export async function refreshMe(tokenOverride?: string): Promise<MeResult> {
  const gen = _generation;
  const s = getSession();
  const token = tokenOverride ?? (await getToken());
  if (s && !token && _token === undefined) {
    // Keychain illisible (et non vide) : rien n'est décidé, nouvel essai plus tard.
    const error: ApiError = { ok: false, status: null, code: 'NETWORK', details: {}, message: 'Secure storage unreadable', network: true };
    return { ok: false, error, action: { kind: 'transport' } };
  }
  if (!s || !token) {
    const error: ApiError = { ok: false, status: 401, code: 'UNAUTHENTICATED', details: { reason: 'missing' }, message: 'No token' };
    if (s && !tokenOverride) await setReadonly('unpaired');
    return { ok: false, error, action: { kind: 'readonly', reason: 'unpaired', details: {} } };
  }
  const r = await apiRequest<Omit<DeviceMe, 'fetchedAt'>>(s.apiBase, '/device/me', { token });
  // Jeton remplacé ou session dissociée pendant la requête : réponse ignorée (rien n'est appliqué).
  const stale = !tokenOverride && gen !== _generation;
  if (!r.ok) return stale ? { ok: false, error: r, action: classify(r), stale: true } : { ok: false, error: r, action: await applyApiError(r) };
  const t = now();
  const me: DeviceMe = { ...(isRecord(r.data) ? r.data : {}), attributedMemberId: isRecord(r.data) && typeof r.data.attributedMemberId === 'string' ? r.data.attributedMemberId : null, fetchedAt: t };
  if (stale) return { ok: true, me };
  saveMe(me);
  if (typeof me.serverTime === 'number') updateSyncMeta({ serverOffsetMs: me.serverTime - t });
  const orgName = me.organization?.name;
  const cur = getSession();
  if (cur && typeof orgName === 'string' && orgName && orgName !== cur.orgName) saveSession({ ...cur, orgName });
  if (me.entitlements?.stocklyMobile === false) await setReadonly('entitlement', { feature: 'stockly_mobile' });
  else setActive();
  emit();
  return { ok: true, me };
}

// ── Association ────────────────────────────────────────────────────────────

export const PHONE_CODE_UNAVAILABLE = "Code du téléphone indisponible : relancez l'application.";
export const PAIRING_INTERRUPTED = 'Association interrompue, recommencez.';

/** Informations de l'appareil envoyées à l'association (§6.2) ; `null` : code du téléphone illisible. */
export function pairingDeviceBody(): { serialNumber: string; model: string; kind: 'stockly_mobile'; appVersion?: string; platform?: string } | null {
  const info = platform().deviceInfo();
  if (!info.serialNumber) return null;
  return {
    serialNumber: info.serialNumber,
    model: (info.model || 'Téléphone Stocky').slice(0, 128),
    kind: 'stockly_mobile',
    ...(info.appVersion ? { appVersion: info.appVersion.slice(0, 64) } : {}),
    ...(info.platform ? { platform: info.platform.slice(0, 64) } : {}),
  };
}

export type PairingCredentials = { deviceToken: string; deviceId: string; orgId: string; apiBase: string };

export type PairingOutcome =
  | { kind: 'paired' }
  /** Données d'une autre organisation présentes : confirmation requise (§10.3). */
  | { kind: 'confirm'; oldOrgName: string; newOrgName: string; pending: number; confirm: () => Promise<PairingOutcome>; cancel: () => Promise<void> }
  | { kind: 'error'; message: string };

function newSession(creds: PairingCredentials, orgName: string, serialNumber: string): StoroSession {
  return { apiBase: creds.apiBase, deviceId: creds.deviceId, orgId: creds.orgId, orgName, serialNumber, pairedAt: now(), state: 'active' };
}

/**
 * Fin d'association (OTP réclamé ou QR accepté) : jeton enregistré, session
 * `active`, puis `/device/me` (cette première utilisation termine la remise
 * du jeton). Données d'une autre organisation présentes : confirmation.
 */
export async function completePairing(creds: PairingCredentials): Promise<PairingOutcome> {
  const serial = pairingDeviceBody()?.serialNumber ?? '';
  const prevSession = getSession();
  const prevToken = await getToken();
  const dataOrg = getSyncMeta().orgId ?? prevSession?.orgId ?? null;
  const switching = dataOrg !== null && dataOrg !== creds.orgId && hasOrgData();

  // Une migration en attente reste liée à son organisation : pas de changement
  // d'organisation tant qu'elle n'est pas annulée (sinon personne ne pourrait
  // plus l'annuler depuis ce téléphone). Rien n'est enregistré.
  const migOrg = pendingMigrationOrgId();
  if (migOrg !== null && migOrg !== creds.orgId) return { kind: 'error', message: MIGRATION_BLOCKS_SWITCH };

  if (!switching) {
    _pairingSince = now();
    try {
      if (!(await setToken(creds.deviceToken))) {
        return { kind: 'error', message: "Le jeton Storo n'a pas pu être enregistré sur ce téléphone. Recommencez l'association." };
      }
      const sameOrg = prevSession?.orgId === creds.orgId;
      if (!saveSession(newSession(creds, sameOrg ? prevSession!.orgName : '', serial))) {
        await setToken(prevToken);
        return { kind: 'error', message: "L'association n'a pas pu être enregistrée sur ce téléphone. Recommencez." };
      }
      if (!sameOrg) saveMe(null);
      adoptOrg(creds.orgId);
    } finally {
      _pairingSince = null;
    }
    await refreshMe();
    return { kind: 'paired' };
  }

  // Autre organisation : le nouveau jeton reste en mémoire (jamais enregistré, jamais
  // utilisé par la synchronisation, qui attend) jusqu'à la confirmation.
  _pairingSince = now();
  const probe = await apiRequest<{ organization?: { name?: string } }>(creds.apiBase, '/device/me', { token: creds.deviceToken });
  const newOrgName = probe.ok && typeof probe.data?.organization?.name === 'string' ? probe.data.organization.name : 'la nouvelle organisation';
  const oldOrgName = prevSession?.orgName || "l'ancienne organisation";
  const pending = getOutboxRows().filter((r) => r.orgId === dataOrg).length;
  return {
    kind: 'confirm',
    oldOrgName,
    newOrgName,
    pending,
    confirm: async () => {
      try {
        if (!(await setToken(creds.deviceToken))) {
          return { kind: 'error', message: "Le jeton Storo n'a pas pu être enregistré sur ce téléphone. Recommencez l'association." };
        }
        // Nouvelle session d'abord : l'ancien cache n'est effacé que si le changement peut aboutir.
        if (!saveSession(newSession(creds, newOrgName === 'la nouvelle organisation' ? '' : newOrgName, serial))) {
          await setToken(prevToken);
          return { kind: 'error', message: "L'association n'a pas pu être enregistrée sur ce téléphone. Recommencez." };
        }
        if (!clearForOrgSwitch(creds.orgId)) {
          saveSession(prevSession);
          await setToken(prevToken);
          return { kind: 'error', message: "L'association n'a pas pu être enregistrée sur ce téléphone. Recommencez." };
        }
        saveMe(null);
      } finally {
        _pairingSince = null;
      }
      await refreshMe();
      return { kind: 'paired' };
    },
    cancel: async () => {
      // Le jeton de l'ancienne organisation n'a jamais été remplacé.
      _pairingSince = null;
    },
  };
}

// OTP (§6.3)

export type OtpSession = {
  sessionId: string;
  otp: string;
  otpDisplay: string;
  pollSecret: string;
  expiresAt: number;
  pollIntervalMs: number;
  apiBase: string;
};

export async function requestOtp(): Promise<{ ok: true; otp: OtpSession } | { ok: false; message: string; error?: ApiError }> {
  const body = pairingDeviceBody();
  if (!body) return { ok: false, message: PHONE_CODE_UNAVAILABLE };
  const base = platform().apiBase;
  const r = await apiRequest<Omit<OtpSession, 'apiBase'>>(base, '/device-pairing/otp', { method: 'POST', body });
  if (!r.ok) return { ok: false, message: errorMessage(r), error: r };
  const d = r.data;
  if (!d || typeof d.pollSecret !== 'string' || typeof d.otpDisplay !== 'string') {
    return { ok: false, message: frMessage('UNAVAILABLE') };
  }
  return { ok: true, otp: { ...d, pollIntervalMs: typeof d.pollIntervalMs === 'number' && d.pollIntervalMs >= 1000 ? d.pollIntervalMs : 3000, apiBase: base } };
}

export type OtpPoll =
  | { status: 'pending'; nextPollMs: number }
  | { status: 'expired' }
  /** Réseau / 429 / 5xx : continuer à interroger après `nextPollMs`. */
  | { status: 'retry'; nextPollMs: number; message: string }
  | { status: 'claimed'; outcome: PairingOutcome }
  | { status: 'failed'; message: string };

export async function pollOtp(otp: OtpSession): Promise<OtpPoll> {
  const r = await apiRequest<{ status?: string; deviceId?: string; orgId?: string; apiBase?: string; deviceToken?: string | null; pollIntervalMs?: number }>(
    otp.apiBase, '/device-pairing/otp/status', { headers: { 'X-Poll-Secret': otp.pollSecret } },
  );
  if (!r.ok) {
    if (r.status === 404) return { status: 'expired' };
    const a = classify(r);
    if (a.kind === 'transport') return { status: 'retry', nextPollMs: a.retryAfterMs ?? otp.pollIntervalMs, message: errorMessage(r) };
    return { status: 'failed', message: errorMessage(r) };
  }
  const d = r.data ?? {};
  if (d.status === 'pending') return { status: 'pending', nextPollMs: typeof d.pollIntervalMs === 'number' ? d.pollIntervalMs : otp.pollIntervalMs };
  if (d.status === 'expired') return { status: 'expired' };
  if (d.status === 'claimed') {
    if (typeof d.deviceToken !== 'string' || !d.deviceToken || typeof d.deviceId !== 'string' || typeof d.orgId !== 'string') {
      // Jeton déjà remis (réponse perdue) : sans jeton enregistré, il faut recommencer.
      return { status: 'failed', message: PAIRING_INTERRUPTED };
    }
    const outcome = await completePairing({
      deviceToken: d.deviceToken, deviceId: d.deviceId, orgId: d.orgId, apiBase: pairingApiBase(d.apiBase, otp.apiBase),
    });
    return { status: 'claimed', outcome };
  }
  return { status: 'retry', nextPollMs: otp.pollIntervalMs, message: frMessage('UNAVAILABLE') };
}

// QR (§6.4)

export type PairingQr = { apiBase: string; token: string; expiresAt: number | null };

export const QR_NOT_STORO = "Ce QR code n'est pas un code d'association Storo.";
export const QR_EXPIRED = 'QR code expiré, demandez-en un nouveau.';

export function parsePairingQr(text: string, allowedHosts: readonly string[], nowMs: number): { ok: true; qr: PairingQr } | { ok: false; error: string } {
  let v: unknown;
  try { v = JSON.parse(text.trim()); } catch { return { ok: false, error: QR_NOT_STORO }; }
  if (!isRecord(v) || v.app !== 'storo' || v.v !== 2 || v.kind !== 'pair' || typeof v.token !== 'string' || !v.token || typeof v.apiBase !== 'string') {
    return { ok: false, error: QR_NOT_STORO };
  }
  const m = /^https:\/\/([^/:?#]+)(?::\d+)?(?:[/?#]|$)/i.exec(v.apiBase);
  if (!m) return { ok: false, error: QR_NOT_STORO };
  const host = m[1].toLowerCase();
  if (!allowedHosts.map((h) => h.toLowerCase()).includes(host)) return { ok: false, error: `Serveur Storo non reconnu : ${host}` };
  const expiresAt = typeof v.expiresAt === 'number' ? v.expiresAt : null;
  if (expiresAt !== null && expiresAt < nowMs) return { ok: false, error: QR_EXPIRED };
  return { ok: true, qr: { apiBase: v.apiBase, token: v.token, expiresAt } };
}

export async function claimQr(qr: PairingQr): Promise<PairingOutcome> {
  const device = pairingDeviceBody();
  if (!device) return { kind: 'error', message: PHONE_CODE_UNAVAILABLE };
  const body = JSON.stringify({ token: qr.token, ...device });
  type Claim = { deviceId?: string; deviceToken?: string; orgId?: string; apiBase?: string };
  let r = await apiRequest<Claim>(qr.apiBase, '/device-pairing/qr/claim', { method: 'POST', body });
  if (!r.ok && (r.network || (r.status !== null && r.status >= 500))) {
    // Même requête une fois après 3 s : sans risque tant que le jeton n'a pas servi (§3.2).
    await platform().sleep(QR_RETRY_DELAY_MS);
    r = await apiRequest<Claim>(qr.apiBase, '/device-pairing/qr/claim', { method: 'POST', body });
  }
  if (!r.ok) {
    if (r.status === 404) return { kind: 'error', message: 'QR code expiré ou déjà utilisé.' };
    return { kind: 'error', message: errorMessage(r) };
  }
  const d = r.data ?? {};
  if (typeof d.deviceToken !== 'string' || typeof d.deviceId !== 'string' || typeof d.orgId !== 'string') {
    return { kind: 'error', message: PAIRING_INTERRUPTED };
  }
  return completePairing({ deviceToken: d.deviceToken, deviceId: d.deviceId, orgId: d.orgId, apiBase: pairingApiBase(d.apiBase, qr.apiBase) });
}

// ── Présence, dissociation ─────────────────────────────────────────────────

/** `POST /device/heartbeat` (échecs ignorés, sauf 401 / 403 appliqués à la session). */
export async function heartbeat(): Promise<void> {
  const gen = _generation;
  const s = getSession();
  if (!s || s.state !== 'active') return;
  const token = await getToken();
  if (!token) return;
  const info = platform().deviceInfo();
  const r = await apiRequest(s.apiBase, '/device/heartbeat', {
    method: 'POST', token, body: { ...(info.appVersion ? { appVersion: info.appVersion } : {}), ...(info.platform ? { platform: info.platform } : {}) },
  });
  if (!r.ok && gen === _generation) await applyApiError(r);
}

/**
 * « Dissocier » : lecture seule (`unpaired`), jeton supprimé du téléphone
 * (il n'est pas révoqué dans Storo). File d'envoi et données conservées.
 */
export async function unpair(): Promise<void> {
  await setReadonly('unpaired', { local: true });
}

/** Supprime la session et le jeton (« Effacer les données Storo »). */
export async function dropSession(): Promise<void> {
  await setToken(null);
  saveSession(null);
  saveMe(null);
}
