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
// Legacy popup-based sign-in — Google Identity Services
// =====================================================================
// Kept for the trial-link / claim-account flows which bundle the idToken
// with another bearer token in a single API call. Not used for primary
// sign-in (which uses the redirect flow above to avoid iOS Safari issues).
//
// Migrate trial flows to the redirect flow when iOS Safari sign-in
// failures show up in support reports.
// =====================================================================

const POPUP_CLIENT_ID = import.meta.env.VITE_GOOGLE_OAUTH_CLIENT_ID || '';

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (config: {
            client_id: string;
            callback: (response: { credential: string }) => void;
            auto_select?: boolean;
            cancel_on_tap_outside?: boolean;
            ux_mode?: 'popup' | 'redirect';
            use_fedcm_for_prompt?: boolean;
          }) => void;
          prompt: () => void;
          renderButton: (parent: HTMLElement, options: Record<string, unknown>) => void;
          disableAutoSelect: () => void;
        };
      };
    };
  }
}

let gisScriptLoaded: Promise<void> | null = null;

function loadGisScript(): Promise<void> {
  if (typeof window === 'undefined') return Promise.reject(new Error('SSR'));
  if (window.google?.accounts?.id) return Promise.resolve();
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
 * Popup-based Google sign-in — returns an ID token directly.
 * Used by trial-link and claim-account flows that need to bundle the
 * idToken with another bearer token in a single server call.
 *
 * Caveat: stalls on iOS Safari with device-prompt 2FA. Fine for the
 * trial flows because trial users are usually new accounts without
 * 2FA enrolled, but consider migrating these flows to the redirect
 * flow if iOS Safari failures surface.
 */
export async function signInWithGooglePopup(): Promise<{ idToken: string }> {
  if (!POPUP_CLIENT_ID) {
    throw new Error('VITE_GOOGLE_OAUTH_CLIENT_ID is not set — Google sign-in cannot work.');
  }
  await loadGisScript();
  if (!window.google?.accounts?.id) {
    throw new Error('Google Identity Services failed to initialise.');
  }

  return new Promise<{ idToken: string }>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Sign-in cancelled or timed out')), 5 * 60 * 1000);
    try {
      window.google!.accounts.id.initialize({
        client_id: POPUP_CLIENT_ID,
        callback: (response) => {
          clearTimeout(timeout);
          if (!response.credential) { reject(new Error('No credential returned from Google')); return; }
          resolve({ idToken: response.credential });
        },
        auto_select: false,
        cancel_on_tap_outside: false,
        ux_mode: 'popup',
        use_fedcm_for_prompt: true,
      });
      const host = document.createElement('div');
      host.style.cssText = 'position:fixed;opacity:0;pointer-events:none;top:-1000px;left:-1000px';
      document.body.appendChild(host);
      window.google!.accounts.id.renderButton(host, { type: 'standard', theme: 'outline', size: 'large' });
      requestAnimationFrame(() => {
        const clickable = host.querySelector<HTMLElement>('div[role="button"], iframe');
        if (clickable && 'click' in clickable) (clickable as HTMLElement).click();
        else window.google!.accounts.id.prompt();
        setTimeout(() => host.remove(), 30 * 1000);
      });
    } catch (err) {
      clearTimeout(timeout);
      reject(err instanceof Error ? err : new Error('Google sign-in failed'));
    }
  });
}
