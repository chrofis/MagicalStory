/**
 * Time consecutive /api/trial/analyze-photo calls to separate analyzer cold
 * start from steady-state cost.
 *
 * The trial showcase reports ~36-45s for photo analysis on staging, which is a
 * third of the harness's end-to-end time and dwarfs the same step's share on
 * production. Production has continuous traffic keeping the Python analyzer
 * warm; an idle staging is cold on the first hit. If that is the explanation,
 * call 1 is slow and calls 2..n are fast.
 *
 * No paid API calls: analyze-photo only reaches the Python analyzer
 * (server/routes/trial.js -> photoAnalyzerUrl/analyze).
 *
 * Usage: node tests/manual/time-analyzer-warmup.js [n] [--base=https://...]
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { chTime } = require('../../scripts/lib/chTime.js');

const n = Number(process.argv.find((a) => /^\d+$/.test(a)) || 3);
const baseArg = process.argv.find((a) => a.startsWith('--base='));
const BASE = (baseArg ? baseArg.split('=')[1] : 'https://staging.magicalstory.ch').replace(/\/$/, '');
const PHOTO = path.join(__dirname, '..', 'fixtures', 'demo-photos', 'berger', 'Emma.jpg');

async function api(route, { method = 'POST', body, bearer } = {}) {
  const res = await fetch(`${BASE}${route}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${route} → ${res.status}: ${text.slice(0, 200)}`);
  try { return JSON.parse(text); } catch { return text; }
}

(async () => {
  if (!fs.existsSync(PHOTO)) { console.error('photo missing:', PHOTO); process.exit(1); }
  const jwt = execFileSync('node', [path.join(__dirname, '..', '..', 'scripts', 'admin', 'get-admin-token.js'), `--base=${BASE}`],
    { encoding: 'utf8' }).trim();
  const { token: adminToken } = await api('/api/trial/admin-bypass-token', { method: 'GET', bearer: jwt });
  const imageData = 'data:image/jpeg;base64,' + fs.readFileSync(PHOTO).toString('base64');

  console.log(`analyze-photo timing — ${BASE}, ${n} consecutive calls, same photo`);
  const times = [];
  for (let i = 1; i <= n; i++) {
    const t = Date.now();
    const r = await api('/api/trial/analyze-photo', { body: { imageData, adminToken } });
    const ms = Date.now() - t;
    times.push(ms);
    console.log(`  [${chTime(new Date())}] call ${i}: ${(ms / 1000).toFixed(1)}s  (faces=${r.face_count ?? r.faceCount ?? '?'})`);
  }
  const [first, ...rest] = times;
  if (rest.length) {
    const avg = rest.reduce((a, b) => a + b, 0) / rest.length;
    console.log(`\nfirst ${(first / 1000).toFixed(1)}s vs warm avg ${(avg / 1000).toFixed(1)}s → ${(first / avg).toFixed(1)}x`);
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
