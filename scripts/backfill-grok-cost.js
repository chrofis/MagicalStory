const { Pool } = require('pg');
const pool = new Pool({ connectionString: 'postgresql://postgres:CkudCnsnCYbUdHxztMaHklimyMZCJAqJ@turntable.proxy.rlwy.net:26087/railway', ssl: { rejectUnauthorized: false } });
(async () => {
  try {
    const r = await pool.query("SELECT id, data->'tokenUsage' as token_usage FROM stories WHERE created_at::date = '2026-04-05' AND data->'tokenUsage'->>'grok' IS NOT NULL");
    console.log('Found', r.rows.length, 'stories');
    let updated = 0;
    for (const row of r.rows) {
      const tu = row.token_usage;
      if (!tu || !tu.byFunction) continue;
      let changed = false;
      for (const fn of ['page_images', 'cover_images']) {
        const f = tu.byFunction[fn];
        if (f && f.provider === 'grok' && f.calls > 0 && (!f.direct_cost || f.direct_cost === 0)) {
          const isPro = (f.models || []).some(m => String(m).includes('pro'));
          f.direct_cost = f.calls * (isPro ? 0.07 : 0.02);
          console.log('  ' + row.id.substring(0,30) + ' ' + fn + ': ' + f.calls + ' x $' + (isPro?0.07:0.02) + ' = $' + f.direct_cost.toFixed(2));
          changed = true;
        }
      }
      if (changed) {
        await pool.query("UPDATE stories SET data = jsonb_set(data, '{tokenUsage}', $1::jsonb) WHERE id = $2", [JSON.stringify(tu), row.id]);
        updated++;
      }
    }
    console.log('Backfilled', updated, 'stories');
  } catch (e) {
    console.error('ERROR:', e.message);
  } finally {
    await pool.end();
    process.exit(0);
  }
})();
