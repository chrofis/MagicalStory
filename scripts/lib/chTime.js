/**
 * Swiss-local time formatting — the ONE way timestamps are shown to the owner.
 *
 * Owner ruling 2026-08-09 (supersedes the May-2026 UTC-only rule, which itself
 * superseded dual-labeling): every timestamp displayed in scripts and replies
 * is Europe/Zurich, marked "CH", with UTC never shown. DST is handled by Intl,
 * never by hand arithmetic. See docs/SETTLED.md.
 *
 * Three timestamp behaviours exist in this stack; pick the right entry point:
 *  - Railway logs / ISO strings with Z (true UTC) → ch(d) / chTime(d) directly.
 *  - Naive Postgres TIMESTAMP columns read via node-pg → the driver parses the
 *    stored-UTC wall clock as LOCAL. Rehome with fromPgNaive(d) FIRST, then
 *    format. (This trap once killed two live Test Lab runs via client-side
 *    age math — or set process.env.TZ='UTC' before requiring pg, or compute
 *    ages in SQL.)
 *  - Browser rendering (React admin pages) → already local; leave alone.
 */
'use strict';

const TZ = 'Europe/Zurich';

const chFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ, hour12: false,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});

function toDate(d) {
  if (d instanceof Date) return d;
  if (typeof d === 'number') return new Date(d);
  // Nanosecond ISO timestamps (Railway) choke Date.parse — trim to millis.
  return new Date(String(d).replace(/(\.\d{3})\d+Z$/, '$1Z'));
}

function parts(date) {
  const p = {};
  for (const { type, value } of chFmt.formatToParts(date)) p[type] = value;
  return p; // {year, month, day, hour, minute, second}
}

/** Full Swiss timestamp: "2026-07-30 22:01:15 CH". */
function ch(d) {
  const date = toDate(d);
  if (isNaN(date)) return String(d);
  const p = parts(date);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second} CH`;
}

/** Time-only for compact log lines: "22:01:15 CH". */
function chTime(d) {
  const date = toDate(d);
  if (isNaN(date)) return String(d);
  const p = parts(date);
  return `${p.hour}:${p.minute}:${p.second} CH`;
}

/**
 * Rehome a node-pg-parsed naive TIMESTAMP: the driver read the stored UTC
 * wall-clock as LOCAL, so rebuild the true instant from its local components.
 */
function fromPgNaive(d) {
  const x = toDate(d);
  if (isNaN(x)) return x;
  return new Date(Date.UTC(
    x.getFullYear(), x.getMonth(), x.getDate(),
    x.getHours(), x.getMinutes(), x.getSeconds(), x.getMilliseconds()
  ));
}

/**
 * Offset of Europe/Zurich at a given instant, in ms (+3600000 CET, +7200000 CEST).
 * Derived from Intl, never from a hand-written DST rule.
 */
function chOffsetMs(date) {
  const p = parts(date);
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUTC - date.getTime();
}

/**
 * The UTC instant of Swiss-local midnight, `offsetDays` from the CH calendar day
 * containing `now` (0 = today, -1 = yesterday, +1 = tomorrow — the exclusive end
 * of today).
 *
 * Why not `date.setHours(0,0,0,0)`: that is the SERVER's local midnight, which is
 * UTC in Railway containers — an hour or two off the day the owner means, so a
 * "today" panel silently mixes in part of yesterday evening. DST is handled by
 * re-reading the zone offset at the candidate instant, which is what makes the
 * 02:00→03:00 and 03:00→02:00 nights come out right.
 *
 * @param {number} offsetDays
 * @param {Date|string|number} [now] - injectable for tests
 * @returns {Date}
 */
function chDayStart(offsetDays = 0, now = new Date()) {
  const base = toDate(now);
  const p = parts(base);
  // Midnight of the target CH calendar day, read as if it were UTC…
  const naive = Date.UTC(+p.year, +p.month - 1, +p.day + offsetDays, 0, 0, 0);
  // …then shifted back by the zone offset actually in force at that instant.
  // Two passes: the first guess can land on the wrong side of a DST switch.
  let ms = naive - chOffsetMs(new Date(naive));
  ms = naive - chOffsetMs(new Date(ms));
  return new Date(ms);
}

/** [start, end) of a Swiss calendar day. offsetDays 0 = today, -1 = yesterday. */
function chDayRange(offsetDays = 0, now = new Date()) {
  return { start: chDayStart(offsetDays, now), end: chDayStart(offsetDays + 1, now) };
}

module.exports = { ch, chTime, fromPgNaive, chOffsetMs, chDayStart, chDayRange };
