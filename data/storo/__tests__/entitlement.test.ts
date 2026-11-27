import { afterEach, describe, expect, it, vi } from 'vitest';
import { ORG, T0, itemRow, pairActive, reply, seed, setup, type Call, type Reply } from './helpers';

afterEach(() => { vi.restoreAllMocks(); });

const DAY = 24 * 60 * 60 * 1000;
const empty = { serverTime: T0, cursor: 'c-end', hasMore: false, sites: { upserts: [], deleted: [] }, stockTakes: { upserts: [], deleted: [] }, items: { upserts: [], deleted: [] } };

/** Session active dont le dernier /device/me annonce un abonnement mobile jusqu'à `until`. */
async function paired(until: number | null, handler?: (c: Call) => Reply | Promise<Reply>, offsetMs = 0) {
  const env = await setup(handler ? { handler } : { handler: () => { throw new Error('offline'); } });
  await pairActive(env);
  seed(env, [itemRow('i1')]);
  const k = env.kv.ORG_KEYS;
  env.mem.set(k.me, JSON.stringify({ attributedMemberId: 'member-1', entitlements: { stocklyMobile: true, stocklyMobileValidUntil: until }, fetchedAt: env.clock.now() }));
  const sync = JSON.parse(env.mem.get(k.sync) ?? '{}');
  env.mem.set(k.sync, JSON.stringify({ ...sync, serverOffsetMs: offsetMs }));
  env.session.reloadSession();
  env.orgStore.reloadOrgStore();
  return env;
}

describe('offline expiry of the stockly_mobile entitlement', () => {
  it('stays writable before the cached end date and with an open-ended entitlement', async () => {
    const env = await paired(T0 + DAY);
    expect(env.session.isOrgWritable()).toBe(true);
    expect(env.outbox.enqueueMovement('i1', 'Entrée', 1)).toBeNull();

    const open = await paired(null);
    open.clock.advance(365 * DAY);
    expect(open.session.isOrgWritable()).toBe(true);
    expect(await open.session.checkEntitlementExpiry()).toBe(false);
  });

  it('refuses writes once the cached end date has passed, without any network answer', async () => {
    const env = await paired(T0 + DAY);
    env.clock.advance(DAY);
    expect(env.session.isOrgWritable()).toBe(false);
    expect(env.outbox.enqueueMovement('i1', 'Entrée', 1)).not.toBeNull();
    expect(env.outbox.recordCount('t1', 'i1', 2, 'Compté')).not.toBeNull();
    expect(env.orgStore.getOutboxRows()).toHaveLength(0);
  });

  it('uses the server clock offset seen at the last /device/me', async () => {
    // Téléphone en retard de 2 h sur Storo : l'expiration suit l'heure du serveur.
    const env = await paired(T0 + DAY, undefined, 2 * 60 * 60 * 1000);
    env.clock.advance(DAY - 60 * 60 * 1000);
    expect(env.session.isOrgWritable()).toBe(false);
  });

  it('a sync cycle while offline records the read-only state with the end date', async () => {
    const env = await paired(T0 + DAY);
    env.clock.advance(DAY + 1);
    await env.sync.runSync('timer');
    const s = env.session.getSession();
    expect(s?.state).toBe('readonly');
    expect(s?.readonlyReason).toBe('entitlement');
    expect(s?.readonlyDetails).toMatchObject({ feature: 'stockly_mobile', expiredAt: T0 + DAY });
  });

  it('a renewed entitlement from Storo makes the workspace writable again', async () => {
    let renewed = false;
    const env = await paired(T0 + DAY, (c) => {
      if (!renewed) throw new Error('offline');
      if (c.path === '/device/me') return reply(200, { attributedMemberId: 'member-1', organization: { id: ORG, name: 'Pharmacie du Port' }, entitlements: { stocklyMobile: true, stocklyMobileValidUntil: T0 + 40 * DAY }, serverTime: env.clock.now() });
      if (c.path.startsWith('/sync/pull')) return reply(200, empty);
      return reply(200, { serverTime: env.clock.now(), countEntries: [], movements: [] });
    });
    env.clock.advance(DAY + 1);
    await env.sync.runSync('timer');
    expect(env.session.getSessionState()).toBe('readonly');

    renewed = true;
    await env.sync.runSync('online');
    expect(env.session.getSessionState()).toBe('active');
    expect(env.session.isOrgWritable()).toBe(true);
  });

  it('probes Storo on the next timer cycle right after a local expiry (renewed meanwhile)', async () => {
    const calls: string[] = [];
    const env = await paired(T0 + DAY, (c) => {
      calls.push(c.path);
      if (c.path === '/device/me') return reply(200, { attributedMemberId: 'member-1', organization: { id: ORG, name: 'Pharmacie du Port' }, entitlements: { stocklyMobile: true, stocklyMobileValidUntil: T0 + 40 * DAY }, serverTime: env.clock.now() });
      if (c.path.startsWith('/sync/pull')) return reply(200, empty);
      return reply(200, { serverTime: env.clock.now(), countEntries: [], movements: [] });
    });
    // /device/me lu 5 min avant la fin (moins de 15 min) : seule la fin d'abonnement justifie la sonde.
    env.clock.advance(DAY - 5 * 60_000);
    env.mem.set(env.kv.ORG_KEYS.me, JSON.stringify({ attributedMemberId: 'member-1', entitlements: { stocklyMobile: true, stocklyMobileValidUntil: T0 + DAY }, fetchedAt: env.clock.now() }));
    env.session.reloadSession();
    env.clock.advance(5 * 60_000 + 1);
    expect(await env.session.checkEntitlementExpiry()).toBe(true);
    expect(env.session.expiryProbeDue()).toBe(true);
    await env.sync.runSync('timer');
    expect(calls).toContain('/device/me');
    expect(env.session.getSessionState()).toBe('active');
    expect(env.session.expiryProbeDue()).toBe(false);
  });

  it('setting the phone clock back offline does not postpone the expiry', async () => {
    const env = await paired(T0 + DAY);
    env.clock.advance(DAY - 60_000);
    await env.session.checkEntitlementExpiry(); // heure vue : T0 + DAY - 1 min
    env.clock.advance(2 * 60_000);
    expect(env.session.isOrgWritable()).toBe(false);
    env.session.noteServerTime();
    env.clock.set(T0); // horloge du téléphone reculée d'un jour
    expect(env.session.isOrgWritable()).toBe(false);
  });

  it('a /device/me answer resets the highest server time seen', async () => {
    const env = await paired(T0 + DAY, (c) => {
      if (c.path === '/device/me') return reply(200, { attributedMemberId: 'member-1', organization: { id: ORG, name: 'Pharmacie du Port' }, entitlements: { stocklyMobile: true, stocklyMobileValidUntil: T0 + DAY }, serverTime: T0 });
      return reply(404);
    });
    // Horloge du téléphone en avance par erreur : heure vue trop loin.
    env.orgStore.updateSyncMeta({ serverTimeSeen: T0 + 2 * DAY });
    expect(env.session.isOrgWritable()).toBe(false);
    await env.session.refreshMe();
    expect(env.orgStore.getSyncMeta().serverTimeSeen).toBe(T0);
    expect(env.session.isOrgWritable()).toBe(true);
  });
});
