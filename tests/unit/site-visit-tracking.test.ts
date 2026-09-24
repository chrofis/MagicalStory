/**
 * Pins the ad-tagged site-visit events added 2026-09-24 (site_arrival / site_exit).
 *
 * Why they exist: Google reported 3 paid clicks and none reached /try, and a visitor who read the landing
 * page and left wrote no row at all — "never loaded", "left in 2 seconds" and "read for a minute" were
 * indistinguishable, and they call for opposite fixes.
 *
 * The client module is imported for real (fresh per test, it holds per-page state) with only the browser
 * globals it touches stubbed; the payloads are read back from the sendBeacon calls. The server half is
 * the step allowlist, the meta bounds, and the promise that none of this changes the /try funnel card.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-site-visit';
const trial = require('../../server/routes/trial.js');

type Sent = { step: string; meta?: Record<string, unknown>; utmCampaign?: string; utmTerm?: string; gclid?: string };

let sent: Promise<Sent>[];
let docListeners: Record<string, Array<() => void>>;
let winListeners: Record<string, Array<() => void>>;
let doc: { visibilityState: string };

function stubBrowser(search: string, pathname = '/') {
  sent = [];
  docListeners = {};
  winListeners = {};
  const store = new Map<string, string>();
  doc = {
    visibilityState: 'visible',
    // @ts-expect-error minimal stub
    referrer: '',
    documentElement: { lang: 'de' },
    addEventListener: (t: string, f: () => void) => { (docListeners[t] ||= []).push(f); },
  };
  vi.stubGlobal('document', doc);
  vi.stubGlobal('window', {
    location: { search, pathname },
    addEventListener: (t: string, f: () => void) => { (winListeners[t] ||= []).push(f); },
  });
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
  });
  vi.stubGlobal('navigator', {
    sendBeacon: (_url: string, blob: Blob) => { sent.push(blob.text().then((t) => JSON.parse(t))); return true; },
  });
}

async function load() {
  vi.resetModules();
  return import('../../client/src/utils/trialFunnel');
}

const hide = () => { doc.visibilityState = 'hidden'; (docListeners.visibilitychange || []).forEach((f) => f()); };
const events = () => Promise.all(sent);

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-24T15:00:00Z')); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('site_arrival', () => {
  it('fires once for a page opened from an ad, carrying the campaign, keyword and click id', async () => {
    stubBrowser('?utm_source=google&utm_medium=search&utm_campaign=cheap-age-ch&utm_term=geschenk%203%20jahre&gclid=abc');
    const m = await load();
    m.startSiteVisitTracking();
    m.startSiteVisitTracking(); // a remount must not record a second arrival
    const ev = await events();
    expect(ev.map((e) => e.step)).toEqual(['site_arrival']);
    expect(ev[0]).toMatchObject({ utmCampaign: 'cheap-age-ch', utmTerm: 'geschenk 3 jahre', gclid: 'abc' });
    expect(typeof ev[0].meta?.bootMs).toBe('number');
  });

  it('a gclid alone (tags stripped) still counts as an ad arrival', async () => {
    stubBrowser('?gclid=only');
    const m = await load();
    m.startSiteVisitTracking();
    expect((await events()).map((e) => e.step)).toEqual(['site_arrival']);
  });

  it('records nothing for an untagged visit, and arms no exit', async () => {
    stubBrowser('');
    const m = await load();
    m.startSiteVisitTracking();
    hide();
    expect(await events()).toEqual([]);
  });
});

describe('site_exit', () => {
  it('fires once on the first hide with the seconds on site and the pages viewed', async () => {
    stubBrowser('?utm_source=google&utm_campaign=zurich', '/');
    const m = await load();
    m.startSiteVisitTracking();
    m.noteSiteNavigation('/');                    // RouteTracker's first effect: same page, not a new one
    vi.advanceTimersByTime(20_000);
    m.noteSiteNavigation('/pricing');
    vi.advanceTimersByTime(22_000);
    m.noteSiteNavigation('/try');
    hide();
    (winListeners.pagehide || []).forEach((f) => f()); // the tab then closes: must not send a second exit
    hide();
    const ev = await events();
    expect(ev.map((e) => e.step)).toEqual(['site_arrival', 'site_exit']);
    expect(ev[1].meta).toEqual({ seconds: 42, pages: 3 });
  });

  it('pagehide alone (no visibility change first) also ends the visit', async () => {
    stubBrowser('?utm_source=google&utm_campaign=zurich');
    const m = await load();
    m.startSiteVisitTracking();
    vi.advanceTimersByTime(2_000);
    (winListeners.pagehide || []).forEach((f) => f());
    const ev = await events();
    expect(ev[1]).toMatchObject({ step: 'site_exit', meta: { seconds: 2, pages: 1 } });
  });

  it('page counting does not depend on whether RouteTracker ran before tracking started', async () => {
    stubBrowser('?utm_source=google', '/geschenk/geschenk-3-jahre');
    const m = await load();
    m.noteSiteNavigation('/geschenk/geschenk-3-jahre'); // child effect first (React order) - tracking not started
    m.startSiteVisitTracking();
    m.noteSiteNavigation('/geschenk/geschenk-3-jahre'); // or after it - either way still one page
    hide();
    expect((await events())[1].meta).toEqual({ seconds: 0, pages: 1 });
  });
});

describe('server side', () => {
  it('accepts the site-visit steps, and they are disjoint from the funnel steps', () => {
    expect(trial.SITE_VISIT_STEPS).toEqual(['site_arrival', 'site_exit']);
    for (const s of trial.SITE_VISIT_STEPS) {
      expect(trial.ACCEPTED_EVENT_STEPS.has(s)).toBe(true);
      expect(trial.TRIAL_FUNNEL_STEPS).not.toContain(s);
    }
    for (const s of trial.TRIAL_FUNNEL_STEPS) expect(trial.ACCEPTED_EVENT_STEPS.has(s)).toBe(true);
  });

  it('the /try funnel card is unchanged by site-visit rows', () => {
    const rows = trial.buildTrialFunnelRows(new Map([['site_arrival', 40], ['site_exit', 38], ['landing', 5], ['intro_start', 4]]));
    expect(rows.map((r: { step: string }) => r.step)).toEqual(trial.TRIAL_FUNNEL_STEPS);
    expect(rows[0]).toMatchObject({ step: 'landing', visits: 5, pctOfFirst: 100 });
    expect(rows[1]).toMatchObject({ step: 'intro_start', visits: 4, pctOfFirst: 80 });
  });

  it('keeps bootMs / seconds / pages only as bounded integers', () => {
    expect(trial.sanitizeTrialEventMeta({ bootMs: 1830, seconds: 42, pages: 3 })).toEqual({ bootMs: 1830, seconds: 42, pages: 3 });
    expect(trial.sanitizeTrialEventMeta({ seconds: -1, pages: 0, bootMs: 1.5 })).toBeNull();
    expect(trial.sanitizeTrialEventMeta({ seconds: 86401, pages: 1001, bootMs: 600001 })).toBeNull();
    expect(trial.sanitizeTrialEventMeta({ seconds: '42', pages: 2 })).toEqual({ pages: 2 });
  });

  it('the child age bound is unchanged by the integer-kind refactor', () => {
    expect(trial.sanitizeTrialEventMeta({ age: 0 })).toEqual({ age: 0 });
    expect(trial.sanitizeTrialEventMeta({ age: 18 })).toEqual({ age: 18 });
    expect(trial.sanitizeTrialEventMeta({ age: 19 })).toBeNull();
    expect(trial.sanitizeTrialEventMeta({ age: 4.5 })).toBeNull();
  });
});
