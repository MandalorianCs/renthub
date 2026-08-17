import type { Session } from '@supabase/supabase-js';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { fetchProfile } from './api';
import { supabase } from './supabase';
import type { User } from './types';

type AuthState = {
  session: Session | null;
  profile: User | null;
  loading: boolean;
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
  signInWithInvite: (phone: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const loadProfile = useCallback(async (userId: string | undefined) => {
    if (!userId) {
      setProfile(null);
      return;
    }
    try {
      setProfile(await fetchProfile(userId));
    } catch {
      // Профиль создаётся триггером on_auth_user_created. Если он ещё не
      // доехал, экран покажет состояние «загрузка», а не упадёт.
      setProfile(null);
    }
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
      signInWithInvite: async (phone, password) => {
        const { error } = await supabase.auth.signInWithPassword({
          email: inviteEmail(normalizePhone(phone)),
          password,
        });
        if (error) throw error;
      },
      signOut: async () => {
        await supabase.auth.signOut();
        setProfile(null);
      },
      refreshProfile: () => loadProfile(session?.user.id),
    }),
    [session, profile, loading, loadProfile],
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
