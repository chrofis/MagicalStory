#!/usr/bin/env node
/**
 * Copy ONE story (stories row + story_images rows) from prod into staging.
 *
 * Used to bring a real story into the staging DB for Test Lab experiments
 * (image bytes stay as R2 URLs — both environments read the same bucket).
 * Sharing is stripped (is_shared=false, share_token=null). The user row is
 * NOT copied — admin read access doesn't need it.
 *
 * Usage: node scripts/admin/copy-story-to-staging.js <storyId>
 */
'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
const { Pool } = require('pg');

const storyId = process.argv[2];
if (!storyId) { console.error('Usage: node copy-story-to-staging.js <storyId>'); process.exit(1); }

const srcUrl = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
const dstUrl = process.env.STAGING_DATABASE_URL;
if (!srcUrl || !dstUrl) { console.error('Need DATABASE_URL (prod) and STAGING_DATABASE_URL in .env'); process.exit(1); }

const host = (u) => { const x = new URL(u); return `${x.hostname}:${x.port}/${x.pathname}`; };
if (host(srcUrl) === host(dstUrl)) { console.error('REFUSED: source and target are the same DB'); process.exit(1); }

(async () => {
  const src = new Pool({ connectionString: srcUrl, ssl: { rejectUnauthorized: false } });
  const dst = new Pool({ connectionString: dstUrl, ssl: { rejectUnauthorized: false } });

  const s = await src.query('SELECT * FROM stories WHERE id = $1', [storyId]);
  if (s.rows.length === 0) { console.error(`Story ${storyId} not found in prod`); process.exit(1); }
  const story = s.rows[0];

  await dst.query(
    `INSERT INTO stories (id, user_id, data, metadata, is_shared, share_token, image_version_meta, created_at)
     VALUES ($1, $2, $3, $4, FALSE, NULL, $5, $6)
     ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, metadata = EXCLUDED.metadata,
       image_version_meta = EXCLUDED.image_version_meta`,
    [story.id, story.user_id, story.data, story.metadata, story.image_version_meta, story.created_at]
  );
  console.log(`✅ stories row copied (${(JSON.stringify(story.data).length / 1024 / 1024).toFixed(1)}MB data)`);

  const imgs = await src.query(
    `SELECT image_type, page_number, version_index, image_data, image_url, quality_score, generated_at
     FROM story_images WHERE story_id = $1`, [storyId]);
  await dst.query('DELETE FROM story_images WHERE story_id = $1', [storyId]);
  let copied = 0;
  for (const r of imgs.rows) {
    await dst.query(
      `INSERT INTO story_images (story_id, image_type, page_number, version_index, image_data, image_url, quality_score, generated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [storyId, r.image_type, r.page_number, r.version_index, r.image_data, r.image_url, r.quality_score, r.generated_at]
    );
    copied++;
  }
  console.log(`✅ ${copied} story_images rows copied (R2 URLs)`);
  await src.end(); await dst.end();
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });
