// Free-book screen after trial sign-up + the free-book line in the story-complete mail
// (docs/decisions.md 2026-11-08). The reminder mail was dropped by the owner; no unsubscribe wording.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '..', '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const email = require(path.join(ROOT, 'email.js'));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { shouldOfferFreeBook } = require(path.join(ROOT, 'server/lib/trialEmail.js'));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { CREDIT_CONFIG } = require(path.join(ROOT, 'server/config/credits.js'));

describe('shouldOfferFreeBook', () => {
  it('offers to a signed-up user with no other story', () => {
    expect(shouldOfferFreeBook({ is_trial: false }, 0)).toBe(true);
  });
  it('not while still a trial account', () => {
    expect(shouldOfferFreeBook({ is_trial: true }, 0)).toBe(false);
  });
  it('not when a real story already exists', () => {
    expect(shouldOfferFreeBook({ is_trial: false }, 1)).toBe(false);
  });
  it('not when the count is unknown (no guessing)', () => {
    expect(shouldOfferFreeBook({ is_trial: false }, undefined)).toBe(false);
  });
});

describe('story-complete free-book block', () => {
  const base = { greeting: ' Anna', title: 'T', storyUrl: 'https://magicalstory.ch/shared/t', claimUrl: '', coverUrl: '', credits: '200' };
  const pages = String(Math.floor(CREDIT_CONFIG.LIMITS.INITIAL_USER / CREDIT_CONFIG.COSTS.PER_PAGE));
  for (const language of ['English', 'German', 'French', 'Italian']) {
    it(`${language}: block shown with url, pages filled, no unsubscribe, singular character`, () => {
      const sec = email.getTemplateSection('story-complete', language);
      const v = { ...base, freeBookUrl: 'https://magicalstory.ch/create?new=true', freeBookPages: pages };
      for (const part of ['text', 'html'] as const) {
        const out = email.fillTemplate(sec[part], v, { html: part === 'html' });
        expect(out).toContain(`${pages}`);
        expect(out).toContain('create?new=true');
        expect(out).not.toMatch(/\{[\w?/]+\}/);
        expect(out).not.toMatch(/unsubscribe|abmelden|désinscri|annulla l'iscrizione|disiscri/i);
        expect(out).not.toMatch(/b(characters|Figuren|personnages|personaggi)b/i);
      }
    });
    it(`${language}: block stripped without url`, () => {
      const sec = email.getTemplateSection('story-complete', language);
      const out = email.fillTemplate(sec.html, { ...base, freeBookUrl: '', freeBookPages: pages }, { html: true });
      expect(out).not.toContain('create?new=true');
      expect(out).not.toMatch(/\{[\w?/]+\}/);
    });
  }
  it('the pipeline full-story sender passes no freeBookUrl', () => {
    expect(read('storyJobPipeline.js')).not.toMatch(/freeBookUrl/);
  });
});

describe('every trial sign-up path ends on the shared free-book screen', () => {
  it('route exists and component computes pages from credit constants', () => {
    expect(read('client/src/App.tsx')).toMatch(/path="\/free-book"/);
    const c = read('client/src/pages/FreeBook.tsx');
    expect(c).toMatch(/INITIAL_USER_CREDITS \/ CREDITS_PER_PAGE/);
    expect(c).toMatch(/navigate\('\/create\?new=true'\)/);
    expect(c).toMatch(/navigate\('\/stories'\)/);
    for (const lang of ['en', 'de', 'fr', 'it']) expect(c).toMatch(new RegExp(`\n  ${lang}: \{`));
    expect(c).not.toMatch(/ß/);
  });
  it('claim page (both redirects), set-password banner and Google gate use FREE_BOOK_PATH', () => {
    expect((read('client/src/pages/ClaimAccount.tsx').match(/= FREE_BOOK_PATH/g) || []).length).toBe(2);
    expect(read('client/src/pages/ClaimAccount.tsx')).not.toMatch(/location\.href = '\/stories'/);
    expect(read('client/src/pages/MyStories.tsx')).toMatch(/navigate\(FREE_BOOK_PATH\)/);
    expect(read('client/src/pages/TrialGenerationPage.tsx')).toMatch(/googleLinked \? FREE_BOOK_PATH/);
  });
  it('FREE_BOOK_PATH matches the route', () => {
    expect(read('client/src/utils/trialPoll.ts')).toMatch(/FREE_BOOK_PATH = '\/free-book'/);
  });
});
