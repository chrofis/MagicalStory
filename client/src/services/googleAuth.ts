/**
 * Google Identity Services helper.
 *
 * Replaces the previous Firebase Auth wrapper. Uses Google's first-party
 * `accounts.google.com/gsi/client` SDK directly — no Firebase project,
 * no FirebaseUser, no redirect dance.
 *
 * Sign-in returns a Google ID token (a signed JWT) that the server verifies
 * with `google-auth-library`. Same shape as before — `email`, `sub`, `name`,
 * `email_verified` — so server-side upsert logic is unchanged.
 */

const CLIENT_ID = import.meta.env.VITE_GOOGLE_OAUTH_CLIENT_ID || '';

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
            context?: 'signin' | 'signup' | 'use';
            ux_mode?: 'popup' | 'redirect';
          }) => void;
          prompt: (cb?: (notification: unknown) => void) => void;
          renderButton: (parent: HTMLElement, options: Record<string, unknown>) => void;
          disableAutoSelect: () => void;
        };
        oauth2: {
          initTokenClient: (config: {
            client_id: string;
            scope: string;
            callback: (response: { access_token?: string; error?: string }) => void;
          }) => { requestAccessToken: () => void };
        };
      };
    };
  }
}

let scriptLoaded: Promise<void> | null = null;

function loadGisScript(): Promise<void> {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('Google Identity Services unavailable in SSR'));
  }
  if (window.google?.accounts?.id) return Promise.resolve();
  if (scriptLoaded) return scriptLoaded;
  scriptLoaded = new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[src="https://accounts.google.com/gsi/client"]');
    if (existing) {
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => reject(new Error('Failed to load Google Identity Services')));
      return;
    }
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Failed to load Google Identity Services'));
    document.head.appendChild(s);
  });
  return scriptLoaded;
}

/**
 * Trigger Google sign-in. Resolves with an ID token (JWT) signed by Google.
 * The token contains: sub, email, email_verified, name, picture, aud, iss, exp.
 *
 * On success the consumer should POST the token to /api/auth/google for
 * server-side verification + session establishment.
 *
 * Implementation: we use the `oauth2.initCodeClient` popup flow indirectly
 * via `id.prompt` + a hidden button click. This is the GIS-recommended way
 * to get an ID token from a custom button.
 */
export async function signInWithGoogle(): Promise<{ idToken: string }> {
  if (!CLIENT_ID) {
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
        client_id: CLIENT_ID,
        callback: (response) => {
          clearTimeout(timeout);
          if (!response.credential) {
            reject(new Error('No credential returned from Google'));
            return;
          }
          resolve({ idToken: response.credential });
        },
        auto_select: false,
        cancel_on_tap_outside: false,
        ux_mode: 'popup',
      });

      // Render an invisible button into a temporary host and programmatically click it.
      // This is GIS's documented way to start a sign-in flow from a custom UX trigger.
      const host = document.createElement('div');
      host.style.position = 'fixed';
      host.style.opacity = '0';
      host.style.pointerEvents = 'none';
      host.style.top = '-1000px';
      host.style.left = '-1000px';
      document.body.appendChild(host);

      window.google!.accounts.id.renderButton(host, {
        type: 'standard',
        theme: 'outline',
        size: 'large',
      });

      // The rendered button is a div containing an iframe. Find the inner clickable element.
      requestAnimationFrame(() => {
        const clickable = host.querySelector<HTMLElement>('div[role="button"], iframe');
        if (clickable && 'click' in clickable) {
          (clickable as HTMLElement).click();
        } else {
          // Fall back to GIS One Tap prompt
          window.google!.accounts.id.prompt();
        }
        // Clean up the host after a delay — the popup runs out-of-DOM
        setTimeout(() => host.remove(), 30 * 1000);
      });
    } catch (err) {
      clearTimeout(timeout);
      reject(err instanceof Error ? err : new Error('Google sign-in failed'));
    }
  });
}

/**
 * Sign out is a client-only operation since the session is held in the
 * server-issued JWT. We just disable Google's auto-select so the next
 * sign-in shows the chooser.
 */
export async function googleSignOut(): Promise<void> {
  await loadGisScript().catch(() => {});
  try { window.google?.accounts?.id?.disableAutoSelect(); } catch { /* ignore */ }
}
