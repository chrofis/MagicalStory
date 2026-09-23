/**
 * Pins the topic telemetry added on 2026-09-14.
 *
 * The funnel recorded THAT a topic was chosen and threw away WHICH — meta was
 * NULL on every stored `topic_selected` row — and a /try?category=…&topic=…
 * deep link from an SEO theme page was indistinguishable from a cold arrival
 * (a React-Router <Link> leaves document.referrer untouched). Both signals are
 * what will replace the authored `liveness` weights in storyTypes.ts with
 * measurement, so they are pinned here as behaviour, not wording.
 *
 * The client half is asserted by parsing TrialWizard.tsx as text — importing it
 * would need a DOM, a router and a language context, none of which say anything
 * about what lands in the column.
 */
import fs from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-trial-meta';
const { sanitizeTrialEventMeta } = require('../../server/routes/trial.js');

// Line endings normalised: a Windows checkout with core.autocrlf=true has CRLF
// on disk, and metaFor() anchors on a newline inside the call.
const WIZARD = fs.readFileSync(
  path.join(__dirname, '..', '..', 'client', 'src', 'pages', 'TrialWizard.tsx'),
  'utf8'
).split('\r\n').join('\n');

/** The meta object literal passed to one trackTrialStep call, as source text. */
function metaFor(step: string): string {
  const at = WIZARD.indexOf(`trackTrialStep(\n      '${step}'`);
  const alt = WIZARD.indexOf(`trackTrialStep('${step}'`);
  const start = at >= 0 ? at : alt;
  expect(start, `no trackTrialStep('${step}') call in TrialWizard.tsx`).toBeGreaterThan(-1);
  return WIZARD.slice(start, start + 700);
}

describe('topic_selected carries the chosen topic', () => {
  it('stores the topic id and its category', () => {
    expect(sanitizeTrialEventMeta({ topic: 'brushing-teeth', category: 'life-challenge' }))
      .toEqual({ topic: 'brushing-teeth', category: 'life-challenge' });
  });

  it('stores the adventure branch theme, which has no topic id', () => {
    expect(sanitizeTrialEventMeta({ category: 'adventure', theme: 'pirate' }))
      .toEqual({ category: 'adventure', theme: 'pirate' });
  });

  it('keeps the declared age, which decides which tiles were offered', () => {
    expect(sanitizeTrialEventMeta({ topic: 'homework', age: 7 })).toEqual({ topic: 'homework', age: 7 });
  });

  it('the wizard actually sends topic, category and age on that step', () => {
    const meta = metaFor('topic_selected');
    expect(meta).toContain('topic:');
    expect(meta).toContain('category:');
    expect(meta).toContain('age');
  });
});

describe('a deep-linked arrival is distinguishable from an in-grid choice', () => {
  it('preselected is a real boolean on both sides', () => {
    expect(sanitizeTrialEventMeta({ topic: 'homework', preselected: true }))
      .toEqual({ topic: 'homework', preselected: true });
    expect(sanitizeTrialEventMeta({ topic: 'homework', preselected: false }))
      .toEqual({ topic: 'homework', preselected: false });
  });

  it('landing records the deep-link params when they are present', () => {
    expect(sanitizeTrialEventMeta({ deepLink: true, category: 'life-challenge', topic: 'homework' }))
      .toEqual({ deepLink: true, category: 'life-challenge', topic: 'homework' });
  });

  it('the wizard reads the arrival params once and tags landing with them', () => {
    expect(WIZARD).toMatch(/const deepLink = useRef/);
    expect(metaFor('landing')).toContain('deepLink: true');
    // preselected must compare the ARRIVAL topic to the chosen one — a bare
    // "was there a deep link" flag would count a visitor who changed their mind
    // in the grid as pre-selected.
    expect(metaFor('topic_selected')).toContain('deepLink.topic === storyInput.storyTopic');
  });
});

describe('unexpected meta is sanitised, never stored as sent', () => {
  it('drops keys that are not in the allowlist', () => {
    expect(sanitizeTrialEventMeta({ topic: 'homework', childName: 'Lukas', email: 'a@b.ch' }))
      .toEqual({ topic: 'homework' });
  });

  it('drops an allowlisted key carrying the wrong type', () => {
    expect(sanitizeTrialEventMeta({ preselected: 'yes', age: '7', topic: 42 })).toBeNull();
  });

  it('drops free text a visitor typed, even in an allowlisted key', () => {
    expect(sanitizeTrialEventMeta({ theme: 'a story about my son Lukas and his dog' })).toBeNull();
    expect(sanitizeTrialEventMeta({ topic: 'x'.repeat(200) })).toBeNull();
  });

  it('drops an out-of-range age rather than storing it', () => {
    expect(sanitizeTrialEventMeta({ age: 99 })).toBeNull();
    expect(sanitizeTrialEventMeta({ age: -1 })).toBeNull();
    expect(sanitizeTrialEventMeta({ age: 4.5 })).toBeNull();
  });

  it('returns null for a non-object, so the row stores NULL not "{}"', () => {
    expect(sanitizeTrialEventMeta(null)).toBeNull();
    expect(sanitizeTrialEventMeta('topic=homework')).toBeNull();
    expect(sanitizeTrialEventMeta(['homework'])).toBeNull();
    expect(sanitizeTrialEventMeta({})).toBeNull();
  });

  it('bounds the row: a huge object cannot survive as a huge row', () => {
    const bloated: Record<string, string> = {};
    for (let i = 0; i < 500; i++) bloated[`k${i}`] = 'x'.repeat(500);
    expect(JSON.stringify(sanitizeTrialEventMeta(bloated) ?? null).length).toBeLessThan(200);
  });
});

describe('the steps that already used meta are unchanged', () => {
  it('photo_analyzed still stores its boolean', () => {
    expect(sanitizeTrialEventMeta({ multipleFaces: true })).toEqual({ multipleFaces: true });
    expect(sanitizeTrialEventMeta({ multipleFaces: false })).toEqual({ multipleFaces: false });
  });

  it('account_created still stores its auth method', () => {
    expect(sanitizeTrialEventMeta({ method: 'google' })).toEqual({ method: 'google' });
    expect(sanitizeTrialEventMeta({ method: 'email' })).toEqual({ method: 'email' });
  });
});
