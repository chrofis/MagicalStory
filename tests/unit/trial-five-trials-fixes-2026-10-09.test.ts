/**
 * Five staging trials of 2026-10-09 (job_1791496201302_6vgktllu5 .. job_1791496986667_r4sgw3870):
 *  1. early avatar styling: the standard sheet must not wait for prepare-title
 *  2. VB-REF "NO usable cell": the sheet's cells reach the final parse
 *  3. COVER TYPO POST initialPage error on a mode that never renders one
 *  4. trial progress never goes backwards
 *  5. the trial records ideaPick (picked card + both cards)
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-five-trials';
const pipeline = require('../../storyJobPipeline.js');
const vb = require('../../server/lib/visualBible.js');
const { log: pipelineLog } = require('../../server/lib/serverLog');
const { log } = require('../../server/utils/logger');
const database = require('../../server/services/database.js');
const trialRouter = require('../../server/routes/trial.js');
const ideaEvents = require('../../server/lib/ideaEvents.js');
const root = path.resolve(__dirname, '../..');

afterEach(() => { vi.restoreAllMocks(); });

describe('1. early avatar styling: the two sheets never wait for each other', () => {
  const reqs = [
    { pageNumber: 'pre-cover', clothingCategory: 'costumed:pirate', characterNames: ['T'] },
    { pageNumber: 'pre-cover', clothingCategory: 'standard', characterNames: ['T'] },
  ];
  it('with nothing prepared the standard sheet is styled at once; costumed waits for prepare-title, is seeded, and is styled once', async () => {
    const order: string[] = [];
    let releaseTitle!: () => void;
    const titleReady = new Promise<void>(r => { releaseTitle = r; });
    const style = vi.fn(async (r: any[]) => { order.push(`style:${r.map(x => x.clothingCategory).join('+')}`); });
    const seed = vi.fn((a: any) => { order.push(`seed:${a ? Object.keys(a.T).join('+') : 'none'}`); });
    const done = pipeline.runTrialEarlyStyling({
      requirements: reqs, titleAvatarsReady: titleReady, standardAvatarsReady: null,
      awaitPrepared: async (_ready: any, what: string) => { expect(what).toBe('prepare-title'); await titleReady; return { T: { costumed: { pirate: 'x' } } }; },
      jobStartAvatars: null, seed, style, onDone: () => order.push('done'),
    });
    await new Promise(r => setTimeout(r, 20));
    // Title still running: the standard sheet is already being styled.
    expect(order).toEqual(['seed:none', 'style:standard']);
    releaseTitle();
    await done;
    expect(order).toEqual(['seed:none', 'style:standard', 'seed:costumed', 'style:costumed:pirate', 'done']);
    expect(style).toHaveBeenCalledTimes(2); // no duplicate costumed styling
  });

  it('with no prepare call in flight it seeds the job-start row first, then styles both', async () => {
    const order: string[] = [];
    await pipeline.runTrialEarlyStyling({
      requirements: reqs, titleAvatarsReady: null, standardAvatarsReady: null, awaitPrepared: async () => { throw new Error('must not wait'); },
      jobStartAvatars: { T: {} }, seed: () => order.push('seed'), style: async (r: any[]) => { order.push(`style:${r.length}`); },
    });
    expect(order[0]).toBe('seed');
    expect(order.slice(1).sort()).toEqual(['style:1', 'style:1']);
  });

  it('a failed prepare-title wait is logged, and both sheets are still styled (the cover needs the costumed one)', async () => {
    const err = vi.spyOn(pipelineLog, 'error').mockImplementation(() => {});
    const style = vi.fn(async () => {});
    await pipeline.runTrialEarlyStyling({
      requirements: reqs, titleAvatarsReady: Promise.resolve(), standardAvatarsReady: null, awaitPrepared: async () => { throw new Error('timeout'); },
      jobStartAvatars: null, seed: () => {}, style,
    });
    // staging job_1791554548909_kl0phznw2: the costumed half gave up on a wait timeout and the front cover shipped missing
    expect(style).toHaveBeenCalledTimes(2);
    expect(style.mock.calls.map((c: any) => c[0][0].clothingCategory).sort()).toEqual(['costumed:pirate', 'standard']);
    expect(err.mock.calls.some(c => /costumed avatar wait failed: timeout/.test(String(c[0])))).toBe(true);
  });
});

describe('2. reference cells reach the final parse', () => {
  const mk = () => ({
    secondaryCharacters: [], animals: [], vehicles: [], locations: [],
    artifacts: [{
      id: 'ART001', name: 'ship', appearsInPages: [1, 2], referenceImageGenerated: false,
      states: [
        { id: 'ART001.1', name: 'sail on', pages: [1], referenceImageUrl: null, referenceImageData: null },
        { id: 'ART001.2', name: 'sail off', pages: [2], referenceImageUrl: null, referenceImageData: null },
      ],
    }],
  });
  it('a stated artifact rendered on the stream-time object is usable on the final parse after adoption', () => {
    const streaming: any = mk();
    const final: any = mk(); // the re-parse: same entries, no cells
    vb.updateElementReferenceImage(streaming, 'ART001.1', 'data:x', 'https://r2/a1.jpg');
    vb.updateElementReferenceImage(streaming, 'ART001.2', 'data:x', 'https://r2/a2.jpg');
    const err = vi.spyOn(log, 'error').mockImplementation(() => {});
    expect(vb.getElementReferenceImagesForPage(final, 1)).toEqual([]);
    expect(err.mock.calls.some(c => /NO usable cell/.test(String(c[0])))).toBe(true); // the defect
    err.mockClear();
    expect(vb.adoptReferenceRenders(streaming, final)).toBe(2);
    const refs = vb.getElementReferenceImagesForPage(final, 1);
    expect(refs).toHaveLength(1);
    expect(refs[0].referenceImageUrl).toBe('https://r2/a1.jpg');
    expect(err.mock.calls.some(c => /NO usable cell/.test(String(c[0])))).toBe(false);
  });
  it('is a no-op for the same object and keeps a render the target already has', () => {
    const a: any = mk();
    expect(vb.adoptReferenceRenders(a, a)).toBe(0);
    const b: any = mk();
    b.artifacts[0].states[0].referenceImageUrl = 'https://keep';
    vb.updateElementReferenceImage(a, 'ART001.1', 'data:x', 'https://other');
    vb.adoptReferenceRenders(a, b);
    expect(b.artifacts[0].states[0].referenceImageUrl).toBe('https://keep');
  });
  it('the trial path adopts the cells right after awaiting the sheet', () => {
    const src = fs.readFileSync(path.join(root, 'storyJobPipeline.js'), 'utf8');
    expect(src).toMatch(/adoptReferenceRenders\(streamingVisualBible, visualBible\)/);
  });
});

describe('3. cover typography skips a cover the mode never renders', () => {
  it('no "no served version" error for initialPage when notProducedKeys names it; still errors for a real miss', async () => {
    const { bakeCoverTypographyPostPersist } = require('../../server/lib/coverTypography.js');
    vi.spyOn(database, 'dbQuery').mockResolvedValue([]);
    const err = vi.spyOn(log, 'error').mockImplementation(() => {});
    vi.spyOn(log, 'debug').mockImplementation(() => {});
    await bakeCoverTypographyPostPersist('s1', {}, { title: 'T', notProducedKeys: ['initialPage'] });
    const initialErrs = (c: any[][]) => c.filter(x => /initialPage: no served version/.test(String(x[0]))).length;
    expect(initialErrs(err.mock.calls)).toBe(0);
    expect(err.mock.calls.some(x => /frontCover: no served version/.test(String(x[0])))).toBe(true);
    err.mockClear();
    await bakeCoverTypographyPostPersist('s1', {}, { title: 'T' });
    expect(initialErrs(err.mock.calls)).toBe(1);
  });
  it('the pipeline passes it for trials only', () => {
    const src = fs.readFileSync(path.join(root, 'storyJobPipeline.js'), 'utf8');
    expect(src).toMatch(/notProducedKeys: inputData\.trialMode \? \['initialPage'\] : \[\]/);
  });
});

describe('4. progress is monotonic', () => {
  it('every streaming checkpoint type the parser emits is mapped; coverScene no longer falls to 1', () => {
    const parser = fs.readFileSync(path.join(root, 'server/lib/outlineParser/progressive.js'), 'utf8');
    const types = [...parser.matchAll(/onProgress\('(\w+)'/g)].map(m => m[1]);
    expect(types.length).toBeGreaterThan(5);
    for (const t of new Set(types)) expect(pipeline.streamingProgressFor(t), t).not.toBeNull();
    expect(pipeline.streamingProgressFor('coverScene')).toBe(7);
    expect(pipeline.streamingProgressFor('nonsense')).toBeNull();
  });
  it('the streaming and start writes cannot lower progress', () => {
    const src = fs.readFileSync(path.join(root, 'storyJobPipeline.js'), 'utf8');
    expect(src).toMatch(/progress = GREATEST\(progress, \$1\), progress_message = \$2[^\n]*\n\s*\[progress, enhancedMessage, jobId\]/);
    expect(src).toMatch(/progress = GREATEST\(progress, \$1\)[^\n]*\n\s*\[1, 'Starting story generation\.\.\.'/);
  });
});

describe('5. the trial records ideaPick', () => {
  it('buildTrialIdeaPick keeps the pick and both cards, drops anything invalid', () => {
    const p = ideaEvents.buildTrialIdeaPick({ index: 1, attempt: 2, offered: [{ title: 'A', summary: 'a' }, { title: 'B', summary: 'b' }, { title: 'C', summary: 'c' }] });
    expect(p.index).toBe(1);
    expect(p.world.world).toBe('fantasy');
    expect(p.attempt).toBe(2);
    expect(p.offered).toEqual([{ title: 'A', summary: 'a' }, { title: 'B', summary: 'b' }]);
    expect(ideaEvents.buildTrialIdeaPick({ index: 0 }).world.world).toBe('location');
    expect(ideaEvents.buildTrialIdeaPick({ index: 7 })).toBeNull();
    expect(ideaEvents.buildTrialIdeaPick(undefined)).toBeNull();
  });
  it('create-story stores it on the job input and records the idea_picked event', async () => {
    const inserted: any[] = [];
    const events: any[] = [];
    const pool = {
      query: async (sql: string, params: any[]) => {
        if (/stories_generated = stories_generated \+ 1/.test(sql)) return { rows: [{ id: 'u1', stories_generated: 1 }] };
        if (/SELECT id FROM users WHERE id = \$1 AND is_trial = true/.test(sql)) return { rows: [{ id: 'u1' }] };
        if (/SELECT stories_generated FROM users/.test(sql)) return { rows: [{ stories_generated: 0 }] };
        if (/FROM story_jobs/.test(sql)) return { rows: [] };
        if (/FROM characters/.test(sql)) return { rows: [{ data: { characters: [{ id: 7, name: 'Lukas', age: '7', gender: 'male', traits: {}, physical: {}, photos: {} }] } }] };
        if (/UPDATE users SET trial_data/.test(sql)) return { rows: [] };
        if (/INSERT INTO story_jobs/.test(sql)) { inserted.push(params); return { rows: [] }; }
        if (/INSERT INTO idea_events/.test(sql)) { events.push(params); return Promise.resolve({ rows: [] }); }
        throw new Error(`unexpected query: ${sql.slice(0, 80)}`);
      },
    };
    const origGetPool = database.getPool;
    database.getPool = () => pool;
    try {
      trialRouter.initTrialRoutes({ processStoryJob: () => Promise.resolve() });
      const layer = trialRouter.stack.find((l: any) => l.route?.path === '/create-story');
      const handler = layer.route.stack[layer.route.stack.length - 1].handle;
      const res: any = { statusCode: 200, body: null };
      res.status = (c: number) => { res.statusCode = c; return res; };
      res.json = (b: any) => { res.body = b; return res; };
      await handler({
        body: {
          storyCategory: 'life-challenge', storyTopic: 'reading-alone', storyTheme: 'wizard', storyDetails: 'x', language: 'de',
          userLocation: { city: 'Baden', country: 'Schweiz' }, ideaKind: 'fantasy',
          ideaPick: { index: 1, attempt: 1, offered: [{ title: 'A', summary: 'a' }, { title: 'B', summary: 'b' }] },
        },
        sessionUser: { userId: 'u1' }, headers: {}, ip: '127.0.0.1',
      }, res);
      expect(res.statusCode).toBe(200);
      const input = JSON.parse(inserted[0][3]);
      expect(input.ideaPick.index).toBe(1);
      expect(input.ideaPick.offered).toHaveLength(2);
      expect(events).toHaveLength(1);
      // columns: environment, event, user_id, story_id, ..., arm_index is the 15th
      expect(events[0][1]).toBe('idea_picked');
      expect(events[0][3]).toBe(res.body.jobId);
      expect(events[0][14]).toBe(1);
    } finally {
      database.getPool = origGetPool;
    }
  });
  it('the wizard and the trial share one idea_picked writer', () => {
    const jobs = fs.readFileSync(path.join(root, 'server/routes/jobs.js'), 'utf8');
    expect(jobs).toMatch(/recordIdeaPicked\(inputData/);
    expect(jobs).not.toMatch(/event: 'idea_picked'/);
  });
});
