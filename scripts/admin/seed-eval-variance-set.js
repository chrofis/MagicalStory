#!/usr/bin/env node
/**
 * Seed the Test Lab set "Eval variance baseline" — the fixed case list for the
 * eval_variance stage.
 *
 * The question the set exists to answer: how far apart can two identical runs
 * of our image eval land on the SAME image? So the members are chosen to span
 * the conditions that plausibly change the answer, not to be representative of
 * traffic:
 *   - the motivating pair: page 9 of "Footprints on the Moon" as v0 (28) and
 *     v1 (85) — two versions the owner reads as near-identical
 *   - clean pages (0 stored findings) — does a page with nothing to find stay
 *     at 100, or does a repeat invent something?
 *   - broken pages (7-14 stored findings) — more findings = more chances to flip
 *   - a deeply negative page — is variance bounded once a page is far below 0?
 *   - six art styles — style_consistency is the single heaviest finding type
 *     and is style-dependent by construction
 *
 * Re-running is safe: the set upserts by (name, stage) and members upsert by
 * target, so adding a case later means adding a line to MEMBERS and re-running.
 *
 *   node scripts/admin/seed-eval-variance-set.js                       # staging
 *   node scripts/admin/seed-eval-variance-set.js --base=https://magicalstory.ch
 *   node scripts/admin/seed-eval-variance-set.js --run                 # seed, then fire a run
 */
const { execFileSync } = require('child_process');
const path = require('path');

const SET_NAME = 'Eval variance baseline';
const STAGE = 'eval_variance';

// storyId, page, [versionIndex], why it is in the set. Stored scores are the
// values at the time of seeding — the baseline the repeats are compared against.
const MEMBERS = [
  ['job_1786998860057_o6deqtv5s',  9, 0, 'concept · the 28 of the near-identical pair (7 findings)'],
  ['job_1786998860057_o6deqtv5s',  9, 1, 'concept · the 85 of the near-identical pair (1 finding)'],
  ['job_1786571353564_0sgrd0f4g',  1, null, 'pixar · clean page, stored 100 / 0 findings'],
  ['job_1786571353564_0sgrd0f4g',  8, null, 'pixar · same story, broken page, stored 28 / 8 findings'],
  ['job_1786917840874_rur4nskfv',  7, null, 'concept · clean page, stored 100 / 0 findings'],
  ['job_1786917840874_rur4nskfv',  1, null, 'concept · stored 21 / 10 findings'],
  ['job_1786829555599_rgzoyoprx',  3, null, 'concept · most findings in one page, stored 11 / 11'],
  ['job_1786780194082_s980g4s9a',  5, null, 'realistic · clean page, stored 80 / 0 findings'],
  ['job_1786743927715_kcx0p939w',  7, null, 'realistic · stored 25 / 7 findings'],
  ['job_1786653013328_yhzn4dv5q',  5, null, 'oil · clean page, stored 95 / 0 findings'],
  ['job_1786484554633_crojok432',  4, null, 'watercolor · stored 46 / 14 findings'],
  ['job_1786397108357_q1fjbdzbx',  5, null, 'steampunk · far below zero, stored -22 / 13 findings'],
];

const args = process.argv.slice(2);
const base = (args.find(a => a.startsWith('--base=')) || '--base=https://staging.magicalstory.ch').split('=')[1];
const alsoRun = args.includes('--run');
const repeats = parseInt((args.find(a => a.startsWith('--repeats=')) || '--repeats=3').split('=')[1], 10);

const token = execFileSync('node', [path.join(__dirname, 'get-admin-token.js'), `--base=${base}`], { encoding: 'utf8' }).trim();

const api = async (method, urlPath, body) => {
  const res = await fetch(`${base}/api/admin/testlab${urlPath}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${urlPath} → ${res.status} ${text.slice(0, 300)}`);
  return JSON.parse(text);
};

(async () => {
  const set = await api('POST', '/sets', { name: SET_NAME, stage: STAGE, params: { repeats } });
  console.log(`Set #${set.id} "${set.name}" (${set.stage}), repeats=${repeats}`);

  for (const [storyId, pageNumber, versionIndex, label] of MEMBERS) {
    const target = { storyId, pageNumber, ...(versionIndex != null ? { versionIndex } : {}) };
    await api('POST', `/sets/${set.id}/members`, { target, label });
    console.log(`  + ${storyId} p${pageNumber}${versionIndex != null ? ` v${versionIndex}` : ''} — ${label}`);
  }

  if (alsoRun) {
    const run = await api('POST', `/sets/${set.id}/run`, { label: `Eval variance — ${MEMBERS.length} images × ${repeats} repeats` });
    console.log(`\nRunning as experiment #${run.id} (${run.members} members × ${repeats} evals)`);
    console.log(`  ${base}/admin/test-lab?exp=${run.id}`);
  } else {
    console.log(`\nSeeded. Run it from the Sets tab, or re-run this with --run.`);
  }
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
