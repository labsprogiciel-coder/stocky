/**
 * « Scanner une boîte » : liaison entre l'analyse de l'étiquette
 * (`data/boxLabel.ts`, module pur) et le stock (`data/store.ts`).
 *
 * L'ajout passe par `addUnit` : mêmes validations, limite de la version
 * gratuite (`limit: 'units'`) et journal d'écriture que la saisie manuelle.
 */
import { analyzeBoxSession, type BoxAnalysis, type BoxSession } from './boxLabel';
import { addUnit, findItemByCode, findUnitByCode, getItem, type Item, type UnitResult } from './store';
import { NOTE_MAX_LENGTH, type Unit } from './units';

/** Analyse de la session, avec les codes-barres / SKU des articles enregistrés. */
export function analyzeBoxForStore(s: BoxSession): BoxAnalysis {
  return analyzeBoxSession(s, { itemName: (c) => findItemByCode(c)?.name });
}

/** Article cible déduit du code produit de la boîte. */
export type BoxArticle =
  /** Aucun code produit lu. */
  | { kind: 'none' }
  /** Article suivi par numéro de série : cible de l'ajout. */
  | { kind: 'serialized'; item: Item; code: string }
  /** Article suivi en quantité : aucun appareil ne peut y être ajouté. */
  | { kind: 'quantity'; item: Item; code: string; message: string }
  /** Code produit lu, mais aucun article ne le porte. */
  | { kind: 'unknown'; code: string; message: string };

/**
 * Résout l'article à partir du code produit (EAN/UPC) de la boîte, puis, à
 * défaut, d'un autre code de l'étiquette égal au code-barres ou au SKU d'un
 * article (hors numéro de série retenu).
 */
export function resolveBoxArticle(a: BoxAnalysis): BoxArticle {
  const codes: string[] = [];
  if (a.ean) codes.push(a.ean);
  for (const f of a.fields) {
    if (f.role === 'imei' || (a.serial && f.id === a.serial.id)) continue;
    if (!codes.includes(f.value)) codes.push(f.value);
  }
  let quantity: BoxArticle | null = null;
  for (const code of codes) {
    const item = findItemByCode(code);
    if (!item) continue;
    if (item.serialized) return { kind: 'serialized', item, code };
    if (!quantity) quantity = {
      kind: 'quantity',
      item,
      code,
      message: `« ${item.name} » est suivi en quantité : activez « Suivi par numéro de série » dans l'article pour enregistrer ses appareils, ou choisissez un autre article.`,
    };
  }
  if (quantity) return quantity;
  if (a.ean) return { kind: 'unknown', code: a.ean, message: `Code produit ${a.ean} inconnu : choisissez l'article de cet appareil.` };
  return { kind: 'none' };
}

const deviceLabel = (u: Unit) => {
  const name = getItem(u.itemId)?.name;
  return `Appareil déjà enregistré : ${u.serial}${name ? ` · ${name}` : ''}`;
};

/**
 * Numéro de série ou IMEI de la boîte déjà enregistré : message à afficher
 * (`null` si aucun).
 */
export function boxDuplicateError(a: BoxAnalysis): string | null {
  for (const code of [a.serial?.value, a.imei1, a.imei2]) {
    if (!code) continue;
    const u = findUnitByCode(code);
    if (u) return deviceLabel(u);
  }
  return null;
}

export const BOX_IMEI2_PREFIX = 'IMEI 2 : ';

/**
 * Note de l'appareil : note existante, puis « IMEI 2 : … ». Au-delà de
 * `NOTE_MAX_LENGTH`, la note existante est raccourcie (l'IMEI 2 est gardé entier).
 */
export function boxNote(imei2: string | null, existing?: string): string | undefined {
  const base = (existing ?? '').trim();
  if (!imei2) return base || undefined;
  const tail = `${BOX_IMEI2_PREFIX}${imei2}`;
  if (base.includes(tail)) return base.slice(0, NOTE_MAX_LENGTH);
  if (!base) return tail;
  const sep = ' · ';
  const room = NOTE_MAX_LENGTH - tail.length - sep.length;
  if (room <= 1) return tail;
  const head = base.length > room ? `${base.slice(0, room - 1).trimEnd()}…` : base;
  return `${head}${sep}${tail}`;
}

/**
 * Ajoute l'appareil de la boîte à l'article `itemId` : numéro de série retenu,
 * IMEI 1 (champ IMEI), IMEI 2 dans la note, statut « En stock ».
 */
export function addDeviceFromBox(itemId: string, a: BoxAnalysis, opts: { note?: string } = {}): UnitResult {
  if (!a.serial) return { error: "Choisissez le numéro de série de l'appareil (touchez le bon code).", field: 'serial' };
  const dup = boxDuplicateError(a);
  if (dup) return { error: dup, field: 'serial' };
  const note = boxNote(a.imei2, opts.note);
  return addUnit(itemId, {
    serial: a.serial.value,
    ...(a.imei1 ? { imei: a.imei1 } : {}),
    status: 'in_stock',
    ...(note ? { note } : {}),
  });
}
