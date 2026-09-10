import { describe, it, expect } from 'vitest';

// @ts-ignore — CommonJS lib
import planCounters from '../../server/lib/planCounters.js';
const { runPlanCounters, classifyShot, planSegments, resolveCast, collectPlaceNames, thingMarkedNames, stripQuoted, namesIn, canonicalName, nameCandidates } = planCounters as any;

/** A well-formed plan line: shot — who — instant — change. */
const line = (shot: string, who: string, instant = 'something happens', change = 'something is now true') =>
  `${shot} — ${who} — ${instant} — ${change}`;

const page = (n: number, planLine: string, beat = 'a beat') => ({ pageNumber: n, planLine, beat });

const CAST = ['Ana', 'Ben', 'Cara'];

describe('planSegments / classifyShot', () => {
  it('splits on em-dash and reports incompleteness by segment count', () => {
    expect(planSegments(line('wide', 'Ana'))).toHaveLength(4);
    expect(planSegments('wide — Ana')).toHaveLength(2);
  });

  it('prefers ultra-wide over wide and close-up over close', () => {
    expect(classifyShot('ultra-wide')).toBe('ultra-wide');
    expect(classifyShot('wide')).toBe('wide');
    expect(classifyShot('close-up')).toBe('close-up');
    expect(classifyShot('medium')).toBe('medium');
    expect(classifyShot('worm-eye')).toBe('other');
  });
});

describe('resolveCast', () => {
  it('reads names from plan lines only, so a non-English beat cannot invent cast', () => {
    const pages = [
      { pageNumber: 1, planLine: line('wide', 'Ana and Rook'), beat: 'Die Karte liegt auf dem Kartentisch.' },
    ];
    const cast = resolveCast(pages, CAST);
    // German nouns in the beat are capitalised; none may become characters.
    expect(cast.invented).not.toContain('Karte');
    expect(cast.invented).not.toContain('Kartentisch');
  });

  it('treats a titled commissioned name as that character, not a second one', () => {
    const pages = [{ pageNumber: 1, planLine: line('wide', 'Captain Ana stands at the rail'), beat: '' }];
    expect(resolveCast(pages, CAST).invented).toHaveLength(0);
  });
});

describe('place names are never cast (story job_1788614817116_vxnu60yjg)', () => {
  // The Zurich landmark_index entries this job resolved, plus its town. The
  // index stores the hill's structures, not the hill, so the bare "Uetliberg"
  // the plan writes is only reachable as a token inside them.
  const INPUT = {
    userLocation: { city: 'Zurich', region: 'Zurich', country: 'Switzerland' },
    availableLandmarks: [
      { name: 'Aussichtsturm Uetliberg' }, { name: 'Fernsehturm Uetliberg' }, { name: 'Oppidum Uetliberg' },
    ],
  };
  const PLACES = collectPlaceNames(INPUT);
  const BOYS = ['Levin', 'Julian', 'Max', 'Kiaan'];
  // Verbatim plan lines from that story's stored beatsReviewReport.
  const PAGES = [
    { pageNumber: 1, planLine: 'ultra-wide — Levin alone on his bike on the Uetliberg path, the old earth walls of the Oppidum Uetliberg ahead — Levin pedals toward the rampart — the destination is set', beat: '' },
    { pageNumber: 2, planLine: 'medium — Levin kneeling with Fünkli on his knee, the Aussichtsturm Uetliberg visible on the hill behind him — Levin says Fünkli must reach high ground — the deadline is spoken', beat: '' },
    { pageNumber: 3, planLine: "close-up — Fünkli pressed against Levin's chest at the railing — Fünkli's light is almost out — this is the low point", beat: '' },
    { pageNumber: 4, planLine: "wide — Max on the platform, the Fernsehturm Uetliberg's red lights lit behind him — Max flashes the shell — the signal brings no answer", beat: '' },
  ];

  it('collects the landmark, town and region names the job already carries', () => {
    expect(PLACES).toContain('Aussichtsturm Uetliberg');
    expect(PLACES).toContain('Zurich');
    // The list also carries the story language's calendar nouns (I10) — English
    // always, because the PAGE PLAN is written in English by contract.
    const extraOnly = collectPlaceNames({}, ['Marktplatz Altdorf']);
    expect(extraOnly).toContain('Marktplatz Altdorf');
    expect(extraOnly).toContain('Monday');
  });

  it('keeps places out of the invented cast, and keeps a real invented character in', () => {
    const cast = resolveCast(PAGES, BOYS, PLACES);
    expect(cast.invented).not.toContain('Uetliberg');
    expect(cast.invented).not.toContain('Aussichtsturm Uetliberg');
    expect(cast.invented).not.toContain('Oppidum Uetliberg');
    expect(cast.invented).not.toContain('Fernsehturm Uetliberg');
    expect(cast.invented).toContain('Fünkli');
    expect(cast.places).toContain('Uetliberg');
  });

  it('without the place names the same lines still leak the bare hill into the cast', () => {
    const blind = runPlanCounters({ pages: PAGES, commissionedNames: BOYS });
    expect(blind.cast.invented).toContain('Uetliberg');
    expect(blind.stats.castPerPage[0].names).toContain('Uetliberg');
    // The article-marked compounds ("the Oppidum Uetliberg", "the Aussichtsturm
    // Uetliberg") are already dropped by the grammar rule (2026-09-10), so the
    // blind run no longer reaches INVENTED_DOMINANT_EXCESS; the bare "Uetliberg"
    // ("Oppidum Uetliberg ahead") still needs the place data.
    expect(blind.cast.places).toEqual(expect.arrayContaining(['Oppidum Uetliberg', 'Aussichtsturm Uetliberg']));

    const fixed = runPlanCounters({ pages: PAGES, commissionedNames: BOYS, placeNames: PLACES });
    expect(fixed.findings.map((f: any) => f.code)).not.toContain('INVENTED_DOMINANT_EXCESS');
    expect(fixed.stats.castPerPage[0].names).toEqual(['Levin']);
  });

  it('a commissioned character sharing a token with a landmark stays commissioned', () => {
    const pages = [{ pageNumber: 1, planLine: 'wide — Uetli walks the path — she climbs — she is up', beat: '' }];
    const cast = resolveCast(pages, ['Uetli'], collectPlaceNames({ availableLandmarks: [{ name: 'Uetli Tower' }] }));
    expect(cast.commissioned).toContain('Uetli');
    expect(cast.invented).toHaveLength(0);
  });
});

describe('runPlanCounters', () => {
  it('flags a plan line missing its instant and change', () => {
    const r = runPlanCounters({ pages: [page(1, 'wide — Ana')], commissionedNames: CAST });
    expect(r.findings.map((f: any) => f.code)).toContain('PLAN_LINE_INCOMPLETE');
  });

  it('flags a book using only two shot types', () => {
    const pages = [1, 2, 3, 4].map(n => page(n, line(n % 2 ? 'wide' : 'medium', 'Ana')));
    const r = runPlanCounters({ pages, commissionedNames: CAST });
    expect(r.findings.map((f: any) => f.code)).toContain('SHOT_VARIETY');
  });

  it('flags a page with more than three named characters', () => {
    const pages = [page(1, line('wide', 'Ana, Ben, Cara and Rook arrive'))];
    const r = runPlanCounters({ pages, commissionedNames: [...CAST, 'Rook'] });
    const codes = r.findings.map((f: any) => f.code);
    expect(codes).toContain('CAST_OVER_3');
    expect(codes).toContain('CAST_OVER_CEILING');
  });

  it('flags consecutive pages carried by invented characters, and pages with no commissioned cast', () => {
    const pages = [
      page(1, line('wide', 'Ana')),
      page(2, line('medium', 'Rook walks alone')),
      page(3, line('close-up', 'Rook turns away')),
    ];
    const r = runPlanCounters({ pages, commissionedNames: CAST });
    const codes = r.findings.map((f: any) => f.code);
    expect(r.cast.invented).toContain('Rook');
    expect(codes).toContain('INVENTED_DOMINANT_CONSECUTIVE');
    expect(codes).toContain('NO_COMMISSIONED_ON_PAGE');
    const consecutive = r.findings.find((f: any) => f.code === 'INVENTED_DOMINANT_CONSECUTIVE');
    expect(consecutive.pages).toEqual([2, 3]);
  });

  it('flags a commissioned character who never gets a focal page', () => {
    // Focal needn't be solo (owner, 2026-09-04): in frame with at most ONE
    // companion satisfies it. Ben only ever appears with two companions.
    const pages = [
      page(1, line('close-up', 'Ana')),
      page(2, line('wide', 'Ana, Ben and Cara walk')),
      page(3, line('medium', 'Ana and Cara talk')),
    ];
    const r = runPlanCounters({ pages, commissionedNames: CAST });
    const noFocal = r.findings.filter((f: any) => f.code === 'NO_FOCAL_PAGE').map((f: any) => f.detail);
    expect(noFocal.join(' ')).toContain('Ben');
    // Cara's two-person page 3 is focal for BOTH people on it.
    expect(noFocal.join(' ')).not.toContain('Cara');
    expect(noFocal.join(' ')).not.toContain('Ana never');
    expect(r.stats.focalPages['Cara']).toEqual([3]);
    expect(r.stats.focalPages['Ben']).toEqual([]);
  });

  it('flags a commissioned character in frame on fewer than two pages', () => {
    const pages = [
      page(1, line('close-up', 'Ana')),
      page(2, line('wide', 'Ana and Ben walk')),
      page(3, line('medium', 'Ana and Ben talk')),
      page(4, line('ultra-wide', 'Cara stands alone')),
    ];
    const r = runPlanCounters({ pages, commissionedNames: CAST });
    const under = r.findings.filter((f: any) => f.code === 'UNDER_COVERED_CHARACTER');
    expect(under.map((f: any) => f.detail).join(' ')).toContain('Cara');
    expect(under.map((f: any) => f.detail).join(' ')).not.toContain('Ben');
    expect(r.stats.coveragePages.Ben).toEqual([2, 3]);
  });

  it('flags consecutive pages sharing shot and cast count, and lets either alone differ', () => {
    const pages = [
      page(1, line('wide', 'Ana and Ben')),
      page(2, line('wide', 'Ana and Cara')),   // same shot, same count -> finding
      page(3, line('wide', 'Ana')),            // same shot, different count -> clean
      page(4, line('close-up', 'Ben')),        // different shot, same count -> clean
    ];
    const r = runPlanCounters({ pages, commissionedNames: CAST });
    const same = r.findings.filter((f: any) => f.code === 'CONSECUTIVE_SAME_SHOT_CAST');
    expect(same).toHaveLength(1);
    expect(same[0].pages).toEqual([1, 2]);
  });

  it('never compares a pair whose plan line is incomplete or whose shot did not classify', () => {
    const incomplete = runPlanCounters({
      pages: [page(1, 'wide — Ana'), page(2, 'wide — Ben')],
      commissionedNames: CAST,
    });
    expect(incomplete.findings.map((f: any) => f.code)).not.toContain('CONSECUTIVE_SAME_SHOT_CAST');
    const unclassified = runPlanCounters({
      pages: [page(1, line('worm-eye', 'Ana')), page(2, line('worm-eye', 'Ben'))],
      commissionedNames: CAST,
    });
    expect(unclassified.findings.map((f: any) => f.code)).not.toContain('CONSECUTIVE_SAME_SHOT_CAST');
  });

  it('flags a main character present on under half the pages', () => {
    const pages = [
      page(1, line('wide', 'Ana')),
      page(2, line('wide', 'Ben')),
      page(3, line('wide', 'Ben')),
      page(4, line('wide', 'Cara')),
    ];
    const r = runPlanCounters({ pages, commissionedNames: CAST });
    expect(r.findings.map((f: any) => f.code)).toContain('MAIN_UNDER_HALF');
  });

  it('flags a book with no peopleless page and no solo page', () => {
    const pages = [1, 2].map(n => page(n, line('wide', 'Ana and Ben')));
    const codes = runPlanCounters({ pages, commissionedNames: CAST }).findings.map((f: any) => f.code);
    expect(codes).toContain('NO_SOLO_PAGE');
    expect(codes).toContain('NO_PEOPLELESS_PAGE');
  });

  it('counts a page naming no people as peopleless', () => {
    const pages = [page(1, line('wide', 'the empty harbour at dawn'))];
    const r = runPlanCounters({ pages, commissionedNames: CAST });
    expect(r.stats.peoplelessPages).toEqual([1]);
  });

  it('renders every finding as one PLAN[CODE] line', () => {
    const r = runPlanCounters({ pages: [page(1, 'wide — Ana')], commissionedNames: CAST });
    expect(r.lines.length).toBe(r.findings.length);
    for (const l of r.lines) expect(l).toMatch(/^PLAN\[[A-Z_0-9]+\]/);
  });
});

// ────────────────────────────────────────────────────────────────
// I10 — calendar nouns must never burn an invented-cast slot.
//
// Measured on job_1788641639919_mpjwlzkf1 (Baden, en-gb, 14 pages): the plan
// line "…they must find one friend before Monday — the Monday deadline is
// spoken aloud…" made `beatsReviewReport.cast.invented` = ["Monday"]. "Monday"
// is capitalised and is followed by a lowercase verb somewhere in the book, so
// it passes the acts-like-a-person heuristic exactly as a person would.
// ────────────────────────────────────────────────────────────────
describe('calendar nouns are excluded from the cast (I10)', () => {
  const { collectCalendarNames, calendarNamesForLocale } = planCounters as any;

  // The two plan lines from that story that actually carry the word.
  const BADEN = [
    {
      pageNumber: 2,
      planLine: 'close-up — Ethan at the flat window, forehead against the glass, the Stadtturm visible in the distance beyond the square where children play below — Ethan turning to Lily beside him and saying they must find one friend before Monday — the Monday deadline is spoken aloud; the tower and the square are established',
      beat: '',
    },
    {
      pageNumber: 3,
      planLine: 'ultra-wide — the square below the Stadtturm, Lily springing out from behind a bin into the open while the boy in the striped scarf still counts at the wall — Monday presses closer as Lily bursts out before the count ends — the first round is spoiled',
      beat: '',
    },
  ];
  const COMMISSIONED = ['Lily', 'Ethan'];

  it('derives weekday and month names from Intl, never a hard-coded list', () => {
    const en = calendarNamesForLocale('en-gb');
    expect(en).toContain('Monday');
    expect(en).toContain('September');
    expect(calendarNamesForLocale('de-ch')).toContain('Montag');
    expect(calendarNamesForLocale('fr')).toContain('lundi');
    // French renders them lowercase; a plan line writes them capitalised.
    expect(calendarNamesForLocale('fr')).toContain('Lundi');
    // A locale Intl cannot resolve degrades to nothing instead of throwing.
    expect(() => calendarNamesForLocale('not-a-locale-!!')).not.toThrow();
  });

  it('always includes English, because the PAGE PLAN is English by contract', () => {
    const de = collectCalendarNames('de-ch');
    expect(de).toContain('Monday');   // the language the plan line is written in
    expect(de).toContain('Montag');   // the language the book is written in
    expect(collectCalendarNames('fr-ch')).toContain('Monday');
  });

  it('reproduces the bug without the fix, and clears it with the fix', () => {
    // BEFORE — the place list as commit 27c5900c5 built it.
    const before = resolveCast(BADEN, COMMISSIONED, ['Baden', 'Switzerland', 'Stadtturm']);
    expect(before.invented).toContain('Monday');

    // AFTER — collectPlaceNames now carries the story language's calendar nouns.
    const places = collectPlaceNames(
      { userLocation: { city: 'Baden', country: 'Switzerland' }, language: 'en-gb' },
      ['Stadtturm'],
    );
    const after = resolveCast(BADEN, COMMISSIONED, places);
    expect(after.invented).not.toContain('Monday');
    expect(after.invented).toEqual([]);
    expect(after.places).toContain('Monday');
  });

  it('a real invented person on the same lines is still found', () => {
    const pages = [
      ...BADEN,
      { pageNumber: 4, planLine: 'medium — Fünkli beside Lily at the wall — Fünkli tugs her sleeve before Monday comes — the pair have a plan', beat: '' },
    ];
    const places = collectPlaceNames({ userLocation: { city: 'Baden' }, language: 'en-gb' }, ['Stadtturm']);
    const cast = resolveCast(pages, COMMISSIONED, places);
    expect(cast.invented).toEqual(['Fünkli']);
  });

  it('a commissioned character named for a month stays a character', () => {
    // Commissioned names are resolved BEFORE the exclusion list is consulted.
    const pages = [{ pageNumber: 1, planLine: 'wide — April runs across the square — April jumps — she is across', beat: '' }];
    const places = collectPlaceNames({ language: 'en-gb' }, []);
    expect(places).toContain('April');
    expect(resolveCast(pages, ['April'], places).commissioned).toContain('April');
    expect(resolveCast(pages, ['April'], places).invented).toEqual([]);
  });

  it('the numeric short-month forms some locales emit are dropped', () => {
    for (const loc of ['en-gb', 'de-ch', 'fr', 'ja']) {
      for (const n of calendarNamesForLocale(loc)) expect(n).toMatch(/[a-zA-ZÀ-ɏ]/);
    }
  });
});

describe('article/preposition-marked names are things, never cast (job_1788983823620_csjcyp1q9)', () => {
  // The measured plan: a ship and a town, both written the way English writes a
  // THING — "the <ship>", "the harbour mouth of <town>", "through <town>" — and
  // both promoted to invented figures by the acts-like-a-person test alone.
  const CREW = ['Fiona', 'Sarah'];
  const SHIP_TOWN = [
    page(1, 'ultra-wide — the crew seen from behind on the deck of the Sturmfeder — the harbour mouth of Krummhafen with its rusty chain stretches across the water — Krummhafen and its chain block the way forward'),
    page(2, 'medium — Fiona and Malva Grimm facing each other across the rail — Fiona holds the map while Malva Grimm looks up at it — Fiona has refused; the Krummhafen chain still blocks the harbour'),
    page(3, 'close-up — Fiona at the harbour — Malva rows the boat away — the crew has earned passage through Krummhafen'),
    page(4, 'medium — Sarah at the rail — a small boat pulls away from the Sturmfeder behind her — the map has been taken'),
    page(5, 'ultra-wide — the Sturmfeder seen from the water, tiny in dense grey fog — two dolphins arc alongside the bow — the rocks are found'),
  ];

  it('the ship ("the Sturmfeder") is not cast', () => {
    const cast = resolveCast(SHIP_TOWN, CREW);
    expect(cast.invented).not.toContain('Sturmfeder');
    expect(cast.places).toContain('Sturmfeder');
  });

  it('the town ("the harbour of Krummhafen", "the Krummhafen chain", "through Krummhafen") is not cast', () => {
    const cast = resolveCast(SHIP_TOWN, CREW);
    expect(cast.invented).not.toContain('Krummhafen');
    expect(cast.places).toContain('Krummhafen');
  });

  it('a real invented person who acts without an article is still cast', () => {
    const cast = resolveCast(SHIP_TOWN, CREW);
    expect(cast.invented).toEqual(['Malva Grimm']);
  });

  it('a commissioned name is never put through the article test', () => {
    // "to Fiona" is preposition-marked; commissioned names resolve first.
    const pages = [page(1, 'medium — Fiona and Sarah — Sarah hands the map to Fiona — Fiona has it')];
    const cast = resolveCast(pages, CREW);
    expect(cast.commissioned).toEqual(CREW);
    expect(cast.places).toEqual([]);
  });

  it('a name written both as "the X" and as an actor keeps its cast slot — the article is decisive only when unopposed', () => {
    const pages = [
      page(1, 'medium — Fiona and Rook — Rook the gull lands on the rail — Fiona laughs'),
      page(2, 'wide — Fiona and the Rook — Rook pulls the ribbon — Fiona has lost it'),
    ];
    expect(resolveCast(pages, CREW).invented).toEqual(['Rook']);
  });

  it('a name written as "the X" that never acts on its own is excluded, even when it heads a coordinated subject', () => {
    const pages = [
      page(1, 'wide — Fiona on the quay — the Eisenmöwe rides at anchor — Eisenmöwe and its crew wait'),
      page(2, 'medium — Fiona at the rail of the Eisenmöwe — Fiona ties a knot — the knot holds'),
    ];
    const cast = resolveCast(pages, CREW);
    expect(cast.invented).toEqual([]);
    expect(cast.places).toEqual(['Eisenmöwe']);
  });

  it('ARC_INVENTED_UNDECLARED no longer lists the ship or the town', () => {
    const { findings, cast } = runPlanCounters({
      pages: SHIP_TOWN, commissionedNames: CREW, declaredInvented: ['Malva Grimm'], inventedAllowance: 2,
    });
    expect(findings.find(f => f.code === 'ARC_INVENTED_UNDECLARED')).toBeUndefined();
    // The bare "Malva" on page 3 folds into the full name — one person.
    expect(cast.invented).toEqual(['Malva Grimm']);
  });

  it('ARC_INVENTED_UNDECLARED still fires for an undeclared person', () => {
    const { findings } = runPlanCounters({
      pages: SHIP_TOWN, commissionedNames: CREW, declaredInvented: [], inventedAllowance: 2,
    });
    const f = findings.find(x => x.code === 'ARC_INVENTED_UNDECLARED');
    expect(f).toBeDefined();
    expect(f.detail).toContain('Malva Grimm');
    expect(f.detail).not.toContain('Sturmfeder');
    expect(f.detail).not.toContain('Krummhafen');
  });

  it('thingMarkedNames guards a pre-resolved cast the same way', () => {
    expect(thingMarkedNames(SHIP_TOWN, ['Sturmfeder', 'Krummhafen', 'Malva Grimm'])).toEqual(['Sturmfeder', 'Krummhafen']);
  });
});

describe('stripQuoted: a possessive apostrophe is not an opening quote (job_1788983823620_csjcyp1q9)', () => {
  // The old `'[^']*'` clause read "ship's … Fiona's" as one quotation and
  // deleted everything between two possessives — 969 of 3818 plan chars (26%)
  // on the measured plan, whole pages gone from the corpus every cast test scans.
  it('two possessives lose nothing', () => {
    const t = "the ship's bow and Fiona's chart";
    expect(stripQuoted(t)).toBe(t);
  });

  it('a single possessive is untouched', () => {
    expect(stripQuoted("Sarah's")).toBe("Sarah's");
  });

  it("a real single-quoted span loses only the span", () => {
    expect(stripQuoted("she says 'Halt!' and runs")).toBe('she says  and runs');
  });

  it('a line-initial quote is stripped', () => {
    expect(stripQuoted("'Go,' says Lorena")).toBe('  says Lorena');
  });

  it('guillemet and double-quote stripping are unchanged', () => {
    expect(stripQuoted('the «Sturmfeder» sails')).toBe('the   sails');
    expect(stripQuoted('the "Sturmfeder" sails')).toBe('the   sails');
  });

  it('resolveCast still sees a name that sits between two possessives', () => {
    // The exact failure mode: the name on line 2 sat inside the span the old
    // clause deleted (opened at "ship's" on line 1, closed at "Fiona's" on line 2).
    const pages = [
      page(1, "medium — Fiona at the ship's rail — she leans out — the chart is safe"),
      page(2, "close-up — Malva Grimm in her rowing boat — Malva Grimm rows toward Fiona's chart — the chart is taken"),
    ];
    const cast = resolveCast(pages, ['Fiona']);
    expect(cast.invented).toContain('Malva Grimm');
    expect(namesIn(planSegments(pages[1].planLine)[1], cast.all)).toEqual(['Malva Grimm']);
  });
});

describe('a bare first name folds into its full name (job_1788983823620_csjcyp1q9)', () => {
  // The measured page 4 of that plan: "Malva Grimm" in the who-column, "Malva"
  // in the instant. One person, previously counted twice.
  const MALVA = [
    page(1, 'medium — Fiona alone at the kitchen table — she presses a torn chart flat — the chest is established'),
    page(2, 'close-up — Fiona and Malva Grimm facing each other across the rail — Fiona holds the map while Malva in her rowing boat looks up at it — Fiona has refused'),
  ];

  it('one invented person, and the page that writes both forms counts 2 not 3', () => {
    const res = runPlanCounters({ pages: MALVA, commissionedNames: ['Fiona'] });
    expect(res.cast.invented).toEqual(['Malva Grimm']);
    expect(res.stats.castPerPage[1].names).toEqual(['Fiona', 'Malva Grimm']);
    expect(res.stats.castPerPage[1].names).toHaveLength(2);
  });

  it('a commissioned two-word name mentioned by first name alone is commissioned, not invented', () => {
    const pages = [
      page(1, 'wide — Anna Meier on the quay — she waves — the boat has left'),
      page(2, 'close-up — Anna at the window — Anna presses her nose to the glass — the boat is out of sight'),
    ];
    const res = runPlanCounters({ pages, commissionedNames: ['Anna Meier'] });
    expect(res.cast.invented).toEqual([]);
    expect(res.stats.castPerPage[1].names).toEqual(['Anna Meier']);
    expect(res.findings.map((f: any) => f.code)).not.toContain('NO_COMMISSIONED_ON_PAGE');
  });

  it('two full names sharing a first token: the bare token is NOT folded, both full names stay intact', () => {
    const pages = [
      page(1, 'wide — Anna Meier and Anna Roth on the quay — Anna Meier waves while Anna Roth turns away — the boat has left'),
      page(2, 'close-up — Anna at the window — Anna presses her nose to the glass — the boat is out of sight'),
    ];
    const cast = resolveCast(pages, []);
    expect(cast.invented).toEqual(['Anna Meier', 'Anna Roth', 'Anna']);
    expect(canonicalName('Anna', ['Anna Meier', 'Anna Roth'])).toEqual({ name: 'Anna', ambiguous: true });
    // Neither full name may claim the bare token on page 2.
    expect(namesIn(planSegments(pages[1].planLine)[1], cast.all, cast.aliases)).toEqual(['Anna']);
  });

  it('a single-token name with no full-name owner is unchanged', () => {
    expect(canonicalName('Nolo', ['Malva Grimm', 'Anna Meier'])).toEqual({ name: 'Nolo', ambiguous: false });
    const pages = [page(1, 'wide — Fiona and Nolo on the quay — Nolo waves — the boat has left')];
    expect(resolveCast(pages, ['Fiona']).invented).toEqual(['Nolo']);
  });

  it('matches the token case-insensitively and keeps the full name\'s spelling', () => {
    expect(canonicalName('MALVA', ['Malva Grimm'])).toEqual({ name: 'Malva Grimm', ambiguous: false });
    expect(canonicalName('Malva Grimm', ['Malva Grimm'])).toEqual({ name: 'Malva Grimm', ambiguous: false });
  });

  it('ARC_INVENTED_UNDECLARED does not fire when the arc declared the full name and the plan writes the first name alone', () => {
    const res = runPlanCounters({ pages: MALVA, commissionedNames: ['Fiona'], declaredInvented: ['Malva Grimm'] });
    expect(res.findings.map((f: any) => f.code)).not.toContain('ARC_INVENTED_UNDECLARED');
  });

  it('the bare form acting on its own is enough to make the full name a person', () => {
    // The who-column names her in full and punctuates; only "Malva" ever acts.
    const pages = [page(1, 'medium — Fiona and Malva Grimm — Malva rows the boat toward Fiona — the chart is taken')];
    expect(resolveCast(pages, ['Fiona']).invented).toEqual(['Malva Grimm']);
  });
});

describe('the acts-like-a-person test never reads across a plan-line break (found 2026-09-10)', () => {
  // The plan is one line per page, so the verb for a name is on the name's own
  // line. With \s+ a name ENDING one line was read as followed by the shot word
  // OPENING the next ("…the ship Sturmfeder" + "\n" + "medium — …") and promoted.
  // The name is UNMARKED here on purpose ("the ship <name>", not "the <name>"):
  // a marked name is already excluded by isThingMarked, which would hide the
  // acts-test defect. Measured against the pre-fix module: invented = ["Sturmfeder"].
  const CREW = ['Fiona'];
  const NAMED_AT_LINE_END = page(1, 'wide — Fiona at the rail — she paints the name on the bow — the crew names the ship Sturmfeder');

  it('a thing name that ends line 1 is not promoted by the shot word opening line 2', () => {
    const pages = [
      NAMED_AT_LINE_END,
      page(2, 'medium — Fiona alone — she folds the map — the map is stowed'),
    ];
    const cast = resolveCast(pages, CREW);
    expect(cast.invented).toEqual([]);
    expect(cast.all).toEqual(['Fiona']);
  });

  it('the same name followed by a lowercase verb on its OWN line is cast', () => {
    const pages = [
      NAMED_AT_LINE_END,
      page(2, 'medium — Fiona and Sturmfeder — Sturmfeder rows the boat toward her — the map is stowed'),
    ];
    expect(resolveCast(pages, CREW).invented).toEqual(['Sturmfeder']);
  });

  it('a real person whose verb is on the same line still resolves', () => {
    const pages = [
      page(1, 'medium — Fiona and Nolo — Nolo pulls the rope while Fiona watches — the sail is up'),
      page(2, 'close-up — Fiona alone — she breathes out — the crew is safe'),
    ];
    expect(resolveCast(pages, CREW).invented).toEqual(['Nolo']);
  });

  it('a capitalised shot word opening line 2 is not glued onto the name ending line 1', () => {
    // Pre-fix nameCandidates returned "Sturmfeder\nClose" as one candidate.
    const pages = [
      NAMED_AT_LINE_END,
      page(2, 'Close-up — Fiona alone — she folds the map — the map is stowed'),
    ];
    expect(nameCandidates(pages.map((p: any) => p.planLine).join('\n'))).toEqual(['Fiona', 'Sturmfeder']);
    const cast = resolveCast(pages, CREW);
    expect(cast.invented).toEqual([]);
    expect(cast.all).toEqual(['Fiona']);
  });

  it('the real plan of job_1788983823620_csjcyp1q9 resolves the same cast, places and findings as before', () => {
    // The 16 plan lines as stored in stories.data.outline (---PAGE PLAN---, "Page N:" prefix stripped).
    const REAL = [
      'medium — Fiona alone at the kitchen table — she presses a torn old chart flat with both hands, her eyes on the paper, charcoal smudges on her fingers — the Grossmünster towers are visible through the rain-streaked window behind her; the chest and the need to reach it before the storms are established',
      "wide — all five children in the kitchen — Facundo drops his sword, belt and boots in a heap on the floor while Saira balances two pirate hats on her head and Lorena is already pulling on her boots — the crew is assembled and costumed; Facundo's untidiness and Saira's indecision are shown",
      'ultra-wide — all five children seen from behind on the deck of the Sturmfeder — the grey sea rolls ahead of them and the harbour mouth of Krummhafen with its rusty chain stretches across the water before them — the adventure world is entered; Krummhafen and its chain block the way forward',
      "medium — Fiona and Malva Grimm facing each other across the ship's rail — Fiona holds the map flat against her coat while Malva in her rowing boat looks up at it — Fiona has refused to hand the map down; the chain still blocks the harbour",
      'wide — Fiona and Sarah on the quay — the dead crane looms over a stack of salt barrels beside them — the problem that will earn the crew passage is established; the harbour chain is still up',
      'medium — Fiona alone, crouching over the broken crane hook and ring — she stares at the two pieces, hands not yet moving — her perfectionism holds her back; the crane is still broken',
      "medium — Saira and Sarah together — Saira laughs and holds up a coil of rope in one hand and a length of wood in the other — Saira's indecision is broken by Sarah's joke; the repair is about to begin",
      "close-up — Fiona's hands driving a wooden wedge in beside the hook where it sits in the ring — the wedge is halfway in, mallet mid-swing — the crane is fixed; the crew has earned passage through Krummhafen",
      "close-up — Facundo on the quay, the map lying on the empty ship's deck behind him just visible, fiddle players around him — he has stepped away from the ship toward the music — the map is left unguarded; this is the moment the theft becomes possible",
      "medium — Sarah at the ship's rail, turned toward the dark water — a small boat pulls away from the Sturmfeder behind her — Sarah sees the boat but does not raise the alarm; the map has been taken",
      'close-up — Facundo alone, facing forward, fists at his sides — he says out loud that it is his fault; Fiona stands small in the background, head bowed — the loss is named and felt; the question of turning back is open',
      'medium — Lorena at the mast, one hand gripping it, feet planted — she stares ahead, jaw set, after a moment of visible wavering — Lorena refuses to let the ship turn back; the crew will sail on without the map',
      'medium — Fiona and Sarah side by side at the sailcloth pinned to the mast — Fiona presses the charcoal drawing against the cloth, smudged and crooked, while Sarah points at a line on it — the charcoal chart is made and pinned up; the crew has a course to follow',
      'ultra-wide — the Sturmfeder seen from the water, tiny in dense grey fog — two dolphins arc alongside the bow and ahead of them three dark rocks rise out of the mist exactly where the sailcloth showed them — the rocks are found; the charcoal chart has proven true',
      'wide — Fiona, Facundo and Lorena in shoulder-deep water at the cove — Facundo pushes the spare sail under the chest while Lorena holds the line and the two barrels are lashed on — the chest breaks the surface; it is recovered',
      'close-up — Fiona at the kitchen table in Zurich, the crooked charcoal sailcloth pinned to the wall above her and the small brass compass turning slowly on the wood beside it — the rain is on the glass behind her — the adventure is over; the ugly chart, not the beautiful map, hangs on the wall',
    ].map((planLine, i) => page(i + 1, planLine));
    const COMMISSIONED = ['Sarah', 'Saira', 'Facundo', 'Fiona', 'Lorena'];
    const places = collectPlaceNames({ language: 'de-ch', userLocation: { city: 'Zurich', country: 'Switzerland' } });
    const cast = resolveCast(REAL, COMMISSIONED, places);
    expect(cast.invented).toEqual(['Malva Grimm']);
    expect(cast.places).toEqual(['Grossmünster', 'Sturmfeder', 'Krummhafen']);
    const res = runPlanCounters({ pages: REAL, commissionedNames: COMMISSIONED, placeNames: places, declaredInvented: ['Malva Grimm'] });
    expect(res.findings.map((f: any) => f.code)).toEqual([
      'MAIN_UNDER_HALF', 'NO_COMMISSIONED_ON_PAGE', 'UNDER_COVERED_CHARACTER', 'CONSECUTIVE_SAME_SHOT_CAST',
    ]);
  });
});
