import { API } from '@stock/shared';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { CurrentUser, LoginResponse } from '@stock/shared';
import { get, post, tokenStore } from '../api/client.js';

type AuthState = {
  user: CurrentUser | null;
  status: 'loading' | 'authenticated' | 'anonymous';
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => void;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [status, setStatus] = useState<AuthState['status']>('loading');
  const queryClient = useQueryClient();

  const signOut = useCallback(() => {
    const refreshToken = tokenStore.refreshToken();

    tokenStore.clear();
    setUser(null);
    setStatus('anonymous');
    // Otherwise the next user to sign in on this browser briefly sees the
    // previous one's stock figures from cache.
    queryClient.clear();

    // Then tell the server, so the refresh token stops working everywhere
    // rather than only being forgotten here. Deliberately after the local
    // teardown and deliberately not awaited: signing out must not appear to
    // fail because the network did, and the local state is what the person is
    // looking at.
    if (refreshToken) {
      post(API.auth.logout(), { refreshToken }).catch(() => {
        // Best effort. The token still expires on its own schedule.
      });
    }
  }, [queryClient]);

  useEffect(() => {
    tokenStore.onSessionLost(signOut);
  }, [signOut]);

  // On load, try to restore the session from the stored refresh token.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      const refreshToken = tokenStore.refreshToken();
      if (!refreshToken) {
        setStatus('anonymous');
        return;
      }
      try {
        const tokens = await post<{ accessToken: string; refreshToken: string }>(API.auth.refresh(), {
          refreshToken,
        });
        tokenStore.set(tokens.accessToken, tokens.refreshToken);
        const me = await get<CurrentUser>(API.auth.me());
        if (cancelled) return;
        setUser(me);
        setStatus('authenticated');
      } catch {
        if (cancelled) return;
        tokenStore.clear();
        setStatus('anonymous');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    const res = await post<LoginResponse>(API.auth.login(), { email, password });
    tokenStore.set(res.tokens.accessToken, res.tokens.refreshToken);
    setUser(res.user);
    setStatus('authenticated');
  }, []);

  return (
    <AuthContext value={{ user, status, signIn, signOut }}>{children}</AuthContext>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}

/** Convenience for screens that only render behind a guard. */
export function useCurrentUser(): CurrentUser {
  const { user } = useAuth();
  if (!user) throw new Error('No authenticated user');
  return user;
}
