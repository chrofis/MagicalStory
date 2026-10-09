import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const check = require('../../server/lib/trialIdeaCheck');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pb = require('../../server/lib/promptBuilders');

const ROOT = path.resolve(__dirname, '../..');
const tpl = fs.readFileSync(path.join(ROOT, 'prompts/trial-idea.txt'), 'utf8');

// WANT / USES / RESULT default to quotes that hold for GOOD_IDEA; a test overrides one to break it.
const card = (idea: string, event: string, act: string, o: { want?: string; uses?: string; result?: string } = {}) =>
  `${idea}\nCHECK\nWANT: ${o.want ?? 'will zum Brunnen'}\nEVENT: ${event}\nUSES: ${o.uses ?? 'NONE'}\nACT: ${act}\nRESULT: ${o.result ?? 'füllt sie den Krug und trägt ihn heim'}`;

const GOOD_IDEA =
  'Mia will zum Brunnen, doch ein umgestürzter Marktstand versperrt den Weg. ' +
  'Sie wartet, bis die Händlerin die Kisten weggeräumt hat. ' +
  'Danach füllt sie den Krug und trägt ihn heim.';

describe('trial idea self-check — the rule is ONE constant, given to the writer and to the check', () => {
  it('the commissioned-act phrase is the same string in the rule and in the self-check', () => {
    expect(check.TRIAL_IDEA_COMMISSION_RULE).toContain(check.COMMISSIONED_ACT_PHRASE);
    expect(check.TRIAL_IDEA_SELF_CHECK_RULE).toContain(check.COMMISSIONED_ACT_PHRASE);
  });

  it('both built arms carry the rule and the self-check, and no hand-copied second wording', () => {
    const { local, fantasy } = pb.buildTrialIdeaPrompts({
      template: tpl,
      characters: [{ name: 'Mia', age: 5, gender: 'female' }],
      charDesc: 'Mia, 5 years old, female',
      categoryContext: 'This is a life skills story about "waiting-turn".',
      langInstruction: 'German.',
    });
    for (const p of [local, fantasy]) {
      expect(p).toContain(check.TRIAL_IDEA_COMMISSION_RULE);
      expect(p).toContain(check.TRIAL_IDEA_SELF_CHECK_RULE);
      // The self-check is the last thing the model reads.
      expect(p.trimEnd().endsWith(check.TRIAL_IDEA_SELF_CHECK_RULE.trimEnd())).toBe(true);
      // The phrase exists exactly three times: the obstacle rule, the shared coherence rule (ideaCoherence.js), the check.
      expect(p.split(check.COMMISSIONED_ACT_PHRASE).length - 1).toBe(3);
    }
  });
});

describe('parseIdeaSelfCheck — a verdict is never taken on trust, only the quotes are checked', () => {
  it('passes a card that quotes a slot-1 event and a slot-2 act', () => {
    const r = check.parseIdeaSelfCheck(card(GOOD_IDEA, 'ein umgestürzter Marktstand versperrt den Weg', 'Sie wartet, bis die Händlerin die Kisten weggeräumt hat'));
    expect(r.ok).toBe(true);
    expect(r.failure).toBeNull();
    expect(r.idea).toBe(GOOD_IDEA);
  });

  it('tolerates case, quote marks and trailing punctuation in the copied span', () => {
    const r = check.parseIdeaSelfCheck(card(GOOD_IDEA, '«Ein umgestürzter Marktstand versperrt den Weg.»', 'sie wartet, bis die Händlerin die Kisten weggeräumt hat.'));
    expect(r.ok).toBe(true);
  });

  it('fails a card that has no act to quote (NONE)', () => {
    const r = check.parseIdeaSelfCheck(card(GOOD_IDEA, 'ein umgestürzter Marktstand versperrt den Weg', 'NONE'));
    expect(r).toMatchObject({ ok: false, failure: 'no-act' });
  });

  it('fails a card whose act span is not in its own words', () => {
    const r = check.parseIdeaSelfCheck(card(GOOD_IDEA, 'ein umgestürzter Marktstand versperrt den Weg', 'sie wartet geduldig am Brunnenrand'));
    expect(r).toMatchObject({ ok: false, failure: 'act-not-quoted' });
  });

  it('fails a card whose act span sits in slot 3 instead of slot 2', () => {
    const r = check.parseIdeaSelfCheck(card(GOOD_IDEA, 'ein umgestürzter Marktstand versperrt den Weg', 'füllt sie den Krug und trägt ihn heim'));
    expect(r).toMatchObject({ ok: false, failure: 'act-not-in-slot-2' });
  });

  it('fails a card whose event span sits outside slot 1', () => {
    const r = check.parseIdeaSelfCheck(card(GOOD_IDEA, 'die Händlerin die Kisten weggeräumt hat', 'Sie wartet, bis die Händlerin die Kisten weggeräumt hat'));
    expect(r).toMatchObject({ ok: false, failure: 'event-not-in-slot-1' });
  });

  it('THROWS on a missing or malformed check block — never silently passes it', () => {
    expect(() => check.parseIdeaSelfCheck(GOOD_IDEA)).toThrow(/no CHECK block/);
    expect(() => check.parseIdeaSelfCheck(`${GOOD_IDEA}\nCHECK\nEVENT: ein umgestürzter Marktstand versperrt den Weg`)).toThrow(/missing a WANT, EVENT, USES, ACT or RESULT/);
    expect(() => check.parseIdeaSelfCheck('CHECK\nWANT: w\nEVENT: a\nUSES: u\nACT: b\nRESULT: r')).toThrow(/no idea/);
  });

  // The chain lines (2026-10-09): four of five picked staging cards broke the
  // chain where the act quote could not see it.
  const EV = 'ein umgestürzter Marktstand versperrt den Weg';
  const AC = 'Sie wartet, bis die Händlerin die Kisten weggeräumt hat';
  it('fails a want that is not a slot-1 span', () => {
    expect(check.parseIdeaSelfCheck(card(GOOD_IDEA, EV, AC, { want: 'trägt ihn heim' })))
      .toMatchObject({ ok: false, failure: 'want-not-in-slot-1' });
  });
  it('fails a thing sentence 2 works with that turned up from nowhere (not named in slot 1)', () => {
    const idea = 'Mia will zum Brunnen, doch ein Marktstand versperrt den Weg. Sie findet eine Kiste und stapelt die Äpfel um. Danach füllt sie den Krug und trägt ihn heim.';
    expect(check.parseIdeaSelfCheck(card(idea, 'ein Marktstand versperrt den Weg', 'stapelt die Äpfel um', { uses: 'eine Kiste' })))
      .toMatchObject({ ok: false, failure: 'uses-not-in-slot-1' });
  });
  it('passes USES when it is a slot-1 span, and when it is NONE', () => {
    expect(check.parseIdeaSelfCheck(card(GOOD_IDEA, EV, AC, { uses: 'Marktstand' })).ok).toBe(true);
    expect(check.parseIdeaSelfCheck(card(GOOD_IDEA, EV, AC)).ok).toBe(true);
  });
  it('fails a slot 3 that settles no want, or a result outside slot 3', () => {
    expect(check.parseIdeaSelfCheck(card(GOOD_IDEA, EV, AC, { result: 'NONE' }))).toMatchObject({ ok: false, failure: 'no-result' });
    expect(check.parseIdeaSelfCheck(card(GOOD_IDEA, EV, AC, { result: 'Sie wartet' }))).toMatchObject({ ok: false, failure: 'result-not-in-slot-3' });
  });
});

describe('stripIdeaSelfCheck — the visitor never sees the block', () => {
  it('removes a complete block', () => {
    expect(check.stripIdeaSelfCheck(card(GOOD_IDEA, 'x', 'y'))).toBe(GOOD_IDEA);
  });
  it('removes a half-streamed marker so no fragment flashes in the UI', () => {
    for (const partial of ['\nC', '\nCH', '\nCHE', '\nCHEC', '\nCHECK']) {
      expect(check.stripIdeaSelfCheck(GOOD_IDEA + partial)).toBe(GOOD_IDEA);
    }
  });
  it('leaves a clean idea untouched', () => {
    expect(check.stripIdeaSelfCheck(GOOD_IDEA)).toBe(GOOD_IDEA);
  });
});

describe('the rerun carries the card back with its own stated reason', () => {
  it('names the failure and the rejected idea, and asks for the block again', () => {
    const p = check.buildIdeaRerunPrompt('BASE PROMPT', { idea: GOOD_IDEA, failure: 'no-act' });
    expect(p.startsWith('BASE PROMPT')).toBe(true);
    expect(p).toContain(check.FAILURE_FEEDBACK['no-act']);
    expect(p).toContain(GOOD_IDEA);
    expect(p).toContain(check.COMMISSIONED_ACT_PHRASE);
    expect(p).toContain('CHECK');
  });
  it('has feedback wording for every failure code the parser can return', () => {
    for (const code of ['no-act', 'act-not-quoted', 'act-not-in-slot-2', 'no-event', 'event-not-quoted', 'event-not-in-slot-1', 'no-want', 'want-not-quoted', 'want-not-in-slot-1', 'uses-not-quoted', 'uses-not-in-slot-1', 'no-result', 'result-not-quoted', 'result-not-in-slot-3']) {
      expect(check.FAILURE_FEEDBACK[code]).toBeTruthy();
    }
  });
});

describe('the /try route reruns a failing card exactly once, and a passing card never', () => {
  const routeSrc = fs.readFileSync(path.join(ROOT, 'server/routes/trial.js'), 'utf8');

  it('the rerun is inside the !parsed.ok branch and is not itself retried', () => {
    const body = routeSrc.slice(routeSrc.indexOf('const runIdeaCard ='), routeSrc.indexOf('const streamStory1 = runIdeaCard'));
    expect(body).toContain('if (!parsed.ok)');
    // ONE call to buildIdeaRerunPrompt, and no loop around it.
    expect(body.split('buildIdeaRerunPrompt(').length - 1).toBe(1);
    expect(body).not.toMatch(/\b(while|for)\s*\(/);
    // The second parse assigns the final answer and is never re-checked.
    expect(body).toContain('parsed = reparsed;');
  });

  it('there is no second judge call on the happy path — one model call per card unless it fails', () => {
    const body = routeSrc.slice(routeSrc.indexOf('const runIdeaCard ='), routeSrc.indexOf('const streamStory1 = runIdeaCard'));
    const calls = body.split('callTextModelStreaming(').length - 1;
    expect(calls).toBe(2); // the draw, and the rerun inside the failure branch
    expect(body.indexOf('callTextModelStreaming(buildIdeaRerunPrompt')).toBeGreaterThan(body.indexOf('if (!parsed.ok)'));
  });

  it('streamed fragments are stripped, so the block never reaches the client', () => {
    expect(routeSrc).toContain('stripIdeaSelfCheck(fullText)');
  });
});

describe('the Lab idea stage reads the same contract (sibling: trial-idea-prompt-mirror)', () => {
  const labSrc = fs.readFileSync(path.join(ROOT, 'server/lib/testlab.js'), 'utf8');
  it('strips and records the check instead of feeding it to premise grouping', () => {
    expect(labSrc).toContain("require('./trialIdeaCheck')");
    expect(labSrc).toContain('selfCheck: { local: localCard.selfCheck, fantasy: fantasyCard.selfCheck }');
  });
});

describe('idea obstacle kind is a rotated, shape-classed axis (2026-10-09)', () => {
  it('the two arms of one cell never share a kind, and wind is never offered as one', () => {
    for (let i = 0; i < 60; i++) {
      const { local, fantasy } = pb.nextIdeaAxisPair();
      expect(local.obstacleKind).not.toBe(fantasy.obstacleKind);
      expect(local.text).toMatch(/never wind or weather/);
    }
    for (const e of pb.IDEA_OBSTACLE_AXES) expect(e.obstacle).not.toMatch(/wind|gust|storm|weather|rain/i);
  });
  it('every kind reaches the local arm over a cycle (no entry starved)', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 40; i++) seen.add(pb.nextIdeaAxisPair().local.obstacle);
    expect(seen.size).toBe(pb.IDEA_OBSTACLE_AXES.length);
  });
  it('the template pins the chain and one-language rules, generically', () => {
    expect(tpl).toContain('What sentence 2 works with or on is named in sentence 1');
    expect(tpl).toContain('Sentence 3 settles exactly the want from sentence 1');
    expect(tpl).toContain('none is borrowed from another');
  });
});
