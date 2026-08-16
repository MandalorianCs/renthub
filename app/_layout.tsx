import {
  Manrope_400Regular,
  Manrope_500Medium,
  Manrope_600SemiBold,
  Manrope_700Bold,
  Manrope_800ExtraBold,
  useFonts,
} from '@expo-google-fonts/manrope';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AuthProvider, useAuth } from '../src/lib/auth';
import { colors, typeface } from '../src/theme';

/**
 * Гейт авторизации. Держим его здесь, а не в каждом экране: если
 * проверку копировать по файлам, рано или поздно появится экран,
 * куда можно попасть без сессии.
 */
function AuthGate({ children }: { children: React.ReactNode }) {
  const { session, loading } = useAuth();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (loading) return;

    const onAuthScreen = segments[0] === 'sign-in';

    if (!session && !onAuthScreen) router.replace('/sign-in');
    if (session && onAuthScreen) router.replace('/');
  }, [session, loading, segments, router]);

  if (loading) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg, justifyContent: 'center' }}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  return <>{children}</>;
}

export default function RootLayout() {
  const [fontsReady] = useFonts({
    Manrope_400Regular,
    Manrope_500Medium,
    Manrope_600SemiBold,
    Manrope_700Bold,
    Manrope_800ExtraBold,
  });

  // Пока шрифт не загружен, рисовать нельзя: иначе первый кадр уйдёт
  // системным шрифтом и текст прыгнет при подмене. Экран остаётся
  // фоновым цветом бренда, а не белым — подмены фона тоже не видно.
  if (!fontsReady) {
    return <View style={{ flex: 1, backgroundColor: colors.bg }} />;
  }

  return (
    <SafeAreaProvider>
      <AuthProvider>
        <StatusBar style="dark" />
        <AuthGate>
          <Stack
            screenOptions={{
              headerStyle: { backgroundColor: colors.bg },
              headerTintColor: colors.text,
              headerTitleStyle: { fontFamily: typeface[700] },
              headerShadowVisible: false,
              contentStyle: { backgroundColor: colors.bg },
            }}
          >
            <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
            <Stack.Screen name="sign-in" options={{ headerShown: false }} />
            <Stack.Screen name="item/[id]" options={{ title: 'Объявление' }} />
            <Stack.Screen name="item/new" options={{ title: 'Новое объявление' }} />
            <Stack.Screen name="booking/[id]" options={{ title: 'Сделка' }} />
            <Stack.Screen name="notifications" options={{ title: 'Уведомления' }} />
          </Stack>
        </AuthGate>
      </AuthProvider>
    </SafeAreaProvider>
  );
}
