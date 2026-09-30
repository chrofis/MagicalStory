/**
 * Pins the 2026-09-30 phone-funnel changes that affect what the trial funnel counts.
 *
 * Why: 4 of the 5 paid visitors who opened /try (21-28 Sept) left on its intro screen without a tap, and
 * on an iPhone that screen had no visible button. The homepage's start button now skips the intro (the
 * visitor has just read the same pitch), and phones get a pinned start button.
 *
 * What must not break: `intro_start` is a mandatory funnel step. A visitor who skips the intro still
 * passed it (by pressing the homepage button), so it must still be recorded - flagged `introSkipped` -
 * or the funnel card shows a false drop-off. And both start buttons (phone, desktop) must go through one
 * handler, so the step cannot be counted two different ways.
 *
 * The client halves are asserted on the source text, like trial-funnel-topic-meta.test.ts: mounting the
 * wizard needs a DOM, a router and a language context, none of which say anything about the counts.
 */
import fs from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-intro-skip';
const { sanitizeTrialEventMeta } = require('../../server/routes/trial.js');

const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8').split('\r\n').join('\n');
const WIZARD = read('client/src/pages/TrialWizard.tsx');
const LANDING = read('client/src/pages/LandingPage.tsx');

describe('homepage start button skips the /try intro', () => {
  it('navigates to /try with router state skipIntro (not a query param, so shared /try links keep the intro)', () => {
    const handler = LANDING.slice(LANDING.indexOf('const handleStartJourney'), LANDING.indexOf('const handleStartJourney') + 200);
    expect(handler).toMatch(/navigate\('\/try',\s*\{\s*state:\s*\{\s*skipIntro:\s*true\s*\}\s*\}\)/);
  });

  it('the wizard reads that state to decide whether the intro shows', () => {
    expect(WIZARD).toMatch(/location\.state[^\n]*skipIntro/);
    expect(WIZARD).toMatch(/useState\(!introSkipped\)/);
  });

  it('a skipped intro still records intro_start, flagged, so the funnel shows no false drop', () => {
    expect(WIZARD).toMatch(/if \(introSkipped\) trackTrialStep\('intro_start', \{ introSkipped: true \}\)/);
  });

  it('the server keeps the introSkipped flag, and only as a boolean', () => {
    expect(sanitizeTrialEventMeta({ introSkipped: true })).toEqual({ introSkipped: true });
    expect(sanitizeTrialEventMeta({ introSkipped: 'yes' })).toBeNull();
  });
});

describe('the intro start buttons', () => {
  it('phone and desktop buttons share one handler that records intro_start', () => {
    expect(WIZARD).toMatch(/const startTrial = \(\) => \{ trackTrialStep\('intro_start'\); setShowIntro\(false\); \};/);
    const intro = WIZARD.slice(WIZARD.indexOf('if (showIntro) {'), WIZARD.indexOf('  return (\n    <div className="min-h-screen bg-gray-50">\n      {/* Navigation bar'));
    expect((intro.match(/onClick=\{startTrial\}/g) || []).length).toBe(2);
    expect(intro).not.toMatch(/trackTrialStep\('intro_start'\)/); // no second, inline recording path
  });

  it('phones get a start button pinned to the bottom edge', () => {
    expect(WIZARD).toMatch(/md:hidden fixed bottom-0/);
  });
});
