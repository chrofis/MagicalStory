#!/usr/bin/env node
/**
 * One-shot migration: upload existing inline-base64 avatars + Visual Bible
 * reference images from Postgres JSONB to Cloudflare R2.
 *
 * Phase 3 of the avatar→R2 migration. Phases 0–1 added the writer/reader
 * helpers and dual-write paths; Phase 2 made readers shape-agnostic. This
 * script backfills the URL fields on existing rows.
 *
 * SAFETY DEFAULTS
 *   --dry-run is the default. Pass --apply to actually write to R2 + Postgres.
 *   Inline base64 is NEVER nulled unless you also pass --null-inline. By
 *   default the script only ADDS the URL field alongside the existing inline,
 *   leaving the row in dual-write state. Phase 4 (separate decision) is the
 *   inline-null cleanup.
 *
 * USAGE
 *   node scripts/admin/migrate-avatars-to-r2.js [--apply] [--null-inline]
 *                                              [--what=avatars|vb|both]
 *                                              [--from-id=<id>] [--limit=N]
 *                                              [--character-row=<id>]
 *                                              [--story-id=<id>]
 *
 * EXAMPLES
 *   # See what would happen on the first 5 character rows, no writes:
 *   node scripts/admin/migrate-avatars-to-r2.js --limit=5
 *
 *   # Migrate one specific character row, write to R2 + Postgres URL fields:
 *   node scripts/admin/migrate-avatars-to-r2.js --apply --character-row=characters_1764881868108
 *
 *   # Full migration of all character avatars (URL fields, KEEP inline):
 *   node scripts/admin/migrate-avatars-to-r2.js --apply --what=avatars
 *
 *   # Cleanup pass — null inline AFTER URLs are confirmed (does not upload):
 *   node scripts/admin/migrate-avatars-to-r2.js --apply --null-inline --what=both
 *
 * RESUME
 *   On interrupt, re-run with --from-id=<last logged id>. The script skips
 *   any row whose avatars/VB entries already have URLs but no inline.
 */

require('dotenv').config();
const { Pool } = require('pg');

// Load runtime modules so we share R2 config + key builders + uploader.
const r2 = require('../../server/lib/r2');

// ── CLI ─────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const val = (flag, dflt = null) => {
  const m = args.find(a => a.startsWith(`${flag}=`));
  return m ? m.split('=').slice(1).join('=') : dflt;
};

const DRY_RUN = !has('--apply');
const NULL_INLINE = has('--null-inline');
const FROM_ID = val('--from-id', null);
const CHARACTER_ROW = val('--character-row', null);
const STORY_ID = val('--story-id', null);
const LIMIT = parseInt(val('--limit', '0'), 10) || 0;

// Auto-scope --what based on the row filter unless caller is explicit.
// --character-row applies only to the characters table, so scanning stories
// with that flag is wasted work; same for --story-id.
const WHAT_EXPLICIT = val('--what', null);
let WHAT;
if (WHAT_EXPLICIT) {
  WHAT = WHAT_EXPLICIT.toLowerCase();
} else if (CHARACTER_ROW) {
  WHAT = 'avatars';
} else if (STORY_ID) {
  WHAT = 'vb';
} else {
  WHAT = 'both';
}

if (!['avatars', 'vb', 'both'].includes(WHAT)) {
  console.error(`--what must be one of: avatars, vb, both (got: ${WHAT})`);
  process.exit(2);
}

const tag = DRY_RUN ? '[DRY RUN] ' : '[APPLY] ';

// ── Helpers ─────────────────────────────────────────────────────────────────
function isInlineBase64(v) {
  return typeof v === 'string' && v.length > 0 && (v.startsWith('data:image') || /^[A-Za-z0-9+/]{20,}={0,2}$/.test(v.slice(0, 40)));
}

function byteSize(b64) {
  if (!b64) return 0;
  // Strip data: prefix length so byte estimate isn't inflated
  const stripped = b64.replace(/^data:image\/\w+;base64,/, '');
  return Math.floor((stripped.length * 3) / 4);
}

async function uploadIfMissing(uploadFn, currentInline, currentUrl) {
  // Returns { newUrl: string|null, uploaded: boolean, skipped: 'has-url'|'no-inline'|null }
  if (currentUrl && currentUrl.startsWith('http')) {
    return { newUrl: currentUrl, uploaded: false, skipped: 'has-url' };
  }
  if (!isInlineBase64(currentInline)) {
    return { newUrl: null, uploaded: false, skipped: 'no-inline' };
  }
  if (DRY_RUN) {
    return { newUrl: 'WOULD-UPLOAD', uploaded: false, skipped: null };
  }
  const url = await uploadFn(currentInline);
  return { newUrl: url, uploaded: !!url, skipped: url ? null : 'upload-failed' };
}

// ── Avatars migration ──────────────────────────────────────────────────────
async function migrateCharacters(pool) {
  console.log(`${tag}=== CHARACTERS table ===`);
  const conditions = ['1=1'];
  const params = [];
  if (CHARACTER_ROW) {
    conditions.push(`id = $${params.length + 1}`);
    params.push(CHARACTER_ROW);
  } else if (FROM_ID) {
    conditions.push(`id >= $${params.length + 1}`);
    params.push(FROM_ID);
  }
  let query = `SELECT id, user_id, data FROM characters WHERE ${conditions.join(' AND ')} ORDER BY id`;
  if (LIMIT > 0) query += ` LIMIT ${LIMIT}`;

  const { rows } = await pool.query(query, params);
  console.log(`${tag}Loaded ${rows.length} character rows`);

  let totalUploads = 0;
  let totalNullified = 0;
  let totalBytesMoved = 0;
  let totalRowsUpdated = 0;

  for (const row of rows) {
    const userId = row.user_id;
    const data = row.data || {};
    const characters = Array.isArray(data.characters) ? data.characters : [];
    if (characters.length === 0) continue;

    let rowChanged = false;
    let perRowUploads = 0;
    let perRowNulls = 0;
    let perRowBytes = 0;

    for (const char of characters) {
      const charId = char.id;
      if (!charId) continue;
      const avatars = char.avatars;
      if (!avatars || typeof avatars !== 'object') continue;

      // Main slots: standard / summer / winter
      for (const slot of ['standard', 'summer', 'winter']) {
        const inline = avatars[slot];
        const urlField = `${slot}Url`;
        const url = avatars[urlField];

        const result = await uploadIfMissing(
          (b64) => r2.uploadImage(b64, r2.keyForCharacterAvatar(userId, charId, slot)),
          inline,
          url,
        );

        if (result.uploaded) {
          avatars[urlField] = result.newUrl;
          rowChanged = true;
          perRowUploads++;
          perRowBytes += byteSize(inline);
          console.log(`${tag}  ✓ uploaded ${userId}/${charId}/${slot}.jpg (${(byteSize(inline) / 1024).toFixed(0)}KB)`);
        } else if (DRY_RUN && result.newUrl === 'WOULD-UPLOAD') {
          perRowUploads++;
          perRowBytes += byteSize(inline);
          console.log(`${tag}  [would upload] ${userId}/${charId}/${slot}.jpg (${(byteSize(inline) / 1024).toFixed(0)}KB)`);
        }

        // Null inline only when explicitly requested AND we have a URL
        if (NULL_INLINE && (result.newUrl === url || result.uploaded) && url) {
          if (avatars[slot] != null) {
            if (!DRY_RUN) avatars[slot] = null;
            rowChanged = true;
            perRowNulls++;
            console.log(`${tag}  ⌫ nulled inline ${userId}/${charId}/${slot}`);
          }
        }
      }

      // Thumbnails: faceThumbnails.{slot} / bodyThumbnails.{slot}
      for (const kind of ['face', 'body']) {
        const thumbObjKey = `${kind}Thumbnails`;
        const urlObjKey = `${kind}ThumbnailsUrl`;
        const thumbs = avatars[thumbObjKey];
        if (!thumbs || typeof thumbs !== 'object') continue;
        if (!avatars[urlObjKey]) avatars[urlObjKey] = {};
        for (const slot of Object.keys(thumbs)) {
          const inline = thumbs[slot];
          const url = avatars[urlObjKey][slot];

          const result = await uploadIfMissing(
            (b64) => r2.uploadImage(b64, r2.keyForCharacterThumb(userId, charId, kind, slot)),
            inline,
            url,
          );

          if (result.uploaded) {
            avatars[urlObjKey][slot] = result.newUrl;
            rowChanged = true;
            perRowUploads++;
            perRowBytes += byteSize(inline);
            console.log(`${tag}  ✓ uploaded ${userId}/${charId}/thumbs/${kind}-${slot}.jpg (${(byteSize(inline) / 1024).toFixed(0)}KB)`);
          } else if (DRY_RUN && result.newUrl === 'WOULD-UPLOAD') {
            perRowUploads++;
            perRowBytes += byteSize(inline);
          }

          if (NULL_INLINE && (result.uploaded || avatars[urlObjKey][slot]) && thumbs[slot] != null) {
            if (!DRY_RUN) thumbs[slot] = null;
            rowChanged = true;
            perRowNulls++;
          }
        }
      }

      // Styled avatars (Phase 1e — not yet wired into write path; only migrate
      // existing inline data)
      const styled = avatars.styledAvatars;
      if (styled && typeof styled === 'object') {
        for (const artStyle of Object.keys(styled)) {
          const slots = styled[artStyle];
          if (!slots || typeof slots !== 'object') continue;
          for (const key of Object.keys(slots)) {
            const inline = slots[key];
            // Skip nested costumed object — recurse into it
            if (key === 'costumed' && inline && typeof inline === 'object' && !inline.imageData) {
              continue; // costume entries handled below
            }
            const value = (typeof inline === 'object' && inline?.imageData) ? inline.imageData : inline;
            if (!isInlineBase64(value)) continue;
            const r2Key = r2.keyForCharacterStyledAvatar(userId, charId, `${artStyle}_${key}`);
            if (DRY_RUN) {
              perRowUploads++;
              perRowBytes += byteSize(value);
              continue;
            }
            const url = await r2.uploadImage(value, r2Key);
            if (url) {
              if (typeof inline === 'object') {
                slots[key].imageUrl = url;
                if (NULL_INLINE) slots[key].imageData = null;
              } else {
                // Plain string — convert to object form for forward compat
                slots[key] = { imageUrl: url, imageData: NULL_INLINE ? null : value };
              }
              rowChanged = true;
              perRowUploads++;
              perRowBytes += byteSize(value);
              console.log(`${tag}  ✓ uploaded styled ${userId}/${charId}/${artStyle}_${key}`);
            }
          }
        }
      }
    }

    if (perRowUploads + perRowNulls > 0) {
      console.log(`${tag}row ${row.id}: ${perRowUploads} uploads, ${perRowNulls} nulls, ${(perRowBytes / 1024).toFixed(0)}KB moved`);
      totalUploads += perRowUploads;
      totalNullified += perRowNulls;
      totalBytesMoved += perRowBytes;
    }

    if (rowChanged && !DRY_RUN) {
      await pool.query(`UPDATE characters SET data = $1 WHERE id = $2`, [data, row.id]);
      totalRowsUpdated++;
    }
  }

  console.log(`${tag}--- characters summary: ${totalRowsUpdated} rows updated, ${totalUploads} uploads, ${totalNullified} nulls, ${(totalBytesMoved / 1024 / 1024).toFixed(1)}MB ---`);
}

// ── Visual Bible refs migration ────────────────────────────────────────────
async function migrateVbRefs(pool) {
  console.log(`${tag}=== STORIES table (visual bible refs) ===`);

  // Stream rows one at a time. The stories.data column is multi-MB per row
  // (4.97 GB total across 96 rows). A single bulk SELECT pulls all of it
  // into one buffer over the network — easily multi-minute hang. Instead:
  //   1) Get the LIST of story ids cheaply (no data blob).
  //   2) For each id, fetch + process + commit + move on. Each row holds
  //      one ~50MB blob in memory at a time.
  const conditions = ['data->\'visualBible\' IS NOT NULL'];
  const params = [];
  if (STORY_ID) {
    conditions.push(`id = $${params.length + 1}`);
    params.push(STORY_ID);
  } else if (FROM_ID) {
    conditions.push(`id >= $${params.length + 1}`);
    params.push(FROM_ID);
  }
  let listQuery = `SELECT id FROM stories WHERE ${conditions.join(' AND ')} ORDER BY id`;
  if (LIMIT > 0) listQuery += ` LIMIT ${LIMIT}`;

  const { rows: idRows } = await pool.query(listQuery, params);
  console.log(`${tag}Streaming ${idRows.length} story rows with VB (one at a time)`);

  let totalUploads = 0;
  let totalNullified = 0;
  let totalBytesMoved = 0;
  let totalRowsUpdated = 0;

  const VB_ARRAYS = ['secondaryCharacters', 'animals', 'artifacts', 'vehicles', 'locations'];

  for (let i = 0; i < idRows.length; i++) {
    const storyId = idRows[i].id;
    const { rows: dataRows } = await pool.query(`SELECT id, data FROM stories WHERE id = $1`, [storyId]);
    if (dataRows.length === 0) continue;
    const row = dataRows[0];
    const data = row.data || {};
    const vb = data.visualBible;
    if (!vb || typeof vb !== 'object') continue;

    let rowChanged = false;
    let perRowUploads = 0;
    let perRowNulls = 0;
    let perRowBytes = 0;

    // Parallelize uploads WITHIN a single story. Each entry's R2 PUT is
    // independent — was sequential at ~200ms each, ~5–15 sequential uploads
    // per story = the dominant per-row cost. Promise.all cuts that to one
    // round-trip's worth.
    const tasks = [];
    for (const arrName of VB_ARRAYS) {
      const arr = vb[arrName];
      if (!Array.isArray(arr)) continue;
      for (const entry of arr) {
        if (!entry?.id) continue;
        tasks.push((async () => {
          const inline = entry.referenceImageData;
          const url = entry.referenceImageUrl;

          const result = await uploadIfMissing(
            (b64) => r2.uploadImage(b64, r2.keyForVbReference(row.id, entry.id)),
            inline,
            url,
          );

          if (result.uploaded) {
            entry.referenceImageUrl = result.newUrl;
            rowChanged = true;
            perRowUploads++;
            perRowBytes += byteSize(inline);
            console.log(`${tag}  ✓ uploaded ${row.id}/vb/${entry.id}.jpg (${(byteSize(inline) / 1024).toFixed(0)}KB)`);
          } else if (DRY_RUN && result.newUrl === 'WOULD-UPLOAD') {
            perRowUploads++;
            perRowBytes += byteSize(inline);
          }

          if (NULL_INLINE && (result.uploaded || url) && entry.referenceImageData != null) {
            if (!DRY_RUN) entry.referenceImageData = null;
            rowChanged = true;
            perRowNulls++;
          }
        })());
      }
    }
    await Promise.all(tasks);

    if (perRowUploads + perRowNulls > 0) {
      console.log(`${tag}story ${row.id}: ${perRowUploads} VB uploads, ${perRowNulls} nulls, ${(perRowBytes / 1024).toFixed(0)}KB moved`);
      totalUploads += perRowUploads;
      totalNullified += perRowNulls;
      totalBytesMoved += perRowBytes;
    }

    if (rowChanged && !DRY_RUN) {
      await pool.query(`UPDATE stories SET data = $1 WHERE id = $2`, [data, row.id]);
      totalRowsUpdated++;
    }
  }

  console.log(`${tag}--- VB summary: ${totalRowsUpdated} rows updated, ${totalUploads} uploads, ${totalNullified} nulls, ${(totalBytesMoved / 1024 / 1024).toFixed(1)}MB ---`);
}

// ── Main ───────────────────────────────────────────────────────────────────
async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL not set');
    process.exit(2);
  }
  if (!r2.isConfigured()) {
    console.error('R2 not configured (check R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_PUBLIC_URL)');
    if (!DRY_RUN) process.exit(2);
    console.warn(`${tag}continuing in DRY RUN despite R2 misconfig (no real uploads will occur)`);
  }

  console.log(`${tag}avatars+VB migration (what=${WHAT}, null-inline=${NULL_INLINE}, limit=${LIMIT || 'none'}, from-id=${FROM_ID || 'none'})`);

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    if (WHAT === 'avatars' || WHAT === 'both') await migrateCharacters(pool);
    if (WHAT === 'vb' || WHAT === 'both') await migrateVbRefs(pool);
    console.log(`${tag}DONE.`);
  } finally {
    await pool.end();
  }
}

main().catch(e => {
  console.error('FATAL:', e.message, e.stack);
  process.exit(1);
});
