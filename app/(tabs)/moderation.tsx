import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { ListSkeleton } from '../../src/components/Skeleton';
import { Button, Card, Empty, ErrorState, Field, Row } from '../../src/components/ui';
import {
  fetchDisputesForReview,
  fetchModerationOverview,
  fetchModerationPeople,
  moderatorHideItem,
  moderatorNotify,
  resolveDispute,
  setUserBlocked,
} from '../../src/lib/api';
import { formatDate, formatDateRange, formatTenge, plural } from '../../src/lib/format';
import { humanizeError } from '../../src/lib/supabase';
import type { DisputeForReview, ModerationOverview, ModerationPerson } from '../../src/lib/types';
import { useRefresh } from '../../src/lib/useRefresh';
import { colors, radius, spacing, typeface } from '../../src/theme';

/**
 * Разбор споров. Виден только модератору.
 *
 * Сюда попадает то, что база не смогла решить сама: ущерб выше порога
 * авторешения. Задача экрана — дать решить по доказательствам, а не по
 * пересказу: рядом лежат фото «до» из объявления и фото «после» из
 * претензии, и обе пачки одинакового размера.
 *
 * Список пуст и у обычного пользователя, зашедшего по прямой ссылке:
 * RLS фильтрует строки, а не запрещает запрос. Кнопка решения при этом
 * всё равно откажет — assert_moderator() проверяет право в самой базе.
 */
export default function Moderation() {
  const [disputes, setDisputes] = useState<DisputeForReview[]>([]);
  const [stats, setStats] = useState<ModerationOverview | null>(null);
  const [people, setPeople] = useState<ModerationPerson[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [d, s, p] = await Promise.all([
        fetchDisputesForReview(),
        fetchModerationOverview(),
        fetchModerationPeople(),
      ]);
      setDisputes(d);
      setStats(s);
      setPeople(p);
      setError(null);
    } catch (e) {
      setError(humanizeError(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const { refreshing, onRefresh } = useRefresh(load);

  if (loading) return <ListSkeleton rows={3} />;
  if (error) return <ErrorState message={error} onRetry={load} />;

  return (
    <ScrollView
      contentContainerStyle={s.container}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} />
      }
    >
      {/* Сводка первой: модератор должен видеть картину целиком, а не
          только то, что сломалось. Пустой список споров без контекста
          не отличается от неработающего экрана. */}
      {stats ? (
        <>
          <View style={s.stats}>
            <Stat value={stats.users.total} label="человек" />
            <Stat value={stats.items.active} label="объявлений" />
            <Stat
              value={stats.bookings.pending + stats.bookings.confirmed + stats.bookings.active}
              label="сделок идёт"
            />
            <Stat value={stats.disputes.open} label="на разборе" accent={stats.disputes.open > 0} />
          </View>

          {/* Разрезы, из-за которых сводка вообще нужна. «Шесть человек» не
              говорит ничего; «шесть, из них четверо с Telegram» объясняет,
              почему уведомления доходят не всем. */}
          <Card>
            <Row left="Подтвердили номер" right={`${stats.users.verified} из ${stats.users.total}`} />
            <Row left="Привязали Telegram" right={`${stats.users.telegram} из ${stats.users.total}`} muted />
            <Row left="Сделок завершено" right={String(stats.bookings.completed)} muted />
            <Row left="Отменено" right={String(stats.bookings.cancelled)} muted />
            <Row left="Споров решено автоматически" right={String(stats.disputes.auto)} muted />
            {/* Склонение здесь не косметика: сводку читают на цифрах в
                единицах — «1 объявлений» за неделю выглядит как ошибка
                подсчёта, а не как единственное объявление. */}
            <Text style={s.weekNote}>
              За неделю: {plural(stats.users.week, 'новый участник', 'новых участника', 'новых участников')},{' '}
              {plural(stats.items.week, 'объявление', 'объявления', 'объявлений')},{' '}
              {plural(stats.bookings.week, 'бронь', 'брони', 'броней')}.
            </Text>
          </Card>

          {people.length > 0 ? (
            <Card>
              <Text style={s.section}>Участники · {people.length}</Text>
              {people.map((person) => (
                <PersonRow key={person.id} person={person} onChanged={load} />
              ))}
            </Card>
          ) : null}

          {/* Лента отвечает на вопрос «пилот живой?» лучше любых чисел:
              видно не только сколько, но и когда. Имён достаточно — телефоны
              и суммы сюда не приходят, функция их не возвращает. */}
          {stats.recent.length > 0 ? (
            <Card>
              <Text style={s.section}>Последнее</Text>
              {stats.recent.slice(0, 12).map((event, i) => (
                <View key={`${event.at}-${i}`} style={s.event}>
                  <Ionicons
                    name={
                      event.kind === 'user'
                        ? 'person-add-outline'
                        : event.kind === 'item'
                          ? 'cube-outline'
                          : 'calendar-outline'
                    }
                    size={15}
                    color={colors.textMuted}
                  />
                  <Text style={s.eventText} numberOfLines={1}>
                    {event.text}
                  </Text>
                  <Text style={s.eventDate}>{formatDate(event.at)}</Text>
                </View>
              ))}
            </Card>
          ) : null}
        </>
      ) : null}

      <Text style={s.section}>
        {disputes.length > 0 ? 'Ждут решения' : 'Разбор споров'}
      </Text>

      {disputes.length === 0 ? (
        <Empty
          icon="shield-checkmark-outline"
          title="Разбирать нечего"
          body="Здесь появляются споры с ущербом выше 15 000 ₸ — те, которые база не решает сама. Мелкие закрываются автоматически."
        />
      ) : (
        disputes.map((d) => <DisputeCard key={d.id} dispute={d} onResolved={load} />)
      )}
    </ScrollView>
  );
}

/**
 * Строка участника с действиями модератора.
 *
 * Действия открываются нажатием, а не висят в строке: в списке на двести
 * человек четыре кнопки в каждой строке превращают экран в приборную панель,
 * где ничего не найти. Причина блокировки спрашивается текстом — она уходит
 * человеку в уведомление, и «решение модератора» без объяснения читается
 * как произвол.
 */
function PersonRow({ person, onChanged }: { person: ModerationPerson; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      setReason('');
      setMessage('');
      setOpen(false);
      onChanged();
    } catch (e) {
      setError(humanizeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={s.person}>
      <Pressable
        style={({ pressed }) => [s.personHead, { opacity: pressed ? 0.7 : 1 }]}
        onPress={() => setOpen((v) => !v)}
      >
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={s.personName}>
            {person.full_name || 'Без имени'}
            {person.is_moderator ? ' · модератор' : ''}
            {person.blocked ? ' · заблокирован' : ''}
          </Text>
          <Text style={s.personMeta}>
            {person.phone} · с {formatDate(person.created_at)}
          </Text>
          <Text style={s.personMeta}>
            {plural(person.items, 'объявление', 'объявления', 'объявлений')} ·{' '}
            {plural(person.bookings, 'аренда', 'аренды', 'аренд')}
            {person.telegram ? ' · Telegram' : ''}
            {person.verified ? '' : ' · номер не подтверждён'}
          </Text>
          {person.blocked && person.blocked_reason ? (
            <Text style={[s.personMeta, { color: colors.danger }]}>
              Причина: {person.blocked_reason}
            </Text>
          ) : null}
        </View>
        <Ionicons
          name={open ? 'chevron-up' : 'chevron-down'}
          size={18}
          color={colors.textMuted}
        />
      </Pressable>

      {open ? (
        <View style={s.personActions}>
          {person.blocked ? (
            <Button
              title="Снять блокировку"
              variant="secondary"
              loading={busy}
              onPress={() => run(() => setUserBlocked(person.id, false))}
            />
          ) : (
            <>
              <Field
                label="Причина блокировки"
                hint="Активные объявления этого человека будут сняты с публикации. Обратно они не вернутся сами — вернуть их сможет только он."
                value={reason}
                onChangeText={setReason}
                placeholder="Что произошло — человек это увидит"
              />
              <Button
                title="Заблокировать"
                variant="danger"
                loading={busy}
                disabled={reason.trim().length < 5}
                onPress={() => run(() => setUserBlocked(person.id, true, reason.trim()))}
              />
            </>
          )}

          <Field
            label="Сообщение участнику"
            value={message}
            onChangeText={setMessage}
            placeholder="Придёт в Telegram, если он привязан"
            multiline
          />
          <Button
            title="Отправить сообщение"
            variant="secondary"
            loading={busy}
            disabled={message.trim().length < 3}
            onPress={() =>
              run(() => moderatorNotify(person.id, 'Сообщение от модератора', message.trim()))
            }
          />

          {!person.telegram ? (
            <Text style={s.personMeta}>
              Telegram не привязан — сообщение будет ждать в приложении, пока человек
              не откроет бота.
            </Text>
          ) : null}

          {error ? <Text style={s.personError}>{error}</Text> : null}
        </View>
      ) : null}
    </View>
  );
}

function Stat({ value, label, accent }: { value: number; label: string; accent?: boolean }) {
  return (
    <View style={s.stat}>
      <Text style={[s.statValue, accent && { color: colors.danger }]}>{value}</Text>
      <Text style={s.statLabel}>{label}</Text>
    </View>
  );
}

function DisputeCard({
  dispute,
  onResolved,
}: {
  dispute: DisputeForReview;
  onResolved: () => void;
}) {
  const deposit = dispute.booking?.deposit_snapshot ?? 0;
  const [amount, setAmount] = useState(String(Math.min(dispute.claim_amount, deposit)));
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Снятие объявления — отдельное состояние, а не общий busy: пока модератор
  // печатает причину, кнопка «Решить спор» не должна выглядеть занятой.
  const itemId = dispute.booking?.item?.id ?? null;
  const [hideOpen, setHideOpen] = useState(false);
  const [hideReason, setHideReason] = useState('');
  const [hiding, setHiding] = useState(false);

  const value = Number(amount) || 0;
  const tooMuch = value > deposit;

  return (
    <Card style={{ borderColor: colors.danger }}>
      <View style={s.head}>
        <Ionicons
          name={dispute.type === 'damage' ? 'hammer-outline' : 'alert-circle-outline'}
          size={20}
          color={colors.danger}
        />
        <View style={{ flex: 1 }}>
          <Text style={s.title}>
            {dispute.booking?.item?.title ?? 'Объявление удалено'}
          </Text>
          <Text style={s.meta}>
            {dispute.type === 'damage' ? 'Порча вещи' : 'Невозврат'} ·{' '}
            {dispute.booking
              ? formatDateRange(dispute.booking.start_date, dispute.booking.end_date)
              : '—'}
          </Text>
        </View>
      </View>

      <Row left="Заявленный ущерб" right={formatTenge(dispute.claim_amount)} />
      <Row left="Депозит в сделке" right={formatTenge(deposit)} muted />
      <Row left="Открыт" right={formatDate(dispute.created_at)} muted />

      {dispute.description ? (
        <View style={s.quote}>
          <Text style={s.quoteText}>{dispute.description}</Text>
        </View>
      ) : null}

      {/* Обе пачки рядом и одного размера: решение принимается сравнением,
          и если «после» крупнее «до», глаз обманывается сам. */}
      <View style={s.evidence}>
        <View style={{ flex: 1, gap: spacing.xs }}>
          <Text style={s.evidenceLabel}>Было при выдаче</Text>
          <PhotoStrip photos={dispute.booking?.item?.condition_photos ?? []} />
        </View>
        <View style={{ flex: 1, gap: spacing.xs }}>
          <Text style={s.evidenceLabel}>Стало при возврате</Text>
          <PhotoStrip photos={dispute.evidence_photos} />
        </View>
      </View>

      {/* Снять объявление — второе действие модератора в этом же месте, и
          оно не про деньги. Функция была в базе и в api с самого начала, а
          нажать её было негде: спор разбирают по фото, и «фото не от этой
          вещи» решается снятием, а не суммой. */}
      {itemId ? (
        hideOpen ? (
          <View style={s.hideBox}>
            <Field
              label="Почему снимаем"
              value={hideReason}
              onChangeText={setHideReason}
              placeholder="Фото не соответствуют вещи"
              hint="Причина уйдёт владельцу в уведомление — без неё снятие читается как произвол"
            />
            <Button
              title="Снять с публикации"
              variant="danger"
              loading={hiding}
              disabled={hideReason.trim().length < 3}
              onPress={async () => {
                setHiding(true);
                setError(null);
                try {
                  await moderatorHideItem(itemId, hideReason.trim());
                  setHideOpen(false);
                  setHideReason('');
                  onResolved();
                } catch (e) {
                  setError(humanizeError(e));
                } finally {
                  setHiding(false);
                }
              }}
            />
            <Button title="Не снимать" variant="ghost" onPress={() => setHideOpen(false)} />
          </View>
        ) : (
          <Button
            title="Снять объявление с публикации"
            variant="ghost"
            onPress={() => setHideOpen(true)}
          />
        )
      ) : null}

      <Field
        label="Удержать из депозита, ₸"
        value={amount}
        onChangeText={setAmount}
        keyboardType="number-pad"
        hint={`Не больше депозита — ${formatTenge(deposit)}. Остаток вернётся арендатору.`}
      />
      <Field
        label="Обоснование"
        value={note}
        onChangeText={setNote}
        placeholder="Что подтверждают фото и почему такая сумма"
        multiline
      />

      {tooMuch ? (
        <View style={s.warn}>
          <Ionicons name="alert-circle-outline" size={17} color={colors.warn} />
          <Text style={s.warnText}>
            Больше депозита выплатить нельзя — база откажет. Платформа не может отдать
            больше, чем заблокировала.
          </Text>
        </View>
      ) : null}

      {error ? <Text style={s.error}>{error}</Text> : null}

      <Button
        title="Решить спор"
        variant="danger"
        loading={busy}
        disabled={tooMuch || note.trim().length < 3}
        onPress={async () => {
          setBusy(true);
          setError(null);
          try {
            await resolveDispute({ disputeId: dispute.id, amount: value, note: note.trim() });
            onResolved();
          } catch (e) {
            setError(humanizeError(e));
          } finally {
            setBusy(false);
          }
        }}
      />

      <Text style={s.note}>
        После решения сделка закроется: компенсация начислится владельцу отдельной
        строкой, остаток депозита вернётся арендатору. Отменить нельзя.
      </Text>

      {/* Снятие объявления — отдельное решение, а не часть разбора спора.
          Спор бывает о состоянии вещи, а объявление снимают за другое: чужие
          фото, запрещённый предмет, цена-приманка. Кнопка стоит здесь просто
          потому, что модератор уже смотрит на это объявление. */}
      {dispute.booking?.item?.id ? (
        <Button
          title="Снять объявление с публикации"
          variant="ghost"
          loading={busy}
          onPress={async () => {
            setBusy(true);
            setError(null);
            try {
              await moderatorHideItem(
                dispute.booking!.item!.id,
                note.trim() || undefined,
              );
              onResolved();
            } catch (e) {
              setError(humanizeError(e));
            } finally {
              setBusy(false);
            }
          }}
        />
      ) : null}
    </Card>
  );
}

function PhotoStrip({ photos }: { photos: string[] }) {
  if (photos.length === 0) {
    return (
      <View style={[s.photo, s.photoEmpty]}>
        <Ionicons name="image-outline" size={18} color={colors.textMuted} />
      </View>
    );
  }
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={{ flexGrow: 0 }}
      contentContainerStyle={{ gap: 6, alignItems: 'center' }}
    >
      {photos.map((uri) => (
        <Image key={uri} source={uri} style={s.photo} contentFit="cover" transition={180} />
      ))}
    </ScrollView>
  );
}

const s = StyleSheet.create({
  container: { padding: spacing.lg, gap: spacing.lg, paddingBottom: spacing.xxl },
  stats: { flexDirection: 'row', gap: spacing.sm },
  stat: {
    flex: 1,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    paddingVertical: spacing.md,
    alignItems: 'center',
    gap: 2,
  },
  statValue: { fontSize: 22, fontFamily: typeface[800], color: colors.text },
  statLabel: { fontSize: 11, fontFamily: typeface[500], color: colors.textMuted },
  section: { fontSize: 16, fontFamily: typeface[700], color: colors.text },
  head: { flexDirection: 'row', gap: spacing.md, alignItems: 'flex-start' },
  title: { fontSize: 16, fontFamily: typeface[700], color: colors.text },
  meta: { fontSize: 12, fontFamily: typeface[400], color: colors.textMuted, marginTop: 2 },
  hideBox: { gap: spacing.sm, paddingVertical: spacing.sm },
  quote: {
    borderLeftWidth: 3,
    borderLeftColor: colors.border,
    paddingLeft: spacing.md,
  },
  quoteText: { fontSize: 14, fontFamily: typeface[400], color: colors.text, lineHeight: 20 },
  evidence: { flexDirection: 'row', gap: spacing.md },
  evidenceLabel: { fontSize: 11, fontFamily: typeface[700], color: colors.textMuted, textTransform: 'uppercase' },
  photo: { width: 72, height: 72, borderRadius: radius.sm, backgroundColor: colors.border },
  photoEmpty: { alignItems: 'center', justifyContent: 'center', backgroundColor: colors.accentSoft },
  weekNote: { fontSize: 13, fontFamily: typeface[500], color: colors.textMuted, marginTop: spacing.sm },
  person: { borderTopWidth: 1, borderTopColor: colors.border },
  personHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.sm,
  },
  personActions: { gap: spacing.md, paddingBottom: spacing.md, paddingTop: spacing.xs },
  personError: { fontSize: 13, fontFamily: typeface[400], color: colors.danger },
  personName: { fontSize: 15, fontFamily: typeface[700], color: colors.text },
  personMeta: { fontSize: 12, fontFamily: typeface[400], color: colors.textMuted },
  event: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: 7 },
  eventText: { flex: 1, fontSize: 14, fontFamily: typeface[500], color: colors.text },
  eventDate: { fontSize: 12, fontFamily: typeface[400], color: colors.textMuted },
  warn: {
    flexDirection: 'row',
    gap: spacing.sm,
    alignItems: 'flex-start',
    backgroundColor: colors.warnSoft,
    borderRadius: radius.md,
    padding: spacing.md,
  },
  warnText: { flex: 1, fontSize: 12, fontFamily: typeface[600], color: colors.warn, lineHeight: 18 },
  error: { fontSize: 14, fontFamily: typeface[400], color: colors.danger },
  note: { fontSize: 12, fontFamily: typeface[400], color: colors.textMuted, lineHeight: 18 },
});
