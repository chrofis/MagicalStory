/**
 * ONE resolver for "which cast entry does this string name?".
 *
 * WHY THIS EXISTS. A story's people come from three pools that are never
 * merged in storage — the photo-backed cast (`storyData.characters[]`, numeric
 * timestamp ids), the Visual Bible's invented secondaries (`CHR###`) and its
 * animals (`ANI###`) — while every brief, roster and metadata list names them
 * by STRING: the full name, the title-less short form the prose uses ("Rossa"
 * for "Kapitänin Rossa"), or a bare VB id placeholder. Five separate rules
 * grew up to decide whether a string names an entry, and they disagree.
 *
 * The damage is measured, not theoretical: on job_1789163494908_kc2joi4ax p9
 * the detector roster read ["Julian","Max","Kiaan","Vendor","Marroni Vendor"]
 * — one person listed twice, because the caller deduped by string. The same
 * story holds a secondary "Mother" (CHR001) and an animal "Mother Dragon"
 * (ANI002), which the whole-word-subset/first-match rule in
 * phantomCharacters.js would silently merge into one; and an earlier
 * `label.includes(name)` rule in the repair targeter whited out the wrong
 * person's head.
 *
 * So: resolution is keyed by ENTRY, not by name. This module is read-time
 * only — stored data stays name-keyed — and it never returns an id as a
 * display string, because a VB id must never reach an image prompt.
 *
 * Pure and CommonJS; `./vbIdGuard` is required lazily inside the functions
 * that need it so this module stays free of load-order constraints. Nothing
 * here throws: a malformed bible resolves to fewer entries, never to a crash.
 */

/** A whole VB handle, anchored, own copy — the grammar lives in vbIdGuard. */
function anchoredVbIdPattern() {
  const { VB_ID_PATTERN } = require('./vbIdGuard');
  return new RegExp(`^(?:${VB_ID_PATTERN.source})$`, 'i');
}

/**
 * The comparable form of a name: no trailing parenthetical, no diacritics,
 * single-spaced, lowercase. "Kapitänin Rossa (the captain)" → "kapitanin rossa".
 *
 * Diacritics fold because the same person is spelled both ways across a German
 * or French story's bible, prose and metadata.
 *
 * @param {*} s
 * @returns {string} '' when there is nothing to canonicalise
 */
function canonicalName(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/\s*\([^)]*\)\s*$/, '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Index every named entity of a story in POOL ORDER: cast → secondary →
 * animal. Order is the tie-break for rules 2 and 3 — a user's own character
 * outranks an invented one of the same name, never the reverse.
 *
 * @param {object|null} storyData
 * @param {object|null} visualBible
 * @returns {{entries: Array, byId: Map, byCanon: Map, stats: {refs: number, unresolved: Array, ambiguous: Array}}}
 */
function buildCastIndex(storyData, visualBible) {
  const entries = [];
  const pools = [
    { kind: 'cast', list: storyData && storyData.characters },
    { kind: 'secondary', list: visualBible && visualBible.secondaryCharacters },
    { kind: 'animal', list: visualBible && visualBible.animals },
  ];
  for (const { kind, list } of pools) {
    if (!Array.isArray(list)) continue;
    for (const raw of list) {
      if (!raw || typeof raw !== 'object') continue;
      const name = typeof raw.name === 'string' ? raw.name.trim() : '';
      if (!name) continue;                       // an unnamed entry is unreferenceable
      const canon = canonicalName(name);
      entries.push({
        kind,
        id: raw.id === null || raw.id === undefined ? '' : String(raw.id),
        name,
        entry: raw,
        canon,
        words: canon ? canon.split(' ') : [],
      });
    }
  }
  const byId = new Map();
  const byCanon = new Map();
  for (const e of entries) {
    if (e.id) {
      const k = e.id.toUpperCase();
      if (!byId.has(k)) byId.set(k, e);
    }
    if (e.canon && !byCanon.has(e.canon)) byCanon.set(e.canon, e);
  }
  return { entries, byId, byCanon, stats: { refs: 0, unresolved: [], ambiguous: [] } };
}

/**
 * Resolve one reference string to exactly one entry, or to nothing.
 *
 * Ladder: a VB id (dotted forms are a facet of their parent), then an exact
 * canonical name, then whole-word subset in EITHER direction across all pools.
 * The subset step demands a unique candidate — two candidates mean the
 * reference genuinely is ambiguous, and picking the first is how "Mother"
 * became "Mother Dragon".
 *
 * @param {*} ref
 * @param {object} index - from buildCastIndex
 * @param {{log?: object|null, pageLabel?: string}} [opts]
 * @returns {object|null} the index entry
 */
function resolveEntity(ref, index, { log = null, pageLabel = '' } = {}) {
  if (!index) return null;
  const text = ref === null || ref === undefined ? '' : String(ref).trim();
  if (!text) return null;                         // an empty ref is not a failed lookup
  index.stats.refs++;

  // (1) a VB id placeholder — `CHR001`, and `CHR001.2` is the same entry.
  if (anchoredVbIdPattern().test(text)) {
    const { baseVbId } = require('./vbIdGuard');
    const base = baseVbId(text);
    const hit = base ? index.byId.get(base.toUpperCase()) : null;
    if (hit) return hit;
  }

  // (2) the same name, spelled comparably.
  const canon = canonicalName(text);
  const exact = index.byCanon.get(canon);
  if (exact) return exact;

  // (3) a title dropped, or a title added.
  const words = canon ? canon.split(' ') : [];
  const candidates = words.length === 0 ? [] : index.entries.filter((e) => {
    if (e.words.length === 0) return false;
    return words.every(w => e.words.includes(w)) || e.words.every(w => words.includes(w));
  });
  if (candidates.length === 1) return candidates[0];

  if (candidates.length === 0) {
    index.stats.unresolved.push(text);
    if (log && typeof log.warn === 'function') {
      log.warn(`⚠️ [CAST-RESOLVE] ${pageLabel}"${text}" unresolved`);
    }
    return null;
  }
  const names = candidates.map(c => c.name);
  index.stats.ambiguous.push({ ref: text, candidates: names });
  if (log && typeof log.warn === 'function') {
    log.warn(`⚠️ [CAST-RESOLVE] ${pageLabel}"${text}" ambiguous → ${names.join(', ')}`);
  }
  return null;
}

/**
 * Do two strings name the same person? Falls back to canonical equality when
 * either side is unresolvable, so an off-roster string still matches itself.
 */
function sameEntity(a, b, index) {
  const ea = resolveEntity(a, index);
  const eb = resolveEntity(b, index);
  if (ea && eb) return ea === eb;
  return canonicalName(a) === canonicalName(b);
}

/**
 * Collapse a roster to one spelling per PERSON, keeping the first spelling
 * seen. This is the p9 fix: ["…","Vendor","Marroni Vendor"] is four people.
 * Names nothing resolves are kept (deduped canonically) — dropping an
 * unknown name would blind the identity call.
 */
function dedupeByEntity(names, index) {
  const out = [];
  const seenEntries = new Set();
  const seenCanon = new Set();
  for (const n of (Array.isArray(names) ? names : [])) {
    const text = n === null || n === undefined ? '' : String(n).trim();
    if (!text) continue;
    const e = resolveEntity(text, index);
    if (e) {
      if (seenEntries.has(e)) continue;
      seenEntries.add(e);
      seenCanon.add(e.canon);
      out.push(text);
      continue;
    }
    const c = canonicalName(text);
    if (seenCanon.has(c)) continue;
    seenCanon.add(c);
    out.push(text);
  }
  return out;
}

/** What a human (or an image model) may be shown — never an id. */
function displayName(entry) {
  return entry ? entry.name : '';
}

/** Animals are not people: the person detector can never satisfy one. */
function isNonHuman(entry) {
  return !!entry && entry.kind === 'animal';
}

/** The parenthetical a description block carries; null for the photo cast. */
function kindLabel(entry) {
  if (!entry) return null;
  if (entry.kind === 'animal') {
    const species = entry.entry && entry.entry.species;
    return species ? `animal, ${species}` : 'animal';
  }
  if (entry.kind === 'secondary') return 'secondary character';
  return null;
}

/**
 * Look a reference up in a name-keyed map (clothingRequirements, description
 * blocks, …) whose keys were written with a different spelling than the ref.
 * Exact key first, then canonical key, then same-entity key.
 *
 * @returns {{key: string, value: *}|null}
 */
function lookupByName(map, ref, index) {
  if (!map || typeof map !== 'object') return null;
  const keys = Object.keys(map);
  const text = ref === null || ref === undefined ? '' : String(ref);
  if (Object.prototype.hasOwnProperty.call(map, text)) return { key: text, value: map[text] };
  const canon = canonicalName(text);
  const byCanon = keys.find(k => canonicalName(k) === canon);
  if (byCanon !== undefined) return { key: byCanon, value: map[byCanon] };
  const target = resolveEntity(text, index);
  if (!target) return null;
  const byEntity = keys.find(k => resolveEntity(k, index) === target);
  if (byEntity !== undefined) return { key: byEntity, value: map[byEntity] };
  return null;
}

// ───────────────────────────────────────────────────────────────────────────
// NAMES INSIDE TEXT. The one place that decides "is this cast name in this
// string?". Before 2026-10-09 at least fourteen call sites each wrote their own
// answer — a `.includes()` substring ("Max" in "Maximilian", "Ann" in "Anna"),
// an ASCII `\b` regex (blind to "Zoé" and "Émile"), a Unicode lookaround regex
// copied six times with slightly different edges — and they disagreed.
// Rule (docs/SETTLED.md, castResolver line): a name is in a text only as a WHOLE
// WORD, letters and digits being the word characters, so a longer name that
// merely starts with it never counts.
//
// Reading free text for a name is still reading text; the sites that do it are
// listed in docs/decisions.md (2026-10-09, name matchers). This module makes
// them agree, it does not make the reading structured.
// ───────────────────────────────────────────────────────────────────────────

/** Escape a literal for use inside a RegExp. */
function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Whole-word, case-insensitive, Unicode regex for ONE literal name.
 * `possessive: true` (default) lets a trailing 's / s' / ’s follow ("Anna's");
 * `possessive: false` refuses it — a possessive names a place or a prop
 * ("Anna's attic"), not the person. `caseSensitive: true` keeps a name that is
 * also a word ("Rose", "Raven") from matching its lower-case noun.
 *
 * @param {string} name
 * @param {{possessive?: boolean, global?: boolean, caseSensitive?: boolean}} [opts]
 * @returns {RegExp}
 */
function nameRegExp(name, { possessive = true, global = false, caseSensitive = false } = {}) {
  // A one-letter "name" is a word of the language ("A", "I"), never a person in a text.
  if (String(name === null || name === undefined ? '' : name).trim().length < 2) return global ? /(?!)/g : /(?!)/;
  const after = possessive ? '[\\p{L}\\p{N}]' : "[\\p{L}\\p{N}'’]";
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(name)}(?!${after})`, `${global ? 'g' : ''}${caseSensitive ? '' : 'i'}u`);
}

/** Is `name` a whole word of `text`? An empty name is in no text. */
function isNameMentioned(text, name, opts) {
  const n = String(name === null || name === undefined ? '' : name).trim();
  if (!n || text === null || text === undefined) return false;
  return nameRegExp(n, opts).test(String(text));
}

/**
 * The names (and their aliases) of `names` present in `text`, in `names` order.
 * `aliases` maps a name to other spellings that count as that same name
 * (planCounters.resolveCast().aliases: a bare first name for its full name).
 *
 * @param {string} text
 * @param {string[]} names
 * @param {Object<string,string[]>} [aliases]
 * @param {{possessive?: boolean}} [opts]
 * @returns {string[]}
 */
function namesMentioned(text, names, aliases = {}, opts) {
  const t = String(text === null || text === undefined ? '' : text);
  return (Array.isArray(names) ? names : []).filter((n) => {
    if (!n) return false;
    return [n, ...((aliases && aliases[n]) || [])].some(f => f && nameRegExp(f, opts).test(t));
  });
}

/**
 * The index entries whose name is a whole word of `text`, in pool order.
 * With `firstToken: true` a bare first token also counts, but only when it is
 * unambiguous across the whole cast: no other entry carries that token as any
 * word of its name ("Mother" is never an alias of "Mother Dragon" once a
 * secondary is called "Mother").
 *
 * @param {string} text
 * @param {object} index - from buildCastIndex
 * @param {{possessive?: boolean, kinds?: string[], firstToken?: boolean}} [opts] - kinds limits the pools
 * @returns {Array} index entries
 */
function entriesMentioned(text, index, opts = {}) {
  if (!index || !Array.isArray(index.entries)) return [];
  const { kinds, firstToken = false, ...regexOpts } = opts;
  const t = String(text === null || text === undefined ? '' : text);
  if (!t) return [];
  const hits = [];
  for (const e of index.entries) {
    if (kinds && !kinds.includes(e.kind)) continue;
    const full = String(e.name).replace(/\s*\([^)]*\)\s*$/, '').trim();
    if (full && nameRegExp(full, regexOpts).test(t)) { hits.push(e); continue; }
    if (!firstToken || e.words.length < 2) continue;
    const token = e.words[0];
    const shared = index.entries.some(o => o !== e && o.words.includes(token));
    if (shared || token.length < 2) continue;
    // the token as the prose spells it, not the folded form: match on the original first word
    const original = full.split(/\s+/)[0];
    if (original && nameRegExp(original, regexOpts).test(t)) hits.push(e);
  }
  return hits;
}

/**
 * Replace every whole-word occurrence of any of `names`, in ONE pass (never
 * sequential, or A->B->C cascades); longer names win over shorter ones
 * ("Anna Maria" over "Anna"). A trailing possessive ("Hans's", "Hans'") is
 * consumed with the name and handed to `fn` so the caller decides what becomes
 * of it.
 *
 * @param {string} text
 * @param {string[]} names
 * @param {(matchedName: string, possessive: string) => string} fn
 * @param {{caseSensitive?: boolean}} [opts] - a name that is also a word ("Rose") needs its capital
 * @returns {string}
 */
function replaceNamesWith(text, names, fn, { caseSensitive = false } = {}) {
  if (!text || typeof text !== 'string') return text;
  const list = [...new Set((Array.isArray(names) ? names : []).map(n => String(n === null || n === undefined ? '' : n).trim()).filter(n => n.length >= 2))];
  if (list.length === 0) return text;
  list.sort((a, b) => b.length - a.length);
  const re = new RegExp(`(?<![\\p{L}\\p{N}])(${list.map(escapeRegExp).join('|')})(['’]s?)?(?![\\p{L}\\p{N}])`, caseSensitive ? 'gu' : 'giu');
  return text.replace(re, (_m, name, poss) => fn(name, poss || ''));
}

/**
 * `replaceNamesWith` for a plain substitution table. Keys are matched
 * case-insensitively; the possessive suffix, if any, stays after the
 * replacement ("Noah's" -> "the figure's").
 *
 * @param {string} text
 * @param {Map<string,string>|Object<string,string>} replacements
 * @returns {string}
 */
function replaceNames(text, replacements) {
  const map = new Map();
  const src = replacements instanceof Map ? replacements.entries() : Object.entries(replacements || {});
  for (const [k, v] of src) if (k) map.set(String(k).toLowerCase(), v);
  return replaceNamesWith(text, [...map.keys()], (name, poss) => map.get(name.toLowerCase()) + poss);
}

/**
 * One INFO line per page so a resolution failure is visible on the day it
 * ships, not five stories later. Silent when nothing was resolved.
 */
function flushResolverStats(index, log, pageLabel = '') {
  if (!index || !index.stats || index.stats.refs === 0) return;
  if (!log || typeof log.info !== 'function') return;
  const { refs, unresolved, ambiguous } = index.stats;
  const uList = [...new Set(unresolved)].join(', ');
  const aList = [...new Set(ambiguous.map(a => a.ref))].join(', ');
  log.info(`[CAST-RESOLVE] ${pageLabel}${refs} refs, ${unresolved.length} unresolved (${uList}), ${ambiguous.length} ambiguous (${aList})`);
}

module.exports = {
  canonicalName,
  buildCastIndex,
  resolveEntity,
  sameEntity,
  dedupeByEntity,
  displayName,
  isNonHuman,
  kindLabel,
  lookupByName,
  flushResolverStats,
  escapeRegExp,
  nameRegExp,
  isNameMentioned,
  namesMentioned,
  entriesMentioned,
  replaceNames,
  replaceNamesWith,
};
