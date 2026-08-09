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

module.exports = { ch, chTime, fromPgNaive };
