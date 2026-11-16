/**
 * Persistance locale (hors ligne) basée sur MMKV.
 *
 * L'instance MMKV est créée paresseusement au premier accès. Si le module
 * natif est absent (Expo Go…), le chargement de `react-native-mmkv` (via
 * `react-native-nitro-modules`) ou `createMMKV` lève une exception : on
 * bascule alors sur une Map en mémoire exposant la même interface, et
 * `isPersistent()` renvoie `false`. Aucune fonction de ce module ne lève.
 */
import type * as MMKVModule from 'react-native-mmkv';

/** Version du schéma des données stockées. À incrémenter en cas de rupture. */
export const SCHEMA_VERSION = 1;

const SCHEMA_KEY = 'schemaVersion';
const NS = `v${SCHEMA_VERSION}.`;

/** Clés de données, préfixées par la version du schéma (ex. `v1.items`). */
export const KEYS = {
  items: `${NS}items`,
  movements: `${NS}movements`,
  countSessions: `${NS}countSessions`,
  /** Unités suivies par numéro de série. Ajout rétrocompatible : clé absente = aucune unité. */
  units: `${NS}units`,
  prefs: `${NS}prefs`,
  meta: `${NS}meta`,
  /**
   * Journal d'écriture (voir `data/store.ts`) : présent uniquement pendant un
   * enregistrement, ou après un enregistrement interrompu à réparer. Ajout
   * rétrocompatible : clé absente = aucun enregistrement en cours.
   */
  txn: `${NS}txn`,
} as const;

/** Sous-ensemble de l'API MMKV utilisé par l'application. */
type KeyValueStore = {
  getString(key: string): string | undefined;
  set(key: string, value: string | number | boolean): void;
  remove(key: string): void;
  clearAll(): void;
};

function createMemoryStore(): KeyValueStore {
  const map = new Map<string, string>();
  return {
    getString: (key) => map.get(key),
    set: (key, value) => { map.set(key, String(value)); },
    remove: (key) => { map.delete(key); },
    clearAll: () => { map.clear(); },
  };
}

let _store: KeyValueStore | null = null;
let _persistent = false;

function store(): KeyValueStore {
  if (_store) return _store;
  try {
    // `require` paresseux et non `import` : le module Nitro lève dès son
    // évaluation s'il est absent, ce qui ferait planter l'app au démarrage.
    const { createMMKV } = require('react-native-mmkv') as typeof MMKVModule;
    const mmkv = createMMKV({ id: 'stockly' });
    _store = {
      getString: (key) => mmkv.getString(key),
      set: (key, value) => mmkv.set(key, value),
      // `mmkv.remove` ne lève pas en cas d'échec (il renvoie `false`, comme pour
      // une clé déjà absente) : on vérifie que la clé a bien disparu.
      remove: (key) => {
        mmkv.remove(key);
        if (mmkv.contains(key)) throw new Error(`remove failed (${key})`);
      },
      clearAll: () => mmkv.clearAll(),
    };
    _persistent = true;
  } catch (e) {
    console.warn('[storage] MMKV indisponible, stockage temporaire en mémoire.', e);
    _store = createMemoryStore();
    _persistent = false;
  }
  migrate(_store);
  return _store;
}

/** Données d'un schéma inconnu ou antérieur : on repart de zéro. */
function migrate(s: KeyValueStore) {
  try {
    const raw = s.getString(SCHEMA_KEY);
    if (raw !== String(SCHEMA_VERSION)) {
      if (raw !== undefined) s.clearAll();
      s.set(SCHEMA_KEY, String(SCHEMA_VERSION));
    }
  } catch (e) {
    console.warn('[storage] Vérification du schéma impossible.', e);
  }
}

/** `true` si les données survivent au redémarrage de l'application. */
export function isPersistent(): boolean {
  store();
  return _persistent;
}

/**
 * Lit une valeur JSON. Renvoie `fallback` si la clé est absente, si le JSON
 * est corrompu ou si `isValid` rejette la valeur. Ne lève jamais.
 */
export function readJSON<T>(
  key: string,
  fallback: T,
  isValid?: ((v: unknown) => v is T) | ((v: unknown) => boolean)
): T {
  try {
    const raw = store().getString(key);
    if (raw === undefined) return fallback;
    const parsed: unknown = JSON.parse(raw);
    if (isValid && !isValid(parsed)) return fallback;
    return parsed as T;
  } catch {
    return fallback;
  }
}

/** Écrit une valeur JSON. Renvoie `false` si l'écriture a échoué. */
export function writeJSON(key: string, value: unknown): boolean {
  try {
    store().set(key, JSON.stringify(value));
    return true;
  } catch (e) {
    console.warn(`[storage] Écriture impossible (${key}).`, e);
    return false;
  }
}

/**
 * Lit la valeur brute (chaîne stockée) d'une clé : `value` vaut `null` si la
 * clé est absente, `ok` vaut `false` si la lecture a échoué. Ne lève jamais.
 */
export function readRaw(key: string): { ok: true; value: string | null } | { ok: false } {
  try {
    return { ok: true, value: store().getString(key) ?? null };
  } catch (e) {
    console.warn(`[storage] Lecture impossible (${key}).`, e);
    return { ok: false };
  }
}

/** Écrit une valeur brute (chaîne déjà sérialisée). Renvoie `false` si l'écriture a échoué. */
export function writeRaw(key: string, value: string): boolean {
  try {
    store().set(key, value);
    return true;
  } catch (e) {
    console.warn(`[storage] Écriture impossible (${key}).`, e);
    return false;
  }
}

/** Supprime une clé. Renvoie `false` si la suppression a échoué. Ne lève jamais. */
export function removeKey(key: string): boolean {
  try {
    store().remove(key);
    return true;
  } catch (e) {
    console.warn(`[storage] Suppression impossible (${key}).`, e);
    return false;
  }
}

/** Efface toutes les données (la version du schéma est réécrite). */
export function clearAll(): void {
  try {
    const s = store();
    s.clearAll();
    s.set(SCHEMA_KEY, String(SCHEMA_VERSION));
  } catch (e) {
    console.warn('[storage] Effacement impossible.', e);
  }
}
