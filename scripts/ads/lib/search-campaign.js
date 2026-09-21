/**
 * Shared engine for the cheap Manual-CPC Search campaigns (Search-Cheap-Age-CH,
 * Search-Cheap-Occasion-CH, Search-LifeChallenge-CH).
 *
 * Extracted verbatim from scripts/ads/create-search-cheap.js (2026-09-09) so the three campaigns
 * are three SPECS against one engine, not three copies that drift. Behaviour is unchanged:
 * dry-run by default, idempotent by name, campaign created PAUSED.
 *
 * A spec is: { name, budgetName, dailyBudgetMicros, maxCpcMicros, geoSource, languageConstant,
 *              site, utm, adGroups: [{ name, lp, path:[p1,p2], copy:{headlines[15],descriptions[4]}, keywords[] }],
 *              negatives: [string | {text,match}] }
 */
const { getClient } = require('./client');
const { enums } = require('google-ads-api');

const CHF = n => Math.round(n * 1e6);
const LIMITS = { headline: 30, description: 90, path: 15 };

function normaliseNegatives(list) {
  return list.map(n => (typeof n === 'string' ? { text: n, match: 'BROAD' } : n));
}

function validate(spec) {
  const problems = [];
  const check = (kind, text, max) => {
    if (text.length > max) problems.push(`${kind} "${text}" is ${text.length} chars (max ${max})`);
    if (/ß/.test(text)) problems.push(`${kind} "${text}" uses eszett (Swiss spelling: ss)`);
    if (/["“”„]/.test(text)) problems.push(`${kind} "${text}" uses straight/curly quotes (use guillemets)`);
    if (kind === 'headline' && /!/.test(text)) problems.push(`headline "${text}" contains ! (not allowed)`);
  };
  const seenKw = new Map();
  for (const g of spec.adGroups) {
    g.copy.headlines.forEach(h => check('headline', h, LIMITS.headline));
    g.copy.descriptions.forEach(d => check('description', d, LIMITS.description));
    g.path.forEach(p => check('path', p, LIMITS.path));
    if (g.copy.headlines.length !== 15) problems.push(`${g.name}: ${g.copy.headlines.length} headlines (need 15)`);
    if (g.copy.descriptions.length !== 4) problems.push(`${g.name}: ${g.copy.descriptions.length} descriptions (need 4)`);
    if (new Set(g.copy.headlines.map(h => h.toLowerCase())).size !== g.copy.headlines.length) problems.push(`${g.name}: duplicate headlines`);
    for (const k of g.keywords) {
      if (/ß/.test(k)) problems.push(`keyword "${k}" uses eszett`);
      if (seenKw.has(k)) problems.push(`keyword "${k}" in both ${seenKw.get(k)} and ${g.name}`);
      seenKw.set(k, g.name);
      if (spec.negatives.some(n => n.match === 'BROAD' && new RegExp(`(^|\\s)${n.text}(\\s|$)`).test(k))) problems.push(`keyword "${k}" is blocked by a negative`);
    }
  }
  if (problems.length) { console.error('VALIDATION FAILED:\n  ' + problems.join('\n  ')); process.exit(1); }
}

async function run(spec, APPLY) {
  spec.negatives = normaliseNegatives(spec.negatives);
  validate(spec);

  const MODE = APPLY ? 'LIVE' : 'DRY';
  let opCount = 0, skipCount = 0;
  async function op(label, detail, fn) {
    opCount++;
    console.log(`  [${MODE}] ${label}`);
    for (const l of detail) console.log('    ' + l);
    if (!APPLY) return null;
    const res = await fn();
    const rn = res && res.results && res.results[0] && res.results[0].resource_name;
    console.log(`    ok ${rn || ''}`);
    return rn;
  }
  function skip(label, why) { skipCount++; console.log(`  [SKIP] ${label} - ${why}`); }
  const q = s => String(s).replace(/'/g, "\\'");
  const enumName = (en, v) => (typeof v === 'string' ? v : (enums[en] && enums[en][v]) || String(v));

  const { customer } = getClient();
  if (!customer) throw new Error('Missing refresh_token in scripts/ads/config.json');
  console.log(`Campaign: ${spec.name}`);
  console.log(`Budget: CHF ${(spec.dailyBudgetMicros / 1e6).toFixed(2)}/day - max CPC CHF ${(spec.maxCpcMicros / 1e6).toFixed(2)}`);
  console.log(`Mode: ${APPLY ? 'LIVE - creates the campaign PAUSED' : 'DRY-RUN - nothing is sent (pass --apply to execute)'}\n`);

  // -- Geo list from the existing campaign (read-only) --
  const geoRows = await customer.query(`
    SELECT campaign.id, campaign_criterion.location.geo_target_constant FROM campaign_criterion
    WHERE campaign.name='${q(spec.geoSource)}' AND campaign_criterion.type='LOCATION' AND campaign_criterion.negative=false`);
  const geos = geoRows.map(r => r.campaign_criterion.location.geo_target_constant);
  if (!geos.length) throw new Error(`No location criteria found on ${spec.geoSource}`);
  const geoNames = await customer.query(`SELECT geo_target_constant.resource_name, geo_target_constant.name FROM geo_target_constant WHERE geo_target_constant.resource_name IN (${geos.map(g => `'${g}'`).join(',')})`);
  const nameOf = new Map(geoNames.map(r => [r.geo_target_constant.resource_name, r.geo_target_constant.name]));
  console.log(`Geo (from ${spec.geoSource}, ${geos.length} regions): ${geos.map(g => nameOf.get(g) || g).join(', ')}\n`);

  // -- Existing state (idempotency) --
  const camps = await customer.query(`SELECT campaign.id, campaign.resource_name, campaign.status FROM campaign WHERE campaign.name='${q(spec.name)}' AND campaign.status != 'REMOVED'`);
  const budgets = await customer.query(`SELECT campaign_budget.resource_name FROM campaign_budget WHERE campaign_budget.name='${q(spec.budgetName)}' AND campaign_budget.status != 'REMOVED'`);
  let campaignRn = camps[0] && camps[0].campaign.resource_name;
  const existing = { adGroups: new Map(), keywords: new Set(), rsas: new Set(), negatives: new Set(), geos: new Set(), lang: false };
  if (campaignRn) {
    const cid = camps[0].campaign.id;
    for (const r of await customer.query(`SELECT campaign.id, ad_group.name, ad_group.resource_name FROM ad_group WHERE campaign.id=${cid} AND ad_group.status != 'REMOVED'`)) existing.adGroups.set(r.ad_group.name, r.ad_group.resource_name);
    for (const r of await customer.query(`SELECT campaign.id, ad_group.name, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type FROM ad_group_criterion WHERE campaign.id=${cid} AND ad_group_criterion.type='KEYWORD' AND ad_group_criterion.negative=false AND ad_group_criterion.status != 'REMOVED'`))
      existing.keywords.add(`${r.ad_group.name}|${r.ad_group_criterion.keyword.text.toLowerCase()}|${enumName('KeywordMatchType', r.ad_group_criterion.keyword.match_type)}`);
    for (const r of await customer.query(`SELECT campaign.id, ad_group.name FROM ad_group_ad WHERE campaign.id=${cid} AND ad_group_ad.status != 'REMOVED' AND ad_group_ad.ad.type='RESPONSIVE_SEARCH_AD'`)) existing.rsas.add(r.ad_group.name);
    for (const r of await customer.query(`SELECT campaign.id, campaign_criterion.type, campaign_criterion.negative, campaign_criterion.keyword.text, campaign_criterion.location.geo_target_constant, campaign_criterion.language.language_constant FROM campaign_criterion WHERE campaign.id=${cid} AND campaign_criterion.status != 'REMOVED'`)) {
      const c = r.campaign_criterion;
      if (c.keyword && c.negative) existing.negatives.add(c.keyword.text.toLowerCase());
      if (c.location) existing.geos.add(c.location.geo_target_constant);
      if (c.language) existing.lang = true;
    }
  }

  // -- 1. Budget + campaign --
  console.log('=== 1. Budget + campaign');
  let budgetRn = budgets[0] && budgets[0].campaign_budget.resource_name;
  if (budgetRn) skip(`campaign_budgets.create ${spec.budgetName}`, `exists (${budgetRn})`);
  else budgetRn = (await op(`campaign_budgets.create ${spec.budgetName}`, [`amount_micros=${spec.dailyBudgetMicros} (CHF ${(spec.dailyBudgetMicros / 1e6).toFixed(2)}/day) delivery_method=STANDARD explicitly_shared=false`],
    () => customer.campaignBudgets.create([{ name: spec.budgetName, amount_micros: spec.dailyBudgetMicros, delivery_method: enums.BudgetDeliveryMethod.STANDARD, explicitly_shared: false }]))) || `[NEW budget ${spec.budgetName}]`;
  if (campaignRn) skip(`campaigns.create ${spec.name}`, `exists (${campaignRn}, ${enumName('CampaignStatus', camps[0].campaign.status)})`);
  else {
    const o = {
      name: spec.name, status: enums.CampaignStatus.PAUSED, advertising_channel_type: enums.AdvertisingChannelType.SEARCH, campaign_budget: budgetRn,
      bidding_strategy_type: enums.BiddingStrategyType.MANUAL_CPC, manual_cpc: { enhanced_cpc_enabled: false },
      network_settings: { target_google_search: true, target_search_network: true, target_content_network: false, target_partner_search_network: false },
      contains_eu_political_advertising: enums.EuPoliticalAdvertisingStatus.DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING,
    };
    campaignRn = (await op(`campaigns.create ${spec.name}`, ['status=PAUSED channel=SEARCH bidding=MANUAL_CPC enhanced_cpc=false', `budget=${budgetRn}`, 'network: google search + search partners, no display'],
      () => customer.campaigns.create([o]))) || `[NEW campaign ${spec.name}]`;
  }
  console.log('');

  // -- 2. Geo + language --
  console.log('=== 2. Geo + language criteria');
  const geoOps = geos.filter(g => !existing.geos.has(g)).map(g => ({ campaign: campaignRn, negative: false, location: { geo_target_constant: g } }));
  if (!geoOps.length) skip('campaign_criteria.create locations', 'all present');
  else await op(`campaign_criteria.create x${geoOps.length} locations`, geoOps.map(o => `${o.location.geo_target_constant} (${nameOf.get(o.location.geo_target_constant) || '?'})`), () => customer.campaignCriteria.create(geoOps));
  if (existing.lang) skip('campaign_criteria.create language', 'present');
  else await op('campaign_criteria.create language', [`${spec.languageConstant} (German)`], () => customer.campaignCriteria.create([{ campaign: campaignRn, negative: false, language: { language_constant: spec.languageConstant } }]));
  console.log('');

  // -- 3. Ad groups --
  for (const g of spec.adGroups) {
    console.log(`=== 3. Ad group ${g.name} -> ${spec.site}${g.lp} (${g.keywords.length} keywords)`);
    let agRn = existing.adGroups.get(g.name);
    if (agRn) skip(`ad_groups.create ${g.name}`, `exists (${agRn})`);
    else agRn = (await op(`ad_groups.create ${g.name}`, [`campaign=${campaignRn} status=ENABLED type=SEARCH_STANDARD cpc_bid_micros=${spec.maxCpcMicros} (CHF ${(spec.maxCpcMicros / 1e6).toFixed(2)})`],
      () => customer.adGroups.create([{ name: g.name, campaign: campaignRn, status: enums.AdGroupStatus.ENABLED, type: enums.AdGroupType.SEARCH_STANDARD, cpc_bid_micros: spec.maxCpcMicros }]))) || `[NEW ad_group ${g.name}]`;

    const kwOps = g.keywords.filter(k => !existing.keywords.has(`${g.name}|${k}|PHRASE`)).map(text => ({ ad_group: agRn, status: enums.AdGroupCriterionStatus.ENABLED, keyword: { text, match_type: enums.KeywordMatchType.PHRASE } }));
    const kwSkipped = g.keywords.length - kwOps.length;
    if (kwSkipped) skip(`ad_group_criteria.create x${kwSkipped} keywords in ${g.name}`, 'exist');
    if (kwOps.length) await op(`ad_group_criteria.create x${kwOps.length} keywords in ${g.name}`, kwOps.map(o => `[PHRASE] "${o.keyword.text}"`), () => customer.adGroupCriteria.create(kwOps));

    const finalUrl = `${spec.site}${g.lp}?${spec.utm}`;
    if (existing.rsas.has(g.name)) skip(`ad_group_ads.create RSA in ${g.name}`, 'an RSA exists');
    else await op(`ad_group_ads.create RSA in ${g.name}`, [
      `ad_group=${agRn} status=ENABLED final_urls=[${finalUrl}] path=/${g.path[0]}/${g.path[1]}`,
      ...g.copy.headlines.map((h, i) => `H${String(i + 1).padStart(2)}: ${h} (${h.length})`),
      ...g.copy.descriptions.map((d, i) => `D${i + 1}: ${d} (${d.length})`),
    ], () => customer.adGroupAds.create([{
      ad_group: agRn, status: enums.AdGroupAdStatus.ENABLED,
      ad: { final_urls: [finalUrl], responsive_search_ad: { headlines: g.copy.headlines.map(text => ({ text })), descriptions: g.copy.descriptions.map(text => ({ text })), path1: g.path[0], path2: g.path[1] } },
    }]));
    console.log('');
  }

  // -- 4. Negatives --
  console.log(`=== 4. Campaign negatives (${spec.negatives.length})`);
  const negOps = spec.negatives.filter(n => !existing.negatives.has(n.text)).map(n => ({ campaign: campaignRn, negative: true, keyword: { text: n.text, match_type: enums.KeywordMatchType[n.match] } }));
  if (spec.negatives.length - negOps.length) skip(`campaign_criteria.create x${spec.negatives.length - negOps.length} negatives`, 'exist');
  if (negOps.length) await op(`campaign_criteria.create x${negOps.length} negatives`, negOps.map(o => `[${enumName('KeywordMatchType', o.keyword.match_type)}] "${o.keyword.text}"`), () => customer.campaignCriteria.create(negOps));
  console.log('');

  console.log(`${APPLY ? 'Sent' : 'Would send'} ${opCount} operation(s), skipped ${skipCount}.`);
  if (!APPLY) console.log('DRY-RUN - nothing was sent to Google Ads.');
  else console.log('Campaign created PAUSED - activate with scripts/ads/activate-week.js when the owner says so.');
}

module.exports = { run, validate, CHF, LIMITS };
