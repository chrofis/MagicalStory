#!/usr/bin/env node
/**
 * One-shot helper: create the 'Trial Email Submitted' conversion action
 * for the MagicalStory account. Returns the conversion's send_to ID, which
 * is what you fire from the site via gtag('event', 'conversion', { send_to: ... }).
 *
 * Already-existing 'Page view' conversion (id 7523328660) is reused for
 * /try landing fires. This script only creates the new email-submit one.
 *
 * Usage: node scripts/ads/create-conversion-actions.js
 */
const { getClient } = require('./lib/client');
const { enums } = require('google-ads-api');

const NAME = 'Trial Email Submitted';

async function main() {
  const { customer } = getClient();

  // Skip if it already exists (idempotent)
  const existing = await customer.query(`
    SELECT conversion_action.id, conversion_action.resource_name, conversion_action.status
    FROM conversion_action
    WHERE conversion_action.name = '${NAME}' AND conversion_action.status != 'REMOVED'
  `);
  if (existing.length) {
    console.log(`✓ Already exists: ${existing[0].conversion_action.resource_name} (status ${existing[0].conversion_action.status})`);
    console.log('To get the send_to ID, query its tag_snippets:');
    console.log(`  SELECT conversion_action.tag_snippets FROM conversion_action WHERE conversion_action.id = ${existing[0].conversion_action.id}`);
    return;
  }

  const op = {
    name: NAME,
    type: enums.ConversionActionType.WEBPAGE,
    category: enums.ConversionActionCategory.SUBMIT_LEAD_FORM,
    status: enums.ConversionActionStatus.ENABLED,
    counting_type: enums.ConversionActionCountingType.ONE_PER_CLICK, // 1 conversion per ad click (qualified lead)
    primary_for_goal: true,                                            // optimize bidding toward this
    click_through_lookback_window_days: 30,
    view_through_lookback_window_days: 1,
    value_settings: {
      default_value: 5.0,        // CHF 5 — proxy value for a qualified email lead
      default_currency_code: 'CHF',
      always_use_default_value: true,
    },
  };

  const res = await customer.conversionActions.create([op]);
  const rn = res.results[0].resource_name;
  const id = rn.split('/').pop();
  console.log(`✓ Created: ${rn}`);

  // Fetch the freshly created action with its tag_snippets to get the send_to ID
  const r = await customer.query(`
    SELECT conversion_action.tag_snippets
    FROM conversion_action WHERE conversion_action.id = ${id}
  `);
  const snippets = r[0].conversion_action.tag_snippets;
  // Find the WEBPAGE event_snippet (type 2 = HTML, page_format 2 = standard webpage)
  const html = snippets.find(s => s.type === 2 && s.page_format === 2);
  if (html?.event_snippet) {
    const match = html.event_snippet.match(/'send_to':\s*'([^']+)'/);
    if (match) {
      console.log();
      console.log(`📋 send_to ID for the new conversion: ${match[1]}`);
      console.log(`   Use this in: gtag('event', 'conversion', { send_to: '${match[1]}', value: 5.0, currency: 'CHF' })`);
    }
  }
}

main().catch(e => {
  console.error('❌ Failed:', e.message);
  if (e.errors) console.error(JSON.stringify(e.errors, null, 2));
  process.exit(1);
});
