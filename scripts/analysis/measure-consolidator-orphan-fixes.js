// Read-only: count consolidator plans that carry a CRITICAL/MAJOR fix with no
// kept (scored) finding of that severity behind it.
//
// Before the 2026-10-04 `ids` contract a fix named no finding ids, so "behind it"
// is judged by declared type (+ character for per-character fixes) against the
// kept deduped_issues and the not-a-defect drops. Source: consolidator_calls
// (resolved plan, one row per page per round).
//
// Usage: node scripts/analysis/measure-consolidator-orphan-fixes.js [--env=staging|prod] [--since=2026-09-20] [--examples=10]
// DB urls come from .env (STAGING_DATABASE_URL / DATABASE_URL); MS_ENV_DIR points at the folder holding .env.
const path = require('path');
require('dotenv').config({ path: path.join(process.env.MS_ENV_DIR || path.resolve(__dirname, '../..'), '.env') });
const { Pool } = require('pg');
const { ch, fromPgNaive } = require('../lib/chTime');

const arg = (k, d) => (process.argv.find(a => a.startsWith(`--${k}=`)) || '').split('=')[1] || d;
const env = arg('env', 'staging');
const since = arg('since', '2026-09-20');
const nEx = parseInt(arg('examples', '10'), 10);
const url = env === 'prod' ? process.env.DATABASE_URL : process.env.STAGING_DATABASE_URL;
const NOT_A_DEFECT = ['profile_says_trait_is_correct', 'finding_contradicts_brief'];
const HI = ['CRITICAL', 'MAJOR'];
const sev = s => String(s || '').toUpperCase();
const norm = s => String(s || '').trim().toLowerCase();

(async () => {
  const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });
  let lastId = 0, rows = 0, withFix = 0;
  const counts = { fixesSeen: 0, critNoKeptCrit: 0, hiNoKeptHi: 0, hiAllTypesDropped: 0, hiNoKeptSameType: 0 };
  const examples = [];
  const stories = new Set();
  for (;;) {
    const r = await pool.query(
      `SELECT id, story_id, page_number, round, created_at, plan FROM consolidator_calls
       WHERE id > $1 AND created_at >= $2 ORDER BY id LIMIT 200`, [lastId, since]);
    if (!r.rows.length) break;
    for (const row of r.rows) {
      lastId = row.id; rows++;
      const plan = row.plan || {};
      const fixes = [];
      const sf = plan.scene_fix;
      if (sf && sf.instruction && HI.includes(sev(sf.severity))) fixes.push({ kind: 'scene_fix', sev: sev(sf.severity), text: sf.instruction, types: (sf.types || []).map(norm), character: null });
      for (const p of (plan.per_character_fixes || [])) if (HI.includes(sev(p.severity))) fixes.push({ kind: 'per_character', sev: sev(p.severity), text: p.fix_instruction, types: (p.types || []).map(norm), character: p.characterName });
      if (!fixes.length) continue;
      withFix++;
      const kept = Array.isArray(plan.deduped_issues) ? plan.deduped_issues : [];
      const dropped = (plan.dropped_issues || []).filter(d => NOT_A_DEFECT.some(c => norm(d.reason).replace(/^["'`\s]+/, '').startsWith(c)));
      const keptCrit = kept.some(k => sev(k.severity) === 'CRITICAL');
      const keptHi = kept.some(k => HI.includes(sev(k.severity)));
      for (const f of fixes) {
        counts.fixesSeen++;
        const critNoCrit = f.sev === 'CRITICAL' && !keptCrit;
        if (critNoCrit) counts.critNoKeptCrit++;
        if (!keptHi) counts.hiNoKeptHi++;
        const keptSame = kept.filter(k => f.types.includes(norm(k.type)) && (!f.character || !k.character || norm(k.character) === norm(f.character)));
        const droppedSame = dropped.filter(d => f.types.includes(norm(d.type)) || (f.character && norm(d.character) === norm(f.character)));
        const noSame = f.types.length > 0 && keptSame.length === 0;
        if (noSame) counts.hiNoKeptSameType++;
        const allDropped = noSame && droppedSame.length > 0;
        if (allDropped) counts.hiAllTypesDropped++;
        if (!keptHi || allDropped || critNoCrit) {
          stories.add(row.story_id);
          examples.push({
            where: `${row.story_id} p${row.page_number} r${row.round} call#${row.id} ${ch(fromPgNaive(row.created_at))}`,
            fix: `${f.kind} ${f.sev} types=[${f.types}] "${f.text}"`,
            kept: kept.map(k => `${sev(k.severity)}/${k.type}`).join(', ') || '(none)',
            dropped: dropped.map(d => `[${d.reason}] ${d.type}/${d.character}: ${d.issue}`),
            flags: { noKeptHiAtAll: !keptHi, allTypesDropped: allDropped, critNoKeptCrit: critNoCrit },
          });
        }
      }
    }
  }
  console.log(JSON.stringify({ env, since, callsScanned: rows, callsWithHiFix: withFix, ...counts, flaggedFixes: examples.length, flaggedStories: stories.size }, null, 1));
  for (const e of examples.slice(0, nEx)) console.log(JSON.stringify(e, null, 1));
  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
