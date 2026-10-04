/**
 * The top bar must stay put while the page scrolls, on every page.
 *
 * Why (2026-10-04): on a phone the bar scrolled away on /try, /create and the trial generation page.
 * Two causes: five hand-built black bars with no sticky classes (now `<Navigation minimal />`), and
 * `overflow-x-hidden` on a wrapper above the bar, which turns that wrapper into the scroll container
 * and so the sticky bar's containing block. `overflow-x-clip` clips the same overflow without that.
 *
 * Asserted on the source text, like trial-intro-phone.test.ts: sticky behaviour needs a real layout engine.
 */
import fs from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';

const ROOT = path.join(__dirname, '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8').split('\r\n').join('\n');
const PAGES_DIR = 'client/src/pages';
const pageFiles = fs.readdirSync(path.join(ROOT, PAGES_DIR)).filter((f) => f.endsWith('.tsx'));

describe('top bar is always sticky', () => {
  it('no hand-built black nav bar remains in client/src/pages', () => {
    const offenders = pageFiles.filter((f) => /<nav className="bg-black/.test(read(`${PAGES_DIR}/${f}`)));
    expect(offenders).toEqual([]);
  });

  // Rule: in the page's final top-level `return (`, no element opened before the first <Navigation>
  // may carry a class that makes it a scroll container (overflow-hidden / -x-hidden / -auto / -y-auto).
  // Use overflow-x-clip instead.
  it('no scroll-container class on elements opened before <Navigation>', () => {
    const offenders: string[] = [];
    let checked = 0;
    for (const f of pageFiles) {
      const src = read(`${PAGES_DIR}/${f}`);
      const idx = src.indexOf('<Navigation');
      if (idx < 0) continue;
      checked++;
      const head = src.slice(0, idx);
      const wrapper = head.slice(head.lastIndexOf('return ('));
      const bad = wrapper.match(/className=["'`{][^\n]*\boverflow-(hidden|x-hidden|y-auto|auto)\b/g);
      if (bad) offenders.push(`${f}: ${bad.join(' | ')}`);
    }
    expect(checked).toBeGreaterThan(20);
    expect(offenders).toEqual([]);
  });

  it('Navigation minimal variant keeps the sticky classes', () => {
    const nav = read('client/src/components/common/Navigation.tsx');
    expect(nav).toContain("const NAV_STICKY = 'sticky top-[var(--impersonation-banner-h,0px)] z-40'");
    const minimalBlock = nav.slice(nav.indexOf('if (minimal)'), nav.indexOf('if (minimal)') + 900);
    expect(minimalBlock).toContain('${NAV_STICKY}');
    expect((nav.match(/\$\{NAV_STICKY\}/g) || []).length).toBe(2);
  });
});
