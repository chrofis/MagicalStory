// Regenerate Ethan's comic 2x4 sheet 3x with the updated Pass-2 clean-render
// eval, to measure score variance and whether painted sheets now get caught.
// Reads the character from the STAGING DB (read-only), writes images to
// tests/fixtures/. Usage: node tests/manual/test-ethan-sheet-3x.js
require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const { loadPromptTemplates } = require('../../server/services/prompts');
const { generateCharacter2x4Sheet } = require('../../server/lib/character2x4Sheet');

(async () => {
  await loadPromptTemplates(); // server does this at startup; standalone must too
  const pool = new Pool({ connectionString: process.env.STAGING_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const u = await pool.query('SELECT id FROM users WHERE username = $1', ['demo-m-hozv9@magicalstory.ch']);
  const c = await pool.query('SELECT data FROM characters WHERE user_id = $1', [u.rows[0].id]);
  await pool.end();
  const all = Array.isArray(c.rows[0]?.data) ? c.rows[0].data
    : (c.rows[0]?.data?.characters || []);
  const character = all.find(ch => ch && ch.name === 'Ethan');
  if (!character) throw new Error('Ethan not found in ' + JSON.stringify(all.map(ch => ch?.name)));
  console.log('Character: Ethan | age:', character.age, '| photos:', Object.keys(character.photos || {}).join(','), '| avatars:', Object.keys(character.avatars || {}).join(','));

  for (let run = 1; run <= 3; run++) {
    console.log(`\n================ RUN ${run}/3 ================`);
    const t0 = Date.now();
    try {
      const res = await generateCharacter2x4Sheet(character, {
        artStyle: 'comic',
        clothingCategory: 'standard',
        costumeDescription: 'standard outfit',
      });
      const dur = ((Date.now() - t0) / 1000).toFixed(0);
      const strip = (s) => (typeof s === 'string' && s.startsWith('data:')) ? s : `data:image/jpeg;base64,${s}`;
      fs.writeFileSync(`tests/fixtures/ethan-sheet-run${run}.jpg`,
        Buffer.from(String(res.imageData).replace(/^data:image\/[^;]+;base64,/, ''), 'base64'));
      console.log(`RUN ${run} done in ${dur}s | finalScore=${res.finalScore}`);
      for (const passName of ['pass1', 'pass2']) {
        const p = res.passes?.[passName];
        if (!p) { console.log(` ${passName}: (none)`); continue; }
        console.log(` ${passName}: finalScore=${p.finalScore}`);
        for (const a of p.attempts || []) {
          console.log(`   attempt ${a.attempt}: stage=${a.stage} score=${a.score}` +
            ` layout=${a.layoutScore ?? '-'} identity=${a.identityScore ?? '-'}` +
            (a.styleScore !== undefined ? ` style=${a.styleScore}` : '') +
            (a.outfitScore !== undefined ? ` outfit=${a.outfitScore}` : '') +
            (a.sourceMatchScore !== undefined ? ` srcMatch=${a.sourceMatchScore}` : '') +
            ` clean=${a.cleanScore ?? '-'}` +
            (a.reasons?.length ? ` | reasons: ${a.reasons.join('; ').slice(0, 160)}` : ''));
        }
      }
    } catch (e) {
      console.log(`RUN ${run} FAILED: ${e.message}`);
    }
  }
  console.log('\nAll runs complete. Images: tests/fixtures/ethan-sheet-run{1,2,3}.jpg');
  process.exit(0);
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
