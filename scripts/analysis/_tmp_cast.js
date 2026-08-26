require('dotenv').config();
const { Pool } = require('pg');

const target = process.argv[2];
const cs = target === 'prod' ? process.env.DATABASE_URL : process.env.STAGING_DATABASE_URL;
const jobId = process.argv[3];
const want = process.argv.slice(4).map(Number);

(async () => {
  const pool = new Pool({ connectionString: cs, ssl: { rejectUnauthorized: false } });
  const j = await pool.query('SELECT result_data, input_data FROM story_jobs WHERE id = $1', [jobId]);
  const rd = j.rows[0].result_data || {};
  const input = j.rows[0].input_data || {};
  const vb = rd.visualBible || {};

  console.log('\nstory characters (have avatars):',
    (input.characters || []).map(c => c.name).join(', ') || '(none in input_data)');
  console.log('VB secondaryCharacters:', JSON.stringify(
    (vb.secondaryCharacters || []).map(s => ({ id: s.id, name: s.name, hasRef: !!(s.referenceImageUrl || s.referenceImageData) }))));

  const avatars = rd.styledAvatarGeneration || rd.characterAvatars || null;
  console.log('styled avatar keys    :', avatars ? Object.keys(avatars).slice(0, 8).join(', ') : '(none)');

  const known = new Set((input.characters || []).map(c => String(c.name).toLowerCase()));
  for (const p of (rd.sceneImages || [])) {
    if (!want.includes(p.pageNumber)) continue;
    const chars = p.sceneMetadata?.fullData?.characters || [];
    console.log(`\np${p.pageNumber} cast resolvability:`);
    for (const c of chars) {
      const isUser = known.has(String(c.name).toLowerCase());
      const vbHit = (vb.secondaryCharacters || []).find(s =>
        String(s.name).toLowerCase().includes(String(c.name).toLowerCase())
        || String(c.name).toLowerCase().includes(String(s.name).toLowerCase()));
      console.log(`   ${String(c.name).padEnd(16)} userCharacter=${isUser}  vbSecondary=${vbHit ? vbHit.id + (vbHit.referenceImageUrl ? ' (has ref)' : ' (NO REF)') : 'no'}`);
    }
  }
  await pool.end();
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
