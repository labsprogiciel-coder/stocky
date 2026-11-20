/**
 * « Scanner une boîte » : analyse des codes-barres d'une étiquette de boîte.
 *
 * L'étiquette d'une boîte d'appareil porte souvent plusieurs codes : numéro de
 * série, IMEI 1, IMEI 2, code produit EAN/UPC, référence / modèle… Le scanner
 * les lit tous (la caméra lit tout le champ) ; ce module attribue à chacun un
 * rôle et propose le numéro de série le plus probable.
 *
 * Module pur (aucune dépendance React Native) : testable sous Node.
 *
 * Règles GÉNÉRIQUES (aucun réglage par marque à ce stade) : elles seront
 * affinées avec des étiquettes réelles. Les quelques indices par fabricant sont
 * isolés dans `VENDOR_PATTERNS` (bonus faible, facile à compléter).
 *
 * Garanties : déterministe, ne lève jamais, travail borné (`BOX_MAX_CODES`
 * codes, `BOX_MAX_RAW_LENGTH` caractères par code, `BOX_MAX_FIELDS_PER_CODE`
 * champs par code).
 */
import { SERIAL_MAX_LENGTH, imeiDigits, isValidImei, luhnValid, normalizeSerial, serialKey } from './units';

/** Comme `SERIAL_DASH_FORMULA` de `data/store.ts` (refusé par `addUnit`). */
const SERIAL_DASH_FORMULA_RE = /^-.*[=+@(|!&"']/;

// ── Types ──────────────────────────────────────────────────────────────────

/** Code lu (caméra ou saisie). `type` : symbologie renvoyée par la caméra (`code128`, `ean13`, `qr`…). */
export type ScannedCode = { data: string; type?: string };

export type BoxRole = 'imei' | 'ean' | 'serial-candidate' | 'other';

/** Un champ d'un code lu (un code simple = un champ ; un QR multi-lignes = plusieurs). */
export type BoxField = {
  /** Identifiant stable : `<index du code>.<index du champ>` (+ `s` pour la variante sans « S » initial). */
  id: string;
  /** Index du code d'origine dans la liste fournie. */
  codeIndex: number;
  /** Symbologie du code d'origine (minuscules), si connue. */
  symbology?: string;
  /** `true` si le code d'origine contient plusieurs champs (QR, Code 128 multi-champs). */
  multi: boolean;
  /** Clé reconnue (« SN », « IMEI1 », « EAN », « PN »…) ou clé libre en majuscules ; absente sinon. */
  key?: string;
  /** Valeur nettoyée (clé retirée). Un IMEI ou un EAN est réduit à ses chiffres. */
  value: string;
  role: BoxRole;
  /** Score de numéro de série (0 pour un IMEI ou un EAN). Plus haut = plus probable. */
  score: number;
  /** Raison courte, en français. */
  reason: string;
  /** IMEI : emplacement indiqué par la clé (« IMEI1 », « IMEI 2 »). */
  imeiSlot?: 1 | 2;
};

export type BoxAnalysis = {
  fields: BoxField[];
  /** Numéro de série retenu (choix de l'utilisateur, sinon meilleur candidat). */
  serial: BoxField | null;
  serialSource: 'user' | 'auto' | null;
  /** Autres candidats, du plus probable au moins probable. */
  alternatives: BoxField[];
  imei1: string | null;
  imei2: string | null;
  /** IMEI valides au-delà des deux premiers (rares ; non enregistrés). */
  extraImeis: string[];
  /** Premier code produit (EAN/UPC/GTIN), en chiffres. */
  ean: string | null;
  /** Champs sans rôle retenu (rôle `other`, ou candidats non choisis non listés ailleurs). */
  others: BoxField[];
  /** `true` si des codes ou des champs ont été ignorés (limites atteintes). */
  truncated: boolean;
};

export type BoxAnalyzeOptions = {
  /** Nom de l'article dont `code` est le code-barres ou le SKU (sinon `undefined`). */
  itemName?: (code: string) => string | undefined;
  /** Champ choisi par l'utilisateur comme numéro de série. */
  chosenFieldId?: string | null;
};

// ── Limites ────────────────────────────────────────────────────────────────

export const BOX_MAX_CODES = 30;
export const BOX_MAX_RAW_LENGTH = 1024;
export const BOX_MAX_FIELDS_PER_CODE = 16;
/** Score minimal d'un candidat numéro de série (en dessous : rôle `other`). */
export const SERIAL_MIN_SCORE = 30;

// ── Indices par fabricant ──────────────────────────────────────────────────

export type VendorPattern = {
  id: string;
  /** Libellé affiché dans la raison (« format proche de … »). */
  label: string;
  /** Testé sur la valeur en majuscules, sans espaces. */
  re: RegExp;
  /** `low` : +4, `medium` : +8. Jamais décisif seul : départage des candidats proches. */
  confidence: 'low' | 'medium';
};

/**
 * Indices de format de numéros de série, volontairement prudents.
 * TOUS « à vérifier sur étiquettes réelles » avant d'en augmenter le poids.
 * Pour ajouter un fabricant : une ligne ici, et un cas dans les tests.
 */
export const VENDOR_PATTERNS: readonly VendorPattern[] = [
  // Samsung (téléphones, tablettes) : 11 caractères commençant par « R » + chiffre.
  // Vérifié sur une étiquette réelle (Galaxy A07 SM-A075F/DS : R8YL615HTHV).
  { id: 'samsung', label: 'Samsung', re: /^R\d[A-Z0-9]{9}$/, confidence: 'medium' },
  // Dell « Service Tag » : 7 caractères alphanumériques. À vérifier sur étiquettes réelles.
  { id: 'dell', label: 'Dell (Service Tag)', re: /^(?=.*\d)(?=.*[A-Z])[A-Z0-9]{7}$/, confidence: 'low' },
  // HP : 10 caractères, lettres puis chiffres en tête (ex. 5CD1234XYZ, CND1234ABC). À vérifier sur étiquettes réelles.
  { id: 'hp', label: 'HP', re: /^(?:\d[A-Z]{2}|[A-Z]{3})\d{4}[A-Z0-9]{3}$/, confidence: 'low' },
  // Apple : 10 à 12 caractères alphanumériques (anciens 11-12, récents 10 aléatoires).
  // Vérifié sur une étiquette réelle (MacBook Neo : JY9NWR1129, 10 caractères).
  { id: 'apple', label: 'Apple', re: /^(?=.*\d)(?=.*[A-Z])[A-Z0-9]{10,12}$/, confidence: 'low' },
];

const VENDOR_BONUS = { low: 4, medium: 8 } as const;

// ── Outils ─────────────────────────────────────────────────────────────────

/** Symbologies des codes-barres produit (EAN-13/8, UPC-A/E), comme `PRODUCT_SYMBOLOGY` du scanner. */
export const PRODUCT_SYMBOLOGY = /^(ean_?(13|8)|upc_?[ae])$/i;
const LINEAR_SERIAL_SYMBOLOGY = /^code_?(128|39|93)$/i;

/** Clé de contrôle GTIN (EAN-8, UPC-A, EAN-13, GTIN-14) valide. */
export function gtinValid(digits: string): boolean {
  if (!/^(\d{8}|\d{12,14})$/.test(digits)) return false;
  let sum = 0;
  for (let i = 1; i < digits.length; i++) {
    const d = digits.charCodeAt(digits.length - 1 - i) - 48;
    sum += i % 2 === 1 ? d * 3 : d;
  }
  return (10 - (sum % 10)) % 10 === digits.charCodeAt(digits.length - 1) - 48;
}

/**
 * Clé de dédoublonnage d'un code lu : `serialKey` (espaces retirés,
 * majuscules ; tirets gardés). Seule exception, avec la symbologie lue par la
 * caméra (`type`) : un EAN-13 commençant par 0 = l'UPC-A correspondant.
 */
export function boxCodeKey(data: string, type?: string): string {
  const t = typeof data === 'string' ? data.trim() : '';
  // Même clé que les numéros de série du store (espaces retirés, majuscules) :
  // les tirets sont gardés, « 1234-5670 » et « 12345670 » restent distincts
  // même si leurs chiffres forment un GTIN valide.
  const k = serialKey(t);
  // Seule équivalence par les chiffres, sur preuve du type : un UPC-A lu comme
  // EAN-13 (zéro de tête, iOS) est le même code que sa lecture UPC-A (Android).
  if (type && PRODUCT_SYMBOLOGY.test(type) && /^0\d{12}$/.test(k) && gtinValid(k)) return k.slice(1);
  return k;
}

const ctrlRe = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
// Caractères invisibles (espace sans chasse, trait d'union conditionnel, BOM…).
const invisibleRe = /[­​-‏⁠﻿]/g;

/**
 * Normalise un code lu : caractères invisibles retirés, formes pleine chasse
 * (« ＳＮ：Ｒ５８… ») ramenées à l'ASCII. Sans `String.normalize` (ICU absent
 * de certains moteurs).
 */
export function normalizeBoxText(s: string): string {
  return s
    .replace(invisibleRe, '')
    .replace(/　/g, ' ')
    .replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
}

const OPEN_WRAP = '"\'«([';
const CLOSE_WRAP = '"\'»)]';

/** Nettoie une valeur : bordures, guillemets / parenthèses englobants, espaces multiples. Linéaire. */
function cleanValue(s: string): string {
  let v = s.replace(ctrlRe, '').replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 2; i++) {
    if (v.length < 2 || !OPEN_WRAP.includes(v[0]) || !CLOSE_WRAP.includes(v[v.length - 1])) break;
    v = v.slice(1, -1).trim();
  }
  return v;
}

// Clés reconnues (en tête de champ). Ordre : la plus spécifique d'abord.
// Numéro de série : après « : » ou « = », un tiret fait partie de la valeur
// s'il est collé à la suite (« SN: -AB123 » → « -AB123 ») ; suivi d'espaces, c'est
// un séparateur (« SN : - AB123 » → « AB123 »). Sans « : » ni « = », un tiret collé
// ou entouré d'espaces est un séparateur (« SN-AB123 », « SN - AB123 » → « AB123 »).
const KEY_RULES: readonly { key: string; re: RegExp }[] = [
  // « (S) Serial No. », « S/N », « SN », « Serial No », « N° de série », « Numéro de série »…
  { key: 'SN', re: /^(?:\(S\)\s*)?(?:S\/N|SN|SERIAL(?:\s*(?:NO\.?|NUMBER|NUM\.?|N°|#))?|N°\s*DE\s*S[EÉ]RIE|NUM[EÉ]RO\s*DE\s*S[EÉ]RIE|NO\.?\s*DE\s*S[EÉ]RIE)(?=$|[\s:=#.\-])(?:[\s#.]*[:=][\s:=]*(?:-\s+)?|[\s#.\-]*)/i },
  { key: 'MEID', re: /^MEID(?=$|[\s:=#.\d])[\s:=#.]*/i },
  // IMEISV (IMEI + version logicielle, 16 chiffres) : identifiant, pas un numéro de série.
  { key: 'IMEISV', re: /^(?:IMEI\s*SV|SVN)(?=$|[\s:=#.\d])[\s:=#.]*/i },
  { key: 'IMEI', re: /^IMEI(?=$|[\s:=#.\d])/i },
  { key: 'EAN', re: /^(?:EAN(?:\s*-?\s*1[34])?|UPC|GTIN)(?=$|[\s:=#.])[\s:=#.]*/i },
  { key: 'PN', re: /^(?:P\/N|PN|MPN|PART\s*(?:NO\.?|NUMBER|N°)?|PRODUCT\s*(?:NO\.?|NUMBER|N°|#)|R[EÉ]F(?:[EÉ]RENCE)?\.?|SKU|MTM|1P)(?=$|[\s:=#.])[\s:=#.]*/i },
  { key: 'MODEL', re: /^(?:MODEL(?:\s*(?:NO\.?|NUMBER|N°))?|MOD[EÈ]LE)(?=$|[\s:=#.])[\s:=#.]*/i },
  // Lot de fabrication, dates : jamais un numéro de série.
  { key: 'LOT', re: /^(?:LOT(?:\s*(?:NO\.?|N°))?|BATCH)(?=$|[\s:=#.])[\s:=#.]*/i },
  { key: 'DATE', re: /^(?:MFG|MFD|MFG\.?\s*DATE|EXP|DATE|PROD\.?\s*DATE|DATE\s*DE\s*FABRICATION)(?=$|[\s:=#.])[\s:=#.]*/i },
];

/** Clés dont la valeur n'est jamais un numéro de série. */
const NON_SERIAL_KEYS: Readonly<Record<string, string>> = {
  PN: 'Référence / modèle',
  MODEL: 'Référence / modèle',
  LOT: 'Numéro de lot',
  DATE: 'Date',
  IMEISV: 'IMEISV (IMEI + version logicielle)',
  MEID: 'MEID (identifiant réseau, pas un n° de série)',
  GS1: 'Donnée GS1 (lot, quantité…)',
};

// Début de clé connue au milieu d'une ligne (les espaces sont déjà réduits à un seul) :
// « IMEI1:… IMEI2:… SN:… », ou sans « : » : « IMEI1 3569… IMEI2 3569… SN R58… ».
const INLINE_KEY_SPLIT = / (?=(?:IMEI ?[12]?|MEID|S\/N|SN|SERIAL(?: NO\.?)?|EAN|UPC|P\/N|PN|MODEL) ?[:=]|(?:IMEI ?[12]?|MEID) \d|(?:S\/N|SN|SERIAL NO\.?) [A-Z0-9])/i;

// ── GS1 (Code 128 « GS1-128 », DataMatrix GS1) ────────────────────────────

/** Identifiants d'application GS1 reconnus : longueur fixe (nombre) ou variable (`[max]`). */
const GS1_AI: Readonly<Record<string, number | [number]>> = {
  '00': 18, '01': 14, '02': 14, '11': 6, '12': 6, '13': 6, '15': 6, '16': 6, '17': 6, '20': 2,
  '10': [20], '21': [20], '22': [20], '30': [8], '37': [8], '240': [30], '241': [30], '250': [30],
  '90': [30], '91': [90], '92': [90], '93': [90], '94': [90], '95': [90], '96': [90], '97': [90], '98': [90], '99': [90],
};

function gs1Field(ai: string, v: string): Parsed {
  if (ai === '01' || ai === '02') return { key: 'EAN', value: v.startsWith('0') ? v.slice(1) : v };
  if (ai === '21') return { key: 'SN', value: v };
  if (ai === '10') return { key: 'LOT', value: v };
  if (/^1[1-7]$/.test(ai)) return { key: 'DATE', value: v };
  if (ai === '240' || ai === '241') return { key: 'PN', value: v };
  return { key: 'GS1', value: `(${ai}) ${v}` };
}

const gs1Ai = (s: string, i: number): string | null => {
  const two = s.slice(i, i + 2);
  if (GS1_AI[two] !== undefined) return two;
  const three = s.slice(i, i + 3);
  return GS1_AI[three] !== undefined ? three : null;
};

/**
 * Chaîne GS1 : forme lisible « (01)…(21)… » ou forme brute (préfixe « ]C1 » /
 * « ]d2 » / « ]Q3 », séparateur GS \x1d). `null` si ce n'en est pas une. Au-delà
 * de `BOX_MAX_FIELDS_PER_CODE` champs : les champs déjà lus sont gardés et
 * `truncated` vaut `true` (seulement s'il reste des données).
 */
function parseGs1(raw: string): { parts: Parsed[]; truncated: boolean } | null {
  const t = raw.trim();
  if (/^\(\d{2,3}\)/.test(t)) {
    const out: Parsed[] = [];
    const re = /\((\d{2,3})\)([^(]*)/y;
    let m: RegExpExecArray | null;
    let pos = 0;
    while (pos < t.length && (m = re.exec(t))) {
      const ai = m[1];
      const v = m[2].replace(/\s+/g, '');
      const spec = GS1_AI[ai];
      if (spec === undefined || !v) return null;
      if (typeof spec === 'number' ? v.length !== spec || !/^\d+$/.test(v) : v.length > spec[0]) return null;
      out.push(gs1Field(ai, v));
      pos = re.lastIndex;
      if (out.length >= BOX_MAX_FIELDS_PER_CODE && pos < t.length) return { parts: out, truncated: true };
    }
    return out.length > 0 && pos >= t.length ? { parts: out, truncated: false } : null;
  }
  const prefixed = /^\](?:C1|d2|Q3|e0)/.test(t);
  let s = prefixed ? t.slice(3) : t;
  s = s.replace(/^\x1d+/, '');
  // Sans préfixe ni GS : seulement « 01 » + GTIN-14 valide suivi d'autres données.
  if (!prefixed && !s.includes('\x1d') && !(s.length > 16 && /^01\d{14}/.test(s) && gtinValid(s.slice(2, 16)))) return null;
  const out: Parsed[] = [];
  let i = 0;
  while (i < s.length) {
    const ai = gs1Ai(s, i);
    if (!ai) return null;
    const spec = GS1_AI[ai];
    i += ai.length;
    let v: string;
    if (typeof spec === 'number') {
      v = s.slice(i, i + spec);
      if (v.length !== spec || !/^\d+$/.test(v)) return null;
      i += spec;
    } else {
      const end = s.indexOf('\x1d', i);
      v = s.slice(i, end < 0 ? s.length : end);
      if (!v || v.length > spec[0]) return null;
      i = end < 0 ? s.length : end;
    }
    out.push(gs1Field(ai, v));
    while (s[i] === '\x1d') i++;
    if (out.length >= BOX_MAX_FIELDS_PER_CODE && i < s.length) return { parts: out, truncated: true };
  }
  return out.length > 0 ? { parts: out, truncated: false } : null;
}

/** Contenu JSON d'un QR (« {"imei1":"…","sn":"…"} ») : champs « clé:valeur ». `null` sinon. */
function parseJsonFields(raw: string): string[] | null {
  const t = raw.trim();
  if (!(t.startsWith('{') && t.endsWith('}')) && !(t.startsWith('[') && t.endsWith(']'))) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(t);
  } catch {
    return null;
  }
  const out: string[] = [];
  const add = (k: string | null, v: unknown) => {
    if (out.length >= BOX_MAX_FIELDS_PER_CODE + 1) return;
    if (typeof v === 'string' || typeof v === 'number') out.push(k ? `${k}:${String(v)}` : String(v));
  };
  if (Array.isArray(obj)) obj.forEach((v) => add(null, v));
  else if (obj && typeof obj === 'object') for (const [k, v] of Object.entries(obj as Record<string, unknown>)) add(k, v);
  else return null;
  return out;
}

/** QR « fonctionnel » (Wi-Fi, carte de visite, SMS…) : aucun code d'appareil. */
const FUNCTIONAL_QR = /^(?:WIFI:|MECARD:|BEGIN:VCARD|SMSTO:|MATMSG:)/i;

const BOX_TOO_LONG = `Code trop long (${BOX_MAX_RAW_LENGTH} caractères max) : non pris en compte`;
const BOX_FUNCTIONAL_QR = 'QR Wi-Fi / contact ignoré';

/**
 * Code lu à écarter entièrement (jamais dans la session, l'analyse ni la
 * liste) : message court à afficher (sans le contenu du code), sinon `null`.
 * Trop long : plus de `BOX_MAX_RAW_LENGTH` caractères une fois normalisé et
 * débarrassé des espaces de bordure. QR fonctionnel : Wi-Fi (mot de passe),
 * carte de visite, SMS, e-mail.
 */
export function boxCheckCode(data: string): string | null {
  if (typeof data !== 'string') return null;
  const t = normalizeBoxText(data).trim();
  if (t.length > BOX_MAX_RAW_LENGTH) return BOX_TOO_LONG;
  if (FUNCTIONAL_QR.test(t)) return BOX_FUNCTIONAL_QR;
  return null;
}

/** Découpe le contenu d'un code en champs (au plus `BOX_MAX_FIELDS_PER_CODE`). */
function splitFields(raw: string): { parts: (string | Parsed)[]; truncated: boolean } {
  const gs1 = parseGs1(raw);
  if (gs1) return gs1;
  const json = parseJsonFields(raw);
  if (json) return { parts: json.slice(0, BOX_MAX_FIELDS_PER_CODE), truncated: json.length > BOX_MAX_FIELDS_PER_CODE };
  const out: string[] = [];
  let truncated = false;
  for (const seg of raw.split(/[\r\n\t;|,]+/)) {
    for (const p of seg.replace(/\s+/g, ' ').split(INLINE_KEY_SPLIT)) {
      const t = p.trim();
      if (!t) continue;
      if (out.length >= BOX_MAX_FIELDS_PER_CODE) {
        truncated = true;
        break;
      }
      out.push(t);
    }
  }
  return { parts: out, truncated };
}

type Parsed = { key?: string; value: string; imeiSlot?: 1 | 2; imeiKeyInvalid?: boolean };

const isUrl = (s: string) => /^(?:https?:\/\/|www\.)|:\/\//i.test(s);
const isMac = (s: string) => /^[0-9A-F]{2}(?:[:-][0-9A-F]{2}){5}$/i.test(s);

/** Sépare la clé reconnue (ou libre `CLÉ:valeur`) de la valeur. */
function parseField(part: string): Parsed {
  const t = part.trim();
  if (isUrl(t) || isMac(t)) return { value: cleanValue(t) };
  for (const rule of KEY_RULES) {
    const m = rule.re.exec(t);
    if (!m) continue;
    let rest = t.slice(m[0].length);
    if (rule.key === 'IMEI') {
      // « IMEI1:… », « IMEI 2 : … », « IMEI:… », « IMEI1356… » (emplacement collé aux chiffres).
      const slot = /^\s*([12])\s*[:=#.]?\s*(.*)$/.exec(rest);
      const plain = rest.replace(/^[\s:=#.]+/, '');
      if (slot && isValidImei(imeiDigits(slot[2])) && !isValidImei(imeiDigits(plain))) {
        return { key: `IMEI${slot[1]}`, value: imeiDigits(slot[2]), imeiSlot: slot[1] === '1' ? 1 : 2 };
      }
      const slot2 = /^\s*([12])(?=[\s:=#.])[\s:=#.]*(.*)$/.exec(rest);
      if (slot2 && !isValidImei(imeiDigits(plain))) {
        return { key: `IMEI${slot2[1]}`, value: cleanValue(slot2[2]), imeiSlot: slot2[1] === '1' ? 1 : 2 };
      }
      rest = plain;
      return { key: 'IMEI', value: cleanValue(rest) };
    }
    const value = cleanValue(rest);
    if (value) return { key: rule.key, value };
  }
  // Clé libre : « CLÉ: valeur » / « CLÉ=valeur » (clé : lettres d'abord, 24 caractères au plus).
  const free = /^([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ0-9 ./°()_-]{0,23}?)\s*[:=]\s*(\S.*)$/.exec(t);
  if (free) return { key: free[1].trim().toUpperCase(), value: cleanValue(free[2]) };
  return { value: cleanValue(t) };
}

// Références / modèles (à ne pas prendre pour un numéro de série).
const MODEL_HINTS: readonly RegExp[] = [
  /^(?:SM|MZ|GT|SG|EB|EP|EF)-[A-Z0-9]/i, // Samsung : modèles, SSD, accessoires (SM-A155F, MZ-V8V1T0)
  /\/(?:DSN?|DS|[A-Z]{1,2})$/i, // « /DSN », « /DS », Apple « ZD/A », « LL/A »
  /-(?:EU|EUR|US|UK|FR|DS|INT|GLOBAL|ROW)$/i,
  /#[A-Z0-9]{3}$/i, // HP « 4P5M7EA#ABF »
];

const KNOWN_KEYS = new Set(['SN', 'IMEI', 'IMEI1', 'IMEI2', 'MEID', 'IMEISV', 'EAN', 'PN', 'MODEL', 'LOT', 'DATE', 'GS1']);

/** Score de numéro de série d'une valeur (sans IMEI ni EAN). */
function scoreSerial(value: string, key: string | undefined, symbology: string | undefined, itemName: string | undefined): { score: number; reason: string } {
  if (itemName !== undefined) return { score: 0, reason: `Code de l'article « ${itemName} »` };
  if (key !== undefined && NON_SERIAL_KEYS[key] !== undefined) return { score: 0, reason: NON_SERIAL_KEYS[key] };
  if (isUrl(value)) return { score: 0, reason: 'Adresse web' };
  if (isMac(value)) return { score: 0, reason: 'Adresse MAC' };
  if (/^\d{4}[-./]\d{2}[-./]\d{2}$/.test(value)) return { score: 0, reason: 'Date' };
  if (value.length < 4) return { score: 0, reason: 'Trop court' };
  if (value.length > SERIAL_MAX_LENGTH) return { score: 0, reason: 'Trop long' };
  if (normalizeSerial(value).error !== undefined || /^[=+@]/.test(value) || SERIAL_DASH_FORMULA_RE.test(value)) {
    return { score: 0, reason: 'Caractères non admis' };
  }

  let score = 50;
  const notes: string[] = [];
  const explicit = key === 'SN';
  // Adresse MAC sans séparateurs (Apple : codes « Wi-Fi ID » / « Bluetooth ID » de la boîte).
  if (!explicit && /^[0-9A-F]{12}$/i.test(value) && /[A-F]/i.test(value) && /\d/.test(value)) {
    score -= 45;
    notes.push('ressemble à une adresse MAC (Wi-Fi / Bluetooth)');
  }
  if (explicit) {
    score += 40;
    notes.push('clé « S/N »');
  }
  if (symbology && LINEAR_SERIAL_SYMBOLOGY.test(symbology)) score += 10;
  const len = value.length;
  if (len >= 6 && len <= 20) score += 10;
  else if (len < 6) {
    score -= 10;
    notes.push('court');
  } else if (len <= 30) score -= 10;
  else score -= 25;

  const hasDigit = /\d/.test(value);
  const hasLetter = /[A-Za-z]/.test(value);
  const compact = value.replace(/\s+/g, '');
  if (hasDigit && hasLetter) score += 15;
  else if (!hasDigit) {
    score -= 50;
    notes.push('lettres seules');
  } else if (/^\d+$/.test(compact)) {
    score -= 15;
    notes.push('chiffres seuls');
    if (!explicit && compact.length === 15 && !luhnValid(compact)) {
      score -= 30;
      notes.push('15 chiffres, clé IMEI invalide');
    }
  }
  if (/[/#+]/.test(value)) {
    score -= 25;
    notes.push('contient / # ou +');
  }
  if (/\s/.test(value)) {
    score -= 20;
    notes.push('contient des espaces');
  }
  const lower = (value.match(/[a-z]/g) ?? []).length;
  const upper = (value.match(/[A-Z]/g) ?? []).length;
  if (lower >= 3 && lower > upper) {
    score -= 20;
    notes.push('texte en minuscules');
  }
  if (!explicit && MODEL_HINTS.some((re) => re.test(value))) {
    score -= 60;
    notes.push('ressemble à une référence / modèle');
  }
  if (key !== undefined && !KNOWN_KEYS.has(key)) {
    score -= 15;
    notes.push(`champ « ${key.slice(0, 24)} »`);
  }
  const k = serialKey(value);
  const vendor = VENDOR_PATTERNS.find((p) => p.re.test(k));
  if (vendor) {
    score += VENDOR_BONUS[vendor.confidence];
    notes.push(`format proche de ${vendor.label} (à vérifier)`);
  }
  const head = explicit ? 'Numéro de série indiqué' : score >= SERIAL_MIN_SCORE ? 'Numéro de série possible' : 'Peu probable';
  return { score, reason: notes.length ? `${head} : ${notes.join(', ')}` : head };
}

// Apple (convention ANSI MH10.8.2) : le Code 128 du numéro de série commence
// par l'identifiant « S » (« (S) Serial No. » imprimé à côté). Vérifié sur une
// étiquette réelle (MacBook Neo : « (S) Serial No. JY9NWR1129 ») : le numéro
// est la valeur SANS le « S », proposée en premier. La variante avec « S »
// reste dans la liste (au cas où le « S » ferait partie du numéro).
const S_PREFIXED = /^S(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{10,12}$/;

/** Analyse brute (sans le choix de l'utilisateur). */
function buildFields(codes: readonly ScannedCode[], itemName?: (code: string) => string | undefined): { fields: BoxField[]; truncated: boolean } {
  const fields: BoxField[] = [];
  let truncated = codes.length > BOX_MAX_CODES;
  const n = Math.min(codes.length, BOX_MAX_CODES);
  const lookup = (c: string): string | undefined => {
    if (!itemName) return undefined;
    try {
      return itemName(c);
    } catch {
      return undefined;
    }
  };
  for (let ci = 0; ci < n; ci++) {
    const c = codes[ci];
    let raw = c && typeof c.data === 'string' ? c.data : '';
    const rejected = boxCheckCode(raw);
    if (rejected !== null) {
      // Code trop long (jamais tronqué : un préfixe donnerait un numéro partiel) ;
      // QR Wi-Fi (mot de passe !), carte de visite… : écartés entièrement.
      if (rejected === BOX_TOO_LONG) truncated = true;
      continue;
    }
    raw = normalizeBoxText(raw);
    const symbology = c && typeof c.type === 'string' && c.type ? c.type.toLowerCase().slice(0, 32) : undefined;
    const product = symbology !== undefined && PRODUCT_SYMBOLOGY.test(symbology);
    const split = splitFields(raw);
    if (split.truncated) truncated = true;
    const multi = split.parts.length > 1;
    split.parts.forEach((part, fi) => {
      const id = `${ci}.${fi}`;
      const base = { id, codeIndex: ci, multi, ...(symbology ? { symbology } : {}) };
      // Code-barres produit lu comme tel : jamais découpé en clé / valeur.
      let p: Parsed = typeof part !== 'string' ? part : product && !multi ? { value: cleanValue(part) } : parseField(part);
      // Identifiant ANSI « 1P » (référence fabricant, ex. Apple « 1PMXXX2ZD/A ») collé à la valeur
      // d'un Code 128 / 39. INCERTAIN : à vérifier sur étiquettes réelles.
      if (!multi && p.key === undefined && symbology && LINEAR_SERIAL_SYMBOLOGY.test(symbology) && /^1P[A-Z][A-Z0-9/-]{3,}$/.test(p.value)) {
        p = { key: 'PN', value: p.value.slice(2) };
      }
      const key = p.key;
      const value = p.value.slice(0, BOX_MAX_RAW_LENGTH);
      const digits = imeiDigits(value);
      const keyed = key !== undefined ? { key } : {};

      // Une clé explicite (S/N, référence, lot…) l'emporte sur la forme de la valeur.
      const freeKey = key === undefined || !KNOWN_KEYS.has(key);
      const imeiKey = key !== undefined && key !== 'IMEISV' && (key.startsWith('IMEI') || key === 'MEID');
      // 1. IMEI : 15 chiffres, clé de Luhn valide (préfixe IMEI / MEID accepté).
      if (!product && (freeKey || imeiKey) && /^\d{15}$/.test(digits) && /^[\d\s-]+$/.test(value) && luhnValid(digits)) {
        fields.push({ ...base, ...keyed, value: digits, role: 'imei', score: 0, reason: 'IMEI (clé de contrôle valide)', ...(p.imeiSlot ? { imeiSlot: p.imeiSlot } : {}) });
        return;
      }
      if (imeiKey && key !== 'MEID') {
        fields.push({ ...base, ...keyed, value, role: 'other', score: 0, reason: /^\d{15}$/.test(digits) ? 'IMEI invalide (clé de contrôle incorrecte)' : 'IMEI illisible' });
        return;
      }
      // 2. Code produit : symbologie EAN/UPC, clé EAN/UPC/GTIN, ou 8/12/13/14 chiffres à clé GTIN valide.
      const numeric = /^\d+$/.test(value);
      if (product || ((freeKey || key === 'EAN') && numeric && gtinValid(value)) || (key === 'EAN' && /^\d{6,14}$/.test(digits))) {
        const name = lookup(value);
        const kind = value.length === 14 ? 'GTIN-14' : value.length === 13 ? 'EAN-13' : value.length === 12 ? 'UPC-A' : value.length === 8 ? 'EAN-8' : 'EAN/UPC';
        fields.push({ ...base, ...keyed, value: numeric ? value : digits, role: 'ean', score: 0, reason: name !== undefined ? `Code produit (${kind}) · ${name}` : `Code produit (${kind})` });
        return;
      }
      // 3. Numéro de série possible, sinon « autre ».
      const name = value ? lookup(value) : undefined;
      if (!product && !multi && key === undefined && symbology && LINEAR_SERIAL_SYMBOLOGY.test(symbology) && S_PREFIXED.test(value)) {
        const stripped = value.slice(1);
        const s = scoreSerial(stripped, undefined, symbology, lookup(stripped));
        const sWith = scoreSerial(value, undefined, symbology, name);
        // Sans « S » devant (identifiant « (S) Serial No. ») ; avec « S » juste derrière.
        const strippedScore = s.score > 0 ? Math.max(s.score, sWith.score) + 2 : 0;
        const withScore = Math.min(sWith.score, Math.max(0, strippedScore - 2));
        fields.push({ ...base, value, role: withScore >= SERIAL_MIN_SCORE ? 'serial-candidate' : 'other', score: withScore, reason: `${sWith.reason} (avec le « S » initial)` });
        fields.push({ ...base, id: `${id}s`, value: stripped, role: strippedScore >= SERIAL_MIN_SCORE ? 'serial-candidate' : 'other', score: strippedScore, reason: `${s.reason} (sans le « S » : identifiant Apple « (S) Serial No. »)` });
        return;
      }
      const s = value ? scoreSerial(value, key, symbology, name) : { score: 0, reason: 'Vide' };
      fields.push({ ...base, ...keyed, value, role: s.score >= SERIAL_MIN_SCORE ? 'serial-candidate' : 'other', score: s.score, reason: s.reason });
    });
  }
  // IMEISV sans clé : 16 chiffres dont les 14 premiers sont ceux d'un IMEI de l'étiquette.
  const tacs = new Set(fields.filter((f) => f.role === 'imei').map((f) => f.value.slice(0, 14)));
  for (const f of fields) {
    if (f.role === 'serial-candidate' && /^\d{16}$/.test(f.value) && tacs.has(f.value.slice(0, 14))) {
      f.role = 'other';
      f.score = 0;
      f.reason = NON_SERIAL_KEYS.IMEISV;
    }
  }
  return { fields, truncated };
}

const EMPTY: BoxAnalysis = {
  fields: [],
  serial: null,
  serialSource: null,
  alternatives: [],
  imei1: null,
  imei2: null,
  extraImeis: [],
  ean: null,
  others: [],
  truncated: false,
};

/** Clé de comparaison de la valeur d'un champ (doublons entre codes). */
const fieldKey = (f: BoxField) => (f.role === 'imei' || f.role === 'ean' ? f.value : serialKey(f.value));

/**
 * Analyse les codes distincts d'une étiquette (dans l'ordre de première
 * lecture). Ne lève jamais.
 */
export function analyzeBoxCodes(codes: readonly ScannedCode[], opts: BoxAnalyzeOptions = {}): BoxAnalysis {
  try {
    if (!Array.isArray(codes)) return { ...EMPTY };
    const { fields, truncated } = buildFields(codes, opts.itemName);
    const chosen = opts.chosenFieldId ? fields.find((f) => f.id === opts.chosenFieldId) ?? null : null;
    const chosenKey = chosen ? serialKey(chosen.value) : null;
    const notChosen = (f: BoxField) => chosenKey === null || (serialKey(f.value) !== chosenKey && imeiDigits(f.value) !== imeiDigits(chosen!.value));

    // IMEI : emplacements explicites d'abord, sinon ordre de lecture ; distincts.
    // Même IMEI lu avec et sans emplacement : l'emplacement explicite l'emporte.
    const byImei = new Map<string, BoxField>();
    for (const f of fields) {
      if (f.role !== 'imei' || !notChosen(f)) continue;
      const prev = byImei.get(f.value);
      if (!prev || (!prev.imeiSlot && f.imeiSlot)) byImei.set(f.value, f);
    }
    const keptImei = new Set(byImei.values());
    const imeis = fields.filter((f) => keptImei.has(f));
    let imei1 = imeis.find((f) => f.imeiSlot === 1) ?? null;
    let imei2 = imeis.find((f) => f.imeiSlot === 2 && f !== imei1) ?? null;
    const rest = imeis.filter((f) => f !== imei1 && f !== imei2);
    if (!imei1) imei1 = rest.shift() ?? null;
    if (!imei2) imei2 = rest.shift() ?? null;
    // Un seul IMEI marqué « IMEI 2 » : il devient l'IMEI principal.
    if (!imei1 && imei2) {
      imei1 = imei2;
      imei2 = null;
    }

    const ean = fields.find((f) => f.role === 'ean' && notChosen(f)) ?? null;

    // Candidats : dédoublonnés (même valeur dans deux codes : meilleur score gardé).
    const byKey = new Map<string, BoxField>();
    for (const f of fields) {
      if (f.role !== 'serial-candidate') continue;
      const k = fieldKey(f);
      const prev = byKey.get(k);
      if (!prev || f.score > prev.score) byKey.set(k, f);
    }
    const order = new Map(fields.map((f, i) => [f.id, i] as const));
    const ranked = [...byKey.values()].sort((a, b) => b.score - a.score || order.get(a.id)! - order.get(b.id)!);

    const serial = chosen ?? ranked[0] ?? null;
    const serialSource = chosen ? 'user' : serial ? 'auto' : null;
    const serialK = serial ? serialKey(serial.value) : null;
    const alternatives = ranked.filter((f) => serialKey(f.value) !== serialK);
    const used = new Set<BoxField>([...(serial ? [serial] : []), ...(imei1 ? [imei1] : []), ...(imei2 ? [imei2] : []), ...(ean ? [ean] : [])]);
    const others = fields.filter((f) => !used.has(f) && f.role === 'other');

    return {
      fields,
      serial,
      serialSource,
      alternatives,
      imei1: imei1?.value ?? null,
      imei2: imei2?.value ?? null,
      extraImeis: rest.map((f) => f.value),
      ean: ean?.value ?? null,
      others,
      truncated,
    };
  } catch {
    return { ...EMPTY };
  }
}

export type BoxChip = 'serial' | 'imei1' | 'imei2' | 'ean' | 'other';

export const BOX_CHIP_LABELS: Readonly<Record<BoxChip, string>> = {
  serial: 'N° de série',
  imei1: 'IMEI 1',
  imei2: 'IMEI 2',
  ean: 'Code produit',
  other: 'Autre',
};

/** Rôle affiché d'un champ (les doublons d'une valeur retenue portent la même pastille). */
export function boxFieldChip(a: BoxAnalysis, f: BoxField): BoxChip {
  if (a.serial && (f.id === a.serial.id || serialKey(f.value) === serialKey(a.serial.value))) return 'serial';
  if (f.role === 'imei' && f.value === a.imei1) return 'imei1';
  if (f.role === 'imei' && f.value === a.imei2) return 'imei2';
  if (f.role === 'ean' && f.value === a.ean) return 'ean';
  return 'other';
}

/**
 * Lignes de la liste affichée : une même valeur (`serialKey`) lue dans
 * plusieurs codes n'est listée qu'une fois, à la place de sa première lecture.
 * Entre doublons, la ligne gardée est celle qui porte le rôle retenu (n° de
 * série, IMEI 1, IMEI 2, code produit) plutôt qu'une ligne « Autre ».
 */
export function boxListFields(a: BoxAnalysis): BoxField[] {
  const rows: BoxField[] = [];
  const at = new Map<string, number>();
  for (const f of a.fields) {
    const k = serialKey(f.value);
    if (!k) continue;
    const i = at.get(k);
    if (i === undefined) {
      at.set(k, rows.length);
      rows.push(f);
    } else if (boxFieldChip(a, rows[i]) === 'other' && boxFieldChip(a, f) !== 'other') {
      rows[i] = f;
    }
  }
  return rows;
}

// ── Session (écran « Scanner une boîte ») ─────────────────────────────────

/**
 * Empreinte courte et non réversible d'un code refusé (FNV-1a 32 bits +
 * longueur) : permet de n'afficher le refus qu'une fois par code sans garder
 * son contenu en mémoire (un QR Wi-Fi contient le mot de passe).
 */
export function boxRejectDigest(data: string): string {
  let h = 0x811c9dc5;
  const s = typeof data === 'string' ? data : '';
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${s.length.toString(36)}:${h.toString(36)}`;
}

/** Délai pendant lequel les codes de la boîte précédente, encore visibles, sont ignorés. */
export const BOX_SUPPRESS_GAP_MS = 1200;

export type BoxSession = {
  /** Codes distincts, dans l'ordre de première lecture (au plus `BOX_MAX_CODES`). */
  codes: ScannedCode[];
  /** `boxCodeKey` de chaque code de `codes`. */
  keys: string[];
  /** Champ choisi par l'utilisateur comme numéro de série. */
  chosenFieldId: string | null;
  /** `true` si un code nouveau a été refusé (limite atteinte). */
  full: boolean;
  /** Codes de la boîte précédente → dernière lecture (epoch ms) : ignorés tant qu'ils restent visibles. */
  ignore: Readonly<Record<string, number>>;
};

export function emptyBoxSession(): BoxSession {
  return { codes: [], keys: [], chosenFieldId: null, full: false, ignore: {} };
}

/**
 * Ajoute un code lu. Renvoie la MÊME session si rien ne change pour
 * l'utilisateur (doublon, code vide, code refusé par `boxCheckCode`), pour que l'écran puisse ne réagir
 * (vibration, rendu) qu'aux codes nouveaux.
 */
export function boxAddCode(s: BoxSession, code: ScannedCode, now: number = Date.now()): BoxSession {
  // Code trop long ou QR fonctionnel : refusé en entier (`boxCheckCode` donne le message).
  if (!code || typeof code.data !== 'string' || boxCheckCode(code.data) !== null) return s;
  const data = normalizeBoxText(code.data).trim();
  if (!data) return s;
  const k = boxCodeKey(data, typeof code.type === 'string' ? code.type : undefined);
  if (!k || s.keys.includes(k)) return s;
  const last = s.ignore[k];
  if (last !== undefined) {
    if (now - last < BOX_SUPPRESS_GAP_MS) {
      // Toujours devant la caméra : reste ignoré (date de lecture mise à jour).
      return { ...s, ignore: { ...s.ignore, [k]: now } };
    }
  }
  if (s.codes.length >= BOX_MAX_CODES) return s.full ? s : { ...s, full: true };
  const { [k]: _gone, ...ignore } = s.ignore;
  const type = typeof code.type === 'string' && code.type ? code.type.slice(0, 32) : undefined;
  return { ...s, codes: [...s.codes, { data, ...(type ? { type } : {}) }], keys: [...s.keys, k], ignore };
}

/** Choisit (ou, avec `null`, annule le choix du) numéro de série. Un identifiant inconnu est ignoré. */
export function boxChooseSerial(s: BoxSession, fieldId: string | null): BoxSession {
  if (fieldId === null) return s.chosenFieldId === null ? s : { ...s, chosenFieldId: null };
  if (fieldId === s.chosenFieldId) return s;
  const exists = analyzeBoxCodes(s.codes).fields.some((f) => f.id === fieldId);
  return exists ? { ...s, chosenFieldId: fieldId } : s;
}

/**
 * Nouvelle boîte. Avec `now`, les codes de la boîte terminée sont ignorés tant
 * qu'ils restent devant la caméra (lus à moins de `BOX_SUPPRESS_GAP_MS`).
 */
export function boxReset(s?: BoxSession, now?: number): BoxSession {
  const next = emptyBoxSession();
  if (!s || now === undefined) return next;
  // Codes encore ignorés (toujours devant la caméra) : gardés, même si la liste est vide.
  const ignore: Record<string, number> = {};
  for (const [k, last] of Object.entries(s.ignore)) if (now - last < BOX_SUPPRESS_GAP_MS) ignore[k] = last;
  for (const k of s.keys) ignore[k] = now;
  return { ...next, ignore };
}

/**
 * Clés (`boxCodeKey`) des codes de l'étiquette en cours et des codes encore
 * ignorés de la boîte précédente (lus à moins de `BOX_SUPPRESS_GAP_MS`).
 */
export function boxActiveKeys(s: BoxSession, now: number = Date.now()): string[] {
  const out = [...s.keys];
  for (const [k, last] of Object.entries(s.ignore)) if (now - last < BOX_SUPPRESS_GAP_MS && !out.includes(k)) out.push(k);
  return out;
}

/**
 * `true` si le code (même normalisation que `boxAddCode`) est un code de la
 * boîte précédente encore ignoré (lu à moins de `BOX_SUPPRESS_GAP_MS`).
 */
export function boxIsIgnored(s: BoxSession, data: string, now: number = Date.now()): boolean {
  if (typeof data !== 'string') return false;
  const k = boxCodeKey(normalizeBoxText(data).trim());
  if (!k || s.keys.includes(k)) return false;
  const last = s.ignore[k];
  return last !== undefined && now - last < BOX_SUPPRESS_GAP_MS;
}

/** `true` si le code (même normalisation que `boxAddCode`) est déjà dans la liste. */
export function boxHasCode(s: BoxSession, data: string): boolean {
  if (typeof data !== 'string') return false;
  const k = boxCodeKey(normalizeBoxText(data));
  return k !== '' && s.keys.includes(k);
}

/** Analyse de la session (choix de l'utilisateur compris). */
export function analyzeBoxSession(s: BoxSession, opts: Omit<BoxAnalyzeOptions, 'chosenFieldId'> = {}): BoxAnalysis {
  return analyzeBoxCodes(s.codes, { ...opts, chosenFieldId: s.chosenFieldId });
}
