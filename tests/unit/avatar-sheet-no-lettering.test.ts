/**
 * Avatar 2×4 sheets carry no lettering, and every sheet judge that checks marks
 * fails a sheet that does.
 *
 * Staging job_1791040103540_atbttop6w: Max's body row printed the cell names
 * the prompt used ("FRONT / THREE-QUARTER / PROFILE / REAR TURN") above and
 * below every figure, pass 2 kept them, and every check passed (clean 9): the
 * heads judge looked for letters only ON a head, the bodies judge had no text
 * check, and the style judge looked only "on the character".
 *
 * One rule (SHEET_NO_LETTERING_RULE) goes to all three generators and is
 * filled into the three judges ({SHEET_LETTERING}). Behaviour is pinned: the
 * built prompts and what a lettered verdict does to the gate.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';

const { loadPromptTemplates } = require('../../server/services/prompts');
const sheetMod = require('../../server/lib/character2x4Sheet');
const sheet = { ...sheetMod, ...sheetMod._internal };

const ROW = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/9oACAEBAAA/AKpgA//Z';
const RULE = sheet.SHEET_NO_LETTERING_RULE;

describe('generator: the sheet prompt states the no-lettering rule', () => {
  const c = { name: 'A', age: 5, physical: {} };

  it('standard and costume sheets state it, and say the cell names are not drawn', () => {
    for (const kind of ['standard', 'costume']) {
      const p = sheet.buildOneCallSheetPrompt(c, { costumeDescription: 'a red long-sleeve shirt', styleLine: 'watercolour', kind });
      expect(p).toContain(RULE);
      expect(p).toContain(sheet.CELL_NAMES_NOT_DRAWN);
    }
  });
});

