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
 * Résout l'article à partir du code produit (EAN/UPC) de la boîte : s'il est
 * le code-barres ou le SKU d'un article, cet article l'emporte (suivi en
 * quantité : message). Sinon seulement, un autre code de l'étiquette égal au
 * code-barres ou au SKU d'un article (hors numéro de série retenu ; un article
 * suivi par numéro de série est préféré).
 */
export function resolveBoxArticle(a: BoxAnalysis): BoxArticle {
  const quantityOf = (item: Item, code: string): BoxArticle => ({
    kind: 'quantity',
    item,
    code,
    message: `« ${item.name} » est suivi en quantité : activez « Suivi par numéro de série » dans l'article pour enregistrer ses appareils, ou choisissez un autre article.`,
  });
  if (a.ean) {
    const primary = findItemByCode(a.ean);
    if (primary) return primary.serialized ? { kind: 'serialized', item: primary, code: a.ean } : quantityOf(primary, a.ean);
  }
  const codes: string[] = [];
  for (const f of a.fields) {
    if (f.role === 'imei' || (a.serial && f.id === a.serial.id) || f.value === a.ean) continue;
    if (!codes.includes(f.value)) codes.push(f.value);
  }
  let quantity: BoxArticle | null = null;
  for (const code of codes) {
    const item = findItemByCode(code);
    if (!item) continue;
    if (item.serialized) return { kind: 'serialized', item, code };
    if (!quantity) quantity = quantityOf(item, code);
  }
  if (quantity) return quantity;
  if (a.ean) return { kind: 'unknown', code: a.ean, message: `Code produit ${a.ean} inconnu : choisissez l'article de cet appareil.` };
  return { kind: 'none' };
}

/**
 * Article cible de l'ajout : l'article choisi (`chosenId`, s'il est suivi par
 * numéro de série), sinon celui du code produit, sinon — boîte sans code
 * produit ni code d'article — l'article déduit de la boîte précédente
 * (`autoId`). `null` si aucun.
 */
export function boxTargetItem(resolved: BoxArticle, chosenId: string | null, autoId: string | null): Item | null {
  if (chosenId) {
    const chosen = getItem(chosenId);
    return chosen?.serialized ? chosen : null;
  }
  if (resolved.kind === 'serialized') return resolved.item;
  if (resolved.kind === 'none' && autoId) {
    const auto = getItem(autoId);
    return auto?.serialized ? auto : null;
  }
  return null;
}

const deviceLabel = (u: Unit) => {
  const name = getItem(u.itemId)?.name;
  return `Appareil déjà enregistré : ${u.serial}${name ? ` · ${name}` : ''}`;
};

/**
 * Numéro de série, IMEI 1 ou IMEI 2 de la boîte déjà enregistré (comme
 * numéro de série, IMEI 1 ou IMEI 2 d'un appareil) : message à afficher
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

/**
 * IMEI de l'appareil : IMEI 1 (champ « IMEI ») et IMEI 2 (champ « IMEI 2 »,
 * téléphone double SIM). Choix documenté : un IMEI 2 lu sans IMEI 1 devient
 * l'IMEI 1 (l'analyse de l'étiquette le fait déjà ; répété ici par sûreté),
 * puisqu'un IMEI 2 seul est refusé par `addUnit`. Un IMEI 2 égal à l'IMEI 1
 * est ignoré.
 */
export function boxImeis(a: Pick<BoxAnalysis, 'imei1' | 'imei2'>): { imei?: string; imei2?: string } {
  const imei = a.imei1 || a.imei2 || undefined;
  const imei2 = a.imei1 && a.imei2 && a.imei2 !== a.imei1 ? a.imei2 : undefined;
  return { ...(imei ? { imei } : {}), ...(imei2 ? { imei2 } : {}) };
}

/**
 * Ajoute l'appareil de la boîte à l'article `itemId` : numéro de série retenu,
 * IMEI 1 et IMEI 2 dans leurs champs (`boxImeis`), statut « En stock ». La
 * note saisie (`opts.note`) est enregistrée telle quelle (l'IMEI 2 n'y est
 * plus ajouté), raccourcie seulement au-delà de `NOTE_MAX_LENGTH`.
 */
export function addDeviceFromBox(itemId: string, a: BoxAnalysis, opts: { note?: string } = {}): UnitResult {
  if (!a.serial) return { error: "Choisissez le numéro de série de l'appareil (touchez le bon code).", field: 'serial' };
  const dup = boxDuplicateError(a);
  if (dup) return { error: dup, field: 'serial' };
  const raw = opts.note?.trim() ?? '';
  const note = raw.length > NOTE_MAX_LENGTH ? `${raw.slice(0, NOTE_MAX_LENGTH - 1).trimEnd()}…` : raw;
  return addUnit(itemId, {
    serial: a.serial.value,
    ...boxImeis(a),
    status: 'in_stock',
    ...(note ? { note } : {}),
  });
}
