// The Italian trial-reminder copy says "account", as the rest of the Italian
// UI does (client/src: "il tuo account" 8x, "un account" 22x, "conto" 4x) and
// as emails-src/i18n.ts already did in the same mail. email.js's
// TRIAL_REMINDER_COPY said "conto" in the body, CTA and perks intro, so one
// reminder mixed both words.

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '..', '..');

describe('Italian mail copy says "account", never "conto"', () => {
  for (const file of ['email.js', 'emails-src/i18n.ts', 'emails/trial-reminder.html', 'emails/trial-story-complete.html']) {
    it(file, () => {
      expect(fs.readFileSync(path.join(ROOT, file), 'utf8')).not.toMatch(/\bconto\b/);
    });
  }
  it('TRIAL_REMINDER_COPY Italian uses account in body, CTA and perks intro', () => {
    const source = fs.readFileSync(path.join(ROOT, 'email.js'), 'utf8');
    expect(source).toContain('sul tuo account');
    expect(source).toContain('Con un account completo ottieni inoltre:');
    expect(source).toContain('Attiva ora il mio account');
    expect(source).toContain("Una volta attivato l'account, ottieni inoltre:");
  });
});
