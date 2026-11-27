/**
 * Hooks React de l'espace organisation (Storo), au-dessus des notifications
 * de `orgStore.ts` : chaque changement (session, données, file d'envoi,
 * migration, synchronisation) redessine les écrans abonnés.
 */
import { useCallback, useSyncExternalStore } from 'react';
import { Alert } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { fmtCount } from '../store';
import { getArchive, getLocalMigration } from './migration';
import { getCurrentSiteId, getSite, getSyncMeta, getVersion, isOnline, isSyncing, subscribe } from './orgStore';
import { outboxSummary } from './outbox';
import { getMe, getSession, getSessionState, getWorkspace, type PairingOutcome } from './session';
import { runSync } from './sync';

/** Redessine le composant à chaque changement de l'espace organisation. */
export function useStoroVersion(): number {
  return useSyncExternalStore(subscribe, getVersion, getVersion);
}

export function useStoroSession() {
  useStoroVersion();
  return { session: getSession(), me: getMe(), state: getSessionState(), workspace: getWorkspace() };
}

export function useOrgData() {
  useStoroVersion();
  const siteId = getCurrentSiteId();
  return { siteId, site: getSite(siteId), sync: getSyncMeta(), syncing: isSyncing(), online: isOnline() };
}

export function useOutboxSummary() {
  useStoroVersion();
  return outboxSummary();
}

export function useLocalMigration() {
  useStoroVersion();
  return { migration: getLocalMigration(), archive: getArchive() };
}

/** Synchronisation périodique tant que l'écran est affiché (60 s accueil, 30 s comptage). */
export function useSyncTimer(ms: number): void {
  useFocusEffect(
    useCallback(() => {
      const id = setInterval(() => { void runSync('timer'); }, ms);
      return () => clearInterval(id);
    }, [ms]),
  );
}

/**
 * Fin d'association côté écran : confirmation si le téléphone contient des
 * données d'une autre organisation (§10.3). `ok` : associé (synchronisation lancée).
 */
export function resolvePairingOutcome(outcome: PairingOutcome): Promise<{ ok: true } | { ok: false; message?: string }> {
  if (outcome.kind === 'paired') {
    void runSync('manual');
    return Promise.resolve({ ok: true });
  }
  if (outcome.kind === 'error') return Promise.resolve({ ok: false, message: outcome.message });
  return new Promise((resolve) => {
    Alert.alert(
      'Changer d\'organisation',
      `Ce téléphone contient des données de ${outcome.oldOrgName} (${fmtCount(outcome.pending, 'opération non envoyée', 'opérations non envoyées')}). Elles seront remplacées par celles de ${outcome.newOrgName}.`,
      [
        { text: 'Annuler', style: 'cancel', onPress: () => { void outcome.cancel().then(() => resolve({ ok: false })); } },
        { text: 'Remplacer', style: 'destructive', onPress: () => { void outcome.confirm().then((next) => resolvePairingOutcome(next)).then(resolve); } },
      ],
      { cancelable: false },
    );
  });
}
