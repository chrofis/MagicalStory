/**
 * The trial's declared age is MANDATORY.
 *
 * Owner ruling, 2026-09-15: "The age must be made mandatory in the trial run,
 * otherwise this will not work."
 *
 * Why: de8753cc1 made the USER-ENTERED age the single source for both halves of
 * the avatar loop — the generator builds the body for the declared age
 * (`ageLine`) and the judge scores against that same declaration (`ageFact`),
 * via resolveDeclaredAvatarOverrides. A trial character with no age emits
 * neither, and the 2×4 sheet's declaredAgeBlock() emits nothing at all — the
 * sheet silently falls back to the generic phantom tier and to the
 * pre-de8753cc1 behaviour the ruling removed.
 *
 * Pinned here: the parser's range, the server rejecting a missing/invalid age
 * BEFORE an account row is created, the client refusing to advance, and — the
 * part most likely to break quietly — the age the trial WRITES reaching the
 * real avatar consumers (declaredAgeBlock, resolveDeclaredAvatarOverrides).
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const fs = require('fs');
const path = require('path');
const { parseTrialAge, TRIAL_MIN_AGE, TRIAL_MAX_AGE } = require('../../server/lib/trialAge.js');
const { resolveDeclaredAvatarOverrides } = require('../../server/lib/avatarOverrides.js');
const { declaredAgeBlock } = require('../../server/lib/character2x4Sheet.js');

const src = (p: string) => fs.readFileSync(path.join(__dirname, '../..', p), 'utf8');
const TRIAL_ROUTE = src('server/routes/trial.js');
const TRIAL_STEP = src('client/src/pages/trial/TrialCharacterStep.tsx');

describe('parseTrialAge — the one server-side range', () => {
  it('rejects a missing, empty or non-numeric age', () => {
    for (const bad of [undefined, null, '', '   ', 'seven', '7 Jahre', '7.5', '-3', NaN]) {
      expect(parseTrialAge(bad as unknown).ok, `${String(bad)} must be refused`).toBe(false);
    }
    expect(parseTrialAge(undefined).error).toBe('Age is required');
    expect(parseTrialAge('seven').error).toBe('Invalid age');
  });

  it('accepts whole years inside the trial range and refuses the edges outside it', () => {
    expect(parseTrialAge('1')).toEqual({ ok: true, years: 1 });
    expect(parseTrialAge(7)).toEqual({ ok: true, years: 7 });
    expect(parseTrialAge('18')).toEqual({ ok: true, years: 18 });
    // 0 is legal in the band machinery (youngestMainAge filters n >= 0) but the
    // trial has never offered a newborn hero — deliberate, see trialAge.js.
    expect(parseTrialAge('0').ok).toBe(false);
    expect(parseTrialAge(String(TRIAL_MAX_AGE + 1)).ok).toBe(false);
    expect([TRIAL_MIN_AGE, TRIAL_MAX_AGE]).toEqual([1, 18]);
  });
});

describe('the server refuses a trial character with no age', () => {
  it('create-anonymous-account validates through parseTrialAge before writing the row', () => {
    expect(TRIAL_ROUTE).toMatch(/const parsedAge = parseTrialAge\(age\);/);
    expect(TRIAL_ROUTE).toMatch(/if \(!parsedAge\.ok\) \{\s*\n\s*return res\.status\(400\)\.json\(\{ error: parsedAge\.error \}\);/);
    // The row stores the NORMALISED age — never the raw string, and never the
    // old `age || ''` that let an empty one through.
    expect(TRIAL_ROUTE).toMatch(/age: String\(parsedAge\.years\),/);
    // The only surviving valid-if-present guard is generate-preview-avatar's:
    // that endpoint fires while the user is still on the photo phase, before
    // any age has been typed, so it cannot require one.
    const optionalGuards = TRIAL_ROUTE.match(/if \(age && \(isNaN\(parseInt\(age\)\)/g) || [];
    expect(optionalGuards.length, 'only the pre-age preview-avatar endpoint may stay optional').toBe(1);
  });

  it('update-character-details refuses an invalid age and never clears a stored one', () => {
    expect(TRIAL_ROUTE).toMatch(/if \(age !== undefined\) \{[\s\S]{0,200}parseTrialAge\(age\)/);
    expect(TRIAL_ROUTE).toMatch(/if \(patchedAge !== null\) \{\s*c\.age = patchedAge;/);
  });
});

describe('the client cannot submit without an age', () => {
  it('canProceed requires a valid age, on the same 1-18 range as the server', () => {
    expect(TRIAL_STEP).toContain('const ageIsValid = /^' + String.fromCharCode(92) + 'd{1,3}$/.test(ageRaw) && Number(ageRaw) >= 1 && Number(ageRaw) <= 18;');
    expect(TRIAL_STEP).toMatch(/const canProceed = characterData\.name\.trim\(\) && characterData\.gender && ageIsValid && hasPhoto;/);
  });

  it('the inline message is translated on every trial language, not hardcoded English', () => {
    const keys = TRIAL_STEP.match(/^\s*ageRequired: '/gm) || [];
    expect(keys.length, 'en + de + fr + it').toBe(4);
    expect(TRIAL_STEP).toMatch(/ageRequired: string;/);
    expect(TRIAL_STEP).toMatch(/\{t\.ageRequired\}/);
  });

  it('a restored (in-flight) trial session still syncs its details, so a newly entered age reaches the row', () => {
    expect(TRIAL_STEP).toMatch(/if \(sessionToken\) \{\s*\n\s*await syncDetails\(sessionToken\);/);
    // A null snapshot (the remounted restored session) means "always sync".
    expect(TRIAL_STEP).toMatch(/if \(sentSnapshotRef\.current && !detailsDiffer\(currentSnapshot, sentSnapshotRef\.current\)\) return;/);
  });
});

describe('the declared age reaches the avatar call on the TRIAL path', () => {
  // The exact value the trial route writes onto characters.data for a user who
  // typed "7": String(parseTrialAge('7').years).
  const storedAge = (() => {
    const p = parseTrialAge('7');
    expect(p.ok).toBe(true);
    return String((p as { years: number }).years);
  })();

  it('prepare-title hands the stored age to the styled-avatar pipeline', () => {
    // trial.js builds the character object prepareStyledAvatars consumes.
    expect(TRIAL_ROUTE).toMatch(/const character = \{[\s\S]{0,120}age: mainChar\.age,/);
  });

  it('the 2×4 sheet prompt states the stored age — and states nothing when it is missing', () => {
    const block = declaredAgeBlock({ age: storedAge });
    expect(block).toMatch(/This person is 7 years old/);
    expect(block).toMatch(/outranks any impression of age taken from the photo/);
    expect(declaredAgeBlock({ age: '' }), 'no age ⇒ the sheet is anchored on nothing').toBe('');
    expect(declaredAgeBlock({}), 'no age ⇒ the sheet is anchored on nothing').toBe('');
  });

  it('the generator line and the judge fact both carry the stored age', () => {
    const r = resolveDeclaredAvatarOverrides({ declaredAge: storedAge });
    expect(r.declaredAge).toBe(7);
    expect(r.ageLine).toMatch(/7 years old/);
    expect(r.ageFact).toBe('7 years old');
    // The shape a missing trial age would have produced — the silent fallback.
    const none = resolveDeclaredAvatarOverrides({ declaredAge: '' });
    expect(none.ageLine).toBeNull();
    expect(none.ageFact).toBeNull();
  });
});
