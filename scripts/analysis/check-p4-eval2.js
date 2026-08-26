require('dotenv').config();
const { Pool } = require('pg');
(async () => {
  const storyId = process.argv[2] || 'job_1776613729106_a9fpjw3cy';
  const pageNumber = parseInt(process.argv[3] || '4', 10);
  const pool = new Pool({ connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

  const r = await pool.query(
    `SELECT scene->'fixableIssues' AS fi,
            scene->'fixTargets' AS ft,
            scene->>'qualityReasoning' AS qr,
            scene->>'qualityScore' AS qs,
            scene->>'semanticScore' AS ss,
            scene->>'verdict' AS v,
            scene->>'issuesSummary' AS is_,
            scene->'entityReport' AS er,
            scene->'semanticResult' AS sr
     FROM stories, jsonb_array_elements(data::jsonb->'sceneImages') AS scene
     WHERE id = $1 AND (scene->>'pageNumber')::int = $2`,
    [storyId, pageNumber]
  );
  const s = r.rows[0];
  console.log('qualityScore:', s.qs);
  console.log('semanticScore:', s.ss);
  console.log('verdict:', s.v);
  console.log('issuesSummary:', s.is_);
  console.log('\nqualityReasoning:', s.qr);
  console.log('\nfixableIssues:');
  console.log(JSON.stringify(s.fi, null, 2));
  console.log('\nfixTargets:');
  console.log(JSON.stringify(s.ft, null, 2));
  console.log('\nentityReport:');
  console.log(JSON.stringify(s.er, null, 2));
  console.log('\nsemanticResult:');
  console.log(JSON.stringify(s.sr, null, 2));

  await pool.end();
})().catch(e => { console.error(e.message); process.exit(1); });
