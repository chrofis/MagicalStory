// Back-fill missing cover imageVersions rows in story_images.
//
// Bug: upsertStory used to save only the top-level cover.imageData (always at
// version_index=0) and never iterated cover.imageVersions[]. For covers that
// got a character-fix during initial generation, that meant:
//   - story_images had ONE row per cover (the best/active picked image)
//   - the original was lost from DB
//   - image_version_meta pointed at version_index=N that didn't exist
//   - the imageVersions array still sat inline in the JSONB blob, base64 and all
//
// This script reads the inline versions from data->coverImages and writes the
// missing rows to story_images, then strips the inline base64 so the blob
// shrinks back to normal size.
//
// Usage:
//   DATABASE_URL=… node scripts/admin/backfill-cover-versions.js               # dry-run all stories
//   DATABASE_URL=… node scripts/admin/backfill-cover-versions.js --apply       # apply to all
//   DATABASE_URL=… node scripts/admin/backfill-cover-versions.js <storyId>     # dry-run one story
//   DATABASE_URL=… node scripts/admin/backfill-cover-versions.js <storyId> --apply

const { Pool } = require('pg');

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const targetStory = args.find(a => !a.startsWith('--')) || null;

const COVER_TYPES = ['frontCover', 'initialPage', 'backCover'];

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  try {
    // Stream one story at a time — story.data blobs can be 1-5MB each, so
    // loading all rows up-front OOMs on prod (saw a heap-limit FATAL on the
    // first apply pass).
    const idRows = targetStory
      ? (await pool.query('SELECT id FROM stories WHERE id = $1', [targetStory])).rows
      : (await pool.query('SELECT id FROM stories ORDER BY id')).rows;

    let storiesScanned = 0;
    let storiesNeedingFix = 0;
    let rowsWritten = 0;
    let blobsTrimmed = 0;

    console.log(`Found ${idRows.length} stories to scan (${apply ? 'APPLY' : 'dry-run'})`);
    for (const idRow of idRows) {
      storiesScanned++;
      if (storiesScanned % 25 === 0) {
        console.log(`… progress: ${storiesScanned}/${idRows.length} scanned, ${rowsWritten} rows written, ${blobsTrimmed} blobs trimmed`);
      }
      const storyId = idRow.id;
      const oneRow = await pool.query('SELECT data FROM stories WHERE id = $1', [storyId]);
      if (oneRow.rows.length === 0) continue;
      const row = oneRow.rows[0];
      const data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
      if (!data?.coverImages) continue;

      let storyTouched = false;
      let blobChanged = false;
      // Mutate data in-place — avoids a JSON.parse(JSON.stringify(...)) deep
      // clone that doubles peak memory on multi-MB blobs.
      const dataMutated = data;

      for (const coverType of COVER_TYPES) {
        const cover = dataMutated.coverImages?.[coverType];
        if (!cover || !Array.isArray(cover.imageVersions) || cover.imageVersions.length === 0) continue;

        // Skip covers that have only one inline version with no imageData
        const hasInlineData = cover.imageVersions.some(v => v?.imageData);
        if (!hasInlineData) continue;

        // Mirror upsertStory's new logic: write every imageVersions[i] to v=i.
        // We OVERWRITE any existing rows because v=0 was historically populated
        // with the picked-best image (e.g. a character-fix) instead of the
        // original — restoring imageVersions[0] puts the canonical original back.
        for (let i = 0; i < cover.imageVersions.length; i++) {
          const v = cover.imageVersions[i];
          if (!v) continue;
          if (v.imageData) {
            const versionIndex = i; // arrayToDbIndex is identity
            console.log(`  [${storyId}] ${coverType} v=${versionIndex} (${v.source || v.type || 'unknown'}, ${v.imageData.length} chars) → UPSERT`);
            if (apply) {
              await pool.query(
                `INSERT INTO story_images (story_id, image_type, page_number, version_index, image_data, image_url, quality_score, generated_at)
                 VALUES ($1, $2, NULL, $3, $4, NULL, $5, $6)
                 ON CONFLICT (story_id, image_type, version_index) WHERE page_number IS NULL
                 DO UPDATE SET image_data = EXCLUDED.image_data, image_url = NULL, quality_score = EXCLUDED.quality_score, generated_at = EXCLUDED.generated_at`,
                [storyId, coverType, versionIndex, v.imageData, v.qualityScore ?? v.score ?? null, v.generatedAt || null]
              );
              rowsWritten++;
            }
            storyTouched = true;
            delete v.imageData;
            blobChanged = true;
          }
        }
      }

      if (storyTouched) storiesNeedingFix++;
      if (blobChanged) {
        if (apply) {
          await pool.query('UPDATE stories SET data = $1 WHERE id = $2', [JSON.stringify(dataMutated), storyId]);
          blobsTrimmed++;
          console.log(`  [${storyId}] blob trimmed`);
        } else {
          console.log(`  [${storyId}] blob would be trimmed`);
        }
      }
    }

    console.log('');
    console.log(`Scanned: ${storiesScanned} stories`);
    console.log(`Needing fix: ${storiesNeedingFix} stories`);
    console.log(`Rows ${apply ? 'written' : 'would be written'}: ${rowsWritten}`);
    console.log(`Blobs ${apply ? 'trimmed' : 'would be trimmed'}: ${blobsTrimmed}`);
    if (!apply) console.log('\n(dry-run — pass --apply to commit)');
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
