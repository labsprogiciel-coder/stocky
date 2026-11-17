/**
 * Licence Stockly Pro hors ligne : code du téléphone et code d'activation.
 *
 * Module PUR (aucun module natif, aucune API React Native) partagé par
 * l'application (`data/license.ts`) et par l'outil du propriétaire
 * `scripts/license.mjs` (Node). Pour que Node puisse l'importer directement
 * (suppression des types intégrée à Node ≥ 22.18), ce fichier n'utilise que
 * de la syntaxe TypeScript « effaçable » (types et annotations seulement :
 * pas d'enum, de namespace ni de propriété de paramètre) et aucun import
 * relatif.
 *
 * Code du téléphone : 15 caractères aléatoires (75 bits) + 1 caractère de
 * contrôle, en base 32 de Crockford (sans I, L, O, U), affiché en groupes de
 * 4 (`7K3D-9QXA-M2PV-H8TC`). Le contrôle (Luhn mod 32) détecte toute faute de
 * frappe sur un caractère et presque toutes les inversions de deux caractères
 * voisins (sauf 0↔Z, comme 0↔9 pour Luhn en base 10). À la
 * saisie, minuscules, espaces et tirets sont acceptés ; O → 0, I/L → 1.
 *
 * Code d'activation : `STK1.<charge>.<signature>` (base64url), où la charge
 * est le JSON compact `{"v":1,"c":société,"d":code téléphone,"e":AAAA-MM-JJ,
 * "n":numéro de série}` et la signature Ed25519 (tweetnacl) porte sur
 * `stockly-license-v1:` + les octets exacts de la charge. Les blancs (retours
 * à la ligne d'une messagerie…) sont ignorés au collage.
 */
import nacl from 'tweetnacl';

// ── Base 32 de Crockford ────────────────────────────────────────────────────

export const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** Caractères aléatoires du code téléphone (hors caractère de contrôle). */
export const PHONE_CODE_BODY_LENGTH = 15;
export const PHONE_CODE_LENGTH = PHONE_CODE_BODY_LENGTH + 1;

const valueOf = (ch: string): number => CROCKFORD_ALPHABET.indexOf(ch);

/** Caractère de contrôle Luhn mod 32 d'une suite de caractères Crockford. */
export function phoneCheckChar(body: string): string {
  const n = 32;
  let factor = 2;
  let sum = 0;
  for (let i = body.length - 1; i >= 0; i--) {
    let addend = factor * valueOf(body[i]);
    factor = factor === 2 ? 1 : 2;
    addend = Math.floor(addend / n) + (addend % n);
    sum += addend;
  }
  return CROCKFORD_ALPHABET[(n - (sum % n)) % n];
}

/** Majuscules, sans espaces ni tirets, O → 0, I/L → 1 (saisie tolérante). */
function canonicalChars(input: string): string {
  return input
    .toUpperCase()
    .replace(/[\s\-_.]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
}

/**
 * Code téléphone sous forme canonique (16 caractères, sans tirets) à partir
 * d'une saisie, ou `null` si la saisie est incomplète, contient un caractère
 * invalide ou si le caractère de contrôle ne correspond pas.
 */
export function normalizePhoneCode(input: string): string | null {
  if (typeof input !== 'string') return null;
  const c = canonicalChars(input);
  if (c.length !== PHONE_CODE_LENGTH) return null;
  for (const ch of c) if (valueOf(ch) < 0) return null;
  const body = c.slice(0, PHONE_CODE_BODY_LENGTH);
  return phoneCheckChar(body) === c[PHONE_CODE_BODY_LENGTH] ? c : null;
}

/** Message d'erreur (français) d'une saisie de code téléphone, ou `null` si elle est valide. */
export function phoneCodeError(input: string): string | null {
  const c = canonicalChars(typeof input === 'string' ? input : '');
  if (c.length === 0) return 'Code du téléphone manquant.';
  for (const ch of c) {
    if (valueOf(ch) < 0) return `Code du téléphone invalide : caractère « ${ch} » non autorisé.`;
  }
  if (c.length !== PHONE_CODE_LENGTH) {
    return `Code du téléphone incomplet : ${PHONE_CODE_LENGTH} caractères attendus (${c.length} saisis).`;
  }
  if (normalizePhoneCode(c) === null) return 'Code du téléphone erroné (faute de frappe ?) : vérifiez-le caractère par caractère.';
  return null;
}

/** Affichage en groupes de 4 : `7K3D-9QXA-M2PV-H8TC`. */
export function formatPhoneCode(code: string): string {
  const c = normalizePhoneCode(code) ?? canonicalChars(code);
  return (c.match(/.{1,4}/g) ?? []).join('-');
}

/**
 * Nouveau code téléphone canonique à partir d'octets aléatoires (au moins
 * 10 : les 75 premiers bits sont utilisés).
 */
export function makePhoneCode(random: Uint8Array): string {
  if (random.length < 10) throw new Error('makePhoneCode: 10 octets aléatoires au moins');
  let bits = 0;
  let acc = 0;
  let body = '';
  for (let i = 0; i < random.length && body.length < PHONE_CODE_BODY_LENGTH; i++) {
    acc = (acc << 8) | random[i];
    bits += 8;
    while (bits >= 5 && body.length < PHONE_CODE_BODY_LENGTH) {
      bits -= 5;
      body += CROCKFORD_ALPHABET[(acc >> bits) & 31];
    }
    acc &= (1 << bits) - 1;
  }
  return body + phoneCheckChar(body);
}

// ── Base64url et UTF-8 (sans Buffer / TextEncoder, pour Hermes et Node) ────

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export function toBase64Url(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i] << 16;
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63];
  }
  return out;
}

/** Décode du base64url sans remplissage ; `null` si la chaîne est invalide (non canonique comprise). */
export function fromBase64Url(s: string): Uint8Array | null {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) return null;
  const out = new Uint8Array(Math.floor((s.length * 3) / 4));
  let o = 0;
  let acc = 0;
  let bits = 0;
  for (const ch of s) {
    acc = (acc << 6) | B64.indexOf(ch);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 255;
    }
    acc &= (1 << bits) - 1;
  }
  // Bits de remplissage non nuls : encodage non canonique (code modifié).
  if (acc !== 0) return null;
  return out;
}

export function utf8Encode(s: string): Uint8Array {
  const out: number[] = [];
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
  }
  return Uint8Array.from(out);
}

/** Décodage UTF-8 strict ; `null` si les octets ne sont pas de l'UTF-8 valide. */
export function utf8Decode(b: Uint8Array): string | null {
  let s = '';
  for (let i = 0; i < b.length; ) {
    const c = b[i];
    let cp: number;
    let n: number;
    if (c < 0x80) { cp = c; n = 0; }
    else if (c >= 0xc2 && c < 0xe0) { cp = c & 31; n = 1; }
    else if (c >= 0xe0 && c < 0xf0) { cp = c & 15; n = 2; }
    else if (c >= 0xf0 && c < 0xf5) { cp = c & 7; n = 3; }
    else return null;
    for (let k = 1; k <= n; k++) {
      const cc = b[i + k];
      if (cc === undefined || (cc & 0xc0) !== 0x80) return null;
      cp = (cp << 6) | (cc & 63);
    }
    if ((n === 2 && (cp < 0x800 || (cp >= 0xd800 && cp < 0xe000))) || (n === 3 && (cp < 0x10000 || cp > 0x10ffff))) return null;
    s += String.fromCodePoint(cp);
    i += n + 1;
  }
  return s;
}

// ── Clés ────────────────────────────────────────────────────────────────────

/** En-tête du fichier de clé privée écrit par `scripts/license.mjs keygen`. */
export const PRIVATE_KEY_HEADER = 'stockly-license-private-key-v1';

/** Valeur provisoire de `expo.extra.licensePublicKey` dans `app.json`, à remplacer. */
export const PUBLIC_KEY_PLACEHOLDER = 'A_REMPLACER_par_la_cle_publique_de_scripts/license.mjs_keygen';

export type KeyPair = { publicKey: string; seed: string };

/** Paire de clés Ed25519 à partir d'une graine aléatoire de 32 octets (base64url). */
export function keyPairFromSeed(seed: Uint8Array): KeyPair {
  if (seed.length !== 32) throw new Error('La graine de la clé privée doit faire 32 octets.');
  const kp = nacl.sign.keyPair.fromSeed(seed);
  return { publicKey: toBase64Url(kp.publicKey), seed: toBase64Url(seed) };
}

/** Contenu du fichier de clé privée. */
export function formatPrivateKeyFile(seed: Uint8Array): string {
  const { publicKey, seed: s } = keyPairFromSeed(seed);
  return `${PRIVATE_KEY_HEADER}\n${s}\n# Clé publique (app.json > expo.extra.licensePublicKey) : ${publicKey}\n# NE PAS PARTAGER NI VERSIONNER CE FICHIER.\n`;
}

/** Graine (32 octets) lue depuis le contenu d'un fichier de clé privée, ou `null`. */
export function parsePrivateKeyFile(text: string): Uint8Array | null {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  if (lines[0] !== PRIVATE_KEY_HEADER || !lines[1]) return null;
  const seed = fromBase64Url(lines[1]);
  return seed && seed.length === 32 ? seed : null;
}

/** Clé publique (32 octets) depuis sa forme base64url, ou `null` (absente, provisoire, invalide). */
export function decodePublicKey(key: unknown): Uint8Array | null {
  if (typeof key !== 'string') return null;
  const k = fromBase64Url(key.trim());
  return k && k.length === nacl.sign.publicKeyLength ? k : null;
}

// ── Code d'activation ───────────────────────────────────────────────────────

export const ACTIVATION_PREFIX = 'STK1';
const SIGN_CONTEXT = 'stockly-license-v1:';
export const COMPANY_MAX_LENGTH = 80;

export type LicensePayload = {
  v: 1;
  /** Société. */
  c: string;
  /** Code téléphone canonique (16 caractères). */
  d: string;
  /** Dernier jour de validité inclus, `AAAA-MM-JJ`. */
  e: string;
  /** Numéro de série / nonce de la licence. */
  n: string;
};

export type License = { company: string; phone: string; expires: string; serial: string };

export function isIsoDate(s: unknown): s is string {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d && y >= 2000;
}

/** Date locale `AAAA-MM-JJ` d'un horodatage. */
export function localIsoDate(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** `AAAA-MM-JJ` → `JJ/MM/AAAA`. */
export function frDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

// Aucun caractère de contrôle (C0, DEL, C1) ni séparateur de ligne Unicode.
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/** Erreur (français) d'un nom de société, ou `null`. */
export function companyError(c: unknown): string | null {
  if (typeof c !== 'string' || c.trim().length === 0) return 'Nom de la société manquant.';
  if (c !== c.trim()) return 'Nom de la société : espaces en début ou fin non autorisés.';
  if ([...c].length > COMPANY_MAX_LENGTH) return `Nom de la société trop long (${COMPANY_MAX_LENGTH} caractères au plus).`;
  if (CONTROL_CHARS.test(c)) return 'Nom de la société : caractère de contrôle non autorisé.';
  return null;
}

const isSerial = (n: unknown): n is string => typeof n === 'string' && /^[A-Za-z0-9-]{1,32}$/.test(n);

function payloadError(p: unknown): string | null {
  if (typeof p !== 'object' || p === null || Array.isArray(p)) return 'contenu illisible';
  const r = p as Record<string, unknown>;
  if (r.v !== 1) return 'version de licence non prise en charge';
  if (companyError(r.c)) return 'société invalide';
  if (typeof r.d !== 'string' || normalizePhoneCode(r.d) !== r.d) return 'code téléphone invalide';
  if (!isIsoDate(r.e)) return "date d'expiration invalide";
  if (!isSerial(r.n)) return 'numéro de licence invalide';
  return null;
}

function signedMessage(payloadBytes: Uint8Array): Uint8Array {
  const ctx = utf8Encode(SIGN_CONTEXT);
  const m = new Uint8Array(ctx.length + payloadBytes.length);
  m.set(ctx, 0);
  m.set(payloadBytes, ctx.length);
  return m;
}

export type IssueInput = { company: string; phone: string; expires: string; serial: string };

/**
 * Émet un code d'activation signé (outil du propriétaire). Lève une erreur en
 * français si une donnée est invalide.
 */
export function issueActivationCode(input: IssueInput, seed: Uint8Array): string {
  const company = typeof input.company === 'string' ? input.company.trim() : '';
  const ce = companyError(company);
  if (ce) throw new Error(ce);
  const pe = phoneCodeError(input.phone);
  if (pe) throw new Error(pe);
  if (!isIsoDate(input.expires)) throw new Error("Date d'expiration invalide : format AAAA-MM-JJ attendu.");
  if (!isSerial(input.serial)) throw new Error('Numéro de licence invalide (1 à 32 caractères A-Z, 0-9, -).');
  if (seed.length !== 32) throw new Error('Clé privée invalide.');
  const payload: LicensePayload = { v: 1, c: company, d: normalizePhoneCode(input.phone)!, e: input.expires, n: input.serial };
  const bytes = utf8Encode(JSON.stringify(payload));
  const { secretKey } = nacl.sign.keyPair.fromSeed(seed);
  const sig = nacl.sign.detached(signedMessage(bytes), secretKey);
  return `${ACTIVATION_PREFIX}.${toBase64Url(bytes)}.${toBase64Url(sig)}`;
}

export type VerifyFailure =
  | 'no_key'
  | 'format'
  | 'signature'
  | 'phone'
  | 'expired';

export type VerifyResult =
  | { ok: true; license: License }
  | { ok: false; reason: VerifyFailure; error: string; license?: License };

export const LICENSE_ERRORS = {
  no_key:
    "Activation impossible : la clé publique de licence n'est pas configurée dans cette version de l'application (app.json › expo.extra.licensePublicKey). Contactez le fournisseur de Stockly.",
  format: "Code d'activation invalide : vérifiez qu'il a été copié en entier (il commence par « STK1. »).",
  signature: "Code d'activation invalide ou modifié : il n'a pas été émis pour Stockly Pro.",
  phone: "Ce code d'activation a été émis pour un autre téléphone. Envoyez le code de CE téléphone à votre fournisseur.",
} as const;

/**
 * Vérifie un code d'activation hors ligne : format, signature Ed25519 avec
 * `publicKey` (base64url), téléphone (`phone`, code canonique ou affiché) et
 * expiration (`today`, `AAAA-MM-JJ` ; la licence est valable jusqu'au jour
 * `e` inclus). Ne lève jamais.
 */
export function verifyActivationCode(code: unknown, publicKey: unknown, phone: string, today: string): VerifyResult {
  const key = decodePublicKey(publicKey);
  if (!key) return { ok: false, reason: 'no_key', error: LICENSE_ERRORS.no_key };
  const compact = typeof code === 'string' ? code.replace(/\s+/g, '') : '';
  const parts = compact.split('.');
  if (parts.length !== 3 || parts[0].toUpperCase() !== ACTIVATION_PREFIX) {
    return { ok: false, reason: 'format', error: LICENSE_ERRORS.format };
  }
  const bytes = fromBase64Url(parts[1]);
  const sig = fromBase64Url(parts[2]);
  if (!bytes || bytes.length === 0 || bytes.length > 1024 || !sig || sig.length !== nacl.sign.signatureLength) {
    return { ok: false, reason: 'format', error: LICENSE_ERRORS.format };
  }
  let valid = false;
  try {
    valid = nacl.sign.detached.verify(signedMessage(bytes), sig, key);
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: 'signature', error: LICENSE_ERRORS.signature };
  const text = utf8Decode(bytes);
  let payload: unknown = null;
  try {
    payload = text === null ? null : JSON.parse(text);
  } catch {
    payload = null;
  }
  // Signé par la bonne clé mais illisible : émis par une version plus récente ?
  const pErr = payloadError(payload);
  if (pErr) return { ok: false, reason: 'format', error: `Code d'activation non pris en charge par cette version (${pErr}). Mettez l'application à jour.` };
  const p = payload as LicensePayload;
  const license: License = { company: p.c, phone: p.d, expires: p.e, serial: p.n };
  const local = normalizePhoneCode(phone);
  if (!local || local !== p.d) return { ok: false, reason: 'phone', error: LICENSE_ERRORS.phone, license };
  if (!isIsoDate(today) || today > p.e) {
    return { ok: false, reason: 'expired', error: `Licence Stockly Pro expirée le ${frDate(p.e)}.`, license };
  }
  return { ok: true, license };
}
