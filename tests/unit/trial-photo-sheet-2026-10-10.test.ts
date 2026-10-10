/**
 * Trial: the standard sheet starts at the photo (docs/decisions.md 2026-10-09 "Trial: the body row starts at the photo", now the whole
 * ONE-CALL sheet: 2026-10-10 "one-call sheets in the trial"). Owner: "start the avatar immediately, at the face pick, from the photo's
 * age and gender estimates; cut it and show the front cell the moment it is available. Never show a row or a whole sheet anywhere:
 * always cut first, only single images."
 *
 *  1. the photo's own estimates draw the sheet; a later differing band/tier keeps it, a gender change redraws it once;
 *  2. the front cell reaches the client from the finished sheet; the client never receives a row or a sheet (one hand-off);
 *  3. a changed photo replaces the photo on the same account.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-body-row';
const sharp = require('sharp');
const trialRouter = require('../../server/routes/trial.js');
const database = require('../../server/services/database.js');
const trialSheets = require('../../server/lib/trialSheets.js');
const trialAge = require('../../server/lib/trialAge.js');
const avatarSlides = require('../../server/lib/avatarSlides.js');
const sheetCut = require('../../server/lib/sheetCut.js');
const clientImages = require('../../server/lib/clientAvatarImages.js');
const { log } = require('../../server/utils/logger');
const root = path.resolve(__dirname, '../..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

// A 1x4 full-body row as the generator draws it (16:9) and a 2x4 sheet (about 1:1), both on four equal columns.
async function bodyRow(background = '#fff') {
  const buf = await sharp({ create: { width: 1280, height: 720, channels: 3, background } })
    .composite([0, 1, 2, 3].map(c => ({ input: { create: { width: 160, height: 600, channels: 3, background: { r: 40 * (c + 1), g: 90, b: 160 } } }, left: c * 320 + 80, top: 60 })))
    .jpeg().toBuffer();
  return `data:image/jpeg;base64,${buf.toString('base64')}`;
}
async function wholeSheet() {
  const buf = await sharp({ create: { width: 1280, height: 1300, channels: 3, background: '#fff' } }).jpeg().toBuffer();
  return `data:image/jpeg;base64,${buf.toString('base64')}`;
}

function finalHandler(routePath: string, method = 'post') {
  const layer = trialRouter.stack.find((l: any) => l.route?.path === routePath && l.route.methods[method]);
  if (!layer) throw new Error(`no route ${method} ${routePath}`);
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
  id: 7, name: 'Child', age: '', gender: '', photos: { face: 'https://r2/face.jpg', bodyNoBg: 'https://r2/body.png' }, physical: { hairColor: 'brown' },
  photoEstimate: { apparentAge: 'kindergartner', gender: 'female' }, ...over,
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
// The cells of a 1x4 row, cut by the figure cutter (sheetCut.js) and registered as cut cells, the way the slide cutters do.
async function cutCells(rowUri: string) {
  const parts = await sheetCut.cutSheet(Buffer.from(rowUri.split(',')[1], 'base64'), { rows: 1, cols: 4 });
  const cells: string[] = [];
  for (const part of parts) cells.push(`data:image/jpeg;base64,${(await sharp(part).jpeg().toBuffer()).toString('base64')}`);
  return clientImages.brandCutList(cells);
}
const origGetPool = database.getPool;
afterEach(() => {
  database.getPool = origGetPool;
  trialRouter.inFlightStandardAvatarPromises.clear();
  trialRouter.standardSheetDraws?.clear();
  vi.restoreAllMocks();
});

describe('1. who the sheet is drawn for, and when it is redrawn', () => {
  it('the photo estimate is the category and the gender, and only male/female count as a gender', () => {
    expect(trialAge.photoEstimateOf({ apparentAge: 'kindergartner', gender: 'Female' })).toEqual({ apparentAge: 'kindergartner', gender: 'female' });
    expect(trialAge.photoEstimateOf({ apparentAge: 'toddler', gender: 'other' })).toEqual({ apparentAge: 'toddler', gender: '' });
    expect(trialAge.photoEstimateOf({})).toBeNull();
    expect(trialAge.photoEstimateOf(null)).toBeNull();
  });
  it('an age category maps to the middle year of its group inside the trial range', () => {
    const r = trialAge.representativeTrialAge;
    expect([r('infant'), r('toddler'), r('preschooler'), r('kindergartner'), r('young-school-age'), r('school-age'), r('preteen'), r('young-teen'), r('teenager')])
      .toEqual([1, 2, 4, 6, 8, 10, 12, 14, 16]);
    expect(r('adult')).toBe(18);
    expect(r('not-a-category')).toBeNull();
  });
  it('the stamp is the gender only: a trial keeps the drawn sheet across any age band or tier (owner 2026-10-09), a gender change redraws', () => {
    const stamp = trialSheets.standardSheetStamp;
    expect(stamp({ age: '7', gender: 'male' })).toBe(stamp({ age: '8', gender: 'male' }));
    expect(stamp({ age: '8', gender: 'male' })).toBe(stamp({ age: '9', gender: 'male' }));      // next band: kept
    expect(stamp({ age: '11', gender: 'male' })).toBe(stamp({ age: '12', gender: 'male' }));    // across the child/teen phantom: kept
    expect(stamp({ age: '1', gender: 'male' })).toBe(stamp({ age: '16', gender: 'male' }));
    expect(stamp({ age: '8', gender: 'male' })).not.toBe(stamp({ age: '8', gender: 'female' }));
  });

  const FRONT = () => clientImages.markCutCell('data:image/jpeg;base64,FRONTCELL');
  // The one styling helper stands in for the sheet: it records what it was asked and puts the sheet on the row, like the real one.
  function fakeSheet(state: { char: any }) {
    const style = vi.spyOn(trialSheets, 'styleAndPersistTrialSheets').mockImplementation(async (args: any) => {
      state.char = { ...state.char, preGeneratedStandardFor: args.fields.preGeneratedStandardFor, preGeneratedStyledAvatars: { [args.character.name]: { standard: 'https://r2/std.jpg' } } };
      return { slides: ['s1', 's2'] };
    });
    vi.spyOn(avatarSlides, 'frontBodyCell').mockResolvedValue(FRONT());
    return style;
  }

  it('prepare-standard-body draws the ONE-CALL sheet from the photo estimate while the form is empty and answers with the front cell only', async () => {
    const state = { char: row() };
    database.getPool = () => fakePool(state);
    const style = fakeSheet(state);
    const res = fakeRes();
    await finalHandler('/prepare-standard-body')({ sessionUser: { userId: 'u1' }, body: {}, headers: {} }, res);

    expect(style).toHaveBeenCalledTimes(1);
    const args = style.mock.calls[0][0];
    expect(args.character.age).toBe('6');           // kindergartner -> its middle year
    expect(args.character.gender).toBe('female');   // the photo's estimate
    expect(args.styleOptions).toEqual({ seasonOutfit: expect.anything() }); // the one path: no per-sheet mode flags
    expect(args.requirements.map((r: any) => r.clothingCategory)).toEqual(['standard']);
    expect(args.fields.preGeneratedStandardFor).toBe('gender:female');
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.body)).toEqual(['avatarImage']);   // one cut figure, never a row or a sheet
    expect(res.body.avatarImage).toBe('data:image/jpeg;base64,FRONTCELL');
  });

  it('the sheet is registered for create-story and update-photo while it is drawn, and a second call joins it instead of drawing again', async () => {
    const state = { char: row() };
    database.getPool = () => fakePool(state);
    let release: () => void = () => {};
    const style = vi.spyOn(trialSheets, 'styleAndPersistTrialSheets').mockImplementation(() => new Promise<any>((r) => { release = () => { state.char = { ...state.char, preGeneratedStyledAvatars: { Child: { standard: 'x' } } }; r({ slides: [] }); }; }));
    vi.spyOn(avatarSlides, 'frontBodyCell').mockResolvedValue(FRONT());
    const first = fakeRes();
    const call1 = finalHandler('/prepare-standard-body')({ sessionUser: { userId: 'u1' }, body: {}, headers: {} }, first);
    await new Promise(r => setTimeout(r, 20));
    expect(trialRouter.inFlightStandardAvatarPromises.has('u1')).toBe(true);
    expect(trialRouter.inFlightStandardSheetsOnRow.has('u1')).toBe(true);
    const second = fakeRes();
    const call2 = finalHandler('/prepare-standard-body')({ sessionUser: { userId: 'u1' }, body: {}, headers: {} }, second);
    release();
    await Promise.all([call1, call2]);
    expect(style).toHaveBeenCalledTimes(1);
    expect(first.body).toEqual(second.body);
    expect(trialRouter.inFlightStandardAvatarPromises.has('u1')).toBe(false);
  });

  it('a failed draw is loud (ERROR), answers 500 and leaves no entry, so the form-time call draws the sheet', async () => {
    database.getPool = () => fakePool({ char: row() });
    vi.spyOn(trialSheets, 'styleAndPersistTrialSheets').mockRejectedValue(new Error('grok refused'));
    const err = vi.spyOn(log, 'error').mockImplementation(() => {});
    const res = fakeRes();
    await finalHandler('/prepare-standard-body')({ sessionUser: { userId: 'u1' }, body: {}, headers: {} }, res);
    expect(res.statusCode).toBe(500);
    expect(res.body.avatarImage).toBeUndefined();
    expect(err.mock.calls.some(c => /prepare-standard-body failed for user u1: grok refused/.test(String(c[0])))).toBe(true);
    await new Promise(r => setTimeout(r, 5));
    expect(trialRouter.standardSheetDraws.has('u1')).toBe(false);
    expect(trialRouter.inFlightStandardAvatarPromises.has('u1')).toBe(false);
  });

  it('with no declared age and no usable estimate it stops loudly instead of guessing', async () => {
    database.getPool = () => fakePool({ char: row({ photoEstimate: undefined }) });
    const style = vi.spyOn(trialSheets, 'styleAndPersistTrialSheets');
    const err = vi.spyOn(log, 'error').mockImplementation(() => {});
    const res = fakeRes();
    await finalHandler('/prepare-standard-body')({ sessionUser: { userId: 'u1' }, body: {}, headers: {} }, res);
    expect(style).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(422);
    expect(err.mock.calls.some(c => /no declared age and no photo age estimate/.test(String(c[0])))).toBe(true);
  });

  async function runBothPhases(declared: { age: string; gender: string }) {
    const state = { char: row() };
    database.getPool = () => fakePool(state);
    const style = fakeSheet(state);
    await finalHandler('/prepare-standard-body')({ sessionUser: { userId: 'u1' }, body: {}, headers: {} }, fakeRes());
    // the visitor then declares their values (update-character-details); the avatar call finds the sheet on the row
    state.char = { ...state.char, name: 'Mia', age: declared.age, gender: declared.gender, preGeneratedStyledAvatars: { Mia: { standard: 'https://r2/std.jpg' } } };
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const res = fakeRes();
    await finalHandler('/prepare-standard-avatar')({ sessionUser: { userId: 'u1' }, body: {}, headers: {} }, res);
    return { style, warn, res };
  }

  it('declared values in the same band, tier and gender: the form-time call TAKES the sheet drawn at the photo (no extra call)', async () => {
    const { style, warn, res } = await runBothPhases({ age: '5', gender: 'female' });
    expect(style).toHaveBeenCalledTimes(1);
    expect(res.body.avatarImage).toBe('data:image/jpeg;base64,FRONTCELL');
    expect(warn.mock.calls.some(c => /drawn for/.test(String(c[0])))).toBe(false);
  });

  it('a different age band or tier declared: the drawn sheet is KEPT and the stamp on the row matches it, so the job seeds the sheet', async () => {
    const other = await runBothPhases({ age: '9', gender: 'female' }); // estimate is band 5-6, the declaration band 9-10
    expect(other.style).toHaveBeenCalledTimes(1);
    expect(other.warn.mock.calls.some(c => /drawn for/.test(String(c[0])))).toBe(false);
    const stamp = other.style.mock.calls[0][0].fields.preGeneratedStandardFor;
    const kept = trialSheets.usablePreparedAvatars({ name: 'Mia', age: '9', gender: 'female', preGeneratedStandardFor: stamp, preGeneratedStyledAvatars: { Mia: { standard: 's' } } });
    expect(kept).toEqual({ Mia: { standard: 's' } });
  });

  it('a gender change declared at an age above 2: the sheet is drawn ONCE more, loudly, with the declared identity', async () => {
    const otherGender = await runBothPhases({ age: '5', gender: 'male' });
    expect(otherGender.style).toHaveBeenCalledTimes(2);
    expect(otherGender.style.mock.calls[1][0].character.gender).toBe('male');
    expect(otherGender.style.mock.calls[1][0].fields.preGeneratedStandardFor).toBe('gender:male');
    expect(otherGender.warn.mock.calls.some(c => String(c[0]).includes('declared another gender (age above 2) — drawing it again'))).toBe(true);
    expect(otherGender.res.statusCode).toBe(200);
  });

  it('with no sheet drawn at the photo, the form-time call draws it from the declaration', async () => {
    const state = { char: row({ name: 'Mia', age: '7', gender: 'male' }) };
    database.getPool = () => fakePool(state);
    const style = fakeSheet(state);
    const res = fakeRes();
    await finalHandler('/prepare-standard-avatar')({ sessionUser: { userId: 'u1' }, body: {}, headers: {} }, res);
    expect(style).toHaveBeenCalledTimes(1);
    expect(style.mock.calls[0][0].styleOptions).toEqual({ seasonOutfit: expect.anything() });
    expect(style.mock.calls[0][0].fields.preGeneratedStandardFor).toBe('gender:male');
    expect(res.body.avatarImage).toBe('data:image/jpeg;base64,FRONTCELL');
  });
});

describe('2. the client never receives a row or a sheet', () => {
  it('heroForClient passes only a cell the cutters made: a row, a sheet or any other image throws', async () => {
    const row = await bodyRow();
    const sheet = await wholeSheet();
    expect(() => clientImages.heroForClient(row)).toThrow(/never shown/);
    expect(() => clientImages.heroForClient(sheet)).toThrow(/never shown/);
    expect(() => clientImages.heroForClient('https://r2/sheet.jpg')).toThrow();
    const [front] = await cutCells(row);
    expect(clientImages.heroForClient(front)).toBe(front);
  });
  it('slides can be stored only from the cutters, and only the stamped list is sent', async () => {
    const stored: any = {};
    const wholeRow = await bodyRow();
    const cutForMismatch = await cutCells(wholeRow);
    expect(() => clientImages.writeCutSlides(stored, [wholeRow], ['u'])).toThrow(/never a slide/);
    expect(() => clientImages.writeCutSlides(stored, cutForMismatch, ['only-one'])).toThrow(/does not match/);
    const cut = await cutCells(await bodyRow());
    const urls = cut.map((_c: string, i: number) => `https://r2/cell${i}.jpg`);
    const sent = clientImages.writeCutSlides(stored, cut, urls);
    expect(clientImages.slidesForClient(sent)).toEqual(urls);
    expect(clientImages.slidesForClient(stored)).toEqual(urls);
    expect(() => clientImages.slidesForClient(['https://r2/a-whole-sheet.jpg'])).toThrow();
    // a sheet written into the slides field by anything else is not sent
    const err = vi.spyOn(log, 'error').mockImplementation(() => {});
    expect(clientImages.slidesForClient({ preGeneratedAvatarSlides: ['https://r2/sheet.jpg'], preGeneratedAvatarSlidesDigest: 'x' })).toEqual([]);
    expect(clientImages.slidesForClient({ ...stored, preGeneratedAvatarSlides: ['https://r2/sheet.jpg'] })).toEqual([]);
    expect(err.mock.calls.length).toBe(2);
  });
  it('a cell wider than a column of its source is refused (isSingleCellWidth)', () => {
    expect(clientImages.isSingleCellWidth(256, 1024)).toBe(true);
    expect(clientImages.isSingleCellWidth(1024, 1024)).toBe(false);
    expect(clientImages.isSingleCellWidth(512, 1024)).toBe(false);
  });
  it('every avatar payload in the trial routes goes through the hand-off functions', () => {
    const src = read('server/routes/trial.js');
    const lines = src.split('\n');
    const payloads = lines.map((l, i) => ({ l, prev: lines[i - 1] || '' }))
      .filter(({ l }) => /avatarImage:|avatarSlides[:=]|response\.avatarSlides/.test(l) && /res\.json|response\.avatarSlides/.test(l));
    expect(payloads.length).toBeGreaterThanOrEqual(6);
    for (const { l, prev } of payloads) {
      const viaHandOff = /heroForClient\(|slidesForClient\(|avatarSlides: \[\]/.test(l) || (/= slides;/.test(l) && /const slides = slidesForClient\(/.test(prev));
      expect(viaHandOff, `avatar payload bypasses the hand-off: ${l.trim()}`).toBe(true);
    }
    // nothing reads the stored slides or a sheet into a response any other way
    expect(src).not.toMatch(/avatarSlides: (mainChar|slides(?!ForClient)|charData)/);
    // the row never leaves the server: no route answers with a row, a sheet or its image data
    expect(src).not.toMatch(/res\.json\([^)]*\b(bodyRow|\.row|headRow|imageData)\b/);
  });
  it('the cut-out photo is not shown as the hero: the client shows only the hero cell the server sent', () => {
    const step = read('client/src/pages/trial/TrialCharacterStep.tsx');
    const wizard = read('client/src/pages/TrialWizard.tsx');
    expect(step).toContain('src={heroAvatar}');
    expect(step).not.toMatch(/src=\{[^}]*bodyNoBg/);
    expect(wizard).toContain('useState<string | null>(null);');
    expect(wizard).not.toMatch(/setHeroAvatar\([^)]*(bodyNoBg|photos)/);
  });
});

describe('3. the client starts the account and the sheet at the photo', () => {
  const step = read('client/src/pages/trial/TrialCharacterStep.tsx');
  it('the account is created when the photo has landed (provisional), with only the values that are valid', () => {
    expect(step).toMatch(/if \(!hasPhoto\) return;\s*\n\s*if \(sessionToken\) return;[\s\S]{0,600}startAccountCreation\(\)/);
    expect(step).toContain('provisional: !formComplete,');
    expect(step).toContain("age: isValidTrialAge(String(data.age || '')) ? data.age : ''");
  });
  it('the sheet is requested once the account exists, and its front cell becomes the hero', () => {
    expect(step).toContain('/api/trial/prepare-standard-body');
    expect(step).toMatch(/if \(response\.ok && result\.avatarImage\) showHero\(result\.avatarImage\);/);
    // one picture source: no unstyled-first / styled-later distinction is left
    expect(step).not.toContain('styledHeroRef');
  });
  it('a different photo after the account exists replaces the photo on the same account and starts again', () => {
    expect(step).toContain('/api/trial/update-photo');
    expect(step).toMatch(/standardAvatarStartedRef\.current = false;\s*\n\s*photoSheetStartedRef\.current = false;/);
    const route = read('server/routes/trial.js');
    expect(route).toContain("router.put('/update-photo'");
    for (const k of ["'photoEstimate'", "'preGeneratedStyledAvatars'", "'preGeneratedAvatarSlides'", "'physical'"]) expect(route).toContain(k);
  });
  it('the provisional session is kept by the wizard, so a returning visitor reuses the account and a new photo goes to update-photo', () => {
    expect(step).toMatch(/\.then\(\(account\) => \{ if \(account\) onAccountCreated\?\.\(account\.sessionToken, account\.characterId\); return account; \}\)/);
    // a restored session (no account made by this page) takes a newly analysed photo through update-photo, and its sheet waits for that
    expect(step).toContain('if (!accountFace && !sessionToken) return;');
    expect(step).toContain('|| !accountPhotoRef.current) return;');
    // Next on an existing session still starts the sheet (no-op when the quiet-form trigger did)
    expect(step).toMatch(/await syncDetails\(sessionToken\);\s*void startStandardAvatar\(sessionToken\);/);
  });
  it('the details phase shows the hero above the form, and the sheet still waits for the declared form', () => {
    expect(step).toContain('{heroAvatar && (');
    expect(step).toMatch(/if \(!canProceed \|\| standardAvatarStartedRef\.current\) return;/);
  });
});

describe('5. a rename moves the sheets; a persisted sheet lands under the row\'s current name', () => {
  it('update-character-details re-keys the sheets of a renamed character', () => {
    const route = read('server/routes/trial.js');
    expect(route).toMatch(/if \(oldName !== c\.name && c\.preGeneratedStyledAvatars\?\.\[oldName\]\) \{/);
  });
  it('persistPreparedSheets keys the merge by the row\'s current name', async () => {
    const rowChar: any = { id: 7, name: 'Mia' };
    const deps = {
      offload: async () => {},
    storeSlides: async (_c: string, _u: string, slides: string[]) => [...slides],
      modifyRow: async (_i: string, _u: string, mutate: any) => { const d = { characters: [rowChar] }; return (await mutate(d)) === false ? null : d; },
      readCharacter: async () => rowChar,
      buildSlides: async () => clientImages.brandCutList([clientImages.markCutCell('data:image/jpeg;base64,Z')]),
    };
    await trialSheets.persistPreparedSheets({ userId: 'u', characterId: 'c', exported: { Child: { standard: 'std' } } }, deps);
    expect(Object.keys(rowChar.preGeneratedStyledAvatars)).toEqual(['Mia']);
  });
});

describe('4. the early full-body row and its styling are gone (docs/decisions.md 2026-10-10 "one-call sheets in the trial")', () => {
  it('no body-row endpoint helper, row cutter or row styling is left', () => {
    const src = read('server/routes/trial.js');
    expect(src).not.toMatch(/bodyRowCells|styleBodyRow|generateStandardBodyRow|persistBodyRowSlides|standardBodyRows/);
    expect(read('server/lib/avatarSlides.js')).not.toMatch(/bodyRowCells|slidesOfBodyRowCells/);
    expect(read('server/lib/character2x4Sheet.js')).not.toMatch(/bodyRowOnly|async function styleBodyRow|async function generateBodyRow/);
  });
});
