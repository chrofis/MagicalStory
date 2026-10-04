import { describe, it, beforeAll, afterEach, expect } from 'vitest';
import { createRequire } from 'node:module';

const { drawChallengeIdeas, buildChallengeIdeasSection, buildArcCreatePrompt, parseArcRetell } = require('../../server/lib/promptBuilders');
const { loadPromptTemplates } = require('../../server/services/prompts');

const inputData = {
  pages: 18,
  characters: [{ name: 'Levin', age: 5 }, { name: 'Julian', age: 3 }],
};

/**
 * Variety used to be an INSTRUCTION: the arc prompt carried "This reader's
 * earlier books used these challenges — this story uses different ones" plus
 * prose lifted from those books' arcs. On staging job_1789759147125_p08djwhbl
 * that block told the creator to avoid the very premise the family had
 * commissioned, and carried three other stories' characters by name.
 * It is now a SELECTION rule applied to the draw.
 *
 * REVERSAL (owner, 2026-09-21): the set excluded is no longer what earlier
 * books were OFFERED but what they actually TOOK — see the taken-column
 * describe below. These cases pin the draw's exclusion MECHANICS, which are
 * unchanged by that; only the source of the ids moved.
 */
describe('the draw excludes an earlier book\'s challenge ids', () => {
  it('returns the catalogue ids it drew, one per offered line', () => {
    const draw = drawChallengeIdeas(inputData, { count: 15 });
    const lines = draw.section.split('\n').filter((l: string) => l.startsWith('- '));
    expect(draw.ids.length).toBe(lines.length);
    expect(draw.ids.every((id: number) => Number.isInteger(id))).toBe(true);
    expect(new Set(draw.ids).size).toBe(draw.ids.length);
  });

  it('never draws an excluded id', () => {
    const first = drawChallengeIdeas(inputData, { count: 15 });
    const second = drawChallengeIdeas(inputData, { count: 15, excludeIds: first.ids });
    expect(second.ids.length).toBeGreaterThan(0);
    for (const id of second.ids) expect(first.ids).not.toContain(id);
  });

  it('drops the exclusions rather than draw from a starved pool', () => {
    // Every id in the band excluded: a draw that cannot be filled at all is a
    // broken input, so the exclusion is abandoned rather than shipped thin.
    const all = Array.from({ length: 400 }, (_, i) => i + 1);
    const draw = drawChallengeIdeas(inputData, { count: 15, excludeIds: all });
    expect(draw.ids.length).toBeGreaterThan(0);
  });

  it('tolerates junk in the exclusion list', () => {
    const draw = drawChallengeIdeas(inputData, { count: 15, excludeIds: [null, 'x', NaN, undefined] as any });
    expect(draw.ids.length).toBeGreaterThan(0);
  });
});

describe('no prompt mentions a previous story', () => {
  beforeAll(async () => { await loadPromptTemplates(); });

  it('the arc-create prompt carries no earlier-book block', () => {
    const prompt = buildArcCreatePrompt(
      { ...inputData, storyDetails: 'Vier Buben finden ein Ei.', language: 'de-CH', title: 'Das Ei' }, 18, {});
    expect(prompt).toBeTruthy();
    expect(prompt).not.toMatch(/earlier books/i);
    expect(prompt).not.toMatch(/this reader's/i);
    expect(prompt).not.toContain('{PRIOR_CHALLENGES}');
  });

  it('buildChallengeIdeasSection still returns the section alone', () => {
    const s = buildChallengeIdeasSection(inputData);
    expect(typeof s).toBe('string');
    expect(s).toContain('# CHALLENGE IDEAS');
  });
});

/**
 * OLDEST-FIRST SHEDDING (2026-09-20).
 *
 * The valve this replaced was all-or-nothing: one book of memory too many and
 * the ENTIRE exclusion list was discarded, so the draw ran completely
 * unfiltered — the reader most likely to notice a repeat (the one who just
 * finished a book) got no protection at all. The memory is now trimmed from
 * the OLD end until the pool fits, and the newest book never pays for the
 * oldest one.
 *
 * These pin the SHEDDING BEHAVIOUR, not the floor's numeric value: each case
 * builds an exclusion whose size is derived from the band's real pool.
 */
describe('oldest-first shedding of the exclusion memory', () => {
  // The band the fixture resolves to (youngest is 3), measured from the real
  // catalogue via an unfiltered draw's own view of what it may draw.
  const eligibleIds = (): number[] => {
    const seen = new Set<number>();
    for (let i = 0; i < 60; i++) {
      for (const id of drawChallengeIdeas(inputData, { count: 25 }).ids) seen.add(id);
    }
    return [...seen];
  };

  it('honours every book when the pool stays above the floor', () => {
    // Three books of five ids each: trivially affordable in any band.
    const books = [[11, 12, 13, 14, 15], [21, 22, 23, 24, 25], [31, 32, 33, 34, 35]];
    const draw = drawChallengeIdeas(inputData, { count: 25, excludeIds: books });
    expect(draw.offeredStories).toBe(3);
    expect(draw.effectiveStories).toBe(3);
    for (const id of draw.ids) expect(books.flat()).not.toContain(id);
  });

  it('sheds the OLDEST book first and always keeps the newest excluded', () => {
    const pool = eligibleIds();
    // Two books that between them starve the pool, but either one alone does
    // not. Split the band so each half is far below the floor when combined.
    const half = Math.ceil(pool.length / 2);
    const newest = pool.slice(0, half);
    const oldest = pool.slice(half);
    const draw = drawChallengeIdeas(inputData, { count: 25, excludeIds: [newest, oldest] });
    expect(draw.offeredStories).toBe(2);
    // Both together starve it, so exactly one book of memory survives...
    expect(draw.effectiveStories).toBe(1);
    // ...and it is the NEWEST, never the oldest.
    for (const id of draw.ids) expect(newest).not.toContain(id);
    expect(draw.ids.some((id: number) => oldest.includes(id))).toBe(true);
  });

  it('sheds one book at a time rather than discarding the whole list', () => {
    const pool = eligibleIds();
    // One affordable recent book, then many old books that together bust the
    // floor. The old end goes; the recent one must not go with it.
    const newest = pool.slice(0, 4);
    const old = [];
    for (let i = 4; i < pool.length; i += 6) old.push(pool.slice(i, i + 6));
    const draw = drawChallengeIdeas(inputData, { count: 25, excludeIds: [newest, ...old] });
    expect(draw.effectiveStories).toBeGreaterThanOrEqual(1);
    expect(draw.effectiveStories).toBeLessThan(draw.offeredStories);
    for (const id of draw.ids) expect(newest).not.toContain(id);
  });

  it('abandons the exclusion only when even the newest book alone cannot be paid for', () => {
    const pool = eligibleIds();
    // A single book holding almost the whole band: nothing left to draw from.
    const draw = drawChallengeIdeas(inputData, { count: 25, excludeIds: [pool.slice(0, pool.length - 3)] });
    expect(draw.offeredStories).toBe(1);
    expect(draw.effectiveStories).toBe(0);
    // A full draw still ships — an unfillable draw would be the worse failure.
    expect(draw.ids.length).toBeGreaterThan(0);
  });

  it('reads a flat exclusion array as one book', () => {
    const draw = drawChallengeIdeas(inputData, { count: 25, excludeIds: [11, 12, 13] });
    expect(draw.offeredStories).toBe(1);
    expect(draw.effectiveStories).toBe(1);
    for (const id of draw.ids) expect([11, 12, 13]).not.toContain(id);
  });

  it('counts no memory when there is none to offer', () => {
    const draw = drawChallengeIdeas(inputData, { count: 25 });
    expect(draw.offeredStories).toBe(0);
    expect(draw.effectiveStories).toBe(0);
  });
});

describe('the draw is auditable back to the catalogue', () => {
  it('tags every offered line with its catalogue id', () => {
    const draw = drawChallengeIdeas(inputData, { count: 25 });
    const lines = draw.section.split('\n').filter((l: string) => l.startsWith('- '));
    expect(lines.length).toBe(draw.ids.length);
    lines.forEach((l: string, i: number) => {
      expect(l.startsWith(`- [C${draw.ids[i]}] `)).toBe(true);
    });
  });
});

describe('parseArcRetell records which drawn challenges the arc took', () => {
  const retell = (taken: string) => [
    'STORY LOGIC:',
    'Want and stakes: get home.',
    'Opposition: the river.',
    'Facts:',
    '- Levin (commissioned) — can swim; cannot row',
    'Central figure: none',
    'Chain:',
    '- because the bridge is down, they build a raft',
    'Fixing: the orphaned payoff.',
    'Keeping: the rescue.',
    'Challenges taken:',
    taken,
    'Used: Panelist A',
    'FINAL ARC:',
    '1. A child sets out.',
    '2. A child comes home.',
    'CRITIQUE:',
    '1. [MINOR] thin middle.',
  ].join('\n');

  it('pulls the catalogue ids off the taken lines', () => {
    const r = parseArcRetell(retell('1. [C42] crossing the water\n2. [C7] the locked door'));
    expect(r.takenIds).toEqual([42, 7]);
  });

  it('counts an arc-invented challenge as taken from no catalogue entry', () => {
    const r = parseArcRetell(retell('1. [C42] crossing the water\n2. [own] the promise she made'));
    expect(r.takenIds).toEqual([42]);
  });

  it('keeps the reference tags out of the arc text that travels downstream', () => {
    // The final arc reaches the beats planner, the text writer and the image
    // prompts; a stray [C###] there reads as a cell reference.
    const r = parseArcRetell(retell('1. [C42] crossing the water\n2. [own] the promise'));
    expect(r.finalArc).not.toMatch(/\[C\d+\]/);
    expect(r.finalArc).not.toMatch(/\[own\]/i);
    expect(r.finalArc).toContain('crossing the water');
  });

  it('yields no ids when the telling ignores the tag contract', () => {
    const r = parseArcRetell(retell('1. crossing the water\n2. the locked door'));
    expect(r.takenIds).toEqual([]);
  });
});

/**
 * TAKEN, NOT OFFERED (owner, 2026-09-21).
 *
 * The exclusion used to read `data->'challengeDrawIds'` — the 25 ids each book
 * was OFFERED. A challenge that was offered and never used never reached a
 * reader, so there is nothing to avoid repeating, and excluding it burned
 * catalogue for no benefit: against the real catalogue (eligible 3-5 = 139,
 * 6-8 = 336, 9-12 = 256; floor 45, limit 12) the effective memory was 3 / 11 / 8
 * books. Excluding the ~3-5 ids a book actually TOOK buys the full 12 in every
 * band with no catalogue growth.
 *
 * These pin the COLUMN and the REPORTING, because the failure mode is silent:
 * if no book contributes a taken id the exclusion becomes "exclude nothing",
 * and every log line still reads like success.
 */
describe('the exclusion reads what earlier books TOOK, not what they were offered', () => {
  const require_ = createRequire(import.meta.url);
  // beatsPipeline's `loadUsedChallengeIds` does its own
  // `require('../services/database')` at CALL time, which vi.mock's ESM
  // interception does not reach. Swap dbQuery on the real module object — the
  // house pattern from tests/unit/character-image-offload.test.ts. Nothing
  // touches a database.
  const db = require_('../../server/services/database');
  const { loadUsedChallengeIds } = require_('../../server/lib/beatsPipeline.js');
  const realQuery = db.dbQuery;
  afterEach(() => { db.dbQuery = realQuery; });

  /** Answers every query with the given rows, and captures the SQL. */
  const withRows = (rows: any[]) => {
    const seen: string[] = [];
    db.dbQuery = async (sql: string) => { seen.push(sql); return rows; };
    return seen;
  };

  const collect = () => {
    const events: any[] = [];
    const rec = (level: string) => (event: string, message: string, _c: any, details: any) =>
      events.push({ level, event, message, details });
    return { events, gl: { info: rec('info'), warn: rec('warn'), error: rec('error'), setStage: () => {} } };
  };

  it('selects and filters on the TAKEN column, never the drawn one', async () => {
    const seen = withRows([]);
    await loadUsedChallengeIds('job_1', collect().gl);
    expect(seen.length).toBe(1);
    expect(seen[0]).toContain("data->'challengeTakenIds'");
    // The completeness filter moved with it: a book that never got as far as a
    // re-told arc reporting its choices has nothing to contribute.
    expect(seen[0]).toContain("jsonb_typeof(s.data->'challengeTakenIds') = 'array'");
    expect(seen[0]).not.toContain('challengeDrawIds');
  });

  it('groups the taken ids by book, newest first', async () => {
    withRows([{ id: 'a', ids: [4, 9] }, { id: 'b', ids: [17, 17, 3] }]);
    const r = await loadUsedChallengeIds('job_1', collect().gl);
    expect(r.idsByStory).toEqual([[4, 9], [17, 3]]);
    expect(r.stories).toBe(2);
    expect(r.examined).toBe(2);
  });

  it('a prior book with an empty taken list contributes nothing and is counted as such', async () => {
    withRows([{ id: 'a', ids: [4, 9] }, { id: 'empty-book', ids: [] }]);
    const { events, gl } = collect();
    const r = await loadUsedChallengeIds('job_1', gl);
    // Contributing is not the same number as examined — that gap IS the signal.
    expect(r.idsByStory).toEqual([[4, 9]]);
    expect(r.stories).toBe(1);
    expect(r.examined).toBe(2);
    const warned = events.find((e: any) => e.event === 'arc_variety_empty_prior');
    expect(warned).toBeTruthy();
    expect(warned.level).toBe('warn');
    expect(warned.details.emptyStoryIds).toEqual(['empty-book']);
  });

  it('reports contributing-vs-examined so a silently empty memory is visible', async () => {
    withRows([{ id: 'a', ids: [] }, { id: 'b', ids: [] }]);
    const { events, gl } = collect();
    const r = await loadUsedChallengeIds('job_1', gl);
    expect(r.stories).toBe(0);
    expect(r.examined).toBe(2);
    expect(events.some((e: any) => e.event === 'arc_variety_empty_prior')).toBe(true);
  });

  it('never throws, and reports no memory, when the lookup fails', async () => {
    db.dbQuery = async () => { throw new Error('connection refused'); };
    const { events, gl } = collect();
    const r = await loadUsedChallengeIds('job_1', gl);
    expect(r).toEqual({ idsByStory: [], stories: 0, examined: 0 });
    expect(events.some((e: any) => e.event === 'arc_variety_failed')).toBe(true);
  });

  it('asks nothing at all without a job id', async () => {
    const seen = withRows([{ id: 'a', ids: [1] }]);
    const r = await loadUsedChallengeIds(null, collect().gl);
    expect(seen.length).toBe(0);
    expect(r).toEqual({ idsByStory: [], stories: 0, examined: 0 });
  });

  /**
   * The whole change rests on `challengeTakenIds` being populated by a real
   * run, and that path had never executed when this shipped. A book that drew
   * challenges and reported none taken must be LOUD — a silent one is
   * indistinguishable from a healthy account with no history.
   */
  describe('a drawn-but-nothing-taken arc fails loudly', () => {
    const { reportChallengeMemoryBreach } = require_('../../server/lib/beatsPipeline.js');

    it('reports when a non-empty draw yields an empty taken list', () => {
      const { events, gl } = collect();
      expect(reportChallengeMemoryBreach('job_9', [3, 4, 5], [], gl)).toBe(true);
      const e = events.find((x: any) => x.event === 'arc_challenges_taken_missing');
      expect(e).toBeTruthy();
      expect(e.level).toBe('error');
      expect(e.details.challengeDrawIds).toEqual([3, 4, 5]);
      expect(e.details.jobId).toBe('job_9');
    });

    it('stays silent when the arc took at least one drawn challenge', () => {
      const { events, gl } = collect();
      expect(reportChallengeMemoryBreach('job_9', [3, 4, 5], [4], gl)).toBe(false);
      expect(events.length).toBe(0);
    });

    it('stays silent when there was no draw to take from', () => {
      // No draw means no contract — an age band with no eligible entries, say.
      const { events, gl } = collect();
      expect(reportChallengeMemoryBreach('job_9', [], [], gl)).toBe(false);
      expect(events.length).toBe(0);
    });
  });
});

/**
 * The safety net stays wired even though a taken-sized memory will almost never
 * trip it. MIN_POOL and oldest-first shedding are what keeps a future, harder
 * catalogue filter from starving the draw — so they are pinned against an
 * artificially large excluded set, not against a realistic one.
 */
describe('shedding and the pool floor still behave on a large excluded set', () => {
  const bandIds = (): number[] => {
    const seen = new Set<number>();
    for (let i = 0; i < 60; i++) {
      for (const id of drawChallengeIdeas(inputData, { count: 25 }).ids) seen.add(id);
    }
    return [...seen];
  };

  it('a realistic taken-sized memory of 12 books costs no shedding at all', () => {
    // 12 books x 5 taken ids = 60 excluded, against the SMALLEST band (the
    // fixture's youngest character is 3). This is the whole point of the change.
    const pool = bandIds();
    const books = Array.from({ length: 12 }, (_, b) => pool.slice(b * 5, b * 5 + 5));
    const draw = drawChallengeIdeas(inputData, { count: 25, excludeIds: books });
    expect(draw.offeredStories).toBe(12);
    expect(draw.effectiveStories).toBe(12);
    for (const id of draw.ids) expect(books.flat()).not.toContain(id);
  });

  it('still sheds from the OLD end when the excluded set is made large enough to bite', () => {
    const pool = bandIds();
    const half = Math.ceil(pool.length / 2);
    const newest = pool.slice(0, half);
    const oldest = pool.slice(half);
    const draw = drawChallengeIdeas(inputData, { count: 25, excludeIds: [newest, oldest] });
    expect(draw.effectiveStories).toBe(1);
    for (const id of draw.ids) expect(newest).not.toContain(id);
  });

  it('still abandons the exclusion when even the newest book alone cannot be paid for', () => {
    const pool = bandIds();
    const draw = drawChallengeIdeas(inputData, { count: 25, excludeIds: [pool.slice(0, pool.length - 3)] });
    expect(draw.effectiveStories).toBe(0);
    expect(draw.ids.length).toBeGreaterThan(0);
  });
});

/**
 * THE CREATED ARC REPORTS WHAT IT TOOK (2026-09-27). Since the re-telling runs
 * only when a MAJOR finding survives (2026-09-25), the created arc is often the
 * one that ships; with the memory reading TAKEN ids, a created arc that did not
 * report them would add nothing to the next book's exclusion.
 */
describe('the created arc reports its challenges taken, as the re-telling does', () => {
  const PB = require('../../server/lib/promptBuilders');
  beforeAll(async () => { await loadPromptTemplates(); });
  const LOGIC = [
    'STORY LOGIC:', 'Want and stakes: get home.', 'Opposition: the river.', 'Facts:',
    '- Levin (commissioned) — can swim; cannot row', 'Central figure: none', 'Chain:', '- because the bridge is down, they build a raft',
  ].join('\n');
  const ARC = 'ARC:\n1. A child sets out.\n2. A child comes home.\n\nCRITIQUE:\nFaults:\n1. [MINOR] (s1) thin — "A child sets out."';

  it('the create prompt carries the one CHALLENGES_TAKEN_RULE when there is a draw, and not without one', () => {
    const drawn = PB.drawChallengeIdeas(inputData, { count: 12 }).section;
    const withDraw = PB.buildArcCreatePrompt({ ...inputData, language: 'en' }, 12, { challengeIdeas: drawn });
    expect(withDraw).toContain(PB.CHALLENGES_TAKEN_RULE);
    const without = PB.buildArcCreatePrompt({ ...inputData, language: 'en' }, 12, { challengeIdeas: '' });
    expect(without).not.toContain('Challenges taken');
    expect(without).not.toContain('{CHALLENGES_TAKEN}');
  });

  it('the re-tell prompt carries the same constant', () => {
    const drawn = PB.drawChallengeIdeas(inputData, { count: 12 }).section;
    const p = PB.buildArcRetellPrompt({ ...inputData, language: 'en' }, 12, 'ARC:\n1. x', '1. [MAJOR] (s1) x — "x"', { challengeIdeas: drawn });
    expect(p).toContain(PB.CHALLENGES_TAKEN_RULE);
    expect(p).not.toContain('{CHALLENGES_TAKEN_RULE}');
  });

  it('parseArcCreate reads the taken ids and keeps the block out of the arc and the committed text', () => {
    const r = PB.parseArcCreate(`${LOGIC}\n\nChallenges taken:\n1. [C42] crossing the water\n2. [own] a promise\n\n${ARC}`);
    expect(r.takenIds).toEqual([42]);
    expect(r.takenTagged).toBe(2);
    expect(r.arc).toBe('1. A child sets out.\n2. A child comes home.');
    expect(r.sentences).toBe(2);
    expect(r.committed).not.toMatch(/\[C\d+\]|Challenges taken/);
    expect(r.logic.chain.length).toBe(1);
  });

  it('a block misplaced after the arc is still read, and cut out of the arc', () => {
    const r = PB.parseArcCreate(`${LOGIC}\n\nARC:\n1. A child sets out.\n2. A child comes home.\n\nChallenges taken:\n1. [C9] the gate\n\nCRITIQUE:\nFaults:\nnone`);
    expect(r.takenIds).toEqual([9]);
    expect(r.arc).toBe('1. A child sets out.\n2. A child comes home.');
  });

  it('no block → no ids, no tagged lines', () => {
    const r = PB.parseArcCreate(`${LOGIC}\n\n${ARC}`);
    expect(r.takenIds).toEqual([]);
    expect(r.takenTagged).toBe(0);
  });
});

describe('an arc built only on its own challenges is not a broken contract', () => {
  const require_ = createRequire(import.meta.url);
  const { reportChallengeMemoryBreach } = require_('../../server/lib/beatsPipeline.js');
  const events: any[] = [];
  const gl = { info: () => {}, warn: () => {}, error: (event: string) => events.push(event) };
  it('[own]-only (tagged lines, no id) stays silent; no tagged line at all is the breach', () => {
    expect(reportChallengeMemoryBreach('job', [1, 2], [], gl, { tagged: 2 })).toBe(false);
    expect(reportChallengeMemoryBreach('job', [1, 2], [], gl, { tagged: 0 })).toBe(true);
    expect(events).toEqual(['arc_challenges_taken_missing']);
  });
});
