import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const pb = require('../../server/lib/promptBuilders.js');
const { loadPromptTemplates, PROMPT_TEMPLATES } = require('../../server/services/prompts.js');

/**
 * The band-view MECHANISM tests (tasks/band-view-audit-2026-09-15.md §4).
 *
 * Every existing band test pins rules BY NAME, which is why each of the three
 * misses (fdc85a290 agency, 862432a85 resolution, the premise-defining sentence)
 * needed a paid idea run to find: a test that asserts "the narrow view contains
 * <rule>" cannot fail for a rule nobody thought to list.
 *
 * T2 and T3 below need no such list. T2 catches "a rule survived but the span
 * that introduced its subject did not" — four of the five bands shipped the
 * make-believe arm that way. T3 catches the silence itself: prose that nobody
 * ever decided a reader for.
 */

const BANDS: Array<[string, string]> = [
  ['routine', 'ageBandRoutine'],
  ['quest', 'ageBandQuest'],
  ['tries', 'ageBandTries'],
  ['fear-choice', 'ageBandFearChoice'],
  ['journey', 'ageBandJourney'],
];

const KNOWN_ROLES = ['premise', 'craft', 'mechanics', 'example'];

// Every view, whatever the view map holds — a new view is checked the day it is
// added, without anyone remembering to list it here.
const views = (): string[] => Object.keys(pb.BAND_VIEW_KEEPS);

const render = (key: string, view: string) =>
  pb.applyBandView(String(PROMPT_TEMPLATES[key] || ''), view);

beforeAll(async () => { await loadPromptTemplates(); });

/**
 * T2 — no dangling antecedent.
 *
 * Each band declares the definite noun phrases it uses and the span that
 * introduces each one. Subtraction can remove a span; it cannot remove the
 * references to it. If a render contains the phrase it must contain the
 * introduction, in EVERY view.
 */
const INTRODUCES: Record<string, Record<string, string>> = {
  routine: {},
  quest: {
    'the wanted thing': 'One tiny goal',
  },
  tries: {
    'the third try': 'Three tries, no more',
    'the first two': 'Three tries, no more',
    'the problem': 'a single concrete problem',
  },
  'fear-choice': {
    'the fear': 'one thing the main character is afraid',
    'the fear and the choice': 'one thing the main character is afraid',
  },
  journey: {
    'the turn': 'then the turn',
  },
};

describe('T2 — no band view ships a dangling antecedent', () => {
  for (const [band, key] of BANDS) {
    it(`${band}: every definite phrase keeps the span that introduced it`, () => {
      for (const view of views()) {
        const text = render(key, view);
        const lower = text.toLowerCase();
        for (const [phrase, intro] of Object.entries(INTRODUCES[band])) {
          if (!lower.includes(phrase.toLowerCase())) continue;
          expect(lower, `${band} / ${view}: "${phrase}" has no antecedent — "${intro}" was dropped`)
            .toContain(intro.toLowerCase());
        }
      }
    });
  }
});

/**
 * T3 — totality. Zero untagged bytes, only known role tags, and the writer view
 * loses nothing (the last of the three exists today and must survive).
 */
describe('T3 — the band files are totally tagged', () => {
  const tagRe = /\[\[(\/)?([a-z-]+)(?::([a-z-]+))?\]\]/g;

  for (const [band, key] of BANDS) {
    it(`${band}: every tag names a known role`, () => {
      const file = String(PROMPT_TEMPLATES[key] || '');
      expect(file, band).toBeTruthy();
      const seen = new Set<string>();
      for (const m of file.matchAll(tagRe)) seen.add(m[2]);
      for (const role of seen) {
        expect(KNOWN_ROLES, `${band}: unknown tag [[${role}]]`).toContain(role);
      }
    });

    it(`${band}: no prose sits outside a tagged span`, () => {
      const file = String(PROMPT_TEMPLATES[key] || '');
      // strip every tagged span; whatever prose is left was never assigned a reader
      let stripped = file;
      for (const role of KNOWN_ROLES) {
        stripped = stripped.replace(
          new RegExp(`\\[\\[${role}(?::[a-z-]+)?\\]\\][\\s\\S]*?\\[\\[\\/${role}(?::[a-z-]+)?\\]\\]`, 'g'),
          '',
        );
      }
      expect(stripped.trim(), `${band}: untagged prose — "${stripped.trim().slice(0, 80)}"`).toBe('');
    });

    it(`${band}: the writer view is the whole file, tags removed`, () => {
      const file = String(PROMPT_TEMPLATES[key] || '');
      expect(render(key, 'writer')).toBe(file.replace(tagRe, ''));
    });
  }

  it('applyBandView refuses untagged prose rather than shipping it silently', () => {
    expect(() => pb.applyBandView('a rule nobody tagged', 'writer')).toThrow(/[Uu]ntagged/);
  });
});
