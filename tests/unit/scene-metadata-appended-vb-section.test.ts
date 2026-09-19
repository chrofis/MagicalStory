/**
 * A page brief the scene review re-emitted a Visual Bible section for lost its
 * ENTIRE metadata block: the review appends `---VISUAL BIBLE---` followed by a
 * fenced ```json block, and the JSON extractor preferred that fenced block over
 * the real METADATA object that precedes it. The whole brief then failed to
 * parse and the page fell back to the degraded prose-only object — no cast, no
 * clothing, no worn state.
 *
 * Measured on staging job_1789759147125_p08djwhbl page 17 (stored
 * `sceneMetadata.isRecovered === true`, no `wornItems` key at all, while the
 * brief's own METADATA tail carried
 * `{"id": "CLO002", "owner": "Levin", "state": "worn", "wearer": "Julian"}`).
 * The fixture below is that page's shape, shortened.
 *
 * Not page-17-specific: any page the review re-emits a VB section for.
 */
import { describe, it, expect } from 'vitest';

// @ts-ignore - CommonJS module
const { extractSceneMetadata, describeDegradedSceneMetadata } = require('../../server/lib/sceneMetadata');

const METADATA = JSON.stringify({
  imageSummary: 'A close-up of a laughing boy with a small dragon on his neck in a narrow alley.',
  characters: [
    { name: 'Julian', clothing: 'standard', position: 'center foreground', depth: 'foreground', looksAt: 'ANI003', expression: 'thrown-back laugh' },
    { name: 'Levin', clothing: 'standard', position: 'right midground', depth: 'midground', looksAt: 'Julian', expression: 'grinning' },
  ],
  textPosition: 'top',
  landmarkView: 'exterior',
  era: 'present day',
  objects: ['LOC005.3', 'ANI003', 'CLO002'],
  interactions: [{
    character: 'ANI003', object: 'Julian',
    where: "sits on Julian's neck, tail curled against his collar",
    action: 'sneezing', hands: false, storyRelevant: true, priority: 'essential',
  }],
  wornItems: [{ id: 'CLO002', owner: 'Levin', state: 'worn', wearer: 'Julian' }],
});

const APPENDED_VB = '\n\n---VISUAL BIBLE---\n```json\n' + JSON.stringify({
  vantages: [{ id: 'LOC004.1', emptyScenePrompt: 'An ultra-wide view over sloping medieval rooftops.' }],
}) + '\n```';

const PROSE = 'The boy fills the close-up frame, head tilted back in a wide-open laugh, '
  + 'a palm-sized pale green dragon sitting on his neck, mid-sneeze. A wide forest-green '
  + 'fleece jacket is wrapped around his shoulders, sleeves hanging loose past his hands.';

describe('a brief with an appended ---VISUAL BIBLE--- section', () => {
  const brief = `${PROSE}\n\n---METADATA---\n${METADATA}${APPENDED_VB}`;

  it('parses the METADATA object, not the appended fenced block', () => {
    const meta = extractSceneMetadata(brief);
    expect(meta).toBeTruthy();
    expect(meta.isRecovered).not.toBe(true);
    expect(meta.characters.map((c: any) => c.name || c)).toEqual(['Julian', 'Levin']);
    expect(meta.textPosition).toBe('top');
    expect(meta.interactions).toHaveLength(1);
  });

  it('keeps the worn item, with its wearer', () => {
    const meta = extractSceneMetadata(brief);
    expect(meta.wornItems).toHaveLength(1);
    expect(meta.wornItems[0]).toMatchObject({ id: 'CLO002', owner: 'Levin', state: 'worn', wearer: 'Julian' });
  });

  it('still prefers a fenced block when the brief is only a fenced block', () => {
    const fenced = `${PROSE}\n\n---METADATA---\n\`\`\`json\n${METADATA}\n\`\`\``;
    const meta = extractSceneMetadata(fenced);
    expect(meta.isRecovered).not.toBe(true);
    expect(meta.characters.map((c: any) => c.name || c)).toEqual(['Julian', 'Levin']);
    expect(meta.wornItems[0].wearer).toBe('Julian');
  });
});

describe('a brief that genuinely cannot be parsed', () => {
  const broken = `${PROSE}\n\n---METADATA---\n{"characters": ["Julian",, ]`;

  it('recovers on prose, and its worn state is an empty array, never undefined', () => {
    const meta = extractSceneMetadata(broken);
    expect(meta.isRecovered).toBe(true);
    expect(meta.wornItems).toEqual([]);
  });

  it('reports worn state among the emptied inputs', () => {
    const degraded = describeDegradedSceneMetadata(extractSceneMetadata(broken));
    expect(degraded).toBeTruthy();
    expect(degraded.recovered).toBe(true);
    expect(degraded.emptyInputs).toContain('wornItems');
    expect(degraded.emptyInputs).toContain('characters');
  });
});
