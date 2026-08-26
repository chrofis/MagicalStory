require('dotenv').config();
const fs = require('fs');
const { Pool } = require('pg');

(async () => {
  const pool = new Pool({ connectionString: process.env.STAGING_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const e = await pool.query('SELECT results FROM testlab_experiments WHERE id = 848');
  const r = (e.rows[0].results || [])[0] || {};
  const bp = String(r.blendPrompt || '');
  fs.writeFileSync('scripts/analysis/_tmp_blendprompt.txt', bp);
  console.log('chars:', bp.length, '| cap is 8000');
  console.log('lines:', bp.split('\n').length);
  console.log('\n================= FULL BLEND PROMPT =================\n');
  console.log(bp);
  await pool.end();
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
