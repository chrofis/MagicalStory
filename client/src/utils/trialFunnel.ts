// Per-step /try funnel tracking — server-side, not GA4.
//
// WHY not GA4 (analytics.ts): ad blockers and consent denial swallow gtag
// exactly among the visitors who bounce, which is the population this measures;
// and GA4 events can't be joined to the users/stories rows. These events go to
// our own POST /api/trial/event and land in the trial_events table, keyed by a
// visit id that survives until the anonymous account exists and back-fills onto
// the earlier rows. See migrations/024_trial_events.sql.
//
// Every call is fire-and-forget: sendBeacon first (it survives the tab closing,
// which matters most at exactly the steps where people quit), fetch(keepalive)
// as the fallback. Nothing here may ever throw into the wizard — a measurement
// failure must not cost a trial.

const VISIT_KEY = 'trial_visit_id';
const ATTR_KEY = 'trial_visit_attribution';

/** Steps must match TRIAL_FUNNEL_STEPS in server/routes/trial.js. */
export type TrialStep =
  | 'landing'
  | 'intro_start'
  | 'consent_given'
  | 'photo_selected'
  | 'photo_analyzed'
  | 'face_picked'
  | 'avatar_ready'
  | 'character_saved'
  | 'character_done'
  | 'topic_selected'
  | 'ideas_generated'
  | 'idea_selected'
  | 'create_clicked'
  | 'generation_started'
  | 'generation_completed'
  | 'email_submitted';

interface Attribution {
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  /** ValueTrack {keyword} from the ad's final URL — the keyword that was paid for. */
  utmTerm?: string;
  /**
   * Google Ads click id, present on every paid click because account-level
   * auto-tagging is on. Survives when UTM tags are stripped, and is the key an
   * offline conversion import needs to attribute a LATER purchase back to the
   * click — which is the only way to answer "did this keyword produce buyers,
   * or only trials?" for a funnel whose purchase lands days after the click.
   */
  gclid?: string;
  referrer?: string;
}

function uuid(): string {
  const c = typeof crypto !== 'undefined' ? crypto : undefined;
  if (c?.randomUUID) return c.randomUUID();
  // Older Safari has crypto.getRandomValues but not randomUUID.
  const bytes = new Uint8Array(16);
  if (c?.getRandomValues) c.getRandomValues(bytes);
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * The id for this visitor's trial attempt. Minted on first use and kept in
 * localStorage so a reload or a return tomorrow continues the SAME funnel row
 * rather than counting as a fresh visitor — the unique (visit_id, step) index
 * server-side then absorbs the repeated steps.
 */
export function getTrialVisitId(): string {
  try {
    const existing = localStorage.getItem(VISIT_KEY);
    if (existing) return existing;
    const fresh = uuid();
    localStorage.setItem(VISIT_KEY, fresh);
    return fresh;
  } catch {
    // Private mode with storage blocked — a per-page-load id still records the
    // steps, it just can't link them across a reload.
    return uuid();
  }
}

/**
 * Capture the landing attribution once per visit, from the URL that brought
 * them in. Later events read it back, so a step recorded three clicks deep
 * still carries the campaign that paid for the visitor.
 *
 * MUST run on the FIRST page of the visit, whatever that page is. Until
 * 2026-08-26 it was only reachable via trackTrialStep(), which fires solely
 * inside /try — but the Search ads land on the HOMEPAGE carrying the tags
 * (`magicalstory.ch/?utm_source=google&utm_medium=search&utm_campaign=…`).
 * A visitor therefore arrived tagged, navigated client-side to /try, and by
 * the time this ran the query string was gone: 0 of 40 trial_events rows in
 * production carried a campaign. captureAttribution() is now also called at
 * app mount (see main.tsx / App.tsx), and stays idempotent so the later
 * trackTrialStep() calls simply read back what the landing page stored.
 *
 * Empty is NOT cached: a direct visit that later becomes an ad click in the
 * same browser would otherwise be permanently stuck unattributed.
 */
export function captureAttribution(): Attribution {
  try {
    const stored = localStorage.getItem(ATTR_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as Attribution;
      // Only trust a cached record that actually identifies a source.
      if (parsed.utmSource || parsed.gclid) return parsed;
    }
  } catch { /* fall through and re-derive */ }

  let attribution: Attribution = {};
  try {
    const params = new URLSearchParams(window.location.search);
    attribution = {
      utmSource: params.get('utm_source') || undefined,
      utmMedium: params.get('utm_medium') || undefined,
      utmCampaign: params.get('utm_campaign') || undefined,
      utmTerm: params.get('utm_term') || undefined,
      gclid: params.get('gclid') || undefined,
      referrer: document.referrer || undefined,
    };
    // Persist only once there is something worth attributing, so an untagged
    // first pageview cannot poison a later tagged one.
    if (attribution.utmSource || attribution.gclid) {
      localStorage.setItem(ATTR_KEY, JSON.stringify(attribution));
    }
  } catch { /* storage blocked — the events still send, just unattributed */ }
  return attribution;
}

/**
 * Record one funnel step. Safe to call repeatedly for the same step.
 *
 * @param step - one of TrialStep
 * @param meta - small, bounded context only (never image bytes)
 */
export function trackTrialStep(step: TrialStep, meta?: Record<string, unknown>): void {
  try {
    const attribution = captureAttribution();
    const payload = JSON.stringify({
      visitId: getTrialVisitId(),
      step,
      ...attribution,
      language: document.documentElement.lang || undefined,
      meta,
    });
    const url = `${import.meta.env.VITE_API_URL || ''}/api/trial/event`;

    // sendBeacon can't carry the session token, so authenticated visits (which
    // is how the server learns the user id) take the fetch path. Everything
    // before the account exists goes by beacon and survives an unload.
    const sessionToken = localStorage.getItem('trial_session_token');
    if (!sessionToken && navigator.sendBeacon) {
      navigator.sendBeacon(url, new Blob([payload], { type: 'application/json' }));
      return;
    }

    fetch(url, {
      method: 'POST',
      keepalive: true,
      headers: {
        'Content-Type': 'application/json',
        ...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {}),
      },
      body: payload,
    }).catch(() => {});
  } catch { /* never let measurement break the wizard */ }
}
