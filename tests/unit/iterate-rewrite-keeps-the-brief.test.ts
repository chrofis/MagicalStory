/**
 * A REWRITE MUST NOT EMPTY THE PROMPT.
 *
 * Measured on staging job_1789584708605_rts4wqupm ("Das Ei unter der Wurzel",
 * 18 pages, commit 434ea1e8). All SIX iterate rewrites came back with
 * `wornItems: []`; two of them (p6, p16) also stopped citing the artefact their
 * page is about; five appended a facet suffix the Visual Bible does not
 * declare. p16's shipped prompt rendered a REQUIRED OBJECTS heading with
 * nothing under it and shipped at -12, its surviving critical reading "Levin is
 * not holding the bundled red fleece jacket against his chest with both hands".
 *
 * Four rules, all structural (ids, facet arrays, name sets — never prose):
 *   A1 the parent brief's metadata reaches the iterate, so `wornItems` survives
 *   A2 a citation the parent made may be reordered, never dropped
 *   A3 a cited facet the bible does not declare falls back to the bare id
 *   A4 the object list can never resolve to nothing the checklist can print
 *
 * Plus the three plumbing faults measured on the same run: the audit-granted
 * extra repair round that ignored the configured budget (B), the "none" answer
 * parsed as a commissioned character (C2), and the two version fields the
 * round whitelist dropped (D).
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

const require_ = createRequire(import.meta.url);
const { carryForwardWornItems, resolveWornItemsForPage } = require_('../../server/lib/wornItems');
const { checkDeclaredSet, normalizeCitedHandles, carryParentObjects } = require_('../../server/lib/iterateBeat');
const { extractSceneMetadata } = require_('../../server/lib/sceneMetadata');
const { planBookAuditRound } = require_('../../server/lib/repairLogic');
const { parseStoryLogic, buildImagePrompt } = require_('../../server/lib/promptBuilders');

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

// ── The run's REAL Visual Bible entries (ids, facets and page tables verbatim) ─
const ART001 = {
  id: 'ART001', name: 'smooth egg', label: 'dragon egg', type: 'artifact',
  description: 'melon-sized oval egg with a smooth curved shell',
  scaleClass: 'melon-sized', appearsInPages: [3, 4, 5, 6, 7, 9, 11, 12, 13, 14, 15, 16],
  pages: [3, 4, 5, 6, 7, 9, 11, 12, 13, 14, 15, 16],
  states: [
    { id: 'ART001.1', name: 'unaltered', delta: 'pale orange, smooth, glowing faintly from within', pages: [3, 4, 5, 6, 7, 9, 11, 12, 13, 14, 15, 16] },
    { id: 'ART001.2', name: 'cold', delta: 'pale orange, smooth, matte and dark', pages: [] },
    { id: 'ART001.3', name: 'cracked', delta: 'pale orange shell broken in half, hollow empty interior', pages: [] },
  ],
};
const ART004 = {
  id: 'ART004', name: 'fleece jacket', label: 'red jacket', type: 'outer layer',
  description: 'red fleece fabric garment with a full front zipper',
  scaleClass: 'forearm-sized', appearsInPages: [7, 9, 10, 15, 16, 17, 18],
  pages: [7, 9, 10, 15, 16, 17, 18], wornAs: 'Levin.top',
  states: [
    { id: 'ART004.1', name: 'unaltered', delta: 'red zip-up fleece jacket with ribbed cuffs', pages: [7, 9, 10] },
    { id: 'ART004.2', name: 'bundled', delta: 'red fleece jacket rolled and wrapped tightly into a round fabric bundle', pages: [15, 16, 17, 18] },
  ],
};
const LOC001 = {
  id: 'LOC001', name: 'Lindenhof', label: 'Lindenhof', description: 'a wide gravel square under linden trees',
  scaleClass: 'landmark', appearsInPages: [1, 2, 3, 4, 5, 6, 7, 8, 17, 18],
  pages: [1, 2, 3, 4, 5, 6, 7, 8, 17, 18], states: [], vantages: [],
};
const LOC002 = {
  id: 'LOC002', name: 'Altstadt lanes', label: 'Altstadt lanes',
  description: 'outdoor, narrow street. cobblestone paths, steep stone stairs.',
  scaleClass: 'landmark', appearsInPages: [9, 10, 11, 16], pages: [9, 10, 11, 16], states: [], vantages: [],
};
const CHR001 = {
  id: 'CHR001', name: 'Ramon', description: 'a boy, slightly tall for his age',
  pages: [11, 13, 17], appearsInPages: [11, 13, 17], states: [],
};

const visualBible = {
  mainCharacters: [{ id: 'MCH001', name: 'Levin' }],
  secondaryCharacters: [CHR001],
  animals: [], vehicles: [], clothing: [],
  artifacts: [ART001, ART004],
  locations: [LOC001, LOC002],
};

// p16's real Art Director brief metadata, and its real iterate-round-1 rewrite.
const P16_CAST = [
  { name: 'Levin', clothing: 'standard', position: 'center foreground', depth: 'foreground' },
  { name: 'Kiaan', clothing: 'standard', position: 'right midground', depth: 'midground' },
  { name: 'Julian', clothing: 'standard', position: 'left midground', depth: 'midground' },
];
const P16_PARENT_META = {
  sceneIntent: 'Levin, Kiaan and Julian climb the dark stone stairs keeping the bundled jacket pressed between them.',
  characters: P16_CAST, shot: 'medium',
  objects: ['LOC002', 'ART001', 'ART004.2'],
  wornItems: [{ id: 'ART004', owner: 'Levin', state: 'off', location: "carried as a bundle in Levin's arms" }],
  textPosition: 'bottom-left',
};
const P16_REWRITE_META = {
  sceneIntent: 'The three boys press the bundle between them on the dark stairs.',
  characters: P16_CAST, shot: 'medium',
  objects: ['LOC002.1', 'ART004.2'], wornItems: [],
  textPosition: 'bottom-left',
};
const brief = (meta: any, prose = 'Three boys climb the dark stone stairs pressing a bundle between them.') =>
  `${prose}\n\n---METADATA---\n${JSON.stringify(meta)}`;

describe('A1 — wornItems survive an iterate round', () => {
  it("p16: the parent brief's OFF row is carried into a rewrite that emitted none", () => {
    const parent = extractSceneMetadata(brief(P16_PARENT_META));
    const rewrite = extractSceneMetadata(brief(P16_REWRITE_META));
    expect(rewrite.wornItems).toEqual([]);
    const carried = carryForwardWornItems(rewrite, parent);
    expect(carried).toHaveLength(1);
    expect(carried[0]).toMatchObject({ id: 'ART004', owner: 'Levin', state: 'off' });
  });

  it('the carried row resolves to OFF, not to the default "worn"', () => {
    // This is the whole damage: with no row, resolveWornItemsForPage defaults
    // the item to worn, the prompt says "Levin IS wearing this", and the
    // REQUIRED OBJECTS line is dropped as already shown by the reference.
    const parent = extractSceneMetadata(brief(P16_PARENT_META));
    const carried = carryForwardWornItems(extractSceneMetadata(brief(P16_REWRITE_META)), parent);
    const resolved = resolveWornItemsForPage(visualBible, P16_CAST, { ...P16_REWRITE_META, wornItems: carried }, { pageNumber: 16 });
    expect(resolved.map((r: any) => [r.id, r.state])).toEqual([['ART004', 'off']]);
  });

  it('WITHOUT the carry, the same page resolves the jacket back onto Levin', () => {
    const resolved = resolveWornItemsForPage(visualBible, P16_CAST, P16_REWRITE_META, { pageNumber: 16 });
    expect(resolved.map((r: any) => [r.id, r.state])).toEqual([['ART004', 'worn']]);
  });

  it('THE HOLE — the repair pipeline hands the iterate the page brief metadata', () => {
    // `pipelineStoryData.sceneImages` is a whitelist; without this key
    // `savedScene.sceneMetadata` was `{}` on every pipeline iterate, so
    // carryForwardWornItems had nothing to carry FROM.
    expect(read('storyJobPipeline.js')).toContain('sceneMetadata: r.sceneMetadata || null');
  });

  it('…and iteratePageCore falls back to the page brief when that row has none', () => {
    const src = read('server/lib/images.js');
    expect(src).toContain('const parentSceneMetadata = savedScene?.sceneMetadata || sceneMetadata || {};');
    expect(src).toContain('const savedMeta = parentSceneMetadata;');
    expect(src).not.toContain('const savedMeta = savedScene?.sceneMetadata || {};');
  });
});

describe('A2 — a citation the parent made is never dropped', () => {
  const check = (rewriteObjects: any[], rewriteCharacters: any[], requiredObjects: string[]) =>
    checkDeclaredSet({
      newMetadata: { objects: rewriteObjects, characters: rewriteCharacters },
      allowedObjects: [...requiredObjects, ...rewriteObjects],
      allowedNames: rewriteCharacters.map((c: any) => c.name || c),
      requiredObjects,
      nameIds: { Ramon: 'CHR001' },
    });

  it('p16 REGRESSION — the dropped egg is a finding that names the id', () => {
    const findings = check(['LOC002.1', 'ART004.2'], P16_CAST, ['LOC002', 'ART001', 'ART004.2']);
    const dropped = findings.find((f: any) => f.type === 'object_dropped_from_declared_set');
    expect(dropped).toBeTruthy();
    expect(dropped.ids).toEqual(['ART001']);
  });

  it('p6 REGRESSION — a rewrite left with only a location loses the egg', () => {
    const findings = check(['LOC001.1'], [{ name: 'Levin' }, { name: 'Julian' }], ['ART001.1', 'LOC001']);
    expect(findings.find((f: any) => f.type === 'object_dropped_from_declared_set').ids).toEqual(['ART001']);
  });

  it('NEGATIVE CONTROL — p13 refiled CHR001 as the NAME Ramon; that is not a drop', () => {
    const findings = check(
      ['LOC003.2', 'ART001.2', 'ART002.2'],
      [{ name: 'Ramon' }, { name: 'Levin' }],
      ['LOC003', 'ART001', 'ART002.2', 'CHR001'],
    );
    expect(findings.filter((f: any) => f.type === 'object_dropped_from_declared_set')).toEqual([]);
  });

  it('NEGATIVE CONTROL — reordering the same ids is allowed', () => {
    expect(check(['ART004.1', 'LOC002.1', 'ART001.1'], [{ name: 'Levin' }], ['ART001.1', 'ART004.1', 'LOC002'])).toEqual([]);
  });

  it('it feeds the ONE corrective re-ask that already exists — no second call', () => {
    const src = read('server/lib/images.js');
    // Since 2026-09-17 that re-ask is the shared one (briefCorrection), and it
    // answers the declaration and declared-set families together.
    expect((src.match(/usageLabel: 'scene_iterate_correct'/g) || []).length).toBe(1);
    expect((src.match(/correctFindings\(\{/g) || []).length).toBe(1);
    expect(src).toContain('args.requiredObjects = origObjects;');
  });
});

describe('A3 — a cited facet the bible does not declare falls back to the bare id', () => {
  it('LOC001.1 / LOC002.1: the location entries have no vantages at all', () => {
    const out = normalizeCitedHandles({ objects: ['LOC001.1', 'LOC002.1'], visualBible });
    expect(out.objects).toEqual(['LOC001', 'LOC002']);
    expect(out.rejected.map((r: any) => r.handle)).toEqual(['LOC001.1', 'LOC002.1']);
  });

  it('ART001.2: the state exists but its pages[] is empty, so it covers nothing', () => {
    const out = normalizeCitedHandles({ objects: ['ART001.2'], visualBible });
    expect(out.objects).toEqual(['ART001']);
    expect(out.rejected[0].reason).toBe('that facet covers no page');
  });

  it('NEGATIVE CONTROL — a real, page-covering facet is left exactly as cited', () => {
    const out = normalizeCitedHandles({ objects: ['ART001.1', 'ART004.2'], visualBible });
    expect(out.objects).toEqual(['ART001.1', 'ART004.2']);
    expect(out.rejected).toEqual([]);
  });

  it('NEGATIVE CONTROL — a citation that is not a bible id passes through untouched', () => {
    expect(normalizeCitedHandles({ objects: ['a pile of leaves'], visualBible }).objects).toEqual(['a pile of leaves']);
  });
});

describe('A4 — REQUIRED OBJECTS is never a heading with nothing under it', () => {
  const buildP16 = (meta: any) => buildImagePrompt(
    brief(meta), { language: 'de-ch', artStyle: 'pixar', layout: { textInImage: true } },
    null, visualBible, 16, null, {},
  ) as string;
  const block = (prompt: string) => {
    const i = prompt.indexOf('**REQUIRED OBJECTS');
    return i < 0 ? '' : prompt.slice(i, i + 900);
  };

  it('p16 REGRESSION — the shipped rewrite must not produce a heading with no entries', () => {
    // The exact shipped shape: the objects resolve to one location plus a
    // jacket that the lost wornItems resolved back to "worn" — and a worn item
    // whose reference carries it is omitted from the checklist by design.
    // Either the heading is followed by a real entry, or there is no heading.
    expect(buildP16(P16_REWRITE_META)).not.toMatch(/\*\*REQUIRED OBJECTS[^\n]*\n(?!\* )/);
  });

  it('with the parent brief carried forward, the jacket IS listed, with where it is', () => {
    const carried = carryForwardWornItems(
      extractSceneMetadata(brief(P16_REWRITE_META)),
      extractSceneMetadata(brief(P16_PARENT_META)),
    );
    const b = block(buildP16({ ...P16_REWRITE_META, wornItems: carried }));
    expect(b).toContain('(object)');
    expect(b).toContain("carried as a bundle in Levin's arms");
  });

  it("a rewrite that resolves to no listable element takes the parent's list", () => {
    // p6's shape: the only surviving citation is a location. The 2026-09-23
    // carry-forward (a superset of the 2026-09-17 restore) still covers it.
    const out = carryParentObjects({
      rewriteObjects: ['LOC001.1'], parentObjects: ['ART001.1', 'LOC001'],
    });
    expect(out.carried).toEqual(['ART001.1']);
    expect(out.objects).toEqual(['LOC001.1', 'ART001.1']);
  });

  it('a rewrite that still cites every parent id is untouched, facets included', () => {
    const out = carryParentObjects({
      rewriteObjects: ['LOC002.1', 'ART004.2', 'ART001'], parentObjects: ['LOC002', 'ART001', 'ART004.2'],
    });
    expect(out.carried).toEqual([]);
    expect(out.objects).toEqual(['LOC002.1', 'ART004.2', 'ART001']);
  });

  it('the prompt builder itself can never emit the bare heading', () => {
    expect(read('server/lib/promptBuilders.js')).toContain('if (!/^\\* /m.test(requiredObjectsSection)) {');
  });
});

describe('B — the round loop stops at the configured cap, audit grant included', () => {
  it('STAGING REGRESSION — a 1-pass environment grants no extra round', () => {
    // repairMaxPasses is 1 on staging; the round-1 audit is final by
    // construction, and before the budget gate it granted round 2. That round
    // regressed 5 of the 6 pages it touched (p16 -68, p10 -40, p7 -8).
    const plan = planBookAuditRound({ round: 1, roundLimit: 1, bookUnchanged: false, extraRoundUsed: false, finalRound: true, maxPasses: 1 });
    expect(plan.runAudit).toBe(true);
    expect(plan.mayGrantExtraRound).toBe(false);
  });

  it('production keeps its grant when the run converged inside the budget', () => {
    const plan = planBookAuditRound({ round: 2, roundLimit: 2, bookUnchanged: false, extraRoundUsed: false, finalRound: true, maxPasses: 3 });
    expect(plan.mayGrantExtraRound).toBe(true);
  });

  it('…and loses it once the budget is spent', () => {
    const plan = planBookAuditRound({ round: 3, roundLimit: 3, bookUnchanged: false, extraRoundUsed: false, finalRound: true, maxPasses: 3 });
    expect(plan.mayGrantExtraRound).toBe(false);
  });

  it('the pipeline passes the configured budget and clamps the assignment', () => {
    const src = read('server/lib/repairPipeline.js');
    expect(src).toContain('maxPasses: maxRegenAttempts');
    expect(src).toContain('roundLimit = Math.min(round + 1, maxRegenAttempts);');
  });
});

// Since 2026-09-24 the figure lists are the tagged FACTS lines of the arc's
// STORY LOGIC; a negative answer there is still no figure.
const logicWith = (figureLines: string[]) => [
  'STORY LOGIC:',
  'Want and stakes: keep the egg warm.',
  'Opposition: the wind.',
  'Facts:',
  '- Ramon (new) — older rival boy; can run; cannot climb',
  ...figureLines,
  'Central figure: none',
  'Chain:',
  '- because the egg knocks, they keep it',
].join('\n');

describe('C2 — a "none" answer to a figure line is no figure', () => {
  it('the run\'s real line: "- none (the creature in the egg is unnamed in the commission)"', () => {
    const parsed = parseStoryLogic(logicWith(['- none (the creature in the egg is unnamed in the commission) (commissioned)']));
    expect(parsed.commissioned).toEqual([]);
    expect(parsed.invented).toEqual(['Ramon']);
  });

  it('a bare sentinel, and the other explicit negatives', () => {
    for (const line of ['- none (commissioned)', '- None. (commissioned)', '- nobody (commissioned)', '- n/a (commissioned)', '- keine (nothing in the premise) (commissioned)']) {
      expect(parseStoryLogic(logicWith([line])).commissioned, line).toEqual([]);
    }
  });

  it('NEGATIVE CONTROL — a real figure with a parenthetical keeps its name', () => {
    const parsed = parseStoryLogic(logicWith(["- Nia (Max's commissioned dog) (commissioned) — can track"]));
    expect(parsed.commissioned).toEqual(["Nia (Max's commissioned dog)"]);
  });
});

describe('D — the round version whitelist carries the sent prose and the lineage', () => {
  const repair = read('server/lib/repairPipeline.js');

  it('D1 — the per-round version object carries compressedScene', () => {
    // 434ea1e89 wired every OTHER hop; this whitelist dropped it again, so
    // originals stamped and all six iterate versions stored null.
    expect(repair).toContain('compressedScene: repairResult.compressedScene || null');
  });

  it('D2 — parentSource round-trips through the round object AND buildVersionEntry', () => {
    expect(repair).toContain('parentSource: repairResult.parentSource || null');
    expect(repair).toContain('parentSource: v.parentSource || null');
  });
});
