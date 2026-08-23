import { useEffect } from 'react';

/**
 * Presence heartbeat for the photo-analyzer session.
 *
 * Mount this on any surface where the user might upload a photo (trial wizard,
 * story wizard). The first beat makes the server spawn + warm the analyzer's
 * face/rembg workers, so the first upload never pays their 10-25s cold start.
 * Beats continue every 60s while the tab is visible and the user has been
 * active in the last 5 minutes; the server closes the session ~5 min after
 * beats stop (or immediately on the pagehide goodbye).
 */
const HEARTBEAT_MS = 60_000;
const ACTIVITY_WINDOW_MS = 5 * 60_000;

// One token per tab, stable across remounts so wizard-step navigation does not
// open a second session.
function presenceToken(): string {
  const KEY = 'analyzerPresenceToken';
  let t = sessionStorage.getItem(KEY);
  if (!t) {
    t = (crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`).slice(0, 64);
    sessionStorage.setItem(KEY, t);
  }
  return t;
}

export function useAnalyzerPresence(surface: string) {
  useEffect(() => {
    const token = presenceToken();
    const base = import.meta.env.VITE_API_URL || '';
    let lastActivity = Date.now();

    const send = (bye = false) => {
      const body = JSON.stringify({ token, surface, ...(bye ? { bye: true } : {}) });
      if (bye && navigator.sendBeacon) {
        // fetch() is unreliable during pagehide; sendBeacon survives unload.
        navigator.sendBeacon(`${base}/api/analyzer-presence`, new Blob([body], { type: 'application/json' }));
        return;
      }
      fetch(`${base}/api/analyzer-presence`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        keepalive: bye,
      }).catch(() => {});
    };

    const onActivity = () => { lastActivity = Date.now(); };
    const activityEvents: (keyof WindowEventMap)[] = ['pointerdown', 'keydown', 'pointermove', 'touchstart'];
    activityEvents.forEach((e) => window.addEventListener(e, onActivity, { passive: true }));

    send(); // immediate: warming should start the moment the page opens
    const interval = setInterval(() => {
      if (document.visibilityState === 'visible' && Date.now() - lastActivity < ACTIVITY_WINDOW_MS) {
        send();
      }
    }, HEARTBEAT_MS);

    const onPageHide = () => send(true);
    window.addEventListener('pagehide', onPageHide);

    return () => {
      clearInterval(interval);
      activityEvents.forEach((e) => window.removeEventListener(e, onActivity));
      window.removeEventListener('pagehide', onPageHide);
      // Unmount = navigated away from the surface inside the SPA.
      send(true);
    };
  }, [surface]);
}

export default useAnalyzerPresence;
