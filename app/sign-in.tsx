import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Button, Field } from '../src/components/ui';
import { useAuth } from '../src/lib/auth';
import { humanizeError } from '../src/lib/supabase';
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
 * Порядок способов задаётся EXPO_PUBLIC_AUTH_MODE. Пока SMS-провайдера нет,
 * показывать «Получить код» первым — ловушка: кнопка отвечает ошибкой про
 * неподключённого провайдера, и человек решает, что сломано приложение.
 */
const AUTH_MODE = process.env.EXPO_PUBLIC_AUTH_MODE ?? 'invite';

export default function SignIn() {
  const [tab, setTab] = useState<'invite' | 'sms'>(AUTH_MODE === 'sms' ? 'sms' : 'invite');
  const [error, setError] = useState<string | null>(null);

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

          <View style={s.tabs}>
            <Tab
              label="По приглашению"
              active={tab === 'invite'}
              onPress={() => {
                setTab('invite');
                setError(null);
              }}
            />
            <Tab
              label="По SMS"
              active={tab === 'sms'}
              onPress={() => {
                setTab('sms');
                setError(null);
              }}
            />
          </View>

          {tab === 'invite' ? (
            <InviteForm onError={setError} />
          ) : (
            <SmsForm onError={setError} />
          )}

          {error ? <Text style={s.error}>{error}</Text> : null}
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
        label="Номер телефона"
        placeholder="+7 705 123 45 67"
        keyboardType="phone-pad"
        autoComplete="tel"
        value={phone}
        onChangeText={setPhone}
      />
      <Field
        label="Пароль из приглашения"
        placeholder="8 цифр"
        keyboardType="number-pad"
        secureTextEntry
        value={password}
        onChangeText={setPassword}
        hint="Пароль выдаёт RentHUB при добавлении в пилот."
      />
      <Button
        title="Войти"
        loading={busy}
        disabled={phone.replace(/\D/g, '').length < 10 || password.length === 0}
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
      <Field
        label="Номер телефона"
        placeholder="+7 705 123 45 67"
        keyboardType="phone-pad"
        autoComplete="tel"
        value={phone}
        onChangeText={setPhone}
        hint="Пришлём SMS с кодом. Номер видят только стороны сделки."
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

      {AUTH_MODE !== 'sms' ? (
        <View style={s.note}>
          <Ionicons name="alert-circle-outline" size={17} color={colors.warn} />
          <Text style={[s.noteText, { color: colors.warn }]}>
            Вход по SMS пока не подключён. На время пилота используйте приглашение.
          </Text>
        </View>
      ) : null}
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

  tabs: {
    flexDirection: 'row',
    gap: spacing.xs,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.pill,
    padding: 5,
  },
  tab: { flex: 1, paddingVertical: 11, borderRadius: radius.pill, alignItems: 'center' },
  tabActive: { backgroundColor: colors.accent },
  tabText: { fontSize: 14, fontFamily: typeface[700], color: colors.textMuted },
  tabTextActive: { color: colors.onFill },

  form: { gap: spacing.lg },
  note: { flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-start' },
  noteText: { flex: 1, fontSize: 13, fontFamily: typeface[400], color: colors.textMuted, lineHeight: 19 },
  error: { color: colors.danger, fontSize: 14, fontFamily: typeface[400], textAlign: 'center' },
});
