import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

// RESULT AT THE CONTACT, RECEIVER CLEAR (decisions.md 2026-09-08).
// An interactions[] row may name the `receiver` of its result. The parser
// passes it through, the builder drops the receiver's state clause for the
// page and appends one fixed placement sentence. Fixtures are archetypal.

const require_ = createRequire(import.meta.url);
const { sanitizeInteractions, extractSceneMetadata } = require_('../../server/lib/sceneMetadata');
const { buildImagePrompt, buildReceiverPlacement } = require_('../../server/lib/promptBuilders');
const { addLogListener, removeLogListener } = require_('../../server/utils/logger');

const TOOL = {
  id: 'ART001', name: 'iron pry bar', type: 'pry bar', size: 'as long as the child is tall',
  description: 'a straight dark iron bar with a flattened tip',
  states: [{ id: 'ART001.1', name: 'wedged in the seam', delta: 'flat tip forced into the seam of the lid, both hands on the far end', held: true, pages: [4] }],
  appearsInPages: [4], referenceImageUrl: 'https://r2/bar.jpg',
};
const RECEIVER = {
  id: 'ART002', name: 'tin pail', type: 'pail', size: 'knee-high',
  description: 'a dented grey tin pail with a wire handle',
  states: [
    { id: 'ART002.1', name: 'empty', delta: 'standing empty on the flagstones', held: false, pages: [3] },
    { id: 'ART002.2', name: 'catching', delta: 'grain pouring into it from the split lid', held: false, pages: [4] },
  ],
  appearsInPages: [3, 4], referenceImageUrl: 'https://r2/pail.jpg',
};
const bible = () => ({
  mainCharacters: [{ id: 'CHR001', name: 'Ada' }], secondaryCharacters: [], animals: [], vehicles: [], clothing: [], locations: [],
  artifacts: [JSON.parse(JSON.stringify(TOOL)), JSON.parse(JSON.stringify(RECEIVER))],
});
const brief = (objects: string[], row: Record<string, unknown>) =>
  `Ada leans on the bar.\n\n---METADATA---\n${JSON.stringify({
    sceneIntent: 'Ada forces the lid.',
    characters: [{ name: 'Ada', position: 'center', depth: 'foreground' }],
    shot: 'medium', objects,
    interactions: [{ character: 'Ada', object: 'ART001.1', where: 'forces the bar tip into the seam of the lid', action: 'prying a lid', hands: true, storyRelevant: true, priority: 'essential', ...row }],
  })}`;
const withWarnings = (fn: () => string) => {
  const warnings: string[] = [];
  const l = (level: string, line: string) => { if (level === 'warn') warnings.push(line); };
  addLogListener(l);
  try { return { prompt: fn(), warnings }; } finally { removeLogListener(l); }
};
const SENTENCE = /The result of this action appears only .*; .* stands well clear of .*, several steps away, never under or beside its tip\./;

describe('receiver — parser pass-through', () => {
  it('sanitizeInteractions keeps receiver and target verbatim and leaves rows without them unchanged', () => {
    const rows = sanitizeInteractions([
      { character: 'Ada', object: 'ART001', where: 'x', receiver: ' ART002 ', target: 'the seam' },
      { character: 'Bo', object: 'rope', where: 'y' },
    ]);
    expect(rows[0].receiver).toBe('ART002');
    expect(rows[0].target).toBe('the seam');
    expect('receiver' in rows[1]).toBe(false);
    expect('target' in rows[1]).toBe(false);
  });
  it('extractSceneMetadata surfaces receiver on the parsed interactions', () => {
    const m = extractSceneMetadata(brief(['ART001.1'], { receiver: 'ART002' }));
    expect(m.interactions[0].receiver).toBe('ART002');
  });
});

describe('receiver — builder sentence', () => {
  it('is deterministic string assembly from the row: target when given, else the where text', () => {
    expect(buildReceiverPlacement([{ object: 'the bar', receiver: 'the pail', target: 'the seam of the lid' }]))
      .toBe('The result of this action appears only where the bar meets the seam of the lid; the pail stands well clear of the bar, several steps away, never under or beside its tip.');
    expect(buildReceiverPlacement([{ object: 'the bar', receiver: 'the pail', where: 'forces the bar into the seam' }]))
      .toBe('The result of this action appears only at the point where the bar makes contact (forces the bar into the seam); the pail stands well clear of the bar, several steps away, never under or beside its tip.');
    expect(buildReceiverPlacement([{ object: 'the bar', where: 'x' }])).toBe('');
    expect(buildReceiverPlacement(null)).toBe('');
  });

  it('receiver OUT of frame: sentence emitted, no state stripped, no [RECEIVER] warning', () => {
    const { prompt, warnings } = withWarnings(() =>
      buildImagePrompt(brief(['ART001.1'], { receiver: 'ART002', target: 'the seam of the lid' }), { language: 'en' }, null, bible(), 4, null, { skipVisualBible: true }));
    expect(prompt).toMatch(SENTENCE);
    expect(prompt).toContain('several steps away');
    expect(prompt).not.toMatch(/grain pouring/);
    expect(warnings.some(w => /\[RECEIVER\]/.test(w))).toBe(false);
    // sits directly after the prose, in the SCENE_DESCRIPTION slot
    expect(prompt).toContain(['Ada leans on the bar.', '', 'The result of this action appears only'].join(String.fromCharCode(10)));
  });

  it('receiver IN frame: its state clause is dropped with a [RECEIVER] warning, the object stays listed, the tool keeps its state', () => {
    const { prompt, warnings } = withWarnings(() =>
      buildImagePrompt(brief(['ART001.1', 'ART002.2'], { receiver: 'ART002', target: 'the seam of the lid' }), { language: 'en' }, null, bible(), 4, null, { skipVisualBible: true }));
    expect(prompt).toMatch(SENTENCE);
    expect(prompt).toContain('**tin pail** (object) — knee-high');
    expect(prompt).not.toMatch(/grain pouring/);
    expect(prompt).toMatch(/flat tip forced into the seam/);
    const w = warnings.find(x => /\[RECEIVER\]/.test(x));
    expect(w).toBeDefined();
    expect(w).toContain('ART002.2');
    expect(w).toContain('grain pouring');
  });

  it('no receiver: prompt byte-identical to before — clause kept, no sentence', () => {
    const { prompt, warnings } = withWarnings(() =>
      buildImagePrompt(brief(['ART001.1', 'ART002.2'], {}), { language: 'en' }, null, bible(), 4, null, { skipVisualBible: true }));
    expect(prompt).not.toMatch(SENTENCE);
    expect(prompt).toMatch(/grain pouring/);
    expect(warnings.some(w => /\[RECEIVER\]/.test(w))).toBe(false);
  });
});
