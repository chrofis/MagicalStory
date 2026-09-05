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
  'toward', 'towards', 'beside', 'behind', 'inside', 'outside', 'along', 'past',
]);

/** Person words that make a page peopled even with no name in frame. */
const PERSON_WORDS = /\b(?:crew|crewman|crewmen|sailor|sailors|man|men|woman|women|boy|boys|girl|girls|child|children|figure|figures|crowd|onlookers|guard|guards|villagers?|people)\b/i;

/** Strip «…» / "…" quoted proper nouns — vessels and titles, never cast. */
function stripQuoted(text) {
  return String(text || '').replace(/«[^»]*»/g, ' ').replace(/"[^"]*"/g, ' ').replace(/'[^']*'/g, ' ');
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
  const re = /(\S+\s+)?\b([A-ZÄÖÜ][a-zäöüßéèàâç]+(?:\s+[A-ZÄÖÜ][a-zäöüßéèàâç]+)*)\b/g;
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
 * The named PLACES this story already knows about, from the authoritative data
 * the job carries into the beats stage — never a word list and never a guess.
 *
 * Three sources, all resolved before `generateStoryViaBeats` runs and all the
 * same names the planner was handed in its own prompt:
 *   - `inputData.availableLandmarks[].name` — the landmark index entries
 *     resolved for the family's town (storyJobPipeline, before the beats call).
 *   - `inputData.userLocation.city` / `.country` — the town itself.
 *   - `extraNames` — the caller's canonical named things for this story
 *     (historical locations and period objects, which are places and props by
 *     definition and are looked up by name the same way).
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
  ].map(n => String(n || '').trim()).filter(Boolean);
  return [...new Set(names)];
}

/** Whole-word regex for a literal name. */
function nameRe(name, flags = 'iu') {
  return new RegExp(`\\b${String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, flags);
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
 * What is left: a person acts: somewhere in the book the name is followed by a
 * lowercase word (a verb — "X stands", "X pulls"). A place is named and then
 * punctuated. This is the one heuristic in the module that can be wrong, so the
 * resolved list travels to the model check, which sees the same pages and can
 * contradict it.
 */
function resolveCast(pages, commissionedNames = [], placeNames = []) {
  const commissioned = commissionedNames.map(n => String(n || '').trim()).filter(Boolean);
  const places = (Array.isArray(placeNames) ? placeNames : []).map(n => String(n || '').trim()).filter(Boolean);
  // PLAN LINES ONLY — never the beats. The plan is written in English by
  // contract (prompts/story-beats.txt: "Plan in ENGLISH"), while the beats are
  // free to carry the book's language. German capitalises every noun, so
  // scanning beats turned "Deck", "Karte" and "Truhe" into cast members and
  // every cast count with them. The plan line is also the only place the cast
  // of a PAGE is stated, which is what every counter here actually needs.
  const corpus = pages.map(p => String(p.planLine || '')).join('\n');
  const clean = stripQuoted(corpus);
  const invented = [];
  const excludedPlaces = [];
  for (const cand of nameCandidates(corpus)) {
    if (commissioned.some(c => c.toLowerCase() === cand.toLowerCase())) continue;
    // A candidate that CONTAINS a commissioned name is that character wearing a
    // title ("Captain <name>"), never a second person.
    if (commissioned.some(c => new RegExp(`\\b${c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(cand))) continue;
    // The story's own place data outranks the acts-like-a-person heuristic.
    if (places.some(pl => pl.toLowerCase() === cand.toLowerCase() || nameRe(pl).test(cand) || nameRe(cand).test(pl))) {
      if (!excludedPlaces.includes(cand)) excludedPlaces.push(cand);
      continue;
    }
    const acts = new RegExp(`\\b${cand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:'s|s')?\\s+[a-zäöüß]`, 'u').test(clean);
    if (acts && !invented.includes(cand)) invented.push(cand);
  }
  return { commissioned, invented, places: excludedPlaces, all: [...commissioned, ...invented] };
}

/** Names from `cast` present in a piece of text (possessives count as present). */
function namesIn(text, cast) {
  const clean = stripQuoted(text);
  return cast.filter(n => new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:'s|s')?\\b`, 'iu').test(clean));
}

/**
 * How many pages of a book may stage a high-action instant — two characters
 * interlocked, a hand-over, an object in flight, a second figure off the
 * ground, two creatures each with its own state (owner ruling, 2026-09-05:
 * "relax it so that 2-3 pages per story can have more action").
 *
 * The number is mechanical, so it is computed here and injected into the
 * planner prompt ({HIGH_ACTION_PAGES}) rather than written into prose.
 *
 * NOTE FOR THE COUNTERS: no counter in this module penalises the allowance.
 * Nothing here counts elevated figures, interlocked pairs or creatures; the
 * only per-page cast counters (CAST_OVER_3, CAST_OVER_CEILING) count NAMES in
 * the who-column, and a high-action instant adds no name to a page. The budget
 * is therefore carried through to `stats.highActionAllowance` for the report
 * and never used to suppress a finding — there is none to suppress.
 *
 * @param {number} pageCount
 * @returns {number} 1 for a short book, 2 for a normal one, 3 for a long one
 */
function highActionPageBudget(pageCount) {
  const n = parseInt(pageCount, 10);
  if (!Number.isFinite(n) || n <= 8) return 1;
  return n <= 16 ? 2 : 3;
}

/** The budget as the planner prompt says it: "one page" / "two pages". */
function highActionPagesPhrase(pageCount) {
  const n = highActionPageBudget(pageCount);
  return n === 1 ? 'one page' : n === 2 ? 'two pages' : 'three pages';
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
 * @param {Array}  args.pages  [{pageNumber, beat, planLine}]
 * @param {string[]} [args.commissionedNames] the characters the book was commissioned for
 * @param {string[]} [args.placeNames] named places/things this story already knows about
 *   (collectPlaceNames): they can never be cast, whatever the plan grammar looks like
 * @param {number} [args.maxCharactersPerScene] the image model's ceiling for the one whole-cast page
 * @param {number} [args.highActionPages] the high-action page budget the planner was given
 * @returns {{findings: Array, lines: string[], stats: Object, cast: Object}}
 */
function runPlanCounters({ pages = [], commissionedNames = [], placeNames = [], maxCharactersPerScene = 3, highActionPages = null } = {}) {
  const findings = [];
  const add = (code, pageList, detail) => findings.push({ code, pages: pageList, detail });

  const cast = resolveCast(pages, commissionedNames, placeNames);
  const pageCount = pages.length;

  // Per-page derived facts. A plan line with fewer than four segments is
  // reported and then read as best it can be — the who column is segment 1
  // when it exists, otherwise the whole line.
  const rows = pages.map((p) => {
    const segs = planSegments(p.planLine);
    const complete = segs.length >= 4;
    const who = segs.length >= 2 ? segs[1] : String(p.planLine || '');
    const present = namesIn(who, cast.all);
    return {
      pageNumber: p.pageNumber,
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

  // 3. Cast per page. Over three is reported for the model to test the plan
  //    line's justification against; over the image model's ceiling is a
  //    finding on its own, justification or not.
  const overThree = rows.filter(r => r.present.length > 3);
  if (overThree.length) {
    add('CAST_OVER_3', overThree.map(r => r.pageNumber),
      `${overThree.length} page(s) put more than three named characters in frame — each needs a justification in its plan line`);
  }
  const overCeiling = rows.filter(r => r.present.length > maxCharactersPerScene);
  if (overCeiling.length) {
    add('CAST_OVER_CEILING', overCeiling.map(r => r.pageNumber),
      `more than ${maxCharactersPerScene} named characters in frame — past what the image model can hold`);
  }

  // 4. Solo pages and no-people pages both have to exist.
  const soloPages = rows.filter(r => r.present.length === 1).map(r => r.pageNumber);
  if (soloPages.length === 0) add('NO_SOLO_PAGE', [], 'no page puts a single character alone in frame');
  const emptyPages = rows.filter(r => !r.peopled).map(r => r.pageNumber);
  if (emptyPages.length === 0) add('NO_PEOPLELESS_PAGE', [], 'no page shows only a thing or a place, with no people in frame');

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
      highActionAllowance: highActionPages == null ? highActionPageBudget(pages.length) : highActionPages,
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
  highActionPageBudget,
  highActionPagesPhrase,
  collectPlaceNames,
  planSegments,
  classifyShot,
  nameCandidates,
  resolveCast,
  namesIn,
};
