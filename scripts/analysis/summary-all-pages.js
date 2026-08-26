// Compact per-page summary for a story: what was requested, repairs, final score.
require('dotenv').config();
const { Pool } = require('pg');
(async () => {
  const storyId = process.argv[2];
  if (!storyId) { console.error('Usage: node summary-all-pages.js <storyId>'); process.exit(1); }
  const dbUrl = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  const pool = new Pool({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  const r = await pool.query('SELECT data FROM stories WHERE id = $1', [storyId]);
  if (!r.rows[0]) { console.error('not found'); process.exit(1); }
  const d = r.rows[0].data || {};
  const scenes = (d.sceneImages || []).sort((a,b) => (a.pageNumber||0) - (b.pageNumber||0));
  console.log(`Story: ${d.title || d.storyTitle || '(untitled)'}  ${scenes.length} pages  job ${storyId}`);
  console.log('='.repeat(90));
  for (const s of scenes) {
    const pn = s.pageNumber;
    console.log(`\n┌── PAGE ${pn} ─────────────────────────────────────────────────────────────────`);
    // Parse hint for character clothing
    let hint = null;
    try { hint = typeof s.outlineExtract === 'string' ? JSON.parse(s.outlineExtract) : s.outlineExtract; } catch {}
    const chars = (hint?.characters || []).map(c => `${c.name}:${c.clothing || '?'}${c.perspective ? '/' + c.perspective : ''}${c.depth ? '/' + c.depth : ''}`).join(', ');
    const desc = hint?.description || '(no hint)';
    console.log(`  Hint: ${desc}`);
    console.log(`  Chars: ${chars}`);
    if (hint?.objects?.length) console.log(`  Objects: ${hint.objects.join(', ')}`);
    if (hint?.background) console.log(`  Background: ${hint.background}`);
    const rh = s.retryHistory || [];
    const versions = s.imageVersions || [];
    console.log(`  Final: quality=${s.qualityScore ?? '?'} semantic=${s.semanticScore ?? '?'} verdict=${s.verdict?.verdict || s.verdict || '?'}`);
    if (rh.length > 0) {
      console.log(`  Repair rounds: ${rh.length}`);
      for (const [i, r] of rh.entries()) {
        const score = r.score ?? r.finalScore ?? '?';
        const src = r.source || r.type || '?';
        console.log(`    [${i}] ${src} → score ${score}`);
      }
    }
    if (s.fixTargets?.length) {
      console.log(`  Last fix targets:`);
      for (const f of s.fixTargets.slice(0, 3)) {
        console.log(`    - [${f.severity || '?'}] ${f.type || ''}: ${(f.issue || f.description || '').slice(0, 120)}`);
      }
    }
    // Character fix applied?
    const hasCharFix = versions.some(v => v.type === 'entity-repair' || (v.source || '').includes('character-fix'));
    if (hasCharFix) console.log(`  🛠  Character-fix repair applied`);
  }
  console.log('\n' + '='.repeat(90));
  // Summary stats
  const redoneCount = scenes.filter(s => (s.retryHistory || []).length > 0).length;
  const avgFinal = scenes.reduce((a, s) => a + (s.qualityScore || 0), 0) / scenes.length;
  console.log(`SUMMARY: ${redoneCount}/${scenes.length} pages had repairs, avg final score ${avgFinal.toFixed(0)}`);
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
