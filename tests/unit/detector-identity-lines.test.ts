/**
 * The detector's identity call gets the character's PLACEMENT, not just a look.
 *
 * THE DEFECT (staging job_1789681157795_wkt20ckod p12, 2026-09-18). The page
 * shipped with finalScore 0 on two CRITICAL findings, both attributed through a
 * name swap: `renameMap {kiaan: "Julian", julian: "Kiaan"}`, agreementRate 0.5.
 *
 * The render had drawn the toddler in the other boy's coat AND the other boy's
 * hair colour. Appearance therefore could not separate the two figures — the
 * Set-of-Mark identity call named the figure wearing the brick-red duffle coat
 * after the character whose contract names that coat, which is the only reading
 * the evidence it was given supports. The one cue that DID separate them was the
 * scene plan's placement (three children pressed against the stone in the
 * foreground; one standing behind them in the midground, head lowered) — and
 * that cue never reached the call, because the iterate-path builder that
 * assembled `expectedCharacters` omitted the `position` field.
 *
 * Measured on this exact image and these exact badges, gemini-2.5-flash,
 * temperature 0, 3 runs per cell:
 *
 *     position hint absent   →  0/3 correct   (names the duffle wearer "Kiaan")
 *     position hint present  →  3/3 correct
 *
 * with and without hair in the identity line, and under both prompt wordings.
 * The placement field is the deciding variable, so the fix is to supply it.
 *
 * Four builders assemble these entries and only the generation-time one carried
 * `clothing` and `position` (given them 2026-08-22, never mirrored). The
 * registry set `detector-identity-lines` now holds all four; `sibling-parity`
 * enforces the field anchors across them. This file pins the BEHAVIOUR on the
 * real stored shapes: given p12's cast and its declared placements, the builder
 * emits an entry that can tell the two contested children apart.
 *
 * Every value below is the stored production shape — nothing is hand-built.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require_ = createRequire(import.meta.url);
const { buildPageCast } = require_('../../server/lib/charRepairTarget.js');
const { checkIdentityAgreement } = require_('../../server/lib/identityAgreement.js');

const fx = require_('./fixtures/detector-identity-lines-job_1789681157795_wkt20ckod-p12.json');

const CONTESTED = ['Kiaan', 'Julian'];

const buildCast = () =>
  buildPageCast({
    storyData: {
      characters: fx.sceneCharacters,
      clothingRequirements: fx.clothingRequirements,
      artStyle: fx.artStyle,
    },
    sceneCharacters: fx.sceneCharacters,
    sceneMetadata: { characterPositions: fx.characterPositions },
    clothingByName: fx.sceneCharacterClothing,
    artStyle: fx.artStyle,
    label: 'P12 ',
    visualBible: null,
  });

describe('the stored evidence this defect was measured on', () => {
  it('the two witnesses disagreed about exactly the two contested children', () => {
    const report = checkIdentityAgreement(fx.evalMatches, fx.detFigures);
    expect(report).not.toBeNull();
    expect(report.agreementRate).toBe(0.5);
    expect([...report.contestedCharacters].sort()).toEqual([...CONTESTED].sort());
  });

  it('the entries the detector was actually given carried no placement at all', () => {
    // The regression this file exists to prevent: an identity line with a
    // wardrobe and a face but nothing about where the character stands.
    const withPosition = fx.storedExpectedCharacters.filter((c: any) => c.position);
    expect(withPosition, 'stored iterate-path entries had no position field').toEqual([]);
  });

  it('the scene plan DID declare a distinct placement for each contested child', () => {
    // The cue existed the whole time — it simply was not passed. If this ever
    // fails, the defect moved upstream into the brief and the fix below cannot
    // help.
    for (const name of CONTESTED) {
      expect(fx.characterPositions[name], `${name} has a declared placement`).toBeTruthy();
    }
    expect(fx.characterPositions.Kiaan).not.toBe(fx.characterPositions.Julian);
  });
});

describe('buildPageCast supplies what the identity call needs', () => {
  it('every entry carries its declared placement', () => {
    const cast = buildCast();
    const byName = Object.fromEntries(cast.map((c: any) => [c.name, c]));
    for (const [name, position] of Object.entries(fx.characterPositions)) {
      expect(byName[name], `${name} is in the cast`).toBeTruthy();
      expect(byName[name].position, `${name} carries its placement`).toBe(position);
    }
  });

  it('the two contested children are separable by placement alone', () => {
    // Not "both have a position" — they must have DIFFERENT ones, or the field
    // is present and still cannot break the tie that appearance could not.
    const byName = Object.fromEntries(buildCast().map((c: any) => [c.name, c]));
    const [a, b] = CONTESTED;
    expect(byName[a].position).toBeTruthy();
    expect(byName[b].position).toBeTruthy();
    expect(byName[a].position).not.toBe(byName[b].position);
  });

  it('every entry carries its wardrobe as its own field, not only inside the prose', () => {
    // The sanitized SoM tier strips the "Wearing:" tail out of `description` and
    // rebuilds it from `clothing`; without the field that tier dresses nobody.
    for (const entry of buildCast()) {
      expect(typeof entry.clothing, `${entry.name}.clothing is a string`).toBe('string');
      expect(entry.clothing.length, `${entry.name} is not sent out undressed`).toBeGreaterThan(0);
    }
  });

  it('a character with no declared placement gets null, never an invented one', () => {
    const cast = buildPageCast({
      storyData: {
        characters: fx.sceneCharacters,
        clothingRequirements: fx.clothingRequirements,
        artStyle: fx.artStyle,
      },
      sceneCharacters: fx.sceneCharacters,
      sceneMetadata: {},               // a scene whose plan declared no placements
      clothingByName: fx.sceneCharacterClothing,
      artStyle: fx.artStyle,
      label: 'P12 ',
      visualBible: null,
    });
    for (const entry of cast) expect(entry.position).toBeNull();
  });
});
