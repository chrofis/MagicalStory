/**
 * Offer windows for the SEASONAL story topics. A seasonal topic is OFFERED only around its occasion; computed from the current
 * date, so nothing is switched by hand. Gating affects what a picker offers, never what loads: a draft or story that already
 * holds a hidden seasonal topic still opens (nothing here is consulted outside the pickers).
 *
 * The dates are SWISS by owner decision (2026-10-09), for every story language: Mother's Day = 2nd Sunday of May, Father's Day =
 * 1st Sunday of June. docs/decisions.md 2026-10-09 "Seasonal topics are offered only around their occasion".
 */

/** A calendar day as a UTC day number (ms), so date arithmetic never meets a timezone or DST. */
export type DayNumber = number;
const day = (year: number, month1: number, d: number): DayNumber => Date.UTC(year, month1 - 1, d);
const DAY_MS = 24 * 60 * 60 * 1000;

/** Easter Sunday of a Gregorian year (the anonymous Gregorian algorithm, Meeus/Jones/Butcher). */
export function easterSunday(year: number): DayNumber {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const dayOfMonth = ((h + l - 7 * m + 114) % 31) + 1;
  return day(year, month, dayOfMonth);
}

/** The n-th (1-based) Sunday of a month. */
export function nthSunday(year: number, month1: number, n: number): DayNumber {
  const first = new Date(day(year, month1, 1)).getUTCDay(); // 0 = Sunday
  return day(year, month1, 1 + ((7 - first) % 7) + 7 * (n - 1));
}

/** The window of ONE occurrence, from the year the occasion starts in. Both ends inclusive. */
export interface SeasonWindow {
  occurrence: (year: number) => { from: DayNumber; to: DayNumber };
}

const FOUR_WEEKS = 28 * DAY_MS;
export const SEASON_WINDOWS = {
  halloween: { occurrence: (y: number) => ({ from: day(y, 10, 1), to: day(y, 10, 31) }) },
  christmas: { occurrence: (y: number) => ({ from: day(y, 11, 1), to: day(y, 12, 26) }) },
  samichlaus: { occurrence: (y: number) => ({ from: day(y, 11, 6), to: day(y, 12, 6) }) }, // 6 Dec, one month ahead (owner 2026-10-09)
  // wraps the year: 15 Dec of y to 6 Jan of y + 1
  newyear: { occurrence: (y: number) => ({ from: day(y, 12, 15), to: day(y + 1, 1, 6) }) },
  // five weeks before Easter Sunday through Easter Monday
  easter: { occurrence: (y: number) => ({ from: easterSunday(y) - 35 * DAY_MS, to: easterSunday(y) + DAY_MS }) },
  'mothers-day': { occurrence: (y: number) => { const d = nthSunday(y, 5, 2); return { from: d - FOUR_WEEKS, to: d }; } },
  'fathers-day': { occurrence: (y: number) => { const d = nthSunday(y, 6, 1); return { from: d - FOUR_WEEKS, to: d }; } },
} satisfies Record<string, SeasonWindow>;

export type SeasonalTopicId = keyof typeof SEASON_WINDOWS;

/** Today as a day number in the visitor's own calendar. */
export function dayNumberOf(now: Date): DayNumber {
  return day(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

/** Is `now` inside the window? A window may start in the previous year (new year), so three occurrences are checked. */
export function isInSeason(season: SeasonWindow | undefined, now: Date = new Date()): boolean {
  if (!season) return true; // no window = always offered
  const today = dayNumberOf(now);
  const year = now.getFullYear();
  return [year - 1, year, year + 1].some((y) => {
    const { from, to } = season.occurrence(y);
    return today >= from && today <= to;
  });
}
