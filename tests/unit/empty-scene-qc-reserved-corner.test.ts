/**
 * The empty-scene QC does not grade the plate on a RESERVED CORNER.
 *
 * Owner, 2026-09-15: "Why does the empty scene need a reserved corner that is
 * wrong. Change the judge."
 *
 * The plate generator (`buildEmptyScenePrompt`) is handed the brief's
 * `emptyScenePrompt` and never `mainScenePrompt`, so the QC's "reserve open,
 * uncluttered space where a distant composited target will land" clause graded
 * a plate against prose it could not read. The page's text area is computed
 * afterwards from the calmness map (server/lib/textRegion.js), so the plate has
 * nothing to reserve either way.
 *
 * Pinned on the prompt that is actually SENT: `fetch` is stubbed, the vision
 * call's request body is captured, and the assertions run against that string —
 * not against the source of the template that builds it.
 *
 * Perspective direction, vanishing point and lighting direction were NOT ruled
 * on and stay; their presence is asserted so a later sweep cannot quietly take
 * them out under cover of this one.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { validateEmptyScene } = require('../../server/lib/evalPipeline.js');
const sharp = require('sharp');

const MAIN_SCENE =
  'The main character stands on the pier while a path stretches to the right background, '
  + 'and a tiny figure waits in the far upper-right corner.';

let sentPrompt = '';
let plate = '';
const realFetch = global.fetch;
const realKey = process.env.GEMINI_API_KEY;

beforeAll(async () => {
  // A flat mid-grey plate: calm everywhere, so Phase 1 raises no pixel issue
  // and the vision phase (the one under test) actually runs.
  const buf = await sharp({
    create: { width: 256, height: 256, channels: 3, background: { r: 150, g: 150, b: 150 } },
  }).jpeg().toBuffer();
  plate = `data:image/jpeg;base64,${buf.toString('base64')}`;

  process.env.GEMINI_API_KEY = 'test-key-not-used';
  global.fetch = vi.fn(async (_url: any, init: any) => {
    const body = JSON.parse(init.body);
    sentPrompt = body.contents[0].parts.map((p: any) => p.text || '').join('\n');
    return {
      ok: true,
      json: async () => ({ candidates: [{ content: { parts: [{ text: 'PASS' }] } }] }),
    } as any;
  }) as any;

  await validateEmptyScene(plate, 'top-right', 'test', {
    sceneDescription: 'a timber pier at dusk',
    mainScenePrompt: MAIN_SCENE,
  });
});

afterAll(() => {
  global.fetch = realFetch;
  if (realKey === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = realKey;
});

describe('empty-scene QC: the reserved corner is gone, the rest of the geometry stays', () => {
  it('the vision call actually happened and its prompt was captured', () => {
    expect(sentPrompt.length, 'the QC vision call did not fire — the test asserts nothing').toBeGreaterThan(200);
  });

  it('the plate is not asked to reserve space for a composited target', () => {
    expect(sentPrompt, 'the reserved-corner requirement is back in the empty-scene QC')
      .not.toMatch(/reserved open space|must have open, uncluttered/i);
    expect(sentPrompt).not.toMatch(/tiny figure.*specific corner/i);
  });

  it('perspective direction, vanishing point and lighting direction are still judged', () => {
    expect(sentPrompt).toMatch(/major perspective line/i);
    expect(sentPrompt).toMatch(/vanishing point/i);
    expect(sentPrompt).toMatch(/lighting direction/i);
  });
});
