import { describe, expect, it } from 'vitest';
import type { ApiError } from '../client';
import { classify, errorMessage, frMessage, NETWORK_MESSAGE } from '../errors';

const e = (status: number | null, code: string, details: Record<string, unknown> = {}, extra: Partial<ApiError> = {}): ApiError => ({
  ok: false, status, code, details, message: code,
  ...(typeof details.reason === 'string' ? { reason: details.reason } : {}),
  ...(status === null ? { network: true as const } : {}),
  ...extra,
});

describe('classify (§7.5)', () => {
  it('network and timeout → transport', () => {
    expect(classify(e(null, 'NETWORK'))).toEqual({ kind: 'transport' });
    expect(classify(e(null, 'TIMEOUT', {}, { timeout: true }))).toEqual({ kind: 'transport' });
  });
  it('5xx and 503 UNAVAILABLE → transport', () => {
    expect(classify(e(500, 'INTERNAL'))).toEqual({ kind: 'transport' });
    expect(classify(e(503, 'UNAVAILABLE'))).toEqual({ kind: 'transport' });
  });
  it('429 → transport with Retry-After (default 60 s)', () => {
    expect(classify(e(429, 'RATE_LIMITED', {}, { retryAfterS: 12 }))).toEqual({ kind: 'transport', retryAfterMs: 12_000 });
    expect(classify(e(429, 'RATE_LIMITED'))).toEqual({ kind: 'transport', retryAfterMs: 60_000 });
  });
  it('401 → unpaired, except a bad X-User-Authorization', () => {
    expect(classify(e(401, 'UNAUTHENTICATED', { reason: 'revoked' }))).toMatchObject({ kind: 'readonly', reason: 'unpaired' });
    expect(classify(e(401, 'UNAUTHENTICATED', { header: 'X-User-Authorization' }))).toMatchObject({ kind: 'call' });
  });
  it('403 variants', () => {
    expect(classify(e(403, 'FORBIDDEN', { reason: 'device_inactive', status: 'lost' }))).toMatchObject({ kind: 'readonly', reason: 'device_inactive', details: { status: 'lost' } });
    expect(classify(e(403, 'ORG_SUSPENDED'))).toMatchObject({ kind: 'readonly', reason: 'org_suspended' });
    expect(classify(e(403, 'ENTITLEMENT_REQUIRED', { feature: 'stockly_mobile' }))).toMatchObject({ kind: 'readonly', reason: 'entitlement' });
    expect(classify(e(403, 'ENTITLEMENT_REQUIRED', { feature: 'max_devices', limit: 2, current: 2 }))).toEqual({ kind: 'max_devices' });
    expect(classify(e(403, 'FORBIDDEN', { permission: 'inventory.read' }))).toEqual({ kind: 'permission', permission: 'inventory.read' });
    expect(classify(e(403, 'FORBIDDEN', { reason: 'device_kind' }))).toEqual({ kind: 'device_kind' });
    expect(classify(e(403, 'FORBIDDEN', { reason: 'no_attributed_member' }))).toEqual({ kind: 'no_attributed_member' });
  });
  it('400 / 404 / 409 / 422 are left to the call', () => {
    for (const [s, c] of [[400, 'VALIDATION'], [404, 'NOT_FOUND'], [409, 'CONFLICT'], [409, 'IDEMPOTENCY_MISMATCH'], [422, 'INSUFFICIENT_STOCK']] as const) {
      expect(classify(e(s, c))).toMatchObject({ kind: 'call', status: s, code: c });
    }
  });
});

describe('frMessage (§10.4)', () => {
  it('uses the contract texts', () => {
    expect(frMessage('NETWORK')).toBe(NETWORK_MESSAGE);
    expect(frMessage('ENTITLEMENT_REQUIRED', undefined, { feature: 'stockly_mobile' })).toBe("L'abonnement de l'organisation n'inclut pas l'application mobile Stocky.");
    expect(frMessage('ENTITLEMENT_REQUIRED', undefined, { feature: 'max_devices', current: 2, limit: 2 })).toBe("Nombre maximal d'appareils atteint pour cette organisation (2/2).");
    expect(frMessage('INSUFFICIENT_STOCK', undefined, { available: 1 })).toBe('Stock insuffisant dans Storo (disponible : 1).');
    expect(frMessage('CONFLICT', 'stock_take_closed')).toBe("Ce comptage a été clôturé dans Storo : la saisie n'a pas été enregistrée.");
    expect(frMessage('FORBIDDEN', 'no_attributed_member')).toBe("Ce téléphone n'est attribué à aucun membre dans Storo.");
    expect(frMessage('NOT_FOUND')).toBe('Article ou comptage introuvable dans Storo (supprimé ?).');
    expect(frMessage('IDEMPOTENCY_MISMATCH')).toBe('Opération en conflit avec une opération déjà envoyée.');
    expect(frMessage('VALIDATION', undefined, { fields: { countedQty: 'must be ≥ 0' } })).toBe('Donnée refusée par Storo : must be ≥ 0.');
    expect(frMessage('RATE_LIMITED', undefined, {}, 9)).toBe('Trop de demandes, nouvel essai dans 9 s.');
    expect(frMessage('UNAVAILABLE')).toBe('Storo est momentanément indisponible. Nouvel essai automatique.');
    expect(frMessage('WHATEVER')).toBe('Erreur Storo (WHATEVER).');
  });
  it('errorMessage handles network and 5xx', () => {
    expect(errorMessage(e(null, 'NETWORK'))).toBe(NETWORK_MESSAGE);
    expect(errorMessage(e(502, 'HTTP_502'))).toBe('Storo est momentanément indisponible. Nouvel essai automatique.');
  });
});
