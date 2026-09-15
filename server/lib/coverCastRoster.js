/**
 * COVER CAST ROSTER — the ONE trim the cover generator applies and the cover
 * judge must agree with.
 *
 * Owner, 2026-09-15: "Cover the author is correct max 5."
 *
 * The cover generator is capped at five characters and hands the image model an
 * explicit exclusion list ("ONLY show these characters: … Do NOT include: …").
 * The cover JUDGE built its EXPECTED CAST from the UNTRIMMED brief: the
 * photo-backed roster it was given, plus every Visual Bible person the cover
 * prose names (`matchVbEntitiesInText`). The prose still names the excluded
 * characters — that is exactly why the restriction block exists — so a cover
 * drawn to order was held to a roster the generator had been ordered to
 * violate, and the gap scored as a missing/extra CRITICAL.
 *
 * Both sides now read this module: the same cap, the same exclusion list,
 * computed the same way, so the two agree by construction rather than by
 * matching prose.
 *
 * Names are compared through `castResolver.canonicalName` — never raw string
 * equality (SETTLED: two stored names compare only through canonicalName).
 */

/** More than five characters on a cover almost always produces a bad render. */
const MAX_COVER_CHARACTERS = 5;

function canonical(name) {
  const { canonicalName } = require('./castResolver');
  return canonicalName(String(name || ''));
}

/**
 * @param {Array<string|{name?: string}>} selected  the cast the generator picked for this cover
 * @param {Array<string|{name?: string}>} all       every character the story could have put on it
 * @param {object} [opts]
 * @param {number} [opts.cap=MAX_COVER_CHARACTERS]
 * @returns {{selected: string[], excluded: string[], cap: number}}
 *   `selected` is the trimmed roster (deduped, capped, order preserved);
 *   `excluded` is every other story character — the list the generator's
 *   restriction block names and the judge must keep off its EXPECTED CAST.
 */
function resolveCoverCastRoster(selected, all, opts = {}) {
  const cap = Number.isFinite(opts.cap) ? opts.cap : MAX_COVER_CHARACTERS;
  const nameOf = (c) => String((typeof c === 'string' ? c : c && c.name) || '').trim();
  const seen = new Set();
  const kept = [];
  for (const c of Array.isArray(selected) ? selected : []) {
    const n = nameOf(c);
    if (!n) continue;
    const k = canonical(n);
    if (seen.has(k)) continue;
    seen.add(k);
    kept.push(n);
    if (kept.length >= cap) break;
  }
  const keptKeys = new Set(kept.map(canonical));
  const excludedSeen = new Set();
  const excluded = [];
  for (const c of Array.isArray(all) ? all : []) {
    const n = nameOf(c);
    if (!n) continue;
    const k = canonical(n);
    if (keptKeys.has(k) || excludedSeen.has(k)) continue;
    excludedSeen.add(k);
    excluded.push(n);
  }
  return { selected: kept, excluded, cap };
}

module.exports = { MAX_COVER_CHARACTERS, resolveCoverCastRoster };
