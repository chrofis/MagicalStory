/**
 * The plate QC judges what the plate's author was given (2026-09-26, owner-approved).
 *
 * - ERA: the brief's `era`, classified by the author's own era guard
 *   (buildEraGuard). A present-day story whose cast dresses up as pirates was
 *   judged "pirate era" on every plate by the deleted costume derivation
 *   (staging job_1790446348343_z3fw660ie).
 * - FRAMING: the author's FRAMING paragraph rides whole, with a framing check.
 *   Since the second change the same day, EXPECTED SCENE (the setting text,
 *   passed apart from the FRAMING) and MAIN SCENE PROSE ride whole too, and the
 *   QC gets the STRUCTURES text and the Visual Bible grid the author got.
 * - LIGHT: a declared covered sky and fog have failure cases of their own.
 * - DETAIL VIEWS: labelled crops of the plate follow it, so small things can
 *   be seen.
 * - PHOTO: every reader of a landmark photo gets one text for it — the stored
 *   description plus what the photo judge saw (landmark_photo_scores.reason).
 *
 * No network: fetch is stubbed.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);

let build: any;
let ev: any;
let pb: any;
let lp: any;

beforeAll(async () => {
  await require_('../../server/services/prompts.js').loadPromptTemplates();
  ev = require_('../../server/lib/evalPipeline.js');
  build = ev.buildEmptySceneQcPrompt;
  pb = require_('../../server/lib/promptBuilders.js');
  lp = require_('../../server/lib/landmarkPhotos.js');
});

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

async function noiseJpeg(w: number, h: number, seed = 1): Promise<string> {
  const sharp = require_('sharp');
  const buf = Buffer.alloc(w * h * 3);
  let x = seed;
  for (let i = 0; i < buf.length; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; buf[i] = 60 + (x % 150); }
  const jpg = await sharp(buf, { raw: { width: w, height: h, channels: 3 } }).jpeg().toBuffer();
  return `data:image/jpeg;base64,${jpg.toString('base64')}`;
}

describe('era: the brief era through the author\'s era guard', () => {
  it('a present-day era gets no era block and no anachronism check', () => {
    const p = build({ sceneDescription: 'A quay.', era: 'present day' });
    expect(p).not.toContain('STORY ERA');
    expect(p).not.toContain('Anachronistic elements');
  });
  it('a historical era gets both', () => {
    const p = build({ sceneDescription: 'A quay.', era: 'medieval town, ~1300' });
    expect(p).toContain('STORY ERA: medieval town, ~1300');
    expect(p).toContain('Anachronistic elements');
  });
  it('the costume derivation is gone', () => {
    expect(require_('../../server/lib/plateQc.js').plateStoryEra).toBeUndefined();
  });
});

describe('framing: the whole FRAMING paragraph and a framing check', () => {
  const framing = 'From a low landing looking sharply up at a massive stone wall towering overhead. '.repeat(6).trim();
  it('rides uncut beside an uncut EXPECTED SCENE and MAIN SCENE PROSE (2026-09-26: no cap)', () => {
    const setting = '**LOCATION:** An old harbour town on a river. '.repeat(12).trim();
    const prose = 'The children climb the worn steps toward the wall, lanterns in hand. '.repeat(20).trim();
    expect(setting.length).toBeGreaterThan(300);
    expect(prose.length).toBeGreaterThan(800);
    const p = build({ sceneDescription: setting, framing, mainScenePrompt: prose });
    expect(p).toContain(`FRAMING (what the plate's author was told the frame holds): "${framing}"`);
    expect(p).toContain(`EXPECTED SCENE: "${setting}"`);
    expect(p).toContain(`"${prose}"`);
    // Callers pass the setting and the FRAMING apart: the paragraph appears once.
    expect(p.split(framing).length - 1).toBe(1);
    expect(p).toContain('- Framing:');
    expect(p).toContain('framing (the structure or view the FRAMING puts in the frame)');
  });
  it('no framing, no framing check', () => {
    const p = build({ sceneDescription: 'A quay.' });
    expect(p).not.toContain('- Framing:');
    expect(p).not.toContain('FRAMING (what');
  });
  it('the landmark check scopes the photo to how structures look, never what fills the frame', () => {
    const p = build({ sceneDescription: 'A wall.', framing: 'A wall.', landmarkName: 'Old Town Wall' });
    expect(p).toContain('never which structure or view fills the frame');
    expect(p).not.toContain('matches the photograph and not the words is a PASS');
    // the author's fidelity block reads the same scoped sentence
    expect(pb.LANDMARK_PHOTO_AUTHORITY).toContain('It never decides which structure or view fills the frame');
    expect(pb.buildLandmarkFidelityBlock({ name: 'Old Town Wall' })).toContain(pb.LANDMARK_PHOTO_AUTHORITY);
    expect(p).toContain(pb.LANDMARK_PHOTO_AUTHORITY);
  });
});

describe('light: a covered sky and fog have their own failure cases', () => {
  it('fog adds the covered-sky and the fog lines, filed under `light`', () => {
    const p = build({ sceneDescription: 'A quay.', light: { timeOfDay: 'dusk', weather: 'fog' } });
    expect(p).toContain('the weather is fog, so the sky is covered');
    expect(p).toContain('visible sun or moon disc');
    expect(p).toContain('Light, fog:');
    expect(p.match(/check key `light`/g)?.length).toBe(2);
  });
  it('overcast adds the covered-sky line only', () => {
    const p = build({ sceneDescription: 'A quay.', light: { timeOfDay: 'afternoon', weather: 'overcast' } });
    expect(p).toContain('the weather is overcast, so the sky is covered');
    expect(p).not.toContain('Light, fog:');
  });
  it('a clear sky and an interior add neither', () => {
    for (const weather of ['clear', 'none']) {
      const p = build({ sceneDescription: 'A quay.', light: { timeOfDay: 'afternoon', weather } });
      expect(p).not.toContain('so the sky is covered');
      expect(p).not.toContain('Light, fog:');
    }
  });
});

describe('detail views: labelled crops of the plate', () => {
  it('seven crops, each fitted to 768 px, labelled', async () => {
    const plate = await noiseJpeg(1024, 1024, 5);
    const parts = await ev.plateDetailViewParts(Buffer.from(plate.split(',')[1], 'base64'));
    expect(parts.length).toBe(ev.PLATE_DETAIL_VIEWS.length * 2);
    expect(ev.PLATE_DETAIL_VIEWS.map((v: any) => v.label)).toContain('bottom-right corner');
    const sharp = require_('sharp');
    for (let i = 0; i < parts.length; i += 2) {
      expect(parts[i].text).toMatch(/^\[Detail view of the plate — .+, enlarged\]:$/);
      const meta = await sharp(Buffer.from(parts[i + 1].inline_data.data, 'base64')).metadata();
      expect(Math.max(meta.width, meta.height)).toBe(768);
    }
  });
  it('the prompt names the views, and says a crop\'s cut sides are not the plate\'s edges', () => {
    const p = build({ sceneDescription: 'A quay.', detailViews: ['top-left quarter', 'centre'] });
    expect(p).toContain('DETAIL VIEWS: after the plate come enlarged parts of the same plate — top-left quarter, centre');
    expect(p).toContain("cut sides are not the plate's edges");
  });
  it('validateEmptyScene sends them after the plate and names the era, framing and photo text', async () => {
    const plate = await noiseJpeg(512, 512, 7);
    const photo = await noiseJpeg(64, 64, 3);
    const bodies: any[] = [];
    vi.stubEnv('GEMINI_API_KEY', 'test-key');
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: any) => {
      bodies.push(JSON.parse(init.body));
      return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: '{"pass": true, "issues": []}' }] } }] }) };
    }));
    await ev.validateEmptyScene(plate, null, 'unit', {
      sceneDescription: 'A wall.', framing: 'Looking up at a wall.', era: 'present day',
      landmarkPhoto: { name: 'Old Town Wall', photoData: photo, description: '[whole, green, day] A stone wall.', judgedView: 'a mossy wall above a river' },
    });
    const parts = bodies[0].contents[0].parts;
    expect(parts[0].text).toBe('[Background plate to judge]:');
    expect(parts[2].text).toMatch(/^\[Detail view of the plate/);
    const prompt = parts[parts.length - 1].text;
    expect(prompt).toContain('FRAMING (what the plate\'s author was told the frame holds): "Looking up at a wall."');
    expect(prompt).not.toContain('STORY ERA');
    expect(prompt).toContain('The landmark index records this photograph as: "[whole, green, day] A stone wall. Photo judge: a mossy wall above a river."');
  });
});

describe('structures: the QC gets the STRUCTURES text and the grid the plate author got', () => {
  const visualBible = {
    vehicles: [{ id: 'VEH001', name: 'Blue boat', description: 'A blue single-mast sailing boat with a red stripe.', appearsInPages: [4] }],
    artifacts: [],
  };
  it('one builder: the plate prompt\'s STRUCTURES block and the QC\'s input are the same text', () => {
    const prompts = require_('../../server/services/prompts.js');
    const text = prompts.buildPlateStructuresText({ visualBible, pageNumber: 4, aboardId: null, sceneObjects: ['VEH001'] });
    expect(text).toContain('A blue single-mast sailing boat with a red stripe.');
    const platePrompt = prompts.buildEmptyScenePrompt({ style: 'watercolor', description: '**SHOT:** wide\n\nA quay.', visualBible, pageNumber: 4, sceneObjects: ['VEH001'] });
    expect(platePrompt).toContain(`**STRUCTURES:** ${text}`);
    const p = build({ sceneDescription: '**SHOT:** wide', framing: 'A quay.', structures: text });
    expect(p).toContain(text);
    expect(p).not.toContain('STRUCTURE REFERENCE');
    // Not staged by the brief: neither side gets it.
    expect(prompts.buildPlateStructuresText({ visualBible, pageNumber: 4, sceneObjects: [] })).toBe('');
    expect(build({ sceneDescription: 'A quay.' })).not.toContain('STRUCTURES');
  });
  it('validateEmptyScene attaches the grid, labelled, and the prompt names it', async () => {
    const plate = await noiseJpeg(512, 512, 9);
    const gridUrl = await noiseJpeg(64, 64, 4);
    const grid = Buffer.from(gridUrl.split(',')[1], 'base64');
    const bodies: any[] = [];
    vi.stubEnv('GEMINI_API_KEY', 'test-key');
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: any) => {
      bodies.push(JSON.parse(init.body));
      return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: '{"pass": true, "issues": []}' }] } }] }) };
    }));
    await ev.validateEmptyScene(plate, null, 'unit', { sceneDescription: 'A quay.', structures: 'Any vessel … - Blue boat: blue.', structureGrid: grid });
    const parts = bodies[0].contents[0].parts;
    const i = parts.findIndex((x: any) => x.text === '[Visual Bible reference]:');
    expect(i).toBeGreaterThan(0);
    expect(parts[i + 1].inline_data.data).toBe(grid.toString('base64'));
    const prompt = parts[parts.length - 1].text;
    expect(prompt).toContain('STRUCTURES (what the plate\'s author was told');
    expect(prompt).toContain('STRUCTURE REFERENCE: the image labelled [Visual Bible reference]');
  });
});

describe('photo text: description + what the photo judge saw, one source for every reader', () => {
  const row = {
    photo_url: 'https://x/1.jpg', photo_description: '[whole, green, day] A square.', photo_type: 'exterior',
    photo_url_2: 'https://x/2.jpg', photo_description_2: '[distant, bare, day] A guild hall across a river.', photo_type_2: null,
    photo_scores: { 1: 80, 2: 72 }, photo_framings: { 1: 'medium', 2: 'wide' },
    photo_reasons: { 2: 'old houses seen across the river' },
  };
  it('variantsFromIndexRow carries the judge\'s reason as judgedView', () => {
    const v = lp.variantsFromIndexRow(row);
    expect(v[0].judgedView).toBeNull();
    expect(v[1].judgedView).toBe('old houses seen across the river');
  });
  it('the numbered PHOTOS list reads it through landmarkPhotoText', () => {
    const lines = pb.landmarkPhotoListLines({ photoVariants: lp.variantsFromIndexRow(row) }, '');
    expect(lines).toBe([
      'Photo 1 (exterior, framed medium): [whole, green, day] A square.',
      'Photo 2 (distant, framed wide): [distant, bare, day] A guild hall across a river. Photo judge: old houses seen across the river.',
    ].join('\n'));
  });
  it('the SQL reads the reason beside score and framing', () => {
    const src = require_('node:fs').readFileSync(require_.resolve('../../server/lib/landmarkPhotos.js'), 'utf8');
    expect(src).toMatch(/jsonb_object_agg\(s\.slot, s\.reason\)[\s\S]*AS photo_reasons/);
  });
});
