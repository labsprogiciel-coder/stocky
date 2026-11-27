/**
 * Raccordement natif de l'espace organisation (Storo) — seul module de
 * `data/storo/` qui importe React Native, Expo, MMKV, NetInfo et la licence.
 * Importé une fois par `app/_layout.tsx` : à l'import, il injecte les
 * implémentations de plateforme (`configureKv`, `configureStoro`) et
 * enregistre la garde du stock local (`./migration`) ; `startStoro()` lance
 * ensuite le moteur de synchronisation et ses déclencheurs.
 */
import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';
import NetInfo from '@react-native-community/netinfo';
import { AppState, Platform } from 'react-native';
import type * as MMKVModule from 'react-native-mmkv';
import { DEFAULT_STORO_ALLOWED_HOSTS, DEFAULT_STORO_API_BASE } from '../../constants/storo';
import { formatPhoneCode, getPhoneCodeCanonical } from '../license';
import { configureKv, configureStoro, createMemoryKv, type OrgKv, type SecureKv } from './kv';
// Enregistre la garde du stock local (migration en attente / stock archivé) auprès de data/store.ts.
import './migration';
import { notifyAppState, notifyConnectivity, startSyncEngine } from './sync';

/** Instance MMKV `stockly-org`, distincte de `stockly` (jamais touchée par « Réinitialiser les données »). */
function createOrgKv(): { kv: OrgKv; persistent: boolean } {
  try {
    // `require` paresseux (comme data/storage.ts) : module Nitro absent → repli en mémoire.
    const { createMMKV } = require('react-native-mmkv') as typeof MMKVModule;
    const mmkv = createMMKV({ id: 'stockly-org' });
    return {
      kv: {
        get: (k) => mmkv.getString(k),
        set: (k, v) => mmkv.set(k, v),
        remove: (k) => {
          mmkv.remove(k);
          if (mmkv.contains(k)) throw new Error(`remove failed (${k})`);
        },
      },
      persistent: true,
    };
  } catch (e) {
    console.warn('[storo] MMKV indisponible, données Storo en mémoire seulement.', e);
    return { kv: createMemoryKv(), persistent: false };
  }
}

const SECURE_OPTIONS: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };

const secure: SecureKv = {
  get: (k) => SecureStore.getItemAsync(k, SECURE_OPTIONS),
  set: (k, v) => SecureStore.setItemAsync(k, v, SECURE_OPTIONS),
  remove: (k) => SecureStore.deleteItemAsync(k, SECURE_OPTIONS),
};

const extra = (Constants.expoConfig?.extra ?? {}) as { storoApiBase?: unknown; storoAllowedHosts?: unknown };
const apiBase = typeof extra.storoApiBase === 'string' && /^https:\/\//.test(extra.storoApiBase) ? extra.storoApiBase : DEFAULT_STORO_API_BASE;
const allowedHosts = Array.isArray(extra.storoAllowedHosts) && extra.storoAllowedHosts.every((h) => typeof h === 'string')
  ? (extra.storoAllowedHosts as string[])
  : DEFAULT_STORO_ALLOWED_HOSTS;

const { kv, persistent } = createOrgKv();
configureKv({ kv, secure, persistent });
configureStoro({
  apiBase,
  allowedHosts,
  deviceInfo: () => {
    let code: string | null = null;
    try { code = getPhoneCodeCanonical(); } catch { code = null; }
    const version = Constants.expoConfig?.version;
    return {
      serialNumber: code ? formatPhoneCode(code) : null,
      model: Constants.deviceName ?? 'Téléphone Stocky',
      ...(version ? { appVersion: version } : {}),
      platform: `${Platform.OS} ${String(Platform.Version)}`,
    };
  },
});

let _stop: (() => void) | null = null;

/** Démarre la synchronisation (une seule fois) : NetInfo, AppState, minuteries, premier cycle. */
export function startStoro(): () => void {
  if (_stop) return _stop;
  const unsubNet = NetInfo.addEventListener((s) => {
    notifyConnectivity(s.isConnected === true && s.isInternetReachable !== false);
  });
  const appSub = AppState.addEventListener('change', (st) => notifyAppState(st === 'active'));
  const stopEngine = startSyncEngine();
  _stop = () => {
    unsubNet();
    appSub.remove();
    stopEngine();
    _stop = null;
  };
  return _stop;
}
