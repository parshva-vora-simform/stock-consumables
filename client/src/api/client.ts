import { API, ERROR } from '@stock/shared';
import type { ApiError, ErrorCode } from '@stock/shared';

const BASE = import.meta.env['VITE_API_URL'] ?? '/api/v1';

/**
 * A failed request, carrying the server's `code` and `details` intact.
 *
 * This matters more here than in most apps: an INSUFFICIENT_STOCK rejection
 * arrives with the real available figure, and the form is expected to show it.
 * Flattening every failure into "something went wrong" would throw away the
 * only useful part (FR-4.2).
 */
export class ApiRequestError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly status: number,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }

  /** The available quantity on a rejected stock-out, when present. */
  get available(): number | null {
    const value = this.details?.['available'];
    return typeof value === 'number' ? value : null;
  }
}

/**
 * Where the two tokens live, and what that actually buys.
 *
 * The access token is held in memory only. The refresh token is in
 * localStorage, because a reload has to not sign the user out and there is
 * nowhere else to put it without a cookie-issuing server session.
 *
 * Be clear about what this is NOT. The refresh token is a full credential: it
 * mints access tokens on demand, so a script that reads localStorage gets a
 * BETTER prize than the 15-minute access token, not a worse one. Keeping the
 * access token out of storage narrows the blast radius of an accidental leak —
 * a logged object, a copied storage dump — and buys nothing at all against a
 * script running on the page.
 *
 * What limits the damage is on the server: refresh tokens rotate on every use
 * and reuse of a spent one is treated as theft, which revokes the family. See
 * `server/src/modules/auth/service.ts`. A stolen token is therefore useful
 * until the real client next refreshes, not for its full seven days.
 */
let accessToken: string | null = null;
let onSessionLost: (() => void) | null = null;

export const tokenStore = {
  set(access: string, refresh: string) {
    accessToken = access;
    try {
      localStorage.setItem('stock.refresh', refresh);
    } catch {
      // Private browsing, blocked storage: the session still works for this tab.
    }
  },
  clear() {
    accessToken = null;
    try {
      localStorage.removeItem('stock.refresh');
    } catch {
      /* ignore */
    }
  },
  refreshToken(): string | null {
    try {
      return localStorage.getItem('stock.refresh');
    } catch {
      return null;
    }
  },
  hasAccess: () => accessToken !== null,
  onSessionLost(handler: () => void) {
    onSessionLost = handler;
  },
};

async function raw<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...init.headers,
    },
  });

  if (res.status === 204) return undefined as T;

  const body = (await res.json().catch(() => null)) as ApiError | T | null;

  if (!res.ok) {
    const err = (body as ApiError | null)?.error;
    throw new ApiRequestError(
      err?.code ?? ERROR.INTERNAL_ERROR,
      res.status,
      err?.message ?? `Request failed (${res.status}).`,
      err?.details,
    );
  }

  return body as T;
}

/**
 * The refresh in flight, if there is one.
 *
 * A page typically has several queries running at once, so when the access
 * token expires they all fail together and all want to refresh. They must not
 * each do it: refresh tokens rotate server-side, so the first exchange spends
 * the token the others are still holding, and their attempts arrive as replays
 * of a spent token — which the server correctly treats as theft and answers by
 * revoking the whole family.
 *
 * That would mean a routine token expiry signing the user out, and the server
 * would be right to do it. The client has to present the token exactly once.
 * So the first caller performs the exchange and everyone else awaits the same
 * promise.
 */
let refreshInFlight: Promise<void> | null = null;

function refreshOnce(): Promise<void> {
  refreshInFlight ??= (async () => {
    const refreshToken = tokenStore.refreshToken();
    if (!refreshToken) throw new Error('no refresh token');

    const tokens = await raw<{ accessToken: string; refreshToken: string }>(API.auth.refresh(), {
      method: 'POST',
      body: JSON.stringify({ refreshToken }),
    });
    tokenStore.set(tokens.accessToken, tokens.refreshToken);
  })().finally(() => {
    // Cleared whether it succeeded or failed, so the next expiry starts a new
    // exchange rather than awaiting a settled promise forever.
    refreshInFlight = null;
  });

  return refreshInFlight;
}

/**
 * Retries once through a token refresh when the access token has expired.
 * TOKEN_EXPIRED is deliberately distinct from UNAUTHENTICATED on the server, so
 * an expired session refreshes silently while a genuinely invalid one signs out.
 */
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  try {
    return await raw<T>(path, init);
  } catch (err) {
    if (!(err instanceof ApiRequestError) || err.code !== ERROR.TOKEN_EXPIRED) throw err;

    try {
      await refreshOnce();
    } catch {
      tokenStore.clear();
      onSessionLost?.();
      throw err;
    }

    return await raw<T>(path, init);
  }
}

export const get = <T>(path: string) => api<T>(path);
export const post = <T>(path: string, body: unknown) =>
  api<T>(path, { method: 'POST', body: JSON.stringify(body) });
export const patch = <T>(path: string, body: unknown) =>
  api<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
export const del = <T>(path: string) => api<T>(path, { method: 'DELETE' });
