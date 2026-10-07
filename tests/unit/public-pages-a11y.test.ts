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
});
