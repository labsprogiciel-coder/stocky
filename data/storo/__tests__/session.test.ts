import { afterEach, describe, expect, it, vi } from 'vitest';
import { API, DEVICE, ORG, T0, apiError, pairActive, reply, seed, setup, type Call } from './helpers';

afterEach(() => { vi.restoreAllMocks(); });

const ME = { device: { status: 'active' }, organization: { id: ORG, name: 'Pharmacie du Port', currency: 'XOF' }, attributedMemberId: 'm1', entitlements: { stocklyMobile: true }, serverTime: T0 + 5000 };

const otpCreated = { sessionId: 's1', otp: '7K3MQ9XA', otpDisplay: '7K3M-Q9XA', pollSecret: 'secret', expiresAt: T0 + 900_000, pollIntervalMs: 3000 };

describe('OTP pairing', () => {
  it('happy path: shows the code, polls, stores the token and the session, then calls /device/me', async () => {
    let polls = 0;
    const env = await setup({
      handler: (c: Call) => {
        if (c.path === '/device-pairing/otp') return reply(201, otpCreated);
        if (c.path === '/device-pairing/otp/status') {
          polls++;
          return polls === 1 ? reply(200, { status: 'pending', expiresAt: otpCreated.expiresAt, pollIntervalMs: 3000 })
            : reply(200, { status: 'claimed', deviceId: DEVICE, orgId: ORG, apiBase: API, deviceToken: 'tok-new', tokenDelivered: false });
        }
        if (c.path === '/device/me') return reply(200, ME);
        return reply(404);
      },
    });
    const r = await env.session.requestOtp();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.otp.otpDisplay).toBe('7K3M-Q9XA');
    expect(env.calls[0].json).toEqual({ serialNumber: '7K3D-9QXA-M2PV-H8TC', model: 'Pixel 8', kind: 'stockly_mobile', appVersion: '1.0.0', platform: 'android 14' });

    expect(await env.session.pollOtp(r.otp)).toEqual({ status: 'pending', nextPollMs: 3000 });
    expect(env.calls[1].headers['X-Poll-Secret']).toBe('secret');
    const claimed = await env.session.pollOtp(r.otp);
    expect(claimed).toEqual({ status: 'claimed', outcome: { kind: 'paired' } });

    expect(await env.sec.get(env.kv.TOKEN_KEY)).toBe('tok-new');
    const s = env.session.getSession();
    expect(s).toMatchObject({ deviceId: DEVICE, orgId: ORG, apiBase: API, state: 'active', orgName: 'Pharmacie du Port' });
    const me = env.calls.find((c) => c.path === '/device/me');
    expect(me?.headers.Authorization).toBe('Device tok-new');
    expect(env.orgStore.getSyncMeta()).toMatchObject({ orgId: ORG, serverOffsetMs: 5000 });
  });

  it('expired status and 404 both mean "Code expiré"', async () => {
    const env = await setup({ handler: () => reply(200, { status: 'expired' }) });
    const otp = { ...otpCreated, apiBase: API };
    expect(await env.session.pollOtp(otp)).toEqual({ status: 'expired' });
    env.setHandler(() => apiError(404, 'NOT_FOUND'));
    expect(await env.session.pollOtp(otp)).toEqual({ status: 'expired' });
  });

  it('429 and network errors keep polling', async () => {
    const env = await setup({ handler: () => apiError(429, 'RATE_LIMITED', {}, { 'Retry-After': '7' }) });
    const otp = { ...otpCreated, apiBase: API };
    expect(await env.session.pollOtp(otp)).toMatchObject({ status: 'retry', nextPollMs: 7000 });
    env.setHandler(() => 'network');
    expect(await env.session.pollOtp(otp)).toMatchObject({ status: 'retry', nextPollMs: 3000 });
  });

  it('claimed without a token and none stored: "Association interrompue"', async () => {
    const env = await setup({ handler: () => reply(200, { status: 'claimed', deviceId: DEVICE, orgId: ORG, apiBase: API, deviceToken: null, tokenDelivered: true }) });
    const r = await env.session.pollOtp({ ...otpCreated, apiBase: API });
    expect(r).toEqual({ status: 'failed', message: env.session.PAIRING_INTERRUPTED });
    expect(env.session.getSession()).toBeNull();
  });

  it('refuses locally without a phone code', async () => {
    const env = await setup({ serial: null });
    expect(await env.session.requestOtp()).toEqual({ ok: false, message: env.session.PHONE_CODE_UNAVAILABLE });
    expect(env.calls).toHaveLength(0);
  });
});

describe('QR pairing', () => {
  const qr = (p: Record<string, unknown> = {}) => JSON.stringify({ app: 'storo', v: 2, kind: 'pair', apiBase: API, token: 'pt', expiresAt: T0 + 300_000, ...p });

  it('parses and checks the payload, host allowlist and expiry', async () => {
    const env = await setup();
    const parse = (t: string) => env.session.parsePairingQr(t, ['storo.test'], T0);
    expect(parse(qr())).toEqual({ ok: true, qr: { apiBase: API, token: 'pt', expiresAt: T0 + 300_000 } });
    expect(parse('hello')).toEqual({ ok: false, error: env.session.QR_NOT_STORO });
    expect(parse(qr({ app: 'other' }))).toEqual({ ok: false, error: env.session.QR_NOT_STORO });
    expect(parse(qr({ v: 1 }))).toEqual({ ok: false, error: env.session.QR_NOT_STORO });
    expect(parse(qr({ kind: 'login' }))).toEqual({ ok: false, error: env.session.QR_NOT_STORO });
    expect(parse(qr({ apiBase: 'http://storo.test/api/v1' }))).toEqual({ ok: false, error: env.session.QR_NOT_STORO });
    expect(parse(qr({ apiBase: 'https://evil.example/api/v1' }))).toEqual({ ok: false, error: 'Serveur Storo non reconnu : evil.example' });
    expect(parse(qr({ expiresAt: T0 - 1 }))).toEqual({ ok: false, error: env.session.QR_EXPIRED });
  });

  it('claims against the QR apiBase and retries once after a network error', async () => {
    let n = 0;
    const env = await setup({
      handler: (c) => {
        if (c.path === '/device-pairing/qr/claim') { n++; return n === 1 ? 'network' : reply(201, { deviceId: DEVICE, deviceToken: 'tok-qr', orgId: ORG, apiBase: API }); }
        if (c.path === '/device/me') return reply(200, ME);
        return reply(404);
      },
    });
    const out = await env.session.claimQr({ apiBase: API, token: 'pt', expiresAt: null });
    expect(out).toEqual({ kind: 'paired' });
    const claims = env.calls.filter((c) => c.path === '/device-pairing/qr/claim');
    expect(claims).toHaveLength(2);
    expect(claims[0].body).toBe(claims[1].body);
    expect(claims[0].json).toMatchObject({ token: 'pt', kind: 'stockly_mobile', serialNumber: '7K3D-9QXA-M2PV-H8TC' });
    expect(await env.sec.get(env.kv.TOKEN_KEY)).toBe('tok-qr');
  });

  it('404: expired or already used', async () => {
    const env = await setup({ handler: () => apiError(404, 'NOT_FOUND') });
    expect(await env.session.claimQr({ apiBase: API, token: 'pt', expiresAt: null })).toEqual({ kind: 'error', message: 'QR code expiré ou déjà utilisé.' });
  });

  it('asks for confirmation when data of another organisation exists', async () => {
    const env = await setup({
      handler: (c) => {
        if (c.path === '/device-pairing/qr/claim') return reply(201, { deviceId: 'D2', deviceToken: 'tok-b', orgId: 'ORG-B', apiBase: API });
        if (c.path === '/device/me') return reply(200, { ...ME, organization: { id: 'ORG-B', name: 'Org B' } });
        return reply(404);
      },
    });
    await pairActive(env);
    seed(env);
    const out = await env.session.claimQr({ apiBase: API, token: 'pt', expiresAt: null });
    expect(out.kind).toBe('confirm');
    if (out.kind !== 'confirm') return;
    expect(out).toMatchObject({ oldOrgName: 'Pharmacie du Port', newOrgName: 'Org B' });
    await out.cancel();
    expect(await env.sec.get(env.kv.TOKEN_KEY)).toBe('tok-1');
    expect(env.session.getSession()?.orgId).toBe(ORG);

    const again = await env.session.claimQr({ apiBase: API, token: 'pt', expiresAt: null });
    if (again.kind !== 'confirm') throw new Error('confirm expected');
    expect(await again.confirm()).toEqual({ kind: 'paired' });
    expect(env.session.getSession()?.orgId).toBe('ORG-B');
    expect(env.orgStore.getAllOrgItems()).toHaveLength(0);
    expect(env.orgStore.getSyncMeta().orgId).toBe('ORG-B');
  });
});

describe('session states', () => {
  it('401 → readonly/unpaired, token deleted after the state is saved, outbox kept', async () => {
    const env = await setup({ handler: () => apiError(401, 'UNAUTHENTICATED', { reason: 'revoked' }) });
    await pairActive(env);
    seed(env);
    expect(env.outbox.enqueueMovement('i1', 'Entrée', 2)).toBeNull();
    env.clock.advance(1_000_000);
    const r = await env.session.refreshMe();
    expect(r.ok).toBe(false);
    expect(env.session.getSession()).toMatchObject({ state: 'readonly', readonlyReason: 'unpaired' });
    expect(JSON.parse(env.mem.get(env.kv.ORG_KEYS.session)!)).toMatchObject({ readonlyReason: 'unpaired' });
    expect(await env.sec.get(env.kv.TOKEN_KEY)).toBeNull();
    expect(env.orgStore.getOutboxRows()).toHaveLength(1);
    expect(env.session.getWorkspace()).toBe('standalone'); // choix non fait
  });

  it.each([
    [apiError(403, 'FORBIDDEN', { reason: 'device_inactive', status: 'maintenance' }), 'device_inactive'],
    [apiError(403, 'ORG_SUSPENDED'), 'org_suspended'],
    [apiError(403, 'ENTITLEMENT_REQUIRED', { feature: 'stockly_mobile' }), 'entitlement'],
  ])('403 → readonly (%#) and keeps the token', async (err, reason) => {
    const env = await setup({ handler: () => err });
    await pairActive(env);
    await env.session.refreshMe();
    expect(env.session.getSession()).toMatchObject({ state: 'readonly', readonlyReason: reason });
    expect(await env.sec.get(env.kv.TOKEN_KEY)).toBe('tok-1');
    expect(env.session.isOrgWritable()).toBe(false);
  });

  it('/device/me with stocklyMobile false → readonly/entitlement; probe 200 → active', async () => {
    const env = await setup({ handler: () => reply(200, { ...ME, entitlements: { stocklyMobile: false } }) });
    await pairActive(env);
    await env.session.refreshMe();
    expect(env.session.getSession()).toMatchObject({ state: 'readonly', readonlyReason: 'entitlement' });
    env.setHandler(() => reply(200, ME));
    await env.session.refreshMe();
    expect(env.session.getSession()?.state).toBe('active');
    expect(env.session.getSession()?.readonlyReason).toBeUndefined();
  });

  it('a missing token at start-up → unpaired', async () => {
    const env = await setup();
    await pairActive(env);
    await env.sec.remove(env.kv.TOKEN_KEY);
    env.session.reloadSession();
    await env.session.checkTokenAtStart();
    expect(env.session.getSession()).toMatchObject({ state: 'readonly', readonlyReason: 'unpaired' });
  });

  it('Dissocier keeps the outbox and the workspace data', async () => {
    const env = await setup();
    await pairActive(env);
    seed(env);
    env.outbox.enqueueMovement('i1', 'Entrée', 1);
    await env.session.unpair();
    expect(env.session.getSessionState()).toBe('readonly');
    expect(await env.sec.get(env.kv.TOKEN_KEY)).toBeNull();
    expect(env.orgStore.getOutboxRows()).toHaveLength(1);
    expect(env.orgStore.getSiteItems(env.orgStore.getCurrentSiteId())).toHaveLength(2);
  });
});
