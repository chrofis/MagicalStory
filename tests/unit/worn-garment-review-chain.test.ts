import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

// The chain that cost p12 of staging job_1790100385959_1nitlympp (score 10):
// the element budget counted worn garments the reference picker never packs,
// the scene review "dropped" one by deleting its `off` wornItems row, the
// missing row resolved to WORN, and Max was drawn twice in the sweatshirt the
// page had taken off him. Plus the sibling defect of the same stage: a
// same-garment rewording of an outfit clause rebuilt two avatar sheets.

const nodeRequire = createRequire(import.meta.url);
const vbMod: any = nodeRequire('../../server/lib/visualBible.js');
const { rankPageElements, checkVbElementBudget }: any = nodeRequire('../../server/lib/vbElementBudget.js');
const { checkBiblePageTable }: any = nodeRequire('../../server/lib/sceneBriefCheck.js');
const worn: any = nodeRequire('../../server/lib/wornItems.js');
const { checkWardrobeAgainstBible, applyWardrobeBibleCorrections }: any = nodeRequire('../../server/lib/clothingCheck.js');

// Page 12 of the run, reduced to its shape: two creatures, three outer layers,
// each linked to its owner's outfit; the gilet and the sweatshirt are OFF, the
// fleece is worn by its owner.
function makeVb() {
  return {
    animals: [
      { id: 'ANI001', name: 'dog', referenceImageUrl: 'https://x/ani1.jpg', appearsInPages: [12] },
      { id: 'ANI002', name: 'dragon', referenceImageUrl: 'https://x/ani2.jpg', appearsInPages: [12] },
    ],
    artifacts: [
      { id: 'ART004', name: 'rust-brown quilted gilet', label: 'quilted gilet', wornAs: 'Kiaan.outer layer', type: 'outerwear', referenceImageUrl: 'https://x/a4.jpg', appearsInPages: [12] },
      { id: 'ART005', name: 'purple hooded sweatshirt', label: 'hooded sweatshirt', wornAs: 'Max.outer layer', type: 'outerwear', referenceImageUrl: 'https://x/a5.jpg', appearsInPages: [12] },
      { id: 'ART006', name: 'forest green fleece jacket', label: 'fleece jacket', wornAs: 'Levin.outer layer', type: 'outerwear', referenceImageUrl: 'https://x/a6.jpg', appearsInPages: [12] },
    ],
  };
}
const ROWS = [
  { id: 'ART004', owner: 'Kiaan', state: 'off', location: 'lies on the ground' },
  { id: 'ART005', owner: 'Max', state: 'off', location: 'lies on the ground' },
  { id: 'ART006', owner: 'Levin', state: 'worn' },
];
const meta = (wornItems: any[] = ROWS) => ({
  characters: ['Max', 'Levin', 'Kiaan', 'Julian'].map(name => ({ name })),
  objects: ['ANI001', 'ANI002'],
  interactions: [],
  wornItems,
});

describe('the element budget counts what the picker packs', () => {
  it('a garment worn by its own owner is not an element; an OFF garment still is', () => {
    const ids = rankPageElements(12, meta(), makeVb()).map((r: any) => r.id);
    expect(ids).not.toContain('ART006');
    expect(ids).toEqual(expect.arrayContaining(['ANI001', 'ANI002', 'ART004', 'ART005']));
    expect(checkVbElementBudget(12, meta(), makeVb())).toBeNull();
  });

  it('counter and picker select the same set (one predicate)', () => {
    const v = makeVb();
    const counted = rankPageElements(12, meta(), v).map((r: any) => r.id).sort();
    const picked = vbMod.getElementReferenceImagesForPage(v, 12, 99, ['ANI001', 'ANI002'], meta())
      .map((r: any) => String(r.id).toUpperCase()).sort();
    expect(counted).toEqual(picked);
  });

  it('a garment handed to another character is packed, so it counts', () => {
    const rows = [{ id: 'ART006', owner: 'Levin', state: 'worn', wearer: 'Max' }];
    const ids = rankPageElements(12, meta(rows), makeVb()).map((r: any) => r.id);
    expect(ids).toContain('ART006');
  });

  it('with no cast on the metadata nothing is excluded (nothing can be carried)', () => {
    const ids = rankPageElements(12, { objects: ['ANI001'], interactions: [] }, makeVb()).map((r: any) => r.id);
    expect(ids).toContain('ART006');
  });
});

describe('a wornItems row is the garment\'s page presence', () => {
  it('no vb_page_uncited for a garment the page declares a row for', () => {
    const v = makeVb();
    const page = { pageNumber: 12 };
    const withRows = checkBiblePageTable(page, meta(), v).filter((f: any) => f.type === 'vb_page_uncited');
    expect(withRows).toHaveLength(0);
    const without = checkBiblePageTable(page, meta([]), v).filter((f: any) => f.type === 'vb_page_uncited');
    expect(without[0].ids).toEqual(expect.arrayContaining(['ART004', 'ART005', 'ART006']));
  });
});

describe('a rewrite changes a worn state by restating the row, never by omission', () => {
  it('a row the rewrite omits is carried per id; restated rows win', () => {
    const fresh = [{ id: 'ART004', owner: 'Kiaan', state: 'off', location: 'in a heap' }, { id: 'ART006', owner: 'Levin', state: 'worn' }];
    const out = worn.carryForwardWornItems({ wornItems: fresh }, { wornItems: ROWS });
    expect(out.find((r: any) => r.id === 'ART004').location).toBe('in a heap');
    expect(out.find((r: any) => r.id === 'ART005')).toEqual(ROWS[1]);
    expect(out).toHaveLength(3);
  });

  const brief = (rows: any[]) => `Max, Levin and Kiaan dig in the leaves.\n\n---METADATA---\n${JSON.stringify({ ...meta(rows) })}`;

  it('the brief form restores the dropped OFF row and the prompt keeps the garment off', () => {
    const before = brief(ROWS);
    const after = brief([ROWS[0], ROWS[2]]);
    const carry = worn.carryForwardWornItemsInBrief(after, before);
    expect(carry.carried).toEqual(['ART005']);
    const { extractSceneMetadata } = nodeRequire('../../server/lib/sceneMetadata.js');
    const lines = (m: any) => worn.buildWornStateLines(worn.resolveWornItemsForPage(makeVb(), ['Max', 'Levin', 'Kiaan'], m, { pageNumber: 12 })).join('\n');
    expect(lines(extractSceneMetadata(after))).toMatch(/Max IS wearing this/);          // the bug
    expect(lines(extractSceneMetadata(carry.brief))).toMatch(/Max is NOT wearing this/); // the fix
  });

  it('an untouched brief is left byte-identical', () => {
    expect(worn.carryForwardWornItemsInBrief(brief(ROWS), brief(ROWS))).toBeNull();
  });
});

describe('the post-review clothing re-check runs on every reviewed run', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'server/lib/beatsPipeline.js'), 'utf8');
  it('is no longer gated on pre-review findings', () => {
    expect(src).not.toContain('if (clothingByPage && clothingByPage.size > 0) {');
  });
  it('both review adopt points keep the declared rows', () => {
    expect(src).toContain("keepDeclaredWornRows(x.pageNumber, reviewed, x.brief, 'scene review', gl)");
    expect(src).toContain("keepDeclaredWornRows(x.pageNumber, reworn, x.brief, 'worn-state round', gl)");
  });
});

describe('a same-garment rewording is not a wardrobe change', () => {
  // The run's own words: the wardrobe said the short form, the bible's wornAs
  // entry restated it longer.
  const reqs = () => ({
    Levin: { standard: { used: true, description: 'A red long-sleeve shirt, mid-blue denim jeans with a straight leg, dark grey lace-up sneakers, and a forest green zip-up fleece jacket.' } },
  });
  const bible = (description: string, name = 'forest green fleece jacket') => ({
    artifacts: [{ id: 'ART006', name, label: 'fleece jacket', wornAs: 'Levin.outer layer', type: 'outerwear', pages: [1], description }],
  });

  it('same garment, same colours: restated, flagged as a rewording', () => {
    const f = checkWardrobeAgainstBible(reqs(), bible('forest green long-sleeve zip-up fleece jacket with a high collar'));
    expect(f).toHaveLength(1);
    expect(f[0].kind).toBe('reconcile');
    expect(f[0].rewording).toBe(true);
    const r: any = reqs();
    const { applied } = applyWardrobeBibleCorrections(r, bible('forest green long-sleeve zip-up fleece jacket with a high collar'), { log: { warn: () => {} } });
    expect(applied[0].rewording).toBe(true);
    expect(r.Levin.standard.description).toContain('high collar');   // the Visual Bible still owns the words
  });

  it('a colour change is a visible change', () => {
    const f = checkWardrobeAgainstBible(reqs(), bible('red zip-up fleece jacket with a high collar', 'red fleece jacket'));
    expect(f[0].rewording).toBe(false);
  });

  it('a different garment in the slot is a visible change', () => {
    const f = checkWardrobeAgainstBible(reqs(), bible('forest green hooded parka', 'forest green parka'));
    expect(f[0].rewording).toBe(false);
  });

  it('only visible changes reach the avatar re-render hook', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'server/lib/beatsPipeline.js'), 'utf8');
    expect(src).toContain('const visibleChanges = applied.filter(f => !f.rewording);');
    expect(src).toContain('const names = [...new Set(visibleChanges.map(f => f.character).filter(Boolean))];');
  });
});

describe('the wardrobe-vs-bible check finds a linked garment by its own words, and keeps the joiner', () => {
  // Max's outfit and ART005 from the run: "sweatshirt" is in no slot-noun list
  // and the entry is typed "outerwear", so it used to get no slot and was never
  // compared.
  const MAX = 'A white long-sleeve shirt, dark navy blue jogger trousers with a ribbed cuff at the ankle, white sneakers, and a purple hooded sweatshirt with a kangaroo pocket at the front.';
  const reqs = () => ({ Max: { standard: { used: true, description: MAX } } });
  const bible = (description: string) => ({
    artifacts: [{ id: 'ART005', name: 'purple hooded sweatshirt', label: 'hooded sweatshirt', wornAs: 'Max.outer layer', type: 'outerwear', pages: [4], description }],
  });

  it('a garment no slot noun names is compared through its link', () => {
    const f = checkWardrobeAgainstBible(reqs(), bible('purple long-sleeve hooded sweatshirt with a kangaroo pocket at the front and a thick hood'));
    expect(f).toHaveLength(1);
    expect(f[0].slot).toBe('outer layer');
    expect(f[0].wardrobeClause).toBe('and a purple hooded sweatshirt with a kangaroo pocket at the front');
    expect(f[0].rewording).toBe(true);
  });

  it('the restated clause keeps its "and a", and a second pass finds nothing', () => {
    const r: any = reqs();
    const v = bible('purple long-sleeve hooded sweatshirt with a kangaroo pocket at the front and a thick hood');
    applyWardrobeBibleCorrections(r, v, { log: { warn: () => {} } });
    expect(r.Max.standard.description).toContain('white sneakers, and a purple long-sleeve hooded sweatshirt');
    expect(checkWardrobeAgainstBible(r, v)).toHaveLength(0);
  });

  it('a replacement bringing its own article does not double it', () => {
    const r: any = reqs();
    applyWardrobeBibleCorrections(r, bible('a purple hooded sweatshirt with a zip'), { log: { warn: () => {} } });
    expect(r.Max.standard.description).toContain('white sneakers, and a purple hooded sweatshirt with a zip.');
    expect(r.Max.standard.description).not.toMatch(/\ba a\b/);
  });

  it('a linked garment whose words match no clause still displaces the slot occupant (a visible change)', () => {
    const v = { artifacts: [{ id: 'ART005', name: 'yellow rain parka', label: 'rain parka', wornAs: 'Max.outer layer', type: 'outerwear', pages: [4], description: 'yellow rain parka' }] };
    const r = { Max: { standard: { used: true, description: 'A white shirt, blue trousers, and a green jacket.' } } };
    const f = checkWardrobeAgainstBible(r, v);
    expect(f).toHaveLength(1);
    expect(f[0].wardrobeClause).toBe('and a green jacket');
    expect(f[0].rewording).toBe(false);
  });
});
