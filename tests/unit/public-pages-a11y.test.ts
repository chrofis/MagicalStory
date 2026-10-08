/**
 * Accessibility contract of the public pages' shared chrome (2026-10-07 audit,
 * Playwright against the built client at 375px and 1280px).
 *
 * Pinned here, each a defect the audit found:
 * - the nav Menu button's only text is `hidden md:inline`, so on phones it had no
 *   accessible name; it now carries aria-label / aria-expanded and closes on Escape
 * - the FAQ search box had a placeholder but no label
 * - the three dialogs (common/Modal, CreditsModal, ChangePasswordModal) are announced as
 *   dialogs, take focus on open and close on Escape (the latter two had no Escape at all)
 * - the /try step images reserve their box (width/height), the landing images already did
 * - ThemePage's "what your child learns" / "recommended age" labels sat as h3 under the
 *   h1 with no h2 between (heading level skip)
 *
 * Source-level pins (vitest runs in node; there is no DOM test environment here).
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const src = (rel: string) => fs.readFileSync(path.join(__dirname, '../../client/src', rel), 'utf8');

describe('public pages a11y chrome', () => {
  it('nav Menu button has a translated accessible name, exposes its state and closes on Escape', () => {
    const nav = src('components/common/Navigation.tsx');
    const btn = nav.slice(nav.indexOf('onClick={() => setShowMenu(!showMenu)}'), nav.indexOf('<Menu size={16} />'));
    expect(btn).toContain("aria-label={uiLabel('menu', language)}");
    expect(btn).toContain('aria-expanded={showMenu}');
    expect(nav).toMatch(/event\.key === 'Escape'\) setShowMenu\(false\)/);
  });

  it('FAQ search input is labelled in the page language', () => {
    const faq = src('pages/FAQ.tsx');
    expect(faq).toContain('aria-label={content.searchPlaceholder}');
  });

  it('all three dialogs are announced as modal dialogs, take focus on open and close on Escape', () => {
    for (const rel of ['components/common/Modal.tsx', 'components/common/CreditsModal.tsx', 'components/auth/ChangePasswordModal.tsx']) {
      const s = src(rel);
      expect(s, rel).toContain('role="dialog"');
      expect(s, rel).toContain('aria-modal="true"');
      expect(s, rel).toMatch(/aria-labelledby=/);
      expect(s, rel).toContain('panelRef.current?.focus()');
      expect(s, rel).toMatch(/e\.key === 'Escape'/);
    }
  });

  it('every /try step image reserves its box with width and height', () => {
    const s = src('pages/TrialWizard.tsx');
    const tags = s.match(/<img[^>]*\/images\/try\/[^>]*>|<img[^>]*src=\{s\.img\}[^>]*>/gs) || [];
    expect(tags.length).toBeGreaterThanOrEqual(5);
    for (const tag of tags) {
      expect(tag, tag.slice(0, 80)).toMatch(/width="\d+"/);
      expect(tag, tag.slice(0, 80)).toMatch(/height="\d+"/);
    }
  });

  it('ThemePage has no h3 before its first h2 (no heading level skip under the h1)', () => {
    const s = src('pages/ThemePage.tsx');
    const firstH2 = s.indexOf('<h2');
    const firstH3 = s.indexOf('<h3');
    expect(firstH2).toBeGreaterThan(-1);
    expect(firstH3 === -1 || firstH3 > firstH2).toBe(true);
  });
});

describe('public pages landmarks and focus management (2026-10-07 follow-up)', () => {
  const mainTag = /^\s*<main\b/gm;

  it('the route shells (App.tsx, SSRApp.tsx) each render exactly one <main id="main-content"> around the routes', () => {
    for (const rel of ['App.tsx', 'SSRApp.tsx']) {
      const s = src(rel);
      expect(s.match(mainTag)?.length, rel).toBe(1);
      expect(s, rel).toContain('<main id="main-content">');
      expect(s.indexOf('<main id="main-content">'), rel).toBeLessThan(s.indexOf('<Routes>'));
      expect(s.indexOf('</Routes>'), rel).toBeLessThan(s.indexOf('</main>'));
      expect(s, rel).toContain('<SkipLink />');
    }
  });

  it('no page or component nests a second <main>', () => {
    const root = path.join(__dirname, '../../client/src');
    const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
      d.isDirectory() ? walk(path.join(dir, d.name)) : /\.tsx?$/.test(d.name) ? [path.join(dir, d.name)] : []);
    const offenders = walk(root)
      .filter((f) => !/[\\/](App|SSRApp)\.tsx$/.test(f))
      .filter((f) => mainTag.test(fs.readFileSync(f, 'utf8')) && (mainTag.lastIndex = 0, true));
    expect(offenders).toEqual([]);
  });

  it('the skip link is the first element of both shells and is localized in all four languages', () => {
    const skip = src('components/common/SkipLink.tsx');
    expect(skip).toContain('href="#main-content"');
    expect(skip).toContain('sr-only focus:not-sr-only');
    expect(skip).toContain("uiLabel('skipToContent', language)");
    const labels = src('utils/uiLabels.ts');
    const row = labels.match(/skipToContent: \{([^}]*)\}/)?.[1] || '';
    for (const lang of ['en', 'de', 'fr', 'it']) expect(row, lang).toMatch(new RegExp(`${lang}: '[^']+'`));
    for (const rel of ['App.tsx', 'SSRApp.tsx']) {
      const s = src(rel);
      const body = s.slice(s.indexOf('return ('));
      expect(body.indexOf('<SkipLink />'), rel).toBeLessThan(body.indexOf('<ScrollToTop />'));
    }
  });

  it('all three dialogs trap Tab inside the panel via useFocusTrap', () => {
    for (const rel of ['components/common/Modal.tsx', 'components/common/CreditsModal.tsx', 'components/auth/ChangePasswordModal.tsx']) {
      const s = src(rel);
      expect(s, rel).toContain('useFocusTrap(panelRef, isOpen)');
    }
  });

  it('landing discover cards (Themes and siblings) show a focus-visible ring', () => {
    const s = src('pages/LandingPage.tsx');
    const card = s.slice(s.indexOf("{ to: '/themes',"), s.indexOf('<Icon className'));
    expect(card).toContain('focus-visible:ring-2');
  });
});
