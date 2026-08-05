#!/usr/bin/env node
/**
 * Fire a Test Lab set run from the CLI — the same POST /sets/:id/run the
 * "Run set" button makes, so a set can be iterated without clicking through
 * the UI. The set's stage decides what runs; every member becomes a target.
 *
 * Usage:
 *   node scripts/admin/run-testlab-set.js --set=3 \
 *     --label="Title paint-in #1" \
 *     --params='{"marginPct":0.12,"recolor":false}' \
 *     [--prompt="full prompt override"] [--base=https://staging.magicalstory.ch]
 *
 * Auth: TESTLAB_USER / TESTLAB_PASSWORD env, else the admin smoke account.
 */
const arg = (name, dflt) => {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};

const BASE = arg('base', 'https://staging.magicalstory.ch');
const SET_ID = arg('set');
const EMAIL = process.env.TESTLAB_USER || 'demo-b-hnecf@magicalstory.ch';
const PASSWORD = process.env.TESTLAB_PASSWORD || 'DemoStory2026!';

(async () => {
  if (!SET_ID) { console.error('--set=<id> required'); process.exit(1); }

  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: EMAIL, password: PASSWORD }),
  });
  if (!login.ok) { console.error(`login failed: ${login.status}`); process.exit(1); }
  const { token } = await login.json();

  const body = {};
  if (arg('label')) body.label = arg('label');
  if (arg('prompt')) body.promptOverride = arg('prompt');
  if (arg('params')) {
    try { body.params = JSON.parse(arg('params')); }
    catch (e) { console.error(`--params must be valid JSON: ${e.message}`); process.exit(1); }
  }

  const res = await fetch(`${BASE}/api/admin/testlab/sets/${SET_ID}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const out = await res.json().catch(() => ({}));
  console.log(`${res.status} ${JSON.stringify(out)}`);
  process.exit(res.ok ? 0 : 1);
})();
