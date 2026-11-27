/**
 * Synchronisation avec Storo (contrat : `docs/STOCKY_SYNC.md` du dépôt Storo, §7.6).
 *
 * Module pur (aucun import natif) : les valeurs de `app.json > expo.extra`
 * (`storoApiBase`, `storoAllowedHosts`) sont lues par `data/storo/native.ts`
 * et transmises via `configureStoro()`. Les valeurs ci-dessous ne servent que
 * de repli (tests, configuration absente).
 */

/** Serveur Storo utilisé pour l'association par code (OTP), sauf configuration `app.json`. */
export const DEFAULT_STORO_API_BASE = 'https://storo.progiciellabs.xyz/api/v1';

/** Hôtes acceptés dans un QR code d'association (le QR fournit lui-même son `apiBase`). */
export const DEFAULT_STORO_ALLOWED_HOSTS: readonly string[] = ['storo.progiciellabs.xyz', 'storo.labsprogiciel.workers.dev', 'storo-preview.labsprogiciel.workers.dev'];

export const REQUEST_TIMEOUT_MS = 20_000;
export const MIGRATION_TIMEOUT_MS = 60_000;
export const PULL_LIMIT = 500;
export const PUSH_MAX_ENTRIES = 200;
export const PUSH_MAX_MOVEMENTS = 50;
export const ORG_TIMER_MS = 60_000;
export const TAKE_TIMER_MS = 30_000;
export const ME_REFRESH_MS = 900_000;
export const HEARTBEAT_MS = 300_000;
export const MIGRATION_POLL_MS = 30_000;
export const ROW_MAX_ATTEMPTS = 8;
export const OUTBOX_CAP = 5000;
export const MAX_MIGRATION_ITEMS = 1000;
export const MAX_MIGRATION_BYTES = 524_288;

/** Attente avant de réessayer après une erreur réseau, 5xx ou 429 (dernière valeur = plafond). */
export const TRANSPORT_BACKOFF_MS: readonly number[] = [5_000, 30_000, 120_000, 600_000];
/** Attente avant de renvoyer une ligne refusée avec `INTERNAL`. */
export const ROW_BACKOFF_MS: readonly number[] = [30_000, 120_000, 600_000, 1_800_000];

/** Délai entre une opération enregistrée et la synchronisation qu'elle déclenche. */
export const ENQUEUE_DEBOUNCE_MS = 2_000;
/** QR : délai avant l'unique nouvel essai après une erreur réseau ou 5xx. */
export const QR_RETRY_DELAY_MS = 3_000;
/** Nombre maximal de pages lues par synchronisation (garde-fou). */
export const PULL_MAX_PAGES = 200;
