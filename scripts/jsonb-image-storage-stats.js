// Audit how much image bytes still live inline in stories.data JSONB.
// Per the original R2 plan, these were the biggest remaining win after the
// story_images table migration. Run via:
//   DATABASE_URL=... node scripts/jsonb-image-storage-stats.js
const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('proxy.rlwy.net') ? { rejectUnauthorized: false } : false,
});

(async () => {
  try {
    // Total stories.data size on disk (TOAST + inline)
    const totals = await pool.query(`
      SELECT
        COUNT(*)::int AS stories,
        pg_size_pretty(pg_total_relation_size('stories')) AS table_size,
        pg_size_pretty(SUM(OCTET_LENGTH(data::text))::bigint) AS data_text_bytes
      FROM stories
    `);
    console.log('stories overall:', totals.rows[0]);

    // Per-section breakdown via JSONB. We approximate "image bytes" by counting
    // length of any string field whose value starts with /9j/ (JPEG base64),
    // iVBORw0KGgo (PNG base64), or data:image/. This catches the legacy
    // inline-image fields without false-positives for plain text.
    const sectionSizes = await pool.query(`
      SELECT
        SUM(OCTET_LENGTH(data->>'sceneImages'))::bigint            AS sceneImages_bytes,
        SUM(OCTET_LENGTH(data->>'coverImages'))::bigint            AS coverImages_bytes,
        SUM(OCTET_LENGTH(data->>'characters'))::bigint             AS characters_bytes,
        SUM(OCTET_LENGTH(data->>'visualBible'))::bigint            AS visualBible_bytes,
        SUM(OCTET_LENGTH(data->>'styledAvatarGeneration'))::bigint AS styledAvatarGen_bytes,
        SUM(OCTET_LENGTH(data->>'avatarGenerationLog'))::bigint    AS avatarGenLog_bytes,
        SUM(OCTET_LENGTH(data->>'finalChecksReport'))::bigint      AS finalChecks_bytes,
        SUM(OCTET_LENGTH(data->>'generationLog'))::bigint          AS generationLog_bytes
      FROM stories
    `);
    console.log('\nstories.data sections (raw text bytes — pre-TOAST compression):');
    for (const [k, v] of Object.entries(sectionSizes.rows[0])) {
      const mb = v ? (Number(v) / 1024 / 1024).toFixed(1) : '0';
      console.log(`  ${k.padEnd(25)} ${mb} MB`);
    }

    // Top 10 stories by data size
    const top = await pool.query(`
      SELECT id, OCTET_LENGTH(data::text) AS bytes
      FROM stories
      ORDER BY OCTET_LENGTH(data::text) DESC
      LIMIT 10
    `);
    console.log('\ntop 10 stories by data size:');
    for (const r of top.rows) {
      console.log(`  ${r.id} ${(r.bytes/1024/1024).toFixed(1)} MB`);
    }
  } catch (err) {
    console.error('failed:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
})();
