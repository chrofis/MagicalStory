/**
 * CODE-SIDE PLAN COUNTERS — the free half of the beats plan check.
 *
 * The beats layer stopped checking the STORY (owner ruling, 2026-09-01: the
 * reviewer "should not fix the story at all... count the images"). The arc
 * machine owns story correctness; what is left at the beats layer is arithmetic
 * over the division — how many close-ups, how many people per page, who never
 * gets a page of their own. That arithmetic is deterministic, so it costs
 * nothing and never hallucinates: it runs here, in code, and only the four
 * judgement calls a counter cannot make go to a model (prompts/plan-check.txt).
 *
 * Input is the parsed PAGE PLAN line per page plus its beat. A plan line is
 * "<shot> — <who is in frame> — <the instant> — <what is true after>"
 * (prompts/story-beats.txt). Every counter degrades rather than throws: a plan
 * line that does not parse produces a PLAN_LINE_INCOMPLETE finding and is
 * skipped by the counters that need its segments, because a malformed line must
 * never silently zero a distribution.
 *
 * Findings are structured — {code, pages, detail} — and render to one line each
 * for the re-plan request. They are advisory input to ONE re-plan by the
 * planner; nothing here ever edits a beat.
 */

/** Plan-line segments are em-dash separated; en-dash and "--" are tolerated. */
const SEGMENT_SPLIT = /\s+[—–]\s+|\s+--\s+/;

/**
 * Shot vocabulary, longest-first. The table used to live here; it is now one
 * declaration (server/lib/shotVocabulary.js) shared with the two Art Director
 * templates and the image prompt, so a word this file counts is a word those
 * stages can define. Anything unrecognised counts as 'other' and is reported
 * rather than silently folded into medium.
 */
const { SHOT_PATTERNS, SHOT_AXIS } = require('./shotVocabulary');

/** Words that look like names but never are, in the who-column's grammar. */
const NAME_STOPWORDS = new Set([
  'The', 'A', 'An', 'And', 'But', 'Then', 'One', 'Two', 'Three', 'Four', 'Five',
  'Page', 'Beat', 'Plan', 'Shot', 'Both', 'All', 'Everyone', 'Nobody', 'No',
  'Close', 'Wide', 'Medium', 'Ultra', 'Portrait', 'Mid', 'Far', 'Near',
  // Sentence-initial function words: capitalised by grammar, never a person.
  'In', 'At', 'On', 'To', 'From', 'By', 'For', 'With', 'As', 'Of', 'Into',
  'When', 'Where', 'While', 'After', 'Before', 'Because', 'Since', 'Until',
  'Now', 'Next', 'Still', 'Even', 'Just', 'Only', 'Every', 'Each', 'Some',
  'That', 'This', 'These', 'Those', 'There', 'Here', 'Once', 'Above', 'Below',
  'He', 'She', 'It', 'They', 'His', 'Her', 'Their', 'Its', 'Him', 'Them',
  'Neither', 'Either', 'Never', 'Nothing', 'Something', 'Anyone', 'Someone',
]);

/** Immediately-preceding words that mark the capitalised token as a place or vessel, not a person. */
const PLACE_PREPOSITIONS = new Set([
  'of', 'at', 'in', 'on', 'to', 'from', 'near', 'across', 'up', 'down',
  'toward', 'towards', 'beside', 'behind', 'inside', 'outside', 'along', 'past', 'through',
]);

/** Person words that make a page peopled even with no name in frame. */
const PERSON_WORDS = /\b(?:crew|crewman|crewmen|sailor|sailors|man|men|woman|women|boy|boys|girl|girls|child|children|figure|figures|crowd|onlookers|guard|guards|villagers?|people)\b/i;

/**
 * A plan line that DECLARES interpersonal drama — the signal for
 * `PEOPLELESS_ON_INTERACTION_PAGE`.
 *
 * A people-free page is a FEATURE (see `NO_PEOPLELESS_PAGE`): the drama can be
 * a place, weather, a vessel or an object seen from afar. It is wrong only when
 * the drama is BETWEEN PEOPLE, and the pictures that lose the most are exactly
 * those — a parting, a confrontation, tears.
 *
 * The plan line is the only per-page text that exists at plan-check time (the
 * beat prose was removed 2026-09-02; a page IS its plan line), so the signal is
 * what the line itself says, never a pattern match on prose written later.
 * Two clauses, both plan-DECLARED:
 *   1. absence of people — the line stages the moment by naming who is NOT
 *      there. A page whose subject is a place describes the place; a page that
 *      has to say "no one is at X" is a page about the people who left.
 *      Bare "empty" is deliberately absent: the prompt allows an empty place as
 *      a page's subject.
 *   2. an interaction the line names outright — shouting, waving, weeping, a
 *      farewell, a handover, an embrace, a confrontation.
 * Archetypal English only; it is read against the whole line, quotes stripped.
 */
const INTERACTION_DRAMA_WORDS = new RegExp([
  // 1. people named by their absence
  '\\bno one\\b', '\\bnobody\\b', '\\bnot a soul\\b', '\\bdeserted\\b', '\\babandoned\\b',
  '\\bleft behind\\b', '\\b(?:they|everyone|the others) (?:have |has |had )?(?:gone|left|go)\\b',
  // 2. an interaction the line names
  '\\bshout(?:s|ing|ed)?\\b', '\\bcall(?:s|ing)? (?:out |back )?after\\b', '\\bcry(?:ing)?\\b', '\\bcries\\b',
  '\\bweep(?:s|ing)?\\b', '\\btears\\b', '\\bwav(?:e|es|ing)\\b', '\\bcheer(?:s|ing)?\\b',
  '\\bfarewell\\b', '\\bgoodbye\\b', '\\bparting\\b', '\\bembrac(?:e|es|ing)\\b', '\\bhug(?:s|ging)?\\b',
  '\\bhand(?:s|ing)? (?:it |them )?over\\b', '\\bconfront(?:s|ing)?\\b', '\\bargu(?:e|es|ing|ment)\\b',
  '\\bpromis(?:e|es|ing)\\b',
].join('|'), 'i');

/**
 * Strip «…» / "…" / '…' quoted spans — vessels, titles and speech, never cast.
 *
 * The single-quote clause is QUOTE-SHAPED: the opening ' sits at the start of
 * the text or after whitespace, the closing ' is followed by whitespace,
 * sentence punctuation or the end. A possessive has a letter directly before
 * its apostrophe, so it can never open a match. The earlier `'[^']*'` treated
 * "ship's … Fiona's" as one quotation and deleted everything between the two
 * possessives — on job_1788983823620_csjcyp1q9 that was 969 of 3818 plan chars
 * (26%, whole pages) removed from the corpus every cast test scans. Measured
 * over the 25 most recent staging plans: 0 single-quote quotations, 127
 * possessives.
 */
function stripQuoted(text) {
  return String(text || '')
    .replace(/«[^»]*»/g, ' ')
    .replace(/"[^"]*"/g, ' ')
    .replace(/(^|\s)'[^']*?'(?=[\s.,;:!?)]|$)/g, ' ');
}

/** Split a plan line into its four segments; fewer than four means incomplete. */
function planSegments(planLine) {
  return String(planLine || '')
    .split(SEGMENT_SPLIT)
    .map(s => s.trim())
    .filter(Boolean);
}

/** Classify a plan line's shot column. Returns 'other' when nothing matches. */
function classifyShot(segment) {
  const text = String(segment || '');
  for (const [name, re] of SHOT_PATTERNS) if (re.test(text)) return name;
  return 'other';
}

/**
 * Candidate character names in a piece of plan/beat text.
 *
 * Capitalised runs, minus the stopwords, minus anything sitting directly after
 * a place preposition ("the rail of the Ferro Corvo", "at Cala Ventosa") — that
 * position is where vessels and locations live in this grammar, and counting
 * one as a person inflates every cast number on the page.
 *
 * @returns {string[]} unique candidates in first-appearance order.
 */
function nameCandidates(text) {
  const clean = stripQuoted(text);
  const out = [];
  // Horizontal whitespace only: the preceding token and the further tokens of a
  // multi-word name must sit on the SAME plan line. A line break never joins a
  // name that ends one line to the word that opens the next.
  const re = /(\S+[ \t]+)?\b([A-ZÄÖÜ][a-zäöüßéèàâç]+(?:[ \t]+[A-ZÄÖÜ][a-zäöüßéèàâç]+)*)\b/g;
  let m;
  while ((m = re.exec(clean)) !== null) {
    const prev = String(m[1] || '').trim().toLowerCase().replace(/[^a-zäöüß]/g, '');
    const name = m[2];
    if (NAME_STOPWORDS.has(name.split(/\s+/)[0])) continue;
    if (PLACE_PREPOSITIONS.has(prev)) continue;
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

/**
 * Weekday and month names for a locale, from Intl — never a hard-coded word
 * list. Both `long` and `short` forms, plus a capitalised form of each, because
 * a locale like French renders them lowercase ("lundi") while a plan line
 * writes them capitalised at a sentence head.
 *
 * A locale Intl cannot resolve degrades to nothing rather than throwing: losing
 * one language's calendar nouns costs an occasional false invented-cast entry,
 * which is what this whole exclusion exists to reduce — it must never be able
 * to kill a run.
 *
 * @param {string} locale a BCP-47 tag ('en-gb', 'de', 'fr-ch', …)
 * @returns {string[]} unique names, long and short, original and capitalised
 */
function calendarNamesForLocale(locale) {
  const out = [];
  const push = (v) => {
    const s = String(v || '').trim();
    if (!s) return;
    for (const form of [s, s.charAt(0).toUpperCase() + s.slice(1)]) {
      if (!out.includes(form)) out.push(form);
    }
  };
  try {
    for (const style of ['long', 'short']) {
      const wd = new Intl.DateTimeFormat(locale, { weekday: style, timeZone: 'UTC' });
      // 2024-01-01 is a Monday, so seven consecutive days cover every weekday.
      for (let d = 1; d <= 7; d++) push(wd.format(new Date(Date.UTC(2024, 0, d))));
      const mo = new Intl.DateTimeFormat(locale, { month: style, timeZone: 'UTC' });
      for (let m = 0; m < 12; m++) push(mo.format(new Date(Date.UTC(2024, m, 15))));
    }
  } catch {
    return [];
  }
  // Intl's `short` month form is numeric in some locales ("1", "01"). A digit
  // string can never be a name candidate, and letting it through would make the
  // whole-word containment test below match arbitrary tokens.
  return out.filter(n => /[a-zA-ZÀ-ɏ]/.test(n));
}

/**
 * Calendar nouns that can never be a character in this story.
 *
 * ALWAYS includes English, whatever the book's language: the PAGE PLAN is
 * written in English by contract (prompts/story-beats.txt), and the plan line
 * is the only corpus `resolveCast` scans. The story's own language is added on
 * top so a plan line that carries a localised date word is covered too.
 *
 * @param {string} [language] `inputData.language` ('en-gb', 'de-ch', 'fr', …)
 * @returns {string[]} unique calendar nouns
 */
function collectCalendarNames(language) {
  const locales = ['en'];
  const lang = String(language || '').trim();
  if (lang && !/^en/i.test(lang)) {
    locales.push(lang);
    // The bare language subtag too: 'de-ch' and 'de' can differ in short forms.
    const base = lang.split(/[-_]/)[0];
    if (base && base !== lang) locales.push(base);
  }
  const out = [];
  for (const loc of locales) {
    for (const n of calendarNamesForLocale(loc)) if (!out.includes(n)) out.push(n);
  }
  return out;
}

/**
 * The named things this story already knows can never be CAST — places, and
 * the calendar nouns of its own language.
 *
 * Places come from the authoritative data the job carries into the beats stage
 * — never a word list and never a guess. Three sources, all resolved before
 * `generateStoryViaBeats` runs and all the same names the planner was handed in
 * its own prompt:
 *   - `inputData.availableLandmarks[].name` — the landmark index entries
 *     resolved for the family's town (storyJobPipeline, before the beats call).
 *   - `inputData.userLocation.city` / `.country` — the town itself.
 *   - `extraNames` — the caller's canonical named things for this story
 *     (historical locations and period objects, which are places and props by
 *     definition and are looked up by name the same way).
 *
 * Calendar nouns join the same list because they fail the cast test the same
 * way and for the same reason: "Monday" is capitalised, is followed by a verb
 * somewhere in the book ("Monday came"), and so passes the acts-like-a-person
 * heuristic and burns an invented-cast slot (measured on
 * job_1788641639919_mpjwlzkf1). They are derived from Intl for the story
 * language rather than listed, so no language is privileged and no word list
 * has to be maintained. A commissioned character is resolved BEFORE this list
 * is consulted, so a child actually named April or June stays a character.
 *
 * @param {Object} inputData
 * @param {string[]} [extraNames]
 * @returns {string[]} unique trimmed names
 */
function collectPlaceNames(inputData = {}, extraNames = []) {
  const names = [
    ...(Array.isArray(inputData.availableLandmarks) ? inputData.availableLandmarks.map(l => l && l.name) : []),
    inputData.userLocation?.city,
    inputData.userLocation?.region,
    inputData.userLocation?.country,
    ...extraNames,
    ...collectCalendarNames(inputData.language),
  ].map(n => String(n || '').trim()).filter(Boolean);
  return [...new Set(names)];
}

/** Whole-word regex for a literal name. */
function nameRe(name, flags = 'iu') {
  return new RegExp(`\\b${String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, flags);
}

/** Escape a literal for use inside a RegExp. */
function reEscape(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/*
 * THE THING-MARKER GRAMMAR IS GONE (owner, 2026-09-11: "we have AI calls for
 * this, not some stupid Regex that we fix 1000 times").
 *
 * `isThingMarked` / `thingMarkedNames` decided whether a capitalised name was a
 * person by looking at the single token before it (an article or a place
 * preposition meant a thing) and the single token after it (a lowercase word
 * meant it acted, so a person). Two surface accidents of one sentence shape,
 * standing in for a definition. It was patched once per story that broke it —
 * a ship and a town (job_1788983823620_csjcyp1q9), a mountain and its lookout
 * tower (job_1788614817116_vxnu60yjg), German nouns from the beats — and still
 * read a lamp, two bikes, a bridge and a river as cast on
 * job_1789147573901_m3uam0nxi, because possessives, adjectives in between and
 * noun compounds are shapes it never enumerated. One unmarked occurrence
 * anywhere in the book flipped a name permanently.
 *
 * The plan check already sends these same pages to a model. That call now
 * answers the language question — who is in frame, people vs things — and this
 * module does arithmetic on the answer. Code does math, the model does
 * language. See `parsePlanCheckRoster` (promptBuilders.js) and `resolveCast`.
 */

/**
 * Fold a bare first name into the one full name it belongs to.
 *
 * `nameCandidates` returns a full name and its bare first token as two separate
 * candidates ("Malva Grimm" in the who-column, "Malva" in the instant). Measured
 * on job_1788983823620_csjcyp1q9 once the corpus was fully visible: full name
 * and bare first name counted as two people — `cast.invented` was
 * ["Malva Grimm", "Malva"], page 4 counted 3 in frame instead of 2, and the arc
 * cross-check reported "Malva" as undeclared beside the declared "Malva Grimm".
 *
 * The rule, over a POOL of every multi-token name the plan or the commission
 * knows (the folding lives here, not in `nameCandidates`, because only here is
 * that pool known):
 *   - a multi-token candidate is already canonical;
 *   - a single token equal (case-insensitively) to the FIRST token of exactly
 *     ONE pool name folds into that name, in the pool's spelling;
 *   - zero matches: a genuine single-name character, returned as it is;
 *   - two or more (two people sharing a first name): NOT folded — the bare token
 *     is kept and flagged `ambiguous` so the caller can log it. Never guess.
 *
 * @param {string} cand a candidate as nameCandidates returned it
 * @param {string[]} pool multi-token names (single-token entries are ignored)
 * @returns {{name: string, ambiguous: boolean}}
 */
function canonicalName(cand, pool) {
  const single = String(cand || '').trim();
  if (/\s/.test(single)) return { name: single, ambiguous: false };
  const token = single.toLowerCase();
  const matches = [];
  for (const full of pool) {
    const parts = String(full || '').trim().split(/\s+/);
    if (parts.length < 2 || parts[0].toLowerCase() !== token) continue;
    if (!matches.some(m => m.toLowerCase() === full.toLowerCase())) matches.push(full);
  }
  if (matches.length === 1) return { name: matches[0], ambiguous: false };
  return { name: single, ambiguous: matches.length > 1 };
}

/**
 * The bare first token each multi-token cast name may also be written as, by
 * the same rule `canonicalName` applies — only when the token folds back to
 * that name unambiguously. Lets the per-page scan count a page that writes
 * both "Malva Grimm" and "Malva" as one person, and refuses to count a bare
 * "Anna" for either of two Annas.
 *
 * @returns {Object<string, string[]>} name → alias tokens (only names with one)
 */
function firstTokenAliases(names, pool) {
  const aliases = {};
  for (const name of names) {
    const parts = String(name || '').trim().split(/\s+/);
    if (parts.length < 2) continue;
    const folded = canonicalName(parts[0], pool);
    if (!folded.ambiguous && folded.name.toLowerCase() === name.toLowerCase()) aliases[name] = [parts[0]];
  }
  return aliases;
}

/**
 * Which candidates behave like people across the whole plan.
 *
 * A candidate is dropped outright when the story's own place data names it: a
 * landmark, the town or region, or a canonical historical location/object.
 * Whole-word containment counts in BOTH directions, because the index stores a
 * hill's structures rather than the hill: "Aussichtsturm <hill>" and "Oppidum
 * <hill>" are index entries, so the bare "<hill>" a plan line actually writes
 * only matches as a token INSIDE them. Commissioned names are resolved first,
 * so a character sharing a token with a landmark stays a character; an invented
 * person who shares one does not, and the model half of the check sees the same
 * pages and can contradict the list.
 *
 * Next, the grammar of the plan itself: a name that is article- or
 * preposition-marked ("the <ship>", "of <town>") and never acts on its own is a
 * THING, whatever the story's place data knows (`isThingMarked`). It joins the
 * `places` list of the result, so every consumer — the per-page counters and
 * the arc cross-check alike — is protected, not only the check it was measured
 * on.
 *
 * What is left: a person acts: somewhere in the book the name is followed by a
 * lowercase word (a verb — "X stands", "X pulls"). A place is named and then
 * punctuated. This is the one heuristic in the module that can be wrong, so the
 * resolved list travels to the model check, which sees the same pages and can
 * contradict it.
 */
function resolveCast(pages, commissionedNames = [], placeNames = [], roster = null) {
  const commissioned = commissionedNames.map(n => String(n || '').trim()).filter(Boolean);
  const places = (Array.isArray(placeNames) ? placeNames : []).map(n => String(n || '').trim()).filter(Boolean);
  // NO ROSTER, NO CAST. The plan check's model answers who each page holds; a
  // missing or partial answer used to fall back to reading the prose in code,
  // and that fallback is what shipped every false cast finding this module has
  // ever produced. A counter that cannot know the cast does not run.
  if (!(roster instanceof Map) || roster.size === 0) return null;
  const missing = pages.map(p => Number(p.pageNumber)).filter(n => Number.isFinite(n) && !roster.has(n));
  if (missing.length > 0) return null;

  const people = [];
  const things = [];
  for (const p of pages) {
    const row = roster.get(Number(p.pageNumber));
    for (const n of (row?.people || [])) if (!people.some(x => x.toLowerCase() === n.toLowerCase())) people.push(n);
    for (const n of (row?.things || [])) if (!things.some(x => x.toLowerCase() === n.toLowerCase())) things.push(n);
  }
  // Bare first token folds into its one owner so every consumer downstream sees
  // one person ("Malva Grimm" + "Malva" — job_1788983823620_csjcyp1q9).
  const pool = [...people.filter(c => /\s/.test(c)), ...commissioned];
  const invented = [];
  const excludedPlaces = [...things];
  const ambiguousLogged = new Set();
  for (const cand of people) {
    const { name, ambiguous } = canonicalName(cand, pool);
    if (ambiguous && !ambiguousLogged.has(cand.toLowerCase())) {
      ambiguousLogged.add(cand.toLowerCase());
      console.debug(`[planCounters] "${cand}" is the first name of more than one full name in the plan — kept as its own candidate, not folded`);
    }
    if (invented.includes(name)) continue;
    if (commissioned.some(c => c.toLowerCase() === name.toLowerCase())) continue;
    // A name that CONTAINS a commissioned one is that character wearing a title
    // ("Captain <name>"), never a second person.
    if (commissioned.some(c => new RegExp(`\\b${c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(name))) continue;
    // The story's own place data still outranks the roster: a landmark the
    // planner was handed is never a figure, however the model read the line.
    if (places.some(pl => pl.toLowerCase() === name.toLowerCase() || nameRe(pl).test(name) || nameRe(name).test(pl))) {
      if (!excludedPlaces.includes(name)) excludedPlaces.push(name);
      continue;
    }
    invented.push(name);
  }
  const all = [...commissioned, ...invented];
  return { commissioned, invented, places: excludedPlaces, all, aliases: firstTokenAliases(all, pool) };
}

/**
 * Names from `cast` present in a piece of text (possessives count as present).
 * `aliases` (name → other spellings, from `resolveCast().aliases`) lets a bare
 * first name count as its full name, so both forms on one page are one person.
 */
function namesIn(text, cast, aliases = {}) {
  const clean = stripQuoted(text);
  return cast.filter((n) => {
    const forms = [n, ...(aliases[n] || [])].map(reEscape);
    return new RegExp(`\\b(?:${forms.join('|')})(?:'s|s')?\\b`, 'iu').test(clean);
  });
}

/**
 * The characters a page's who column reaches WITHOUT naming them.
 *
 * A plan line may carry the cast collectively — a count of them, a word for the
 * group, a description standing in for one figure — and the counters matched
 * literal names only, so such a page read as holding nobody. Measured on
 * staging job_1789681157795_wkt20ckod: `NO_COMMISSIONED_ON_PAGE` (a must-fix
 * code) named four pages, and two of the four were this — the whole
 * commissioned cast, in frame, referred to as a group. The re-plan answered the
 * other two by deleting the story's antagonist, which cost three CRITICAL image
 * faults.
 *
 * Recognising that language in code is forbidden here (owner: the thing-marker
 * grammar above, and the mirror-guard of 2026-08-09), so the plan check's model
 * answers it: `covers` on the ROSTER line (prompts/plan-check.txt) names, one
 * by one, who such a reference stands for.
 *
 * THE LIST IS RE-COUNTED, NEVER TRUSTED. A claim is only as good as the names
 * it writes out: a covered name counts when it resolves — through the same
 * `namesIn` the counters and the re-plan guard use, aliases included — to a
 * character this book already has. A name nothing knows is dropped, and a
 * `covers` that enumerates nobody ("the whole cast") credits nobody, so the
 * finding stands. That is the arc's invented-figure rule applied one stage
 * later (docs/decisions.md, 2026-09-09): an enumeration cannot be
 * self-certified.
 *
 * `people` keeps its meaning — the names the column CARRIES — so the cast
 * `resolveCast` derives, and every invented-figure count that rides on it, are
 * untouched by this field. It adds per-page presence and nothing else, and a
 * roster without it behaves exactly as before.
 *
 * @param {{covers?: string[]}} row the page's roster row
 * @param {{all: string[], aliases: Object}} cast the resolved cast
 * @returns {string[]} cast names the page holds without naming them
 */
function coveredNames(row, cast) {
  const declared = (row && Array.isArray(row.covers)) ? row.covers : [];
  const out = [];
  for (const claim of declared) {
    const hits = namesIn(claim, cast.all, cast.aliases);
    if (hits.length === 0) {
      console.debug(`[planCounters] roster covers "${claim}", which is nobody this book names — not counted`);
      continue;
    }
    for (const n of hits) if (!out.includes(n)) out.push(n);
  }
  return out;
}

/** Contiguous runs of 2+ page numbers in a sorted list. */
function consecutiveRuns(sorted) {
  const runs = [];
  let run = [];
  for (const n of sorted) {
    if (run.length && n !== run[run.length - 1] + 1) {
      if (run.length > 1) runs.push([...run]);
      run = [];
    }
    run.push(n);
  }
  if (run.length > 1) runs.push(run);
  return runs;
}

/**
 * Run every code-side counter over a divided plan.
 *
 * @param {Object} args
 * @param {Array}  args.pages  the divided plan, one row per page:
 *   `{pageNumber, planLine}`. There is no separate beat prose — a page IS its
 *   plan line (beat prose removed 2026-09-02) — and nothing here reads any
 *   other field off a row.
 * @param {string[]} [args.commissionedNames] the characters the book was commissioned for
 * @param {string[]} [args.placeNames] named things this story already knows can never be
 *   cast (collectPlaceNames: places, plus the calendar nouns of its language),
 *   whatever the plan grammar looks like
 * @param {number} [args.maxCharactersPerScene] the image model's ceiling for the one whole-cast page
 * @param {Map<number,{people:string[],things:string[],covers?:string[]}>} [args.roster] the plan
 *   check's per-page roster (`parsePlanCheckRoster`). Every counter that needs to know who is on a
 *   page needs this; without it the counters do not run, because the only alternative was
 *   guessing the cast out of the prose in code, which is what they were doing wrong. `covers`
 *   is the names a page reaches without naming them (`coveredNames`).
 * @returns {{findings: Array, lines: string[], stats: Object, cast: Object|null, skipped?: string}}
 */
function runPlanCounters({ pages = [], commissionedNames = [], placeNames = [], maxCharactersPerScene = 3, declaredInvented = null, inventedAllowance = null, roster = null } = {}) {
  const findings = [];
  const add = (code, pageList, detail) => findings.push({ code, pages: pageList, detail });

  const cast = resolveCast(pages, commissionedNames, placeNames, roster);
  // No cast, no counters. Silence is the honest answer when the roster is
  // missing or short a page — a fabricated cast is what produced every false
  // finding this module has ever emitted.
  if (!cast) {
    return { findings: [], lines: [], stats: { pages: pages.length }, cast: null, skipped: 'no-roster' };
  }
  const pageCount = pages.length;

  // Per-page derived facts. A plan line with fewer than four segments is
  // reported and then read as best it can be — the who column is segment 1
  // when it exists, otherwise the whole line.
  const rows = pages.map((p) => {
    const segs = planSegments(p.planLine);
    const complete = segs.length >= 4;
    const who = whoColumn(p.planLine);
    const named = namesIn(who, cast.all, cast.aliases);
    // Named outright, plus the ones the column reaches without naming them
    // (`coveredNames`). One list: who is in frame on this page.
    const covered = coveredNames(roster.get(Number(p.pageNumber)), cast).filter(n => !named.includes(n));
    const present = [...named, ...covered];
    return {
      pageNumber: p.pageNumber,
      planLine: String(p.planLine || ''),
      complete,
      segments: segs.length,
      shot: segs.length >= 1 ? classifyShot(segs[0]) : 'other',
      who,
      present,
      covered,
      commissionedPresent: present.filter(n => cast.commissioned.includes(n)),
      inventedPresent: present.filter(n => cast.invented.includes(n)),
      peopled: present.length > 0 || PERSON_WORDS.test(stripQuoted(who)),
    };
  });

  // 1. Every plan line carries instant + change.
  const incomplete = rows.filter(r => !r.complete).map(r => r.pageNumber);
  if (incomplete.length) {
    add('PLAN_LINE_INCOMPLETE', incomplete,
      'the plan line does not carry all four of shot, who, the instant, and what is true after');
  }

  // 2. Shot distribution: about two close-ups and two ultra-wides, never only
  //    two camera DISTANCES across the book, and not every page at eye level.
  //
  //    The `shot` field carries two axes since 1b53f4d0f (2026-09-19) — four
  //    words for how close the camera is, four for where it stands — and it is
  //    one-of, so a page declaring `high-angle` has spent its word and states
  //    no distance. Counting all eight together, as this block did when every
  //    value was a distance, mis-reads the new ones in BOTH directions:
  //    medium/wide/aerial would have passed SHOT_VARIETY on two distances, and
  //    an angled page reads as "not a close-up" against the 2+2 floor although
  //    it never had the chance to be one. Each counter is scoped to the axis it
  //    is actually about, off the vocabulary's own `axis` — never a second list
  //    of which words are angles.
  const shotCounts = rows.reduce((acc, r) => { acc[r.shot] = (acc[r.shot] || 0) + 1; return acc; }, {});
  const usedShots = Object.keys(shotCounts).filter(k => k !== 'other');
  const onAxis = (axis) => rows.filter(r => SHOT_AXIS[r.shot] === axis);
  const distancesUsed = usedShots.filter(k => SHOT_AXIS[k] === 'distance');
  const angledPages = onAxis('position');
  if (distancesUsed.length <= 2) {
    add('SHOT_VARIETY', [], `the book uses only ${distancesUsed.length} camera distance(s) (${distancesUsed.join(', ') || 'none recognised'}) across ${pageCount} pages`);
  }
  // Every page drawn from eye level. The vocabulary offered no other option
  // before 2026-09-19, so this is the state every stored book is in; the floor
  // is ONE page, the minimum that makes the axis exist at all, and is not a
  // taste call about how angled a book should be (owner decision pending).
  if (angledPages.length === 0) {
    add('SHOT_NO_CAMERA_POSITION', [],
      `every page of the book is shot from eye level; no page declares a camera position (${Object.keys(SHOT_AXIS).filter(k => SHOT_AXIS[k] === 'position').join(', ')})`);
  }
  if ((shotCounts['close-up'] || 0) < 2) {
    add('SHOT_CLOSEUP_COUNT', rows.filter(r => r.shot === 'close-up').map(r => r.pageNumber),
      `${shotCounts['close-up'] || 0} close-up page(s); the plan asks for about two`);
  }
  if ((shotCounts['ultra-wide'] || 0) < 2) {
    add('SHOT_ULTRAWIDE_COUNT', rows.filter(r => r.shot === 'ultra-wide').map(r => r.pageNumber),
      `${shotCounts['ultra-wide'] || 0} ultra-wide page(s); the plan asks for about two`);
  }

  // 3. Cast per page, against the CONFIGURED ceiling — never a literal.
  //    There were two counters here: CAST_OVER_3 (hardcoded 3, "needs a
  //    justification") and CAST_OVER_CEILING (the image model's
  //    maxCharactersPerScene). The 3 was written when the ceiling was 5; the
  //    ceiling is 6 since 2026-09-13 (678129944), and the scene reviewer's
  //    twin check was reframed the same day from a hardcoded "three" to the
  //    cap read as a composition recommendation. A plan counter that still
  //    asked for a justification at four people was contradicting the cap the
  //    rest of the pipeline had just been given. One counter, one number, read
  //    from config.
  const overCeiling = rows.filter(r => r.present.length > maxCharactersPerScene);
  if (overCeiling.length) {
    add('CAST_OVER_CEILING', overCeiling.map(r => r.pageNumber),
      `${overCeiling.length} page(s) put more than ${maxCharactersPerScene} named characters in frame — past what the image model can hold, and each needs a justification in its plan line`);
  }

  // 4. Solo pages and no-people pages both have to exist.
  const soloPages = rows.filter(r => r.present.length === 1).map(r => r.pageNumber);
  if (soloPages.length === 0) add('NO_SOLO_PAGE', [], 'no page puts a single character alone in frame');
  // A people-free page is BY DESIGN and stays required: the drama of one page
  // in the book is a place, weather, a vessel or an object seen from afar, and
  // the picture is stronger for having no cast in it.
  const emptyPages = rows.filter(r => !r.peopled).map(r => r.pageNumber);
  if (emptyPages.length === 0) add('NO_PEOPLELESS_PAGE', [], 'no page shows only a thing or a place, with no people in frame');
  // 4b. …but the book may not spend that page on its interpersonal drama.
  //     Measured on job_1789420511893_zly5rcdej: the planner put the mandatory
  //     people-free page on the emotional climax — the plan line said "no one
  //     at the gangway" while the story had three children shouting after a
  //     departing ship — and the page shipped with no faces. Nothing
  //     constrained WHICH page was people-free, and `NO_COMMISSIONED_ON_PAGE`
  //     below only inspects `peopled` rows, so a zero-cast page was skipped by
  //     construction. This counter is the constraint on WHICH page.
  const drama = rows.filter(r => !r.peopled && INTERACTION_DRAMA_WORDS.test(stripQuoted(r.planLine)));
  if (drama.length) {
    add('PEOPLELESS_ON_INTERACTION_PAGE', drama.map(r => r.pageNumber),
      `${drama.length} page(s) put no one in frame while the plan line stages a moment between people — a people-free page belongs on drama that is a place, weather, a vessel or an object seen from afar, never on a parting, a confrontation or a moment of feeling between characters`);
  }

  // 5. The main character carries the book: present in at least half the images.
  const mainName = cast.commissioned[0] || null;
  if (mainName) {
    const mainPages = rows.filter(r => r.present.includes(mainName)).map(r => r.pageNumber);
    if (pageCount > 0 && mainPages.length * 2 < pageCount) {
      add('MAIN_UNDER_HALF', mainPages,
        `${mainName} is in frame on ${mainPages.length}/${pageCount} pages — the main character belongs in at least half`);
    }
  }

  // 6. Invented figures never take the book over. A dominant page is one where
  //    the invented cast outnumbers the commissioned cast on that page.
  const dominant = rows
    .filter(r => r.inventedPresent.length > 0 && r.inventedPresent.length > r.commissionedPresent.length)
    .map(r => r.pageNumber);
  if (dominant.length > 1) {
    add('INVENTED_DOMINANT_EXCESS', dominant,
      `${dominant.length} pages are carried by invented characters rather than the commissioned cast — at most one may be`);
  }
  for (const run of consecutiveRuns(dominant)) {
    add('INVENTED_DOMINANT_CONSECUTIVE', run,
      'consecutive pages carried by invented characters');
  }
  // 6b. CROSS-CHECK the arc's own declared invented list against the one this
  //     module derives from the plan lines (2026-09-09). REPORTING ONLY, and
  //     deliberately not in REPLAN_MUST_FIX_CODES: a re-plan may not remove a
  //     character, so enforcement here would ask for something the stage is not
  //     allowed to do. That rule is now stated to the planner and enforced
  //     (`buildReplanSection`, `castLostByReplan`); before 2026-09-18 this
  //     comment read "architecturally forbidden" and nothing anywhere said or
  //     checked it, which is how job_1789681157795_wkt20ckod lost its
  //     antagonist off two pages. A discrepancy means the arc under-declared —
  //     which is exactly how job_1788903616404_iqvhj4l8m shipped four invented
  //     figures on an allowance of two — and it must at least be visible.
  if (Array.isArray(declaredInvented)) {
    const declared = declaredInvented.map(n => String(n || '').trim()).filter(Boolean);
    const lower = new Set(declared.map(n => n.toLowerCase()));
    // No thing-guard needed here any more: `cast.invented` holds only names the
    // plan check's roster reported as PEOPLE, so a ship or a town never reaches
    // this list (2026-09-11, replacing the article/preposition marking).
    const undeclared = cast.invented.filter(n => !lower.has(String(n).toLowerCase()));
    if (undeclared.length) {
      add('ARC_INVENTED_UNDECLARED', [],
        `the plan names invented ${undeclared.length === 1 ? 'figure' : 'figures'} ${undeclared.join(', ')} that the arc's own invented list does not carry (arc declared: ${declared.length ? declared.join(', ') : 'none'})`);
    }
    // THE ALLOWANCE IS CHECKED AGAINST WHAT THE BOOK HAS, NOT AGAINST WHAT THE
    // ARC ADMITTED TO (2026-09-19).
    //
    // This compared `declared.length` alone, so an arc that under-declared got
    // its allowance checked against its own understatement and always passed —
    // the two findings sat side by side and neither said the book was over.
    // `job_1788903616404_iqvhj4l8m` (named in the comment above) shipped four
    // invented figures on an allowance of two exactly this way. On
    // `job_1789759147125_p08djwhbl` the arc declared NONE while its story turns
    // on an invented raven — the antagonist that takes the bedding, blocks the
    // warm window and trades the cap at the low point — plus a baker.
    //
    // The effective count is the union: what the arc declared, plus what the
    // plan names and the arc did not. `cast.invented` holds only names the plan
    // check's roster reported as PEOPLE, so a ship or a town cannot inflate it.
    const effective = [...declared, ...undeclared];
    if (inventedAllowance != null && effective.length > inventedAllowance) {
      const shortfall = undeclared.length
        ? ` — ${declared.length} declared (${declared.join(', ') || 'none'}) plus ${undeclared.length} the arc did not name (${undeclared.join(', ')})`
        : '';
      add('ARC_INVENTED_OVER_ALLOWANCE', [],
        `the book carries ${effective.length} invented figures (${effective.join(', ')}) against an allowance of ${inventedAllowance}${shortfall}`);
    }
  }

  // PEOPLED pages only, by design: a page with nobody in frame is a legitimate
  // picture (see NO_PEOPLELESS_PAGE), so it cannot owe the book a commissioned
  // character. Whether it is the RIGHT page to leave empty is
  // `PEOPLELESS_ON_INTERACTION_PAGE`'s question, not this one's.
  // A page that carries the cast collectively is NOT one of these: `present`
  // holds the names the roster says the column reaches (`coveredNames`), so the
  // whole commissioned cast in frame under one phrase reads as present, not
  // absent.
  const noCommissioned = rows.filter(r => r.peopled && r.commissionedPresent.length === 0).map(r => r.pageNumber);
  if (noCommissioned.length) {
    add('NO_COMMISSIONED_ON_PAGE', noCommissioned,
      'a peopled page with none of the commissioned characters in frame');
  }

  // 7. Every commissioned character earns at least one focal page: in frame
  //    with at most one companion, or named first in a close-up. Solo is not
  //    required (owner, 2026-09-04) — two people sharing one action carry a
  //    focal page; the visible-action requirement lives in the prompt.
  const focalOf = (name) => rows
    .filter(r => (r.present.length <= 2 && r.present.includes(name))
      || (r.shot === 'close-up' && r.present[0] === name))
    .map(r => r.pageNumber);
  const focal = {};
  for (const name of cast.commissioned) {
    focal[name] = focalOf(name);
    if (focal[name].length === 0) {
      add('NO_FOCAL_PAGE', [], `${name} never has a focal page — never in frame with at most one companion, never the subject of a close-up`);
    }
  }

  // 8. Coverage floor: a commissioned character is in frame on at least two
  //    pages. Separate property from the focal page above — a character can own
  //    one close-up and still be absent from the rest of the book.
  const coverage = {};
  for (const name of cast.commissioned) {
    coverage[name] = rows.filter(r => r.present.includes(name)).map(r => r.pageNumber);
    if (coverage[name].length < 2) {
      add('UNDER_COVERED_CHARACTER', coverage[name],
        `${name} is in frame on ${coverage[name].length} page(s) — every commissioned character belongs in at least two`);
    }
  }

  // 9. Consecutive pages differ: never the same shot AND the same number of
  //    named characters twice in a row. Pairs whose shot did not classify, or
  //    whose plan line is incomplete, are skipped rather than compared.
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1];
    const cur = rows[i];
    if (!prev.complete || !cur.complete) continue;
    if (prev.shot === 'other' || cur.shot === 'other') continue;
    if (prev.shot !== cur.shot || prev.present.length !== cur.present.length) continue;
    add('CONSECUTIVE_SAME_SHOT_CAST', [prev.pageNumber, cur.pageNumber],
      `both pages are a ${prev.shot} shot with ${prev.present.length} named character(s) in frame`);
  }

  const lines = findings.map(f =>
    `PLAN[${f.code}]${f.pages && f.pages.length ? ` page ${f.pages.join(', ')}` : ''}: ${f.detail}`);

  return {
    findings,
    lines,
    cast,
    stats: {
      pageCount,
      shotCounts,
      shotTypesUsed: usedShots,
      distancesUsed,
      angledPages: angledPages.map(r => r.pageNumber),
      soloPages,
      peoplelessPages: emptyPages,
      // `covered` rides along only when the roster declared one, so a stored
      // report says whether the check's model used the field at all.
      castPerPage: rows.map(r => ({ pageNumber: r.pageNumber, names: r.present, ...(r.covered.length ? { covered: r.covered } : {}) })),
      inventedDominantPages: dominant,
      focalPages: focal,
      coveragePages: coverage,
    },
  };
}

/** The who-in-frame column of a plan line; the whole line when it has no segments. */
function whoColumn(planLine) {
  const segs = planSegments(planLine);
  return segs.length >= 2 ? segs[1] : String(planLine || '');
}

/**
 * Pages whose RE-PLAN dropped a character the standing division had in frame
 * AND DID NOT SAY SO.
 *
 * A removal is legitimate work — an over-crowded page is answered by taking a
 * name out, and the division that stands is itself a model output that round
 * one may have got wrong (owner, 2026-09-18: "we can not say delete only or add
 * only; we must give a fair review and allow both fix types"). What is never
 * legitimate is a SILENT removal. The re-plan declares each structural change
 * it made under `---CHANGES---`; `reviewPlanChanges` judges the declared ones;
 * this function finds the ones nobody declared. Until 2026-09-18 the only way
 * anyone found such a removal was diffing two who-columns after the book was
 * finished.
 *
 * Once the plan line stops naming a figure, the Art Director has no authority
 * to stage them and the scene review's `[cast_not_in_plan]` check strips them
 * from the brief by the book — so an undeclared loss is unreviewable damage,
 * and the page is restored from the division that stands.
 *
 * Measured on staging job_1789681157795_wkt20ckod ("Das Ei im Lindenhof"): the
 * arc's fourth declared challenge is "Tobias sits on the stone in the dark
 * while Zünsli goes cold". `NO_COMMISSIONED_ON_PAGE` named pages 8, 12, 16 and
 * 18; the re-plan answered pages 8 and 12 by ADDING the commissioned children
 * and answered 16 and 18 by DELETING Tobias. His who-column pages went
 * [8,9,16,18] → [8,9]; the briefs for 16 and 17 were then stripped
 * (`castRemovals`: "not named by PAGE PLAN line"), and the book audit returned
 * three CRITICAL and one MAJOR IMG faults for an antagonist the page text
 * describes and no picture shows.
 *
 * A MOVE IS NOT A DELETION. A re-plan may shift a beat between two pages a
 * finding named, and page N then loses a name page M gains. Restoring N would
 * put the beat on both pages, so a name gained on any other changed page in
 * the same round is not counted as lost anywhere.
 *
 * Pure set arithmetic over a declared cast list — no prose is read, no name is
 * inferred from the line's grammar.
 *
 * THE CAST LIST IS THE ROSTER'S, INCLUDING ITS MISTAKES, and that is a measured
 * choice rather than an oversight. The plan check's roster still reads a ship,
 * a bridge or a summit as a person often enough to matter — `Gemüsebrücke`,
 * `Zwirbelspitz`, `Silberkrabbe`, `Donnermöwe`, `La Nivéole` over the stored
 * staging corpus — and three candidate filters were tried against it and all
 * three failed: the arc's own declared invented list goes STALE when a retell
 * renames its figures (on the motivating story the arc declared `Fünkli,
 * Silvan` for figures the committed arc calls `Zünsli, Tobias`, and
 * `arcInventedNames` was null there in any case); the roster's own
 * people-vs-things split never contradicts itself (0 overlaps across 9 stories
 * checked); and `placeNames` only knows the landmarks the planner was handed.
 * Over 613 changed pages on staging the unfiltered rule restores 23 (3.8%) —
 * 17 of them a real figure and 6 a mislabelled vessel or place — so the price
 * of the roster's mistakes is declining a re-plan's repair on 1.0% of changed
 * pages, and a page restored from the STANDING division is never corrupt: it
 * is the line the planner itself wrote and the plan check already measured.
 * The finding that named the page simply survives to the recheck, which is
 * what `beats_replan_unfixed` reports. Against that, an unguarded round
 * deletes a book's antagonist.
 *
 * @param {Array<{pageNumber:number, planLine:string}>} standing the division that stands
 * @param {Array<{pageNumber:number, planLine:string}>} returned the merged re-plan result
 * @param {string[]} castNames the resolved cast (`resolveCast().all`; the commissioned
 *   names alone when the roster failed and there is no resolved cast)
 * @param {Object} [aliases] name → other spellings (`resolveCast().aliases`)
 * @param {Map<number,string[]>|Object} [declaredOut] page → the names the re-plan
 *   DECLARED it took out of that page's frame. A declared removal is not this
 *   function's business — `reviewPlanChanges` judges it. Omitted (or empty) means
 *   nothing was declared, which is a re-plan that returned no `---CHANGES---`
 *   block at all: every loss is then undeclared, which is the behaviour this
 *   function had before declarations existed.
 * @returns {Array<{pageNumber:number, lost:string[]}>} one row per page to restore, page order
 */
function castLostByReplan(standing, returned, castNames = [], aliases = {}, declaredOut = null) {
  const names = (Array.isArray(castNames) ? castNames : []).map(n => String(n || '').trim()).filter(Boolean);
  if (!names.length) return [];
  const before = new Map();
  for (const p of (standing || [])) before.set(Number(p.pageNumber), String(p.planLine || ''));
  const changed = (returned || []).filter((p) => {
    const b = before.get(Number(p.pageNumber));
    return b !== undefined && b !== String(p.planLine || '');
  });
  if (!changed.length) return [];

  const declaredFor = (pageNumber) => {
    if (!declaredOut) return [];
    const v = declaredOut instanceof Map ? declaredOut.get(Number(pageNumber)) : declaredOut[pageNumber];
    return Array.isArray(v) ? v.map(n => String(n || '').trim()).filter(Boolean) : [];
  };

  const lostOn = new Map();
  const gained = new Set();
  for (const p of changed) {
    const nb = namesIn(whoColumn(before.get(Number(p.pageNumber))), names, aliases);
    const na = namesIn(whoColumn(p.planLine), names, aliases);
    // A name the round SAID it took out of this page is reviewed elsewhere; it
    // is not a silent loss and this function must not report it twice.
    const declared = new Set(declaredFor(p.pageNumber));
    const lost = nb.filter(n => !na.includes(n) && !declared.has(n));
    if (lost.length) lostOn.set(Number(p.pageNumber), lost);
    for (const n of na) if (!nb.includes(n)) gained.add(n);
  }
  const out = [];
  for (const [pageNumber, lost] of lostOn) {
    const deleted = lost.filter(n => !gained.has(n));
    if (deleted.length) out.push({ pageNumber, lost: deleted });
  }
  return out.sort((a, b) => a.pageNumber - b.pageNumber);
}

/**
 * HOW A FINDING MOVES A PAGE'S CAST — the vocabulary's own property.
 *
 * 'more' means answering this finding puts a name in frame; 'fewer' means
 * answering it takes one out; a finding absent from the map moves the cast
 * neither way and constrains nothing.
 *
 * This is a table over finding TAGS — a counter's `code`, a plan-check
 * question's number — and never a reading of a finding's sentence. It exists so
 * an addition and a removal are judged by the SAME rule: before 2026-09-18 the
 * re-plan was told a removal is never a fix, which left `CAST_OVER_CEILING` and
 * plan-check Q3 — the two findings a removal is the natural answer to — with no
 * answer available at all, and an over-crowded page could only get more crowded.
 *
 * Deliberately absent: `NO_FOCAL_PAGE` (a focal page is at most two in frame OR
 * a close-up, so either direction can answer it), `CONSECUTIVE_SAME_SHOT_CAST`
 * (satisfied by changing the shot, adding or removing), `ARC_INVENTED_OVER_ALLOWANCE`
 * (a finding against the ARC, which names no page and no division edit repairs)
 * and plan-check Q2 (an entrance is a staging question, not a headcount). An
 * unlisted finding leaves the change unreviewed by direction — the span,
 * obstacle and declaration rules still apply.
 */
const REPLAN_FINDING_DIRECTION = new Map([
  ['NO_COMMISSIONED_ON_PAGE', 'more'],
  ['PEOPLELESS_ON_INTERACTION_PAGE', 'more'],
  ['UNDER_COVERED_CHARACTER', 'more'],
  ['MAIN_UNDER_HALF', 'more'],
  // The invented-dominance pair asks for MORE, not fewer — measured, not
  // assumed. Both counters fire where the invented cast outnumbers the
  // commissioned cast on a page, and the ratio moves either way; ranking them
  // 'fewer' let the replay of staging job_1789681157795_wkt20ckod delete the
  // arc's antagonist off two pages a second time, answering
  // INVENTED_DOMINANT_EXCESS instead of NO_COMMISSIONED_ON_PAGE. The arc is
  // settled by the time it is divided, so the figure it gave the page stays and
  // the commissioned cast is what comes in. A page genuinely at the ceiling can
  // still remove to make room — that carve-out is the ceiling check, not this
  // table.
  ['INVENTED_DOMINANT_EXCESS', 'more'],
  ['INVENTED_DOMINANT_CONSECUTIVE', 'more'],
  ['CAST_OVER_CEILING', 'fewer'],
  ['NO_SOLO_PAGE', 'fewer'],
  ['NO_PEOPLELESS_PAGE', 'fewer'],
  // Plan-check questions, by number (prompts/plan-check.txt).
  ['CHECK:1', 'fewer'],   // an emotional highlight page holding a second actor
  ['CHECK:3', 'fewer'],   // three or more named characters in frame
  ['CHECK:11', 'more'],   // the page's obstacle-holder is not named
]);

/** The direction of the finding a change declares it answers; null when unknown. */
function replanChangeDirection(tag) {
  if (!tag) return null;
  if (tag.code) return REPLAN_FINDING_DIRECTION.get(String(tag.code).toUpperCase()) || null;
  if (tag.check != null) return REPLAN_FINDING_DIRECTION.get(`CHECK:${Number(tag.check)}`) || null;
  return null;
}

/**
 * REVIEW a re-plan's DECLARED structural changes — the middle third of
 * declare → review → apply (owner design, 2026-09-18).
 *
 * A removal is judged, not banned and not waved through. Every input here is a
 * DECLARED field: the change's own kind and the finding tag it answers, the
 * plan check's ROSTER-derived cast, the plan check's OBSTACLES block, the image
 * model's cast ceiling, and the who-columns of two divisions. No sentence is
 * pattern-matched; recognising a character or a justification in prose is
 * language and belongs to the prompts.
 *
 * Four rules refuse a change. Each names a page; the caller restores exactly
 * those pages from the division that stands, and the finding that named the
 * page survives to the recheck — the same, cheap failure mode the merge has
 * always had. Nothing here discards a round.
 *
 *   obstacle  a `cast out` of the figure the preceding check declared as that
 *             page's obstacle-holder (plan-check Q11). A figure whose action
 *             the page's instant works against is the page; dropping them
 *             leaves a picture of nothing happening to nobody.
 *   span      a `cast out` that leaves the figure in frame on fewer than two
 *             pages of the returned division while the standing one gave them
 *             two or more. Two pages is the floor `UNDER_COVERED_CHARACTER`
 *             already holds the commissioned cast to; three stories lost an
 *             invented figure from every page (Pfiff, Silberkrabbe, Krümel).
 *   direction a `cast out` answering a finding that asks for MORE in frame,
 *             on a page the standing division left under the cast ceiling —
 *             and its mirror, a `cast in` answering a finding that asks for
 *             fewer. Under the ceiling there is room to add, so a removal is
 *             not what that finding asked for; at or over it, taking a name
 *             out to make room is exactly right and is allowed.
 *   balance   a page that takes another page's material where the freed page
 *             declares no `material to page <N>` saying what it stages
 *             instead, or the reverse. The book keeps its page count, so a
 *             merge and a split are one move and both halves name each other's
 *             page. `action in` — "this page now also stages X" — is the
 *             common case, has its own verb, and is not judged here.
 *
 * @param {Object} args
 * @param {Array} args.changes   `parsePlanChanges().changes`
 * @param {Array} args.standing  the division that stands
 * @param {Array} args.returned  the merged re-plan result
 * @param {string[]} args.castNames `resolveCast().all`
 * @param {Object} [args.aliases]   `resolveCast().aliases`
 * @param {number} [args.maxCast]   the image model's cast ceiling
 * @param {Map<number,string[]>} [args.obstacles] page → obstacle-holders, from the
 *   plan check that produced these findings
 * @returns {{refusals: Array<{pageNumber:number, rule:string, detail:string, line:string}>,
 *            declaredOut: Map<number,string[]>, notes: string[]}}
 */
function reviewPlanChanges({ changes = [], standing = [], returned = [], castNames = [], aliases = {}, maxCast = 3, obstacles = null } = {}) {
  const names = (Array.isArray(castNames) ? castNames : []).map(n => String(n || '').trim()).filter(Boolean);
  const refusals = [];
  const notes = [];
  const declaredOut = new Map();
  const list = Array.isArray(changes) ? changes : [];
  if (!list.length) return { refusals, declaredOut, notes };

  const whoOf = (pages) => {
    const m = new Map();
    for (const p of (pages || [])) m.set(Number(p.pageNumber), namesIn(whoColumn(p.planLine), names, aliases));
    return m;
  };
  const beforeWho = whoOf(standing);
  const afterWho = whoOf(returned);
  const spanIn = (who) => {
    const c = new Map();
    for (const list2 of who.values()) for (const n of list2) c.set(n, (c.get(n) || 0) + 1);
    return c;
  };
  const beforeSpan = spanIn(beforeWho);
  const afterSpan = spanIn(afterWho);
  const refuse = (pageNumber, rule, detail, line) => {
    if (!Number.isFinite(pageNumber)) return;
    refusals.push({ pageNumber: Number(pageNumber), rule, detail, line: String(line || '') });
  };
  // The declared subject is resolved against the DECLARED cast list, never read
  // as prose: a subject naming nobody on that list resolves to nothing, the
  // removal stays undeclared, and `castLostByReplan` restores the page.
  const resolve = (subject) => namesIn(String(subject || ''), names, aliases);

  for (const c of list) {
    const page = Number(c.pageNumber);
    const dir = replanChangeDirection(c.answers);
    if (!c.answers) notes.push(`p${page}: "${String(c.line || '').slice(0, 120)}" names no finding tag`);

    if (c.kind === 'cast_out') {
      const hit = resolve(c.subject);
      if (!hit.length) {
        notes.push(`p${page}: declared "cast out ${c.subject}" names nobody on the cast list`);
        continue;
      }
      declaredOut.set(page, [...(declaredOut.get(page) || []), ...hit]);
      const held = obstacles instanceof Map ? (obstacles.get(page) || []) : [];
      const heldNames = held.length ? namesIn(held.join(', '), names, aliases) : [];
      const onObstacle = hit.filter(n => heldNames.includes(n));
      if (onObstacle.length) {
        refuse(page, 'obstacle', `${onObstacle.join(', ')} holds this page's obstacle (the check's own OBSTACLES line)`, c.line);
        continue;
      }
      const stranded = hit.filter(n => (beforeSpan.get(n) || 0) >= 2 && (afterSpan.get(n) || 0) < 2);
      if (stranded.length) {
        refuse(page, 'span', `${stranded.map(n => `${n} ${beforeSpan.get(n) || 0}→${afterSpan.get(n) || 0} page(s)`).join(', ')} — two pages is the floor`, c.line);
        continue;
      }
      if (dir === 'more' && (beforeWho.get(page) || []).length < Number(maxCast)) {
        refuse(page, 'direction', `${c.answersText || 'the finding'} asks for a name in frame and this page held ${(beforeWho.get(page) || []).length} of ${maxCast}, so there was room to add`, c.line);
        continue;
      }
    } else if (c.kind === 'cast_in') {
      if (dir === 'fewer') {
        refuse(page, 'direction', `${c.answersText || 'the finding'} asks for fewer in frame and this change adds one`, c.line);
      }
    }
  }

  // BALANCE: the book keeps its page count, so a merge frees exactly one number
  // and BOTH halves of the move are declared, each naming the other's page.
  //
  // `action in` — "this page now also stages X" — is deliberately NOT a half of
  // a merge and carries no obligation here. Until 2026-09-18 one verb, `new
  // material`, meant both things, and this rule refused every use of it in the
  // common sense: a widened shot answering CONSECUTIVE_SAME_SHOT_CAST (Lab
  // 1327 p14) and a figure frozen behind the push answering CHECK[3] (Lab 1326
  // p12) were both read as an unbalanced half of a page merge. Two verbs, so
  // the strictness lands only where the page count is actually at stake.
  const takes = list.filter(c => c.kind === 'material_from' && Number.isFinite(c.fromPage));
  const gives = list.filter(c => c.kind === 'material_to' && Number.isFinite(c.toPage));
  const givenBy = (freedPage, takerPage) => gives
    .some(g => Number(g.pageNumber) === freedPage && Number(g.toPage) === takerPage);
  const takenBy = (takerPage, freedPage) => takes
    .some(t => Number(t.pageNumber) === takerPage && Number(t.fromPage) === freedPage);
  for (const c of takes) {
    if (!givenBy(Number(c.fromPage), Number(c.pageNumber))) {
      refuse(c.pageNumber, 'balance', `page ${c.fromPage}'s material moves here and page ${c.fromPage} declares no "material to page ${c.pageNumber}" saying what it stages instead`, c.line);
      refuse(c.fromPage, 'balance', `its material moved to page ${c.pageNumber} and nothing was declared in its place`, c.line);
    }
  }
  for (const c of gives) {
    if (!takenBy(Number(c.toPage), Number(c.pageNumber))) {
      refuse(c.pageNumber, 'balance', `its material goes to page ${c.toPage} and page ${c.toPage} declares no "material from page ${c.pageNumber}"`, c.line);
    }
  }
  return { refusals, declaredOut, notes };
}


module.exports = {
  runPlanCounters,
  collectPlaceNames,
  collectCalendarNames,
  calendarNamesForLocale,
  planSegments,
  classifyShot,
  nameCandidates,
  resolveCast,
  canonicalName,
  namesIn,
  coveredNames,
  stripQuoted,
  whoColumn,
  castLostByReplan,
  reviewPlanChanges,
  replanChangeDirection,
  REPLAN_FINDING_DIRECTION,
};
