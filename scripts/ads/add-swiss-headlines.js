#!/usr/bin/env node
/**
 * Add the user-approved personalization + Swiss-setting headlines to every
 * responsive search ad in Search-Deutschschweiz-v1, keeping existing headlines.
 * Angle: a PERSONAL story (your child as hero) that takes place in Switzerland —
 * not a generic "Schweizer Kinderbuch".
 *
 * Usage:
 *   node scripts/ads/add-swiss-headlines.js          # dry-run
 *   node scripts/ads/add-swiss-headlines.js --apply
 */
const { getClient } = require('./lib/client');

const APPLY = process.argv.includes('--apply');

const NEW_HEADLINES = [
  'Dein Kind ist der Held',
  'Ein Abenteuer in deiner Stadt',
  'Das Buch, das es nie vergisst',
  'In 3 Minuten zum Helden',
  'Foto rein, Abenteuer raus',
  'Dein Kind, die Hauptfigur',
  'Nur für dein Kind gemacht',
];

async function main() {
  const { customer } = getClient();
  console.log(`Mode: ${APPLY ? '🔴 LIVE' : '🟡 DRY-RUN (pass --apply)'}\n`);

  const ads = await customer.query(`
    SELECT ad_group_ad.ad.resource_name, ad_group_ad.ad.id,
           ad_group_ad.ad.responsive_search_ad.headlines,
           ad_group_ad.ad.responsive_search_ad.descriptions
    FROM ad_group_ad
    WHERE campaign.name='Search-Deutschschweiz-v1' AND ad_group_ad.status != 'REMOVED'
      AND ad_group_ad.ad.type = 'RESPONSIVE_SEARCH_AD'
  `);

  const ops = [];
  for (const r of ads) {
    const ad = r.ad_group_ad.ad;
    const existing = (ad.responsive_search_ad.headlines || []).map(h => h.text);
    const seen = new Set(existing.map(t => t.toLowerCase()));
    const toAdd = NEW_HEADLINES.filter(t => !seen.has(t.toLowerCase()));
    // RSA cap is 15 headlines.
    const merged = [...existing, ...toAdd].slice(0, 15).map(text => ({ text }));
    console.log(`Ad ${ad.id}: ${existing.length} → ${merged.length} headlines (+${merged.length - existing.length})`);
    for (const t of toAdd) console.log('   +', t);
    ops.push({
      resource_name: ad.resource_name,
      responsive_search_ad: {
        headlines: merged,
        descriptions: ad.responsive_search_ad.descriptions, // unchanged
      },
    });
  }

  if (!APPLY) { console.log('\n🟡 Dry run — nothing sent.'); return; }
  await customer.ads.update(ops);
  console.log(`\n✅ Updated ${ops.length} responsive search ad(s).`);
}

main().catch((e) => { console.error('ERR:', e.message, JSON.stringify(e && e.errors || '').slice(0, 400)); process.exit(1); });
