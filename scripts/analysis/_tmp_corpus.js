require('dotenv').config();
const { Pool } = require('pg');
const VESSEL = /\b(deck|bow|stern|helm|gunwale|aboard|on (?:the|a) (?:boat|raft|ship|cart|wagon|sled|sleigh)|in (?:the|a) (?:boat|raft|cart|wagon))\b/i;
const N = Number(process.argv[3] || 120);
(async () => {
  const name = process.argv[2];
  const cs = name === 'prod' ? process.env.DATABASE_URL : process.env.STAGING_DATABASE_URL;
  const pool = new Pool({ connectionString: cs, ssl: { rejectUnauthorized: false } });
  const ids = await pool.query(`SELECT id FROM stories ORDER BY created_at DESC LIMIT $1`, [N]);
  let stories = 0, pages = 0; const hits = [];
  for (const { id } of ids.rows) {
    const r = await pool.query(`SELECT jsonb_path_query_array(data, '$.sceneImages[*].sceneMetadata.fullData') AS fd FROM stories WHERE id=$1`, [id]);
    const arr = r.rows[0]?.fd || [];
    if (!arr.length) continue;
    stories++;
    arr.forEach((fd, i) => {
      const chars = fd?.characters;
      if (!Array.isArray(chars) || chars.length < 2) return;
      pages++;
      const onV = chars.filter(c => VESSEL.test(c.position || ''));
      if (onV.length < 2) return;
      const depths = new Set(onV.map(c => (c.depth || '').toLowerCase()).filter(Boolean));
      if (depths.has('background') && depths.size > 1) hits.push({ id, i, onV });
    });
  }
  console.log(`\n=== ${name}: ${stories} stories with scenes, ${pages} multi-character pages`);
  console.log(`shared-surface pages with mixed depth incl. background: ${hits.length}`);
  hits.forEach(h => { console.log(`  ${h.id}  page-index ${h.i}`); h.onV.forEach(c => console.log(`      ${c.name}: depth=${c.depth} position="${c.position}"`)); });
  await pool.end();
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
