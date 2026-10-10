/**
 * Trial speed (docs/decisions.md 2026-10-08).
 *
 * 1. POST /api/trial/create-story must NOT await an in-flight prepare-title: it
 *    blocked 28 s on staging job_1791490151653 before the job existed. It
 *    creates and starts the job at once and hands the in-flight promise to the
 *    job (processStoryJob(jobId, { titleAvatarsReady })), which waits for it
 *    right before the avatar step, so the sheets are styled once, not twice.
 * 2. The trial path runs NO arc panel / reviewers: the three panel calls seen in
 *    that staging log belonged to a concurrent 18-page beats job. A trial is
 *    always the single-call writer.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-trial-wait';
const trialRouter = require('../../server/routes/trial.js');
const database = require('../../server/services/database.js');
const { awaitPreparedAvatars } = require('../../storyJobPipeline.js');
const { resolvePipelineMode } = require('../../server/lib/beatsPipeline.js');

const root = path.resolve(__dirname, '../..');

function createStoryHandler() {
  const layer = trialRouter.stack.find((l: any) => l.route?.path === '/create-story');
  const handlers = layer.route.stack.map((s: any) => s.handle);
  return handlers[handlers.length - 1];
}

function fakePool() {
  return {
    query: async (sql: string) => {
      if (/stories_generated = stories_generated \+ 1/.test(sql)) return { rows: [{ id: 'u1', stories_generated: 1 }] };
      if (/SELECT id FROM users WHERE id = \$1 AND is_trial = true/.test(sql)) return { rows: [{ id: 'u1' }] };
      if (/SELECT stories_generated FROM users/.test(sql)) return { rows: [{ stories_generated: 0 }] };
      if (/FROM story_jobs/.test(sql)) return { rows: [] };
      if (/FROM characters/.test(sql)) {
        return { rows: [{ data: { characters: [{ id: 7, name: 'Lukas', age: '7', gender: 'male', traits: {}, physical: {}, photos: {}, preGeneratedStyledAvatars: null }] } }] };
      }
      if (/UPDATE users SET trial_data/.test(sql)) return { rows: [] };
      if (/INSERT INTO story_jobs/.test(sql)) return { rows: [] };
      throw new Error(`unexpected query in test: ${sql.slice(0, 80)}`);
    },
  };
}

const origGetPool = database.getPool;
afterEach(() => {
  database.getPool = origGetPool;
  trialRouter.inFlightTitlePagePromises.clear();
  trialRouter.inFlightStandardAvatarPromises.clear();
});

describe('create-story does not await an in-flight prepare-title', () => {
  it('answers and starts the job while prepare-title is still running, handing the promise to the job', async () => {
    database.getPool = () => fakePool();
    const started: any[] = [];
    trialRouter.initTrialRoutes({ processStoryJob: (jobId: string, opts: any) => { started.push({ jobId, opts }); return Promise.resolve(); } });

    // A prepare-title that never finishes during this test.
    const never = new Promise<void>(() => {});
    trialRouter.inFlightTitlePagePromises.set('u1', never);

    const res: any = { statusCode: 200, body: null };
    res.status = (c: number) => { res.statusCode = c; return res; };
    res.json = (b: any) => { res.body = b; return res; };
    const req: any = {
      body: { storyCategory: 'life-challenge', storyTopic: 'reading-alone', storyTheme: 'wizard', storyDetails: 'x', language: 'de', userLocation: { city: 'Baden', country: 'Schweiz' } },
      sessionUser: { userId: 'u1' }, headers: {}, ip: '127.0.0.1',
    };
    const handler = createStoryHandler();
    // If the handler awaited `never`, this race would resolve to 'blocked'.
    const outcome = await Promise.race([
      handler(req, res).then(() => 'done'),
      new Promise(r => setTimeout(() => r('blocked'), 1500)),
    ]);
    expect(outcome).toBe('done');
    expect(res.statusCode).toBe(200);
    expect(res.body.jobId).toMatch(/^job_/);
    expect(started).toHaveLength(1);
    expect(started[0].opts.titleAvatarsReady).toBe(never);
  });

  it('passes no wait when no prepare-title is in flight', async () => {
    database.getPool = () => fakePool();
    const started: any[] = [];
    trialRouter.initTrialRoutes({ processStoryJob: (jobId: string, opts: any) => { started.push(opts); return Promise.resolve(); } });
    const res: any = { statusCode: 200, body: null };
    res.status = (c: number) => { res.statusCode = c; return res; };
    res.json = (b: any) => { res.body = b; return res; };
    await createStoryHandler()({
      body: { storyCategory: 'life-challenge', storyTopic: 'reading-alone', storyTheme: 'wizard', storyDetails: 'x', language: 'de', userLocation: { city: 'Baden', country: 'Schweiz' } },
      sessionUser: { userId: 'u1' }, headers: {}, ip: '127.0.0.1',
    }, res);
    expect(started[0].titleAvatarsReady).toBeNull();
  });

  it('the handler source no longer races a 60 s wait on the in-flight promise', () => {
    const src = fs.readFileSync(path.join(root, 'server/routes/trial.js'), 'utf8');
    expect(src).not.toMatch(/Awaiting in-flight prepare-title/);
  });
});

describe('the job awaits a prepare call, then reads what it persisted', () => {
  const rowWith = (avatars: any) => ({ query: async () => ({ rows: [{ data: { characters: [{ id: 7, preGeneratedStyledAvatars: avatars }] } }] }) });

  it('waits for the in-flight promise before reading the row (no read while styling runs)', async () => {
    let released = false;
    let readBeforeRelease = false;
    const pool = { query: async () => { if (!released) readBeforeRelease = true; return { rows: [{ data: { characters: [{ id: 7, preGeneratedStyledAvatars: { Lukas: { costumed: { default: 'x' } } } }] } }] }; } };
    let release!: () => void;
    const ready = new Promise<void>(r => { release = r; });
    const p = awaitPreparedAvatars(ready, { userId: 'u1', characterId: 7, what: 'prepare-title', pool });
    await new Promise(r => setTimeout(r, 30));
    released = true; release();
    expect(await p).toEqual({ Lukas: { costumed: { default: 'x' } } });
    expect(readBeforeRelease).toBe(false);
  });

  it('returns null when prepare-title persisted nothing (it failed): the job then styles fresh, once', async () => {
    expect(await awaitPreparedAvatars(Promise.resolve(), { userId: 'u1', characterId: 7, what: 'prepare-title', pool: rowWith(null) })).toBeNull();
  });

  it('throws on timeout instead of silently defaulting', async () => {
    await expect(awaitPreparedAvatars(new Promise(() => {}), { userId: 'u1', characterId: 7, what: 'prepare-title', timeoutMs: 20, pool: rowWith(null) }))
      .rejects.toThrow(/prepare-title still styling avatars/);
  });

  it('throws when the character is gone from the row', async () => {
    await expect(awaitPreparedAvatars(Promise.resolve(), { userId: 'u1', characterId: 99, what: 'prepare-title', pool: rowWith(null) }))
      .rejects.toThrow(/not in characters_u1/);
  });
});

describe('the trial path makes no arc-panel call', () => {
  it('a trial always resolves to the single-call unified writer, never the beats arc machine', () => {
    expect(resolvePipelineMode({ trialMode: true })).toBe('unified');
    expect(resolvePipelineMode({ trialMode: true, pipelineMode: 'beats' })).toBe('unified');
  });

  it('the trial writer path in storyJobPipeline never reaches the panel', () => {
    const src = fs.readFileSync(path.join(root, 'storyJobPipeline.js'), 'utf8');
    expect(src).not.toMatch(/arc_panel|buildArcPanelPrompt|arcPanelModels/);
    for (const f of ['prompts/story-trial-arc.txt', 'prompts/story-trial-pages.txt']) {
      expect(fs.readFileSync(path.join(root, f), 'utf8'), f).not.toMatch(/panel/i);
    }
  });
});

describe('the in-flight promise reaches the unified job', () => {
  // Regression: 9a6c4a889 read opts.titleAvatarsReady and job.user_id inside
  // processUnifiedStoryJob, where neither is in scope (ReferenceError on every
  // trial). The promise travels as that function's own parameter.
  it('processUnifiedStoryJob takes both in-flight promises and the impl passes them', () => {
    const src = fs.readFileSync(path.join(root, 'storyJobPipeline.js'), 'utf8');
    expect(src).toContain('checkCancellation = async () => {}, titleAvatarsReady = null, standardAvatarsReady = null) {');
    expect(src).toMatch(/processUnifiedStoryJob\([^;]*opts\.titleAvatarsReady \|\| null, opts\.standardAvatarsReady \|\| null\)/);
    const body = src.slice(src.indexOf('async function processUnifiedStoryJob('), src.indexOf('async function _processStoryJobImpl('));
    expect(body).not.toMatch(/\bopts\.(titleAvatarsReady|standardAvatarsReady)\b/);
  });
});
