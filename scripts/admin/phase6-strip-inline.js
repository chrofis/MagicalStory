#!/usr/bin/env node
/**
 * Phase 6 cleanup — strip every inline base64 payload from existing
 * stories.data using the same sanitizer that saveStoryData / saveScenePageData
 * now run on every write. Reclaims the historical bloat (entity grids,
 * sceneCharacters snapshots, grokRefImages, debug overlays, finalChecksReport
 * comparison images, styledAvatarGeneration debug, top-level character
 * snapshot photos+avatars).
 *
 * Source of truth lives in characters table (avatars/photos), story_images
 * (scene/cover bytes), and R2 (URLs). Everything stripped here is debug
 * data or duplicates the canonical row.
 *
 * --dry-run is the default. Pass --apply to write.
 */

require('dotenv').config();
const { Pool } = require('pg');
const { stripInlineImagesFromStoryData } = require('../../server/services/database');

const args = process.argv.slice(2);
const DRY_RUN = !args.includes('--apply');
const tag = DRY_RUN ? '[DRY RUN] ' : '[APPLY] ';

const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
const pool = new Pool({
  connectionString: url,
  ssl: url.includes('railway') || url.includes('proxy') ? { rejectUnauthorized: false } : false,
});

(async () => {
  console.log(`${tag}Phase 6 cleanup starting (apply=${!DRY_RUN})`);

  const { rows: ids } = await pool.query('SELECT id FROM stories ORDER BY id');
  console.log(`${tag}Streaming ${ids.length} story rows`);

  let totalUpdated = 0, totalBefore = 0, totalAfter = 0;

  for (const { id } of ids) {
    const r = await pool.query('SELECT data FROM stories WHERE id = $1', [id]);
    if (!r.rows.length) continue;
    const data = typeof r.rows[0].data === 'string' ? JSON.parse(r.rows[0].data) : r.rows[0].data;

    const beforeBytes = JSON.stringify(data).length;
    stripInlineImagesFromStoryData(data);
    const afterBytes = JSON.stringify(data).length;
    const freed = beforeBytes - afterBytes;

    if (freed <= 0) continue;

    console.log(`${tag}story ${id}: ${(beforeBytes/1024/1024).toFixed(1)}MB → ${(afterBytes/1024/1024).toFixed(1)}MB (-${(freed/1024/1024).toFixed(1)}MB)`);
    totalBefore += beforeBytes;
    totalAfter += afterBytes;

    if (!DRY_RUN) {
      await pool.query('UPDATE stories SET data = $1 WHERE id = $2', [JSON.stringify(data), id]);
      totalUpdated++;
    }
  }

  console.log(`${tag}--- summary: ${totalUpdated} rows updated, before=${(totalBefore/1024/1024).toFixed(0)}MB after=${(totalAfter/1024/1024).toFixed(0)}MB freed=${((totalBefore-totalAfter)/1024/1024).toFixed(0)}MB ---`);
  await pool.end();
  console.log(`${tag}DONE.`);
})().catch(e => { console.error(e); process.exit(1); });
