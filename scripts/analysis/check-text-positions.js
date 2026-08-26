require('dotenv').config();
const { Pool } = require('pg');
(async () => {
  const storyId = process.argv[2];
  if (!storyId) { console.error('Usage: <storyId>'); process.exit(1); }
  const pool = new Pool({ connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

  // Extract only pageNumber + textPosition from sceneImages — avoids pulling
  // the whole data blob which includes tens of MB of image base64.
  const r = await pool.query(
    `SELECT jsonb_agg(jsonb_build_object('p', (scene->>'pageNumber')::int, 't', scene->>'textPosition') ORDER BY (scene->>'pageNumber')::int) AS rows
     FROM stories, jsonb_array_elements(data::jsonb->'sceneImages') AS scene
     WHERE id = $1`,
    [storyId]
  );
  await pool.end();

  const rows = r.rows[0]?.rows || [];
  if (rows.length === 0) { console.error('no scenes found'); process.exit(1); }

  console.log(`Page | Expected side | textPosition     | Match?`);
  console.log(`-----+---------------+------------------+-------`);
  let violations = 0;
  let topFull = 0, bottomFull = 0;
  for (const { p, t } of rows) {
    const tp = t || '(none)';
    const isFull = tp.includes('full');
    const expected = p % 2 === 1 ? 'left' : 'right';
    const side = tp.includes('left') ? 'left' : tp.includes('right') ? 'right' : 'full';
    const ok = isFull || side === expected;
    if (!ok) violations++;
    if (tp === 'top-full') topFull++;
    if (tp === 'bottom-full') bottomFull++;
    console.log(` ${String(p).padStart(2)}  | ${expected.padEnd(13)} | ${tp.padEnd(16)} | ${ok ? '✓' : '✗'}`);
  }
  const total = rows.length;
  const fullCount = topFull + bottomFull;
  const fullPct = Math.round((fullCount / total) * 100);
  console.log(`\nParity: ${violations === 0 ? '✓' : '✗ ' + violations + ' violations'}`);
  console.log(`Full-width usage: ${fullCount}/${total} (${fullPct}%) — target 30-50%`);
  const topCount = rows.filter(r => (r.t || '').startsWith('top')).length;
  const botCount = rows.filter(r => (r.t || '').startsWith('bottom')).length;
  console.log(`Top/bottom: ${topCount} top, ${botCount} bottom (target: ≥30% each)`);
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
