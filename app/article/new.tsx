import { router, useLocalSearchParams } from 'expo-router';
import { ArticleForm } from '../../components/ArticleForm';

export default function NewArticle() {
  const params = useLocalSearchParams<{ barcode?: string }>();
  return (
    <ArticleForm
      initialBarcode={typeof params.barcode === 'string' ? params.barcode : undefined}
      onDone={() => router.back()}
    />
  );
}
