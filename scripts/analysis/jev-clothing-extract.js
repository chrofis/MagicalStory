#!/usr/bin/env node
/**
 * Extract for the Jev clothing-check measurement (2026-10-09): every stored staging page that has a
 * reference photo with a clothing description, with the prose the image prompt builder checks
 * (stripSceneMetadata(sceneDescription)). The old clothingCheck.missingGarments answer (`old`) was
 * added to the 2026-10-09 cases.json when that function still existed (commit 95f5b843d); it was deleted
 * with the switch to Jev, so a fresh extract has no `old` and the eval skips the comparison.
 *   node scripts/analysis/jev-clothing-extract.js
 * Output (gitignored, local): evals/runs/2026-10-09_jev-clothing/cases.json
 */
const path = require('path'); const fs = require('fs');
const ROOT = path.join(__dirname, '../..');
require('dotenv').config({ path: path.join(ROOT, '.env') });
const { stripSceneMetadata } = require('../../server/lib/sceneMetadata');
const OUT = path.join(ROOT, 'evals/runs/2026-10-09_jev-clothing');
(async () => {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.STAGING_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const ids = (await pool.query(`SELECT id, created_at FROM stories WHERE data ? 'sceneImages' ORDER BY created_at DESC LIMIT 120`)).rows;
  const cases = [];
  for (const { id, created_at } of ids) {
    const r = await pool.query(`SELECT data->'sceneImages' si, data->>'language' lang FROM stories WHERE id=$1`, [id]);
    for (const p of r.rows[0].si || []) {
      if (!p.sceneDescription || !Array.isArray(p.referencePhotos)) continue;
      let prose;
      try { prose = stripSceneMetadata(p.sceneDescription); } catch (e) { continue; }
      for (const ph of p.referencePhotos) {
        if (!ph?.name || !ph?.clothingDescription) continue;
        cases.push({
          sid: id.slice(-9), date: created_at.toISOString().slice(0, 10), page: p.pageNumber, name: ph.name,
          category: ph.clothingCategory, outfit: ph.clothingDescription, prose: String(prose || ''),
        });
      }
    }
  }
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'cases.json'), JSON.stringify(cases));
  const costumed = cases.filter(c => /costum/.test(c.category || ''));
  console.log('stories', ids.length, 'cases', cases.length, 'costumed', costumed.length,
    '');
  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
