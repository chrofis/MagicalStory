// Inspect every saved version of a page (and its retry history) for a story.
// Output uses the SAME labels the user sees in the frontend version picker:
//   Original, V2 (repair), V3 (repair), V4 (entity-repair), …
// (See client/src/components/generation/story/ImageHistoryModal.tsx — index 0
// is "Original"; otherwise "V{idx+1}", with the version.type tag in
// parentheses for non-original entries.)
//
// Usage:
//   node scripts/analysis/inspect-page-versions.js <storyId> <pageNumber>

require('dotenv').config();
const { Pool } = require('pg');

(async () => {
  const id = process.argv[2];
  const page = parseInt(process.argv[3] || 'NaN', 10);
  if (!id || Number.isNaN(page)) {
    console.error('Usage: node scripts/analysis/inspect-page-versions.js <storyId> <pageNumber>');
    process.exit(1);
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  // Match the frontend label: index 0 → "Original", otherwise "V{idx+1}".
  const versionLabel = (idx) => (idx === 0 ? 'Original' : `V${idx + 1}`);

  // story_images table — canonical persisted versions.
  const dbR = await pool.query(
    `SELECT version_index, octet_length(image_data) AS bytes, generated_at, quality_score
     FROM story_images
     WHERE story_id = $1 AND page_number = $2 AND image_type = 'scene'
     ORDER BY version_index ASC`,
    [id, page]
  );
  console.log(`story_images rows for page ${page}: ${dbR.rows.length}`);
  for (const r of dbR.rows) {
    console.log(
      `  ${versionLabel(r.version_index)}: ${(r.bytes / 1024).toFixed(0)}KB  ${r.generated_at?.toISOString?.() || r.generated_at}  qualityScore=${r.quality_score ?? '-'}`
    );
  }

  // Blob: imageVersions array carries the type tag the frontend renders.
  const sR = await pool.query('SELECT data FROM stories WHERE id = $1', [id]);
  if (!sR.rows[0]) {
    console.error('story not found');
    process.exit(1);
  }
  const d = sR.rows[0].data;
  const scene = (d.sceneImages || []).find((s) => s.pageNumber === page);
  if (!scene) {
    console.error(`page ${page} not in sceneImages`);
    process.exit(1);
  }

  console.log(`\nblob.sceneImages[page ${page}].imageVersions:`);
  for (const [i, v] of (scene.imageVersions || []).entries()) {
    const tag = v.type && v.type !== 'original' ? ` (${v.type})` : '';
    console.log(
      `  ${versionLabel(i)}${tag}  modelId=${v.modelId || '-'}  qualityScore=${v.qualityScore ?? '-'}  createdAt=${v.createdAt || '-'}  promptLen=${(v.prompt || '').length}`
    );
  }

  console.log(`\nblob.sceneImages[page ${page}].retryHistory:`);
  for (const [i, r] of (scene.retryHistory || []).entries()) {
    console.log(
      `  retry${i}: source=${r.source || '-'}  modelId=${r.modelId || '-'}  scoreBefore=${r.preRepairEval?.score ?? '-'}  scoreAfter=${r.postRepairEval?.score ?? '-'}  reason="${(r.reason || '').slice(0, 80)}"`
    );
  }

  console.log(
    `\nbestSource: ${scene.bestSource || '-'}  wasIterated: ${!!scene.wasIterated}  wasRegenerated: ${!!scene.wasRegenerated}  wasCharacterFixed: ${!!scene.wasCharacterFixed}`
  );
  if (d.finalChecksReport?.entity) {
    console.log('finalChecksReport.entity present (entity-consistency report)');
  }

  process.exit(0);
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
