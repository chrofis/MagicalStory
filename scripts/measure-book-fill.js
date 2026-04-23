/**
 * Measure what fraction of each viewport the book viewer actually fills.
 * Runs a lightweight headless loop across the same viewport matrix as the
 * responsive screenshot harness and reads the bounding box of `.book-viewer`
 * via getBoundingClientRect.
 */

const { chromium } = require('@playwright/test');

const VIEWPORTS = [
  { name: 'iphone-se',            width: 375,  height: 667  },
  { name: 'iphone-15-pro',        width: 393,  height: 852  },
  { name: 'iphone-15-pro-max',    width: 430,  height: 932  },
  { name: 'pixel-7',              width: 412,  height: 915  },
  { name: 'galaxy-s21',           width: 360,  height: 800  },
  { name: 'phone-landscape',      width: 932,  height: 430  },
  { name: 'ipad-mini-portrait',   width: 744,  height: 1133 },
  { name: 'ipad-mini-landscape',  width: 1133, height: 744  },
  { name: 'ipad-air-portrait',    width: 820,  height: 1180 },
  { name: 'ipad-air-landscape',   width: 1180, height: 820  },
  { name: 'desktop-narrow',       width: 1280, height: 800  },
  { name: 'desktop-wide',         width: 1920, height: 1080 },
];

const SHARE_URL = process.env.SHARE_URL;
if (!SHARE_URL) {
  console.error('Set SHARE_URL=http://localhost:5173/shared/<token>');
  process.exit(1);
}

(async () => {
  const browser = await chromium.launch();
  const results = [];
  for (const v of VIEWPORTS) {
    const ctx = await browser.newContext({
      viewport: { width: v.width, height: v.height },
      hasTouch: v.width < 800,
      isMobile: v.width < 800,
      deviceScaleFactor: 1,
    });
    const page = await ctx.newPage();
    await page.goto(SHARE_URL, { waitUntil: 'domcontentloaded' });
    try {
      await page.waitForSelector('.book-viewer', { timeout: 10000 });
    } catch {}
    await page.waitForTimeout(4000);
    const rect = await page.evaluate(() => {
      const el = document.querySelector('.book-viewer');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
    await ctx.close();
    if (!rect) {
      results.push({ name: v.name, viewport: `${v.width}x${v.height}`, status: 'no-book' });
      continue;
    }
    const viewportArea = v.width * v.height;
    const bookArea = rect.width * rect.height;
    const pct = (bookArea / viewportArea) * 100;
    const widthPct = (rect.width / v.width) * 100;
    const heightPct = (rect.height / v.height) * 100;
    results.push({
      name: v.name,
      viewport: `${v.width}x${v.height}`,
      book: `${Math.round(rect.width)}x${Math.round(rect.height)}`,
      widthPct: widthPct.toFixed(1),
      heightPct: heightPct.toFixed(1),
      areaPct: pct.toFixed(1),
    });
  }
  await browser.close();
  console.log('\n%-22s %-12s %-12s %-10s %-10s %-10s', 'viewport', 'vp size', 'book size', 'W%', 'H%', 'area%');
  console.log('─'.repeat(82));
  for (const r of results) {
    if (r.status === 'no-book') {
      console.log('%-22s %-12s %s', r.name, r.viewport, 'NO BOOK FOUND');
    } else {
      console.log('%-22s %-12s %-12s %-10s %-10s %-10s', r.name, r.viewport, r.book, r.widthPct, r.heightPct, r.areaPct);
    }
  }
})();
