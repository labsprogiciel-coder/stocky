import { useCallback, useState } from 'react';
import { View, Text, Alert } from 'react-native';
import { router, Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { UnitForm } from '../../components/UnitForm';
import { Btn, Card, EmptyState, H2, Muted, Row, Screen, UnitStatusChip, Alert as InlineAlert } from '../../components/ui';
import { colors } from '../../constants/theme';
import { deleteUnit, fmtDateTime, getItem, getMovements, getUnit } from '../../data/store';

/** Fiche d'un appareil : modification, historique des mouvements, suppression. */
export default function UnitScreen() {
  const { id: rawId } = useLocalSearchParams<{ id: string }>();
  const id = typeof rawId === 'string' ? rawId : '';
  // Le formulaire garde ses valeurs pendant la saisie ; au retour sur l'écran,
  // l'appareil est relu et, s'il a été modifié ailleurs (scan, comptage…), le
  // formulaire est réinitialisé (clé = `updatedAt`) pour ne pas réécrire un
  // statut périmé.
  const [unit, setUnit] = useState(() => getUnit(id) ?? null);
  const [item, setItem] = useState(() => (unit ? getItem(unit.itemId) ?? null : null));
  const [history, setHistory] = useState(() => getMovements().filter((m) => m.unitId === id));
  const [error, setError] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      const fresh = getUnit(id) ?? null;
      setUnit((prev) => (prev?.updatedAt === fresh?.updatedAt && prev?.id === fresh?.id ? prev : fresh));
      setItem(fresh ? getItem(fresh.itemId) ?? null : null);
      setHistory(getMovements().filter((m) => m.unitId === id));
    }, [id])
  );

  if (!unit || !item) {
    return (
      <>
        <Stack.Screen options={{ title: 'Appareil introuvable' }} />
        <Screen hasHeader>
          <EmptyState
            icon="search"
            title="Appareil introuvable"
            message="Ce numéro de série n'existe pas ou n'est plus enregistré sur cet appareil."
            primaryAction={{ label: 'Retour', onPress: () => router.back(), accessibilityLabel: "Retour à l'écran précédent" }}
          />
        </Screen>
      </>
    );
  }

  const handleDelete = () => {
    // Statut à jour (il a pu changer depuis l'ouverture de l'écran).
    const current = getUnit(unit.id);
    if (!current) {
      router.back();
      return;
    }
    Alert.alert(
      "Supprimer l'appareil",
      `Le numéro de série « ${current.serial} » sera supprimé de « ${item.name} »${current.status === 'in_stock' ? ' et une sortie de stock de 1 sera enregistrée' : ''}. Il est aussi retiré du comptage en cours. Cette action est irréversible.`,
      [
        { text: 'Annuler', style: 'cancel' },
        {
          text: 'Supprimer',
          style: 'destructive',
          onPress: () => {
            const res = deleteUnit(current.id);
            if (!res.ok) {
              setError(res.error);
              return;
            }
            router.back();
          },
        },
      ]
    );
  };

  return (
    <>
      <UnitForm key={unit.updatedAt} item={item} unit={unit} onDone={() => router.back()}>
        <Card style={{ gap: 6 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <Muted style={{ fontWeight: '600', fontSize: 12 }}>Statut enregistré</Muted>
            <UnitStatusChip status={unit.status} />
          </View>
          <Muted>Reçu le {fmtDateTime(unit.receivedAt)} · Modifié le {fmtDateTime(unit.updatedAt)}</Muted>
          <Btn
            title="Voir l'article"
            variant="outline"
            style={{ marginTop: 6 }}
            accessibilityHint={`Ouvre la fiche de ${item.name}`}
            onPress={() => router.push(`/article/${item.id}`)}
          />
        </Card>

        <H2>Historique</H2>
        {history.length === 0 ? (
          <Card>
            <Muted>Aucun mouvement de stock pour cet appareil. Une entrée ou une sortie est enregistrée quand il entre en stock ou en sort.</Muted>
          </Card>
        ) : (
          <Card style={{ padding: 0, overflow: 'hidden' }}>
            {history.map((m) => (
              <Row key={m.id}>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 14, fontWeight: '600', color: m.mode === 'Entrée' ? colors.primary : colors.warnText }}>
                    {m.mode} · {m.mode === 'Entrée' ? '+' : '−'}{m.qty}
                  </Text>
                  <Muted>{fmtDateTime(m.ts)}{m.serial && m.serial !== unit.serial ? ` · n° ${m.serial}` : ''}</Muted>
                </View>
              </Row>
            ))}
          </Card>
        )}

        {error && <InlineAlert message={error} />}
        <Btn
          title="Supprimer l'appareil"
          variant="danger"
          accessibilityHint="Demande une confirmation avant de supprimer ce numéro de série"
          onPress={handleDelete}
        />
      </UnitForm>
    </>
  );
}
