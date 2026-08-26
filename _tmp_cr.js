const fs = require('fs');
for (const l of fs.readFileSync('.env','utf8').split('\n')) { if (l.includes('=') && !l.trim().startsWith('#')) { const i=l.indexOf('='); process.env[l.slice(0,i).trim()]=l.slice(i+1).trim(); } }
const { Pool } = require('pg');
(async () => {
  const pool = new Pool({ connectionString: process.env.STAGING_DATABASE_URL, ssl:{rejectUnauthorized:false} });
  const sid = 'job_1783981243217_bhub4d1ji';
  const s = await pool.query(`SELECT data FROM stories WHERE id=$1`, [sid]);
  const d = s.rows[0].data;
  console.log('d.clothingRequirements exists:', !!d.clothingRequirements, '| Hans.standard.description:', d.clothingRequirements?.Hans?.standard?.description?.slice(0,60));
  console.log('d.outline.clothingRequirements exists:', !!d.outline?.clothingRequirements, '| Hans:', d.outline?.clothingRequirements?.Hans?.standard?.description?.slice(0,60));
  // Now replicate buildClothingDescription for Hans/standard with BOTH inputs
  const { buildClothingDescription } = require('./server/lib/entityConsistency');
  const hans = (d.characters||[]).find(c=>c.name==='Hans');
  console.log('\n-- buildClothingDescription(Hans, standard, null, d.clothingRequirements):');
  console.log('   ', (buildClothingDescription(hans,'standard',null, d.clothingRequirements||null)||'').slice(0,120));
  console.log('-- buildClothingDescription(Hans, standard, null, NULL):');
  console.log('   ', (buildClothingDescription(hans,'standard',null, null)||'').slice(0,120));
  await pool.end();
})().catch(e=>{console.error('ERR',e.message);process.exit(1);});
