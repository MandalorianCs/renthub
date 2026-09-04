import type { Session } from '@supabase/supabase-js';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { fetchProfile } from './api';
import { Platform } from 'react-native';
import { EMAIL_RETURN_URL, humanizeError, supabase } from './supabase';
import type { User } from './types';

type AuthState = {
  session: Session | null;
  profile: User | null;
  loading: boolean;
  /**
   * Почему профиля нет — отдельно от самого профиля.
   *
   * `fetchProfile` читает через `maybeSingle()`: отсутствующая строка приходит
   * как `null` без исключения. Значит выброшенная ошибка — это всегда сбой
   * связи или политики, а не «триггер ещё не создал профиль». Различать их
   * обязательно: в первом случае экрану нужно предложить повтор, во втором —
   * подождать. Раньше оба случая давали `profile === null`, и экран профиля
   * мерцал скелетоном бесконечно, обещая данные, которые не придут.
   */
  profileError: string | null;
  /** ПРАВИЛО 1: без подтверждённого телефона нельзя ни сдавать, ни арендовать. */
  isVerified: boolean;
  sendCode: (phone: string) => Promise<void>;
  verifyCode: (phone: string, code: string) => Promise<void>;
  /**
   * Вход по приглашению: человек вводит свой телефон и выданный пароль.
   *
   * Внутри это вход по email — провайдер Email включён в Supabase по
   * умолчанию, а Phone отвечает «Phone logins are disabled», пока не
   * настроен SMS-провайдер, который для Казахстана стоит $250 в месяц
   * только за регистрацию имени отправителя.
   *
   * Адрес собирается из номера по фиксированному правилу, поэтому человек
   * его не видит и не вводит. Правило обязано совпадать со scripts/invite.mjs.
   */
  signInWithInvite: (login: string, password: string) => Promise<void>;
  /**
   * Вход по почте: код или ссылка на адрес, привязанный к аккаунту.
   *
   * `shouldCreateUser: false` здесь — не оптимизация, а защита от худшего
   * исхода. По умолчанию Supabase заводит нового пользователя под незнакомый
   * адрес, и человек, набравший почту, которую он к аккаунту не привязывал,
   * молча получил бы ВТОРОЙ аккаунт: свой id, пустой профиль, ни сделок, ни
   * рейтинга. Он бы решил, что приложение потеряло его данные.
   *
   * С этим флагом незнакомый адрес получает отказ, а пилот заодно остаётся
   * закрытым сам собой — ровно как с Telegram, где код уходит только тому,
   * у кого в профиле есть telegram_id.
   */
  sendEmailCode: (email: string) => Promise<void>;
  verifyEmailCode: (email: string, code: string) => Promise<void>;
  /**
   * Привязать почту к своему аккаунту.
   *
   * Делает это сам человек, а не админ-скрипт: почта — личные данные, и
   * подставлять её за него странно. Supabase шлёт письмо подтверждения, и
   * адрес меняется только после перехода по ссылке.
   *
   * Побочный эффект, о котором экран обязан предупредить: адрес учётной
   * записи и есть логин для входа по приглашению. После смены пароль из
   * приглашения работает с новой почтой, а не со старым служебным адресом,
   * который клиент собирал из номера.
   */
  linkEmail: (email: string) => Promise<void>;
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<void>;
  /**
   * Отказ, с которым вернула ссылка из письма.
   *
   * Ссылка одноразовая: GoTrue проверяет токен и возвращает в приложение
   * либо с сессией, либо с ошибкой в хвосте адреса — `#error=...`. Второе
   * приложение до сих пор не читало вовсе, и человек оказывался на
   * витрине невошедшим, без единого слова о том, что произошло.
   *
   * Случай не редкий: токен сгорает после первого перехода, а первым по
   * ссылке нередко ходит не человек, а сканер безопасности почты.
   */
  linkError: string | null;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<User | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const loadProfile = useCallback(async (userId: string | undefined) => {
    if (!userId) {
      setProfile(null);
      return;
    }
    try {
      setProfile(await fetchProfile(userId));
      setProfileError(null);
    } catch (e) {
      // Сюда попадают только настоящие сбои: профиль, которого ещё нет,
      // возвращается как null без исключения (см. maybeSingle в fetchProfile).
      // Профиль обнуляем, но причину сохраняем — по ней экран покажет отказ
      // с кнопкой повтора вместо вечной заглушки.
      setProfile(null);
      setProfileError(humanizeError(e));
    }
  }, []);

  // Хвост адреса читается один раз при запуске и сразу стирается: иначе
  // он останется в строке браузера и вернётся при обновлении страницы,
  // показав старую ошибку поверх нового входа.
  const [linkError, setLinkError] = useState<string | null>(null);

  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return;

    const hash = window.location.hash.replace(/^#/, '');
    if (!hash.includes('error')) return;

    const params = new URLSearchParams(hash);
    const code = params.get('error_code') ?? '';
    const described = params.get('error_description')?.replace(/\+/g, ' ') ?? '';

    setLinkError(
      code === 'otp_expired'
        ? 'Ссылка из письма уже использована или устарела — она одноразовая. ' +
            'Запросите новое письмо: кнопка ниже.'
        : described || 'Ссылка из письма не сработала. Запросите новое письмо.',
    );

    window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }, []);

  useEffect(() => {
    supabase.auth.getSession().then(async ({ data }) => {
      setSession(data.session);
      await loadProfile(data.session?.user.id);
      setLoading(false);
    });

    const { data: sub } = supabase.auth.onAuthStateChange(async (_event, next) => {
      setSession(next);
      await loadProfile(next?.user.id);
    });

    return () => sub.subscription.unsubscribe();
  }, [loadProfile]);

  const value = useMemo<AuthState>(
    () => ({
      session,
      profile,
      profileError,
      loading,
      isVerified: Boolean(profile?.verified_at),
      sendCode: async (phone) => {
        const { error } = await supabase.auth.signInWithOtp({ phone: normalizePhone(phone) });
        if (error) throw error;
      },
      verifyCode: async (phone, code) => {
        const { error } = await supabase.auth.verifyOtp({
          phone: normalizePhone(phone),
          token: code,
          type: 'sms',
        });
        if (error) throw error;
      },
      sendEmailCode: async (email) => {
        const { error } = await supabase.auth.signInWithOtp({
          email: email.trim().toLowerCase(),
          // emailRedirectTo — куда вернёт ссылка из письма. Без него
          // Supabase берёт Site URL проекта, а он по умолчанию
          // http://localhost:3000: письмо доходит, ссылка ведёт в никуда.
          options: { shouldCreateUser: false, emailRedirectTo: EMAIL_RETURN_URL },
        });
        if (error) throw error;
      },
      verifyEmailCode: async (email, code) => {
        const { error } = await supabase.auth.verifyOtp({
          email: email.trim().toLowerCase(),
          token: code,
          // `email` — код из письма; `magiclink` — переход по ссылке, и его
          // обрабатывает сам Supabase при возврате в приложение.
          type: 'email',
        });
        if (error) throw error;
      },
      linkEmail: async (email) => {
        const { error } = await supabase.auth.updateUser(
          { email: email.trim().toLowerCase() },
          // Тот же адрес возврата, что и у входа: письмо о смене почты
          // содержит такую же одноразовую ссылку и так же уводило на
          // localhost:3000.
          { emailRedirectTo: EMAIL_RETURN_URL },
        );
        if (error) throw error;
      },
      signInWithInvite: async (login, password) => {
        // Логин — номер ИЛИ почта. Пока адрес учётной записи собирался из
        // номера, второго варианта не требовалось. Но участник, которому
        // привязали настоящую почту, поменял и логин: адрес учётной записи
        // один, и он же служит входом по паролю. Собранный из номера
        // служебный адрес такому человеку больше не подходит, и вход по
        // приглашению у него молча переставал работать.
        const login_ = login.trim();
        const { error } = await supabase.auth.signInWithPassword({
          email: login_.includes('@')
            ? login_.toLowerCase()
            : inviteEmail(normalizePhone(login_)),
          password,
        });
        if (error) throw error;
      },
      signOut: async () => {
        await supabase.auth.signOut();
        setProfile(null);
      },
      refreshProfile: () => loadProfile(session?.user.id),
      linkError,
    }),
    [session, profile, profileError, loading, loadProfile, linkError],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth вызван вне AuthProvider');
  return ctx;
}

/**
 * Телефон → внутренний адрес учётной записи.
 *
 * Правило продублировано в scripts/invite.mjs и обязано совпадать: скрипт
 * заводит аккаунт с этим адресом, клиент собирает его же из введённого
 * номера. Разойдутся — человек с верным паролем не сможет войти, и причину
 * будут искать в пароле.
 */
export function inviteEmail(phone: string): string {
  return `${phone.replace(/\D/g, '')}@renthub.test`;
}

/** Казахстанские номера: 8 705… и +7 705… — это один и тот же номер. */
export function normalizePhone(input: string): string {
  const digits = input.replace(/\D/g, '');
  if (digits.startsWith('8') && digits.length === 11) return `+7${digits.slice(1)}`;
  if (digits.startsWith('7') && digits.length === 11) return `+${digits}`;
  return `+${digits}`;
}
