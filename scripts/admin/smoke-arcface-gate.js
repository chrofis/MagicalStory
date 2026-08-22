#!/usr/bin/env node
/**
 * Smoke test: does the ArcFace gate actually run during avatar creation?
 *
 * Generates avatars for N showcase characters against a deployed environment and
 * checks that every category came back with an `arcface` score stored next to
 * the Gemini judge's, so the gate can be seen working on real data rather than
 * inferred from unit checks.
 *
 * COSTS REAL MONEY — each character is a set of paid Grok generations, plus one
 * more per category the gate rejects. Default limit is 2 characters. Run only
 * when asked.
 *
 *   node scripts/admin/smoke-arcface-gate.js [--chars=2] [--base=https://staging.magicalstory.ch]
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { ch } = require('../lib/chTime');

const args = process.argv.slice(2);
const arg = (n, d) => { const h = args.find(a => a.startsWith(`--${n}=`)); return h ? h.split('=').slice(1).join('=') : d; };
const BASE = arg('base', 'https://staging.magicalstory.ch');
const N_CHARS = parseInt(arg('chars', '2'), 10);
const FAMILY = arg('family', 'miller');
const POLL_TIMEOUT_MS = 12 * 60 * 1000;

const token = () => execFileSync('node', [path.join(__dirname, 'get-admin-token.js'), `--base=${BASE}`],
  { encoding: 'utf8' }).trim().split('\n').pop().trim();

async function api(TOKEN, method, url, body) {
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(120000),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status}: ${JSON.stringify(json).slice(0, 200)}`);
  return json;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const TOKEN = token();

  // Confirm the deployed commit carries the gate before spending anything.
  const health = await (await fetch(`${BASE}/api/health`)).json();
  console.log(`Environment: ${BASE}  commit ${health.commit}  (${ch(new Date())})`);

  const dir = path.join(__dirname, '..', '..', 'tests', 'fixtures', 'demo-photos', FAMILY);
  const photos = fs.readdirSync(dir).filter(f => /\.(jpe?g|png)$/i.test(f)).slice(0, N_CHARS);
  if (!photos.length) throw new Error(`no photos in ${dir}`);
  console.log(`Using ${photos.length} ${FAMILY} photo(s): ${photos.join(', ')}\n`);

  // Reuse EXISTING characters rather than creating any: POST /api/characters
  // upserts the whole per-user array and returns {message, count}, so there is
  // no single-character create to get an id from. The avatar endpoint only needs
  // a valid characterId plus a referencePhoto, which we supply from the demo
  // photos — so an existing row is paired with a showcase face, matched on
  // gender so the prompt is not fighting the photo.
  //
  // NOTE: this OVERWRITES those characters' avatars on the smoke account. That
  // is the account's purpose, but it is why this is not pointed at real users.
  const { characters } = await api(TOKEN, 'GET', '/api/characters');
  const results = [];

  const pairs = [];
  for (const file of photos) {
    const female = /lily|rachel|margaret/i.test(file);
    const pick = characters.find(c => (c.gender === (female ? 'female' : 'male')) && !pairs.some(p => p.character.id === c.id));
    if (!pick) { console.log(`  no free ${female ? 'female' : 'male'} character for ${file} — skipping`); continue; }
    pairs.push({ file, character: pick });
  }
  if (!pairs.length) throw new Error('no characters available to test with');

  for (const { file, character } of pairs) {
    const name = character.name;
    const b64 = fs.readFileSync(path.join(dir, file)).toString('base64');
    const photo = `data:image/jpeg;base64,${b64}`;
    console.log(`  ${name} (${character.id})  <-  ${file}`);

    const started = Date.now();
    const job = await api(TOKEN, 'POST', '/api/generate-clothing-avatars?async=true', {
      characterId: character.id,
      referencePhoto: photo,
      facePhoto: photo,
      name, gender: character.gender || 'female', age: character.age || '7',
    });
    const jobId = job.jobId || job.id;
    console.log(`  job ${jobId} started — polling…`);

    let final = null;
    while (Date.now() - started < POLL_TIMEOUT_MS) {
      await sleep(10000);
      const st = await api(TOKEN, 'GET', `/api/avatar-jobs/${jobId}`);
      if (st.status === 'completed' || st.status === 'failed') { final = st; break; }
      process.stdout.write(`\r  ${st.progress ?? '?'}% ${String(st.message || '').slice(0, 60).padEnd(62)}`);
    }
    process.stdout.write('\n');
    if (!final) { console.log(`  TIMEOUT after ${POLL_TIMEOUT_MS / 1000}s`); results.push({ name, timeout: true }); continue; }
    if (final.status === 'failed') { console.log(`  FAILED: ${final.error}`); results.push({ name, failed: final.error }); continue; }

    const fm = final.result?.faceMatch || final.faceMatch || {};
    const rows = Object.entries(fm).map(([cat, v]) => ({
      cat, judge: v.score ?? null, arcface: v.arcface ?? null, cells: v.arcfaceCells || null,
    }));
    rows.forEach(r => console.log(
      `  ${r.cat.padEnd(9)} judge ${String(r.judge ?? '-').padStart(2)}/10   arcface ${r.arcface == null ? 'MISSING' : r.arcface.toFixed(3)}`
      + (r.cells ? `   cells ${JSON.stringify(r.cells)}` : '')
    ));
    results.push({ name, rows, seconds: Math.round((Date.now() - started) / 1000) });
  }

  // ── Verdict ───────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(72)}`);
  const all = results.flatMap(r => r.rows || []);
  const scored = all.filter(r => typeof r.arcface === 'number');
  console.log(`Characters: ${results.length}   categories: ${all.length}   with an arcface score: ${scored.length}`);
  if (!all.length) {
    console.log('NO CATEGORIES EVALUATED — the gate could not be observed.');
    process.exit(1);
  }
  if (!scored.length) {
    console.log('GATE NOT RUNNING: every category came back without an arcface score.');
    console.log('Likely the analyzer is unreachable or ArcFace weights are missing — it fails open by design,');
    console.log('so avatars still generate, but the second opinion is doing nothing.');
    process.exit(1);
  }
  const vals = scored.map(r => r.arcface).sort((a, b) => a - b);
  console.log(`arcface range: ${vals[0].toFixed(3)} – ${vals[vals.length - 1].toFixed(3)}`);
  console.log(scored.length === all.length
    ? 'GATE IS LIVE — every category carries an independent ArcFace score.'
    : `PARTIAL — ${all.length - scored.length} categor(ies) had no score (fail-open path).`);
  console.log('─'.repeat(72));
})().catch(e => { console.error(`\nSMOKE FAILED: ${e.message}`); process.exit(1); });
