// Inspect consolidator calls stored in the consolidator_calls table.
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

  const page = pageStr ? parseInt(pageStr, 10) : null;
  const round = roundStr ? parseInt(roundStr, 10) : null;

  if (page != null && round != null) {
    const r = await pool.query(
      `SELECT full_prompt, raw_response, plan, usage, created_at
       FROM consolidator_calls
       WHERE story_id = $1 AND page_number = $2 AND round = $3
       ORDER BY created_at DESC
       LIMIT 1`,
      [storyId, page, round]
    );
    if (!r.rows[0]) { console.log(`No call found for page ${page} round ${round}`); process.exit(0); }
    const c = r.rows[0];
    console.log('='.repeat(90));
    console.log(`CALL  page ${page}  round ${round}  @ ${c.created_at}`);
    console.log('='.repeat(90));
    console.log('\n--- FULL PROMPT (input to Haiku) ---');
    console.log(c.full_prompt);
    console.log('\n--- RAW HAIKU RESPONSE ---');
    console.log(c.raw_response);
    console.log('\n--- PARSED PLAN ---');
    console.log(JSON.stringify(c.plan, null, 2));
    console.log('\n--- USAGE ---');
    console.log(JSON.stringify(c.usage, null, 2));
    process.exit(0);
  }

  // Otherwise list calls (optionally filtered by page)
  const r = await pool.query(
    `SELECT page_number, round, plan, created_at
     FROM consolidator_calls
     WHERE story_id = $1 ${page != null ? 'AND page_number = $2' : ''}
     ORDER BY page_number, round, created_at`,
    page != null ? [storyId, page] : [storyId]
  );
  if (r.rows.length === 0) { console.log('No consolidator calls stored for this story.'); process.exit(0); }

  console.log(`${r.rows.length} consolidator call(s) for ${storyId}${page != null ? ` page ${page}` : ''}:\n`);
  for (const c of r.rows) {
    const plan = c.plan;
    const planSummary = plan
      ? `${plan.per_character_fixes?.length || 0} per-char, scene=${plan.scene_fix?.severity || 'NONE'}, ${plan.dropped_issues?.length || 0} dropped`
      : '(no plan)';
    console.log(`  page ${c.page_number}  round ${c.round ?? '?'}  ${c.created_at.toISOString()}  —  ${planSummary}`);
  }
  console.log('\nRun with `<page> <round>` to see full IO.');
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
