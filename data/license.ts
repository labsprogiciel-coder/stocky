/**
 * Licence Stockly Pro, entièrement hors ligne (aucun serveur).
 *
 * - Code du téléphone : identifiant aléatoire créé une seule fois, conservé
 *   dans expo-secure-store (Keychain / Keystore, « cet appareil uniquement » :
 *   jamais recopié vers un autre iPhone par iCloud ou une sauvegarde) et
 *   recopié dans une instance MMKV dédiée (`stockly-license`, non effacée par
 *   « Réinitialiser les données ») ; repli en mémoire si aucun des deux n'est
 *   disponible. Affiché en groupes de 4 avec un caractère de contrôle
 *   (`data/licenseCode.ts`).
 *   iOS : les fichiers MMKV font partie des sauvegardes iCloud / Finder. Une
 *   copie MMKV dont le code était aussi dans le Keychain, alors que le
 *   Keychain (lisible) ne l'a plus, vient donc d'un autre iPhone (sauvegarde
 *   restaurée) : elle est ignorée et un nouveau code est créé, si bien que la
 *   licence de l'autre iPhone ne s'applique pas ici. (Le Keychain iOS survit à
 *   la désinstallation : ce cas ne se produit pas sur le même iPhone.)
 *   Android : SecureStore et MMKV sont exclus de la sauvegarde automatique ;
 *   la copie MMKV sert de secours si le Keystore devient illisible.
 * - Code d'activation : signé Ed25519 par le propriétaire
 *   (`scripts/license.mjs issue`), vérifié ici avec la clé publique
 *   `app.json > expo.extra.licensePublicKey`. Le code accepté est conservé ;
 *   à chaque lancement (et à chaque consultation) la signature, le téléphone
 *   et la date d'expiration sont revérifiés. Expirée → version gratuite, les
 *   données sont conservées.
 * - Horloge : l'expiration se juge sur la date du téléphone. La date la plus
 *   récente déjà vue est mémorisée, si bien que reculer l'horloge ne prolonge
 *   jamais une licence au-delà d'une date déjà atteinte. Limite connue :
 *   reculer l'horloge AVANT d'avoir atteint l'expiration (et ne plus jamais
 *   l'avancer) n'est pas détectable sans serveur.
 *
 * Ce module enregistre `isPro` auprès de `data/store.ts` (`setLicenseCheck`),
 * qui applique les limites de la version gratuite. Importé par `app/_layout.tsx`.
 */
import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { LICENSE_CONTACT } from '../constants/license';
import type * as MMKVModule from 'react-native-mmkv';
import {
  PUBLIC_KEY_PLACEHOLDER,
  decodePublicKey,
  formatPhoneCode,
  frDate,
  isIsoDate,
  localIsoDate,
  makePhoneCode,
  normalizePhoneCode,
  verifyActivationCode,
  type License,
} from './licenseCode';
import { setLicenseCheck } from './store';

export { formatPhoneCode, frDate } from './licenseCode';
export type { License } from './licenseCode';

/** Prix et conditions affichés dans Profil › Stockly Pro. */
export const PRO_PRICE_TEXT = '150 000 FCFA / an · 1 société · jusqu\'à 2 téléphones';

const K = {
  phone: 'stockly.license.phoneId',
  code: 'stockly.license.code',
  lastSeen: 'stockly.license.lastSeenDate',
  /** (MMKV) `1` : le code du téléphone a bien été écrit dans le Keychain / Keystore. */
  phoneInSecure: 'stockly.license.phoneInSecure',
} as const;

/** Keychain iOS : lisible une fois l'appareil déverrouillé, jamais migré vers un autre appareil. */
const SECURE_OPTIONS: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };

// ── Stockage à deux niveaux (SecureStore puis MMKV dédié), sans exception ─

type Kv = { get(key: string): string | null; set(key: string, value: string): boolean; remove(key: string): void };

const memory = new Map<string, string>();
let _mmkv: Kv | null | undefined;

function mmkv(): Kv | null {
  if (_mmkv !== undefined) return _mmkv;
  try {
    const { createMMKV } = require('react-native-mmkv') as typeof MMKVModule;
    const m = createMMKV({ id: 'stockly-license' });
    _mmkv = {
      get: (k) => m.getString(k) ?? null,
      set: (k, v) => { m.set(k, v); return true; },
      remove: (k) => { m.remove(k); },
    };
  } catch {
    _mmkv = null;
  }
  return _mmkv;
}

/** Lecture SecureStore : `undefined` si le Keychain / Keystore est illisible. */
function secureRead(key: string): string | null | undefined {
  try {
    return SecureStore.getItem(key);
  } catch {
    return undefined;
  }
}

function secureGet(key: string): string | null {
  return secureRead(key) ?? null;
}

function secureSet(key: string, value: string): boolean {
  try {
    SecureStore.setItem(key, value, SECURE_OPTIONS);
    return true;
  } catch {
    return false;
  }
}

function readKey(key: string, valid: (v: string) => boolean = () => true): string | null {
  const s = secureGet(key);
  if (s !== null && valid(s)) return s;
  let m: string | null = null;
  try {
    m = mmkv()?.get(key) ?? null;
  } catch {
    m = null;
  }
  if (m !== null && valid(m)) return m;
  const mem = memory.get(key);
  return mem !== undefined && valid(mem) ? mem : null;
}

/** Écrit dans les deux stockages (et la mémoire) ; `true` si au moins un stockage persistant a réussi. */
function writeKey(key: string, value: string): boolean {
  memory.set(key, value);
  const a = secureSet(key, value);
  let b = false;
  try {
    b = mmkv()?.set(key, value) ?? false;
  } catch {
    b = false;
  }
  return a || b;
}

/** Efface une clé : valeur vide écrite de façon synchrone (lue comme absente), puis suppression. */
function removeKeyEverywhere(key: string): void {
  memory.delete(key);
  secureSet(key, '');
  try { SecureStore.deleteItemAsync(key).catch(() => {}); } catch { /* ignoré */ }
  try { mmkv()?.remove(key); } catch { /* ignoré */ }
}

const nonEmpty = (v: string) => v.length > 0;

// ── Code du téléphone ──────────────────────────────────────────────────────

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  let filled = false;
  if (c && typeof c.getRandomValues === 'function') {
    try {
      c.getRandomValues(out);
      filled = true;
    } catch {
      filled = false;
    }
  }
  // Repli (Hermes sans crypto.getRandomValues) : le code n'est pas un secret,
  // il doit seulement être unique ; l'heure et Math.random suffisent.
  if (!filled) {
    let t = Date.now();
    for (let i = 0; i < n; i++) {
      out[i] = (Math.floor(Math.random() * 256) ^ (t & 255)) & 255;
      t = Math.floor(t / 7) + i * 31;
    }
  }
  return out;
}

let _phone: string | null = null;

/** Code canonique de ce téléphone (16 caractères), créé au premier appel. */
export function getPhoneCodeCanonical(): string {
  if (_phone) return _phone;
  const valid = (v: string) => normalizePhoneCode(v) === v;
  const secureRaw = secureRead(K.phone);
  const fromSecure = secureRaw ?? null;
  let code: string | null = fromSecure !== null && valid(fromSecure) ? fromSecure : null;
  if (!code) {
    let mmkvSaysSecure = false;
    try { mmkvSaysSecure = mmkv()?.get(K.phoneInSecure) === '1'; } catch { mmkvSaysSecure = false; }
    // iOS : Keychain lisible et vide alors que la copie MMKV dit l'y avoir écrit
    // → fichiers venus d'un autre iPhone (sauvegarde restaurée) : copie ignorée.
    const copiedFromAnotherIphone = Platform.OS === 'ios' && secureRaw === null && mmkvSaysSecure;
    if (!copiedFromAnotherIphone) code = readKey(K.phone, valid);
  }
  if (!code) code = makePhoneCode(randomBytes(10));
  // Recopié partout (ex. Keychain vidé mais copie MMKV présente, ou l'inverse).
  const inSecure = fromSecure === code || secureSet(K.phone, code);
  try {
    if (mmkv()?.get(K.phone) !== code) mmkv()?.set(K.phone, code);
    const flag = inSecure ? '1' : '0';
    if (mmkv()?.get(K.phoneInSecure) !== flag) mmkv()?.set(K.phoneInSecure, flag);
  } catch { /* ignoré */ }
  memory.set(K.phone, code);
  _phone = code;
  return code;
}

/** Code de ce téléphone, à envoyer au fournisseur : `7K3D-9QXA-M2PV-H8TC`. */
export function getPhoneCode(): string {
  return formatPhoneCode(getPhoneCodeCanonical());
}

// ── Date de référence (anti-recul d'horloge simple) ───────────────────────

let _seen: string | null | undefined;

/** Date du jour (`AAAA-MM-JJ`) : la plus récente entre l'horloge et la date déjà vue. */
export function effectiveToday(now: number = Date.now()): string {
  const today = localIsoDate(now);
  if (_seen === undefined) _seen = readKey(K.lastSeen, isIsoDate);
  if (_seen && _seen >= today) return _seen;
  _seen = today;
  writeKey(K.lastSeen, today);
  return today;
}

// ── Clé publique et contact (app.json > expo.extra) ───────────────────────

function extra(): Record<string, unknown> {
  const e = Constants.expoConfig?.extra;
  return e && typeof e === 'object' ? (e as Record<string, unknown>) : {};
}

export function getPublicKey(): string | null {
  const k = extra().licensePublicKey;
  return typeof k === 'string' && k !== PUBLIC_KEY_PLACEHOLDER && decodePublicKey(k) ? k : null;
}

/**
 * Texte « comment acheter » (`constants/license.ts > LICENSE_CONTACT`), ou
 * `null` s'il n'est pas renseigné. En JavaScript (et non dans app.json) pour
 * pouvoir le modifier par une mise à jour OTA : `expo.extra` fait partie du
 * fingerprint (`runtimeVersion`), toute modification y exige un nouveau build.
 */
export function getLicenseContact(text: string = LICENSE_CONTACT): string | null {
  return typeof text === 'string' && text.trim() && !text.startsWith('A_REMPLACER') ? text.trim() : null;
}

// ── État de la licence ─────────────────────────────────────────────────────

export type LicenseStatus =
  /** Licence valide. */
  | { pro: true; license: License; expiresLabel: string }
  /**
   * Version gratuite. `license` + `problem` : un code est enregistré mais
   * n'est plus valable (expiré, autre téléphone, clé publique changée…).
   */
  | { pro: false; license?: License; problem?: string };

/** Codes enregistrés (SecureStore, MMKV, mémoire), sans doublon. */
function storedCodes(): string[] {
  const out: string[] = [];
  const add = (v: string | null | undefined) => { if (v && nonEmpty(v) && !out.includes(v)) out.push(v); };
  add(secureGet(K.code));
  try { add(mmkv()?.get(K.code)); } catch { /* ignoré */ }
  add(memory.get(K.code));
  return out;
}

let _cache: { code: string | null; day: string; status: LicenseStatus } | null = null;

function computeStatus(code: string | null, day: string): LicenseStatus {
  if (!code) return { pro: false };
  const r = verifyActivationCode(code, getPublicKey(), getPhoneCodeCanonical(), day);
  if (r.ok) return { pro: true, license: r.license, expiresLabel: frDate(r.license.expires) };
  return { pro: false, ...(r.license ? { license: r.license } : {}), problem: r.error };
}

/** État de la licence, revérifié (signature, téléphone, expiration) à chaque changement de jour. */
export function getLicenseStatus(now: number = Date.now()): LicenseStatus {
  const day = effectiveToday(now);
  if (_cache && _cache.day === day) return _cache.status;
  // Si les copies divergent (une écriture a échoué), la première copie valide l'emporte.
  const candidates = storedCodes();
  let best: { code: string | null; status: LicenseStatus } = { code: null, status: { pro: false } };
  for (const code of candidates) {
    const st = computeStatus(code, day);
    if (st.pro) { best = { code, status: st }; break; }
    if (best.code === null) best = { code, status: st };
  }
  _cache = { code: best.code, day, status: best.status };
  return best.status;
}

export function isPro(): boolean {
  return getLicenseStatus().pro;
}

export type ActivateResult =
  /** `warning` : licence active pour cette session mais non enregistrée (à recoller au prochain lancement). */
  | { ok: true; status: LicenseStatus & { pro: true }; warning?: string }
  | { ok: false; error: string };

/**
 * Vérifie et enregistre un code d'activation collé par l'utilisateur. En cas
 * d'échec, la licence déjà enregistrée (s'il y en a une) est conservée.
 */
export function activateLicense(code: string, now: number = Date.now()): ActivateResult {
  const compact = typeof code === 'string' ? code.replace(/\s+/g, '') : '';
  if (!compact) return { ok: false, error: "Collez le code d'activation reçu de votre fournisseur." };
  const day = effectiveToday(now);
  const r = verifyActivationCode(compact, getPublicKey(), getPhoneCodeCanonical(), day);
  if (!r.ok) return { ok: false, error: r.error };
  // Gardé au moins en mémoire pour cette session si l'enregistrement échoue.
  const saved = writeKey(K.code, compact);
  const status: LicenseStatus & { pro: true } = { pro: true, license: r.license, expiresLabel: frDate(r.license.expires) };
  _cache = { code: compact, day, status };
  return saved
    ? { ok: true, status }
    : { ok: true, status, warning: "Stockly Pro est actif, mais le code n'a pas pu être enregistré sur ce téléphone : il faudra le recoller au prochain lancement." };
}

/** Retire la licence de ce téléphone (retour à la version gratuite, données conservées). */
export function removeLicense(): void {
  removeKeyEverywhere(K.code);
  _cache = null;
}

/** Pour les tests : oublie les caches en mémoire (simule un redémarrage). */
export function _resetLicenseCacheForTests(): void {
  _cache = null;
  _phone = null;
  _seen = undefined;
  _mmkv = undefined;
  memory.clear();
}

setLicenseCheck(isPro);
