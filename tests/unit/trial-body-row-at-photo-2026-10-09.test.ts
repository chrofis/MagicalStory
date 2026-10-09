/**
 * Trial: the standard avatar's FULL-BODY row starts at the photo (docs/decisions.md 2026-10-09 "Trial: the body row starts at the
 * photo"). Owner: "Why does the avatar come later now? Start the 4 full-body images immediately, at the face pick, from the
 * photo's age and gender estimates; cut them and show the FIRST full-body cell the moment it is available. Never show a row or a
 * whole sheet anywhere: always cut first, only single images."
 *
 *  1. the body row is its own render before the head row, and a sheet reuses a row drawn ahead of it (no extra call);
 *  2. the account is created at the photo (provisional), the photo's own estimates draw the row, a later differing band/tier/
 *     gender redraws only that row, never the sheet;
 *  3. the first cell reaches the client before the sheet exists; the client never receives a row or a sheet (one hand-off);
 *  4. a changed photo replaces the photo on the same account.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-body-row';
const sharp = require('sharp');
const trialRouter = require('../../server/routes/trial.js');
const database = require('../../server/services/database.js');
const trialSheets = require('../../server/lib/trialSheets.js');
const trialAge = require('../../server/lib/trialAge.js');
const styled = require('../../server/lib/styledAvatars.js');
const avatarSlides = require('../../server/lib/avatarSlides.js');
const clientImages = require('../../server/lib/clientAvatarImages.js');
const { log } = require('../../server/utils/logger');
const root = path.resolve(__dirname, '../..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

// A 1x4 full-body row as the generator draws it (16:9) and a 2x4 sheet (about 1:1), both on four equal columns.
async function bodyRow() {
  const buf = await sharp({ create: { width: 1280, height: 720, channels: 3, background: '#fff' } })
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
const origGetPool = database.getPool;
afterEach(() => {
  database.getPool = origGetPool;
  trialRouter.inFlightStandardAvatarPromises.clear();
  trialRouter.standardBodyRows?.clear();
  vi.restoreAllMocks();
});

describe('1. the body row is its own render, before the head row', () => {
  const SRC = read('server/lib/character2x4Sheet.js');
  it('generateBodyRow draws the row with the stage generateComposited2x4 itself uses (one implementation)', () => {
    expect(SRC).toMatch(/async function runBodyRowStage\(/);
    expect(SRC).toMatch(/const runBodyRow = async \(\) => precomputedBody \|\| runBodyRowStage\(/);
    expect(SRC).toMatch(/const best = await runBodyRowStage\(/);
    expect(typeof require('../../server/lib/character2x4Sheet.js').generateBodyRow).toBe('function');
  });
  it('the sequential sheet draws the body row first, the head row after it against the accepted body', () => {
    expect(SRC).toMatch(/bestBody = await runBodyRow\(\);\s*\n\s*bestHead = await runHeadRow\(bestBody\.row\);/);
  });
  it('a precomputed body row is threaded through the styling chain and the sheet skips stage 1', () => {
    const s = read('server/lib/styledAvatars.js');
    expect(s).toContain('precomputedBody: precomputedBodies[`${characterName}:${clothingCategory}`] || null');
    expect(s).toMatch(/generateCharacter2x4Sheet\(adHocChar, \{[\s\S]*precomputedBody,/);
    expect(SRC).toMatch(/precomputedBody,\s*\n\s*\.\.\.\(fastPass1/);
  });
});

describe('2. who the row is drawn for, and when it is redrawn', () => {
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
  it('the stamp is the gender only: a trial keeps the drawn body row across any age band or tier (owner 2026-10-09), a gender change redraws', () => {
    const stamp = trialSheets.standardSheetStamp;
    expect(stamp({ age: '7', gender: 'male' })).toBe(stamp({ age: '8', gender: 'male' }));
    expect(stamp({ age: '8', gender: 'male' })).toBe(stamp({ age: '9', gender: 'male' }));      // next band: kept
    expect(stamp({ age: '11', gender: 'male' })).toBe(stamp({ age: '12', gender: 'male' }));    // across the child/teen phantom: kept
    expect(stamp({ age: '1', gender: 'male' })).toBe(stamp({ age: '16', gender: 'male' }));
    expect(stamp({ age: '8', gender: 'male' })).not.toBe(stamp({ age: '8', gender: 'female' }));
  });

  it('prepare-standard-body draws from the photo estimate while the form is empty, answers with the FIRST cell only, and starts no sheet', async () => {
    const state = { char: row() };
    database.getPool = () => fakePool(state);
    const gen = vi.spyOn(styled, 'generateStandardBodyRow').mockResolvedValue({ row: await bodyRow(), review: { valid: true, score: null }, attemptHistory: [], usage: {} });
    const sheet = vi.spyOn(trialSheets, 'styleAndPersistTrialSheets');
    const persisted = vi.spyOn(trialSheets, 'persistBodyRowSlides').mockResolvedValue(null);
    const res = fakeRes();
    await finalHandler('/prepare-standard-body')({ sessionUser: { userId: 'u1' }, body: {}, headers: {} }, res);

    expect(gen).toHaveBeenCalledTimes(1);
    const drawnFor = gen.mock.calls[0][0];
    expect(drawnFor.age).toBe('6');           // kindergartner -> its middle year
    expect(drawnFor.gender).toBe('female');   // the photo's estimate
    expect(sheet).not.toHaveBeenCalled();     // the first picture does not wait for, or start, the sheet
    // one cut figure: a quarter of the row's width, never the row
    expect(Object.keys(res.body)).toEqual(['avatarImage']);
    const meta = await sharp(Buffer.from(res.body.avatarImage.split(',')[1], 'base64')).metadata();
    expect(meta.width).toBe(320);
    expect(meta.height).toBe(720);
    // the other cells feed the slides (front, three-quarter, profile)
    await new Promise(r => setTimeout(r, 5));
    expect(persisted).toHaveBeenCalledTimes(1);
    expect(persisted.mock.calls[0][0].slides).toHaveLength(3);
  });

  it('with no declared age and no usable estimate it stops loudly instead of guessing', async () => {
    database.getPool = () => fakePool({ char: row({ photoEstimate: undefined }) });
    const gen = vi.spyOn(styled, 'generateStandardBodyRow');
    const err = vi.spyOn(log, 'error').mockImplementation(() => {});
    const res = fakeRes();
    await finalHandler('/prepare-standard-body')({ sessionUser: { userId: 'u1' }, body: {}, headers: {} }, res);
    expect(gen).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(422);
    expect(err.mock.calls.some(c => /no declared age and no photo age estimate/.test(String(c[0])))).toBe(true);
  });

  async function runBothPhases(declared: { age: string; gender: string }) {
    const state = { char: row() };
    database.getPool = () => fakePool(state);
    vi.spyOn(styled, 'generateStandardBodyRow').mockResolvedValue({ row: await bodyRow(), review: { valid: true, score: null }, attemptHistory: [{ stage: 'body', try: 1 }], usage: {} });
    vi.spyOn(trialSheets, 'persistBodyRowSlides').mockResolvedValue(null);
    await finalHandler('/prepare-standard-body')({ sessionUser: { userId: 'u1' }, body: {}, headers: {} }, fakeRes());
    // the visitor then declares their values (update-character-details)
    state.char = row({ name: 'Mia', age: declared.age, gender: declared.gender });
    const style = vi.spyOn(trialSheets, 'styleAndPersistTrialSheets').mockImplementation(async () => {
      state.char = row({ name: 'Mia', age: declared.age, gender: declared.gender, preGeneratedStyledAvatars: { Mia: { standard: 'https://r2/std.jpg' } } });
      return { slides: [] };
    });
    vi.spyOn(avatarSlides, 'frontBodyCell').mockResolvedValue(clientImages.markCutCell('data:image/jpeg;base64,FINAL'));
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    await finalHandler('/prepare-standard-avatar')({ sessionUser: { userId: 'u1' }, body: {}, headers: {} }, fakeRes());
    return { style, warn };
  }

  it('declared values in the same band, tier and gender: the sheet REUSES the row drawn at the photo (no extra call)', async () => {
    const { style, warn } = await runBothPhases({ age: '5', gender: 'female' }); // estimate kindergartner(6) is band 5-6, child tier
    const bodies = style.mock.calls[0][0].styleOptions.precomputedBodies;
    expect(Object.keys(bodies)).toEqual(['Mia:standard']);
    expect(bodies['Mia:standard'].row).toMatch(/^data:image\/jpeg/);
    expect(warn.mock.calls.some(c => /drawn for/.test(String(c[0])))).toBe(false);
  });

  it('a different age band or tier declared: the drawn row is KEPT and the stamp on the row matches it, so the job seeds the sheet', async () => {
    const other = await runBothPhases({ age: '9', gender: 'female' }); // estimate is band 5-6, the declaration band 9-10
    expect(Object.keys(other.style.mock.calls[0][0].styleOptions.precomputedBodies)).toEqual(['Mia:standard']);
    expect(other.warn.mock.calls.some(c => /drawn for/.test(String(c[0])))).toBe(false);
    const stamp = other.style.mock.calls[0][0].fields.preGeneratedStandardFor;
    const kept = trialSheets.usablePreparedAvatars({ name: 'Mia', age: '9', gender: 'female', preGeneratedStandardFor: stamp, preGeneratedStyledAvatars: { Mia: { standard: 's' } } });
    expect(kept).toEqual({ Mia: { standard: 's' } });
  });

  it('a gender change declared: only the row is redrawn by the sheet, loudly (never the whole sheet twice)', async () => {
    const otherGender = await runBothPhases({ age: '5', gender: 'male' });
    expect(otherGender.style.mock.calls[0][0].styleOptions.precomputedBodies).toEqual({});
    expect(otherGender.warn.mock.calls.some(c => String(c[0]).includes('(a gender change at age above 2) — the sheet draws its own body row'))).toBe(true);
  });
});

describe('3. the client never receives a row or a sheet', () => {
  it('slides cut from a sheet are single cells, and a body row is cut into four quarter-width cells', async () => {
    const cells = await avatarSlides.bodyRowCells(await bodyRow());
    expect(cells).toHaveLength(4);
    for (const c of cells) expect((await sharp(Buffer.from(c.split(',')[1], 'base64')).metadata()).width).toBe(320);
  });
  it('a sheet or a single figure is refused as a body row', async () => {
    await expect(avatarSlides.bodyRowCells(await wholeSheet())).rejects.toThrow(/not a 1x4 body row/);
  });
  it('heroForClient passes only a cell the cutters made: a row, a sheet or any other image throws', async () => {
    const row = await bodyRow();
    const sheet = await wholeSheet();
    expect(() => clientImages.heroForClient(row)).toThrow(/never shown/);
    expect(() => clientImages.heroForClient(sheet)).toThrow(/never shown/);
    expect(() => clientImages.heroForClient('https://r2/sheet.jpg')).toThrow();
    const [front] = await avatarSlides.bodyRowCells(row);
    expect(clientImages.heroForClient(front)).toBe(front);
  });
  it('slides can be stored only from the cutters, and only the stamped list is sent', async () => {
    const stored: any = {};
    const wholeRow = await bodyRow();
    const cutForMismatch = await avatarSlides.bodyRowCells(wholeRow);
    expect(() => clientImages.writeCutSlides(stored, [wholeRow], ['u'])).toThrow(/never a slide/);
    expect(() => clientImages.writeCutSlides(stored, cutForMismatch, ['only-one'])).toThrow(/does not match/);
    const cut = await avatarSlides.bodyRowCells(await bodyRow());
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

describe('4. the client starts the account and the body row at the photo', () => {
  const step = read('client/src/pages/trial/TrialCharacterStep.tsx');
  it('the account is created when the photo has landed (provisional), with only the values that are valid', () => {
    expect(step).toMatch(/if \(!hasPhoto\) return;\s*\n\s*if \(sessionToken\) return;[\s\S]{0,600}startAccountCreation\(\)/);
    expect(step).toContain('provisional: !formComplete,');
    expect(step).toContain("age: isValidTrialAge(String(data.age || '')) ? data.age : ''");
  });
  it('the body row is requested once the account exists, and its first cell becomes the hero', () => {
    expect(step).toContain('/api/trial/prepare-standard-body');
    expect(step).toMatch(/if \(response\.ok && result\.avatarImage\) showHero\(result\.avatarImage, false\);/);
    // a late body-row answer never replaces the styled picture
    expect(step).toContain('if (!styled && styledHeroRef.current) return;');
  });
  it('a different photo after the account exists replaces the photo on the same account and starts again', () => {
    expect(step).toContain('/api/trial/update-photo');
    expect(step).toMatch(/standardAvatarStartedRef\.current = false;\s*\n\s*bodyRowStartedRef\.current = false;/);
    const route = read('server/routes/trial.js');
    expect(route).toContain("router.put('/update-photo'");
    for (const k of ["'photoEstimate'", "'preGeneratedStyledAvatars'", "'preGeneratedAvatarSlides'", "'physical'"]) expect(route).toContain(k);
  });
  it('the provisional session is kept by the wizard, so a returning visitor reuses the account and a new photo goes to update-photo', () => {
    expect(step).toMatch(/\.then\(\(account\) => \{ if \(account\) onAccountCreated\?\.\(account\.sessionToken, account\.characterId\); return account; \}\)/);
    // a restored session (no account made by this page) takes a newly analysed photo through update-photo, and its body row waits for that
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
      modifyRow: async (_i: string, _u: string, mutate: any) => { const d = { characters: [rowChar] }; return (await mutate(d)) === false ? null : d; },
      readCharacter: async () => rowChar,
      buildSlides: async () => clientImages.brandCutList([clientImages.markCutCell('data:image/jpeg;base64,Z')]),
    };
    await trialSheets.persistPreparedSheets({ userId: 'u', characterId: 'c', exported: { Child: { standard: 'std' } } }, deps);
    expect(Object.keys(rowChar.preGeneratedStyledAvatars)).toEqual(['Mia']);
  });
});
