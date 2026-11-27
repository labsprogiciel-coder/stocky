/**
 * Stockage et dépendances de plateforme de l'espace organisation (Storo).
 *
 * Module pur : les implémentations natives (MMKV `stockly-org`,
 * expo-secure-store, `fetch`, informations du téléphone) sont injectées au
 * démarrage par `data/storo/native.ts` (`configureKv`, `configureStoro`).
 * Sans elles (tests Node), tout fonctionne en mémoire.
 */
import { DEFAULT_STORO_ALLOWED_HOSTS, DEFAULT_STORO_API_BASE } from '../../constants/storo';

/** Clés de l'instance MMKV `stockly-org` (JSON). */
export const ORG_KEYS = {
  session: 'v1.org.session',
  me: 'v1.org.me',
  workspace: 'v1.org.workspace',
  siteId: 'v1.org.siteId',
  sync: 'v1.org.sync',
  sites: 'v1.org.data.sites',
  items: 'v1.org.data.items',
  takes: 'v1.org.data.takes',
  counts: 'v1.org.counts',
  outbox: 'v1.org.outbox',
  migration: 'v1.org.migration',
  archive: 'v1.org.archive',
  /** Journal d'une écriture en plusieurs clés (`orgStore.ts`). */
  txn: 'v1.org.txn',
} as const;

/** Seul secret : le jeton de l'appareil (expo-secure-store). */
export const TOKEN_KEY = 'stockly.storo.deviceToken';

/** Stockage clé/valeur synchrone (MMKV ou mémoire). Les méthodes peuvent lever. */
export interface OrgKv {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
  remove(key: string): void;
}

/** Stockage sécurisé asynchrone (Keychain / Keystore ou mémoire). */
export interface SecureKv {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export function createMemoryKv(): OrgKv & { dump(): Record<string, string> } {
  const map = new Map<string, string>();
  return {
    get: (k) => map.get(k),
    set: (k, v) => { map.set(k, v); },
    remove: (k) => { map.delete(k); },
    dump: () => Object.fromEntries(map),
  };
}

export function createMemorySecure(): SecureKv {
  const map = new Map<string, string>();
  return {
    get: async (k) => map.get(k) ?? null,
    set: async (k, v) => { map.set(k, v); },
    remove: async (k) => { map.delete(k); },
  };
}

let _kv: OrgKv = createMemoryKv();
let _secure: SecureKv = createMemorySecure();
let _persistent = false;

export function configureKv(opts: { kv?: OrgKv; secure?: SecureKv; persistent?: boolean }): void {
  if (opts.kv) _kv = opts.kv;
  if (opts.secure) _secure = opts.secure;
  if (opts.persistent !== undefined) _persistent = opts.persistent;
}

export const orgKv = (): OrgKv => _kv;
export const secureKv = (): SecureKv => _secure;
/** `true` si les données de l'organisation survivent au redémarrage. */
export const isOrgPersistent = (): boolean => _persistent;

/** Lit une valeur JSON ; `fallback` si absente, illisible ou rejetée par `isValid`. Ne lève jamais. */
export function readJSON<T>(key: string, fallback: T, isValid?: (v: unknown) => boolean): T {
  try {
    const raw = _kv.get(key);
    if (raw === undefined) return fallback;
    const v: unknown = JSON.parse(raw);
    if (isValid && !isValid(v)) return fallback;
    return v as T;
  } catch {
    return fallback;
  }
}

/** Écrit une valeur JSON (`undefined` = suppression). `false` si l'écriture a échoué. */
export function writeJSON(key: string, value: unknown): boolean {
  try {
    if (value === undefined) _kv.remove(key);
    else _kv.set(key, JSON.stringify(value));
    return true;
  } catch (e) {
    console.warn(`[storo] Écriture impossible (${key}).`, e);
    return false;
  }
}

export function removeKey(key: string): boolean {
  return writeJSON(key, undefined);
}

// ── Dépendances de plateforme ──────────────────────────────────────────────

export type FetchLike = (url: string, init: {
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}) => Promise<{
  status: number;
  ok: boolean;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

/** Informations envoyées à l'association (§6.2). `serialNumber` null : code du téléphone illisible. */
export type DeviceInfo = {
  serialNumber: string | null;
  model: string;
  appVersion?: string;
  platform?: string;
};

export type StoroPlatform = {
  fetch: FetchLike;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  deviceInfo: () => DeviceInfo;
  apiBase: string;
  allowedHosts: readonly string[];
};

const defaultFetch: FetchLike = (url, init) => {
  const f = (globalThis as { fetch?: unknown }).fetch;
  if (typeof f !== 'function') return Promise.reject(new Error('fetch indisponible'));
  return (f as FetchLike)(url, init);
};

const DEFAULT_PLATFORM: StoroPlatform = {
  fetch: defaultFetch,
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  deviceInfo: () => ({ serialNumber: null, model: 'Téléphone Stocky' }),
  apiBase: DEFAULT_STORO_API_BASE,
  allowedHosts: DEFAULT_STORO_ALLOWED_HOSTS,
};

let _platform: StoroPlatform = { ...DEFAULT_PLATFORM };

/** Injecte les dépendances de plateforme (seules les clés fournies changent). */
export function configureStoro(p: Partial<StoroPlatform>): void {
  _platform = { ..._platform, ...p };
}

/** Pour les tests : revient aux dépendances par défaut. */
export function resetStoroPlatform(): void {
  _platform = { ...DEFAULT_PLATFORM };
}

export const platform = (): StoroPlatform => _platform;
export const now = (): number => _platform.now();
