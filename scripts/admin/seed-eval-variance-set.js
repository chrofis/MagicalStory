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
 * That 12-case list is the BASELINE — run once (experiment 768) to establish
 * the numbers. Day-to-day iteration uses the 5-case ITERATION_MEMBERS below;
 * see the note there.
 *
 * Re-running is safe: the set upserts by (name, stage) and members upsert by
 * target, so adding a case later means adding a line and re-running.
 *
 *   node scripts/admin/seed-eval-variance-set.js                       # 5-style iteration set, staging
 *   node scripts/admin/seed-eval-variance-set.js --set=baseline        # the full 12-case baseline
 *   node scripts/admin/seed-eval-variance-set.js --run                 # seed, then fire a run
 *   node scripts/admin/seed-eval-variance-set.js --base=https://magicalstory.ch
 */
const { execFileSync } = require('child_process');
const path = require('path');

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

/**
 * THE ITERATION SET (owner, 2026-08-19: "why do we need 12 cases, select 5
 * different art styles that is enough"). Five pages, five distinct art styles,
 * every one of them ALREADY measured by experiment 768 — so a before/after
 * needs one run, not two, and the baseline is a recorded number rather than a
 * fresh CHF 0.5 of evals.
 *
 * Chosen for signal, not coverage: the four worst movers across four styles,
 * plus one deliberately STABLE page. Without that control a "fix" that simply
 * deducts less would look like a win on every case in the set — the control is
 * what catches a change that buys quiet by going blind.
 */
const ITERATION_MEMBERS = [
  ['job_1786998860057_o6deqtv5s',  9, 0, 'concept · the motivating case · exp768 range 27 (23/50/33)'],
  ['job_1786571353564_0sgrd0f4g',  1, null, 'pixar · stored 100, invented findings on rerun · exp768 range 40 (85/45/45)'],
  ['job_1786653013328_yhzn4dv5q',  5, null, 'oil · stored 95 · exp768 range 60 (40/75/100)'],
  ['job_1786397108357_q1fjbdzbx',  5, null, 'steampunk · worst mover · exp768 range 105 (-130/-65/-25)'],
  ['job_1786743927715_kcx0p939w',  7, null, 'realistic · CONTROL, already stable · exp768 range 10 (50/45/55)'],
];

const SETS = {
  baseline:  { name: 'Eval variance baseline',  members: MEMBERS },
  iteration: { name: 'Eval variance — 5 styles', members: ITERATION_MEMBERS },
};

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

const which = (args.find(a => a.startsWith('--set=')) || '--set=iteration').split('=')[1];
if (!SETS[which]) { console.error(`--set must be one of: ${Object.keys(SETS).join(', ')}`); process.exit(1); }
const { name: SET_NAME, members: CASES } = SETS[which];

(async () => {
  const set = await api('POST', '/sets', { name: SET_NAME, stage: STAGE, params: { repeats } });
  console.log(`Set #${set.id} "${set.name}" (${set.stage}), repeats=${repeats}`);

  for (const [storyId, pageNumber, versionIndex, label] of CASES) {
    const target = { storyId, pageNumber, ...(versionIndex != null ? { versionIndex } : {}) };
    await api('POST', `/sets/${set.id}/members`, { target, label });
    console.log(`  + ${storyId} p${pageNumber}${versionIndex != null ? ` v${versionIndex}` : ''} — ${label}`);
  }

  if (alsoRun) {
    const run = await api("POST", `/sets/${set.id}/run`, { label: `${SET_NAME} — ${CASES.length} images × ${repeats} repeats` });
    console.log(`\nRunning as experiment #${run.id} (${run.members} members × ${repeats} evals)`);
    console.log(`  ${base}/admin/test-lab?exp=${run.id}`);
  } else {
    console.log(`\nSeeded. Run it from the Sets tab, or re-run this with --run.`);
  }
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
