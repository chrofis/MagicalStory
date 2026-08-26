// Measure p5's prompt section-by-section: what takes how many chars.
require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.STAGING_DATABASE_URL, ssl: { rejectUnauthorized: false } });
(async () => {
  const r = await pool.query(`SELECT data->'sceneImages'->4->>'prompt' AS p FROM stories WHERE id='job_1786397108357_q1fjbdzbx'`);
  const p = r.rows[0].p;
  // Split on ** section headers at line starts
  const re = /^\*\*([A-Z][A-Z /_():'-]+):?\*\*/gm;
  const marks = [];
  let m;
  while ((m = re.exec(p)) !== null) marks.push({ name: m[1].trim(), idx: m.index });
  marks.push({ name: '(end)', idx: p.length });
  console.log('total:', p.length, 'chars\n');
  for (let i = 0; i < marks.length - 1; i++) {
    const len = marks[i + 1].idx - marks[i].idx;
    console.log(String(marks[i].idx).padStart(5), String(len).padStart(5), marks[i].name);
  }
  // also show first mark preamble
  if (marks[0].idx > 0) console.log('    0', String(marks[0].idx).padStart(5), '(preamble before first header)');
  // dump each section's first 100 chars for context
  console.log('\n--- section previews:');
  for (let i = 0; i < marks.length - 1; i++) {
    console.log('## ' + marks[i].name + ' :: ' + p.slice(marks[i].idx, marks[i].idx + 160).replace(/\n/g, ' ⏎ '));
  }
  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
