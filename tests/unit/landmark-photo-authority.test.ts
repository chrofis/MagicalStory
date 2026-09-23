import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);

// BEHAVIOUR PINNED (owner, 2026-09-23): for a real landmark with a reference
// photo, the plate judge holds the landmark to the PHOTO, never to the written
// description — and the plate author is told the same thing from the same
// constant. prod job_1790107559778_fcmlfa8kn: a mis-described photo put a wrong
// structure in the brief; the judge failed a photo-faithful plate against it and
// its feedback repainted the landmark into something else.

let build: any;
let validateEmptyScene: any;
let pb: any;

beforeAll(async () => {
  await require_('../../server/services/prompts.js').loadPromptTemplates();
  build = require_('../../server/lib/evalPipeline.js').buildEmptySceneQcPrompt;
  validateEmptyScene = require_('../../server/lib/evalPipeline.js').validateEmptyScene;
  pb = require_('../../server/lib/promptBuilders.js');
});

afterEach(() => { vi.unstubAllGlobals(); });

async function noisePng(w = 256, h = 256, seed = 1): Promise<string> {
  const sharp = require_('sharp');
  const buf = Buffer.alloc(w * h * 3);
  let x = seed;
  for (let i = 0; i < buf.length; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; buf[i] = 60 + (x % 150); }
  const png = await sharp(buf, { raw: { width: w, height: h, channels: 3 } }).jpeg().toBuffer();
  return `data:image/jpeg;base64,${png.toString('base64')}`;
}

describe('plate judge: the landmark photo is the authority', () => {
  it('names the landmark, carries the shared authority sentence and judges against the photo', () => {
    const p = build({ sceneDescription: 'A forest path below a tall tower.', landmarkName: 'Old Town Tower', storyEra: 'medieval' });
    expect(p).toContain('LANDMARK REFERENCE PHOTO: the second attached image is a real photograph of Old Town Tower');
    // stated before the checks, so every check reads it
    expect(p.indexOf('LANDMARK REFERENCE PHOTO')).toBeLessThan(p.indexOf('\nCheck:'));
    expect(p).toContain(pb.LANDMARK_PHOTO_AUTHORITY);
    expect(p).toContain('never against a written description');
    expect(p).toContain('the landmark itself stays as the photo shows it');
    expect(p).toContain('A real landmark the scene is set at is never one of them');
    expect(p.match(/\{[A-Z][A-Z0-9_]*\}/g)).toBe(null);
  });

  it('adds no landmark check when no photo is attached', () => {
    const p = build({ sceneDescription: 'A forest path.' });
    expect(p).not.toContain('LANDMARK REFERENCE PHOTO');
    expect(p).not.toContain(pb.LANDMARK_PHOTO_AUTHORITY);
  });

  it('the plate author is given the same sentence in both fidelity-block shapes', () => {
    expect(pb.buildLandmarkFidelityBlock({ name: 'Old Town Tower' })).toContain(pb.LANDMARK_PHOTO_AUTHORITY);
    expect(pb.buildLandmarkFidelityBlock({ name: 'Old Town', photoType: 'distant' })).toContain(pb.LANDMARK_PHOTO_AUTHORITY);
  });

  it('validateEmptyScene sends the landmark photo as the second image with the landmark check', async () => {
    const plate = await noisePng(256, 256, 7);
    const photo = await noisePng(64, 64, 3);
    const bodies: any[] = [];
    vi.stubEnv('GEMINI_API_KEY', 'test-key');
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: any) => {
      bodies.push(JSON.parse(init.body));
      return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: '{"pass": true, "issues": []}' }] } }] }) };
    }));
    const res = await validateEmptyScene(plate, null, 'unit', {
      sceneDescription: 'A forest path below a tall tower.',
      landmarkPhoto: { name: 'Old Town Tower', photoData: photo },
    });
    expect(res.pass).toBe(true);
    expect(bodies.length).toBe(1);
    const parts = bodies[0].contents[0].parts;
    expect(parts.length).toBe(5);
    expect(parts[0].text).toBe('[Background plate to judge]:');
    expect(parts[1].inline_data.data).toBe(plate.replace(/^data:image\/\w+;base64,/, ''));
    expect(parts[2].text).toBe('[Landmark reference photo: Old Town Tower]:');
    expect(parts[3].inline_data.data).toBe(photo.replace(/^data:image\/\w+;base64,/, ''));
    expect(parts[4].text).toContain('real photograph of Old Town Tower');
  });

  it('without a landmark photo the judge gets the plate alone and no landmark check', async () => {
    const plate = await noisePng(256, 256, 9);
    const bodies: any[] = [];
    vi.stubEnv('GEMINI_API_KEY', 'test-key');
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: any) => {
      bodies.push(JSON.parse(init.body));
      return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: '{"pass": true, "issues": []}' }] } }] }) };
    }));
    await validateEmptyScene(plate, null, 'unit', { sceneDescription: 'A forest path.' });
    const parts = bodies[0].contents[0].parts;
    expect(parts.length).toBe(2);
    expect(parts[1].text).not.toContain('LANDMARK REFERENCE PHOTO');
  });
});
