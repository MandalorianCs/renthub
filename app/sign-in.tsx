import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import { KeyboardAvoidingView, Linking, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Button, Field } from '../src/components/ui';
import { useAuth } from '../src/lib/auth';
import { humanizeError, TELEGRAM_BOT, TELEGRAM_BOT_URL } from '../src/lib/supabase';
import { colors, radius, spacing, typeface } from '../src/theme';

/**
 * Экран входа.
 *
 * Два способа, и оба подтверждают одно и то же — что телефон принадлежит
 * человеку. Меняется только кто это подтверждает:
 *
 *   приглашение — вы, лично, заведя аккаунт командой npm run invite;
 *   код из SMS  — оператор связи, когда будет подключён провайдер.
 *
 * Правило 1 при этом выполняется по-настоящему: verified_at проставляется
 * триггером из phone_confirmed_at, и обход проверки здесь не появляется.
 *
 * Порядок способов задаётся EXPO_PUBLIC_AUTH_MODE. С 21.08.2026 значение
 * `sms` — коды доставляет бот в Telegram через Send SMS Hook, и вход по коду
 * стоит первым. Имя режима осталось прежним намеренно: так его называет сам
 * Supabase (провайдер Phone, `signInWithOtp`), и переименование в коде
 * разошлось бы с тем, что написано в панели.
 *
 * Значение `invite` возвращает прежний порядок — вход паролем из
 * приглашения. Он остаётся рабочим для тех, у кого Telegram не привязан:
 * бот не может написать первым, и это не обходится ничем.
 */
const AUTH_MODE = process.env.EXPO_PUBLIC_AUTH_MODE ?? 'invite';

export default function SignIn() {
  const [tab, setTab] = useState<'invite' | 'sms' | 'email'>(AUTH_MODE === 'sms' ? 'sms' : 'invite');
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  // Отказ, с которым вернула ссылка из письма. Раньше он приходил в хвосте
  // адреса и не читался никем: человек оказывался на витрине невошедшим и
  // без единого слова о том, что произошло. Показываем его до всего
  // остального — он объясняет, почему человек вообще здесь.
  const { linkError } = useAuth();

  return (
    <SafeAreaView style={s.safe}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1 }}
      >
        <ScrollView contentContainerStyle={s.container}>
          <View style={s.header}>
            <Text style={s.logo}>RentHUB.</Text>
            <Text style={s.tagline}>
              Аренда строительного инструмента у соседей — с депозитом, проверкой и рейтингом.
            </Text>
          </View>

          {/* Подписи короткие: трёх полных названий («По приглашению»,
              «Через Telegram», «По почте») в ряд на телефоне не помещается,
              а перенос на две строки превращает переключатель в блок
              текста. Способ входа человек выбирает по одному слову. */}
          {linkError ? (
            <View style={s.linkError}>
              <Ionicons name="link-outline" size={18} color={colors.danger} />
              <Text style={s.linkErrorText}>{linkError}</Text>
            </View>
          ) : null}

          <View style={s.tabs}>
            <Tab
              label="Приглашение"
              active={tab === 'invite'}
              onPress={() => {
                setTab('invite');
                setError(null);
              }}
            />
            <Tab
              label="Telegram"
              active={tab === 'sms'}
              onPress={() => {
                setTab('sms');
                setError(null);
              }}
            />
            <Tab
              label="Почта"
              active={tab === 'email'}
              onPress={() => {
                setTab('email');
                setError(null);
              }}
            />
          </View>

          {tab === 'invite' ? (
            <InviteForm onError={setError} />
          ) : tab === 'sms' ? (
            <SmsForm onError={setError} />
          ) : (
            <EmailForm onError={setError} />
          )}

          {error ? <Text style={s.error}>{error}</Text> : null}

          {/* Дверь туда, куда экран и так отправляет словами.
              Форма говорит «каталог можно смотреть и без входа», но пути
              туда не давала: человек, которого сюда привёл маршрутный
              сторож — открыл ссылку на сделку, пришёл по рекламе, — упирался
              в форму без выхода. Сказать про возможность и не дать её
              читается как отговорка. */}
          <Pressable
            onPress={() => router.replace('/')}
            style={({ pressed }) => [s.exit, pressed && { opacity: 0.6 }]}
            accessibilityRole="link"
            accessibilityLabel="Смотреть каталог без входа"
          >
            <Text style={s.exitText}>Смотреть каталог без входа</Text>
          </Pressable>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

/**
 * Вход по приглашению. Человек вводит свой номер и выданный пароль —
 * адрес учётной записи клиент собирает сам, показывать его незачем.
 */
function InviteForm({ onError }: { onError: (m: string | null) => void }) {
  const { signInWithInvite } = useAuth();
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  return (
    <View style={s.form}>
      <Field
        label="Номер телефона или почта"
        placeholder="+7 705 123 45 67"
        keyboardType="default"
        autoCapitalize="none"
        autoComplete="username"
        value={phone}
        onChangeText={setPhone}
        hint="Почта — если вам её привязали: тогда номер здесь уже не подойдёт"
      />
      {/* Двенадцать, а не восемь. Длину подняли 04.09.2026 после замера по
          базе утечек HaveIBeenPwned: из 25 восьмизначных паролей там
          нашлись 3–7, из двенадцатизначных — ни одного. Правку сделали в
          scripts/invite.mjs и забыли здесь, и с тех пор человек вводил
          двенадцать цифр в поле, обещавшее восемь.

          Цена такой мелочи выше, чем кажется: подсказка — единственное,
          с чем приглашённый сверяется, если вход не удался. Она говорила
          ему, что пароль неверный, когда пароль был верный. */}
      <Field
        label="Пароль из приглашения"
        placeholder="12 цифр"
        keyboardType="number-pad"
        secureTextEntry
        value={password}
        onChangeText={setPassword}
        hint="Пароль выдаёт RentHUB при добавлении в пилот. Вводится слитно, без пробелов."
      />
      <Button
        title="Войти"
        loading={busy}
        // Логин — номер или почта, поэтому проверяем оба вида. Условие
        // «десять цифр» оставило бы кнопку выключенной навсегда тому, кто
        // ввёл адрес: цифр в нём нет, а причина отказа не видна.
        disabled={
          (phone.includes('@')
            ? !/.+@.+\..+/.test(phone.trim())
            : phone.replace(/\D/g, '').length < 10) || password.length === 0
        }
        onPress={async () => {
          setBusy(true);
          onError(null);
          try {
            await signInWithInvite(phone, password);
          } catch (e) {
            onError(humanizeError(e));
          } finally {
            setBusy(false);
          }
        }}
      />

      <View style={s.note}>
        <Ionicons name="information-circle-outline" size={17} color={colors.textMuted} />
        <Text style={s.noteText}>
          Пилот идёт в Кокшетау по закрытым приглашениям. Каталог можно смотреть
          и без входа — он открыт всем.
        </Text>
      </View>

      {/* Путь для тех, у кого приглашения нет.
          До сих пор его не было вовсе: человек, пришедший по рекламе, читал
          «по закрытым приглашениям» и оставался ни с чем — без имени, без
          адреса, без кнопки. Бот подходит для этого лучше формы: он получает
          номер, подтверждённый самим Telegram, и не просит вводить его
          руками. */}
      {/* Адрес бота берётся из TELEGRAM_BOT_URL, а не пишется строкой.
          Здесь он был записан строкой, а десятью строками ниже — из
          переменной: два источника на одном экране. Разойдутся они ровно
          в тот день, когда бота переименуют или заведут второго под другой
          город, и половина экрана поведёт в никуда. */}
      <Button
        title="Нет приглашения — оставить заявку"
        variant="ghost"
        onPress={() => Linking.openURL(TELEGRAM_BOT_URL)}
      />
    </View>
  );
}

/** Вход по SMS. Заработает, когда будет подключён провайдер. */
function SmsForm({ onError }: { onError: (m: string | null) => void }) {
  const { sendCode, verifyCode } = useAuth();
  const [step, setStep] = useState<'phone' | 'code'>('phone');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    onError(null);
    try {
      await action();
    } catch (e) {
      onError(humanizeError(e));
    } finally {
      setBusy(false);
    }
  }

  if (step === 'code') {
    return (
      <View style={s.form}>
        <Field
          label="Код из SMS"
          placeholder="123456"
          keyboardType="number-pad"
          value={code}
          onChangeText={setCode}
          hint={`Отправили на ${phone}`}
        />
        <Button
          title="Войти"
          loading={busy}
          disabled={code.length < 4}
          onPress={() => run(() => verifyCode(phone, code))}
        />
        <Button title="Изменить номер" variant="ghost" onPress={() => setStep('phone')} />
      </View>
    );
  }

  return (
    <View style={s.form}>
      {/* Открыть бота — первый шаг, а не сноска внизу.
          Telegram запрещает боту писать первым тому, кто не начинал с ним
          диалог. Значит код физически не придёт, пока человек не открыл
          бота и не поделился номером. Раньше это стояло серым текстом под
          кнопкой «Получить код» — то есть человек узнавал причину после
          того, как нажал и ничего не дождался. */}
      <View style={s.step}>
        <View style={s.stepHead}>
          <View style={s.stepNum}>
            <Text style={s.stepNumText}>1</Text>
          </View>
          <Text style={s.stepTitle}>Откройте бота и поделитесь номером</Text>
        </View>
        <Text style={s.stepBody}>
          Telegram не разрешает боту писать первым. Пока вы не начали с ним диалог,
          отправить код ему некуда.
        </Text>
        <Button
          title={`Открыть @${TELEGRAM_BOT}`}
          variant="secondary"
          onPress={() => Linking.openURL(TELEGRAM_BOT_URL)}
        />
      </View>

      <View style={s.stepHead}>
        <View style={s.stepNum}>
          <Text style={s.stepNumText}>2</Text>
        </View>
        <Text style={s.stepTitle}>Вернитесь сюда за кодом</Text>
      </View>

      <Field
        label="Номер телефона"
        placeholder="+7 705 123 45 67"
        keyboardType="phone-pad"
        autoComplete="tel"
        value={phone}
        onChangeText={setPhone}
        hint="Тот же номер, которым поделились с ботом. Его видят только стороны сделки."
      />
      <Button
        title="Получить код"
        loading={busy}
        disabled={phone.replace(/\D/g, '').length < 10}
        onPress={() => run(async () => {
          await sendCode(phone);
          setStep('code');
        })}
      />
    </View>
  );
}

/**
 * Вход по почте.
 *
 * Работает только для адреса, уже привязанного к аккаунту, — за это
 * отвечает `shouldCreateUser: false` в sendEmailCode. Незнакомая почта
 * получает отказ, а не тихо заводит второй аккаунт с пустым профилем.
 *
 * Экран принимает оба исхода письма, и это не перестраховка. Пока у
 * проекта нет своего SMTP, Supabase шлёт письма встроенным сервисом, а на
 * нём шаблоны править нельзя — приходит ссылка, а не код. Со своим SMTP
 * шаблон Magic Link меняется на `{{ .Token }}`, и приходит код. Экран,
 * написанный под один из вариантов, сломался бы при переключении.
 */
function EmailForm({ onError }: { onError: (m: string | null) => void }) {
  const { sendEmailCode, verifyEmailCode } = useAuth();
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    onError(null);
    try {
      await action();
    } catch (e) {
      onError(humanizeError(e));
    } finally {
      setBusy(false);
    }
  }

  if (step === 'code') {
    return (
      <View style={s.form}>
        <View style={s.step}>
          <View style={s.stepHead}>
            <Ionicons name="mail-outline" size={18} color={colors.accent} />
            <Text style={s.stepTitle}>Письмо отправлено на {email}</Text>
          </View>
          <Text style={s.stepBody}>
            В письме может быть ссылка или код — зависит от настроек почты.
            Ссылка вернёт вас в приложение уже с входом, код введите ниже.
            Проверьте папку «Спам».
          </Text>
          {/* Что делать, если письма нет вовсе.
              Измерено 04.09.2026: Supabase принимает отправку (200 и минута
              задержки на адрес), но встроенный сервис доставляет не всё —
              он для разработки, и на живой почте письмо может не дойти
              молча. Пока организатор не подключил свой SMTP, это самый
              вероятный исход, и человеку надо дать работающий путь, а не
              оставить смотреть в пустой ящик. */}
          <Text style={s.stepBody}>
            Ссылка из письма ведёт не туда или пишет, что устарела? Она
            одноразовая, и адрес возврата пока настраивается организатором.
            Работают два других входа: по приглашению (номер и пароль от
            организатора) и по коду в Telegram.
          </Text>
        </View>

        <Field
          label="Код из письма"
          placeholder="123456"
          keyboardType="number-pad"
          value={code}
          onChangeText={setCode}
        />
        <Button
          title="Войти"
          loading={busy}
          disabled={code.length < 4}
          onPress={() => run(() => verifyEmailCode(email, code))}
        />
        <Button title="Другая почта" variant="ghost" onPress={() => setStep('email')} />
      </View>
    );
  }

  return (
    <View style={s.form}>
      <Field
        label="Почта"
        placeholder="name@gmail.com"
        keyboardType="email-address"
        autoCapitalize="none"
        autoComplete="email"
        value={email}
        onChangeText={setEmail}
        hint="Та, которую вы привязали к аккаунту в профиле."
      />
      <Button
        title="Получить письмо"
        loading={busy}
        disabled={!/.+@.+\..+/.test(email.trim())}
        onPress={() => run(async () => {
          await sendEmailCode(email);
          setStep('code');
        })}
      />

      <View style={s.note}>
        <Ionicons name="information-circle-outline" size={17} color={colors.textMuted} />
        <Text style={s.noteText}>
          Почта работает, только если вы привязали её в профиле. Незнакомый адрес
          получит отказ: иначе на него завёлся бы пустой второй аккаунт, и ваши
          сделки в нём бы не нашлись.
        </Text>
      </View>
    </View>
  );
}

function Tab({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable style={[s.tab, active && s.tabActive]} onPress={onPress}>
      <Text style={[s.tabText, active && s.tabTextActive]}>{label}</Text>
    </Pressable>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  container: { flexGrow: 1, justifyContent: 'center', padding: spacing.xl, gap: spacing.xl },
  header: { gap: spacing.md },
  logo: { fontSize: 52, fontFamily: typeface[800], color: colors.text, letterSpacing: -2 },
  tagline: { fontSize: 16, fontFamily: typeface[500], color: colors.textMuted, lineHeight: 24 },

  linkError: {
    flexDirection: 'row',
    gap: spacing.sm,
    alignItems: 'flex-start',
    padding: spacing.md,
    marginBottom: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.dangerSoft,
  },
  linkErrorText: { flex: 1, fontSize: 14, lineHeight: 20, fontFamily: typeface[500], color: colors.text },
  tabs: {
    flexDirection: 'row',
    gap: spacing.xs,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.pill,
    padding: 5,
  },
  tab: { flex: 1, paddingVertical: 11, paddingHorizontal: 4, borderRadius: radius.pill, alignItems: 'center' },
  tabActive: { backgroundColor: colors.accent },
  tabText: { fontSize: 14, fontFamily: typeface[700], color: colors.textMuted },
  tabTextActive: { color: colors.onFill },

  form: { gap: spacing.lg },

  // Первый шаг выделен подложкой: без него второй не работает, и это должно
  // читаться как условие, а не как совет.
  step: {
    gap: spacing.md,
    backgroundColor: colors.accentSoft,
    borderRadius: radius.lg,
    padding: spacing.lg,
  },
  stepHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  stepNum: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepNumText: { fontSize: 12, fontFamily: typeface[800], color: colors.onFill },
  stepTitle: { flex: 1, fontSize: 15, fontFamily: typeface[700], color: colors.text },
  stepBody: { fontSize: 13, fontFamily: typeface[400], color: colors.textMuted, lineHeight: 19 },
  note: { flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-start' },
  noteText: { flex: 1, fontSize: 13, fontFamily: typeface[400], color: colors.textMuted, lineHeight: 19 },
  exit: { alignSelf: 'center', paddingVertical: 14, paddingHorizontal: 8 },
  exitText: {
    fontSize: 15,
    fontFamily: typeface[500],
    color: colors.textMuted,
    textDecorationLine: 'underline',
  },
  error: { color: colors.danger, fontSize: 14, fontFamily: typeface[400], textAlign: 'center' },
});
