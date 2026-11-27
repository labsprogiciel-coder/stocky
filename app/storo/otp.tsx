/**
 * Association par code (OTP) : le téléphone affiche le code à saisir dans
 * Storo et interroge le serveur jusqu'à ce qu'un responsable l'ait saisi.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Text, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { Alert as InlineAlert, Btn, Card, Muted, Screen } from '../../components/ui';
import { colors } from '../../constants/theme';
import { pollOtp, requestOtp, type OtpSession } from '../../data/storo/session';
import { resolvePairingOutcome } from '../../data/storo/useStoro';

const hostOf = (base: string) => base.replace(/^https?:\/\//, '').split('/')[0];

function countdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export default function Otp() {
  const [otp, setOtp] = useState<OtpSession | null>(null);
  const [expired, setExpired] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [loading, setLoading] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const active = useRef(true);
  const done = useRef(false);

  const newCode = useCallback(async () => {
    setLoading(true);
    setError(null);
    setInfo(null);
    setExpired(false);
    const r = await requestOtp();
    setLoading(false);
    if (r.ok) setOtp(r.otp);
    else { setOtp(null); setError(r.message); }
  }, []);

  useEffect(() => { void newCode(); }, [newCode]);

  // Compte à rebours.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Interrogation tant que l'écran est affiché et l'application au premier plan.
  useFocusEffect(
    useCallback(() => {
      if (!otp || expired) return;
      active.current = true;
      const schedule = (ms: number) => {
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(tick, ms);
      };
      const tick = async () => {
        if (!active.current || done.current) return;
        if (AppState.currentState !== 'active') { schedule(otp.pollIntervalMs); return; }
        const r = await pollOtp(otp);
        if (!active.current || done.current) return;
        if (r.status === 'pending') { setInfo(null); schedule(r.nextPollMs); }
        else if (r.status === 'retry') { setInfo(r.message); schedule(r.nextPollMs); }
        else if (r.status === 'expired') setExpired(true);
        else if (r.status === 'failed') { setError(r.message); setOtp(null); }
        else {
          done.current = true;
          const res = await resolvePairingOutcome(r.outcome);
          if (res.ok) router.replace('/storo');
          else { done.current = false; setOtp(null); setError(res.message ?? 'Association annulée.'); }
        }
      };
      schedule(otp.pollIntervalMs);
      return () => {
        active.current = false;
        if (timer.current) clearTimeout(timer.current);
      };
    }, [otp, expired]),
  );

  const left = otp ? otp.expiresAt - now : 0;
  const isExpired = expired || (otp !== null && left <= 0);

  return (
    <Screen hasHeader>
      {otp && !isExpired && (
        <Card style={{ alignItems: 'center', gap: 12, paddingVertical: 28 }}>
          <Muted>Code d'association</Muted>
          <Text
            accessibilityLabel={`Code ${otp.otpDisplay.split('').join(' ')}`}
            selectable
            style={{ fontSize: 40, fontWeight: '700', letterSpacing: 4, color: colors.text, fontFamily: 'monospace' }}
          >
            {otp.otpDisplay}
          </Text>
          <Text style={{ fontSize: 14, color: colors.text, textAlign: 'center' }}>À saisir dans Storo › Paramètres › Appareils</Text>
          <Muted>Expire dans {countdown(left)} · {hostOf(otp.apiBase)}</Muted>
          <Muted style={{ textAlign: 'center' }}>En attente de la saisie du code par un responsable…</Muted>
        </Card>
      )}
      {otp && isExpired && (
        <Card style={{ alignItems: 'center', gap: 12 }}>
          <Text style={{ fontSize: 17, fontWeight: '600', color: colors.text }}>Code expiré</Text>
          <Btn title="Nouveau code" onPress={() => { void newCode(); }} style={{ alignSelf: 'stretch' }} />
        </Card>
      )}
      {loading && <Muted style={{ textAlign: 'center' }}>Demande du code…</Muted>}
      {info && <Muted style={{ textAlign: 'center', color: colors.warnText }}>{info}</Muted>}
      {error && (
        <View style={{ gap: 10 }}>
          <InlineAlert message={error} />
          <Btn title="Nouveau code" variant="outline" onPress={() => { void newCode(); }} />
        </View>
      )}
    </Screen>
  );
}
