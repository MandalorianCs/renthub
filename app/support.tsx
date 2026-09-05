import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { ListSkeleton } from '../src/components/Skeleton';
import { Badge, Button, Card, ErrorState, Field, ScreenHead } from '../src/components/ui';
import { fetchMySupport, submitSupport } from '../src/lib/api';
import { formatDateTime, plural } from '../src/lib/format';
import { useAuth } from '../src/lib/auth';
import { humanizeError } from '../src/lib/supabase';
import type { MySupportMessage } from '../src/lib/types';
import { useRefresh } from '../src/lib/useRefresh';
import { colors, radius, spacing, typeface } from '../src/theme';

/**
 * Написать организатору.
 *
 * 02.09.2026 канал поддержки завели наполовину: бот научился принимать
 * обращение, приложение — нет. Половина хуже, чем кажется, потому что
 * ссылку на продукт дают на приложение, и человек, у которого что-то
 * пошло не так, сидит именно здесь. Отправить его в Telegram за тем,
 * чтобы задать вопрос, — это ещё один шаг там, где он уже расстроен.
 *
 * Ответ приходит не сюда, а в уведомления: модератор отвечает
 * moderator_notify(), а тот кладёт сообщение в ту же ленту, что и
 * подтверждения броней. Отдельной переписки здесь нет намеренно — чат
 * между двумя людьми это уже другой продукт, а вопрос «мне ответили?»
 * закрывается ссылкой на ленту.
 *
 * Чего этот экран НЕ делает: не показывает ответ рядом с вопросом.
 * moderator_notify() не знает, на какое обращение отвечает — у него нет
 * такого поля, — и связать их можно было бы только по времени, то есть
 * угадать. Угаданная связь хуже честного «ответ придёт в уведомления».
 */
export default function Support() {
  const { session } = useAuth();
  const router = useRouter();
  const [items, setItems] = useState<MySupportMessage[]>([]);
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!session) return;
    try {
      setItems(await fetchMySupport(session.user.id));
      setError(null);
    } catch (e) {
      setError(humanizeError(e));
    } finally {
      setLoading(false);
    }
  }, [session]);

  useEffect(() => {
    load();
  }, [load]);

  const { refreshing, onRefresh } = useRefresh(load);

  // Предел в три открытых обращения стоит в базе — support_add() откажет
  // и без нас. Но узнать об этом после того, как человек написал письмо,
  // значит потерять его текст и его время. Считаем здесь и говорим до.
  const open = items.filter((m) => !m.handled_at).length;
  const atLimit = open >= 3;

  async function send() {
    setBusy(true);
    setFormError(null);
    try {
      await submitSupport(text.trim());
      setText('');
      setSent(true);
      await load();
    } catch (e) {
      setFormError(humanizeError(e));
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <ListSkeleton rows={3} />;
  if (error) return <ErrorState message={error} onRetry={load} />;

  return (
    <ScrollView
      contentContainerStyle={s.container}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} />
      }
      // Те же две строки, что в форме публикации: обращение пишут
      // длинным текстом, поле стоит внизу экрана, и без отступа под
      // клавиатуру человек не видит, что печатает. «handled» нужен
      // отдельно — иначе первое нажатие на «Отправить» только прячет
      // клавиатуру, и кнопка выглядит несработавшей.
      keyboardShouldPersistTaps="handled"
      automaticallyAdjustKeyboardInsets
    >
      <ScreenHead
        title="Написать организатору"
        sub="Если что-то пошло не так со сделкой, вещью или входом — напишите. Читает живой человек."
        tone="warm"
        bleed
      />

      <Card>
        {/* Куда придёт ответ — первым, до поля ввода. Человек, отправивший
            вопрос в пустоту и не знающий, где ждать, приходит писать
            второй раз. */}
        <View style={s.note}>
          <Ionicons name="notifications-outline" size={17} color={colors.textMuted} />
          <Text style={s.noteText}>
            Ответ придёт в «Уведомления», а если у вас привязан Telegram — то и в чат
            с ботом. Отвечает не робот, поэтому не мгновенно.
          </Text>
        </View>

        {atLimit ? (
          // Причина недоступности — заметным блоком, а не мелким серым:
          // иначе выключенная кнопка читается как поломка.
          <View style={s.limit}>
            <Ionicons name="hourglass-outline" size={18} color={colors.warn} />
            <Text style={s.limitText}>
              У вас {plural(open, 'обращение', 'обращения', 'обращений')} без ответа.
              Новое можно будет отправить, когда разберут эти — так очередь не забивается
              одним человеком, и ваши прежние вопросы не теряются.
            </Text>
          </View>
        ) : (
          <>
            <Field
              label="Что случилось"
              placeholder="Например: арендатор не выходит на связь, а вещь надо вернуть завтра"
              value={text}
              onChangeText={(v) => {
                setText(v);
                setSent(false);
              }}
              multiline
              maxLength={2000}
              hint="Напишите, что именно не получилось и на какой сделке — так разберут быстрее."
            />

            <Button
              title="Отправить"
              loading={busy}
              disabled={text.trim().length < 2}
              onPress={send}
            />
          </>
        )}

        {sent ? (
          <View style={s.ok}>
            <Ionicons name="checkmark-circle-outline" size={18} color={colors.green} />
            <Text style={s.okText}>
              Отправили. Обращение ниже — оно останется здесь, чтобы «я вам писал» не
              пришлось доказывать.
            </Text>
          </View>
        ) : null}

        {formError ? (
          <View style={s.errorBox}>
            <Ionicons name="alert-circle-outline" size={18} color={colors.danger} />
            <Text style={s.error}>{formError}</Text>
          </View>
        ) : null}
      </Card>

      <Card>
        <Text style={s.sectionTitle}>Ваши обращения</Text>

        {items.length === 0 ? (
          <Text style={s.note}>
            Здесь появятся ваши вопросы и отметка о том, что их разобрали. Пока вы ничего
            не писали — и это хорошо.
          </Text>
        ) : (
          items.map((m) => (
            <View key={m.id} style={s.item}>
              <View style={s.itemHead}>
                <Text style={s.itemDate}>{formatDateTime(m.created_at)}</Text>
                {m.handled_at ? (
                  <Badge label="Разобрано" fg={colors.green} bg={colors.greenSoft} />
                ) : (
                  <Badge label="Ждёт ответа" fg={colors.warn} bg={colors.warnSoft} />
                )}
              </View>
              <Text style={s.itemText}>{m.text}</Text>
            </View>
          ))
        )}
      </Card>

      <Button
        title="Открыть уведомления"
        variant="ghost"
        onPress={() => router.push('/notifications')}
      />
    </ScrollView>
  );
}

const s = StyleSheet.create({
  container: { padding: spacing.lg, gap: spacing.md },
  sectionTitle: { fontSize: 15, fontFamily: typeface[700], color: colors.text },
  note: { flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-start' },
  noteText: {
    flex: 1,
    fontSize: 13,
    fontFamily: typeface[400],
    color: colors.textMuted,
    lineHeight: 19,
  },
  limit: {
    flexDirection: 'row',
    gap: spacing.sm,
    alignItems: 'flex-start',
    backgroundColor: colors.warnSoft,
    borderRadius: radius.md,
    padding: spacing.md,
  },
  limitText: { flex: 1, fontSize: 13, fontFamily: typeface[500], color: colors.text, lineHeight: 19 },
  ok: { flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-start' },
  okText: { flex: 1, fontSize: 13, fontFamily: typeface[400], color: colors.green, lineHeight: 19 },
  errorBox: { flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-start' },
  error: { flex: 1, fontSize: 13, fontFamily: typeface[400], color: colors.danger, lineHeight: 19 },
  item: {
    gap: spacing.xs,
    paddingVertical: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  itemHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  itemDate: { fontSize: 12, fontFamily: typeface[400], color: colors.textMuted },
  itemText: { fontSize: 14, fontFamily: typeface[400], color: colors.text, lineHeight: 20 },
});
