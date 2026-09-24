/**
 * A REPAIRED PAGE'S BRIEF IS CHECKED LIKE AN AUTHORED ONE.
 *
 * `prompts/scene-review.txt` runs ONCE, over the Art Director's briefs, before
 * any image exists. When a page is repaired the iterate round REWRITES that
 * brief, and the rewrite becomes the page's contract — the judges score against
 * it and it is promoted onto the page record. Until 2026-09-17 the only
 * mechanical check that reached it kept two of the eleven fault types
 * `sceneBriefCheck.checkPage` computes, and nothing at all compared the
 * rewrite's METADATA against the brief it replaced.
 *
 * Both halves are pinned here against the real thing: the 11 stored iterate
 * rounds of staging job_1789584708605_rts4wqupm (p4, p6, p9, p10, p13, p16) and
 * job_1789506283204_3kxqshifx (p2, p7, p10, p13, p16), each with the Art
 * Director brief it replaced and the Visual Bible it was written against.
 *
 * Structure and behaviour, never prose: no assertion reads a finding's wording.
 * Offline and free — pure code, no model call, no database.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const IB = nodeRequire('../../server/lib/iterateBeat.js');
const SBC = nodeRequire('../../server/lib/sceneBriefCheck.js');
const { extractSceneMetadata } = nodeRequire('../../server/lib/sceneMetadata.js');
const FIXTURE = nodeRequire('./fixtures/iterate-rewrite-checks-staging.json');

type Round = {
  job: string; pageNumber: number; source: string;
  planLine: string; parentBrief: string; rewriteBrief: string;
};
const ROUNDS: Round[] = FIXTURE.rounds;
const storyOf = (r: Round) => FIXTURE.stories[r.job];
const label = (r: Round) => `${r.job.slice(-8)} p${r.pageNumber}`;

const checkRewrite = (r: Round, opts: any = {}) => IB.checkRewrittenBrief({
  pageNumber: r.pageNumber,
  brief: r.rewriteBrief,
  planLine: r.planLine,
  castNames: storyOf(r).castNames,
  visualBible: storyOf(r).visualBible,
  ...opts,
});

const carried = (r: Round) => IB.checkCarriedFields({
  parentMetadata: extractSceneMetadata(String(r.parentBrief || '')),
  rewriteMetadata: extractSceneMetadata(String(r.rewriteBrief || '')),
});

describe('the corpus', () => {
  it('holds 11 iterate rounds across two runs, each with the brief it replaced', () => {
    expect(ROUNDS.length).toBe(11);
    expect(new Set(ROUNDS.map(r => r.job)).size).toBe(2);
    for (const r of ROUNDS) {
      expect(r.parentBrief.length, `${label(r)} parent`).toBeGreaterThan(500);
      expect(r.rewriteBrief.length, `${label(r)} rewrite`).toBeGreaterThan(500);
      expect(r.rewriteBrief, `${label(r)} is a rewrite, not the parent`).not.toBe(r.parentBrief);
      expect(r.source).toMatch(/^iterate-/);
    }
  });
});

// ── The metadata half ───────────────────────────────────────────────────────

describe('a rewrite may not drop a field its parent declared', () => {
  it('every one of the 11 rounds dropped depth, looksAt and action, and is reported', () => {
    for (const r of ROUNDS) {
      const found = carried(r);
      expect(found.length, `${label(r)}: expected one finding`).toBe(1);
      expect(found[0].type).toBe('brief_field_dropped');
      // p10 of the second run is the one page whose parent brief declares no
      // characters[] row at all, so only the interaction field can be dropped.
      const expected = (r.job.endsWith('3kxqshifx') && r.pageNumber === 10)
        ? ['interactions[].action']
        : ['characters[].depth', 'characters[].looksAt', 'interactions[].action'];
      expect(found[0].fields, label(r)).toEqual(expected);
    }
  });

  it('a rewrite that keeps the fields is clean', () => {
    for (const r of ROUNDS) {
      const meta = extractSceneMetadata(String(r.parentBrief || ''));
      expect(IB.checkCarriedFields({ parentMetadata: meta, rewriteMetadata: meta }), label(r)).toEqual([]);
    }
  });

  it('a field the parent never declared is never demanded of the rewrite', () => {
    const parent = { fullData: { characters: [{ name: 'A' }], interactions: [{ character: 'A', object: 'x' }] } };
    const rewrite = { fullData: { characters: [{ name: 'A' }], interactions: [{ character: 'A', object: 'x' }] } };
    expect(IB.checkCarriedFields({ parentMetadata: parent, rewriteMetadata: rewrite })).toEqual([]);
  });

  it('a rewrite with no rows to carry the field on is never reported', () => {
    const parent = { fullData: { characters: [{ name: 'A', depth: 'foreground', looksAt: 'LOC001' }] } };
    expect(IB.checkCarriedFields({ parentMetadata: parent, rewriteMetadata: { fullData: { characters: [] } } })).toEqual([]);
  });

  it('`hands` is not a carried field — the template makes it a claim about contact', () => {
    const rows = (hands?: boolean) => ({
      fullData: { interactions: [{ character: 'A', object: 'x', action: 'holding', ...(hands === undefined ? {} : { hands }) }] },
    });
    expect(IB.checkCarriedFields({ parentMetadata: rows(true), rewriteMetadata: rows() })).toEqual([]);
  });

  it('the fields the iterateSceneMetadata merge already restores are not demanded again', () => {
    // shot / landmarkView / wornItems / era / aboard / crowdExpected /
    // textZoneDescription are carried in code (images.js). Reporting them here
    // would ask the model to re-supply what the caller has already put back.
    const parent = { fullData: { shot: 'medium', landmarkView: 'exterior', wornItems: [{ id: 'CLO001', state: 'off' }], era: 'modern' } };
    const rewrite = { fullData: {} };
    expect(IB.checkCarriedFields({ parentMetadata: parent, rewriteMetadata: rewrite })).toEqual([]);
  });
});

// ── The mechanical-check half ───────────────────────────────────────────────

describe('which sceneBriefCheck types reach a rewrite', () => {
  it('the admitted set is REVIEWABLE minus the whole-book, text-zone and already-covered types', () => {
    const admitted = new Set<string>([...IB.REINSTATE_TYPES, ...IB.INTRODUCED_TYPES]);
    const excluded = ['vb_state_no_base', 'vb_page_uncited', 'vb_cite_offpage',
      // `shot_widened` compares the plan's shot against the brief's, and on the
      // iterate path the brief's `shot` is not the model's to choose: the
      // iterateSceneMetadata merge carries it over from the parent in code
      // (images.js — the test above pins exactly that). A rewrite therefore
      // cannot answer this finding however it restages the prose, and an
      // unanswerable finding on a paid round is the shape this file exists to
      // keep out. It reaches the scene REVIEW, which authors `shot` itself.
      'shot_widened',
      // The same holds for the `shot` a plate must hold (2026-09-23): it is
      // carried over from the parent in code, so a rewrite cannot answer it.
      'shot_off_plate',
      // Same for the declared light (2026-09-24): a rewrite that states no
      // `timeOfDay` / `weather` gets the parent's put back in code
      // (sceneLight.carryForwardLightInBrief, images.js), so it cannot miss them.
      'light_undeclared',
      // A cover's copy space is locked to its beat's zone on iterate (images.js
      // lockedTextPosition = COVER_TEXT_POSITION), like the text-zone family.
      'cover_text_zone_mismatch',
      'textzone_character_collision', 'textzone_fullwidth_floor', 'textzone_top_floor',
      'textzone_bottom_floor', 'textzone_half_streak'];
    for (const t of SBC.REVIEWABLE) {
      if (excluded.includes(t)) {
        expect(admitted.has(t), `${t} must NOT reach the rewrite`).toBe(false);
      } else {
        expect(admitted.has(t), `${t} is REVIEWABLE and must reach the rewrite`).toBe(true);
      }
    }
    // The diagnostic-only type stays out on both paths.
    expect(admitted.has('object_id_unresolved')).toBe(false);
  });

  it('the reinstatement type fires whatever the parent did; the rest need the parent clean', () => {
    expect([...IB.REINSTATE_TYPES].sort()).toEqual(['cast_unlisted']);
    for (const t of IB.REINSTATE_TYPES) expect(IB.INTRODUCED_TYPES.has(t)).toBe(false);
  });
});

describe('introduced vs inherited, on the stored rounds', () => {
  it('an inherited fault is not put to the rewrite', () => {
    // rts p9: the parent brief declares two separate actions and one object
    // under two pairs of hands. Both survive into the rewrite's shape, and
    // neither is the rewrite's to fix inside a page rewrite.
    const r = ROUNDS.find(x => x.job.endsWith('rts4wqupm') && x.pageNumber === 9)!;
    const parentTypes = SBC.checkPage(
      { pageNumber: r.pageNumber, brief: r.parentBrief, planLine: r.planLine },
      storyOf(r).castNames, storyOf(r).visualBible, {},
    ).map((f: any) => f.type);
    expect(parentTypes).toContain('interaction_multiple_actions');
    expect(parentTypes).toContain('interaction_object_shared_hands');
    expect(checkRewrite(r, { parentBrief: r.parentBrief }).map((f: any) => f.type))
      .not.toContain('interaction_multiple_actions');
  });

  it('without the parent brief no INTRODUCED_TYPES finding is guessed at', () => {
    for (const r of ROUNDS) {
      for (const f of checkRewrite(r)) {
        expect(IB.INTRODUCED_TYPES.has(f.type), `${label(r)} ${f.type} without a parent`).toBe(false);
      }
    }
  });

  it('a fault the parent was free of IS put to the rewrite', () => {
    // Synthetic parent, real rewrite: with a parent that carries no fault at
    // all, every type the rewrite trips becomes introduced.
    const r = ROUNDS.find(x => x.job.endsWith('rts4wqupm') && x.pageNumber === 9)!;
    const withBlankParent = checkRewrite(r, { parentBrief: 'A page with nothing in it.' });
    const withRealParent = checkRewrite(r, { parentBrief: r.parentBrief });
    expect(withBlankParent.length).toBeGreaterThanOrEqual(withRealParent.length);
  });
});

describe('what the widened scope produces on the 11 stored rounds', () => {
  const scope = (r: Round) => [...checkRewrite(r, { parentBrief: r.parentBrief }), ...carried(r)];

  it('every round earns the one corrective re-ask; the reinstate set alone earns none', () => {
    // Before the 2026-09-17 widening the reinstate set alone caught 1 round of
    // 11 — rts p6, element_uncited. That type was removed on 2026-09-18 (it
    // classified by matching prose), so the reinstate set now catches none, and
    // everything the iterate path checks mechanically comes from the widening
    // and from checkDeclaredSet.
    const before = ROUNDS.filter(r => checkRewrite(r).length > 0).length;
    const after = ROUNDS.filter(r => scope(r).length > 0).length;
    expect(before, 'the reinstate set alone').toBe(0);
    expect(after, 'the widened scope').toBe(11);
  });

  it('the citation defects stay with checkDeclaredSet, which already names them', () => {
    // If a future change admits vb_page_uncited / vb_cite_offpage here, this
    // fails and the overlap must be re-measured, not waved through.
    for (const r of ROUNDS) {
      for (const f of scope(r)) {
        expect(['vb_page_uncited', 'vb_cite_offpage'], label(r)).not.toContain(f.type);
      }
    }
  });

  it('the corpus round that used to be element_uncited is still named, by the citation basis', () => {
    // element_uncited is gone (2026-09-18). rts p6 was the only round it named,
    // and checkDeclaredSet names the same page from the parent's own citation
    // list — the artefact the rewrite stopped citing. That is why the removal
    // costs this corpus nothing.
    for (const r of ROUNDS) {
      for (const f of scope(r)) expect(f.type, label(r)).not.toBe('element_uncited');
    }
    const r = ROUNDS.find(x => x.job.endsWith('rts4wqupm') && x.pageNumber === 6)!;
    const parentMeta: any = extractSceneMetadata(r.parentBrief) || {};
    const rewriteMeta: any = extractSceneMetadata(r.rewriteBrief) || {};
    const origObjects = parentMeta.fullData?.objects || parentMeta.objects || [];
    const findings = IB.checkDeclaredSet({
      newMetadata: rewriteMeta,
      ...IB.declaredSetAllowance({ origObjects, rewriteObjects: rewriteMeta.objects, planLine: r.planLine }),
      requiredObjects: origObjects,
    });
    const dropped = findings.find((f: any) => f.type === 'object_dropped_from_declared_set');
    expect(dropped, 'rts p6 must still be named').toBeTruthy();
    expect(dropped.ids).toContain('ART001');
  });

  it('three interaction checks are blind while the field they count is missing', () => {
    // The point of the metadata half: rts p9's rewrite declares MORE
    // interaction rows than its parent and reports no interaction fault,
    // because not one row carries `action`.
    const r = ROUNDS.find(x => x.job.endsWith('rts4wqupm') && x.pageNumber === 9)!;
    const rows = (brief: string) => {
      const m = extractSceneMetadata(brief) || {};
      return (m.fullData?.interactions || m.interactions || []).filter((x: any) => x && typeof x === 'object');
    };
    const parentRows = rows(r.parentBrief);
    const rewriteRows = rows(r.rewriteBrief);
    expect(rewriteRows.length).toBeGreaterThan(parentRows.length);
    expect(parentRows.filter((x: any) => x.action).length).toBe(parentRows.length);
    expect(rewriteRows.filter((x: any) => x.action).length).toBe(0);
    expect(carried(r)[0].fields).toContain('interactions[].action');
  });
});
