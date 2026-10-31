/**
 * The idea step's "Own story" box: while the parent types, the server's Jev
 * check (POST /api/analyze-own-story) says which story parts the text has.
 * This is the trigger logic only: wait 5 s after the last keystroke, ask only
 * when the text (or the age or book) changed since the last answer and is long enough,
 * drop a stale request when the text moves on. Timers and the request are
 * injected so the unit test needs neither a browser nor a network.
 */

/** Mirror of OWN_STORY_MIN_CHARS in server/lib/ownStoryAnalysis.js. */
export const OWN_STORY_MIN_CHARS = 40;
export const OWN_STORY_DEBOUNCE_MS = 5000;

/** Closed list of story parts, in checklist order. Mirror of OWN_STORY_PARTS on the server. */
export const OWN_STORY_PARTS = ['WHO', 'WHERE', 'PROBLEM', 'WANT', 'ENDING'] as const;
export type OwnStoryPart = typeof OWN_STORY_PARTS[number];

export interface OwnStoryResult {
  present: Record<OwnStoryPart, boolean>;
  missing: OwnStoryPart[];
  unsuitable: boolean;
  /** The text names more events than the chosen book comfortably holds (a hint only, never a limit). */
  tooManyEvents: boolean;
}

/** The chosen book the check measures the text against. */
export interface OwnStoryBook { pages: number; languageLevel?: string }

export interface OwnStoryCheckerOptions {
  analyse: (text: string, age: number | undefined, signal: AbortSignal, book: OwnStoryBook) => Promise<OwnStoryResult>;
  /** result for the text last asked about, or null when the text is too short to check. */
  onResult: (result: OwnStoryResult | null) => void;
  onError?: (err: unknown) => void;
  delayMs?: number;
  minChars?: number;
}

export function createOwnStoryChecker(opts: OwnStoryCheckerOptions) {
  const { analyse, onResult, onError, delayMs = OWN_STORY_DEBOUNCE_MS, minChars = OWN_STORY_MIN_CHARS } = opts;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let controller: AbortController | null = null;
  let lastKey: string | null = null;

  const stop = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (controller) { controller.abort(); controller = null; }
  };

  return {
    /** Call on every change of the text, the age or the book. */
    update(text: string, age: number | undefined, book: OwnStoryBook) {
      const trimmed = text.trim();
      if (timer) { clearTimeout(timer); timer = null; }
      if (trimmed.length < minChars) {
        stop();
        lastKey = null;
        onResult(null);
        return;
      }
      const key = `${age ?? ''}|${book.pages}|${book.languageLevel ?? ''}|${trimmed}`;
      if (key === lastKey) return;            // unchanged since the last answer
      if (controller) { controller.abort(); controller = null; } // stale: the text moved on
      timer = setTimeout(() => {
        timer = null;
        const mine = new AbortController();
        controller = mine;
        analyse(trimmed, age, mine.signal, book)
          .then(result => {
            if (mine.signal.aborted) return;
            lastKey = key;
            controller = null;
            onResult(result);
          })
          .catch(err => {
            if (mine.signal.aborted) return;
            controller = null;
            onError?.(err);
          });
      }, delayMs);
    },
    cancel: stop,
  };
}
