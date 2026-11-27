/**
 * Correspondances Stocky ↔ Storo (contrat §8) : lignes de `/sync/pull` →
 * types locaux, opérations locales → lignes de `/sync/push`, recherche d'un
 * code, contenu d'une migration. Module pur.
 */
import type { Item } from '../store';

// ── Types locaux de l'espace organisation (§8.5) ───────────────────────────

export type OrgSite = { id: string; name: string; address: string };

export type OrgItem = {
  id: string;
  siteId: string | null;
  sku: string;
  barcode: string | null;
  /** `description` dans Storo. */
  name: string;
  category: string;
  currency: string;
  unitCost: number;
  reorderPoint: number | null;
  /** Dernier stock connu de Storo (`qtyOnHand`, ou `qtyAfter` d'un mouvement envoyé). */
  serverQty: number;
  /** Instant de `serverQty` (ms) : un stock plus ancien ne le remplace pas. */
  serverQtyAt: number;
  updatedAt: number;
};

export type OrgTakeStatus = 'scheduled' | 'in_progress';

export type OrgTake = {
  id: string;
  reference: string;
  siteId: string;
  siteName: string;
  status: OrgTakeStatus;
  scheduledDate: string | null;
  teamLeadId: string | null;
  memberIds: string[];
  totalItems: number;
  countedItems: number;
  updatedAt: number;
  /** Clôturé (ou supprimé) dans Storo alors qu'un comptage local existe : lecture seule. */
  closed?: true;
};

export type OrgCountEntry = {
  qty: number;
  status: 'Compté' | 'Passé';
  rev: number;
  /** Révision envoyée avec succès (`created` / `duplicate`). */
  sentRev?: number;
  /** Quantité de la révision envoyée (affichée si la saisie suivante est abandonnée). */
  sentQty?: number;
  capturedAt: number;
};

export type OrgCount = {
  takeId: string;
  idx: number;
  startedAt: number;
  entries: Record<string /* storoItemId */, OrgCountEntry>;
  /**
   * Plus haute révision émise par article (identifiant client déjà utilisé),
   * conservée quand une saisie est abandonnée : un identifiant n'est jamais
   * réutilisé, même si Storo l'a enregistré sans que la réponse arrive.
   */
  issuedRev?: Record<string /* storoItemId */, number>;
};

// ── Lignes de /sync/push (§8.1, §8.2) ──────────────────────────────────────

export type PushCountEntry = {
  clientId: string;
  stockTakeId: string;
  sku: string;
  countedQty: number;
  description?: string;
  timestamp: number;
};

export type PushMovement = {
  clientId: string;
  itemId: string;
  type: 'reception' | 'sortie';
  qty: number;
  reason: 'stocky';
};

// ── Utilitaires ────────────────────────────────────────────────────────────

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);
const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const numOr = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Format des identifiants client acceptés par Storo. */
export const CLIENT_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

let _seq = 0;
/** Même générateur que `data/store.ts` : `<préfixe><heure base 36>-<séquence>-<aléa>`. */
export function localUid(prefix: string): string {
  _seq = (_seq + 1) % 1_679_616; // 36^4
  return `${prefix}${Date.now().toString(36)}-${_seq.toString(36)}-${Math.random().toString(36).slice(2, 6).padEnd(4, '0')}`;
}

export const countClientId = (deviceId: string, takeId: string, itemId: string, rev: number): string =>
  `${deviceId}:ce:${takeId}:${itemId}:${rev}`;

export const movementClientId = (deviceId: string, uid: string): string => `${deviceId}:mv:${uid}`;

// ── Pull → local (§8.5) ────────────────────────────────────────────────────

export function toOrgSite(row: unknown): OrgSite | null {
  if (!isRecord(row) || typeof row.id !== 'string' || !row.id) return null;
  return { id: row.id, name: str(row.name, row.id), address: str(row.address) };
}

/**
 * Article Storo. `prev` : version locale ; son `serverQty` est gardé s'il est
 * plus récent (`serverQtyAt`) que la ligne reçue (mouvement envoyé entre-temps).
 */
export function toOrgItem(row: unknown, prev?: OrgItem): OrgItem | null {
  if (!isRecord(row) || typeof row.id !== 'string' || !row.id) return null;
  const updatedAt = numOr(row.updatedAt, 0);
  const qty = numOr(row.qtyOnHand, 0);
  const keepLocal = prev !== undefined && prev.serverQtyAt > updatedAt;
  return {
    id: row.id,
    siteId: strOrNull(row.siteId),
    sku: str(row.sku),
    barcode: strOrNull(typeof row.barcode === 'string' ? row.barcode.trim() : null),
    name: str(row.description, str(row.sku)),
    category: str(row.category),
    currency: str(row.currency),
    unitCost: numOr(row.unitCost, 0),
    reorderPoint: numOrNull(row.reorderPoint),
    serverQty: keepLocal ? prev.serverQty : qty,
    serverQtyAt: keepLocal ? prev.serverQtyAt : updatedAt,
    updatedAt,
  };
}

export function toOrgTake(row: unknown): OrgTake | null {
  if (!isRecord(row) || typeof row.id !== 'string' || !row.id) return null;
  const status: OrgTakeStatus = row.status === 'in_progress' ? 'in_progress' : 'scheduled';
  return {
    id: row.id,
    reference: str(row.reference, row.id),
    siteId: str(row.siteId),
    siteName: str(row.siteName),
    status,
    scheduledDate: strOrNull(row.scheduledDate),
    teamLeadId: strOrNull(row.teamLeadId),
    memberIds: Array.isArray(row.memberIds) ? row.memberIds.filter((m): m is string => typeof m === 'string') : [],
    totalItems: numOr(row.totalItems, 0),
    countedItems: numOr(row.countedItems, 0),
    updatedAt: numOr(row.updatedAt, 0),
  };
}

// ── Local → push ───────────────────────────────────────────────────────────

/** Ligne de comptage (§8.1) : horodatage ramené à l'heure du serveur, jamais dans le futur. */
export function countEntryBody(p: {
  clientId: string;
  takeId: string;
  item: Pick<OrgItem, 'sku' | 'name'>;
  qty: number;
  capturedAt: number;
  serverOffsetMs: number;
  now: number;
}): PushCountEntry {
  const ts = Math.min(p.capturedAt + p.serverOffsetMs, p.now + p.serverOffsetMs);
  return {
    clientId: p.clientId,
    stockTakeId: p.takeId,
    sku: p.item.sku,
    countedQty: p.qty,
    ...(p.item.name ? { description: p.item.name.slice(0, 500) } : {}),
    timestamp: Math.round(ts),
  };
}

/** Entrée → `reception` (+n), Sortie → `sortie` (−n) (§8.2). */
export function movementBody(clientId: string, itemId: string, mode: 'Entrée' | 'Sortie', n: number): PushMovement {
  return mode === 'Entrée'
    ? { clientId, itemId, type: 'reception', qty: n, reason: 'stocky' }
    : { clientId, itemId, type: 'sortie', qty: -n, reason: 'stocky' };
}

// ── Recherche d'un code (§8.3) ─────────────────────────────────────────────

/** Clé de comparaison d'un code-barres : UPC-A lu en EAN-13 (zéro en tête, iOS) = UPC-A. */
const barcodeKey = (s: string): string => {
  const t = s.trim();
  return /^0\d{12}$/.test(t) ? t.slice(1) : t;
};

/** Code-barres exact (UPC-A / EAN-13 à zéro en tête confondus), puis SKU (sans casse) parmi les articles du site. */
export function lookupCode(items: readonly OrgItem[], siteId: string | null, code: string): OrgItem | null {
  const c = code.trim();
  if (!c) return null;
  const site = items.filter((i) => i.siteId === siteId);
  const key = barcodeKey(c);
  const byBarcode = site.filter((i) => i.barcode && barcodeKey(i.barcode) === key).sort((a, b) => (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0));
  if (byBarcode.length > 0) return byBarcode[0];
  const low = c.toLowerCase();
  return site.find((i) => i.sku.toLowerCase() === low) ?? null;
}

/** Articles d'un comptage : articles du site, triés par nom puis SKU (§8.1). */
export function takeItems(items: readonly OrgItem[], siteId: string): OrgItem[] {
  return items
    .filter((i) => i.siteId === siteId)
    .sort((a, b) => a.name.localeCompare(b.name, 'fr') || (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0));
}

// ── Migration (§8.4) ───────────────────────────────────────────────────────

export type MigrationItemPayload = {
  localItemId: string;
  name: string;
  sku: string;
  barcode?: string;
  folder: string;
  minQty: number;
  unitPrice: number;
  qty: number;
  serialized: boolean;
};

export type MigrationSource = { app: 'stocky'; appVersion?: string; platform?: string; licensed: boolean };

export type MigrationPayload = { clientId: string; source: MigrationSource; items: MigrationItemPayload[] };

const clampInt = (v: number, max: number) => (Number.isFinite(v) ? Math.min(max, Math.max(0, Math.round(v))) : 0);
const cut = (s: string, max: number) => s.trim().slice(0, max);

/** Un article Stocky → une ligne de migration (champs bornés aux limites de Storo). */
export function migrationItem(i: Item): MigrationItemPayload {
  const barcode = i.barcode ? cut(i.barcode, 64) : '';
  return {
    localItemId: i.id,
    name: cut(i.name, 500) || i.sku,
    sku: cut(i.sku, 120),
    ...(barcode ? { barcode } : {}),
    folder: cut(i.folder ?? '', 120),
    minQty: clampInt(i.min, 1_000_000_000),
    unitPrice: Number.isFinite(i.price) && i.price >= 0 ? i.price : 0,
    qty: clampInt(i.qty, 1_000_000_000),
    serialized: i.serialized === true,
  };
}

export function buildMigrationPayload(items: readonly Item[], clientId: string, source: MigrationSource): MigrationPayload {
  const src: MigrationSource = {
    app: 'stocky',
    ...(source.appVersion ? { appVersion: source.appVersion.slice(0, 64) } : {}),
    ...(source.platform ? { platform: source.platform.slice(0, 64) } : {}),
    licensed: source.licensed,
  };
  return { clientId, source: src, items: items.map(migrationItem) };
}

/** Taille en octets UTF-8 d'une chaîne (sans dépendre de TextEncoder). */
export function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i++; }
    else n += 3;
  }
  return n;
}
