/**
 * Trial avatar timing (docs/decisions.md 2026-10-09 "the standard avatar sheet starts at the form, the preview
 * avatar is gone"). Owner: "Why is the standard one not done before the story starts? Why do we create a separate
 * one? Cheap and early, so the story spinner already has something."
 *
 *  1. the standard sheet starts at the form: the client fires prepare-standard-avatar once the account exists and
 *     the form is quiet (and at Next), the server styles ONLY the standard sheet, with no topic;
 *  2. prepare-title (costumed) and the story job reuse it: prepare-title never styles a standard sheet, the job seeds
 *     it (or awaits the in-flight call) and styles nothing twice, a sheet drawn for another age/gender is not reused;
 *  3. the waiting-page slides hold the standard cells from the first poll (both sheets, rebuilt race-free);
 *  4. the preview avatar is gone: no route, no prompt, no client call, nothing that read it is left.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-standard-early';
const trialRouter = require('../../server/routes/trial.js');
const database = require('../../server/services/database.js');
const trialSheets = require('../../server/lib/trialSheets.js');
const avatarSlides = require('../../server/lib/avatarSlides.js');
const { markCutCell, brandCutList, writeCutSlides } = require('../../server/lib/clientAvatarImages.js');
const cell = (label: string) => markCutCell('data:image/jpeg;base64,' + label);
const STAMP = trialSheets.standardSheetStamp({ age: '8', gender: 'male' });
const { log } = require('../../server/utils/logger');
const pipeline = require('../../storyJobPipeline.js');
const root = path.resolve(__dirname, '../..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

function finalHandler(routePath: string) {
  const layer = trialRouter.stack.find((l: any) => l.route?.path === routePath);
  if (!layer) throw new Error(`no route ${routePath}`);
  const handlers = layer.route.stack.map((s: any) => s.handle);
  return handlers[handlers.length - 1];
}
function fakeRes() {
  const res: any = { statusCode: 200, body: null, headersSent: false };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: any) => { res.body = b; res.headersSent = true; return res; };
  return res;
}
const row = (over: any = {}) => ({
  id: 7, name: 'Kid', age: '8', gender: 'male', photos: { face: 'https://r2/face.jpg' }, physical: { hairColor: 'brown' },
  ...over,
});
function fakePool(state: { char: any }) {
  return {
    query: async (sql: string) => {
      if (/SELECT stories_generated FROM users/.test(sql)) return { rows: [{ stories_generated: 0 }] };
      if (/SELECT data FROM characters/.test(sql)) return { rows: [{ data: { characters: [state.char] } }] };
      return { rows: [] };
    },
  };
}

const origGetPool = database.getPool;
afterEach(() => {
  database.getPool = origGetPool;
  trialRouter.inFlightTitlePagePromises.clear();
  trialRouter.inFlightStandardAvatarPromises.clear();
  vi.restoreAllMocks();
});

describe('1. the standard sheet starts at the form', () => {
  const step = read('client/src/pages/trial/TrialCharacterStep.tsx');

  it('the client fires prepare-standard-avatar from the quiet-form trigger and at Next, once, after syncing the details', () => {
    expect(step).toContain('/api/trial/prepare-standard-avatar');
    // one call per account
    expect(step).toMatch(/if \(standardAvatarStartedRef\.current\) return;\s*\n\s*standardAvatarStartedRef\.current = true;/);
    // the row is brought up to date BEFORE the sheet is drawn (age "1" while "10" is typed)
    expect(step.indexOf('await syncDetails(token);')).toBeGreaterThan(step.indexOf('const startStandardAvatar'));
    expect(step.indexOf('await syncDetails(token);')).toBeLessThan(step.indexOf('/api/trial/prepare-standard-avatar'));
    // the quiet-form effect and Next both start it
    expect(step).toMatch(/setTimeout\(async \(\) => \{\s*\n\s*const account = await accountCreationPromiseRef\.current;\s*\n\s*if \(account\) startStandardAvatar\(account\.sessionToken\);/);
    expect(step).toMatch(/void startStandardAvatar\(activeSession!\.sessionToken\);/);
    // not awaited by the wizard: Next does not wait for it
    expect(step).not.toMatch(/await startStandardAvatar/);
  });

  it('the client sends no topic with it, and the picture it gets back is the hero avatar', () => {
    const call = step.slice(step.indexOf('/api/trial/prepare-standard-avatar'), step.indexOf('/api/trial/prepare-standard-avatar') + 400);
    expect(call).toContain("body: '{}'");
    expect(step).toContain('showHero(result.avatarImage, true)');
  });

  it('the server styles ONLY the standard sheet, with no topic, and stamps the age/gender it was drawn for', async () => {
    const state = { char: row() };
    database.getPool = () => fakePool(state);
    const style = vi.spyOn(trialSheets, 'styleAndPersistTrialSheets').mockResolvedValue({ slides: ['s0', 's1'] });
    vi.spyOn(avatarSlides, 'frontBodyCell').mockResolvedValue(cell('FRONT'));
    // the sheet is on the row after styling (the real persist wrote it)
    style.mockImplementation(async () => { state.char = row({ preGeneratedStyledAvatars: { Kid: { standard: 'https://r2/std.jpg' } }, preGeneratedStandardFor: STAMP }); return { slides: ['s0'] }; });

    const res = fakeRes();
    await finalHandler('/prepare-standard-avatar')({ sessionUser: { userId: 'u1' }, body: {}, headers: {} }, res);

    expect(style).toHaveBeenCalledTimes(1);
    const args = style.mock.calls[0][0];
    expect(args.requirements).toEqual([{ pageNumber: 'pre-cover', clothingCategory: 'standard', characterNames: ['Kid'] }]);
    expect(args.fields).toEqual({ preGeneratedStandardFor: STAMP });
    expect(STAMP).toBe('gender:male'); // gender only: an age band or tier difference keeps the sheet
    expect(args.styleOptions.skipQualityEval).toBe(true); // the job's own options for this sheet
    expect(JSON.stringify(args)).not.toMatch(/costumed:/);
    expect(res.body).toEqual({ avatarImage: cell('FRONT') });
    expect(trialRouter.inFlightStandardAvatarPromises.has('u1')).toBe(false); // released
  });

  it('while it runs, create-story can hand its promise to the job; a duplicate call is refused', async () => {
    const state = { char: row() };
    database.getPool = () => fakePool(state);
    let release!: () => void;
    const styleGate = new Promise<void>(r => { release = r; });
    vi.spyOn(trialSheets, 'styleAndPersistTrialSheets').mockImplementation(async () => {
      await styleGate;
      state.char = row({ preGeneratedStyledAvatars: { Kid: { standard: 'u' } }, preGeneratedStandardFor: STAMP });
      return { slides: [] };
    });
    vi.spyOn(avatarSlides, 'frontBodyCell').mockResolvedValue(cell('X'));
    const first = finalHandler('/prepare-standard-avatar')({ sessionUser: { userId: 'u1' }, body: {}, headers: {} }, fakeRes());
    await new Promise(r => setTimeout(r, 10));
    expect(trialRouter.inFlightStandardAvatarPromises.has('u1')).toBe(true);
    const dup = fakeRes();
    await finalHandler('/prepare-standard-avatar')({ sessionUser: { userId: 'u1' }, body: {}, headers: {} }, dup);
    expect(dup.statusCode).toBe(409);
    release();
    await first;
    expect(trialRouter.inFlightStandardAvatarPromises.has('u1')).toBe(false);
  });

  it('a repeat call after the sheet exists styles nothing again', async () => {
    const state = { char: row({ preGeneratedStyledAvatars: { Kid: { standard: 'https://r2/std.jpg' } }, preGeneratedStandardFor: STAMP }) };
    database.getPool = () => fakePool(state);
    const style = vi.spyOn(trialSheets, 'styleAndPersistTrialSheets');
    vi.spyOn(avatarSlides, 'frontBodyCell').mockResolvedValue(cell('STORED'));
    const res = fakeRes();
    await finalHandler('/prepare-standard-avatar')({ sessionUser: { userId: 'u1' }, body: {}, headers: {} }, res);
    expect(style).not.toHaveBeenCalled();
    expect(res.body.avatarImage).toBe(cell('STORED'));
  });

  it('a failure is loud (ERROR) and answers 500, so the job styles the sheet itself', async () => {
    database.getPool = () => fakePool({ char: row() });
    vi.spyOn(trialSheets, 'styleAndPersistTrialSheets').mockRejectedValue(new Error('grok down'));
    const err = vi.spyOn(log, 'error').mockImplementation(() => {});
    const res = fakeRes();
    await finalHandler('/prepare-standard-avatar')({ sessionUser: { userId: 'u1' }, body: {}, headers: {} }, res);
    expect(res.statusCode).toBe(500);
    expect(err.mock.calls.some(c => /prepare-standard-avatar failed.*grok down/.test(String(c[0])))).toBe(true);
  });
});

describe('2. prepare-title and the job reuse it', () => {
  it('prepare-title styles only the costumed sheet (never a standard one), with the costume and the parallel rows', async () => {
    database.getPool = () => fakePool({ char: row({ preGeneratedStyledAvatars: { Kid: { standard: 'https://r2/std.jpg' } }, preGeneratedStandardFor: STAMP }) });
    const sent = writeCutSlides({}, brandCutList([cell('A'), cell('B')]), ['https://r2/a.jpg', 'https://r2/b.jpg']);
    const style = vi.spyOn(trialSheets, 'styleAndPersistTrialSheets').mockResolvedValue({ slides: sent });
    const res = fakeRes();
    await finalHandler('/prepare-title')({ sessionUser: { userId: 'u1' }, body: { storyCategory: 'adventure', storyTheme: 'pirate', storyTopic: '' }, headers: {} }, res);
    expect(style).toHaveBeenCalledTimes(1);
    const args = style.mock.calls[0][0];
    expect(args.requirements).toHaveLength(1);
    expect(args.requirements[0].clothingCategory).toMatch(/^costumed:/);
    expect(args.styleOptions.fastPass1).toBe(true);
    expect(args.fields).toHaveProperty('preGeneratedCostumeType');
    expect(res.body.avatarSlides).toEqual(['https://r2/a.jpg', 'https://r2/b.jpg']); // slides of both sheets, built by the persist step
  });

  it('prepare-title with no costume for the topic styles nothing (the old fall-back to a standard sheet is gone)', async () => {
    database.getPool = () => fakePool({ char: row() });
    const style = vi.spyOn(trialSheets, 'styleAndPersistTrialSheets');
    const costumes = require('../../server/config/trialCostumes');
    vi.spyOn(costumes, 'getTrialCostume').mockReturnValue(null);
    const res = fakeRes();
    await finalHandler('/prepare-title')({ sessionUser: { userId: 'u1' }, body: { storyCategory: 'adventure', storyTheme: 'pirate' }, headers: {} }, res);
    expect(style).not.toHaveBeenCalled();
    expect(res.body.costumeType).toBeNull();
  });

  it('create-story hands BOTH in-flight promises to the job', () => {
    const src = read('server/routes/trial.js');
    expect(src).toContain('const standardAvatarsReady = inFlightStandardAvatarPromises.get(userId) || null;');
    expect(src).toContain('deps.processStoryJob(jobId, { titleAvatarsReady, standardAvatarsReady })');
  });

  describe('the job', () => {
    const reqs = [
      { pageNumber: 'pre-cover', clothingCategory: 'costumed:pirate', characterNames: ['Kid'] },
      { pageNumber: 'pre-cover', clothingCategory: 'standard', characterNames: ['Kid'] },
    ];
    it('a finished standard sheet is seeded from the row first; an in-flight one is awaited and seeded; neither is styled by the job', async () => {
      const order: string[] = [];
      let releaseStandard!: () => void;
      const standardReady = new Promise<void>(r => { releaseStandard = r; });
      const seen: string[] = [];
      const done = pipeline.runTrialEarlyStyling({
        requirements: reqs, titleAvatarsReady: null, standardAvatarsReady: standardReady,
        awaitPrepared: async (_r: any, what: string) => { seen.push(what); await standardReady; return { Kid: { standard: 'std' } }; },
        jobStartAvatars: { Kid: { costumed: { pirate: 'cos' } } },
        seed: (a: any) => order.push(`seed:${a ? Object.keys(a.Kid).join('+') : 'none'}`),
        // the real styling skips what the cache holds; here "styled" = asked for, so the order shows who waited
        style: async (r: any[]) => { order.push(`style:${r.map(x => x.clothingCategory).join('+')}`); },
        onDone: () => order.push('done'),
      });
      await new Promise(r => setTimeout(r, 20));
      expect(order).toEqual(['seed:costumed', 'style:costumed:pirate']); // the costumed sheet did not wait for the standard one
      releaseStandard();
      await done;
      expect(seen).toEqual(['prepare-standard-avatar']);
      expect(order).toEqual(['seed:costumed', 'style:costumed:pirate', 'seed:standard', 'style:standard', 'done']);
    });

    it('styling an already seeded standard sheet runs no second sheet generation (the cache hit)', async () => {
      const styled = require('../../server/lib/styledAvatars');
      const sheet = require('../../server/lib/character2x4Sheet');
      const gen = vi.spyOn(sheet, 'generateCharacter2x4Sheet').mockRejectedValue(new Error('a second standard sheet must not be styled'));
      await styled.runInCacheScope('trial-early-reuse', async () => {
        styled.setStyledAvatar('Kid', 'standard', 'watercolor', 'data:image/jpeg;base64,AAAA');
        const kid = { name: 'Kid', age: '8', gender: 'male', photos: { face: 'data:image/jpeg;base64,AAAA' }, avatars: {} };
        await styled.prepareStyledAvatars([kid], 'watercolor', [reqs[1]], { Kid: { standard: { used: true, signature: 'none' }, costumed: { used: false } } }, null, null, { skipQualityEval: true });
        styled.clearStyledAvatarCache();
      });
      expect(gen).not.toHaveBeenCalled();
    });

    it('a standard sheet drawn for another GENDER than the row now holds is NOT reused (loud); another age band is kept, a matching one is', () => {
      const err = vi.spyOn(log, 'error').mockImplementation(() => {});
      const base = { name: 'Kid', age: '10', gender: 'male', preGeneratedStyledAvatars: { Kid: { standard: 's', costumed: { default: 'c' } } } };
      const girlStamp = trialSheets.standardSheetStamp({ age: '10', gender: 'female' });
      const nowStamp = trialSheets.standardSheetStamp({ age: '10', gender: 'male' });
      const stale = trialSheets.usablePreparedAvatars({ ...base, preGeneratedStandardFor: girlStamp });
      expect(stale).toEqual({ Kid: { costumed: { default: 'c' } } });
      expect(err.mock.calls.some(c => String(c[0]).includes(`drawn for "${girlStamp}" but the row now says "${nowStamp}"`))).toBe(true);
      const current = trialSheets.usablePreparedAvatars({ ...base, preGeneratedStandardFor: nowStamp });
      expect(current).toEqual({ Kid: { standard: 's', costumed: { default: 'c' } } });
      // drawn at toddler proportions, row now says 10: kept (owner 2026-10-09)
      const toddler = trialSheets.usablePreparedAvatars({ ...base, preGeneratedStandardFor: trialSheets.standardSheetStamp({ age: '1', gender: 'male' }) });
      expect(toddler).toEqual({ Kid: { standard: 's', costumed: { default: 'c' } } });
      expect(trialSheets.usablePreparedAvatars({ name: 'Kid' })).toBeNull();
    });

    it('the job reads the stamp, passes it and seeds through the one filter', () => {
      const src = read('storyJobPipeline.js');
      expect(src).toContain("jobStartAvatars: require('./server/lib/trialSheets').usablePreparedAvatars((inputData.characters || [])[0])");
      expect(src).toContain("return require('./server/lib/trialSheets').usablePreparedAvatars(main);");
      // the job persists slides only for a standard sheet it styled itself
      expect(src).toContain('const styled = !standardPrepared && main && getStyledAvatarsForCharacter(main, artStyle);');
      expect(read('server/routes/trial.js')).toContain('preGeneratedStandardFor: characterData._preGeneratedStandardFor || null,');
    });
  });
});

describe('3. the slides hold the standard cells from job start', () => {
  const fakeDeps = (rowChar: any, built: string[][]) => ({
    offload: async () => {},
    storeSlides: async (_c: string, _u: string, slides: string[]) => [...slides],
    modifyRow: async (_id: string, _u: string, mutate: any) => {
      const data = { characters: [rowChar] };
      if ((await mutate(data)) === false) return null;
      return data;
    },
    readCharacter: async () => rowChar,
    buildSlides: async (sheets: any) => { const label = Object.keys(sheets).sort().join('+'); built.push([label]); return brandCutList([cell(label)]); },
  });

  it('merges the new sheet into the row and cuts slides from every sheet the row then holds', async () => {
    const rowChar: any = { id: 7, preGeneratedStyledAvatars: { Kid: { costumed: { default: 'cos' } } } };
    const built: string[][] = [];
    const slides = await trialSheets.persistPreparedSheets({ userId: 'u1', characterId: 'characters_u1', exported: { Kid: { standard: 'std' } }, fields: { preGeneratedStandardFor: STAMP } }, fakeDeps(rowChar, built));
    expect(rowChar.preGeneratedStyledAvatars.Kid).toEqual({ costumed: { default: 'cos' }, standard: 'std' });
    expect(rowChar.preGeneratedStandardFor).toBe(STAMP);
    expect(built).toEqual([['costumed+standard']]); // the slides cover BOTH sheets
    expect(slides).toEqual([cell('costumed+standard')]);
    expect(rowChar.preGeneratedAvatarSlides).toEqual([cell('costumed+standard')]);
  });

  it('when the other endpoint lands its sheet while the slides are cut, the cut is redone (the last writer never drops a sheet)', async () => {
    const rowChar: any = { id: 7, preGeneratedStyledAvatars: { Kid: { standard: 'std' } } };
    let calls = 0;
    const deps = {
      ...fakeDeps(rowChar, []),
      buildSlides: async (sheets: any) => {
        calls++;
        const label = Object.keys(sheets).sort().join('+');
        if (calls === 1) rowChar.preGeneratedStyledAvatars.Kid.costumed = { default: 'cos' }; // prepare-title persists meanwhile
        return brandCutList([cell(label)]);
      },
    };
    const info = vi.spyOn(log, 'info').mockImplementation(() => {});
    const slides = await trialSheets.persistPreparedSheets({ userId: 'u1', characterId: 'c', exported: { Kid: { standard: 'std' } } }, deps);
    expect(calls).toBe(2);
    expect(slides).toEqual([cell('costumed+standard')]);
    expect(rowChar.preGeneratedAvatarSlides).toEqual([cell('costumed+standard')]);
    expect(info.mock.calls.some(c => /changed while the slides were cut/.test(String(c[0])))).toBe(true);
  });

  it('gives up loudly (throws) rather than store slides that lack a sheet', async () => {
    const rowChar: any = { id: 7, preGeneratedStyledAvatars: { Kid: { standard: 'std' } } };
    let n = 0;
    const deps = { ...fakeDeps(rowChar, []), buildSlides: async () => { rowChar.preGeneratedStyledAvatars.Kid.costumed = { default: `c${++n}` }; return brandCutList([cell('x')]); } };
    vi.spyOn(log, 'info').mockImplementation(() => {});
    await expect(trialSheets.persistPreparedSheets({ userId: 'u1', characterId: 'c', exported: { Kid: { standard: 'std' } } }, deps)).rejects.toThrow(/kept changing/);
    expect(rowChar.preGeneratedAvatarSlides).toBeUndefined();
  });

  it('only the sheets a request asked for are persisted (the scope cache may hold the other one)', () => {
    const all = { Kid: { standard: 'std', costumed: { default: 'cos' } } };
    expect(trialSheets.onlyRequestedSheets(all, [{ clothingCategory: 'standard' }])).toEqual({ Kid: { standard: 'std' } });
    expect(trialSheets.onlyRequestedSheets(all, [{ clothingCategory: 'costumed:pirate' }])).toEqual({ Kid: { costumed: { default: 'cos' } } });
  });

  it('slides alternate the two sheets, so a standard cell is in the first pairs', async () => {
    expect(avatarSlides.interleaveSheetSlides([['c0', 'c1', 'c2', 'c3'], ['s0', 's1', 's2', 's3']])).toEqual(['c0', 'c1', 's0', 's1', 'c2', 'c3', 's2', 's3']);
  });
});

describe('4. the preview avatar is gone: its decision and what read it', () => {
  it('no route, no prompt builder, no client call', () => {
    expect(trialRouter.stack.some((l: any) => l.route?.path === '/generate-preview-avatar')).toBe(false);
    expect(read('server/routes/trial.js')).not.toMatch(/generate-preview-avatar'|buildTrialPreviewAvatarPrompt/);
    expect(require('../../server/lib/trialAge.js').buildTrialPreviewAvatarPrompt).toBeUndefined();
    for (const f of ['client/src/pages/trial/TrialCharacterStep.tsx', 'client/src/pages/TrialWizard.tsx', 'client/src/pages/trial/TrialTopicStep.tsx', 'client/src/pages/TrialGenerationPage.tsx']) {
      expect(read(f), f).not.toMatch(/generate-preview-avatar|previewAvatar|onAvatarGenerated/);
    }
  });

  it('nothing seeds avatars.standard from a preview, and the account no longer stores one', () => {
    const src = read('server/routes/trial.js');
    expect(src).not.toMatch(/previewAvatar/);
    expect(src).not.toMatch(/avatars: \{ standard:/);
    const account = src.slice(src.indexOf("router.post('/create-anonymous-account'"), src.indexOf("router.patch('/update-character-details'"));
    expect(account).not.toMatch(/previewAvatar/);
    expect(read('server/lib/avatarHair.js')).not.toMatch(/previewAvatar/);
    expect(read('scripts/admin/trial-showcase.js')).not.toMatch(/generate-preview-avatar/);
  });

  it('the job does not read a trial hero\'s hair from an avatar that does not exist yet', () => {
    expect(read('storyJobPipeline.js')).toMatch(/if \(!inputData\.trialMode\) \{\s*\n\s*await require\('\.\/server\/lib\/avatarHair'\)\.ensureAvatarDerivedHair/);
  });

  it('the funnel step avatar_ready follows character_saved and is optional (the sheet arrives after the account)', () => {
    const steps = trialRouter.TRIAL_FUNNEL_STEPS as string[];
    expect(steps.indexOf('avatar_ready')).toBe(steps.indexOf('character_saved') + 1);
    expect(trialRouter.OPTIONAL_TRIAL_STEPS.has('avatar_ready')).toBe(true);
    // an optional step never becomes the baseline for the next one
    const rows = trialRouter.buildTrialFunnelRows(new Map([['landing', 10], ['character_saved', 8], ['avatar_ready', 3], ['character_done', 7]]));
    const done = rows.find((r: any) => r.step === 'character_done');
    expect(done.droppedFromPrev).toBe(1); // 8 -> 7, not 3 -> 7
  });
});

describe('the front body cell the wizard shows', () => {
  it('is cut from a 2x4 sheet as one whole front-facing body cell and refuses a portrait', async () => {
    const sharp = require('sharp');
    const sheet = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: { r: 255, g: 255, b: 255 } } }).jpeg().toBuffer();
    const cell = await avatarSlides.frontBodyCell(sheet);
    expect(cell).toMatch(/^data:image\/jpeg;base64,/);
    const meta = await sharp(Buffer.from(cell.split(',')[1], 'base64')).metadata();
    expect(meta.width).toBeLessThan(1024);
    const portrait = await sharp({ create: { width: 300, height: 900, channels: 3, background: { r: 255, g: 255, b: 255 } } }).jpeg().toBuffer();
    await expect(avatarSlides.frontBodyCell(portrait)).rejects.toThrow(/not a 2x4 sheet/);
  });
});

describe('the awaited row is filtered like the job-start row', () => {
  it('a standard sheet drawn for another age/gender is dropped after the wait, a costumed one is kept', async () => {
    vi.spyOn(log, 'error').mockImplementation(() => {});
    const pool = { query: async () => ({ rows: [{ data: { characters: [{ id: 7, name: 'Kid', age: '10', gender: 'male', preGeneratedStandardFor: '1|male', preGeneratedStyledAvatars: { Kid: { standard: 's', costumed: { default: 'c' } } } }] } }] }) };
    const got = await pipeline.awaitPreparedAvatars(Promise.resolve(), { userId: 'u1', characterId: 7, what: 'prepare-standard-avatar', pool });
    expect(got).toEqual({ Kid: { costumed: { default: 'c' } } });
  });
});
