/**
 * The IDEA path reads an idea-shaped guide; the STORY path still reads the guide whole.
 *
 * Round 10's blind buy-axis read split by category (blind-scores-r10.md): adventure
 * 4.25, historical 3.75, life-challenge 3.63. Both weak arms were handed the STORY
 * writer's input — a book brief ("What the book is / What happens / Ending") or a
 * fact sheet — and wrote it back as a synopsis. These pins hold the three cuts that
 * answer it. They pin BEHAVIOUR (which part reaches which path), never prompt wording.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const { getIdeaGuide, getTeachingGuide } = require(path.join(ROOT, 'server/lib/promptBuilders'));

const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const TEMPLATES = [
  'prompts/generate-story-idea-single.txt',
  'prompts/generate-story-ideas.txt',
];

describe('getIdeaGuide — life-challenge', () => {
  // The three topics the rating cells use, plus going-outside, which is the shape
  // they were written to and deliberately carries no block of its own.
  for (const topic of ['making-friends', 'managing-emotions', 'not-giving-up']) {
    it(`${topic} yields only the [[idea]] block`, () => {
      const idea = getIdeaGuide('life-challenge', topic);
      expect(idea).toBeTruthy();
      // The three idea-shaped headings are there…
      expect(idea).toContain('**What the child wants.**');
      expect(idea).toContain('**What answers back.**');
      expect(idea).toContain('**The child moves.**');
      // …and the book-brief headings are not.
      expect(idea).not.toContain('**What the book is.**');
      expect(idea).not.toContain('**What happens.**');
      expect(idea).not.toContain('**Ending.**');
      expect(idea).not.toMatch(/\[\[\/?idea\]\]/);
    });

    it(`${topic}: the STORY path still gets the whole guide, tags stripped`, () => {
      const whole = getTeachingGuide('life-challenge', topic);
      expect(whole).toContain('**What the book is.**');
      expect(whole).toContain('**What answers back.**');
      expect(whole).toContain('**Ending.**');
      expect(whole).not.toMatch(/\[\[\/?idea\]\]/);
    });
  }

  it('a guide with no [[idea]] block falls back to the whole guide', () => {
    expect(getIdeaGuide('life-challenge', 'going-outside'))
      .toBe(getTeachingGuide('life-challenge', 'going-outside'));
  });

  it('an unknown topic is null, not a throw', () => {
    expect(getIdeaGuide('life-challenge', 'no-such-topic')).toBeNull();
  });
});

describe('getIdeaGuide — historical', () => {
  for (const topic of ['moon-landing', 'wright-brothers']) {
    it(`${topic} keeps the seeds and drops the story-prompt sections`, () => {
      const idea = getIdeaGuide('historical', topic);
      expect(idea).toMatch(/^EVENT: /);
      expect(idea).toContain('KEY FIGURES:');
      expect(idea).toContain('STORY ANGLES:');
      expect(idea).toContain("The idea is one child's day inside this event");
      for (const dropped of ['PERIOD COSTUMES', 'HISTORICAL DETAILS', 'LOCATION_REFERENCES', 'THEMES:']) {
        expect(idea).not.toContain(dropped);
      }
      // One sentence of context, not the whole essay.
      expect(idea!.split('\n\n')[1].split('. ').length).toBe(1);
      // The STORY path is untouched: it still gets every section.
      const sheet = getTeachingGuide('historical', topic);
      expect(sheet).toContain('PERIOD COSTUMES:');
      expect(sheet).toContain('HISTORICAL CONTEXT:');
    });
  }
});

describe('the idea templates carry none of the story writer\'s inputs', () => {
  for (const f of TEMPLATES) {
    it(`${path.basename(f)} has no complexity guide and no challenge catalogue`, () => {
      const t = read(f);
      expect(t).not.toContain('{SCENE_COMPLEXITY_GUIDE}');
      expect(t).not.toContain('{CHALLENGE_CATALOGUE}');
      expect(t).not.toContain('SCENE COMPLEXITY');
      expect(t).not.toMatch(/Complexity(:| matches| \*\*)/);
    });
  }

  it('the single template drops the "locations and time periods" rule', () => {
    expect(read(TEMPLATES[0])).not.toContain('Be specific about locations and time periods');
  });

  it('the review checks are numbered 1..14 with no gap (single)', () => {
    const nums = [...read(TEMPLATES[0]).matchAll(/^(\d+)\. \*\*/gm)].map(m => Number(m[1]));
    expect(nums).toEqual(Array.from({ length: 14 }, (_, i) => i + 1));
  });

  it('the CUT line points at the surviving back-cover check', () => {
    const t = read(TEMPLATES[0]);
    const n = Number((t.match(/^(\d+)\. \*\*Back cover, not synopsis\*\*/m) || [])[1]);
    expect(t).toContain(`cut by check ${n}`);
  });
});

describe('the life-skill obstacle claim is one wording on every idea path', () => {
  const CLAIM = 'a person, a creature or a thing that answers back';
  for (const f of ['server/routes/storyIdeas.js', 'server/routes/trial.js', 'server/lib/testlab.js']) {
    it(`${path.basename(f)} states it`, () => {
      expect(read(f)).toContain(CLAIM);
      expect(read(f)).not.toContain('this skill being hard');
    });
  }
});
