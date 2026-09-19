import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const P = (f: string) => fs.readFileSync(path.join(__dirname, '../../prompts', f), 'utf8');

/**
 * The three-stage compliance judge is TEXT-ONLY by construction — its own first
 * line is "You have NOT seen the image". A finding-by-finding audit of 8 pages
 * of job_1789759147125_p08djwhbl ruled every finding against the shipped pixels:
 * 46 findings / 528 points, of which 60 points (11.4%) were defensible. This one
 * judge produced 25 of the findings and 337 of the points, and 16 of its 24
 * scored findings were FALSE — against ONE false finding out of eleven from the
 * two judges that look at pixels.
 *
 * The false ones clustered entirely in rulings about what is happening in the
 * frame: action_interaction (120 pts, 0/6 priced right), object_presence (40 pts,
 * 3/3 false), the absence family (50 pts, 0/4), clothing_inconsistent (30 pts,
 * 0/3). So the judge was NARROWED, not distrusted: it keeps the countable
 * contract checks a written inventory settles and stops ruling on what is
 * depicted. These tests pin the boundary — never the wording.
 */

const compliance = () => P('image-prompt-compliance.txt');

/** The vocabulary the judge is offered, isolated from the sentence naming what it is not. */
const offeredTypes = () => {
  const section = compliance().split('MUST come from this closed list')[1] || '';
  const body = section.split('ONE type per entry')[0] || '';
  const lines = body.split('\n').map((l) => l.trim()).filter(Boolean);
  // line 0 is the ":" tail of the intro sentence, line 1 is the vocabulary itself
  return lines.find((l) => l.includes('`naturalness`')) || '';
};

describe('compliance judge: the narrowed remit is in the closed type list', () => {
  const DROPPED = [
    'action_interaction',
    'missing_character',
    'missing_element',
    'object_presence',
    'object_count',
    'clothing_inconsistent',
    'implausible_placement',
    'wrong_action',
  ];

  for (const type of DROPPED) {
    it(`does not offer \`${type}\``, () => {
      expect(offeredTypes()).not.toContain(`\`${type}\``);
    });
  }

  // A deleted rule leaves the model free to improvise the same finding under a
  // neighbouring code (measured before on `accessory`). The list has to SAY the
  // types are absent, not merely omit them.
  it('names the dropped types as barred rather than silently omitting them', () => {
    const section = compliance().split('MUST come from this closed list')[1] || '';
    const barred = (section.split('ONE type per entry')[0] || '').replace(offeredTypes(), '');
    for (const type of DROPPED) expect(barred).toContain(`\`${type}\``);
  });

  const KEPT = [
    'character_identity',
    'clothing',
    'garment_colour',
    'clothing_detail',
    'accessory',
    'duplicate_identity',
    'unverified_absence',
    'rendered_text',
    'scale',
    'figure_completeness',
    'setting',
  ];

  for (const type of KEPT) {
    it(`still offers \`${type}\``, () => {
      expect(offeredTypes()).toContain(`\`${type}\``);
    });
  }
});

describe('compliance judge: the checks it KEEPS', () => {
  // Lettering is load-bearing: docs/decisions.md 2026-08-19 records a caption
  // shipping at 100/PASS precisely because neither stage covered it.
  it('still carries a lettering rule that emits `rendered_text`', () => {
    const para = compliance()
      .split('\n\n')
      .find((p) => /\*\*Lettering\.\*\*/.test(p)) || '';
    expect(para).toContain('rendered_text');
  });

  it('still judges the clothing contract, and names the two codes it uses', () => {
    const bullet = compliance()
      .split('\n')
      .find((l) => l.startsWith('- **Clothing type**')) || '';
    expect(bullet).toContain('CLOTHING CONTRACT');
    expect(bullet).toContain('`clothing`');
    expect(bullet).toContain('`garment_colour`');
  });

  it('still judges expected ages against the inventory estimate', () => {
    const t = compliance();
    expect(t).toContain('EXPECTED AGES');
    expect(t).toContain('apparent_age');
  });

  it('still reads the cast roster and the landmark block', () => {
    const t = compliance();
    expect(t).toContain('EXPECTED CAST');
    expect(t).toContain('{LANDMARK_CONTEXT}');
    expect(t).toContain('landmark_element');
  });
});

describe('compliance judge: the steps agree with the instruction', () => {
  // An instruction that says "do not" while the rule list still says "report X"
  // is the worst of both. STEP 3 must price nothing.
  it('STEP 3 emits no severity of any kind', () => {
    const step3 = (compliance().split('**STEP 3:')[1] || '').split('\n---')[0];
    expect(step3).toBeTruthy();
    for (const sev of ['CATASTROPHIC', 'CRITICAL', 'MAJOR', 'MODERATE', 'MINOR']) {
      expect(step3).not.toContain(sev);
    }
  });

  it('the output schema no longer asks for an action verdict or an absence list', () => {
    const t = compliance();
    expect(t).not.toContain('main_action_check');
    expect(t).not.toContain('interaction_compliance');
    expect(t).not.toContain('"all_present"');
    expect(t).not.toContain('"missing": []');
  });

  it('the scope block states the remit positively and then bars the four families', () => {
    const block = (compliance().split('**WHAT THIS JUDGE RULES ON')[1] || '').split('\n---')[0];
    expect(block).toBeTruthy();
    expect(block).toContain('CLOTHING CONTRACT');
    expect(block).toContain('EXPECTED CAST');
    for (const type of ['action_interaction', 'object_presence', 'missing_character', 'clothing_inconsistent']) {
      expect(block).toContain(`\`${type}\``);
    }
  });
});

/**
 * The narrowing is only safe while the judges that SEE the image keep covering
 * what this one stopped covering. If one of these ever fails, the change above
 * has become a blind spot.
 */
describe('the sighted judges still own what the blind judge dropped', () => {
  it('image-semantic still rules on actions, presence and absence', () => {
    const t = P('image-semantic.txt');
    expect(t).toContain('`action_interaction`');
    expect(t).toContain('`missing_character`');
    expect(t).toContain('`missing_element`');
    expect(t).toContain('`object_presence`');
    expect(t).toMatch(/Missing character[^\n]*CRITICAL/);
    expect(t).toMatch(/Missing key object[^\n]*MAJOR/);
  });

  it('image-evaluation still rules on declared interactions, missing elements and objects', () => {
    const t = P('image-evaluation.txt');
    expect(t).toMatch(/\*\*D-16 `action_interaction`/);
    expect(t).toMatch(/\*\*D-18 `action_interaction`/);
    expect(t).toMatch(/\*\*D-19 `missing_element`/);
    expect(t).toMatch(/\*\*D-20 `object_presence`/);
    expect(t).toMatch(/\*\*D-05 `clothing`/);
  });
});
