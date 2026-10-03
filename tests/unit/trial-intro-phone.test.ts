/**
 * Pins the phone-funnel changes of 2026-09-30 / 2026-10-03.
 *
 * Why: 4 of the 5 paid visitors who opened /try (21-28 Sept) left on its intro screen without a tap; on
 * an iPhone that screen had no visible button. Phones now get the finished-book image first and a start
 * button pinned to the bottom edge.
 *
 * A homepage-to-step-1 skip was tried on staging (2026-09-30) and REMOVED on 2026-10-03 (owner): it landed
 * homepage visitors straight on the consent step without ever seeing the finished book, and once the intro
 * fit one screen with a pinned button the skip saved only one tap. So every visitor sees the intro, and
 * the funnel needs no flag to tell two paths apart.
 *
 * Client halves are asserted on the source text, like trial-funnel-topic-meta.test.ts: mounting the wizard
 * needs a DOM, a router and a language context, none of which say anything about the counts.
 */
import fs from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-intro-phone';
const { sanitizeTrialEventMeta } = require('../../server/routes/trial.js');

const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8').split('\r\n').join('\n');
const WIZARD = read('client/src/pages/TrialWizard.tsx');
const LANDING = read('client/src/pages/LandingPage.tsx');
const FOOTER = read('client/src/components/common/Footer.tsx');

describe('every visitor sees the /try intro', () => {
  it('the intro is shown unconditionally on arrival', () => {
    expect(WIZARD).toMatch(/const \[showIntro, setShowIntro\] = useState\(true\);/);
  });

  it('the homepage start button goes to plain /try, with no skip state', () => {
    const at = LANDING.indexOf('const handleStartJourney');
    expect(LANDING.slice(at, at + 120)).toMatch(/navigate\('\/try'\);/);
    expect(LANDING).not.toMatch(/skipIntro/);
  });

  it('the server no longer accepts the removed introSkipped flag', () => {
    expect(sanitizeTrialEventMeta({ introSkipped: true })).toBeNull();
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

describe('homepage trust row on phones', () => {
  it('Impressum and Datenschutz next to the CTA are desktop-only', () => {
    expect(LANDING).toMatch(/<Link to="\/impressum" className="hidden lg:inline-flex/);
    expect(LANDING).toMatch(/<Link to="\/privacy" className="hidden lg:inline-flex/);
  });

  it('...and phones still reach both through the footer the homepage renders', () => {
    expect(LANDING).toMatch(/<Footer \/>/);
    expect(FOOTER).toMatch(/to=\{to\('\/impressum'\)\}/);
    expect(FOOTER).toMatch(/to=\{to\('\/privacy'\)\}/);
  });
});
