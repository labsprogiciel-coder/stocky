import { useState } from 'react';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { UnitForm } from '../../components/UnitForm';
import { EmptyState, Screen } from '../../components/ui';
import { getItem } from '../../data/store';

/** Ajout d'un appareil : `/unit/new?itemId=…&serial=…` (numéro de série facultatif, ex. code scanné). */
export default function NewUnit() {
  const params = useLocalSearchParams<{ itemId?: string; serial?: string }>();
  const itemId = typeof params.itemId === 'string' ? params.itemId : '';
  // Lu une seule fois : le formulaire garde ses valeurs pendant la saisie.
  const [item] = useState(() => getItem(itemId) ?? null);

  if (!item) {
    return (
      <>
        <Stack.Screen options={{ title: 'Article introuvable' }} />
        <Screen hasHeader>
          <EmptyState
            icon="search"
            title="Article introuvable"
            message="Cet article n'existe pas ou n'est plus enregistré sur cet appareil."
            primaryAction={{ label: 'Retour', onPress: () => router.back(), accessibilityLabel: "Retour à l'écran précédent" }}
          />
        </Screen>
      </>
    );
  }

  if (!item.serialized) {
    return (
      <Screen hasHeader>
        <EmptyState
          icon="hash"
          title="Suivi par numéro de série désactivé"
          message={`« ${item.name} » est suivi en quantité. Activez « Suivi par numéro de série » dans l'article pour lui ajouter des appareils.`}
          primaryAction={{ label: "Modifier l'article", onPress: () => router.replace(`/article/edit/${item.id}`), accessibilityHint: "Ouvre le formulaire de modification de l'article" }}
          secondaryAction={{ label: 'Retour', onPress: () => router.back(), accessibilityLabel: "Retour à l'écran précédent" }}
        />
      </Screen>
    );
  }

  return (
    <UnitForm
      item={item}
      initialSerial={typeof params.serial === 'string' ? params.serial : undefined}
      onDone={() => router.back()}
    />
  );
}
