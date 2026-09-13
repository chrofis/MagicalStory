import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const { extractSceneMetadata } = require('../../server/lib/sceneMetadata');

/**
 * `sceneIntent` — the Art Director's one-line "this image depicts" — is written
 * on every page, but the prose-format branch of extractSceneMetadata() builds
 * `fullData` from a hand-written allowlist and that allowlist omitted it. The
 * JSON-format branch sets `fullData = parsedData` wholesale, so the same brief
 * produced two different shapes depending on which format it arrived in, and
 * consumers spelled `meta.sceneIntent || meta.fullData.sceneIntent`
 * (evalPipeline, routes/regeneration) reached it through one of the two only.
 *
 * Restored from 190962747, which was reverted wholesale by 7c07824a4 for an
 * unrelated rejected hunk. Nothing asserted it, which is why it stayed lost.
 * These tests pin the BEHAVIOUR — a value the brief declared survives into
 * fullData, in both formats, and absence stays null.
 */

const INTENT = 'The main character waves from the dock as a boat pulls away.';

function proseBrief(meta: Record<string, unknown>): string {
  return `A figure stands at the water's edge.\n\n---METADATA---\n${JSON.stringify(meta)}`;
}

const CAST = [{ name: 'Anna', depth: 'foreground', expression: 'raised brows, open mouth' }];

describe('extractSceneMetadata — sceneIntent reaches fullData', () => {
  it('carries the declared sceneIntent into fullData for a prose-format brief', () => {
    const meta = extractSceneMetadata(proseBrief({
      sceneIntent: INTENT,
      characters: CAST,
      objects: [],
      shot: 'wide shot'
    }));
    expect(meta.fullData.sceneIntent).toBe(INTENT);
  });

  it('agrees with the top-level field — the two are one value, never one shape', () => {
    const meta = extractSceneMetadata(proseBrief({
      sceneIntent: INTENT,
      characters: CAST,
      objects: []
    }));
    expect(meta.sceneIntent).toBe(INTENT);
    expect(meta.fullData.sceneIntent).toBe(meta.sceneIntent);
  });

  it('stays null when the brief declares none — absent is "not declared", never undefined', () => {
    const meta = extractSceneMetadata(proseBrief({ characters: CAST, objects: [] }));
    expect(meta.fullData.sceneIntent).toBeNull();
    expect(meta.sceneIntent).toBeNull();
  });

  it('treats an empty string as not declared', () => {
    const meta = extractSceneMetadata(proseBrief({ sceneIntent: '', characters: CAST, objects: [] }));
    expect(meta.fullData.sceneIntent).toBeNull();
  });

  it('gives the same fullData.sceneIntent for a JSON-format brief — the branches do not disagree', () => {
    const json = JSON.stringify({ scene: { sceneIntent: INTENT, characters: CAST, objects: [] } });
    const fromJson = extractSceneMetadata(json);
    const fromProse = extractSceneMetadata(proseBrief({ sceneIntent: INTENT, characters: CAST, objects: [] }));
    expect(fromJson.fullData.sceneIntent).toBe(INTENT);
    expect(fromProse.fullData.sceneIntent).toBe(fromJson.fullData.sceneIntent);
  });

  it('does not disturb the other allowlisted passthroughs', () => {
    const meta = extractSceneMetadata(proseBrief({
      sceneIntent: INTENT,
      characters: CAST,
      objects: [],
      shot: 'close-up',
      setting: { description: 'a wooden jetty' },
      background: 'open water',
      crowdExpected: true
    }));
    expect(meta.fullData.shot).toBe('close-up');
    expect(meta.fullData.background).toBe('open water');
    expect(meta.fullData.crowdExpected).toBe(true);
    expect(meta.fullData.setting).toEqual({ description: 'a wooden jetty' });
  });
});

describe('wiring guard — the fullData allowlist still lists sceneIntent', () => {
  // The field was lost once by a wholesale revert and once, before that, by
  // simply not being in the allowlist. Grepping the allowlist block itself is
  // the only way to catch a future deletion that the branch-parity tests above
  // would also catch but a partial refactor of the JSON branch would not.
  const src = fs.readFileSync(
    path.join(__dirname, '../../server/lib/sceneMetadata.js'),
    'utf8'
  );

  it('names sceneIntent inside the prose-branch fullData literal', () => {
    const block = src.split('fullData: {')[1]?.split('\n      },')[0] || '';
    expect(block).toContain('sceneIntent: metadata.sceneIntent');
  });

  it('keeps the consumer fallback chain that reads it off fullData', () => {
    const evalSrc = fs.readFileSync(
      path.join(__dirname, '../../server/lib/evalPipeline.js'),
      'utf8'
    );
    expect(evalSrc).toMatch(/sceneMeta\?\.sceneIntent \|\| sceneMeta\?\.fullData\?\.sceneIntent/);
  });
});
