// GA4 behavioural analytics — "where do people go" (page paths + funnel).
//
// Separate from the Google Ads CONVERSION events in gtagConversion.ts:
//   - gtagConversion.ts → AW-… conversions, used for Ads bidding.
//   - this file        → GA4 (G-…) page_views + funnel events, used to see
//                         the on-site journey and where visitors drop off.
//
// Ships INERT: nothing fires until VITE_GA4_ID is set to a G-XXXXXXXX
// measurement id (Railway env + client/.env). The global gtag.js loader is
// already in client/index.html, and Consent Mode v2 defaults are set there
// (analytics_storage denied → GA4 still sends cookieless modelled pings).

const GA4_ID = (import.meta.env.VITE_GA4_ID as string | undefined)?.trim();

/** True only when a real GA4 measurement id is configured. */
export const ga4Enabled = !!GA4_ID && /^G-[A-Z0-9]+$/i.test(GA4_ID);

function gtag(...args: unknown[]) {
  if (typeof window !== 'undefined' && typeof window.gtag === 'function') {
    (window.gtag as (...a: unknown[]) => void)(...args);
  }
}

/** Configure GA4 once on load. Page_views are sent manually per route. */
export function initGA4() {
  if (!ga4Enabled) return;
  gtag('config', GA4_ID, { send_page_view: false });
}

/** Fire a GA4 page_view for the current SPA route. */
export function trackPageView(path: string) {
  if (!ga4Enabled) return;
  gtag('event', 'page_view', {
    page_path: path,
    page_location: typeof window !== 'undefined' ? window.location.href : path,
    page_title: typeof document !== 'undefined' ? document.title : undefined,
  });
}

/** Fire an arbitrary GA4 event (used for the /try funnel steps). */
export function trackEvent(name: string, params: Record<string, unknown> = {}) {
  if (!ga4Enabled) return;
  gtag('event', name, params);
}
