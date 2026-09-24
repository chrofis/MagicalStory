import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// @ts-ignore - CommonJS module
const { applyWardrobeBibleCorrections, checkWardrobeAgainstBible } = require('../../server/lib/clothingCheck');
// @ts-ignore - CommonJS module
const wornItems = require('../../server/lib/wornItems');
const { resolveGeneratedOutfit, resolveWornItemsForPage } = wornItems;
// @ts-ignore - CommonJS module
const wv = require('../../server/lib/wardrobeVariants');
// @ts-ignore - CommonJS module
const { resolveSheetForRef } = require('../../server/lib/storyAvatars');
// @ts-ignore - CommonJS module
const { MODEL_DEFAULTS } = require('../../server/config/models');

/**
 * OUTFIT VERSIONS (owner, 2026-09-24). A garment the Art Director puts on a
 * character in a slot the wardrobe contract already fills with a DIFFERENT
 * garment is a new outfit version with its own sheet. The default outfit is
 * untouched; only the page that needs the garment selects the version.
 */
const MIA = 'A red long-sleeve cotton t-shirt; blue denim jeans; a green zip-up fleece jacket; white canvas sneakers.';
const quiet = { warn: () => {}, info: () => {}, error: () => {} };

const reqs = () => ({ Mia: { standard: { used: true, description: MIA }, costumed: { used: false } } });
const bible = () => ({
  artifacts: [{
    id: 'ART007', name: 'yellow raincoat', label: 'raincoat', type: 'outer layer', wornAs: 'Mia.outer layer',
    description: 'a yellow hooded raincoat with wooden toggles',
  }],
});
const page = (n: number, extra: any = {}) => ({ pageNumber: n, sceneMetadata: { characters: [{ name: 'Mia' }], ...extra } });
const PAGES = [
  page(1),                                                           // nothing about the raincoat
  page(2, { objects: ['ART007'] }),                                  // cites it
  page(3, { wornItems: [{ id: 'ART007', owner: 'Mia', state: 'worn' }] }), // declares it worn
  page(4, { wornItems: [{ id: 'ART007', owner: 'Mia', state: 'off', location: 'on a hook' }] }),
];

function setup() {
  const r: any = reqs();
  const vb: any = bible();
  const out = applyWardrobeBibleCorrections(r, vb, { log: quiet });
  return { r, vb, out };
}

describe('a conflict becomes an outfit version; the contract is untouched', () => {
  it('marks the bible entry, never rewrites the contract', () => {
    const { r, vb, out } = setup();
    expect(out.findings.map((f: any) => f.kind)).toEqual(['conflict']);
    expect(out.versions).toHaveLength(1);
    expect(out.applied).toHaveLength(0);
    expect(out.unresolved).toHaveLength(0);
    expect(r.Mia.standard.description).toBe(MIA);                       // default byte-identical
    const v = vb.artifacts[0].outfitVersion;
    expect(v.character).toBe('Mia');
    expect(v.category).toBe('standard');
    expect(v.replaces).toContain('fleece jacket');
    expect(v.garment).toContain('raincoat');
    expect(v.outfit).toContain('raincoat');
    expect(v.outfit).not.toContain('fleece');
  });

  it('is idempotent — a marked version is settled, not re-reported', () => {
    const { r, vb } = setup();
    expect(checkWardrobeAgainstBible(r, vb)).toEqual([]);
    const again = applyWardrobeBibleCorrections(r, vb, { log: quiet });
    expect(again.findings).toEqual([]);
    expect(r.Mia.standard.description).toBe(MIA);
  });

  it('links an entry attributed by name alone, so the per-page machinery sees it', () => {
    const r: any = { Sarah: { costumed: { used: true, costume: 'pirate', description: 'A long navy wool captain’s coat; black trousers; black boots; a black tricorn hat with yellow braid trim.' } } };
    const vb: any = { artifacts: [{ id: 'ART002', name: "navy captain's cap", label: "captain's cap", type: 'headwear', description: "a navy wool captain's cap with a gold anchor" }] };
    const out = applyWardrobeBibleCorrections(r, vb, { log: quiet });
    expect(out.versions).toHaveLength(1);
    expect(vb.artifacts[0].wornAs).toBe('Sarah.headwear');
    expect(r.Sarah.costumed.description).toContain('tricorn');
  });
});

describe('only the page that needs the garment selects the version', () => {
  it('outfit text: default everywhere except the pages that declare or cite it', () => {
    const { vb } = setup();
    const outfitOn = (p: any) => resolveGeneratedOutfit(MIA, 'Mia', { visualBible: vb, sceneMetadata: p.sceneMetadata, pageNumber: p.pageNumber });
    expect(outfitOn(PAGES[0])).toBe(MIA);
    expect(outfitOn(PAGES[1])).toContain('yellow hooded raincoat');
    expect(outfitOn(PAGES[1])).not.toContain('fleece');
    expect(outfitOn(PAGES[2])).toContain('yellow hooded raincoat');
    expect(outfitOn(PAGES[3])).toBe(MIA);                                 // off = the default, nothing stripped
  });

  it('sheet key: the version id on those pages only', () => {
    const { vb } = setup();
    const ids = PAGES.map(p => wv.offIdsForCharacter('Mia',
      resolveWornItemsForPage(vb, ['Mia'], p.sceneMetadata, { pageNumber: p.pageNumber })));
    expect(ids).toEqual([[], ['ART007'], ['ART007'], []]);
  });

  it('derives ONE new sheet for the version, from the default sheet, never the default re-rendered', () => {
    const { r, vb } = setup();
    const { requirements, refusals } = wv.deriveWardrobeVariantRequirements({
      visualBible: vb, scenes: PAGES, clothingRequirements: r, characters: [{ name: 'Mia' }],
    });
    expect(refusals).toEqual([]);
    expect(requirements).toHaveLength(1);
    const req = requirements[0];
    expect(req.clothingCategory).toBe('standard--off:ART007');
    expect(req.baseCategory).toBe('standard');
    expect(req.outfitVersion).toBe(true);
    expect(req.pages).toEqual([2, 3]);
    expect(req.redressNote).toContain('green zip-up fleece jacket');
    expect(req.redressNote).toContain('yellow hooded raincoat');
    expect(requirements.some((x: any) => x.clothingCategory === 'standard')).toBe(false);
  });

  it('the crop site serves the version sheet on a version page and the default elsewhere', () => {
    const { vb } = setup();
    const story = { 'styled-standard': 'data:default', 'styled-standard--off:ART007': 'data:version' };
    const on = (p: any) => resolveSheetForRef(story, { name: 'Mia', clothingCategory: 'standard' },
      { wornResolved: resolveWornItemsForPage(vb, ['Mia'], p.sceneMetadata, { pageNumber: p.pageNumber }) });
    expect(on(PAGES[0]).uri).toBe('data:default');
    expect(on(PAGES[1]).uri).toBe('data:version');
    expect(on(PAGES[3]).uri).toBe('data:default');
  });
});

describe('covers follow the same rule', () => {
  it('a cover that cites the version garment wears the version; one that does not keeps the default', () => {
    const { vb } = setup();
    const cited = wv.coverVersionRows(vb, ['Mia'], ['ART007', 'LOC001']);
    expect(cited.map((x: any) => x.id)).toEqual(['ART007']);
    expect(wv.coverVersionRows(vb, ['Mia'], ['LOC001'])).toEqual([]);
    const photos = [{ name: 'Mia', clothingDescription: MIA }];
    wornItems.applyCoverOutfitVersions(photos, cited);
    expect(photos[0].clothingDescription).toContain('raincoat');
    expect(photos[0].clothingDescription).not.toContain('fleece');
  });
});

describe('the rewrite-the-contract path is gone', () => {
  const root = path.join(__dirname, '..', '..');
  const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');
  it('no re-render hook, no contract merge for a conflict', () => {
    for (const f of ['server/lib/beatsPipeline.js', 'storyJobPipeline.js']) {
      expect(read(f)).not.toContain('onWardrobeCorrected');
    }
    expect(read('server/lib/beatsPipeline.js')).not.toContain("applied.filter(f => f.kind === 'conflict')");
  });
});

describe('the clothing review runs with reasoning off, in production and in the Lab', () => {
  it('one constant, both call sites', () => {
    expect(MODEL_DEFAULTS.clothingReviewReasoning).toEqual({ enabled: false });
    const root = path.join(__dirname, '..', '..');
    const beats = fs.readFileSync(path.join(root, 'server/lib/beatsPipeline.js'), 'utf8');
    const lab = fs.readFileSync(path.join(root, 'server/lib/testlab.js'), 'utf8');
    expect(beats).toContain("usageLabel: 'beats_clothing_review', reasoning: MODEL_DEFAULTS.clothingReviewReasoning");
    expect(lab).toContain('reasoning: MODEL_DEFAULTS.clothingReviewReasoning,');
    expect(lab).not.toContain('params.noReasoning');
  });
});
