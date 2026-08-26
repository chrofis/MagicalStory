require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
(async () => {
  const id = 'job_1778967306826_ynmt8lpwa';
  const r = await pool.query("SELECT data->'styledAvatarGeneration' as sag FROM stories WHERE id = $1", [id]);
  const all = r.rows[0].sag || [];
  const hans = all.filter(e => e.characterName === 'Hans');
  console.log('Hans entries:', hans.length, '\n');
  for (let i = 0; i < hans.length; i++) {
    const e = hans[i];
    console.log('=== Entry', i+1, '===');
    console.log('  timestamp:', e.timestamp, '| duration:', e.durationMs+'ms');
    console.log('  artStyle:', e.artStyle, '| clothingCategory:', e.clothingCategory, '| sheetFormat:', e.sheetFormat);
    console.log('  success:', e.success, '| attempt:', e.attempt);
    console.log('  faceMatchScore:', e.faceMatchScore, '| clothingMatchScore:', e.clothingMatchScore);
    console.log('  faceMatchDetails:', e.faceMatchDetails?.slice(0, 200));
    console.log('  clothingMatchReason:', e.clothingMatchReason?.slice(0, 200));
    console.log('  warning:', e.warning);
    console.log('  combinedScore:', e.combinedScore);
    console.log('  ALL KEYS:', Object.keys(e).sort().join(','));
    if (e.passes) {
      console.log('  pass1: selected#'+e.passes.pass1?.selectedAttempt+' score='+e.passes.pass1?.finalScore+' attempts='+(e.passes.pass1?.attempts?.length || 0));
      console.log('  pass2:', e.passes.pass2 ? 'selected#'+e.passes.pass2.selectedAttempt+' score='+e.passes.pass2.finalScore : 'skipped');
    }
    console.log('  prompt first 200:', e.prompt?.slice(0, 200));
    console.log('');
  }
  await pool.end();
})().catch(e => { console.error('ERR:', e); process.exit(1); });
