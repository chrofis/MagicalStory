/**
 * Migrate inline base64 character photos + styled avatars on the characters
 * table to R2. Each row in `characters` is keyed by user, with `data.characters[]`
 * holding the per-character objects. We walk every char and migrate:
 *
 *   c.photos.{original, face, body, bodyNoBg}
 *   c.avatars.styledAvatars.{art-style}.{clothing or costumed.{name}}
 *
 * Bare-string base64 → R2 URL string. After migration the inline bytes are
 * gone; readers (storyHelpers, characterPhotos.js, entityConsistency) already
 * handle URL form via r2.bytesFromAnyImage / extractUrl / resolveStyled.
 *
 * Run from inside Railway:
 *   railway ssh "node --max-old-space-size=4096 scripts/admin/backfill-character-photos.js [--dry] [--limit=N]"
 *
 * Idempotent. Sets `data.r2BackfilledAt` after each successful row save.
 */

require('dotenv').config();
process.env.STORAGE_MODE = process.env.STORAGE_MODE || 'database';
const { Pool } = require('pg');

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const LIMIT = (() => {
  const a = args.find(a => a.startsWith('--limit='));
  return a ? parseInt(a.split('=')[1], 10) : null;
})();
const SLEEP_MS = 100;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const r2 = require('../../server/lib/r2');
  if (!r2.isConfigured()) {
    console.error('FATAL: R2 not configured');
    process.exit(1);
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL?.includes('railway.app') ? { rejectUnauthorized: false } : false,
  });

  const looksLikeBytes = (s) =>
    typeof s === 'string'
    && (s.startsWith('data:image/') || s.startsWith('/9j/') || s.startsWith('iVBORw0') || s.startsWith('R0lGOD'))
    && s.length > 1024;

  const limitClause = LIMIT ? ` LIMIT ${LIMIT}` : '';
  const candidates = await pool.query(
    `SELECT id, user_id, pg_column_size(data) AS bytes
     FROM characters
     WHERE pg_column_size(data) > 1048576
       AND NOT (data ? 'r2BackfilledAt')
     ORDER BY pg_column_size(data) DESC${limitClause}`
  );

  console.log(`[backfill-chars] candidates: ${candidates.rows.length} rows`);
  if (candidates.rows.length === 0) {
    await pool.end();
    return;
  }

  if (DRY) {
    for (const row of candidates.rows) {
      console.log(`  ${row.id}  ${Math.round(row.bytes / 1024)} KB`);
    }
    await pool.end();
    return;
  }

  let totalReclaimed = 0;
  let processed = 0;
  let failed = 0;
  const startTime = Date.now();

  for (let i = 0; i < candidates.rows.length; i++) {
    const { id: rowId, user_id, bytes: beforeBytes } = candidates.rows[i];
    process.stdout.write(`[${i + 1}/${candidates.rows.length}] ${rowId} (${Math.round(beforeBytes / 1024)} KB) … `);

    try {
      const r = await pool.query("SELECT data FROM characters WHERE id = $1", [rowId]);
      if (r.rows.length === 0) { process.stdout.write('GONE\n'); continue; }
      const data = r.rows[0].data;
      const userId = user_id;

      // Build an upload-task list synchronously, then drain in parallel.
      const tasks = [];
      const queue = (input, key, apply) => {
        if (looksLikeBytes(input)) tasks.push({ input, key, apply });
      };

      const chars = Array.isArray(data.characters) ? data.characters : [];
      for (const c of chars) {
        if (!c || typeof c !== 'object') continue;
        const charId = c.id || c.name || 'unknown';

        // photos.{original, face, body, bodyNoBg}
        if (c.photos && typeof c.photos === 'object') {
          for (const slot of ['original', 'face', 'body', 'bodyNoBg']) {
            const v = c.photos[slot];
            if (typeof v === 'string') {
              queue(v, r2.keyForUserCharacterPhoto(userId, charId, slot), (url) => {
                c.photos[slot] = url;
              });
            } else if (v && typeof v === 'object' && typeof v.imageData === 'string') {
              queue(v.imageData, r2.keyForUserCharacterPhoto(userId, charId, slot), (url) => {
                c.photos[slot] = { imageUrl: url };
              });
            }
          }
        }

        // avatars.styledAvatars.{art}.{clothing | costumed.{name}}
        if (c.avatars?.styledAvatars && typeof c.avatars.styledAvatars === 'object') {
          for (const [artStyle, perArt] of Object.entries(c.avatars.styledAvatars)) {
            if (!perArt || typeof perArt !== 'object') continue;
            for (const [clothing, slot] of Object.entries(perArt)) {
              if (!slot) continue;
              if (clothing === 'costumed' && typeof slot === 'object' && !Array.isArray(slot)) {
                for (const [name, val] of Object.entries(slot)) {
                  const inline = (typeof val === 'string')
                    ? val
                    : (val && typeof val === 'object' && typeof val.imageData === 'string') ? val.imageData : null;
                  if (!inline) continue;
                  queue(inline, r2.keyForCharacterStyledAvatar(userId, charId, `${artStyle}-costumed-${name}`), (url) => {
                    slot[name] = { imageUrl: url };
                  });
                }
              } else {
                const inline = (typeof slot === 'string')
                  ? slot
                  : (slot && typeof slot === 'object' && typeof slot.imageData === 'string') ? slot.imageData : null;
                if (!inline) continue;
                queue(inline, r2.keyForCharacterStyledAvatar(userId, charId, `${artStyle}-${clothing}`), (url) => {
                  perArt[clothing] = { imageUrl: url };
                });
              }
            }
          }
        }

        // Plain avatars (standard/summer/winter/formal) — only if still inline
        if (c.avatars && typeof c.avatars === 'object') {
          for (const slot of ['standard', 'summer', 'winter', 'formal']) {
            const v = c.avatars[slot];
            if (typeof v === 'string' && looksLikeBytes(v)) {
              queue(v, r2.keyForCharacterAvatar(userId, charId, slot), (url) => {
                c.avatars[`${slot}Url`] = c.avatars[`${slot}Url`] || url;
                c.avatars[slot] = undefined;
              });
            }
          }
        }
      }

      // Drain tasks in parallel batches of 12
      const PARALLEL = 12;
      let nextTask = 0;
      const workers = new Array(Math.min(PARALLEL, tasks.length)).fill(null).map(async () => {
        while (true) {
          const myIdx = nextTask++;
          if (myIdx >= tasks.length) return;
          const t = tasks[myIdx];
          try {
            const url = await r2.uploadImage(t.input, t.key);
            if (url) t.apply(url);
          } catch (err) {
            console.warn(`[upload-fail] ${t.key}: ${err.message}`);
          }
        }
      });
      await Promise.all(workers);

      data.r2BackfilledAt = new Date().toISOString();

      const newJson = JSON.stringify(data);
      await pool.query('UPDATE characters SET data = $1 WHERE id = $2', [newJson, rowId]);
      const v = await pool.query("SELECT pg_column_size(data) AS bytes FROM characters WHERE id = $1", [rowId]);
      const afterBytes = v.rows[0].bytes;
      const reclaimed = beforeBytes - afterBytes;
      totalReclaimed += reclaimed;
      processed++;
      process.stdout.write(`OK ${Math.round(afterBytes / 1024)} KB (-${Math.round(reclaimed / 1024)} KB, ${tasks.length} uploads)\n`);
    } catch (err) {
      process.stdout.write(`FAIL: ${err.message}\n`);
      failed++;
    }
    if (SLEEP_MS > 0 && i + 1 < candidates.rows.length) await sleep(SLEEP_MS);
  }

  console.log(`\n[backfill-chars] done in ${((Date.now() - startTime) / 1000).toFixed(1)} s`);
  console.log(`  processed: ${processed}, failed: ${failed}, reclaimed: ${Math.round(totalReclaimed / 1024 / 1024)} MB`);
  await pool.end();
})().catch(e => { console.error('FATAL:', e.message, '\n', e.stack); process.exit(1); });
