import { router, useLocalSearchParams } from 'expo-router';
import { ArticleForm } from '../../components/ArticleForm';

export default function NewArticle() {
  const params = useLocalSearchParams<{ barcode?: string; serialized?: string }>();
  return (
    <ArticleForm
      initialBarcode={typeof params.barcode === 'string' ? params.barcode : undefined}
      initialSerialized={params.serialized === '1'}
      onDone={() => router.back()}
    />
  );
}
