/**
 * Dump retryHistory for one scene, including mask data references.
 *
 *   node scripts/analysis/dump-page-history.js <storyId> <pageNum> [outDir]
 *
 * Saves any base64 image/mask payloads to outDir/ as PNGs and prints metadata.
 */
require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

async function main() {
  const storyId = process.argv[2];
  const pageNum = parseInt(process.argv[3], 10);
  const outDir = process.argv[4] || path.join('tests', 'fixtures', 'page-history', `${storyId}-p${pageNum}`);
  if (!storyId || !pageNum) {
    console.error('Usage: node scripts/analysis/dump-page-history.js <storyId> <pageNum> [outDir]');
    process.exit(1);
  }
  fs.mkdirSync(outDir, { recursive: true });

  const pool = new Pool({
    connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  const r = await pool.query('SELECT data FROM stories WHERE id = $1', [storyId]);
  if (r.rows.length === 0) { console.error('Story not found'); await pool.end(); process.exit(1); }
  const d = r.rows[0].data || {};
  const scene = (d.sceneImages || []).find(s => s.pageNumber === pageNum);
  if (!scene) { console.error(`Page ${pageNum} not found`); await pool.end(); process.exit(1); }

  const rh = scene.retryHistory || [];
  console.log(`retryHistory: ${rh.length} entries\n`);

  // Top-level keys on the scene that look like masks/textRect/etc
  const sceneTopMaskKeys = Object.keys(scene).filter(k => /mask|rect|wash|textArea|overlay/i.test(k));
  if (sceneTopMaskKeys.length > 0) {
    console.log('Scene top-level mask-ish keys:', sceneTopMaskKeys);
  }

  for (const [i, h] of rh.entries()) {
    console.log(`\n========== [${i}] ${h.source || h.type || '?'} ==========`);
    const keys = Object.keys(h);
    console.log('keys:', keys.join(', '));
    for (const k of keys) {
      const v = h[k];
      if (v == null) continue;
      if (typeof v === 'string' && v.length > 200 && /^([A-Za-z0-9+/=]|data:image)/.test(v)) {
        // Looks like base64 — save it
        const ext = v.startsWith('data:image/jpeg') ? 'jpg' : 'png';
        const fname = `${i}_${h.source || h.type || 'x'}_${k}.${ext}`;
        const cleanPath = path.join(outDir, fname);
        const b64 = v.includes('base64,') ? v.split('base64,')[1] : v;
        try {
          fs.writeFileSync(cleanPath, Buffer.from(b64, 'base64'));
          console.log(`  ${k}: saved → ${cleanPath} (${(b64.length * 0.75 / 1024).toFixed(0)} KB)`);
        } catch (e) {
          console.log(`  ${k}: failed to save: ${e.message}`);
        }
      } else if (typeof v === 'string' && v.length > 200) {
        console.log(`  ${k}: <${v.length}-char string> ${v.substring(0, 80)}...`);
      } else if (typeof v === 'object') {
        console.log(`  ${k}:`, JSON.stringify(v).substring(0, 300));
      } else {
        console.log(`  ${k}:`, v);
      }
    }
  }

  await pool.end();
}
main().catch(e => { console.error(e); process.exit(1); });
