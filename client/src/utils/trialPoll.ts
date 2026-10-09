// Trial job-status polling policy. A non-2xx answer from job-status is NOT proof the trial
// failed: the server returns JSON 5xx on a transient DB error and 429/503 under load, while the
// story keeps generating. One trial per user means a false "failed" screen is very costly.

export type PollHttpOutcome = 'ok' | 'retry' | 'failed';

/** 2xx -> ok; 5xx/429/408 -> retry (transient); every other non-2xx (401/403/404...) -> definitive. */
export function classifyJobStatusHttp(status: number): PollHttpOutcome {
  if (status >= 200 && status < 300) return 'ok';
  if (status >= 500 || status === 429 || status === 408) return 'retry';
  return 'failed';
}

export const MAX_TRANSIENT_POLL_ERRORS = 10;

/** Delay before the next allowed poll after `consecutiveErrors` transient failures (3s base, 30s cap). */
export function pollBackoffMs(consecutiveErrors: number, baseMs = 3000, capMs = 30000): number {
  if (consecutiveErrors <= 0) return 0;
  return Math.min(baseMs * 2 ** consecutiveErrors, capMs);
}

/**
 * The avatar slides the job-status poll reports, folded into what the page already holds.
 * Returns `prev` itself (same reference) when nothing new arrived: the slideshow memo depends on
 * the array, and a fresh identical array every 3 s poll would rebuild it (and reshuffle its
 * captions) on each tick. Slides are independent of the title page: they exist from job start,
 * the title page only ~2.5 min later (staging job_1791490151653_r9mypyn0c).
 */
export function mergeAvatarSlides(prev: string[], incoming: unknown): string[] {
  if (!Array.isArray(incoming) || incoming.length === 0) return prev;
  const next = incoming.filter((s): s is string => typeof s === 'string' && s.length > 0);
  if (next.length === 0) return prev;
  if (next.length === prev.length && next.every((s, i) => s === prev[i])) return prev;
  return next;
}

/**
 * The finished-story hard redirect to /stories fires only for a visitor who has an account to read it in:
 * email verified (claim-session succeeded) or Google linked. An anonymous trial visitor, or one who has
 * only typed an address, stays on the page and reads the book there.
 */
export function shouldRedirectToStories(pageState: string, isVerified: boolean, googleLinked: boolean): boolean {
  return pageState === 'completed' && (isVerified || googleLinked);
}

/**
 * Which figure a slide shows. The server stores each slide as `.../slides/<variant>-<pose>-<head|body>-<hash>.jpg`
 * (avatarSlides.storeSlides): the early body-row slides and the finished sheet's body cells are the same figure with
 * different bytes, so the label before the hash, not the URL, decides that a figure was already shown. Anything else
 * (the hero's data URI) is its own figure.
 */
export function avatarFigureOf(src: string): string {
  const m = /\/slides\/([A-Za-z0-9-]+)-[0-9a-f]{24}\.jpg(?:\?.*)?$/.exec(src);
  return m ? m[1] : src;
}

/**
 * The waiting-screen avatar pool: the slides once the server has any, the hero's front picture only until then.
 * The hero IS the front body cell of the standard sheet, which is also the first body slide: keeping both showed that
 * figure three times in the first five slots (owner iPhone, 2026-10-09: "the main avatar comes up too often at the
 * start"). Strings can not tell them apart (hero is a data URI, slides are stored URLs), so the hero steps aside.
 * One picture per figure.
 */
export function avatarPoolSources(hero: string | null | undefined, slides: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const s of slides.length > 0 ? slides : hero ? [hero] : []) {
    if (!s || seen.has(avatarFigureOf(s))) continue;
    seen.add(avatarFigureOf(s));
    out.push(s);
  }
  return out;
}

/**
 * The next avatar to show: walking on from the current one in list order, the first FIGURE that has not been shown yet;
 * once every figure of the pool has been shown the round starts again (`shown` holds figure labels and is cleared in place,
 * the current one kept). Position comes from the figure, not from a counter or the URL, so a pool that grows or is replaced
 * while the slideshow runs (body-row slides, then the finished sheet's) never restarts it and never repeats a figure.
 * Returns the pool's first picture when nothing is current.
 */
export function nextAvatarSource(pool: string[], shown: Set<string>, current: string | null): string | null {
  if (pool.length === 0) return null;
  const figures = pool.map(avatarFigureOf);
  const curFigure = current ? avatarFigureOf(current) : null;
  const at = curFigure ? figures.indexOf(curFigure) : -1;
  if (curFigure) shown.add(curFigure);
  if (figures.every(f => shown.has(f))) {
    shown.clear();
    if (curFigure) shown.add(curFigure);
    if (pool.length === 1) return pool[0];
  }
  for (let k = 1; k <= pool.length; k++) {
    const i = (at + k + pool.length) % pool.length;
    if (!shown.has(figures[i])) return pool[i];
  }
  return pool[0];
}
