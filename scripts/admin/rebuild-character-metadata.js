#!/usr/bin/env node
/**
 * Rebuild characters.metadata column from data column.
 *
 * The metadata column is a stripped-down snapshot used by /api/characters
 * for fast loading. It was originally written with inline base64 in
 * faceThumbnails.{slot}. After Phase 4 nulled inline data and Phase 5
 * switched writers to URL-only, existing metadata rows still hold either
 * stale inline base64 (works visually but doesn't reflect current state)
 * or have no thumbnail field at all (Lukas case).
 *
 * This script rebuilds metadata from the live data column using the new
 * URL-aware light format: faceThumbnails.standard now holds the R2 URL
 * directly so the frontend <img src> works without code changes.
 *
 * --dry-run is the default; --apply to write.
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

function buildLightCharacter(c) {
  const { body_no_bg_url, body_photo_url, photo_url, thumbnail_url,
          clothing_avatars, photos, styledAvatars, costumedAvatars, ...light } = c;
  if (light.avatars) {
    const a = light.avatars;
    const stdFace = a.faceThumbnails?.standard || a.faceThumbnailsUrl?.standard;
    const stdBody = a.bodyThumbnails?.standard || a.bodyThumbnailsUrl?.standard;
    const hasFull = !!(a.winter || a.standard || a.summer || a.winterUrl || a.standardUrl || a.summerUrl);
    light.avatars = {
      status: a.status || 'complete',
      stale: a.stale || false,
      generatedAt: a.generatedAt,
      hasFullAvatars: hasFull,
      faceThumbnails: stdFace ? { standard: stdFace } : undefined,
      bodyThumbnails: stdBody ? { standard: stdBody } : undefined,
      clothing: a.clothing,
    };
  }
  return light;
}

(async () => {
  const { rows } = await pool.query('SELECT id, data FROM characters WHERE data IS NOT NULL ORDER BY id');
  console.log(`${tag}Found ${rows.length} character rows`);
  let updated = 0, skipped = 0;
  for (const row of rows) {
    const data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
    const chars = Array.isArray(data) ? data : (data?.characters || []);
    if (chars.length === 0) { skipped++; continue; }
    const lightChars = chars.map(buildLightCharacter);
    const newMeta = Array.isArray(data) ? lightChars : { ...data, characters: lightChars };
    // Strip heavy fields from non-character data parts
    delete newMeta.tokenUsage;
    delete newMeta.faceMatch;
    delete newMeta.rawEvaluation;
    const metaSize = JSON.stringify(newMeta).length;
    const charsWithThumbs = lightChars.filter(c => c.avatars?.faceThumbnails?.standard).length;
    console.log(`${tag}row ${row.id}: ${chars.length} chars (${charsWithThumbs} with face thumb), meta size: ${(metaSize/1024).toFixed(0)}KB`);
    if (!DRY_RUN) {
      await pool.query('UPDATE characters SET metadata = $1 WHERE id = $2', [JSON.stringify(newMeta), row.id]);
      updated++;
    }
  }
  console.log(`${tag}--- summary: ${updated} rows updated, ${skipped} skipped ---`);
  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
