/**
 * A BAKED COVER TITLE SURVIVES REPAIR (2026-10-05, decisions.md 2026-10-05).
 *
 * Staging job_1791145238223_50osg2osm, front cover. v0 (73) had the title
 * "Emma und der Löwenatem" painted across the top sky. The blind inventory
 * misread it as "Lövenatem", so the undeclared-lettering check charged it as a
 * caption (CRITICAL, fix "Paint over the lettering on sky"), and the repair
 * prompt carried the same title as REQUIRED TEXT. Grok erased the sky title and
 * put it on a cropped wall sign (v1, 55); the semantic judge filed that as
 * `required_text` MAJOR, which cleared v0's CRITICAL, and critical-gone-wins
 * shipped the titleless v1. The data below is copied from the two stored
 * versions.
 *
 * Fixed behaviour pinned here:
 *  1. a `required_text` finding on a cover that paints its title is CRITICAL
 *     whatever the judge tagged (a page's stays as filed);
 *  2. so a version that lost its title cannot win by clearing a caption CRITICAL;
 *  3. the repair clause paints the title back in its required place and never
 *     erases it; the caption fix names the required lettering as left alone.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const RT = require_('../../server/lib/requiredText.js');
const { checkUndeclaredLettering } = require_('../../server/lib/letteringCheck.js');
const { pickBestVersionIndex } = require_('../../server/lib/scoring.js');

const TITLE = 'Emma und der Löwenatem';

// v0's stored lettering inventory (the misread) and declared strings.
const V0_LETTERING = {
  items: [{ text: 'Emma\nund\nder\nLövenatem', surface: 'sky above the scene', position: 'top-center', spelling: 'correct', placement: 'overlay' }],
  declared: [TITLE],
};
// v1's stored consolidated finding for the title on the wall sign.
const V1_REQUIRED_TEXT = {
  type: 'required_text', severity: 'MAJOR', sources: ['semantic'], character: null,
  description: "The required text 'Emma und der Löwenatem' is displayed on a sign in the background instead of as a book title in the top-full position",
};

const coverItems = RT.coverRequiredTexts({ expectedText: TITLE, textMode: 'baked' });

describe('floorCoverTitleSeverity', () => {
  it('raises a MAJOR required_text on a cover that paints its title to CRITICAL', () => {
    const issues = [{ ...V1_REQUIRED_TEXT }];
    expect(RT.floorCoverTitleSeverity(issues, coverItems)).toBe(1);
    expect(issues[0].severity).toBe('CRITICAL');
  });

  it('leaves a page (no cover title item) as filed', () => {
    const issues = [{ ...V1_REQUIRED_TEXT }];
    const pageItems = [{ id: 'ART001', label: 'signpost', text: 'WEST' }];
    expect(RT.floorCoverTitleSeverity(issues, pageItems)).toBe(0);
    expect(issues[0].severity).toBe('MAJOR');
  });

  it('leaves an appOverlay cover (textless art, no title item) as filed', () => {
    const issues = [{ ...V1_REQUIRED_TEXT }];
    expect(RT.floorCoverTitleSeverity(issues, RT.coverRequiredTexts({ expectedText: TITLE, textMode: 'appOverlay' }))).toBe(0);
    expect(issues[0].severity).toBe('MAJOR');
  });

  it('never lowers CATASTROPHIC and ignores other types', () => {
    const issues = [
      { type: 'required_text', severity: 'CATASTROPHIC' },
      { type: 'object_presence', severity: 'MAJOR' },
    ];
    expect(RT.floorCoverTitleSeverity(issues, coverItems)).toBe(0);
    expect(issues.map(i => i.severity)).toEqual(['CATASTROPHIC', 'MAJOR']);
  });
});

describe('a version that lost the title cannot beat the one that has it', () => {
  const v0 = {
    finalScore: 73,
    deductions: { entity: [], quality: [], semantic: [], compliance: [], consolidated: [
      { type: 'rendered_text', severity: 'critical', sources: ['quality'], description: "Caption 'Emma und der Lövenatem' appears in the sky" },
    ] },
    letteringInventory: V0_LETTERING,
  };
  const v1Floored = { ...V1_REQUIRED_TEXT };
  RT.floorCoverTitleSeverity([v1Floored], coverItems);
  const v1 = (sev: string) => ({
    finalScore: 55,
    deductions: { entity: [], quality: [], semantic: [], compliance: [], consolidated: [{ ...V1_REQUIRED_TEXT, severity: sev.toLowerCase() }] },
    letteringInventory: { items: [{ text: TITLE, surface: 'wooden sign attached to wall', position: 'left-midground', spelling: 'correct', placement: 'fits' }], declared: [TITLE] },
  });

  it('with the title finding left MAJOR, the new MAJOR keeps v1 from dominating and the score keeps the titled v0', () => {
    // Before 2026-10-07 (B5) critical-gone-wins shipped the titleless v1 here.
    expect(pickBestVersionIndex([v0, v1('MAJOR')])).toBe(0);
  });

  it('with the title finding CRITICAL, v0 (the version with the title) wins', () => {
    expect(v1Floored.severity).toBe('CRITICAL');
    expect(pickBestVersionIndex([v0, v1(v1Floored.severity)])).toBe(0);
  });
});

describe('the repair puts the title back and never erases it', () => {
  it('the clause for a cover title carries the placement and the never-erase rule, not a prop-sign line', () => {
    const clause = RT.buildRequiredTextRepairClause(coverItems);
    expect(clause).toContain(`Paint "${TITLE}" in the upper third of the canvas`);
    expect(clause).toMatch(/never painted over or removed/);
    expect(clause).toMatch(/missing, misspelled or painted on any other surface/);
    expect(clause).not.toContain('on the **cover**');
  });

  it('a prop sign keeps the page clause; a cover adds its title beside it', () => {
    const sign = { id: 'ART001', label: 'signpost', text: 'WEST' };
    const clause = RT.buildRequiredTextRepairClause([...coverItems, sign]);
    expect(clause).toContain('- on the **signpost**: "WEST"');
    expect(clause).toContain(`Paint "${TITLE}"`);
  });

  it('the misread caption is still a CRITICAL finding, but its fix leaves the declared lettering alone', () => {
    const found = checkUndeclaredLettering({ lettering: V0_LETTERING.items, declared: V0_LETTERING.declared });
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe('CRITICAL');
    expect(found[0].fix).toContain('Paint over the lettering on sky above the scene');
    expect(found[0].fix).toContain('required lettering');
    expect(found[0].fix).toContain('left exactly as it is');
  });

  it('with nothing declared the caption fix is the plain paint-over', () => {
    const found = checkUndeclaredLettering({ lettering: V0_LETTERING.items, declared: [] });
    expect(found[0].fix).not.toContain('required lettering');
  });
});
