/**
 * Suivi par numéro de série : types, libellés et règles de normalisation.
 *
 * Module pur (aucune dépendance) : partagé par `data/store.ts` et
 * `data/assetsCsv.ts`, et réexporté par `data/store.ts`.
 *
 * Un article « suivi par numéro de série » (`Item.serialized`) est composé
 * d'unités (`Unit`), une par appareil, identifiées par leur numéro de série
 * (et, pour un téléphone, leur IMEI). C'est le modèle de Jira Service
 * Management Assets : un objet par appareil, clé = numéro de série.
 */

export type UnitStatus = 'in_stock' | 'assigned' | 'repair' | 'retired' | 'missing';

export type Unit = {
  id: string;
  itemId: string;
  /** Numéro de série tel que saisi (espaces de bordure retirés). */
  serial: string;
  /** IMEI normalisé : 15 chiffres, clé de Luhn valide. */
  imei?: string;
  status: UnitStatus;
  /** Personne à qui l'appareil est attribué (présent seulement si `status === 'assigned'`). */
  assignee?: string;
  note?: string;
  /** Date de réception (epoch ms). */
  receivedAt: number;
  /** Dernière modification (epoch ms). */
  updatedAt: number;
};

/** Statuts, dans l'ordre d'affichage. */
export const UNIT_STATUSES: readonly UnitStatus[] = ['in_stock', 'assigned', 'repair', 'retired', 'missing'];

/** Libellés français (interface). */
export const UNIT_STATUS_LABELS: Readonly<Record<UnitStatus, string>> = {
  in_stock: 'En stock',
  assigned: 'Attribué',
  repair: 'En réparation',
  retired: 'Retiré',
  missing: 'Manquant',
};

/** Libellés anglais attendus par l'import Jira Service Management Assets. */
export const UNIT_STATUS_JIRA_LABELS: Readonly<Record<UnitStatus, string>> = {
  in_stock: 'In Stock',
  assigned: 'Assigned',
  repair: 'In Repair',
  retired: 'Retired',
  missing: 'Missing',
};

export const SERIAL_MAX_LENGTH = 64;
export const ASSIGNEE_MAX_LENGTH = 100;
export const NOTE_MAX_LENGTH = 500;

export function isUnitStatus(v: unknown): v is UnitStatus {
  return typeof v === 'string' && (UNIT_STATUSES as readonly string[]).includes(v);
}

/** Clé de comparaison d'un numéro de série : sans espaces, en majuscules. */
export function serialKey(s: string): string {
  return s.trim().replace(/\s+/g, '').toUpperCase();
}

/** IMEI débarrassé des espaces et tirets (ne vérifie pas le format). */
export function imeiDigits(s: string): string {
  return s.replace(/[\s-]+/g, '');
}

/** Clé de contrôle de Luhn valide (chaîne de chiffres). */
export function luhnValid(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let sum = 0;
  // En partant de la droite, un chiffre sur deux (à partir de l'avant-dernier) est doublé.
  for (let i = 0; i < digits.length; i++) {
    let d = digits.charCodeAt(digits.length - 1 - i) - 48;
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/** IMEI normalisé valide : exactement 15 chiffres et clé de Luhn correcte. */
export function isValidImei(v: unknown): v is string {
  return typeof v === 'string' && /^\d{15}$/.test(v) && luhnValid(v);
}

/**
 * Valide et normalise un IMEI saisi. Renvoie `{ imei }` (15 chiffres) ou un
 * message d'erreur en français.
 */
export function normalizeImei(input: string): { imei: string; error?: undefined } | { imei?: undefined; error: string } {
  const d = imeiDigits(input.trim());
  if (!/^\d+$/.test(d)) return { error: "L'IMEI ne doit contenir que des chiffres." };
  if (d.length !== 15) return { error: `L'IMEI doit comporter exactement 15 chiffres (${d.length} saisi${d.length > 1 ? 's' : ''}).` };
  if (!luhnValid(d)) return { error: "IMEI invalide : le dernier chiffre (clé de contrôle) est incorrect. Vérifiez la saisie." };
  return { imei: d };
}

/**
 * Valide un numéro de série saisi (hors unicité). Renvoie le numéro nettoyé
 * (espaces de bordure retirés) ou un message d'erreur en français.
 */
export function normalizeSerial(input: string): { serial: string; error?: undefined } | { serial?: undefined; error: string } {
  const serial = input.trim();
  if (!serial) return { error: 'Le numéro de série est obligatoire.' };
  if (serial.length > SERIAL_MAX_LENGTH) return { error: `Le numéro de série ne doit pas dépasser ${SERIAL_MAX_LENGTH} caractères.` };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(serial)) return { error: 'Le numéro de série contient des caractères invalides.' };
  return { serial };
}

/**
 * Texte sans accents (comparaisons « insensibles aux accents » : noms
 * d'articles et en-têtes de l'import Excel). `normalize` dépend de l'ICU du
 * moteur JavaScript : s'il est absent ou lève, repli sur les lettres
 * accentuées courantes du français.
 */
export function foldAccents(s: string): string {
  try {
    return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  } catch {
    return s.replace(/[àâäáãå]/g, 'a').replace(/[ÀÂÄÁÃÅ]/g, 'A').replace(/[éèêë]/g, 'e').replace(/[ÉÈÊË]/g, 'E')
      .replace(/[îïíì]/g, 'i').replace(/[ÎÏÍÌ]/g, 'I').replace(/[ôöóòõ]/g, 'o').replace(/[ÔÖÓÒÕ]/g, 'O')
      .replace(/[ûüúù]/g, 'u').replace(/[ÛÜÚÙ]/g, 'U').replace(/ç/g, 'c').replace(/Ç/g, 'C').replace(/ñ/g, 'n').replace(/Ñ/g, 'N')
      .replace(/ÿ/g, 'y').replace(/œ/g, 'oe').replace(/Œ/g, 'OE').replace(/æ/g, 'ae').replace(/Æ/g, 'AE');
  }
}
