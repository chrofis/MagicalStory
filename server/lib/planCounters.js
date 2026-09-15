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
 * Shot vocabulary, longest-first: "ultra-wide" contains "wide", and "close-up"
 * must win over a bare "close". Anything unrecognised counts as 'other' and is
 * reported rather than silently folded into medium.
 */
const SHOT_PATTERNS = [
  ['ultra-wide', /\b(?:ultra[-\s]?wide|extreme[-\s]?wide|establishing[-\s]?wide)\b/i],
  ['close-up', /\b(?:extreme[-\s]?close[-\s]?up|close[-\s]?up|closeup|portrait)\b/i],
  ['wide', /\bwide\b/i],
  ['medium', /\b(?:medium|mid)\b/i],
];

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
 * @param {Map<number,{people:string[],things:string[]}>} [args.roster] the plan check's
 *   per-page roster (`parsePlanCheckRoster`). Every counter that needs to know who is on a
 *   page needs this; without it the counters do not run, because the only alternative was
 *   guessing the cast out of the prose in code, which is what they were doing wrong.
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
    const who = segs.length >= 2 ? segs[1] : String(p.planLine || '');
    const present = namesIn(who, cast.all, cast.aliases);
    return {
      pageNumber: p.pageNumber,
      planLine: String(p.planLine || ''),
      complete,
      segments: segs.length,
      shot: segs.length >= 1 ? classifyShot(segs[0]) : 'other',
      who,
      present,
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

  // 2. Shot distribution: about two close-ups and two ultra-wides, and never
  //    only two shot types across the book.
  const shotCounts = rows.reduce((acc, r) => { acc[r.shot] = (acc[r.shot] || 0) + 1; return acc; }, {});
  const usedShots = Object.keys(shotCounts).filter(k => k !== 'other');
  if (usedShots.length <= 2) {
    add('SHOT_VARIETY', [], `the book uses only ${usedShots.length} shot type(s) (${usedShots.join(', ') || 'none recognised'}) across ${pageCount} pages`);
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
  //     deliberately not in REPLAN_MUST_FIX_CODES: a re-plan is architecturally
  //     forbidden from removing a character (prompts/story-beats.txt tells the
  //     stage the arc is finished), so enforcement here would ask for something
  //     the stage cannot do. A discrepancy means the arc under-declared — which
  //     is exactly how job_1788903616404_iqvhj4l8m shipped four invented
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
    if (inventedAllowance != null && declared.length > inventedAllowance) {
      add('ARC_INVENTED_OVER_ALLOWANCE', [],
        `the arc declares ${declared.length} invented figures (${declared.join(', ')}) against an allowance of ${inventedAllowance}`);
    }
  }

  // PEOPLED pages only, by design: a page with nobody in frame is a legitimate
  // picture (see NO_PEOPLELESS_PAGE), so it cannot owe the book a commissioned
  // character. Whether it is the RIGHT page to leave empty is
  // `PEOPLELESS_ON_INTERACTION_PAGE`'s question, not this one's.
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
      soloPages,
      peoplelessPages: emptyPages,
      castPerPage: rows.map(r => ({ pageNumber: r.pageNumber, names: r.present })),
      inventedDominantPages: dominant,
      focalPages: focal,
      coveragePages: coverage,
    },
  };
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
  stripQuoted,
};
