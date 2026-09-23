import { describe, it, expect } from 'vitest';

// A character repair keeps what the page's brief says the character is doing.
// The state block read retired brief fields (pose / action / gaze / holding),
// so only `expression` arrived and the repaint dropped the held object
// (staging job_1790100385959_1nitlympp p14). The current schema: hands and
// held objects in interactions[], eyes in looksAt, body turn in perspective.
// See docs/decisions.md 2026-09-23 "Char-fix reads the brief's current schema".

// eslint-disable-next-line @typescript-eslint/no-var-requires
const faceRepair = require('../../server/lib/faceRepair');

const meta = (m: Record<string, unknown>) => `Prose of the page.\n\n---METADATA---\n${JSON.stringify(m)}`;

const BRIEF = meta({
  characters: [
    { name: 'CharA', depth: 'foreground', looksAt: 'away', expression: 'eyes relaxed, mouth chewing softly' },
    { name: 'CharB', depth: 'midground', looksAt: 'CharA', perspective: 'back view', expression: 'calm' },
  ],
  interactions: [
    { character: 'CharA', object: 'ART001', where: 'holds one roasted chestnut up and bites into it', hands: true, priority: 'essential' },
    { character: 'CharB, CharC and CharA', object: 'the leaves', where: 'rake the leaves with both hands', hands: true },
  ],
});

describe('char-fix page state', () => {
  it('carries the held object and action from interactions[]', () => {
    const ctx = faceRepair.buildActionContext(BRIEF, 'CharA');
    expect(ctx).toContain('holds one roasted chestnut up and bites into it');
    expect(ctx).toContain('eyes relaxed, mouth chewing softly');
    expect(ctx).toContain('eyes turned away');
  });

  it('a row naming several actors reaches each of them', () => {
    const ctx = faceRepair.buildActionContext(BRIEF, 'CharA');
    expect(ctx).toContain('rake the leaves with both hands');
    const b = faceRepair.buildActionContext(BRIEF, 'CharB');
    expect(b).toContain('rake the leaves with both hands');
    expect(b).not.toContain('chestnut');
  });

  it('carries looksAt and perspective', () => {
    const b = faceRepair.buildActionContext(BRIEF, 'CharB');
    expect(b).toContain('eyes on CharA');
    expect(b).toContain('back view');
  });

  it('never emits a raw Visual Bible id', () => {
    expect(faceRepair.buildActionContext(BRIEF, 'CharA')).not.toMatch(/\bART\d{3}\b/);
  });

  it('a character the brief does not name gets nothing', () => {
    expect(faceRepair.buildActionContext(BRIEF, 'Nobody')).toBe('');
  });

  it('the state reaches the built repair prompt', async () => {
    const prompt = await faceRepair.buildPrompt({
      treatment: 'crosshatch', regionSource: 'box', faceOnly: false, charName: 'CharA',
      opts: { sceneDescription: BRIEF, artStyle: 'watercolor' },
    });
    expect(prompt).toContain('holds one roasted chestnut up and bites into it');
  });
});

describe('face repair keeps the face treatment when the real figure box is passed', () => {
  const faceBbox = [0.15, 0.39, 0.57, 0.75];
  const bodyBbox = [0.13, 0.09, 1.0, 0.87];
  const faceAxes = { model: 'grok', faceOnly: true, treatment: 'blur', regionSource: 'cutout' };

  it('face box with the figure box → face blur survives the guard', () => {
    const out = faceRepair.applyGeometryGuards(faceAxes, { faceBbox, bodyBbox });
    expect(out.faceOnly).toBe(true);
    expect(out.treatment).toBe('blur');
  });

  it('face box passed as the figure box → the guard turns it into a body crosshatch (why the caller must not)', () => {
    const out = faceRepair.applyGeometryGuards(faceAxes, { faceBbox, bodyBbox: faceBbox });
    expect(out.faceOnly).toBe(false);
  });
});
