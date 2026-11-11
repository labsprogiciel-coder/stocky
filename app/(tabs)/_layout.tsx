import { Tabs, router } from 'expo-router';
import { Pressable, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { colors } from '../../constants/theme';

const icon = (name: React.ComponentProps<typeof Feather>['name']) => ({ color }: { color: any }) => <Feather name={name} size={22} color={color} />;

export default function TabsLayout() {
  return (
    <Tabs screenOptions={{ headerShown: false, tabBarActiveTintColor: colors.primary, tabBarInactiveTintColor: colors.muted, tabBarLabelStyle: { fontSize: 11, fontWeight: '600' }, tabBarStyle: { backgroundColor: '#fff', borderTopColor: colors.border } }}>
      <Tabs.Screen name="index" options={{ title: 'Accueil', tabBarIcon: icon('grid') }} />
      <Tabs.Screen name="articles" options={{ title: 'Articles', tabBarIcon: icon('box') }} />
      <Tabs.Screen name="scanner" options={{ title: '', tabBarButton: () => (
        <Pressable accessibilityLabel="Scanner" onPress={() => router.push('/scan')} style={{ flex: 1, alignItems: 'center' }}>
          <View style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: colors.primary, marginTop: -18, alignItems: 'center', justifyContent: 'center', elevation: 4 }}>
            <Feather name="maximize" size={26} color="#fff" />
          </View>
        </Pressable>
      ) }} />
      <Tabs.Screen name="tasks" options={{ title: 'Tâches', tabBarIcon: icon('check-square') }} />
      <Tabs.Screen name="more" options={{ title: 'Profil', tabBarIcon: icon('user') }} />
    </Tabs>
  );
}
