require('dotenv').config();
const { Pool } = require('pg');
const { bucketForType } = require('../../server/lib/evalBuckets');
const NAME = { visual:'image-evaluation (mine)', semantic:'image-semantic', threeStage:'image-prompt-compliance', entity:'entity-consistency' };
(async () => {
  const pool = new Pool({ connectionString: process.env.STAGING_DATABASE_URL, ssl:{rejectUnauthorized:false} });
  const agg = {}; const unmapped = {};
  for (const id of process.argv.slice(2)) {
    const { rows } = await pool.query('select data from stories where id=$1',[id]);
    if (!rows[0]) continue;
    for (const pg of rows[0].data.sceneImages || []) {
      const bd = ((pg.imageVersions||[])[0]||{}).scoreBreakdown; if (!bd) continue;
      for (const k of Object.keys(NAME)) {
        agg[k] = agg[k] || { total:0, hasType:0, routed:0 };
        for (const i of (bd[k]&&bd[k].issues)||[]) {
          agg[k].total++;
          const t = String(i.type||'').trim();
          if (t) agg[k].hasType++;
          if (t && bucketForType(t) !== 'other') agg[k].routed++;
          else if (t) unmapped[t] = (unmapped[t]||0)+1;
        }
      }
    }
  }
  console.log('prompt                       findings   has type    routes to a real bucket');
  let T=0, R=0;
  for (const k of Object.keys(NAME)) {
    const x = agg[k]; T += x.total; R += x.routed;
    const pct = n => (n/(x.total||1)*100).toFixed(0)+'%';
    console.log('  '+NAME[k].padEnd(27)+String(x.total).padStart(5)+'  '+(x.hasType+' ('+pct(x.hasType)+')').padStart(12)+'  '+(x.routed+' ('+pct(x.routed)+')').padStart(14));
  }
  console.log('\n  OVERALL routed: '+R+'/'+T+' = '+(R/T*100).toFixed(1)+'%');
  const left = Object.entries(unmapped).sort((a,b)=>b[1]-a[1]);
  console.log('\n  still unmapped types ('+left.length+' distinct, '+left.reduce((s,[,n])=>s+n,0)+' findings):');
  left.slice(0,15).forEach(([t,n])=>console.log('    '+String(n).padStart(3)+'x  '+t));
  await pool.end(); process.exit(0);
})().catch(e=>{console.error(e);process.exit(1)});
