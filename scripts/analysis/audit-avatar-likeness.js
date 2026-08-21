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
const INCLUDE_DEMO = args.includes('--include-demo');
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

// The 2x2 sheet is: top row = HEAD views (front, 3/4), bottom row = FULL BODY
// (front, profile). Only the top row is a face comparison — in a full-body cell
// the head is a small fraction of a 360x640 crop, so whatever ArcFace returns
// there is dominated by torso and background, not identity. Bottom cells are
// therefore excluded; --all-cells re-enables them for inspection only.
const HEAD_QUADRANTS = ['top-left', 'top-right'];
const ALL_QUADRANTS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
const QUADRANTS = process.argv.includes('--all-cells') ? ALL_QUADRANTS : HEAD_QUADRANTS;

/**
 * Compare the source photo against all four cells of an avatar sheet.
 *
 * Only the two HEAD cells are compared (see QUADRANTS). Two separate traps live
 * in the bottom row: the head is tiny inside a 360x640 full-body crop, and the
 * profile view cannot be embedded by a frontal-biased model at all (measured
 * 0.028 on a sheet whose head cells scored 0.79 and 0.70).
 *
 * MIN across cells is therefore meaningless here even though the LLM judge uses
 * one — the judge understands that a profile is supposed to look like a profile.
 * The reportable statistic is BEST across the head views, with `second` as the
 * corroborating view.
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
  const sims = ok.map(c => c.sim);
  const winner = ok.length ? ok.reduce((a, b) => (b.sim > a.sim ? b : a)) : null;
  return {
    cells,
    bestQuadrant: winner?.q || null,
    best: sims.length ? Math.max(...sims) : null,
    // Second-best: guards against a single lucky cell. A genuinely good sheet
    // has at least two frontal-ish views matching.
    second: sims.length > 1 ? sims.sort((a, b) => b - a)[1] : null,
    worst: sims.length ? Math.min(...sims) : null,
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
  // Demo-family characters are generated portraits, not real photographs, so
  // an avatar built from one is an easy case and will flatter the numbers.
  // They are labelled, and excluded entirely unless --include-demo is passed.
  const { rows } = await pool.query(
    `SELECT c.id, c.user_id, c.created_at, c.data, u.email, u.is_trial
       FROM characters c
       JOIN users u ON u.id = c.user_id
      WHERE c.data->'characters' IS NOT NULL
      ORDER BY c.created_at DESC
      LIMIT $1`,
    [LIMIT * 8]
  );

  const results = [];
  for (const row of rows) {
    const isDemo = /^(demo|test)[-.]|@example\./i.test(row.email || '');
    if (isDemo && !INCLUDE_DEMO) continue;
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
          // Page bytes live in story_images (R2 URL in image_url), NOT in
          // stories.data.sceneImages — those entries carry metadata only.
          // We take the HIGHEST version_index per page: these stories carry no
          // activeVersion pin, and repairs append, so the last version is the
          // one a reader ends up seeing. Labelled "latest" rather than
          // "active" because that is what it actually is.
          const st = await pool.query(
            `SELECT DISTINCT ON (si.page_number) si.page_number, si.image_url
               FROM story_images si
               JOIN stories s ON s.id = si.story_id
              WHERE s.user_id = $1
                AND si.image_type = 'scene'
                AND si.image_url IS NOT NULL
              ORDER BY si.page_number, si.version_index DESC
              LIMIT 3`,
            [row.user_id]
          );
          const perPage = [];
          for (const s of st.rows) {
            perPage.push({ page: s.page_number, ...(await comparePageFaces(photoB64, await toBase64(s.image_url))) });
          }
          pages = perPage;
        }

        results.push({ name: c.name, userId: row.user_id, createdAt: row.created_at, isDemo, email: row.email, photoUrl, sheetUrl, llm, sheet, pages });
        console.log(sheet.best == null
          ? 'no face detected in any cell'
          : `arcface best=${sheet.best.toFixed(3)} 2nd=${sheet.second?.toFixed(3) ?? '-'} (llm ${llm ?? '-'}/10)`);
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
  const scored = results.filter(r => r.sheet.best != null);
  const bests = scored.map(r => r.sheet.best).sort((a, b) => a - b);
  const med = bests.length ? bests[Math.floor(bests.length / 2)] : null;

  console.log(`\n${'─'.repeat(78)}`);
  console.log(`Characters audited: ${results.length}   scored: ${scored.length}   no-face: ${results.length - scored.length}`);
  console.log(`Demo/test accounts: ${results.filter(r => r.isDemo).length}   real users: ${results.filter(r => !r.isDemo).length}`);
  if (med != null) {
    console.log(`ArcFace cosine (BEST view): min ${bests[0].toFixed(3)}  median ${med.toFixed(3)}  max ${bests[bests.length - 1].toFixed(3)}`);
    const bands = {};
    bests.forEach(m => { bands[band(m)] = (bands[band(m)] || 0) + 1; });
    console.log(`Bands: ${JSON.stringify(bands)}`);
  }
  const withLlm = scored.filter(r => typeof r.llm === 'number');
  if (withLlm.length) {
    const llmAvg = withLlm.reduce((a, r) => a + r.llm, 0) / withLlm.length;
    const arcAvg = withLlm.reduce((a, r) => a + r.sheet.best, 0) / withLlm.length;
    console.log(`LLM judge mean ${llmAvg.toFixed(1)}/10  vs  ArcFace mean ${arcAvg.toFixed(3)} cosine (best view)`);
    console.log('Disagreements (LLM >= 8 but ArcFace weak/poor on its BEST view):');
    const bad = withLlm.filter(r => r.llm >= 8 && r.sheet.best < 0.45);
    console.log(bad.length
      ? bad.map(r => `  ${r.name}${r.isDemo ? ' [demo]' : ''}: llm ${r.llm}/10, arcface ${r.sheet.best.toFixed(3)}`).join('\n')
      : '  none');
  }
  console.log('─'.repeat(78));

  // ── HTML report (opened locally, never published) ─────────────────────────
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  // Raw results, so a curated view (best/average/worst buckets) can be built
  // without paying for the ArcFace pass again.
  fs.writeFileSync(OUT.replace(/\.html$/, '.json'), JSON.stringify(results, null, 2));
  const rowsHtml = results.map(r => `
    <tr>
      <td><b>${r.name}</b>${r.isDemo ? ' <small>[demo]</small>' : ''}<br><small>${ch(new Date(r.createdAt))}</small></td>
      <td><img src="${r.photoUrl}"></td>
      <td><img src="${r.sheetUrl}" class="sheet"></td>
      <td class="${r.sheet.best == null ? 'poor' : band(r.sheet.best)}">
        ${r.sheet.best == null ? 'no face detected' : `best <b>${r.sheet.best.toFixed(3)}</b><br>2nd ${r.sheet.second?.toFixed(3) ?? '—'}<br><small>worst ${r.sheet.worst.toFixed(3)} (profile view)</small>`}
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
 The four sheet cells are <b>views</b> (front headshot, ¾ headshot, full-body front,
 full-body profile). ArcFace cannot embed a pure side profile, so that cell lands near
 0.03 however good the likeness is — <b>the worst-cell figure is noise here</b>, even
 though the LLM judge's <code>sourceMatchScore</code> is a min. The reportable number is
 <b>best</b>, the strongest-matching view, with <b>2nd</b> as the guard against one lucky cell.
 Bands (strong ≥0.60, good ≥0.45, weak ≥0.30, poor) rank characters; they are not a
 same-person verdict.
 Generated ${ch(new Date())} · db=${DB} · ${results.length} characters.
</div>
<table>
 <tr><th>Character</th><th>Source photo</th><th>Avatar sheet</th><th>ArcFace</th><th>LLM judge</th><th>Per cell</th><th>Page faces</th></tr>
 ${rowsHtml}
</table>`);

  console.log(`\nReport: ${OUT}\n`);
})();
