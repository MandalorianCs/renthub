import { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Button, Field } from '../src/components/ui';
import { useAuth } from '../src/lib/auth';
import { humanizeError } from '../src/lib/supabase';
import { colors, spacing } from '../src/theme';

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
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
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
});
