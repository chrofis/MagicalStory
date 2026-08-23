#!/usr/bin/env node
/**
 * Copy ONE story (stories row + story_images rows) from prod into staging.
 *
 * Used to bring a real story into the staging DB for Test Lab experiments
 * (image bytes stay as R2 URLs — both environments read the same bucket).
 * Sharing is stripped (is_shared=false, share_token=null). The user row is
 * NOT copied — admin read access doesn't need it.
 *
 * Also copies the OWNER'S CHARACTER ROW, so avatar-level fixes (regenerate a
 * sheet, restyle) work on staging instead of failing on a missing character —
 * stories.data carries a snapshot, but the avatar endpoints read the table.
 *
 * Stamps provenance (source hash + timestamp) into the staging copy's metadata.
 * promote-story-to-prod.js checks it to prove production has not changed since
 * the pull; without it, promoting could silently discard a user's later edit.
 *
 * Usage: node scripts/admin/copy-story-to-staging.js <storyId>
 * Return leg: node scripts/admin/promote-story-to-prod.js <storyId> --yes
 */
'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
const { Pool } = require('pg');
const crypto = require('crypto');

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

  // Provenance for the return leg: the hash of the data we are copying. If
  // production's data no longer hashes to this when we promote, someone changed
  // the story in the meantime and promoting would throw their change away.
  const srcSha = crypto.createHash('sha256').update(JSON.stringify(story.data ?? null)).digest('hex').slice(0, 16);
  const metaWithProvenance = {
    ...(story.metadata || {}),
    promotedFrom: { env: 'prod', srcSha, pulledAt: new Date().toISOString(), userId: story.user_id },
  };

  await dst.query(
    `INSERT INTO stories (id, user_id, data, metadata, is_shared, share_token, image_version_meta, created_at)
     VALUES ($1, $2, $3, $4, FALSE, NULL, $5, $6)
     ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, metadata = EXCLUDED.metadata,
       image_version_meta = EXCLUDED.image_version_meta`,
    [story.id, story.user_id, story.data, metaWithProvenance, story.image_version_meta, story.created_at]
  );
  console.log(`   provenance: srcSha=${srcSha} (checked on promote)`);
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

  // Character row — avatar regeneration reads the TABLE, not the story snapshot.
  const charId = `characters_${story.user_id}`;
  const ch = await src.query('SELECT * FROM characters WHERE id = $1', [charId]);
  if (ch.rows.length) {
    const c = ch.rows[0];
    await dst.query(
      `INSERT INTO characters (id, user_id, data, metadata, created_at)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, metadata = EXCLUDED.metadata`,
      [c.id, c.user_id, c.data, c.metadata, c.created_at]
    );
    const names = (c.data?.characters || []).map((x) => x.name).join(', ');
    console.log(`✅ characters row copied (${names || 'no names'})`);
  } else {
    console.log(`ℹ️  no characters row for user ${story.user_id} — avatar-level fixes will not work on staging`);
  }

  console.log(`
Next: fix/rerun on staging, then`);
  console.log(`  node scripts/admin/promote-story-to-prod.js ${storyId} --dry-run`);
  await src.end(); await dst.end();
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });
