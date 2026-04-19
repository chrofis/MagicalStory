// Inspect consolidator calls stored in stories.data.consolidatorCalls[].
// Usage:
//   node scripts/analysis/inspect-consolidator-call.js <storyId>            # list all calls
//   node scripts/analysis/inspect-consolidator-call.js <storyId> <page>     # list calls for one page
//   node scripts/analysis/inspect-consolidator-call.js <storyId> <page> <round>  # show full IO

require('dotenv').config();
const { Pool } = require('pg');

(async () => {
  const [storyId, pageStr, roundStr] = process.argv.slice(2);
  if (!storyId) { console.error('Usage: inspect-consolidator-call.js <storyId> [page] [round]'); process.exit(1); }
  const pool = new Pool({ connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const r = await pool.query("SELECT data::jsonb->'consolidatorCalls' as calls FROM stories WHERE id = $1", [storyId]);
  if (!r.rows[0]) { console.error('story not found'); process.exit(1); }
  const calls = r.rows[0].calls || [];
  if (calls.length === 0) { console.log('No consolidator calls stored for this story.'); process.exit(0); }

  const page = pageStr ? parseInt(pageStr, 10) : null;
  const round = roundStr ? parseInt(roundStr, 10) : null;

  if (page != null && round != null) {
    const call = calls.find(c => c.pageNumber === page && c.round === round);
    if (!call) { console.log(`No call found for page ${page} round ${round}`); process.exit(0); }
    console.log('='.repeat(90));
    console.log(`CALL  page ${page}  round ${round}  @ ${call.timestamp}`);
    console.log('='.repeat(90));
    console.log('\n--- FULL PROMPT (input to Haiku) ---');
    console.log(call.fullPrompt);
    console.log('\n--- RAW HAIKU RESPONSE ---');
    console.log(call.rawResponse);
    console.log('\n--- PARSED PLAN ---');
    console.log(JSON.stringify(call.plan, null, 2));
    console.log('\n--- USAGE ---');
    console.log(JSON.stringify(call.usage, null, 2));
    process.exit(0);
  }

  // Otherwise list calls (optionally filtered by page)
  const filtered = page != null ? calls.filter(c => c.pageNumber === page) : calls;
  console.log(`${filtered.length} consolidator call(s) for ${storyId}${page != null ? ` page ${page}` : ''}:\n`);
  for (const c of filtered) {
    const planSummary = c.plan
      ? `${c.plan.per_character_fixes?.length || 0} per-char, scene=${c.plan.scene_fix?.severity || 'NONE'}, ${c.plan.dropped_issues?.length || 0} dropped`
      : '(no plan)';
    console.log(`  page ${c.pageNumber}  round ${c.round ?? '?'}  ${c.timestamp}  —  ${planSummary}`);
  }
  console.log('\nRun with `<page> <round>` to see full IO.');
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
