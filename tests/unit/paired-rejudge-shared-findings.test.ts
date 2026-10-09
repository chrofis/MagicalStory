/**
 * Second half of the paired re-judge (Fiona rerun, staging job_1791450210539_nwi88y9lr, dedication
 * page). v0 carried a painted caption (CRITICAL rendered_text). The inpaint removed it. The
 * re-judge then charged v1 with "the page is photographic" (MAJOR) and four lesser findings that
 * the parent shows just as much, none tagged alsoInParent because the quality judge never saw the
 * parent. v1 scored 69 against v0's 75, dominance was blocked by the untagged MAJOR, and the
 * version with the caption shipped.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';

// @ts-ignore
const SV = require('../../server/lib/sceneValidator.js');
// @ts-ignore
const S = require('../../server/lib/scoring.js');
// @ts-ignore
const { PROMPT_TEMPLATES, loadPromptTemplates } = require('../../server/services/prompts.js');
// @ts-ignore
const { GoogleGenerativeAI } = require('@google/generative-ai');

const EMPTY = { quality: [], semantic: [], compliance: [], consolidated: [], entity: [] };
// the stored deductions of the two versions, as the pipeline wrote them
const V0 = { finalScore: 75, evalScore: 75, letteringInventory: { items: [{ text: 'THE CREW', surface: 'overlay at bottom center of image', position: 'bottom-center', spelling: 'correct', placement: 'overlay' }], declared: [] }, deductions: { ...EMPTY, consolidated: [
  { name: null, type: 'rendered_text', source: 'consolidated', sources: ['quality'], severity: 'critical', description: "Caption 'THE CREW' overlaid at bottom center" },
] } };
const v1 = () => ({ finalScore: 69, evalScore: 69, letteringInventory: { items: [], declared: [] }, deductions: { ...EMPTY, consolidated: [
  { name: null, type: 'style_consistency', source: 'consolidated', sources: ['quality'], severity: 'major', description: 'Page is photographic; commissioned style is watercolor' },
  { name: 'Fiona', type: 'accessory_missing', source: 'consolidated', sources: ['quality'], severity: 'moderate', description: 'Fiona is missing her silver necklace' },
  { name: 'Sarah', type: 'hair', source: 'consolidated', sources: ['quality'], severity: 'minor', description: 'Sarah hair parted on the left' },
] } });

describe('selection on the stored dedication-page shape', () => {
  it('regression: untagged page-wide findings block the child that removed the CRITICAL', () => {
    expect(S.pickBestVersionIndex([V0, v1()], { tieBreak: 'earliest' })).toBe(0);
  });
  it('tagged as also in the parent, the child that removed the CRITICAL wins', () => {
    const parent = JSON.parse(JSON.stringify(V0));
    const child = v1();
    child.deductions.consolidated.forEach((f: any) => { f.alsoInParent = true; });
    S.chargeSharedFindingsToParent(child, parent);
    expect(S.dominatesByCritical(child, parent)).toBe(true);
    expect(S.pickBestVersionIndex([parent, child], { tieBreak: 'earliest' })).toBe(1);
  });
  it('a genuinely new defect still blocks it', () => {
    const parent = JSON.parse(JSON.stringify(V0));
    const child = v1();
    child.deductions.consolidated.forEach((f: any) => { if (f.type !== 'style_consistency') f.alsoInParent = true; });
    expect(S.pickBestVersionIndex([parent, child], { tieBreak: 'earliest' })).toBe(0);
  });
});

describe('the shared-findings answer', () => {
  it('lists the findings with ids C1..Cn in order', () => {
    const block = SV.buildSharedFindingsBlock([
      { severity: 'major', type: 'style_consistency', character: null, description: 'photographic' },
      { severity: 'moderate', type: 'accessory_missing', character: 'Fiona', description: 'no necklace' },
    ]);
    expect(block).toBe('- C1 [MAJOR] (style_consistency) photographic\n- C2 [MODERATE] (accessory_missing) Fiona: no necklace');
  });
  it('reads true answers by id and ignores unknown ids and non-booleans', () => {
    const text = 'x ' + JSON.stringify({ findings: [
      { id: 'C1', also_in_parent: true }, { id: 'C2', also_in_parent: false },
      { id: 'C3', also_in_parent: 'true' }, { id: 'C9', also_in_parent: true }, { id: 'P1', also_in_parent: true },
    ] });
    expect([...SV.parseSharedFindings(text, 3)]).toEqual([0]);
  });
  it('rejects a reply that is not the contract', () => {
    expect(() => SV.parseSharedFindings('nothing', 2)).toThrow();
    expect(() => SV.parseSharedFindings('{"a":1}', 2)).toThrow();
  });
});

describe('tagFindingsSharedWithParent', () => {
  beforeAll(async () => { await loadPromptTemplates(); });
  const plan = () => ({ deduped_issues: [
    { type: 'style_consistency', severity: 'MAJOR', sources: ['quality'], description: 'photographic' },
    { type: 'hair', severity: 'MINOR', sources: ['quality'], description: 'parting' },
    { type: 'action_interaction', severity: 'MAJOR', sources: ['semantic'], description: 'already answered by the semantic judge' },
    { type: 'rendered_text', severity: 'CRITICAL', sources: ['reader'], description: 'caption', alsoInParent: true },
  ] });

  it('asks nothing, and calls no model, when every finding is minor, semantic or already tagged', async () => {
    const spy = vi.spyOn(GoogleGenerativeAI.prototype, 'getGenerativeModel');
    const p = { deduped_issues: plan().deduped_issues.slice(1) };
    const r = await SV.tagFindingsSharedWithParent({ childImage: 'data:image/png;base64,AA', parentImage: 'data:image/png;base64,AA', plan: p, parentFindings: [], pageNumber: 1 });
    expect(r).toMatchObject({ asked: 0, tagged: 0 });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('asks only the MODERATE+ non-semantic untagged entries and tags the ones answered true', async () => {
    let sentPrompt = '';
    const spy = vi.spyOn(GoogleGenerativeAI.prototype, 'getGenerativeModel').mockReturnValue({
      generateContent: async (parts: any[]) => { sentPrompt = parts[0]; return { response: { text: () => '{"findings":[{"id":"C1","also_in_parent":true}]}', usageMetadata: {} } }; },
    } as any);
    const p = plan();
    const r = await SV.tagFindingsSharedWithParent({ childImage: 'data:image/png;base64,AA', parentImage: 'data:image/png;base64,AA', plan: p, parentFindings: [], pageNumber: 1 });
    expect(r).toMatchObject({ asked: 1, tagged: 1, error: null });
    expect(sentPrompt).toContain('C1 [MAJOR] (style_consistency) photographic');
    expect(sentPrompt).not.toContain('C2');
    expect(p.deduped_issues[0].alsoInParent).toBe(true);
    expect(p.deduped_issues[1].alsoInParent).toBeUndefined();
    spy.mockRestore();
  });

  it('a failed call tags nothing and says so', async () => {
    const spy = vi.spyOn(GoogleGenerativeAI.prototype, 'getGenerativeModel').mockReturnValue({
      generateContent: async () => { throw new Error('boom'); },
    } as any);
    const p = plan();
    const r = await SV.tagFindingsSharedWithParent({ childImage: 'data:image/png;base64,AA', parentImage: 'data:image/png;base64,AA', plan: p, parentFindings: [], pageNumber: 1 });
    expect(r).toMatchObject({ asked: 1, tagged: 0, error: 'boom' });
    expect(p.deduped_issues[0].alsoInParent).toBeUndefined();
    spy.mockRestore();
  });
});

// Every MAJOR+ finding on a repair child that the parent's own findings do not carry gets the
// picture check (owner 2026-10-09). Stored shape: staging job_1789078732136_622wecmhj p18, the
// iterate child's compliance finding on Levin that the parent's findings did not list, and the
// parentFindingsForCompare rows of that parent.
describe('which findings need the parent-picture check', () => {
  beforeAll(async () => { await loadPromptTemplates(); });
  const okReply = (ids: string[]) => ({ generateContent: async () => ({ response: { text: () => JSON.stringify({ findings: ids.map(id => ({ id, also_in_parent: true })) }), usageMetadata: {} } }) } as any);
  const img = 'data:image/png;base64,AA';

  it('regression: a new MAJOR (not in the parent findings) is checked, a fresh call is made and it is tagged', async () => {
    const spy = vi.spyOn(GoogleGenerativeAI.prototype, 'getGenerativeModel').mockReturnValue(okReply(['C1']));
    const p = { deduped_issues: [{ type: 'action_interaction', character: 'Levin', severity: 'major', sources: ['compliance'], description: 'Levin facing viewer, not gripping the neck ridges' }] };
    const r = await SV.tagFindingsSharedWithParent({ childImage: img, parentImage: img, plan: p, parentFindings: [{ id: 'P1', severity: 'CRITICAL', type: 'missing_character', character: 'Lindi', description: 'x' }], pageNumber: 18 });
    expect(r).toMatchObject({ asked: 1, tagged: 1 });
    expect(p.deduped_issues[0]).toMatchObject({ alsoInParent: true });
    spy.mockRestore();
  });

  it('a MAJOR whose type and subject the parent findings already carry needs no picture check', async () => {
    const spy = vi.spyOn(GoogleGenerativeAI.prototype, 'getGenerativeModel');
    const p = { deduped_issues: [{ type: 'action_interaction', character: 'Levin', severity: 'major', sources: ['compliance'], description: 'again' }] };
    const r = await SV.tagFindingsSharedWithParent({ childImage: img, parentImage: img, plan: p, parentFindings: [{ id: 'P1', severity: 'MAJOR', type: 'action_interaction', character: 'levin', description: 'x' }], pageNumber: 18 });
    expect(r).toMatchObject({ asked: 0, tagged: 0 });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('only MODERATE findings new against the parent: no call (they cannot decide a pick)', async () => {
    const spy = vi.spyOn(GoogleGenerativeAI.prototype, 'getGenerativeModel');
    const p = { deduped_issues: [{ type: 'clothing_detail', character: 'Max', severity: 'moderate', sources: ['compliance'], description: 'shirt grey' }] };
    const r = await SV.tagFindingsSharedWithParent({ childImage: img, parentImage: img, plan: p, parentFindings: [], pageNumber: 18 });
    expect(r.asked).toBe(0);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('with a new MAJOR present the same call also carries the MODERATE entries', async () => {
    let sent = '';
    const spy = vi.spyOn(GoogleGenerativeAI.prototype, 'getGenerativeModel').mockReturnValue({
      generateContent: async (parts: any[]) => { sent = parts[0]; return { response: { text: () => '{"findings":[]}', usageMetadata: {} } }; },
    } as any);
    const p = { deduped_issues: [
      { type: 'clothing_detail', character: 'Max', severity: 'moderate', sources: ['compliance'], description: 'shirt grey' },
      { type: 'scale', character: 'Julian', severity: 'major', sources: ['compliance'], description: 'same height' },
    ] };
    const r = await SV.tagFindingsSharedWithParent({ childImage: img, parentImage: img, plan: p, parentFindings: [], pageNumber: 2 });
    expect(r.asked).toBe(2);
    expect(sent).toContain('C1 [MODERATE]');
    expect(sent).toContain('C2 [MAJOR]');
    spy.mockRestore();
  });

  it('refuses a call that does not say what the parent findings were (no silent default)', async () => {
    await expect(SV.tagFindingsSharedWithParent({ childImage: img, parentImage: img, plan: { deduped_issues: [] }, pageNumber: 1 })).rejects.toThrow(/parentFindings/);
  });
});

// Every path that makes a repair child is judged beside its parent. Before 2026-10-09 only the
// round loop (iterate / inpaint / char-fix) was; the garment recolour and the post-repair text
// re-render scored their children with no parent check at all.
describe('repairPipeline wires the parent check into every repair-child path', () => {
  // @ts-ignore
  const src: string = require('fs').readFileSync(require('path').join(__dirname, '../../server/lib/repairPipeline.js'), 'utf8');
  it.each([
    ['round loop', 'parent_shared_r${round}', 'roundEvalInputs'],
    ['recolour', 'parent_shared_recolour_r${round}', 'recolourInputs'],
    ['text re-render', 'parent_shared_text_space', 'tsInputs'],
  ])('%s attaches the parent to the eval input and checks the plan', (_n, label, inputs) => {
    expect(src).toContain(label);
    expect(src).toContain(`for (const input of ${inputs}) attachParentCompare`);
  });
  it('recolour and text re-render charge shared findings to the parent like the round loop does', () => {
    expect(src.split('chargeSharedFindingsToParent(').length - 1).toBeGreaterThanOrEqual(3);
  });
});
