// One-shot verification of a story run against everything changed on 2026-08-09.
// Usage: node scripts/_tmp_verify_run.js <storyId>
const { Pool } = require('pg'); require('dotenv').config();
const { bucketForType } = require('../server/lib/evalBuckets');
const { REPAIR_DEFAULTS } = require('../server/config/models');
const pool = new Pool({ connectionString: process.env.STAGING_DATABASE_URL, ssl: { rejectUnauthorized: false } });
const ID = process.argv[2];
const PTS = { CATASTROPHIC:50, CRITICAL:25, MAJOR:15, MODERATE:5, MINOR:2 };
const EVALS = { visual:'quality', semantic:'semantic', threeStage:'compliance', entity:'entity' };
const SEVR = ['MINOR','MODERATE','MAJOR','CRITICAL','CATASTROPHIC'];

(async () => {
  const { rows } = await pool.query(
    `SELECT data->>'artStyle' AS style, data->'sceneImages' AS scenes FROM stories WHERE id=$1`, [ID]);
  if (!rows.length) { console.log('story not found'); process.exit(1); }
  const scenes = rows[0].scenes || [];
  console.log(`\n=== ${ID}  style=${rows[0].style}  pages=${scenes.length} ===`);
  console.log(`gates live: redo<${REPAIR_DEFAULTS.scoreThreshold} iterVis<${REPAIR_DEFAULTS.qualityThresholdForIterate} iterSem<${REPAIR_DEFAULTS.semanticThresholdForIterate} salvageFloor=${REPAIR_DEFAULTS.iterateSalvageFloor}`);

  // ---- 1. per page
  console.log('\n--- per page ---');
  console.log('page  score  vers  versions            style_gate');
  const gateSeen = { present:0, missing:0, failed:0 }; const observedVals = {};
  for (const sc of scenes) {
    const vers = sc.imageVersions || [];
    const act = vers.find(v => v.finalScore === sc.finalScore) || vers[vers.length-1] || {};
    const raw = String(act.qualityRawOutput || sc.qualityRawOutput || '');
    let g = '(no raw output)';
    if (raw) {
      const m = raw.match(/"style_gate"\s*:\s*\{[^}]*\}/);
      if (m) { gateSeen.present++; g = m[0].replace(/\s+/g,' ').slice(0,72);
        if (/"matches_style"\s*:\s*false/.test(m[0])) gateSeen.failed++;
        const o = m[0].match(/"observed"\s*:\s*"([^"]*)"/); if (o) observedVals[o[1]] = (observedVals[o[1]]||0)+1;
      } else { gateSeen.missing++; g = 'MISSING from output'; }
    }
    console.log(`p${String(sc.pageNumber).padEnd(3)} ${String(sc.finalScore).padStart(6)} ${String(vers.length).padStart(5)}  ${vers.map(v=>v.finalScore??'?').join(' → ').padEnd(20)} ${g}`);
  }
  console.log(`\nstyle_gate: present ${gateSeen.present}, MISSING ${gateSeen.missing}, matches_style=false ${gateSeen.failed}`);
  console.log('observed mediums:', JSON.stringify(observedVals));

  // ---- 2. types + ceilings + regressions
  const types = {}, buckets = {}; let consTotal=0, consTyped=0, medOk=0, medTot=0, mirrors=0;
  const ceilBreach = [];
  const CEIL = { accessory:'MODERATE', accessory_missing:'MODERATE', clothing_detail:'MODERATE', unverified_absence:'MINOR' };
  const median = s => { const v=Object.values(s||{}).map(x=>String(x).toUpperCase()).filter(x=>SEVR.includes(x)).sort((a,b)=>SEVR.indexOf(a)-SEVR.indexOf(b)); return v.length?v[Math.floor((v.length-1)/2)]:null; };
  for (const sc of scenes) for (const v of (sc.imageVersions||[])) {
    for (const d of (v.deductions?.consolidated||[])) {
      consTotal++; if (d.type) consTyped++;
      const t = String(d.type||'(none)'); types[t]=(types[t]||0)+1;
      const b = bucketForType(t)||'other';
      const sev = String(d.severity||'').toUpperCase();
      let p = PTS[sev]||0; if (/garment_colou?r/.test(t)) p = 0;
      if (CEIL[t]) p = Math.min(p, PTS[CEIL[t]]);
      buckets[b] = buckets[b]||{n:0,pts:0}; buckets[b].n++; buckets[b].pts += p;
      if (d.severities && Object.keys(d.severities).length) { medTot++; if (sev === median(d.severities)) medOk++; }
      const txt = String(d.description||'');
      if (/\b(facing|faces|turned)\b/i.test(txt) && /\bleft\b/i.test(txt) && /\bright\b/i.test(txt)) mirrors++;
      if (t === 'camera_facing') ceilBreach.push('camera_facing still emitted: ' + txt.slice(0,60));
    }
  }
  const tot = Object.values(buckets).reduce((a,x)=>a+x.pts,0);
  console.log('\n--- deductions by bucket (charged) ---');
  Object.entries(buckets).sort((a,b)=>b[1].pts-a[1].pts).forEach(([b,x]) =>
    console.log(`  ${b.padEnd(22)} ${String(x.n).padStart(4)}  ${String(x.pts).padStart(5)} pts  ${(x.pts/tot*100).toFixed(0)}%`));
  console.log('\n--- types emitted ---');
  Object.entries(types).sort((a,b)=>b[1]-a[1]).forEach(([t,n]) => console.log(`  ${String(n).padStart(4)}  ${t}`));
  console.log(`\ntyped ${consTyped}/${consTotal} | median-enforced ${medOk}/${medTot} | left/right mirrors ${mirrors} | camera_facing ${ceilBreach.length}`);

  // ---- 3. repair outcome
  let improved=0, worse=0, single=0;
  for (const sc of scenes) {
    const v = (sc.imageVersions||[]).map(x=>x.finalScore).filter(x=>typeof x==='number');
    if (v.length<2) { single++; continue; }
    const d = v[v.length-1]-v[0]; if (d>0) improved++; else if (d<0) worse++;
  }
  const s = scenes.map(x=>x.finalScore).filter(x=>typeof x==='number');
  console.log(`\n--- outcome ---`);
  console.log(`mean ${(s.reduce((a,b)=>a+b,0)/s.length).toFixed(1)}  min ${Math.min(...s)}  max ${Math.max(...s)}  below 55: ${s.filter(x=>x<55).length}/${s.length}`);
  console.log(`repair: improved ${improved}, worse ${worse}, single-version ${single}`);
  console.log(`\nBASELINE (job_1786287569165): mean 10.8, 11/14 below 55, clothing 38%, repair improved 5 / worse 8, 13 regenerations`);
  await pool.end();
})();
