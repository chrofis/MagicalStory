/**
 * THE BIBLE'S PAGE TABLE AGAINST THE BRIEFS' CITATIONS
 * (sceneBriefCheck.checkBiblePageTable, 2026-09-17).
 *
 * scene-expansion-all.txt tells the Art Director, verbatim, that "An entry's
 * `pages` and the `objects[]` of the page briefs below say the same thing".
 * Both halves come out of one call and nothing compared them.
 *
 * Every fixture below is trimmed from a real staging story — the ids, the page
 * tables and the `objects[]` rows are the stored values, not invented shapes.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const { checkBiblePageTable, checkPage, REVIEWABLE } = require_('../../server/lib/sceneBriefCheck');

const typesOf = (f: any[]) => f.map((x: any) => x.type);
const idsFor = (f: any[], type: string) =>
  f.filter((x: any) => x.type === type).flatMap((x: any) => x.ids || []);

// ── job_1789147573901_m3uam0nxi (staging, 2026-09-11) ───────────────────────
// The Art-Director-authored bible. ART001 is Levin's Velolampe, ART011/12/13
// the three bikes, ART005/ART006 the two sides of one signpost, LOC005 the
// stone path, ANI001 the dog.
function lampStory(): any {
  return {
    secondaryCharacters: [],
    animals: [{ id: 'ANI001', name: 'Nia', pages: [6, 7, 8, 10, 11, 12, 13, 14, 15, 18] }],
    vehicles: [],
    clothing: [],
    artifacts: [
      { id: 'ART001', name: "Levin's Velolampe", pages: [1, 2, 3, 16] },
      { id: 'ART005', name: 'Wegweiser (signpost, turned away)', pages: [10] },
      { id: 'ART006', name: 'Wegweiser (signpost, face to camera)', pages: [] },
      { id: 'ART011', name: "Levin's Velo", pages: [1, 2, 9] },
      { id: 'ART012', name: "Julian's Velo", pages: [2, 9] },
    ],
    locations: [
      { id: 'LOC002', name: 'Hügelstrasse nach dem Berg', pages: [2] },
      { id: 'LOC003', name: 'Höhleneingang', pages: [3, 4, 5, 6, 7, 8, 9] },
      { id: 'LOC005', name: 'Steinpfad mit Stufen', pages: [11] },
    ],
  };
}

describe('checkBiblePageTable — the bible claims a page the brief never cites', () => {
  it('names the entry whose `pages` holds this page while objects[] does not', () => {
    // p2 as stored: objects ["LOC002","ART011","ART012"]. ART001's table claims
    // p2 — the lamp is clipped to the bike and the plan line makes nothing of it.
    const f = checkBiblePageTable(
      { pageNumber: 2 },
      { objects: ['LOC002', 'ART011', 'ART012'], characters: [{ name: 'Levin' }, { name: 'Julian' }] },
      lampStory(),
    );
    expect(typesOf(f)).toEqual(['vb_page_uncited']);
    expect(idsFor(f, 'vb_page_uncited')).toEqual(['ART001']);
  });

  it('resolves a dotted state handle through its parent before deciding', () => {
    // p3 cites ART001.2 — a facet of ART001, whose table holds p3. No finding.
    const f = checkBiblePageTable(
      { pageNumber: 3 },
      { objects: ['LOC003', 'ART001.2'], characters: [{ name: 'Levin' }] },
      lampStory(),
    );
    expect(f).toEqual([]);
  });

  it('reads a labelled prose citation, not only a bare id', () => {
    // The trial writer emits `name [ID]` rows (staging job_1789296188291_thezv15y1).
    const f = checkBiblePageTable(
      { pageNumber: 2 },
      { objects: ['Hügelstrasse [LOC002]', "Levin's Velo [ART011]", "Julian's Velo [ART012]", 'Velolampe [ART001.2]'], characters: [] },
      lampStory(),
    );
    expect(f).toEqual([]);
  });

  it('treats a figure on the roster as cited, and never as a citation of its own', () => {
    // job_1789163494908_kc2joi4ax p2: the cast row "Mother" and the bible entry
    // "Mother Dragon" are one name under isSameFigureName. A name may SUPPRESS
    // an absence; reading it as a citation reported the creature off-page.
    const vb = {
      animals: [{ id: 'ANI002', name: 'Mother Dragon', pages: [5, 6, 13, 18] }],
      artifacts: [], locations: [], vehicles: [], clothing: [], secondaryCharacters: [],
    };
    const f = checkBiblePageTable(
      { pageNumber: 2 },
      { objects: ['LOC001', 'ART001'], characters: [{ name: 'Mother' }, { name: 'Levin' }] },
      vb,
    );
    expect(f).toEqual([]);
  });
});

describe('checkBiblePageTable — the brief cites a page the bible leaves out', () => {
  it('names the entry whose `pages` excludes this page', () => {
    // p5 as stored: objects ["LOC003","ART001.1","ANI002.1"], and the plan line
    // puts the lamp in Levin's hand. ART001's table is [1,2,3,16] — the bible
    // is the half that is wrong, and the reviewer holds the plan line.
    const f = checkBiblePageTable(
      { pageNumber: 5 },
      { objects: ['LOC003', 'ART001.1'], characters: [{ name: 'Levin' }] },
      lampStory(),
    );
    expect(typesOf(f)).toEqual(['vb_cite_offpage']);
    expect(idsFor(f, 'vb_cite_offpage')).toEqual(['ART001']);
  });

  it('reports both directions on one page, as two findings', () => {
    // p9 as stored: objects ["LOC005","ART011","ANI001"]. LOC003's range runs a
    // page long (it claims p9) while the brief has moved to LOC005, which the
    // bible gives only p11 — and Nia, whose table skips p9.
    const f = checkBiblePageTable(
      { pageNumber: 9 },
      { objects: ['LOC005', 'ART011', 'ANI001'], characters: [{ name: 'Levin' }] },
      lampStory(),
    );
    expect(typesOf(f).sort()).toEqual(['vb_cite_offpage', 'vb_page_uncited']);
    expect(idsFor(f, 'vb_page_uncited').sort()).toEqual(['ART012', 'LOC003']);
    expect(idsFor(f, 'vb_cite_offpage').sort()).toEqual(['ANI001', 'LOC005']);
  });
});

describe('checkBiblePageTable — what it deliberately does not claim', () => {
  it('an entry with an empty `pages` is unknown, in both directions', () => {
    // ART006 (the signpost face the story needs) carries no page at all. It is
    // cited on p10 and it is absent from every other page's citations, and
    // neither is reported: an empty table cannot disagree with anything.
    const vb = lampStory();
    const cited = checkBiblePageTable({ pageNumber: 10 }, { objects: ['LOC004', 'ART006'], characters: [] }, vb);
    expect(idsFor(cited, 'vb_cite_offpage')).not.toContain('ART006');
    const uncited = checkBiblePageTable({ pageNumber: 4 }, { objects: ['LOC003'], characters: [] }, vb);
    expect(idsFor(uncited, 'vb_page_uncited')).not.toContain('ART006');
  });

  it('a clothing entry is never expected in objects[]', () => {
    // job_1789348171785_9oxos7dwv: CLO001 ("red zip-up hoodie") claims p8 and
    // p10 and no brief cites it — a CLO reaches the page through the wearer's
    // clothing contract. 104 findings across the corpus were this shape.
    const vb = {
      clothing: [{ id: 'CLO001', name: 'red zip-up hoodie', pages: [8, 10] }],
      artifacts: [{ id: 'ART001', name: 'large stone-like egg', pages: [8] }],
      animals: [], locations: [], vehicles: [], secondaryCharacters: [],
    };
    const f = checkBiblePageTable({ pageNumber: 8 }, { objects: ['ART001'], characters: [{ name: 'Levin' }] }, vb);
    expect(f).toEqual([]);
  });

  it('a bible with no page tables at all produces nothing', () => {
    const vb = {
      artifacts: [{ id: 'ART001', name: 'a prop' }],
      animals: [], locations: [], vehicles: [], clothing: [], secondaryCharacters: [],
    };
    expect(checkBiblePageTable({ pageNumber: 1 }, { objects: [], characters: [] }, vb)).toEqual([]);
    expect(checkBiblePageTable({ pageNumber: 1 }, { objects: [], characters: [] }, null)).toEqual([]);
  });
});

// ── job_1789584708605_rts4wqupm (staging, 2026-09-16) ───────────────────────
// The run that motivated the check. The bible as SHIPPED has been through
// applyBriefUsage, which rebuilt the state rows from the same briefs — so the
// two tables agree by construction on the stored copy, and the check is silent.
// The AUTHORED table (recorded verbatim in 3f8ebb21f: unaltered [3-13], cold
// [14,15], cracked [18]) is what the check actually sees, at the point it runs.
const EGG_BRIEFS: Record<number, string[]> = {
  3: ['ART001.1', 'LOC001'], 4: ['ART001.1', 'LOC001'], 5: ['ART001.1', 'LOC001'],
  6: ['ART001.1', 'LOC001'], 7: ['ART001.1', 'ART002.1', 'ART004.1', 'LOC001'],
  8: ['LOC001'], 9: ['ART001.1', 'ART004.1', 'LOC002'], 10: ['ART002.2', 'ART004.1', 'LOC002'],
  11: ['LOC002', 'ART001', 'CHR001'], 12: ['LOC003', 'LOC004', 'ART001'],
  13: ['LOC003', 'ART001', 'ART002.2', 'CHR001'], 14: ['LOC003', 'ART001'],
  15: ['LOC003', 'ART001', 'ART004.2'], 16: ['LOC002', 'ART001', 'ART004.2'],
  17: ['LOC001', 'ART004.2', 'CHR001'], 18: ['LOC001', 'ANI001', 'ANI002', 'ART004.2'],
  1: ['LOC001'], 2: ['LOC001'],
};
const EGG_CAST: Record<number, string[]> = { 11: ['Levin', 'Ramon'], 13: ['Levin', 'Ramon'], 17: ['Levin', 'Ramon'] };

function eggBible(statePages: number[][]): any {
  return {
    secondaryCharacters: [{ id: 'CHR001', name: 'Ramon', pages: [11, 13, 17] }],
    animals: [{ id: 'ANI001', name: 'Big Dragon', pages: [18] }, { id: 'ANI002', name: 'Flämmli', pages: [18] }],
    vehicles: [], clothing: [],
    artifacts: [
      {
        id: 'ART001', name: 'smooth egg', pages: [3, 4, 5, 6, 7, 9, 11, 12, 13, 14, 15, 16],
        states: [
          { id: 'ART001.1', name: 'unaltered', delta: 'pale and warm', pages: statePages[0] },
          { id: 'ART001.2', name: 'cold', delta: 'grey and dull', pages: statePages[1] },
          { id: 'ART001.3', name: 'cracked', delta: 'a split down one side', pages: statePages[2] },
        ],
      },
      { id: 'ART002', name: 'paper bag', pages: [7, 10, 13], states: [
        { id: 'ART002.1', name: 'unaltered', delta: 'upright', pages: [7] },
        { id: 'ART002.2', name: 'flat', delta: 'folded flat', pages: [10, 13] }] },
      { id: 'ART003', name: 'push scooter', pages: [] },
      { id: 'ART004', name: 'fleece jacket', pages: [7, 9, 10, 15, 16, 17, 18], states: [
        { id: 'ART004.1', name: 'unaltered', delta: 'worn', pages: [7, 9, 10] },
        { id: 'ART004.2', name: 'bundled', delta: 'bundled under an arm', pages: [15, 16, 17, 18] }] },
    ],
    locations: [
      { id: 'LOC001', name: 'Lindenhof', pages: [1, 2, 3, 4, 5, 6, 7, 8, 17, 18] },
      { id: 'LOC002', name: 'Altstadt lanes', pages: [9, 10, 11, 16] },
      { id: 'LOC003', name: 'Rathausbruecke', pages: [12, 13, 14, 15] },
      { id: 'LOC004', name: 'Grossmuenster', pages: [12] },
    ],
  };
}

function runEggBook(vb: any) {
  const out: any[] = [];
  for (const [pn, objects] of Object.entries(EGG_BRIEFS)) {
    out.push(...checkBiblePageTable(
      { pageNumber: Number(pn) },
      { objects, characters: (EGG_CAST[Number(pn)] || []).map((name) => ({ name })) },
      vb,
    ));
  }
  return out;
}

describe('job_1789584708605_rts4wqupm — the run this check was built for', () => {
  it('is silent on the SHIPPED bible, p14 and p15 included', () => {
    // applyBriefUsage rewrote the state rows from these same briefs after the
    // review, emptying "cold" and "cracked" — which is the bug 3f8ebb21f fixed.
    // The two tables therefore agree on the stored copy: this check is a
    // NEGATIVE control there, and the reason it is not the catcher for that
    // rewrite is that it runs before it.
    const shipped = eggBible([[3, 4, 5, 6, 7, 9, 11, 12, 13, 14, 15, 16], [], []]);
    expect(runEggBook(shipped)).toEqual([]);
    expect(checkBiblePageTable({ pageNumber: 14 }, { objects: EGG_BRIEFS[14], characters: [] }, shipped)).toEqual([]);
    expect(checkBiblePageTable({ pageNumber: 15 }, { objects: EGG_BRIEFS[15], characters: [] }, shipped)).toEqual([]);
  });

  it('names p18 on the AUTHORED bible — the state that claims a page no brief stages', () => {
    // "cracked" claimed p18, where the plan line stages no shell; p18's brief
    // cites the two dragons and the jacket and never the egg.
    const authored = eggBible([[3, 4, 5, 6, 7, 9, 11, 12, 13], [14, 15], [18]]);
    const f = runEggBook(authored);
    expect(f.map((x: any) => `p${x.pageNumber} ${x.type} ${(x.ids || []).join('/')}`)).toEqual(['p18 vb_page_uncited ART001']);
  });
});

describe('wiring', () => {
  it('checkPage raises both types and the review block carries them', () => {
    const f = checkPage(
      { pageNumber: 5, brief: 'Levin stands at the cave with the lamp in his hand.\n---METADATA---\n{}' },
      ['Levin'],
      lampStory(),
      {},
    );
    expect(typesOf(f)).toContain('vb_page_uncited');
    const f2 = checkPage(
      {
        pageNumber: 5,
        brief: 'Levin stands at the cave with the lamp in his hand.',
        metadata: { objects: ['LOC003', 'ART001.1'], characters: [{ name: 'Levin' }] },
      },
      ['Levin'],
      lampStory(),
      {},
    );
    expect(typesOf(f2)).toContain('vb_cite_offpage');
  });

  it('both types are sent to the reviewer', () => {
    expect(REVIEWABLE.has('vb_page_uncited')).toBe(true);
    expect(REVIEWABLE.has('vb_cite_offpage')).toBe(true);
  });
});
