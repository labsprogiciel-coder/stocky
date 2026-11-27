/**
 * Classement des erreurs Storo (contrat §7.5) et messages en français (§10.4).
 */
import type { ApiError } from './client';

export type ReadonlyReason = 'unpaired' | 'device_inactive' | 'org_suspended' | 'entitlement';

export type ErrorAction =
  /** Réseau, délai, 5xx, 429 : attente (`retryAfterMs` pour un 429), état conservé. */
  | { kind: 'transport'; retryAfterMs?: number }
  /** 401 sans `details.header` : jeton refusé, téléphone dissocié. */
  | { kind: 'readonly'; reason: ReadonlyReason; details: Record<string, unknown> }
  /** 403 `ENTITLEMENT_REQUIRED max_devices` (association) : message, aucun changement d'état. */
  | { kind: 'max_devices' }
  /** 403 `FORBIDDEN` avec `details.permission` (refus de l'organisation). */
  | { kind: 'permission'; permission: string }
  /** 403 `FORBIDDEN device_kind` (migration). */
  | { kind: 'device_kind' }
  /** 403 `FORBIDDEN no_attributed_member`. */
  | { kind: 'no_attributed_member' }
  /** Erreur propre à l'appel (400, 404, 409, 422, autre 403…) : traitée par l'appelant. */
  | { kind: 'call'; status: number | null; code: string; reason?: string };

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** Retry-After par défaut d'un 429 sans en-tête. */
export const DEFAULT_RETRY_AFTER_S = 60;

export function classify(e: ApiError): ErrorAction {
  if (e.network || e.status === null) return { kind: 'transport' };
  if (e.status === 429 || e.code === 'RATE_LIMITED') {
    return { kind: 'transport', retryAfterMs: (e.retryAfterS ?? DEFAULT_RETRY_AFTER_S) * 1000 };
  }
  if (e.status >= 500) return { kind: 'transport' };
  if (e.status === 401) {
    // X-User-Authorization refusé : le jeton de l'appareil reste valable (Stocky ne l'envoie pas).
    if (str(e.details.header)) return { kind: 'call', status: e.status, code: e.code, ...(e.reason ? { reason: e.reason } : {}) };
    return { kind: 'readonly', reason: 'unpaired', details: e.details };
  }
  if (e.status === 403) {
    if (e.code === 'ORG_SUSPENDED') return { kind: 'readonly', reason: 'org_suspended', details: e.details };
    if (e.code === 'ENTITLEMENT_REQUIRED') {
      if (str(e.details.feature) === 'max_devices') return { kind: 'max_devices' };
      return { kind: 'readonly', reason: 'entitlement', details: e.details };
    }
    if (e.code === 'FORBIDDEN') {
      if (e.reason === 'device_inactive') return { kind: 'readonly', reason: 'device_inactive', details: e.details };
      if (e.reason === 'device_kind') return { kind: 'device_kind' };
      if (e.reason === 'no_attributed_member') return { kind: 'no_attributed_member' };
      const permission = str(e.details.permission);
      if (permission) return { kind: 'permission', permission };
    }
  }
  return { kind: 'call', status: e.status, code: e.code, ...(e.reason ? { reason: e.reason } : {}) };
}

export const NETWORK_MESSAGE = 'Pas de connexion au serveur Storo. Nouvel essai automatique.';

const num = (v: unknown): string => (typeof v === 'number' && Number.isFinite(v) ? String(v) : '?');

/** Premier message de champ de `details.fields` (erreur de validation). */
function firstField(details: Record<string, unknown>): string | null {
  const f = details.fields;
  if (typeof f !== 'object' || f === null) return null;
  for (const v of Object.values(f as Record<string, unknown>)) if (typeof v === 'string' && v) return v;
  return null;
}

/** Message français d'une erreur Storo (code, raison, détails). */
export function frMessage(code: string, reason?: string, details: Record<string, unknown> = {}, retryAfterS?: number): string {
  const feature = str(details.feature);
  switch (code) {
    case 'NETWORK':
    case 'TIMEOUT':
      return NETWORK_MESSAGE;
    case 'ENTITLEMENT_REQUIRED':
      if (feature === 'max_devices') {
        return `Nombre maximal d'appareils atteint pour cette organisation (${num(details.current)}/${num(details.limit)}).`;
      }
      return "L'abonnement de l'organisation n'inclut pas l'application mobile Stocky.";
    case 'INSUFFICIENT_STOCK':
      return `Stock insuffisant dans Storo (disponible : ${num(details.available)}).`;
    case 'CONFLICT':
      if (reason === 'stock_take_closed') return 'Ce comptage a été clôturé dans Storo : la saisie n\'a pas été enregistrée.';
      return `Erreur Storo (${code}).`;
    case 'FORBIDDEN':
      if (reason === 'no_attributed_member') return "Ce téléphone n'est attribué à aucun membre dans Storo.";
      if (reason === 'device_kind') return "Ce téléphone n'est pas enregistré comme Stocky.";
      if (reason === 'device_inactive') return 'Ce téléphone est désactivé dans Storo.';
      return `Erreur Storo (${code}).`;
    case 'NOT_FOUND':
      return 'Article ou comptage introuvable dans Storo (supprimé ?).';
    case 'IDEMPOTENCY_MISMATCH':
      return 'Opération en conflit avec une opération déjà envoyée.';
    case 'VALIDATION': {
      const f = firstField(details);
      return f ? `Donnée refusée par Storo : ${f}.` : 'Donnée refusée par Storo.';
    }
    case 'RATE_LIMITED':
      return `Trop de demandes, nouvel essai dans ${retryAfterS ?? DEFAULT_RETRY_AFTER_S} s.`;
    case 'UNAVAILABLE':
    case 'INTERNAL':
      return 'Storo est momentanément indisponible. Nouvel essai automatique.';
    case 'ORG_SUSPENDED':
      return "L'organisation est suspendue dans Storo.";
    case 'UNAUTHENTICATED':
      return "Ce téléphone n'est plus associé à Storo.";
    default:
      return `Erreur Storo (${code}).`;
  }
}

/** Message d'une `ApiError` (réseau, délai, 5xx compris). */
export function errorMessage(e: ApiError): string {
  if (e.network || e.status === null) return NETWORK_MESSAGE;
  if (e.status >= 500 && e.code !== 'RATE_LIMITED') return frMessage('UNAVAILABLE');
  return frMessage(e.code, e.reason, e.details, e.retryAfterS);
}

/** Ligne « Détails » (petite, discrète) : code et identifiant de requête. */
export function errorDetailsLine(e: { code: string; requestId?: string }): string {
  return e.requestId ? `Détails : ${e.code} · ${e.requestId}` : `Détails : ${e.code}`;
}
