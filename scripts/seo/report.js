#!/usr/bin/env node
/**
 * Search Console performance report: last 28 days vs the previous 28,
 * by query and by page — the "what got worse" view.
 *
 * Run: node scripts/seo/report.js            (28d vs previous 28d)
 *      node scripts/seo/report.js --days=7   (7d vs previous 7d)
 *
 * Requires scripts/seo/config.json (mint via get-refresh-token.js).
 * GSC data lags ~2 days; ranges end 3 days ago to stay complete.
 */
const cfg = require('./config.json');

const DAYS = (() => {
  const a = process.argv.find(x => x.startsWith('--days='));
  return a ? parseInt(a.split('=')[1], 10) : 28;
})();

async function accessToken() {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: cfg.client_id,
      client_secret: cfg.client_secret,
      refresh_token: cfg.refresh_token,
      grant_type: 'refresh_token',
    }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error('token refresh failed: ' + JSON.stringify(j));
  return j.access_token;
}

function iso(d) { return d.toISOString().slice(0, 10); }

async function query(token, startDate, endDate, dimension) {
  const r = await fetch(
    `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(cfg.site)}/searchAnalytics/query`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ startDate, endDate, dimensions: [dimension], rowLimit: 250 }),
    },
  );
  const j = await r.json();
  if (j.error) throw new Error(`${dimension} ${startDate}..${endDate}: ${j.error.message}`);
  return new Map((j.rows || []).map(row => [row.keys[0], row]));
}

function fmtRow(key, cur, prev) {
  const c = cur || { clicks: 0, impressions: 0, position: 0 };
  const p = prev || { clicks: 0, impressions: 0, position: 0 };
  const dc = c.clicks - p.clicks;
  const di = c.impressions - p.impressions;
  const dpos = (c.position && p.position) ? (c.position - p.position) : null;
  return `${String(dc).padStart(4)} clicks (${p.clicks}→${c.clicks}) | ` +
    `${String(di).padStart(5)} impr (${p.impressions}→${c.impressions}) | ` +
    `pos ${p.position ? p.position.toFixed(1) : '—'}→${c.position ? c.position.toFixed(1) : '—'}` +
    `${dpos !== null && dpos > 0.5 ? ' ▼' : dpos !== null && dpos < -0.5 ? ' ▲' : ''} | ${key}`;
}

(async () => {
  const token = await accessToken();
  const end = new Date(Date.now() - 3 * 86400e3);
  const start = new Date(end.getTime() - (DAYS - 1) * 86400e3);
  const prevEnd = new Date(start.getTime() - 86400e3);
  const prevStart = new Date(prevEnd.getTime() - (DAYS - 1) * 86400e3);
  console.log(`Current: ${iso(start)}..${iso(end)}  vs  Previous: ${iso(prevStart)}..${iso(prevEnd)}\n`);

  for (const dim of ['query', 'page']) {
    const [cur, prev] = await Promise.all([
      query(token, iso(start), iso(end), dim),
      query(token, iso(prevStart), iso(prevEnd), dim),
    ]);
    const keys = new Set([...cur.keys(), ...prev.keys()]);
    const rows = [...keys].map(k => ({ k, cur: cur.get(k), prev: prev.get(k) }))
      .map(r => ({ ...r, delta: (r.cur?.clicks || 0) - (r.prev?.clicks || 0), tot: (r.cur?.clicks || 0) + (r.prev?.clicks || 0), dImpr: (r.cur?.impressions || 0) - (r.prev?.impressions || 0) }))
      .filter(r => r.tot > 0 || Math.abs(r.dImpr) >= 10);

    const totCur = [...cur.values()].reduce((s, r) => s + r.clicks, 0);
    const totPrev = [...prev.values()].reduce((s, r) => s + r.clicks, 0);
    const impCur = [...cur.values()].reduce((s, r) => s + r.impressions, 0);
    const impPrev = [...prev.values()].reduce((s, r) => s + r.impressions, 0);
    console.log(`═══ by ${dim} — clicks ${totPrev}→${totCur}, impressions ${impPrev}→${impCur} ═══`);

    rows.sort((a, b) => a.delta - b.delta || a.dImpr - b.dImpr);
    console.log(`— biggest losses:`);
    for (const r of rows.slice(0, 12)) console.log('  ' + fmtRow(r.k, r.cur, r.prev));
    console.log(`— biggest gains:`);
    for (const r of rows.slice(-5).reverse()) console.log('  ' + fmtRow(r.k, r.cur, r.prev));
    console.log('');
  }
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });
