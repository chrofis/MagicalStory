/**
 * Google sign-in — Authorization Code flow (full-page redirect).
 *
 * Replaces the previous popup-based Google Identity Services implementation.
 * Popup + postMessage stalls on iOS Safari when the user has device-prompt
 * 2FA enabled. The redirect flow works on every browser regardless of 2FA
 * method because there's no cross-window message — the browser just navigates.
 *
 * Flow:
 *   1. Client calls signInWithGoogle('/return/path')
 *   2. We navigate to /api/auth/google/start?return=/return/path
 *   3. Server sets CSRF state cookie, redirects to Google
 *   4. User signs in on Google
 *   5. Google redirects to /api/auth/google/callback
 *   6. Server verifies state, exchanges code, issues JWT, redirects to
 *      <returnPath>#auth=token=JWT&user=BASE64_USER_JSON
 *   7. consumeAuthHash() (called by AuthContext on mount) reads the hash,
 *      persists, cleans the URL.
 *
 * Trial-link and claim-account flows still use the popup-based POST endpoint
 * because they're tied to a session-token bearer header — they navigate
 * separately via signInWithGooglePopup() below if needed in the future.
 */

const API_URL = import.meta.env.VITE_API_URL || '';

export interface GoogleAuthHashResult {
  token: string;
  user: {
    id: string;
    username: string;
    email: string;
    role: string;
    storyQuota?: number;
    storiesGenerated?: number;
    credits: number;
    preferredLanguage?: string;
    emailVerified?: boolean;
    photoConsentAt?: string | null;
  };
}

/**
 * Trigger Google sign-in by navigating away to the server's start endpoint.
 * Server handles the OAuth dance and redirects back with the JWT in URL hash.
 *
 * @param returnPath The same-origin path to return to after sign-in. Must
 *                   start with '/'. Defaults to current pathname.
 */
export function signInWithGoogle(returnPath?: string): void {
  const returnTo = returnPath || window.location.pathname || '/';
  const safeReturn = returnTo.startsWith('/') && !returnTo.startsWith('//')
    ? returnTo
    : '/';
  // Use absolute URL when API_URL is set (e.g. dev: client on :5173, server on :3000),
  // relative otherwise (prod: same origin).
  const startUrl = `${API_URL}/api/auth/google/start?return=${encodeURIComponent(safeReturn)}`;
  window.location.href = startUrl;
}

/**
 * Read the auth hash set by the server callback redirect, if present, and
 * remove it from the URL. Called by AuthContext on mount.
 *
 * Returns null when no auth hash is present (most page loads).
 */
export function consumeAuthHash(): GoogleAuthHashResult | null {
  if (typeof window === 'undefined') return null;
  const hash = window.location.hash;
  if (!hash || !hash.startsWith('#auth=')) return null;

  try {
    const payload = decodeURIComponent(hash.slice('#auth='.length));
    const params = new URLSearchParams(payload);
    const token = params.get('token');
    const userB64 = params.get('user');
    if (!token || !userB64) return null;

    // Replace base64url chars
    const b64 = userB64.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const userJson = atob(padded);
    const user = JSON.parse(userJson);

    // Clean the URL — remove the hash without reloading
    const cleanUrl = window.location.pathname + window.location.search;
    window.history.replaceState(null, '', cleanUrl);

    return { token, user };
  } catch (err) {
    console.error('Failed to consume Google auth hash:', err);
    return null;
  }
}

/**
 * Sign out is a client-only operation since the session is held in the
 * server-issued JWT. The redirect flow doesn't need client-side cleanup.
 */
export async function googleSignOut(): Promise<void> {
  // No-op — session lives in localStorage JWT, cleared by AuthContext.logout().
}

// =====================================================================
// Popup-mode auth-code sign-in — for trial-link / claim-account
// =====================================================================
// These two flows need an idToken bundled with another bearer token in a
// single server POST, so they can't use the full-page redirect flow.
//
// We use `accounts.oauth2.initCodeClient({ ux_mode: 'popup' })`: opens a
// real OS popup (not an iframe), Google posts an auth code back via
// postMessage with redirect_uri='postmessage'. Immune to Safari ITP and
// device-prompt 2FA — there's no cross-window iframe storage involved.
//
// The client posts the code to /api/auth/google/exchange-code; the server
// exchanges it for an id_token (using GOOGLE_OAUTH_CLIENT_SECRET) and
// returns it. The trial endpoints continue to accept idToken unchanged.
// =====================================================================

const POPUP_CLIENT_ID = import.meta.env.VITE_GOOGLE_OAUTH_CLIENT_ID || '';

declare global {
  interface Window {
    google?: {
      accounts: {
        oauth2: {
          initCodeClient: (config: {
            client_id: string;
            scope: string;
            ux_mode?: 'popup' | 'redirect';
            redirect_uri?: string;
            callback: (response: { code?: string; error?: string }) => void;
          }) => { requestCode: () => void };
        };
      };
    };
  }
}

let gisScriptLoaded: Promise<void> | null = null;

function loadGisScript(): Promise<void> {
  if (typeof window === 'undefined') return Promise.reject(new Error('SSR'));
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  if (gisScriptLoaded) return gisScriptLoaded;
  gisScriptLoaded = new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[src="https://accounts.google.com/gsi/client"]');
    if (existing) {
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => reject(new Error('GIS script failed')));
      return;
    }
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('GIS script failed'));
    document.head.appendChild(s);
  });
  return gisScriptLoaded;
}

/**
 * Popup-mode Google sign-in for trial-link / claim-account.
 * Returns an ID token after a server-side code exchange.
 */
export async function signInWithGooglePopup(): Promise<{ idToken: string }> {
  if (!POPUP_CLIENT_ID) {
    throw new Error('VITE_GOOGLE_OAUTH_CLIENT_ID is not set — Google sign-in cannot work.');
  }
  await loadGisScript();
  if (!window.google?.accounts?.oauth2) {
    throw new Error('Google Identity Services failed to initialise.');
  }

  const code = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Sign-in cancelled or timed out')), 5 * 60 * 1000);
    try {
      const client = window.google!.accounts.oauth2.initCodeClient({
        client_id: POPUP_CLIENT_ID,
        scope: 'openid email profile',
        ux_mode: 'popup',
        redirect_uri: 'postmessage',
        callback: (response) => {
          clearTimeout(timeout);
          if (response.error || !response.code) {
            reject(new Error(response.error || 'No code returned from Google'));
            return;
          }
          resolve(response.code);
        },
      });
      client.requestCode();
    } catch (err) {
      clearTimeout(timeout);
      reject(err instanceof Error ? err : new Error('Google sign-in failed'));
    }
  });

  const resp = await fetch(`${API_URL}/api/auth/google/exchange-code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}));
    throw new Error(body.error || `Code exchange failed (${resp.status})`);
  }
  const { idToken } = await resp.json();
  if (!idToken) throw new Error('Server returned no idToken');
  return { idToken };
}
