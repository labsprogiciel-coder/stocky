/**
 * Client HTTP de l'API Storo (`/api/v1`), sur le `fetch` injecté
 * (`configureStoro`). Ne lève jamais : renvoie une réponse `ok` ou une
 * `ApiError` (enveloppe `{ error: { code, message, details, requestId } }`,
 * erreur réseau ou délai dépassé).
 */
import { REQUEST_TIMEOUT_MS } from '../../constants/storo';
import { platform } from './kv';

export type ApiOk<T> = {
  ok: true;
  status: number;
  data: T;
  headers: { get(name: string): string | null };
};

export type ApiError = {
  ok: false;
  /** `null` : aucune réponse (réseau, délai). */
  status: number | null;
  code: string;
  reason?: string;
  details: Record<string, unknown>;
  message: string;
  requestId?: string;
  retryAfterS?: number;
  network?: true;
  timeout?: true;
};

export type ApiResult<T> = ApiOk<T> | ApiError;

export type RequestOpts = {
  method?: 'GET' | 'POST';
  /** Objet (sérialisé en JSON) ou chaîne déjà sérialisée, envoyée telle quelle. */
  body?: unknown;
  token?: string | null;
  idempotencyKey?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Joint la base (`https://…/api/v1`) et un chemin (`/device/me`). */
export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

function parseRetryAfter(v: string | null): number | undefined {
  if (!v) return undefined;
  const n = Number(v.trim());
  if (Number.isFinite(n) && n >= 0) return Math.ceil(n);
  const at = Date.parse(v);
  if (Number.isFinite(at)) return Math.max(0, Math.ceil((at - Date.now()) / 1000));
  return undefined;
}

function fallbackCode(status: number): string {
  if (status === 401) return 'UNAUTHENTICATED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status === 429) return 'RATE_LIMITED';
  if (status === 503) return 'UNAVAILABLE';
  if (status >= 500) return 'INTERNAL';
  return `HTTP_${status}`;
}

export async function apiRequest<T = unknown>(base: string, path: string, opts: RequestOpts = {}): Promise<ApiResult<T>> {
  const method = opts.method ?? (opts.body === undefined ? 'GET' : 'POST');
  const headers: Record<string, string> = { Accept: 'application/json', ...(opts.headers ?? {}) };
  let body: string | undefined;
  if (opts.body !== undefined) {
    body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
    headers['Content-Type'] = 'application/json';
  }
  if (opts.token) headers.Authorization = `Device ${opts.token}`;
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;

  const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const Ctrl = (globalThis as { AbortController?: typeof AbortController }).AbortController;
  const ctrl = Ctrl ? new Ctrl() : null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => {
      ctrl?.abort();
      resolve('timeout');
    }, timeoutMs);
  });

  try {
    const res = await Promise.race([
      platform().fetch(joinUrl(base, path), { method, headers, ...(body !== undefined ? { body } : {}), ...(ctrl ? { signal: ctrl.signal } : {}) }),
      timeout,
    ]);
    if (res === 'timeout') {
      return { ok: false, status: null, code: 'TIMEOUT', details: {}, message: 'Request timed out', network: true, timeout: true };
    }
    const text = await Promise.race([res.text(), timeout]);
    if (text === 'timeout') {
      return { ok: false, status: null, code: 'TIMEOUT', details: {}, message: 'Request timed out', network: true, timeout: true };
    }
    let json: unknown = undefined;
    if (text.length > 0) {
      try { json = JSON.parse(text); } catch { json = undefined; }
    }
    const requestId = res.headers.get('X-Request-Id') ?? undefined;
    if (res.ok) {
      if (json === undefined && text.length > 0) {
        return { ok: false, status: res.status, code: 'BAD_RESPONSE', details: {}, message: 'Invalid JSON response', ...(requestId ? { requestId } : {}) };
      }
      return { ok: true, status: res.status, data: json as T, headers: res.headers };
    }
    const env = isRecord(json) && isRecord(json.error) ? json.error : null;
    const details = env && isRecord(env.details) ? env.details : {};
    const code = env && typeof env.code === 'string' ? env.code : fallbackCode(res.status);
    const reason = typeof details.reason === 'string' ? details.reason : undefined;
    const rid = env && typeof env.requestId === 'string' ? env.requestId : requestId;
    const retryAfterS = parseRetryAfter(res.headers.get('Retry-After'));
    return {
      ok: false,
      status: res.status,
      code,
      ...(reason !== undefined ? { reason } : {}),
      details,
      message: env && typeof env.message === 'string' ? env.message : `HTTP ${res.status}`,
      ...(rid ? { requestId: rid } : {}),
      ...(retryAfterS !== undefined ? { retryAfterS } : {}),
    };
  } catch (e) {
    return { ok: false, status: null, code: 'NETWORK', details: {}, message: e instanceof Error ? e.message : String(e), network: true };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
