// Throwaway perf probe: load a URL under mobile + Slow-4G emulation and report
// the LCP element (tag, size, text/src) plus FCP/LCP timings.
// Usage: node tests/manual/measure-lcp.js [url]
const { chromium, devices } = require('playwright');

const URL = process.argv[2] || 'https://www.magicalstory.ch/';

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ ...devices['Moto G4'] });
  const page = await context.newPage();

  // Register the LCP observer BEFORE any navigation so we capture the final
  // entry with its element, surviving SPA hydration.
  await page.addInitScript(() => {
    window.__lcp = null;
    new PerformanceObserver((list) => {
      const entries = list.getEntries();
      const last = entries[entries.length - 1];
      const el = last.element;
      const r = el && el.getBoundingClientRect();
      window.__lcp = {
        time: Math.round(last.startTime),
        size: last.size,
        url: last.url || '(text node)',
        tag: el ? el.tagName : null,
        cls: el ? el.className : null,
        text: el ? (el.textContent || '').trim().slice(0, 80) : null,
        font: el ? getComputedStyle(el).fontFamily : null,
        rect: r ? `${Math.round(r.width)}x${Math.round(r.height)}` : null,
      };
    }).observe({ type: 'largest-contentful-paint', buffered: true });
  });

  // Slow 4G via CDP, matching Lighthouse's throttling profile.
  const client = await context.newCDPSession(page);
  await client.send('Network.enable');
  await client.send('Network.emulateNetworkConditions', {
    offline: false,
    downloadThroughput: (1.6 * 1024 * 1024) / 8,
    uploadThroughput: (750 * 1024) / 8,
    latency: 150,
  });
  await client.send('Emulation.setCPUThrottlingRate', { rate: 4 });

  await page.goto(URL, { waitUntil: 'load', timeout: 60000 });
  await page.waitForTimeout(6000); // let LCP settle

  const result = await page.evaluate(() => {
    const paints = performance.getEntriesByType('paint');
    const fcp = Math.round((paints.find(p => p.name === 'first-contentful-paint') || {}).startTime || 0);
    return { fcp, lcp: window.__lcp };
  });

  console.log(JSON.stringify({ url: URL, ...result }, null, 2));
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
