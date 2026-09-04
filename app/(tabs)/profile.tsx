import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { Linking, Pressable, RefreshControl, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { Badge, Button, Card, ErrorState, Field, Row, ScreenHead, tap } from '../../src/components/ui';
import { fetchMyBookings, fetchNotifications, updateProfile } from '../../src/lib/api';
import { useAuth } from '../../src/lib/auth';
import { BOOKING_STATUS, formatDateRange, ratingLabel } from '../../src/lib/format';
import { Ionicons } from '@expo/vector-icons';
import { ListSkeleton } from '../../src/components/Skeleton';
import { humanizeError, TELEGRAM_BOT, TELEGRAM_BOT_URL } from '../../src/lib/supabase';
import { useRefresh } from '../../src/lib/useRefresh';
import type { BookingWithItem } from '../../src/lib/types';
import { colors, radius, spacing, typeface } from '../../src/theme';

/** Экран 6: профиль — рейтинг, история сделок, настройки. */
export default function Profile() {
  const { session, profile, profileError, isVerified, linkEmail, signOut, refreshProfile } = useAuth();
  const router = useRouter();

  const [history, setHistory] = useState<BookingWithItem[]>([]);
  const [unread, setUnread] = useState(0);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!session) return;
    try {
      const [bookings, notifications] = await Promise.all([
        fetchMyBookings(session.user.id),
        // Счётчик непрочитанного — со своим catch по той же причине, что
        // лента в «Моих вещах»: это цифра над колокольчиком, а история
        // сделок — содержимое экрана. Терять второе из-за первого нечестный
        // размен, и он был: отказ счётчика уводил весь профиль в ошибку.
        fetchNotifications(session.user.id).catch(() => []),
      ]);
      setHistory(bookings.filter((b) => b.status === 'completed'));
      setUnread(notifications.filter((n) => !n.read_at).length);
    } catch (e) {
      setError(humanizeError(e));
    }
  }, [session]);

  useFocusEffect(
    useCallback(() => {
      load();
      setName(profile?.full_name ?? '');
    }, [load, profile?.full_name]),
  );

  const { refreshing, onRefresh } = useRefresh(load);

  // Профиля нет по двум причинам, и выглядеть они обязаны по-разному.
  // Сбой — отказ с кнопкой повтора. Отсутствие строки сразу после регистрации
  // (триггер on_auth_user_created ещё не отработал) — заглушка: данные
  // действительно едут, и через секунду появятся сами.
  if (!profile) {
    if (profileError) return <ErrorState message={profileError} onRetry={refreshProfile} />;
    return <ListSkeleton rows={3} />;
  }

  return (
    <ScrollView
      contentContainerStyle={s.container}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} />
      }
    >
      <ScreenHead title="Профиль" sub="Рейтинг, история сделок и настройки" bleed />

      <Card>
        <View style={s.head}>
          <View style={s.avatar}>
            <Text style={s.avatarText}>{initials(profile.full_name)}</Text>
          </View>
          <View style={{ flex: 1, gap: 3 }}>
            <Text style={s.name}>{profile.full_name || 'Без имени'}</Text>
            <View style={s.ratingRow}>
              <Ionicons name="star" size={13} color={colors.warn} />
              <Text style={s.rating}>{ratingLabel(profile.rating, profile.ratings_count)}</Text>
            </View>
            <Text style={s.phone}>{profile.phone}</Text>
          </View>
        </View>

        {isVerified ? (
          <Badge label="Телефон подтверждён" fg={colors.green} bg={colors.greenSoft} />
        ) : (
          <Badge label="Телефон не подтверждён" fg={colors.warn} bg={colors.warnSoft} />
        )}
      </Card>

      <Card>
        <Field label="Имя" value={name} onChangeText={setName} placeholder="Как к вам обращаться" />
        <Button
          title="Сохранить"
          loading={saving}
          onPress={async () => {
            setSaving(true);
            try {
              await updateProfile(profile.id, { full_name: name.trim() });
              await refreshProfile();
            } catch (e) {
              setError(humanizeError(e));
            } finally {
              setSaving(false);
            }
          }}
        />
      </Card>

      <Card>
        <View style={s.switchRow}>
          <View style={{ flex: 1 }}>
            <Text style={s.switchLabel}>Пассивный режим</Text>
            <Text style={s.note}>
              Платформа сама следит за сроками и присылает готовый итог. Выключите, если
              хотите управлять сделками вручную и видеть подробный трекинг.
            </Text>
          </View>
          <Switch
            value={profile.passive_mode}
            trackColor={{ true: colors.accent, false: colors.border }}
            onValueChange={async (value) => {
              // Без обработки ошибка здесь превращалась в необработанное
              // отклонение промиса: переключатель отскакивал назад молча.
              try {
                await updateProfile(profile.id, { passive_mode: value });
                await refreshProfile();
              } catch (e) {
                setError(humanizeError(e));
              }
            }}
          />
        </View>
      </Card>

      <Card>
        <Text style={s.sectionTitle}>Уведомления в Telegram</Text>
        {profile.telegram_id ? (
          <>
            <Badge label="Подключено" fg={colors.green} bg={colors.greenSoft} />
            <Text style={s.note}>
              Подтверждения броней, напоминания о возврате и решения по спорам приходят
              в Telegram{profile.telegram_username ? ` — на @${profile.telegram_username}` : ''}.
              Отключить можно командой /unlink в самом боте.
            </Text>
          </>
        ) : (
          <>
            <Text style={s.note}>
              Бот пришлёт подтверждение брони и напомнит о возврате, чтобы не пришлось
              открывать приложение. Telegram не может написать первым — поэтому первый
              шаг за вами: откройте бота и нажмите «Поделиться номером».
            </Text>
            <Button
              title={`Открыть @${TELEGRAM_BOT}`}
              variant="secondary"
              onPress={() => Linking.openURL(TELEGRAM_BOT_URL)}
            />
          </>
        )}
      </Card>

      <EmailCard current={session?.user.email ?? null} onLink={linkEmail} />

      <Card>
        <Pressable
          style={({ pressed }) => [s.linkRow, tap({ pressed })]}
          onPress={() => router.push('/notifications')}
        >
          <Ionicons name="notifications-outline" size={20} color={colors.text} />
          <Text style={s.linkTitle}>Уведомления</Text>
          {unread > 0 ? (
            <View style={s.counter}>
              <Text style={s.counterText}>{unread}</Text>
            </View>
          ) : (
            <Text style={s.note}>нет новых</Text>
          )}
          <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
        </Pressable>

        {/* Дверь к живому человеку.
            До 03.09.2026 её здесь не было: канал поддержки умел принимать
            обращение только из Telegram, хотя ссылку на продукт дают на
            приложение. Человек, у которого что-то пошло не так со сделкой,
            находил в профиле телефон, почту и рейтинг — и ни одного места,
            куда написать. */}
        <Pressable
          style={({ pressed }) => [s.linkRow, tap({ pressed })]}
          onPress={() => router.push('/support')}
        >
          <Ionicons name="chatbubble-ellipses-outline" size={20} color={colors.text} />
          <Text style={s.linkTitle}>Написать организатору</Text>
          <Text style={s.note}>что-то не так</Text>
          <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
        </Pressable>
      </Card>

      <Card>
        <Text style={s.sectionTitle}>История сделок</Text>
        {history.length === 0 ? (
          <Text style={s.note}>Завершённых сделок пока нет.</Text>
        ) : (
          history.map((b) => (
            <Row
              key={b.id}
              left={b.item?.title ?? '—'}
              right={`${formatDateRange(b.start_date, b.end_date)} · ${BOOKING_STATUS[b.status].label}`}
              muted
            />
          ))
        )}
      </Card>

      {error ? (
        <View style={s.errorBox}>
          <Ionicons name="alert-circle-outline" size={18} color={colors.danger} />
          <Text style={s.error}>{error}</Text>
        </View>
      ) : null}

      <Button title="Выйти" variant="ghost" onPress={signOut} />
    </ScrollView>
  );
}

/**
 * Почта для входа.
 *
 * Привязывает её сам человек, а не админ-скрипт: почта — личные данные, и
 * подставлять её за него странно. Supabase шлёт письмо подтверждения, и
 * адрес меняется только после перехода по ссылке — до этого в аккаунте
 * остаётся прежний.
 *
 * Служебный адрес вида 77010000001@renthub.test показывать как «вашу
 * почту» нельзя: человек его не заводил, не знает и написать на него
 * не сможет. Для него это то же самое, что почты нет.
 */
function EmailCard({
  current,
  onLink,
}: {
  current: string | null;
  onLink: (email: string) => Promise<void>;
}) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const real = current && !current.endsWith('@renthub.test') ? current : null;

  return (
    <Card>
      <Text style={s.sectionTitle}>Почта для входа</Text>

      {real ? (
        <>
          <Badge label="Привязана" fg={colors.green} bg={colors.greenSoft} />
          <Text style={s.note}>
            Вход по почте работает на адрес {real}. Сменить — введите другой ниже,
            подтверждение придёт письмом на новый адрес.
          </Text>
        </>
      ) : (
        <Text style={s.note}>
          Запасной способ войти, если Telegram недоступен. Код или ссылка придут
          письмом. Пока почта не привязана, вход по ней не работает: незнакомый
          адрес получает отказ, чтобы на него не завёлся пустой второй аккаунт.
        </Text>
      )}

      {sent ? (
        <Text style={s.note}>
          Письмо отправлено. Перейдите по ссылке в нём — адрес сменится только после
          этого. Проверьте папку «Спам».
        </Text>
      ) : (
        <>
          <Field
            label={real ? 'Новый адрес' : 'Адрес почты'}
            placeholder="name@gmail.com"
            keyboardType="email-address"
            autoCapitalize="none"
            autoComplete="email"
            value={value}
            onChangeText={setValue}
          />
          <Button
            title={real ? 'Сменить почту' : 'Привязать почту'}
            loading={busy}
            disabled={!/.+@.+\..+/.test(value.trim())}
            onPress={async () => {
              setBusy(true);
              setError(null);
              try {
                await onLink(value);
                setSent(true);
              } catch (e) {
                setError(humanizeError(e));
              } finally {
                setBusy(false);
              }
            }}
          />
          {/* Предупреждение стоит рядом с кнопкой, а не в общей справке:
              адрес учётной записи и есть логин для входа по приглашению,
              и человек должен узнать об этом до нажатия, а не когда пароль
              перестанет подходить. */}
          <Text style={s.note}>
            Адрес учётной записи — это и логин для входа по приглашению. После смены
            пароль из приглашения работает с новой почтой, а не с номером телефона.
          </Text>
        </>
      )}

      {error ? <Text style={s.error}>{error}</Text> : null}
    </Card>
  );
}

const s = StyleSheet.create({
  container: { padding: spacing.lg, gap: spacing.lg, paddingBottom: spacing.xxl },
  head: { flexDirection: 'row', alignItems: 'center', gap: spacing.lg },
  avatar: {
    width: 60, height: 60, borderRadius: 30,
    backgroundColor: colors.accentSoft,
    alignItems: 'center', justifyContent: 'center',
  },
  avatarText: { fontSize: 20, fontFamily: typeface[800], color: colors.accent },
  ratingRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  linkRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  linkTitle: { flex: 1, fontSize: 15, fontFamily: typeface[700], color: colors.text },
  counter: {
    minWidth: 22, height: 22, borderRadius: 11, paddingHorizontal: 6,
    backgroundColor: colors.accent,
    alignItems: 'center', justifyContent: 'center',
  },
  counterText: { fontSize: 12, fontFamily: typeface[800], color: colors.onFill },
  errorBox: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
    backgroundColor: colors.dangerSoft, borderRadius: radius.md, padding: spacing.md,
  },
  name: { fontSize: 22, fontFamily: typeface[800], color: colors.text },
  phone: { fontSize: 14, fontFamily: typeface[400], color: colors.textMuted },
  rating: { fontSize: 15, fontFamily: typeface[600], color: colors.text },
  sectionTitle: { fontSize: 16, fontFamily: typeface[700], color: colors.text },
  note: { fontSize: 12, fontFamily: typeface[400], color: colors.textMuted, lineHeight: 18 },
  error: { fontSize: 14, fontFamily: typeface[400], color: colors.danger },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  switchLabel: { fontSize: 15, fontFamily: typeface[700], color: colors.text },
});

/** Инициалы для аватара — те же правила, что в профиле владельца. */
function initials(name?: string | null): string {
  if (!name) return '—';
  const parts = name.trim().split(' ').filter(Boolean);
  return parts.slice(0, 2).map((p) => p[0]?.toUpperCase() ?? '').join('') || '—';
}
