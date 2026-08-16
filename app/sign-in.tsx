import { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Button, Field } from '../src/components/ui';
import { useAuth } from '../src/lib/auth';
import { humanizeError } from '../src/lib/supabase';
import { colors, radius, spacing } from '../src/theme';

/**
 * Тестовые аккаунты из scripts/seed-test-users.mjs. Номера — из диапазона,
 * который не выдаётся абонентам, поэтому даже с подключённым провайдером
 * SMS на них не уйдёт.
 */
const TEST_ACCOUNTS = [
  { label: 'Владелец', phone: '+77000000001' },
  { label: 'Арендатор', phone: '+77000000002' },
];

/**
 * Экран 1: вход по телефону.
 * Подтверждение номера — это и есть верификация на MVP: без неё база
 * не даст ни создать объявление, ни забронировать (assert_verified).
 */
export default function SignIn() {
  const { sendCode, verifyCode } = useAuth();
  const [step, setStep] = useState<'phone' | 'code'>('phone');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(humanizeError(e));
    } finally {
      setBusy(false);
    }
  }

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

          {step === 'phone' ? (
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
            </View>
          ) : (
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
          )}

          {error ? <Text style={s.error}>{error}</Text> : null}

          {__DEV__ ? <DevLogin onError={setError} /> : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

/**
 * Вход по паролю для тестовых аккаунтов — обход SMS, пока не подключён
 * провайдер. Отрисовывается только под __DEV__: в production-сборке
 * (expo export, EAS Build) эта ветка недостижима и вырезается бандлером.
 *
 * Пунктирная рамка — не украшение: блок должен выглядеть инородно, чтобы
 * его нельзя было принять за часть продукта и случайно оставить.
 */
function DevLogin({ onError }: { onError: (message: string | null) => void }) {
  const { signInWithPassword } = useAuth();
  const [phone, setPhone] = useState(TEST_ACCOUNTS[0].phone);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  return (
    <View style={s.dev}>
      <Text style={s.devTitle}>Тестовый вход — только в разработке</Text>
      <Text style={s.devNote}>
        Аккаунты созданы скриптом `npm run seed:users`. SMS-провайдер для них не нужен.
      </Text>

      <View style={s.devRow}>
        {TEST_ACCOUNTS.map((a) => (
          <View key={a.phone} style={{ flex: 1 }}>
            <Button
              title={a.label}
              variant={phone === a.phone ? 'secondary' : 'ghost'}
              onPress={() => setPhone(a.phone)}
            />
          </View>
        ))}
      </View>

      <Field
        label="Пароль"
        placeholder="test-…"
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        hint={`Войти как ${phone}`}
      />

      <Button
        title="Войти по паролю"
        loading={busy}
        disabled={password.length === 0}
        onPress={async () => {
          setBusy(true);
          onError(null);
          try {
            await signInWithPassword(phone, password);
          } catch (e) {
            onError(humanizeError(e));
          } finally {
            setBusy(false);
          }
        }}
      />
    </View>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  container: { flexGrow: 1, justifyContent: 'center', padding: spacing.xl, gap: spacing.xxl },
  header: { gap: spacing.md },
  logo: { fontSize: 40, fontWeight: '800', color: colors.text, letterSpacing: -1 },
  tagline: { fontSize: 16, color: colors.textMuted, lineHeight: 24 },
  form: { gap: spacing.lg },
  error: { color: colors.danger, fontSize: 14, textAlign: 'center' },
  dev: {
    gap: spacing.md,
    padding: spacing.lg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: colors.border,
  },
  devTitle: { fontSize: 13, fontWeight: '700', color: colors.textMuted, letterSpacing: 0.5 },
  devNote: { fontSize: 12, color: colors.textMuted, lineHeight: 18 },
  devRow: { flexDirection: 'row', gap: spacing.sm },
});
