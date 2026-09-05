#!/usr/bin/env node
/**
 * Re-generate a production story on STAGING with the current code, using the
 * ORIGINAL inputs and the ORIGINAL characters.
 *
 * The point is a like-for-like comparison: same brief, same figures, today's
 * pipeline. Anything that differs in the output is the pipeline, not the input.
 *
 * Two details that make "same figures" actually true:
 *  - story_jobs.input_data stores SLIM character stubs (no photos, no avatar
 *    URLs) because the pipeline enriches them from the characters table at run
 *    time. Replaying input_data verbatim would therefore generate NEW avatars.
 *    So we splice in the FULL character objects from the copied characters row.
 *  - The job runs under the admin account (the prod user does not exist on
 *    staging), so the characters must travel in the request rather than being
 *    looked up by user id.
 *
 * COSTS REAL MONEY — a full story is ~CHF 2 and 30-45 min. Run only when asked.
 *
 * Season comes from the DATE. The source job's stored season is dropped (it is
 * often blank — `job_1788614817116_vxnu60yjg` carried `season: ""` — or stale,
 * from whenever the original was launched), so the field travels ABSENT and the
 * pipeline's single resolver (server/lib/season.js) derives it from this job's
 * own creation date. `--season=` overrides that, for tests that need a fixed one.
 *
 *   node scripts/admin/rerun-story-on-staging.js <storyId> [--pages=N] [--season=S] [--yes]
 */
'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
const { Pool } = require('pg');
const { execFileSync } = require('child_process');
const { normalizeSeason, resolveSeason, SEASONS } = require('../../server/lib/season');

const args = process.argv.slice(2);
const storyId = args.find((a) => !a.startsWith('--'));
const YES = args.includes('--yes');
const pagesOverride = args.find((a) => a.startsWith('--pages='));
const seasonFlag = args.find((a) => a.startsWith('--season='));
const BASE = 'https://staging.magicalstory.ch';

const USAGE = 'Usage: node scripts/admin/rerun-story-on-staging.js <storyId> [--pages=N] [--season=spring|summer|autumn|winter] [--yes]';
if (!storyId || args.includes('--help') || args.includes('-h')) { console.error(USAGE); process.exit(storyId ? 0 : 1); }

let seasonOverride = null;
if (seasonFlag) {
  const raw = seasonFlag.split('=').slice(1).join('=');
  seasonOverride = normalizeSeason(raw);
  if (!seasonOverride) {
    console.error(`--season="${raw}" is not a season. Use one of: ${SEASONS.join(', ')} (aliases like fall/Sommer/Herbst are accepted).`);
    process.exit(1);
  }
}

/** Append the story's characters to the admin account's row (idempotent). */
async function ensureCharactersOnAdmin(characters) {
  const stg = new Pool({ connectionString: process.env.STAGING_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  try {
    const me = await fetch(`${BASE}/api/auth/me`, { headers: { Authorization: `Bearer ${token()}` } });
    const meBody = await me.json().catch(() => null);
    const adminId = meBody?.user?.id || meBody?.id;
    if (!adminId) throw new Error(`could not resolve admin user id (${JSON.stringify(meBody).slice(0, 120)})`);

    const rowId = `characters_${adminId}`;
    const cur = await stg.query('SELECT data FROM characters WHERE id = $1', [rowId]);
    const existing = cur.rows[0]?.data?.characters || [];
    const haveIds = new Set(existing.map((c) => String(c.id)));
    const toAdd = characters.filter((c) => !haveIds.has(String(c.id)));
    if (!toAdd.length) return adminId;

    const merged = { ...(cur.rows[0]?.data || {}), characters: [...existing, ...toAdd] };
    if (cur.rows.length) {
      await stg.query('UPDATE characters SET data = $2 WHERE id = $1', [rowId, merged]);
    } else {
      await stg.query('INSERT INTO characters (id, user_id, data, metadata, created_at) VALUES ($1,$2,$3,$4,NOW())',
        [rowId, adminId, merged, {}]);
    }
    console.log(`  appended ${toAdd.map((c) => c.name).join(', ')} (kept ${existing.length} existing)`);
    return adminId;
  } finally {
    await stg.end();
  }
}

const token = () => execFileSync('node', [path.join(__dirname, 'get-admin-token.js'), `--base=${BASE}`], { encoding: 'utf8' }).trim().split('\n').pop().trim();

(async () => {
  const prod = new Pool({ connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const stg = new Pool({ connectionString: process.env.STAGING_DATABASE_URL, ssl: { rejectUnauthorized: false } });

  // 1) Original inputs, straight from the production job.
  const j = await prod.query('SELECT input_data, user_id FROM story_jobs WHERE id = $1', [storyId]);
  if (!j.rows.length) { console.error(`No story_jobs row for ${storyId} — inputs are not replayable.`); process.exit(1); }
  const src = typeof j.rows[0].input_data === 'string' ? JSON.parse(j.rows[0].input_data) : j.rows[0].input_data;
  const prodUser = j.rows[0].user_id;

  // 2) FULL characters, from the row copy-story-to-staging.js brought over.
  const ch = await stg.query('SELECT data FROM characters WHERE id = $1', [`characters_${prodUser}`]);
  if (!ch.rows.length) {
    console.error(`No characters row on staging for ${prodUser}.`);
    console.error(`Run first: node scripts/admin/copy-story-to-staging.js ${storyId}`);
    process.exit(1);
  }
  const fullChars = ch.rows[0].data?.characters || [];
  await prod.end(); await stg.end();

  const wantedIds = new Set((src.characters || []).map((c) => String(c.id)));
  const characters = fullChars.filter((c) => wantedIds.has(String(c.id)));
  if (characters.length !== wantedIds.size) {
    console.error(`Character mismatch: job wants ${wantedIds.size}, staging row has ${characters.length}. Refusing — "same figures" would not hold.`);
    process.exit(1);
  }

  // The API rejects characters that do not belong to the calling account
  // ("Characters not found on this account"), so inline objects are not enough
  // — the rows must exist under the admin user. APPEND them, never replace:
  // the smoke account's own characters are used by other tests.
  const adminId = await ensureCharactersOnAdmin(characters);
  console.log(`Characters attached to admin account ${adminId}`);

  const inputs = { ...src, characters };
  if (pagesOverride) inputs.pages = Number(pagesOverride.split('=')[1]);

  // Season: the date decides. Drop whatever the source job stored — it is blank
  // on some jobs and stale on the rest — so the field is ABSENT and the pipeline
  // derives it from this job's creation date. --season= is the test override.
  delete inputs.season;
  if (seasonOverride) inputs.season = seasonOverride;
  const season = seasonOverride || resolveSeason({}, { now: new Date() });

  const withAvatars = characters.filter((c) => c.avatars?.standardUrl || c.avatars?.summerUrl || c.avatars?.winterUrl).length;
  console.log(`Story    : ${storyId}`);
  console.log(`Inputs   : ${inputs.pages}p, ${inputs.language}, ${inputs.artStyle}, ${inputs.storyCategory}/${inputs.storyType}`);
  console.log(`Characters: ${characters.map((c) => c.name).join(', ')} (${withAvatars}/${characters.length} carry avatar sheets)`);
  console.log(`Season   : ${season}${seasonOverride ? ' (--season override)' : " (derived from today's date by the pipeline)"}`);
  console.log(`Main     : ${(inputs.mainCharacters || []).join(', ')}`);
  console.log(`Details  : ${String(inputs.storyDetails || '').slice(0, 120)}…`);

  if (!YES) { console.log('\nThis costs ~CHF 2 and 30-45 min. Re-run with --yes to launch.'); return; }

  const res = await fetch(`${BASE}/api/jobs/create-story`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
    body: JSON.stringify(inputs),
    signal: AbortSignal.timeout(120000),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) { console.error(`create-story failed ${res.status}: ${JSON.stringify(body).slice(0, 400)}`); process.exit(1); }
  console.log(`\n✅ launched on staging: job ${body.jobId}`);
  console.log(`   watch: ${BASE}/create?storyId=${body.jobId}`);
})().catch((e) => { console.error('ERR:', e.message); process.exit(1); });
