const fs = require('fs');
for (const l of fs.readFileSync('.env','utf8').split('\n')) { if (l.includes('=') && !l.trim().startsWith('#')) { const i=l.indexOf('='); process.env[l.slice(0,i).trim()]=l.slice(i+1).trim(); } }
const { Pool } = require('pg');
const { buildClothingDescription } = require('./server/lib/entityConsistency');
(async () => {
  const pool = new Pool({ connectionString: process.env.STAGING_DATABASE_URL, ssl:{rejectUnauthorized:false} });
  const { rows:[s] } = await pool.query(`SELECT data->'characters' chars, data->'clothingRequirements' creq FROM stories WHERE id=$1`, ['job_1783889777354_lmtq5xuij']);
  await pool.end();
  const creq = s.creq || {};
  for (const char of (s.chars||[])) {
    const category = creq[char.name]?._currentClothing || 'standard';
    const OLD = char.avatars?.clothing?.[category] || 'unknown';
    const NEW = buildClothingDescription(char, category, null, creq) || 'unknown';
    console.log(`\n=== ${char.name} (category=${category}) ===`);
    console.log('  OLD (avatars default):', String(OLD).slice(0,90));
    console.log('  NEW (story resolver) :', String(NEW).slice(0,90));
  }
})().catch(e=>{console.error('ERR',e.message);process.exit(1);});
