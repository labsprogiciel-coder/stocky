/**
 * Outils communs des tests Storo : modules rechargés à neuf à chaque test
 * (`vi.resetModules`), stockage en mémoire, horloge et `fetch` simulés.
 */
import { vi } from 'vitest';
import type { FetchLike } from '../kv';

export type Call = { method: string; path: string; url: string; headers: Record<string, string>; body?: string; json?: unknown };
export type Reply = { status: number; body?: unknown; headers?: Record<string, string>; raw?: string } | 'network' | 'hang';
export type Handler = (c: Call) => Reply | Promise<Reply>;

export const API = 'https://storo.test/api/v1';
export const ORG = '01JORGAAAAAAAAAAAAAAAAAAAA';
export const DEVICE = '01JDEVICEAAAAAAAAAAAAAAAAA';
export const SITE = '01JSITEAAAAAAAAAAAAAAAAAAA';
export const T0 = 1_764_720_000_000;

export function reply(status: number, body?: unknown, headers?: Record<string, string>): Reply {
  return { status, body, headers };
}

export function apiError(status: number, code: string, details: Record<string, unknown> = {}, headers?: Record<string, string>): Reply {
  return { status, body: { error: { code, message: code, details, requestId: 'req-1' } }, headers };
}

export function makeFetch(handler: Handler) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    const path = url.startsWith(API) ? url.slice(API.length) : url;
    let json: unknown;
    try { json = init.body ? JSON.parse(init.body) : undefined; } catch { json = undefined; }
    const call: Call = { method: init.method, path, url, headers: init.headers, ...(init.body !== undefined ? { body: init.body } : {}), json };
    calls.push(call);
    const r = await handler(call);
    if (r === 'network') throw new TypeError('Network request failed');
    if (r === 'hang') {
      return new Promise((_, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    }
    const text = r.raw ?? (r.body === undefined ? '' : JSON.stringify(r.body));
    const hdrs = new Map(Object.entries(r.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    return {
      status: r.status,
      ok: r.status >= 200 && r.status < 300,
      headers: { get: (n: string) => hdrs.get(n.toLowerCase()) ?? null },
      text: async () => text,
    };
  };
  return { fetch, calls };
}

export async function setup(opts: { handler?: Handler; now?: number; serial?: string | null } = {}) {
  vi.resetModules();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const kv = await import('../kv');
  const mem = kv.createMemoryKv();
  const sec = kv.createMemorySecure();
  kv.configureKv({ kv: mem, secure: sec });
  let t = opts.now ?? T0;
  const clock = { now: () => t, set: (v: number) => { t = v; }, advance: (ms: number) => { t += ms; } };
  let handler: Handler = opts.handler ?? (() => reply(404, { error: { code: 'NOT_FOUND', message: 'x', details: {} } }));
  const f = makeFetch((c) => handler(c));
  kv.configureStoro({
    fetch: f.fetch,
    now: () => t,
    sleep: async () => {},
    deviceInfo: () => ({ serialNumber: opts.serial === undefined ? '7K3D-9QXA-M2PV-H8TC' : opts.serial, model: 'Pixel 8', appVersion: '1.0.0', platform: 'android 14' }),
    apiBase: API,
    allowedHosts: ['storo.test'],
  });
  const [client, errors, session, orgStore, outbox, mapping, sync, migration, store] = await Promise.all([
    import('../client'),
    import('../errors'),
    import('../session'),
    import('../orgStore'),
    import('../outbox'),
    import('../mapping'),
    import('../sync'),
    import('../migration'),
    import('../../store'),
  ]);
  return {
    kv, mem, sec, clock, calls: f.calls,
    setHandler: (h: Handler) => { handler = h; },
    client, errors, session, orgStore, outbox, mapping, sync, migration, store,
  };
}

export type Env = Awaited<ReturnType<typeof setup>>;

/** Session `active` déjà associée (jeton en stockage sécurisé), `/device/me` récent. */
export async function pairActive(env: Env, extra: { attributed?: string | null } = {}) {
  const { kv, mem, sec } = env;
  mem.set(kv.ORG_KEYS.session, JSON.stringify({
    apiBase: API, deviceId: DEVICE, orgId: ORG, orgName: 'Pharmacie du Port', serialNumber: '7K3D-9QXA-M2PV-H8TC', pairedAt: T0, state: 'active',
  }));
  mem.set(kv.ORG_KEYS.me, JSON.stringify({
    attributedMemberId: extra.attributed === undefined ? 'member-1' : extra.attributed, entitlements: { stocklyMobile: true }, fetchedAt: env.clock.now(),
  }));
  mem.set(kv.ORG_KEYS.sync, JSON.stringify({ orgId: ORG, cursor: null, lastPullAt: null, lastPushAt: null, lastOkAt: null, backoffStep: 0, nextTryAt: 0, serverOffsetMs: 0 }));
  await sec.set(kv.TOKEN_KEY, 'tok-1');
  env.session.reloadSession();
  env.orgStore.reloadOrgStore();
}

export const siteRow = (id = SITE, name = 'Dépôt central') => ({ id, name, address: 'Rue 1', type: 'warehouse', updatedAt: T0 });
export const itemRow = (id: string, p: Record<string, unknown> = {}) => ({
  id, sku: `SKU-${id}`, barcode: null, description: `Article ${id}`, siteId: SITE, category: 'Cat', currency: 'XOF', unitCost: 100,
  qtyOnHand: 10, reorderPoint: null, updatedAt: T0, ...p,
});
export const takeRow = (id: string, p: Record<string, unknown> = {}) => ({
  id, reference: `ST-${id}`, siteId: SITE, siteName: 'Dépôt central', status: 'in_progress', scheduledDate: '2026-11-27',
  teamLeadId: 'member-1', memberIds: [], totalItems: 2, countedItems: 0, industryConfig: {}, updatedAt: T0, ...p,
});

/** Charge un site, des articles et des comptages dans le cache de l'organisation. */
export function seed(env: Env, items: Record<string, unknown>[] = [itemRow('i1'), itemRow('i2')], takes: Record<string, unknown>[] = [takeRow('t1')]) {
  env.orgStore.applyPullPage({ sites: { upserts: [siteRow()] }, items: { upserts: items }, stockTakes: { upserts: takes }, cursor: 'c1' }, ORG, env.clock.now());
  env.orgStore.setCurrentSiteId(SITE);
}
