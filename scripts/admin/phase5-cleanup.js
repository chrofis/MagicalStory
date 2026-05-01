#!/usr/bin/env node
/**
 * Phase 5 cleanup — null residual inline base64 fields that the new URL-only
 * writers should never produce. Scope:
 *
 *   1. characters.data — avatars.{standard,summer,winter} where the *Url
 *      sibling is set (residual dual-write from new stories generated before
 *      writers were patched, plus anything the old code path missed).
 *   2. characters.data — avatars.{face,body}Thumbnails.{slot} where the
 *      matching *ThumbnailsUrl[slot] is set.
 *   3. stories.data — visualBible.*[].referenceImageData where the entry
 *      also has referenceImageUrl set.
 *   4. stories.data — sceneImages[].imageData (vestigial — no read path
 *      uses this field; story_images table is the source of truth).
 *
 * SAFETY: --dry-run by default. Pass --apply to write.
 */

require('dotenv').config();
const { Pool } = require('pg');

const args = process.argv.slice(2);
const DRY_RUN = !args.includes('--apply');
const tag = DRY_RUN ? '[DRY RUN] ' : '[APPLY] ';

const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
const pool = new Pool({
  connectionString: url,
  ssl: url.includes('railway') || url.includes('proxy') ? { rejectUnauthorized: false } : false,
});

async function cleanCharacters() {
  console.log(`${tag}=== CHARACTERS table ===`);
  const { rows } = await pool.query('SELECT id, data FROM characters WHERE data IS NOT NULL');
  let totalSlotNulls = 0, totalThumbNulls = 0, rowsUpdated = 0, bytesFreed = 0;
  for (const row of rows) {
    const data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
    const chars = Array.isArray(data?.characters) ? data.characters : [];
    let changed = false;
    let perRowSlots = 0, perRowThumbs = 0, perRowBytes = 0;
    for (const c of chars) {
      const a = c?.avatars; if (!a || typeof a !== 'object') continue;
      // Base slots
      for (const slot of ['standard', 'summer', 'winter']) {
        const inline = a[slot];
        const url = a[`${slot}Url`];
        if (typeof inline === 'string' && inline.length > 100 && url) {
          perRowBytes += Math.floor(inline.length * 3 / 4);
          if (!DRY_RUN) a[slot] = null;
          perRowSlots++;
          changed = true;
        }
      }
      // Thumbnails
      for (const kind of ['face', 'body']) {
        const tk = `${kind}Thumbnails`;
        const uk = `${kind}ThumbnailsUrl`;
        const thumbs = a[tk]; const urls = a[uk];
        if (!thumbs || typeof thumbs !== 'object' || !urls) continue;
        for (const slot of Object.keys(thumbs)) {
          if (typeof thumbs[slot] === 'string' && thumbs[slot].length > 100 && urls[slot]) {
            perRowBytes += Math.floor(thumbs[slot].length * 3 / 4);
            if (!DRY_RUN) thumbs[slot] = null;
            perRowThumbs++;
            changed = true;
          }
        }
      }
    }
    if (changed) {
      console.log(`${tag}row ${row.id}: ${perRowSlots} slot nulls, ${perRowThumbs} thumb nulls, ${(perRowBytes/1024).toFixed(0)}KB freed`);
      totalSlotNulls += perRowSlots;
      totalThumbNulls += perRowThumbs;
      bytesFreed += perRowBytes;
      if (!DRY_RUN) {
        await pool.query('UPDATE characters SET data = $1 WHERE id = $2', [data, row.id]);
        rowsUpdated++;
      }
    }
  }
  console.log(`${tag}--- chars summary: ${rowsUpdated} rows updated, ${totalSlotNulls} slot nulls, ${totalThumbNulls} thumb nulls, ${(bytesFreed/1024/1024).toFixed(1)}MB ---`);
}

async function cleanVbAndScenes() {
  console.log(`${tag}=== STORIES table (VB + sceneImages vestigial) ===`);
  // Stream story IDs first to keep memory bounded
  const { rows: ids } = await pool.query('SELECT id FROM stories ORDER BY id');
  console.log(`${tag}Streaming ${ids.length} story rows`);
  let totalVbNulls = 0, totalSceneNulls = 0, rowsUpdated = 0, bytesFreed = 0;
  const vbCats = ['secondaryCharacters', 'animals', 'artifacts', 'locations', 'vehicles', 'clothing'];
  for (const { id } of ids) {
    const r = await pool.query('SELECT data FROM stories WHERE id = $1', [id]);
    if (!r.rows.length) continue;
    const data = typeof r.rows[0].data === 'string' ? JSON.parse(r.rows[0].data) : r.rows[0].data;
    let changed = false;
    let vbN = 0, scN = 0, by = 0;
    // VB cleanup
    const vb = data?.visualBible;
    if (vb) {
      for (const cat of vbCats) {
        const arr = vb[cat]; if (!Array.isArray(arr)) continue;
        for (const e of arr) {
          if (e?.referenceImageUrl && typeof e.referenceImageData === 'string' && e.referenceImageData.length > 100) {
            by += Math.floor(e.referenceImageData.length * 3 / 4);
            if (!DRY_RUN) e.referenceImageData = null;
            vbN++; changed = true;
          }
        }
      }
    }
    // sceneImages[].imageData vestigial cleanup
    const scenes = data?.sceneImages;
    if (Array.isArray(scenes)) {
      for (const s of scenes) {
        if (typeof s?.imageData === 'string' && s.imageData.length > 100) {
          by += Math.floor(s.imageData.length * 3 / 4);
          if (!DRY_RUN) delete s.imageData;
          scN++; changed = true;
        }
      }
    }
    if (changed) {
      console.log(`${tag}story ${id}: ${vbN} VB nulls, ${scN} scene nulls, ${(by/1024).toFixed(0)}KB freed`);
      totalVbNulls += vbN; totalSceneNulls += scN; bytesFreed += by;
      if (!DRY_RUN) {
        await pool.query('UPDATE stories SET data = $1 WHERE id = $2', [data, id]);
        rowsUpdated++;
      }
    }
  }
  console.log(`${tag}--- stories summary: ${rowsUpdated} rows updated, ${totalVbNulls} VB nulls, ${totalSceneNulls} scene nulls, ${(bytesFreed/1024/1024).toFixed(1)}MB ---`);
}

(async () => {
  console.log(`${tag}Phase 5 cleanup starting (apply=${!DRY_RUN})`);
  await cleanCharacters();
  await cleanVbAndScenes();
  await pool.end();
  console.log(`${tag}DONE.`);
})().catch(e => { console.error(e); process.exit(1); });
