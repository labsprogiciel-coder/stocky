/**
 * Connexion à Storo : association par code affiché sur le téléphone (OTP)
 * ou par QR code affiché dans Storo (scanné avec le scanner de l'application).
 */
import { useCallback, useState } from 'react';
import { router, useFocusEffect } from 'expo-router';
import { Alert as InlineAlert, Btn, Card, H2, Muted, Screen } from '../../components/ui';
import { getPhoneCode } from '../../data/license';
import { platform } from '../../data/storo/kv';
import { consumePendingStoroScan } from '../../data/storo/orgStore';
import { claimQr, parsePairingQr } from '../../data/storo/session';
import { resolvePairingOutcome, useStoroSession } from '../../data/storo/useStoro';

const hostOf = (base: string) => base.replace(/^https?:\/\//, '').split('/')[0];

export default function Connect() {
  const { session } = useStoroSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Retour du scanner (`?storo=pair`) : QR code d'association.
  useFocusEffect(
    useCallback(() => {
      const text = consumePendingStoroScan('pair');
      if (!text) return;
      const parsed = parsePairingQr(text, platform().allowedHosts, Date.now());
      if (!parsed.ok) {
        setError(parsed.error);
        return;
      }
      setError(null);
      setBusy(true);
      void (async () => {
        const outcome = await claimQr(parsed.qr);
        const r = await resolvePairingOutcome(outcome);
        setBusy(false);
        if (r.ok) router.replace('/storo');
        else if (r.message) setError(r.message);
      })();
    }, []),
  );

  return (
    <Screen hasHeader>
      <Muted style={{ fontSize: 14, lineHeight: 20 }}>
        Associez ce téléphone à votre organisation Storo pour compter les inventaires et enregistrer les entrées et sorties de ses sites.
        Votre stock local (« Mon stock ») reste disponible.
      </Muted>
      {session?.state === 'active' && (
        <InlineAlert message={`Ce téléphone est déjà associé à ${session.orgName || 'une organisation'}. Une nouvelle association la remplacera.`} />
      )}

      <Card style={{ gap: 10 }}>
        <H2>Avec un code</H2>
        <Muted>Le téléphone affiche un code à saisir par un responsable dans Storo › Paramètres › Appareils.</Muted>
        <Btn title="Afficher un code" disabled={busy} onPress={() => router.push('/storo/otp')} />
      </Card>

      <Card style={{ gap: 10 }}>
        <H2>Avec un QR code</H2>
        <Muted>Un responsable affiche un QR code dans Storo (« Associer par QR code ») ; scannez-le avec ce téléphone.</Muted>
        <Btn title={busy ? 'Association en cours…' : 'Scanner le QR code'} variant="outline" disabled={busy} onPress={() => { setError(null); router.push({ pathname: '/scan', params: { storo: 'pair' } }); }} />
      </Card>

      {error && <InlineAlert message={error} />}

      <Muted>Serveur : {hostOf(platform().apiBase)} · Code du téléphone : {getPhoneCode()}</Muted>
    </Screen>
  );
}
