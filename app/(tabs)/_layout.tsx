import { Ionicons } from '@expo/vector-icons';
import { Tabs } from 'expo-router';
import { useAuth } from '../../src/lib/auth';
import { colors, typeface } from '../../src/theme';

export default function TabsLayout() {
  const { profile } = useAuth();

  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: colors.bg },
        headerShadowVisible: false,
        headerTitleStyle: { fontFamily: typeface[800], fontSize: 20 },
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.textMuted,
        tabBarLabelStyle: { fontFamily: typeface[600], fontSize: 11, marginTop: 2 },
        // Высота с запасом: стандартные 49 пунктов на Android прижимают
        // подпись к иконке, и вкладки читаются как одна серая полоса.
        tabBarStyle: {
          backgroundColor: colors.surface,
          borderTopColor: colors.border,
          height: 62,
          paddingTop: 6,
          paddingBottom: 8,
        },
        sceneStyle: { backgroundColor: colors.bg },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Каталог',
          tabBarIcon: ({ color, size }) => <Ionicons name="search" color={color} size={size} />,
        }}
      />
      <Tabs.Screen
        name="bookings"
        options={{
          title: 'Мои аренды',
          tabBarIcon: ({ color, size }) => <Ionicons name="calendar" color={color} size={size} />,
        }}
      />
      <Tabs.Screen
        name="my-items"
        options={{
          title: 'Мои вещи',
          tabBarIcon: ({ color, size }) => <Ionicons name="construct" color={color} size={size} />,
        }}
      />

      {/*
        Вкладка модератора.
        href: null убирает её из меню, не убирая экран из маршрутов — по
        прямой ссылке он откроется у кого угодно. Так и должно быть:
        спрятанная кнопка это подсказка, а не защита. Настоящая защита в
        базе — список споров придёт пустым без права на чтение, а решение
        отклонит assert_moderator().
      */}
      <Tabs.Screen
        name="moderation"
        options={{
          title: 'Модерация',
          href: profile?.is_moderator ? undefined : null,
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="shield-checkmark" color={color} size={size} />
          ),
        }}
      />

      <Tabs.Screen
        name="profile"
        options={{
          title: 'Профиль',
          tabBarIcon: ({ color, size }) => <Ionicons name="person" color={color} size={size} />,
        }}
      />
    </Tabs>
  );
}
