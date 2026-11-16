import { useState } from 'react';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { ArticleForm } from '../../../components/ArticleForm';
import { EmptyState, Screen } from '../../../components/ui';
import { getItem } from '../../../data/store';

export default function EditArticle() {
  const { id } = useLocalSearchParams<{ id: string }>();
  // Lu une seule fois : le formulaire garde ses valeurs pendant la saisie.
  const [item] = useState(() => getItem(typeof id === 'string' ? id : '') ?? null);

  if (!item) {
    return (
      <>
        <Stack.Screen options={{ title: 'Article introuvable' }} />
        <Screen hasHeader>
          <EmptyState
            icon="search"
            title="Article introuvable"
            message="Cet article n'existe pas ou n'est plus enregistré sur cet appareil."
            primaryAction={{ label: 'Retour aux articles', onPress: () => router.dismissTo('/articles'), accessibilityHint: 'Affiche la liste des articles' }}
          />
        </Screen>
      </>
    );
  }

  return <ArticleForm item={item} onDone={() => router.back()} />;
}
