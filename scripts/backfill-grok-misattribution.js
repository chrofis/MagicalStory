/**
 * Backfill: move misattributed gemini_image calls back to grok where they belong.
 *
 * Bug history: the unified repair pipeline tracked iterate/inpaint usage as 'gemini_image'
 * regardless of the actual model. For stories using Grok (default), these calls actually
 * cost $0.02/call (Grok) but were recorded as $0.04 Gemini calls.
 *
 * For each story:
 * - If grok was used as the page image backend (any byFunction.page_images.provider === 'grok'),
 *   assume orphan gemini_image calls (those with no byFunction attribution) are actually grok.
 * - Move them: subtract from gemini_image counter, add to grok.calls and grok.direct_cost.
 */
const { Pool } = require('pg');

const CONN = process.env.DATABASE_URL || 'postgresql://postgres:CkudCnsnCYbUdHxztMaHklimyMZCJAqJ@turntable.proxy.rlwy.net:26087/railway';
const pool = new Pool({ connectionString: CONN, ssl: { rejectUnauthorized: false } });

(async () => {
  try {
    const r = await pool.query("SELECT id, data->'tokenUsage' as token_usage FROM stories WHERE data->'tokenUsage' IS NOT NULL");
    console.log('Found', r.rows.length, 'stories with tokenUsage');

    let updated = 0;
    let totalCallsMoved = 0;
    let totalCostShifted = 0;

    for (const row of r.rows) {
      const tu = row.token_usage;
      if (!tu) continue;

      // Did this story use grok as the page image backend?
      const grokIsPageBackend = tu.byFunction?.page_images?.provider === 'grok' ||
                                tu.byFunction?.cover_images?.provider === 'grok';
      if (!grokIsPageBackend) continue;

      const geminiImageCalls = tu.gemini_image?.calls || 0;
      if (geminiImageCalls === 0) continue;

      // These are the orphan iterate/inpaint calls — assume they were actually grok
      // (each call cost $0.02, not the $0.04 Gemini we billed).
      const grokCost = geminiImageCalls * 0.02;

      // Move calls from gemini_image to grok
      tu.gemini_image.calls = 0;
      tu.gemini_image.input_tokens = 0;
      tu.gemini_image.output_tokens = 0;
      tu.gemini_image.thinking_tokens = 0;

      if (!tu.grok) tu.grok = { calls: 0, direct_cost: 0 };
      tu.grok.calls = (tu.grok.calls || 0) + geminiImageCalls;
      tu.grok.direct_cost = (tu.grok.direct_cost || 0) + grokCost;

      // Also bump page_images byFunction (best-effort attribution)
      if (tu.byFunction?.page_images) {
        tu.byFunction.page_images.calls = (tu.byFunction.page_images.calls || 0) + geminiImageCalls;
        tu.byFunction.page_images.direct_cost = (tu.byFunction.page_images.direct_cost || 0) + grokCost;
      }

      await pool.query("UPDATE stories SET data = jsonb_set(data, '{tokenUsage}', $1::jsonb) WHERE id = $2",
        [JSON.stringify(tu), row.id]);

      updated++;
      totalCallsMoved += geminiImageCalls;
      totalCostShifted += grokCost;
      console.log('  ' + row.id.substring(0, 30) + ' → moved ' + geminiImageCalls + ' calls, shifted $' + grokCost.toFixed(4));
    }

    console.log('\nUpdated', updated, 'stories');
    console.log('Total calls moved:', totalCallsMoved);
    console.log('Total Grok cost shifted:', '$' + totalCostShifted.toFixed(4));
    console.log('Gemini cost reduced by:', '$' + (totalCallsMoved * 0.04).toFixed(4));
  } catch (e) {
    console.error('ERROR:', e.message);
  } finally {
    await pool.end();
    process.exit(0);
  }
})();
