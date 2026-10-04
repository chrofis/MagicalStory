/**
 * OBJECT STATES ARE CHECKED — the bible's `states[]` page ranges are faulted
 * mechanically and sent to the brief re-ask. (The scene review that also
 * corrected the ranges is deleted, 2026-09-28; on the Jev path a state's pages
 * follow from the decided cites, jevDecisions.applyVbPages.)
 *
 * Bug (staging job_1789343124794_z2c779f7i, 2026-09-14): an artifact's FIRST
 * state was a change ("muddy and cracked") claiming twelve pages, while the
 * story finds the object clean and glowing on the first six of them. A brief
 * citing the bare id falls back to `states[0]` (defaultObjectState), so those
 * pages were attached the mud cell. The page-prompt path noticed
 * (`resolveObjectState` → `contradicted`) and dropped the delta from the PROSE,
 * but that runs after the review and cannot swap the reference cell: the pages
 * rendered a dark, cracked, mud-crusted object six pages before the mud exists.
 *
 * Nothing reviewed the bible — scene-review.txt had no bible input at all.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const {
  checkPage, checkScenes, renderFindingsBlock, REVIEWABLE,
} = require_('../../server/lib/sceneBriefCheck');

// ── Fixtures: the stored shape, names archetypal. ───────────────────────────
const DESCRIPTION = 'a smooth, perfectly oval shell about the size of a school bag, emitting a warm glowing internal light, completely unlettered';

/** The bible as authored: the first state is a CHANGE, claiming p3 onward. */
function faultedBible(): any {
  return {
    artifacts: [{
      id: 'ART003',
      name: 'creature egg',
      type: 'egg',
      description: DESCRIPTION,
      appearsInPages: [3, 4, 5, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17],
      states: [
        { id: 'ART003.1', name: 'muddy and cracked', delta: 'covered in thick dark mud with a jagged crack across the surface', pages: [3, 4, 5, 7, 8, 9, 10, 11, 12, 13, 14, 15] },
        { id: 'ART003.2', name: 'shining and cracked', delta: 'wiped clean, glowing with bright warm light, a jagged crack across the surface', pages: [16] },
        { id: 'ART003.3', name: 'broken open', delta: 'broken open into two empty shell halves', pages: [17] },
      ],
    }],
    secondaryCharacters: [], animals: [], vehicles: [], locations: [], clothing: [],
  };
}

/** The same entry corrected: the unaltered look is the first state. */
function cleanBible(): any {
  const vb = faultedBible();
  vb.artifacts[0].states = [
    { id: 'ART003.1', name: 'unaltered', delta: 'the shell as described, unmarked', pages: [3, 4, 5, 7, 8] },
    { id: 'ART003.2', name: 'muddy', delta: 'covered in thick dark mud', pages: [9] },
    { id: 'ART003.3', name: 'muddy and cracked', delta: 'thick dark mud with a jagged crack across the surface', pages: [10, 11, 12, 13, 14, 15] },
  ];
  return vb;
}

/** A page citing the bare id, whose own instant asserts the glowing look. */
const page3 = (): any => ({
  pageNumber: 3,
  brief: 'The two children crouch at the reeds, hands out toward the shell.',
  metadata: {
    objects: ['ART003'],
    characters: [{ name: 'the older child' }],
    sceneIntent: 'The children find the egg in the reeds, glowing with bright warm light.',
  },
});

describe('vb_state_contradicted — the page\'s instant disagrees with the state it resolves to', () => {
  it('fires on a bare citation that falls back to a change the page has not reached', () => {
    const findings = checkPage(page3(), ['the older child'], faultedBible(), {});
    const hits = findings.filter((f: any) => f.type === 'vb_state_contradicted');
    expect(hits).toHaveLength(1);
    expect(hits[0].pageNumber).toBe(3);
    expect(hits[0].ids).toEqual(['ART003']);
    expect(hits[0].detail).toContain('ART003.1');
  });

  it('is silent when the first state is the unaltered look and covers the page', () => {
    const findings = checkPage(page3(), ['the older child'], cleanBible(), {});
    expect(findings.filter((f: any) => f.type === 'vb_state_contradicted')).toHaveLength(0);
  });

  it('is silent for an entry with no states at all (the old stored shape)', () => {
    const vb = faultedBible();
    delete vb.artifacts[0].states;
    expect(checkPage(page3(), [], vb, {}).filter((f: any) => f.type === 'vb_state_contradicted')).toHaveLength(0);
  });

  it('survives a malformed entry rather than killing the check', () => {
    const vb: any = { artifacts: [{ id: 'ART003', name: 'creature egg', states: [null] }] };
    expect(() => checkPage(page3(), [], vb, {})).not.toThrow();
  });
});

/**
 * Lab #1266 p12: a page cites two stated objects (a muddy egg and a jacket in
 * its unaltered state) and one sentence names both. "muddy" belongs to the
 * egg; the check charged the JACKET's unaltered state with being contradicted.
 * The reviewer declined it — the cost is a wasted finding slot, on every page
 * where two stated objects co-occur.
 */
function twoStatedObjectsBible(): any {
  return {
    artifacts: [
      {
        id: 'ART001',
        name: 'creature egg',
        type: 'egg',
        description: DESCRIPTION,
        appearsInPages: [11, 12],
        states: [
          { id: 'ART001.1', name: 'unaltered', delta: 'the shell as described, unmarked', pages: [11] },
          { id: 'ART001.3', name: 'muddy', delta: 'covered in thick dark mud', pages: [12] },
        ],
      },
    ],
    clothing: [
      {
        id: 'ART002',
        name: 'travelling jacket',
        type: 'jacket',
        description: 'a short canvas travelling jacket with two front pockets',
        appearsInPages: [11, 12],
        states: [
          { id: 'ART002.1', name: 'unaltered', delta: 'spotless and dry', pages: [11, 12] },
          { id: 'ART002.2', name: 'muddy', delta: 'streaked with thick dark mud', pages: [13] },
        ],
      },
    ],
    secondaryCharacters: [], animals: [], vehicles: [], locations: [],
  };
}

const page12 = (sceneIntent: string): any => ({
  pageNumber: 12,
  brief: 'The child stands at the bank.',
  metadata: {
    objects: ['ART001.3', 'ART002.1'],
    characters: [{ name: 'the older child' }],
    sceneIntent,
  },
});

describe('vb_state_contradicted — an appearance word is attributed before it is charged', () => {
  it('does not charge the second element when the appearance word belongs to the first (Lab #1266 p12)', () => {
    const findings = checkPage(
      page12('She clutches the muddy egg against her jacket.'),
      ['the older child'], twoStatedObjectsBible(), {}
    );
    const hits = findings.filter((f: any) => f.type === 'vb_state_contradicted' && f.ids.includes('ART002'));
    expect(hits).toHaveLength(0);
  });

  it('still fires when the appearance word belongs to the element it contradicts', () => {
    const findings = checkPage(
      page12('The jacket hangs streaked with mud.'),
      ['the older child'], twoStatedObjectsBible(), {}
    );
    const hits = findings.filter((f: any) => f.type === 'vb_state_contradicted' && f.ids.includes('ART002'));
    expect(hits).toHaveLength(1);
    expect(hits[0].detail).toContain('ART002.1');
  });
});

describe('vb_state_no_base — the unaltered look is missing or mis-ranged', () => {
  const pages = () => [
    { pageNumber: 3, brief: 'x', metadata: { objects: ['ART003'] } },
    { pageNumber: 9, brief: 'x', metadata: { objects: ['ART003'] } },
  ];

  it('fires when the first state does not cover the earliest page a brief stages the object on', () => {
    const vb = faultedBible();
    vb.artifacts[0].states[0].pages = [9, 10, 11];   // the change claims p9 onward, p3 belongs to no state
    const { findings } = checkScenes(pages(), [], vb, {});
    const hits = findings.filter((f: any) => f.type === 'vb_state_no_base');
    expect(hits).toHaveLength(1);
    expect(hits[0].pageNumber).toBe(3);
    expect(hits[0].ids).toEqual(['ART003']);
  });

  it('fires when the first state carries no pages at all', () => {
    const vb = faultedBible();
    vb.artifacts[0].states[0].pages = [];
    const { findings } = checkScenes(pages(), [], vb, {});
    expect(findings.filter((f: any) => f.type === 'vb_state_no_base')).toHaveLength(1);
  });

  it('does not fire when the first state covers that page', () => {
    const { findings } = checkScenes(pages(), [], cleanBible(), {});
    expect(findings.filter((f: any) => f.type === 'vb_state_no_base')).toHaveLength(0);
  });

  it('reads the earliest page from the BRIEFS, not from the bible\'s own pages', () => {
    const vb = faultedBible();
    vb.artifacts[0].states[0].pages = [3, 4, 5];
    // Only p2 stages it; the bible's table never mentions p2.
    const { findings } = checkScenes([{ pageNumber: 2, brief: 'x', metadata: { objects: ['ART003'] } }], [], vb, {});
    const hits = findings.filter((f: any) => f.type === 'vb_state_no_base');
    expect(hits).toHaveLength(1);
    expect(hits[0].pageNumber).toBe(2);
  });
});

describe('both types reach the re-ask', () => {
  it('are REVIEWABLE and are rendered into the findings block', () => {
    expect(REVIEWABLE.has('vb_state_contradicted')).toBe(true);
    expect(REVIEWABLE.has('vb_state_no_base')).toBe(true);
    const byPage = new Map([[3, [
      { pageNumber: 3, type: 'vb_state_contradicted', detail: 'contradiction detail' },
      { pageNumber: 3, type: 'vb_state_no_base', detail: 'base detail' },
    ]]]);
    const block = renderFindingsBlock(byPage);
    expect(block).toContain('[vb_state_contradicted]');
    expect(block).toContain('[vb_state_no_base]');
  });
});
