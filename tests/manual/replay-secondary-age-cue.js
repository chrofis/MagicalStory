// Replay buildImagePrompt over STORED pages (read-only DB, no model calls) and
// count the pages whose AGE & PROPORTIONS block gains an invented character.
// Usage: node tests/manual/replay-secondary-age-cue.js [limitStories] [baseCommit=HEAD~1]
// The 'before' builder is `git show <baseCommit>:server/lib/promptBuilders.js` written to a temp sibling file.
require('dotenv').config();
const path = require('path');
const { Pool } = require('pg');
const ROOT = path.join(__dirname, '..', '..');
const limit = parseInt(process.argv[2] || '15', 10);
const fs = require('fs');
const beforePath = path.join(ROOT, 'server/lib/promptBuilders.BEFORE_tmp.js');
fs.writeFileSync(beforePath, require('child_process').execSync(`git show ${process.argv[3] || 'HEAD~1'}:server/lib/promptBuilders.js`, { cwd: ROOT, maxBuffer: 1 << 28 }));
process.on('exit', () => { try { fs.unlinkSync(beforePath); } catch {} });
(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const { loadPromptTemplates } = require(path.join(ROOT, 'server/services/prompts'));
  await loadPromptTemplates();
  const after = require(path.join(ROOT, 'server/lib/promptBuilders'));
  const before = require(beforePath);
  const rows = (await pool.query(`select id, data->'sceneDescriptions' sd, data->'characters' ch, data->'visualBible' vb, data->>'artStyle' st, data->>'language' lg from stories where jsonb_typeof(data->'visualBible'->'secondaryCharacters')='array' and jsonb_array_length(data->'visualBible'->'secondaryCharacters')>0 and jsonb_typeof(data->'sceneDescriptions')='array' order by created_at desc limit $1`, [limit])).rows;
  await pool.end();
  let pages = 0, withSecondary = 0, gained = 0, changedClean = 0, cleanPages = 0, shown = 0;
  const ageBlock = (p) => { const m = p.match(/AGE & PROPORTIONS[^\n]*\n([\s\S]*?)(?:\n\n|$)/); return m ? m[1] : ''; };
  for (const r of rows) {
    const sec = (r.vb.secondaryCharacters || []);
    for (const s of r.sd) {
      const desc = s.description || s.sceneDescription || '';
      if (!desc) continue;
      const names = (r.ch || []).filter(c => c.name && desc.includes(c.name));
      const inputData = { characters: r.ch, artStyle: r.st || 'watercolor', language: r.lg || 'de', ageFrom: 3, ageTo: 8, languageLevel: 'standard' };
      let b, a;
      try {
        b = before.buildImagePrompt(desc, inputData, names, r.vb, s.pageNumber, null, {});
        a = after.buildImagePrompt(desc, inputData, names, r.vb, s.pageNumber, null, {});
      } catch (e) { console.log('ERR', r.id, s.pageNumber, e.message); continue; }
      pages++;
      const named = sec.filter(e => (e.name && desc.includes(e.name)) || (e.id && desc.includes(e.id)) || (e.appearsInPages || e.pages || []).includes(s.pageNumber));
      if (named.length === 0) { cleanPages++; if (a !== b) { changedClean++; console.log('CLEAN PAGE CHANGED', r.id, s.pageNumber); } continue; }
      withSecondary++;
      const gain = named.some(e => ageBlock(a).includes(e.name) && !ageBlock(b).includes(e.name));
      if (gain) gained++;
      if (gain && shown < 3) {
        shown++;
        console.log(`\n--- ${r.id} p${s.pageNumber} (${named.map(e=>e.name+' age '+e.age).join(', ')})\nBEFORE age block: ${JSON.stringify(ageBlock(b))}\nAFTER  age block: ${JSON.stringify(ageBlock(a))}`);
      }
    }
  }
  console.log(`\nstories=${rows.length} pages=${pages} pagesWithInventedCast=${withSecondary} gainedAgeCue=${gained} cleanPages=${cleanPages} cleanPagesChanged=${changedClean}`);
})().catch(e => { console.error(e); process.exit(1); });
