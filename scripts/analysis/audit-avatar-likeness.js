#!/usr/bin/env node
/**
 * Avatar likeness audit — objective ArcFace cosine vs. the LLM judge's opinion.
 *
 * WHY THIS EXISTS
 * Owner trial feedback (2026-08-21): "Das Foto fand ich gegenüber dem Original
 * nicht sehr gelungen / fehlende Ähnlichkeit." But every likeness score we
 * already store says the opposite — `stories.data.styledAvatarGeneration[]
 * .faceMatchScore` had a median of 8/10 across 512 samples (4 below the gate of
 * 5), and `characters.data.characters[].avatars.faceMatch.*.score` reads 9/10.
 * Both are Gemini opinions grading themselves. This script adds an INDEPENDENT
 * measurement — ArcFace cosine similarity, which is style-invariant (it is
 * designed to match a photo against a stylised render) — so we can find out
 * whether the judges are lenient or are simply grading the wrong artifact.
 *
 * WHAT IT COMPARES
 *   original face photo  ->  each quadrant of the avatar sheet   (always)
 *   original face photo  ->  faces cropped out of real story pages   (--pages)
 * The second is the one that matters most: `faceMatchScore` only ever looks at
 * the avatar sheet, which no customer ever sees. Likeness can still be lost in
 * the page render and in character repair, and nothing measures that today.
 *
 * REQUIREMENTS
 *   The Python service must be running:  npm run dev:python
 *   ArcFace (DeepFace) is loaded lazily by photo_analyzer.py on first call.
 *
 * USAGE
 *   node scripts/analysis/audit-avatar-likeness.js --limit=15
 *   node scripts/analysis/audit-avatar-likeness.js --limit=8 --pages
 *   node scripts/analysis/audit-avatar-likeness.js --db=staging
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { ch } = require('../lib/chTime');

const PY = process.env.PHOTO_ANALYZER_URL || 'http://127.0.0.1:5000';

const args = process.argv.slice(2);
const arg = (name, dflt) => {
  const hit = args.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : dflt;
};
const LIMIT = parseInt(arg('limit', '15'), 10);
const WITH_PAGES = args.includes('--pages');
const DB = arg('db', 'prod');
const OUT = arg('out', path.join(__dirname, 'test-output', 'avatar-likeness-audit.html'));

const CONN = DB === 'staging' ? process.env.STAGING_DATABASE_URL : process.env.DATABASE_URL;

// ArcFace cosine bands. DeepFace's own ArcFace threshold for "same person" on
// photo-vs-photo is ~0.68 cosine; photo-vs-illustration sits lower by nature,
// so these bands are for RANKING and for spotting the floor, not for a verdict.
const band = (s) => (s >= 0.60 ? 'strong' : s >= 0.45 ? 'good' : s >= 0.30 ? 'weak' : 'poor');

async function py(endpoint, body) {
  const res = await fetch(`${PY}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${endpoint} ${res.status}: ${json?.error || 'no body'}`);
  return json;
}

/** R2 URL (or data URI) -> bare base64, which is what the Python service wants. */
const imageCache = new Map();
async function toBase64(url) {
  if (!url) return null;
  if (url.startsWith('data:')) return url.split(',')[1];
  if (imageCache.has(url)) return imageCache.get(url);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${res.status} for ${url.slice(0, 80)}`);
  const b64 = Buffer.from(await res.arrayBuffer()).toString('base64');
  imageCache.set(url, b64);
  return b64;
}

const QUADRANTS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];

/**
 * Compare the source photo against all four cells of an avatar sheet.
 * Mirrors how the LLM judge scores it (`sourceMatchScore` = LOWEST of the four
 * cells, per prompts/sheet-2x4-evaluation.txt) so the two numbers are directly
 * comparable — we report the same min, plus the max and the detection failures.
 */
async function compareSheet(photoB64, sheetB64) {
  const cells = [];
  for (const q of QUADRANTS) {
    try {
      const r = await py('/compare-identity', { image1: photoB64, image2: sheetB64, quadrant2: q });
      if (r.success && typeof r.similarity === 'number') {
        cells.push({ q, sim: r.similarity, same: r.same_person, conf: r.confidence });
      } else {
        cells.push({ q, sim: null, err: r.error || 'no face detected' });
      }
    } catch (e) {
      cells.push({ q, sim: null, err: e.message.slice(0, 90) });
    }
  }
  const ok = cells.filter(c => typeof c.sim === 'number');
  return {
    cells,
    min: ok.length ? Math.min(...ok.map(c => c.sim)) : null,
    max: ok.length ? Math.max(...ok.map(c => c.sim)) : null,
    detected: ok.length,
  };
}

/** Faces cropped from a finished page illustration, compared to the photo. */
async function comparePageFaces(photoB64, pageB64) {
  let faces = [];
  try {
    // Illustrated faces need the anime+Haar cascade; MediaPipe misses them.
    const det = await py('/detect-illustration-faces', { image: pageB64 });
    faces = det.faces || [];
  } catch (e) {
    return { error: e.message.slice(0, 90), scores: [] };
  }
  const scores = [];
  for (const f of faces.slice(0, 4)) {
    const crop = f.cropData; // padded face crop, already a data URI
    if (!crop) continue;
    try {
      const r = await py('/compare-identity', { image1: photoB64, image2: crop });
      if (r.success && typeof r.similarity === 'number') scores.push(r.similarity);
    } catch { /* a face we cannot embed is reported via detected-vs-scored counts */ }
  }
  return { faceCount: faces.length, scores };
}

(async () => {
  // Fail loudly and usefully rather than producing an empty report.
  try {
    const h = await fetch(`${PY}/health`, { signal: AbortSignal.timeout(5000) });
    if (!h.ok) throw new Error(`health ${h.status}`);
  } catch {
    console.error(`\n  Python service not reachable at ${PY}.`);
    console.error('  Start it first:  npm run dev:python\n');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: CONN, ssl: { rejectUnauthorized: false } });
  const { rows } = await pool.query(
    `SELECT id, user_id, created_at, data
       FROM characters
      WHERE data->'characters' IS NOT NULL
      ORDER BY created_at DESC
      LIMIT $1`,
    [LIMIT * 3]
  );

  const results = [];
  for (const row of rows) {
    for (const c of row.data.characters || []) {
      if (results.length >= LIMIT) break;
      const photoUrl = c.photos?.face || c.photos?.original;
      const sheetUrl = c.avatars?.standardUrl || c.avatars?.summerUrl || c.avatars?.winterUrl;
      if (!photoUrl || !sheetUrl) continue;

      // The judge's own verdict on this exact character, for side-by-side.
      const fm = c.avatars?.faceMatch || {};
      const llm = fm.standard?.score ?? fm.summer?.score ?? fm.winter?.score ?? null;

      process.stdout.write(`  ${c.name} … `);
      try {
        const [photoB64, sheetB64] = await Promise.all([toBase64(photoUrl), toBase64(sheetUrl)]);
        const sheet = await compareSheet(photoB64, sheetB64);

        let pages = null;
        if (WITH_PAGES) {
          const st = await pool.query(
            `SELECT data->'sceneImages' AS si FROM stories
              WHERE user_id = $1 AND data ? 'sceneImages'
              ORDER BY created_at DESC LIMIT 1`,
            [row.user_id]
          );
          const scenes = (st.rows[0]?.si || []).slice(0, 3);
          const perPage = [];
          for (const s of scenes) {
            const url = s.imageUrl || s.imageData;
            if (!url) continue;
            perPage.push({ page: s.pageNumber, ...(await comparePageFaces(photoB64, await toBase64(url))) });
          }
          pages = perPage;
        }

        results.push({ name: c.name, userId: row.user_id, createdAt: row.created_at, photoUrl, sheetUrl, llm, sheet, pages });
        console.log(sheet.min == null ? 'no face detected in any cell' : `arcface min=${sheet.min.toFixed(3)} max=${sheet.max.toFixed(3)} (llm ${llm ?? '-'}/10)`);
      } catch (e) {
        console.log(`FAILED — ${e.message.slice(0, 80)}`);
      }
    }
    if (results.length >= LIMIT) break;
  }
  await pool.end();

  if (!results.length) {
    console.error('\nNo characters with both a face photo and an avatar sheet were found.\n');
    process.exit(1);
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  const scored = results.filter(r => r.sheet.min != null);
  const mins = scored.map(r => r.sheet.min).sort((a, b) => a - b);
  const med = mins.length ? mins[Math.floor(mins.length / 2)] : null;

  console.log(`\n${'─'.repeat(78)}`);
  console.log(`Characters audited: ${results.length}   scored: ${scored.length}   no-face: ${results.length - scored.length}`);
  if (med != null) {
    console.log(`ArcFace cosine (worst cell): min ${mins[0].toFixed(3)}  median ${med.toFixed(3)}  max ${mins[mins.length - 1].toFixed(3)}`);
    const bands = {};
    mins.forEach(m => { bands[band(m)] = (bands[band(m)] || 0) + 1; });
    console.log(`Bands: ${JSON.stringify(bands)}`);
  }
  const withLlm = scored.filter(r => typeof r.llm === 'number');
  if (withLlm.length) {
    const llmAvg = withLlm.reduce((a, r) => a + r.llm, 0) / withLlm.length;
    const arcAvg = withLlm.reduce((a, r) => a + r.sheet.min, 0) / withLlm.length;
    console.log(`LLM judge mean ${llmAvg.toFixed(1)}/10  vs  ArcFace mean ${arcAvg.toFixed(3)} cosine`);
    console.log('Disagreements (LLM >= 8 but ArcFace weak/poor):');
    const bad = withLlm.filter(r => r.llm >= 8 && r.sheet.min < 0.45);
    console.log(bad.length ? bad.map(r => `  ${r.name}: llm ${r.llm}/10, arcface ${r.sheet.min.toFixed(3)}`).join('\n') : '  none');
  }
  console.log('─'.repeat(78));

  // ── HTML report (opened locally, never published) ─────────────────────────
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const rowsHtml = results.map(r => `
    <tr>
      <td><b>${r.name}</b><br><small>${ch(new Date(r.createdAt))}</small></td>
      <td><img src="${r.photoUrl}"></td>
      <td><img src="${r.sheetUrl}" class="sheet"></td>
      <td class="${r.sheet.min == null ? 'poor' : band(r.sheet.min)}">
        ${r.sheet.min == null ? 'no face detected' : `min <b>${r.sheet.min.toFixed(3)}</b><br>max ${r.sheet.max.toFixed(3)}<br><small>${r.sheet.detected}/4 cells</small>`}
      </td>
      <td>${r.llm == null ? '—' : `${r.llm}/10`}</td>
      <td><small>${r.sheet.cells.map(c => `${c.q}: ${c.sim != null ? c.sim.toFixed(3) : (c.err || '—')}`).join('<br>')}</small></td>
      <td><small>${!r.pages ? '—' : r.pages.map(p => `p${p.page}: ${p.scores?.length ? p.scores.map(s => s.toFixed(3)).join(', ') : (p.error || 'no face')}`).join('<br>')}</small></td>
    </tr>`).join('');

  fs.writeFileSync(OUT, `<!doctype html><meta charset="utf-8">
<title>Avatar likeness audit</title>
<style>
 body{font:14px/1.5 system-ui;margin:24px;color:#222}
 h1{font-size:20px} table{border-collapse:collapse;width:100%}
 td,th{border:1px solid #ddd;padding:8px;vertical-align:top;text-align:left}
 th{background:#f5f5f5}
 img{max-width:130px;border-radius:6px} img.sheet{max-width:220px}
 .strong{background:#dcfce7}.good{background:#ecfccb}.weak{background:#fef3c7}.poor{background:#fee2e2}
 .note{background:#f8fafc;border-left:3px solid #6366f1;padding:10px 14px;margin-bottom:18px}
</style>
<h1>Avatar likeness audit — ArcFace vs. the LLM judge</h1>
<div class="note">
 ArcFace cosine is style-invariant and independent of the pipeline's own scoring.
 <b>min</b> is the worst of the four sheet cells — the same statistic the LLM judge
 reports as <code>sourceMatchScore</code>, so the two columns are directly comparable.
 Bands (strong ≥0.60, good ≥0.45, weak ≥0.30, poor) rank characters; they are not a
 same-person verdict, since photo-vs-illustration sits below DeepFace's photo-only threshold.
 Generated ${ch(new Date())} · db=${DB} · ${results.length} characters.
</div>
<table>
 <tr><th>Character</th><th>Source photo</th><th>Avatar sheet</th><th>ArcFace</th><th>LLM judge</th><th>Per cell</th><th>Page faces</th></tr>
 ${rowsHtml}
</table>`);

  console.log(`\nReport: ${OUT}\n`);
})();
