require('dotenv').config();
const cc = require('../../server/lib/clothingCheck');
(async () => {
  const { Pool } = require('pg');
  const p = new Pool({ connectionString: process.env.STAGING_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const r = await p.query("select data from stories where id='job_1786484554633_crojok432'");
  const d = r.rows[0].data; await p.end();
  const s = d.sceneImages.find(x => x.pageNumber === 9);
  const prose = s.sceneDescription || '';
  console.log('--- characterProse(Noah) ---');
  console.log(JSON.stringify(cc.characterProse(prose, 'Noah').slice(0, 300)));
  const reqs = d.clothingRequirements;
  const parts = cc.splitSlots(reqs.Noah.costumed.description);
  console.log('\n--- contract parts for Noah ---', parts.length, JSON.stringify(parts).slice(0, 200));
  console.log('--- contractPairs ---', JSON.stringify([...cc.contractPairs(parts)].map(([g, c]) => [g, [...c]])));
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
