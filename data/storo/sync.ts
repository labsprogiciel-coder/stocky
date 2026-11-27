/**
 * Moteur de synchronisation avec Storo (contrat §7.1, §7.2) : un cycle à la
 * fois (`runSync`), déclenché au démarrage, au retour au premier plan, au
 * retour du réseau, par minuterie, après chaque opération enregistrée et par
 * le bouton « Synchroniser ». Module pur (minuteries de la plateforme JS).
 */
import { ENQUEUE_DEBOUNCE_MS, HEARTBEAT_MS, ME_REFRESH_MS, PULL_LIMIT, PULL_MAX_PAGES } from '../../constants/storo';
import { apiRequest, type ApiError } from './client';
import { errorMessage } from './errors';
import { now } from './kv';
import { forgetMigration, tickMigration } from './migration';
import {
  applyPullPage,
  clearAllOrgState,
  clearForOrgSwitch,
  getSyncMeta,
  onEnqueue,
  resetPullState,
  setOnline,
  setSyncing,
  updateSyncMeta,
  isOnline,
  type PullPage,
} from './orgStore';
import { applyPushResults, chunkRows, sendableRows, setInFlight, transportBackoffMs, unparkNoAttributedMember, type PushResponse } from './outbox';
import { applyApiError, checkTokenAtStart, dropSession, getMe, getSession, getToken, heartbeat, isPairingInProgress, refreshMe } from './session';

export type SyncReason = 'start' | 'foreground' | 'online' | 'timer' | 'enqueue' | 'manual' | 'migration';

export type SyncResult =
  | { ok: true }
  | { ok: false; stopped: 'no_session' | 'readonly' | 'backoff' | 'transport' | 'error' | 'busy'; message?: string };

export const SYNC_ERROR = 'Erreur de synchronisation';

function recordError(e: ApiError | { code: string; message: string; requestId?: string }): void {
  updateSyncMeta({ lastError: { code: e.code, message: 'ok' in e ? errorMessage(e) : e.message, ...(e.requestId ? { requestId: e.requestId } : {}), at: now() } });
}

/** Erreur réseau, 5xx ou 429 : prochain essai après l'attente de l'étape suivante (ou Retry-After). */
function transportBackoff(e: ApiError, retryAfterMs?: number): SyncResult {
  const meta = getSyncMeta();
  const wait = retryAfterMs ?? transportBackoffMs(meta.backoffStep);
  const t = now();
  updateSyncMeta({ backoffStep: meta.backoffStep + 1, nextTryAt: t + wait, retryAfterUntil: retryAfterMs ? t + retryAfterMs : undefined });
  recordError(e);
  return { ok: false, stopped: 'transport', message: errorMessage(e) };
}

async function handleError(e: ApiError): Promise<SyncResult> {
  const action = await applyApiError(e);
  if (action.kind === 'transport') return transportBackoff(e, action.retryAfterMs);
  recordError(e);
  if (action.kind === 'readonly') return { ok: false, stopped: 'readonly', message: errorMessage(e) };
  return { ok: false, stopped: 'error', message: errorMessage(e) };
}

let _lastServerTime: { serverTime: number; at: number } | null = null;
const noteServerTime = (v: unknown) => {
  if (typeof v === 'number' && Number.isFinite(v)) _lastServerTime = { serverTime: v, at: now() };
};

async function push(apiBase: string, token: string, orgId: string): Promise<SyncResult> {
  const rows = sendableRows(orgId, now());
  if (rows.length === 0) return { ok: true };
  for (const batch of chunkRows(rows)) {
    setInFlight(batch.rows.map((x) => x.clientId));
    let r: Awaited<ReturnType<typeof apiRequest<PushResponse>>>;
    try {
      r = await apiRequest<PushResponse>(apiBase, '/sync/push', {
        method: 'POST', token, body: { countEntries: batch.countEntries, movements: batch.movements },
      });
      if (r.ok) applyPushResults(batch, r.data ?? {}, now());
    } finally {
      setInFlight(null);
    }
    if (!r.ok) {
      if (r.status === 400 && r.code === 'VALIDATION') {
        // Enveloppe refusée : défaut de l'application, aucune ligne n'est garée.
        console.warn('[storo] /sync/push refusé (VALIDATION)', r.details);
        recordError({ code: r.code, message: SYNC_ERROR, ...(r.requestId ? { requestId: r.requestId } : {}) });
        return { ok: false, stopped: 'error', message: SYNC_ERROR };
      }
      return handleError(r);
    }
    noteServerTime(r.data?.serverTime);
    updateSyncMeta({ lastPushAt: now() });
  }
  return { ok: true };
}

async function pull(apiBase: string, token: string, orgId: string): Promise<SyncResult> {
  let resetDone = false;
  for (let page = 0; page < PULL_MAX_PAGES; page++) {
    const cursor = getSyncMeta().cursor;
    const qs = `tables=sites,stockTakes,items&limit=${PULL_LIMIT}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const r = await apiRequest<PullPage>(apiBase, `/sync/pull?${qs}`, { token });
    if (!r.ok) {
      if (r.status === 400 && r.code === 'VALIDATION' && cursor && !resetDone) {
        // Curseur refusé : cache effacé (ni comptages ni file d'envoi), lecture complète une fois.
        resetDone = true;
        resetPullState();
        continue;
      }
      if (r.status === 403 && r.code === 'FORBIDDEN' && typeof r.details.permission === 'string') {
        updateSyncMeta({ deniedPermission: r.details.permission });
        recordError(r);
        return { ok: false, stopped: 'error', message: `Accès refusé par l'organisation (${r.details.permission}).` };
      }
      return handleError(r);
    }
    noteServerTime(r.data?.serverTime);
    const applied = applyPullPage(r.data ?? {}, orgId, now());
    if (!applied.ok) {
      recordError({ code: 'STORAGE', message: "Enregistrement impossible sur ce téléphone." });
      return { ok: false, stopped: 'error', message: "Enregistrement impossible sur ce téléphone." };
    }
    if (!r.data?.hasMore) return { ok: true };
  }
  return { ok: true };
}

/** Un cycle (§7.1). */
async function cycle(reason: SyncReason): Promise<SyncResult> {
  let s = getSession();
  if (!s || s.readonlyReason === 'unpaired') return { ok: false, stopped: 'no_session' };
  // Association en cours de confirmation : ni l'ancienne session ni le nouveau jeton ne servent.
  if (isPairingInProgress()) return { ok: false, stopped: 'busy' };
  const t0 = now();
  const me = getMe();
  const meStale = !me || t0 - me.fetchedAt >= ME_REFRESH_MS;
  const wasAttributed = me?.attributedMemberId ?? null;

  if (s.state === 'readonly') {
    // Sonde : au premier plan, au retour du réseau, sur demande, ou toutes les 15 min.
    if (!(reason === 'manual' || reason === 'foreground' || reason === 'online' || reason === 'start' || meStale)) {
      return { ok: false, stopped: 'readonly' };
    }
    const r = await refreshMe();
    if (!r.ok) return r.action.kind === 'transport' ? transportBackoff(r.error, r.action.retryAfterMs) : { ok: false, stopped: 'readonly' };
    s = getSession();
    if (!s || s.state !== 'active') return { ok: false, stopped: 'readonly' };
  } else {
    // Retour du réseau / premier plan : l'attente de transport est levée (le réseau
    // vient de revenir), sauf un Retry-After demandé par Storo.
    const meta = getSyncMeta();
    const resume = reason === 'online' || reason === 'foreground';
    if (resume && meta.nextTryAt > t0 && !((meta.retryAfterUntil ?? 0) > t0)) updateSyncMeta({ backoffStep: 0, nextTryAt: 0 });
    if (getSyncMeta().nextTryAt > t0 && reason !== 'manual') return { ok: false, stopped: 'backoff' };
    if (meStale) {
      const r = await refreshMe();
      if (!r.ok) return r.action.kind === 'transport' ? transportBackoff(r.error, r.action.retryAfterMs) : handleError(r.error);
      s = getSession();
      if (!s || s.state !== 'active') return { ok: false, stopped: 'readonly' };
    }
  }

  // Téléphone attribué à un membre depuis le dernier /device/me : saisies refusées « aucun membre » renvoyées.
  if (wasAttributed === null && getMe()?.attributedMemberId) unparkNoAttributedMember();

  const token = await getToken();
  if (!token) return { ok: false, stopped: 'no_session' };
  if (isPairingInProgress()) return { ok: false, stopped: 'busy' };

  // Données d'une autre organisation (association interrompue) : jamais mélangées.
  const dataOrg = getSyncMeta().orgId;
  if (dataOrg !== null && dataOrg !== s.orgId) clearForOrgSwitch(s.orgId);

  const mig = await tickMigration();
  if (!mig.ok && mig.transport) return mig.error.network || (mig.error.status ?? 0) >= 500 || mig.error.status === 429 ? transportBackoff(mig.error, mig.retryAfterMs) : { ok: false, stopped: 'readonly' };

  const pushed = await push(s.apiBase, token, s.orgId);
  if (!pushed.ok && pushed.stopped !== 'error') return pushed;

  const pulled = await pull(s.apiBase, token, s.orgId);
  if (!pulled.ok) return pulled;
  if (!pushed.ok) return pushed;

  const patch: Parameters<typeof updateSyncMeta>[0] = { backoffStep: 0, nextTryAt: 0, retryAfterUntil: undefined, lastOkAt: now(), lastError: undefined };
  if (_lastServerTime) patch.serverOffsetMs = _lastServerTime.serverTime - _lastServerTime.at;
  updateSyncMeta(patch);
  return { ok: true };
}

let _running: Promise<SyncResult> | null = null;
let _again = false;

/**
 * Lance un cycle. Pendant un cycle, un nouvel appel renvoie le cycle en cours
 * et le fait rejouer une fois à la fin.
 */
export function runSync(reason: SyncReason): Promise<SyncResult> {
  if (_running) {
    _again = true;
    return _running;
  }
  _running = (async () => {
    setSyncing(true);
    let result: SyncResult = { ok: false, stopped: 'busy' };
    try {
      let r: SyncReason = reason;
      for (let i = 0; i < 3; i++) {
        _again = false;
        result = await cycle(r);
        if (!_again) break;
        r = r === 'manual' ? 'manual' : 'enqueue';
      }
    } catch (e) {
      console.warn('[storo] Synchronisation interrompue.', e);
      result = { ok: false, stopped: 'error', message: SYNC_ERROR };
    } finally {
      _running = null;
      setSyncing(false);
    }
    return result;
  })();
  return _running;
}

// ── Déclencheurs ───────────────────────────────────────────────────────────

let _foreground = true;
let _lastHeartbeat = 0;
let _enqueueTimer: ReturnType<typeof setTimeout> | null = null;
let _ticker: ReturnType<typeof setInterval> | null = null;
let _stopEnqueue: (() => void) | null = null;

/** AppState : `active` relance un cycle (et une sonde si lecture seule). */
export function notifyAppState(active: boolean): void {
  const was = _foreground;
  _foreground = active;
  if (active && !was) void runSync('foreground');
}

/** NetInfo : passage à « connecté » relance un cycle. */
export function notifyConnectivity(connected: boolean): void {
  const was = isOnline();
  setOnline(connected);
  if (connected && was === false) void runSync('online');
}

async function tick(): Promise<void> {
  if (!_foreground) return;
  const s = getSession();
  if (!s) return;
  const t = now();
  if (s.state === 'active' && t - _lastHeartbeat >= HEARTBEAT_MS) {
    _lastHeartbeat = t;
    await heartbeat();
  }
  const me = getMe();
  if (s.state === 'readonly' && s.readonlyReason !== 'unpaired' && (!me || t - me.fetchedAt >= ME_REFRESH_MS)) void runSync('timer');
  // Session active, quel que soit l'écran : lignes à envoyer (dont les renvois
  // différés) ou attente de transport écoulée → un cycle.
  if (s.state === 'active' && shouldRetry(s.orgId, t)) void runSync('timer');
}

/** Minuterie globale : un cycle est dû (lignes envoyables, ou fin d'une attente après un échec). */
export function shouldRetry(orgId: string, t: number): boolean {
  const meta = getSyncMeta();
  if (meta.nextTryAt > t) return false;
  return meta.nextTryAt > 0 || sendableRows(orgId, t).length > 0;
}

/** Démarrage (après `configureStoro`) : contrôle du jeton, présence, premier cycle, minuteries. */
export function startSyncEngine(): () => void {
  _stopEnqueue?.();
  _stopEnqueue = onEnqueue(() => {
    if (_enqueueTimer) clearTimeout(_enqueueTimer);
    _enqueueTimer = setTimeout(() => {
      _enqueueTimer = null;
      void runSync('enqueue');
    }, ENQUEUE_DEBOUNCE_MS);
  });
  if (_ticker) clearInterval(_ticker);
  _ticker = setInterval(() => { void tick(); }, 60_000);
  void (async () => {
    await checkTokenAtStart();
    _lastHeartbeat = now();
    await heartbeat();
    await runSync('start');
  })();
  return () => {
    _stopEnqueue?.();
    _stopEnqueue = null;
    if (_ticker) clearInterval(_ticker);
    _ticker = null;
    if (_enqueueTimer) clearTimeout(_enqueueTimer);
    _enqueueTimer = null;
  };
}

// ── Effacement (§10.3) ─────────────────────────────────────────────────────

/** « Effacer les données Storo » : seulement hors session active. L'archive du stock local reste. */
export async function eraseStoroData(): Promise<string | null> {
  const s = getSession();
  if (s && s.state === 'active') return "Dissociez d'abord ce téléphone de l'organisation.";
  if (_running) await _running;
  if (!clearAllOrgState()) return "Effacement impossible sur ce téléphone. Réessayez.";
  forgetMigration();
  await dropSession();
  return null;
}
