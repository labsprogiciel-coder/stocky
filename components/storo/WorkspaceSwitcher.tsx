/**
 * Choix de l'espace de travail (contrat §5.4) : une pastille « Mon stock ▾ »
 * ou « <Organisation> ▾ » ouvrant une feuille avec « Mon stock (local) » et
 * « <Organisation> (Storo) ». Affichée seulement si une session Storo existe.
 */
import { useState } from 'react';
import { Modal, Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import { colors } from '../../constants/theme';
import { setWorkspaceChoice } from '../../data/storo/orgStore';
import { useLocalMigration, useStoroSession } from '../../data/storo/useStoro';

export function WorkspaceSwitcher({ current }: { current: 'standalone' | 'org' }) {
  const { session, state } = useStoroSession();
  const { archive } = useLocalMigration();
  const [open, setOpen] = useState(false);
  if (!session) return null;
  const orgName = session.orgName || 'Organisation Storo';
  const label = current === 'org' ? orgName : 'Mon stock';

  const choose = (w: 'standalone' | 'org') => {
    setOpen(false);
    if (w === current) return;
    setWorkspaceChoice(w);
    router.replace(w === 'org' ? '/storo' : '/(tabs)');
  };

  const option = (w: 'standalone' | 'org', title: string, suffix: string | null, icon: React.ComponentProps<typeof Feather>['name']) => {
    const on = w === current;
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ selected: on }}
        onPress={() => choose(w)}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56, paddingHorizontal: 14, borderRadius: 12, borderWidth: on ? 2 : 1, borderColor: on ? colors.primary : colors.field, backgroundColor: on ? colors.tint : '#fff' }}
      >
        <Feather name={icon} size={20} color={colors.primary} />
        <Text style={{ flex: 1, fontSize: 15, fontWeight: '600', color: colors.text }}>
          {title}{suffix ? <Text style={{ color: colors.muted, fontWeight: '500' }}> {suffix}</Text> : null}
        </Text>
        {on && <Feather name="check" size={18} color={colors.primary} />}
      </Pressable>
    );
  };

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Espace de travail : ${label}. Changer d'espace`}
        onPress={() => setOpen(true)}
        style={{ alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 40, paddingHorizontal: 14, borderRadius: 999, backgroundColor: '#fff', borderWidth: 1, borderColor: colors.field, maxWidth: '100%' }}
      >
        <Feather name={current === 'org' ? 'cloud' : 'smartphone'} size={14} color={colors.primary} />
        <Text numberOfLines={1} style={{ fontSize: 13, fontWeight: '700', color: colors.text, flexShrink: 1 }}>{label}</Text>
        <Feather name="chevron-down" size={14} color={colors.muted} />
      </Pressable>
      <Modal visible={open} transparent animationType="slide" onRequestClose={() => setOpen(false)}>
        <Pressable accessibilityLabel="Fermer" onPress={() => setOpen(false)} style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.35)' }} />
        <SafeAreaView edges={['bottom']} style={{ backgroundColor: colors.bg, borderTopLeftRadius: 18, borderTopRightRadius: 18, padding: 16, gap: 10 }}>
          <Text accessibilityRole="header" style={{ fontSize: 17, fontWeight: '700', color: colors.text, marginBottom: 4 }}>Espace de travail</Text>
          {option('standalone', 'Mon stock', archive ? '(local, archivé)' : '(local)', 'smartphone')}
          {option('org', orgName, state === 'readonly' ? '(Storo, lecture seule)' : '(Storo)', 'cloud')}
        </SafeAreaView>
      </Modal>
    </>
  );
}
