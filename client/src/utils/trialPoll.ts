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
 * The hero picture IS the front cell of the standard body row / sheet, which the slide lists then carry as
 * `standard-front-body`. The hero's string (a data URI) cannot say so, so this label stands in for it: after the hero was
 * on screen, that figure counts as shown (owner iPhone 2026-10-10: "the full body comes twice at the start").
 */
export const HERO_FIGURE = 'standard-front-body';

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

/** The turning order of the waiting screen (owner, 2026-10-11): head straight, body 45, head 180, body 90, head 45, body straight. */
const POSE_CYCLE = ['front', 'threeQuarter', 'back', 'profile', 'threeQuarter', 'front'] as const;
/** Pictures of one sheet variant shown in a row before the other variant (standard, standard, costumed, costumed, ...). */
const VARIANT_RUN = 2;

interface AvatarFigure { variant: string; pose: string; kind: 'head' | 'body' }

/** A figure label `<variant>-<pose>-<head|body>` (server avatarSlides.figureLabel) as its parts; null for anything else. */
export function parseAvatarFigure(label: string): AvatarFigure | null {
  const m = /^(.+)-(front|threeQuarter|profile|back)-(head|body)$/.exec(label);
  return m ? { variant: m[1], pose: m[2], kind: m[3] as 'head' | 'body' } : null;
}

/** Poses in the order they should follow `cur`: the cycle on from where `cur` stands, never `cur`'s own pose first. */
function poseWalk(cur: AvatarFigure | null): string[] {
  let pos = -1;
  if (cur) {
    const at = POSE_CYCLE.map((p, i) => (p === cur.pose ? i : -1)).filter(i => i >= 0);
    pos = at.find(i => (i % 2 === 0) === (cur.kind === 'head')) ?? at[0];
  }
  const walk: string[] = [];
  for (let d = 1; d <= POSE_CYCLE.length; d++) {
    const pose = POSE_CYCLE[(pos + d + POSE_CYCLE.length) % POSE_CYCLE.length];
    if (pose !== cur?.pose && !walk.includes(pose)) walk.push(pose);
  }
  if (cur) walk.push(cur.pose);
  return walk;
}

/**
 * The index of the next picture among the figures not shown yet, or -1 when none of them is labelled. Every picture differs
 * from the last in what the owner asked for: head and body alternate, the pose follows the turning cycle and never repeats,
 * and the sheet variant changes every VARIANT_RUN pictures when both exist. What the pool lacks relaxes pose first, then
 * head/body, then the variant, so the rotation always continues with the next best picture. `shown` keeps insertion order,
 * which is how the length of the current variant run is known without a counter.
 */
function nextLabelledIndex(figures: string[], shown: Set<string>, curFigure: string | null): number {
  const parsed = figures.map(parseAvatarFigure);
  const open = parsed.map((f, i) => (f && !shown.has(figures[i]) ? i : -1)).filter(i => i >= 0);
  if (open.length === 0) return -1;
  const cur = curFigure ? parseAvatarFigure(curFigure) : null;
  const variants = [...new Set(parsed.filter((f): f is AvatarFigure => !!f).map(f => f.variant))];
  variants.sort((a, b) => Number(b === 'standard') - Number(a === 'standard'));
  let run = 0;
  if (cur) for (const h of [...shown].reverse()) { if (parseAvatarFigure(h)?.variant === cur.variant) run++; else break; }
  const startAt = cur ? Math.max(0, variants.indexOf(cur.variant)) + (run >= VARIANT_RUN ? 1 : 0) : 0;
  const variantOrder = variants.map((_, k) => variants[(startAt + k) % variants.length]);
  const kinds: Array<'head' | 'body'> = !cur || cur.kind === 'body' ? ['head', 'body'] : ['body', 'head'];
  for (const variant of variantOrder) for (const kind of kinds) for (const pose of poseWalk(cur)) {
    const i = open.find(j => parsed[j]!.variant === variant && parsed[j]!.kind === kind && parsed[j]!.pose === pose);
    if (i !== undefined) return i;
  }
  return open[0];
}

/**
 * The next avatar to show: the first FIGURE that has not been shown yet in the turning order (nextLabelledIndex; a pool
 * without figure labels is walked on from the current one in list order);
 * once every figure of the pool has been shown the round starts again (`shown` holds figure labels and is cleared in place,
 * the current one kept). Position comes from the figure, not from a counter or the URL, so a pool that grows or is replaced
 * while the slideshow runs (body-row slides, then the finished sheet's) never restarts it and never repeats a figure.
 * Returns the rotation's first picture (standard, head straight) when nothing is current.
 */
export function nextAvatarSource(pool: string[], shown: Set<string>, current: string | null, hero?: string | null): string | null {
  if (pool.length === 0) return null;
  const figures = pool.map(avatarFigureOf);
  const curFigure = current ? (hero && current === hero ? HERO_FIGURE : avatarFigureOf(current)) : null;
  const at = curFigure ? figures.indexOf(curFigure) : -1;
  if (curFigure) shown.add(curFigure);
  if (figures.every(f => shown.has(f))) {
    shown.clear();
    if (curFigure) shown.add(curFigure);
    if (pool.length === 1) return pool[0];
  }
  const ordered = nextLabelledIndex(figures, shown, curFigure);
  if (ordered >= 0) return pool[ordered];
  for (let k = 1; k <= pool.length; k++) {
    const i = (at + k + pool.length) % pool.length;
    if (!shown.has(figures[i])) return pool[i];
  }
  return pool[0];
}

