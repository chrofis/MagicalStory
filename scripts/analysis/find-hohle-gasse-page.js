require('dotenv').config();
const fs = require('fs');
const { Pool } = require('pg');

(async () => {
  const dbUrl = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  const pool = new Pool({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  const stories = [
    'job_1777923092665_wkhxd3mg9',
    'job_1777756893340_z7sorswkj',
    'job_1777723595105_q9t5foo51',
    'job_1777701999612_we3rb9u7b',
  ];
  const out = [];
  for (const id of stories) {
    const r = await pool.query("SELECT data FROM stories WHERE id = $1", [id]);
    const story = r.rows[0].data;
    out.push('\n=== ' + id + ' — ' + story.title + ' ===');
    for (const p of story.sceneImages || []) {
      const desc = p.description || '';
      const text = p.text || '';
      const all = (desc + ' ' + text).toLowerCase();
      const hits = [];
      if (all.includes('hohle gasse')) hits.push('hohle gasse');
      if (all.includes('hollow')) hits.push('hollow');
      if (all.includes('crossbow') || all.includes('armbrust')) hits.push('crossbow/armbrust');
      if (all.includes('aim') || all.includes('zielt')) hits.push('aim/zielt');
      if (all.includes('shoot') || all.includes('schiess') || all.includes('schoss')) hits.push('shoot');
      if (hits.length > 0) {
        out.push('p' + p.pageNumber + ' [HITS: ' + hits.join(', ') + ']');
        out.push('  text: ' + text.slice(0, 250).replace(/\n/g, ' | '));
        out.push('  desc: ' + desc.slice(0, 600).replace(/\n/g, ' | '));
      }
    }
  }
  fs.writeFileSync('tmp/hohle-gasse-search.txt', out.join('\n'));
  console.log('wrote tmp/hohle-gasse-search.txt');
  await pool.end();
})().catch(e => { console.error(e.message); process.exit(1); });
