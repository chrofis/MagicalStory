#!/usr/bin/env node
/**
 * READ-ONLY Google Ads account audit for Search-Deutschschweiz-v1 (GAQL only, no mutates).
 *
 *   node scripts/ads/audit-account.js                       # default campaign
 *   node scripts/ads/audit-account.js --campaign=<name>     # another search campaign
 *   node scripts/ads/audit-account.js --since=2026-01-01 > tasks/ads-audit-YYYY-MM-DD.md
 *
 * Prints (Markdown):
 *  1. Ad groups → keywords (text, match type, status, max CPC) + QS and its 3 components
 *  2. Every RSA per ad group: headline/description counts, pinned fields, texts, ad strength
 *  3. Assets linked at customer / campaign / ad-group level, grouped by type
 *  4. Campaign-level negative keywords (+ shared negative lists)
 *  5. Conversion actions + which are biddable (customer_conversion_goal)
 *
 * Any field that this account cannot query is reported as such in the output, never guessed.
 */
const { getClient } = require('./lib/client');
const { enums } = require('google-ads-api');

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = a.match(/^--([^=]+)=(.*)$/);
  return m ? [m[1], m[2]] : [a.replace(/^--/, ''), 'true'];
}));
const CAMPAIGN = args.campaign || 'Search-Deutschschweiz-v1';
const SINCE = args.since || '2026-01-01'; // paused campaigns show 0 in LAST_30_DAYS; history needs an explicit range
const TODAY = new Date().toISOString().slice(0, 10);
const RANGE = `segments.date BETWEEN '${SINCE}' AND '${TODAY}'`;

const BUCKET = { 0: 'unspecified', 1: 'unknown', 2: 'BELOW avg', 3: 'AVERAGE', 4: 'ABOVE avg' };
const name = (en, v) => {
  if (v == null) return '-';
  if (typeof v === 'string') return v;
  const e = enums[en];
  return (e && e[v]) || String(v);
};
const chf = micros => micros == null ? '-' : `CHF ${(micros / 1e6).toFixed(2)}`;
const q = s => String(s).replace(/'/g, "\\'");

const out = [];
const p = (...s) => out.push(s.join(''));

async function safeQuery(customer, gaql, label) {
  try {
    return await customer.query(gaql);
  } catch (e) {
    const msg = (e.errors && e.errors.map(x => x.message).join('; ')) || e.message;
    p(`\n> NOT QUERYABLE for this account — ${label}: ${msg}\n`);
    return null;
  }
}

async function main() {
  const { customer } = getClient();
  if (!customer) throw new Error('Missing refresh_token in scripts/ads/config.json');

  p(`# Google Ads account audit — ${new Date().toISOString().slice(0, 10)}`);
  p('');
  p('Read-only GAQL snapshot (`scripts/ads/audit-account.js`). No mutate calls were made.');
  p('');

  // ── Campaign header ──
  const camps = await safeQuery(customer, `
    SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type,
           campaign.bidding_strategy_type, campaign_budget.amount_micros,
           campaign.final_url_suffix, campaign.tracking_url_template
    FROM campaign WHERE campaign.name='${q(CAMPAIGN)}'`, 'campaign');
  if (!camps || !camps.length) throw new Error(`Campaign "${CAMPAIGN}" not found`);
  const camp = camps[0].campaign;
  const campRN = `customers/${customer.credentials.customer_id}/campaigns/${camp.id}`;
  p(`## 0. Campaign`);
  p('');
  p(`- **${camp.name}** (id ${camp.id}) — status **${name('CampaignStatus', camp.status)}**, ` +
    `${name('AdvertisingChannelType', camp.advertising_channel_type)}, bidding ${name('BiddingStrategyType', camp.bidding_strategy_type)}, ` +
    `budget ${chf(camps[0].campaign_budget && camps[0].campaign_budget.amount_micros)}/day`);
  if (camp.tracking_url_template) p(`- tracking template: \`${camp.tracking_url_template}\``);
  if (camp.final_url_suffix) p(`- final URL suffix: \`${camp.final_url_suffix}\``);

  // Historical metrics (all-time, campaign level) for context on "biggest drags"
  const hist = await safeQuery(customer, `
    SELECT metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.ctr,
           metrics.search_impression_share, metrics.search_rank_lost_impression_share,
           metrics.search_budget_lost_impression_share
    FROM campaign WHERE campaign.name='${q(CAMPAIGN)}' AND ${RANGE}`, 'campaign metrics since');
  if (hist && hist[0]) {
    const m = hist[0].metrics;
    p(`- since ${SINCE}: ${m.impressions || 0} impr, ${m.clicks || 0} clicks, ${chf(m.cost_micros || 0)}, ` +
      `${(m.conversions || 0).toFixed(1)} conv, CTR ${((m.ctr || 0) * 100).toFixed(2)}%, ` +
      `impr share ${((m.search_impression_share || 0) * 100).toFixed(1)}%, lost-to-rank ${((m.search_rank_lost_impression_share || 0) * 100).toFixed(1)}%, ` +
      `lost-to-budget ${((m.search_budget_lost_impression_share || 0) * 100).toFixed(1)}%`);
  }
  p('');

  // ── 1. Ad groups + keywords + QS ──
  p(`## 1. Ad groups, keywords, Quality Score`);
  p('');
  const ags = await safeQuery(customer, `
    SELECT ad_group.id, ad_group.name, ad_group.status, ad_group.cpc_bid_micros, ad_group.type
    FROM ad_group WHERE campaign.name='${q(CAMPAIGN)}' AND ad_group.status != 'REMOVED'
    ORDER BY ad_group.name`, 'ad_group');
  const kws = await safeQuery(customer, `
    SELECT ad_group.id, ad_group.name,
           ad_group_criterion.criterion_id, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type,
           ad_group_criterion.status, ad_group_criterion.cpc_bid_micros, ad_group_criterion.effective_cpc_bid_micros,
           ad_group_criterion.final_urls,
           ad_group_criterion.quality_info.quality_score,
           ad_group_criterion.quality_info.creative_quality_score,
           ad_group_criterion.quality_info.post_click_quality_score,
           ad_group_criterion.quality_info.search_predicted_ctr,
           metrics.impressions, metrics.clicks, metrics.conversions, metrics.cost_micros
    FROM keyword_view WHERE campaign.name='${q(CAMPAIGN)}' AND ad_group_criterion.status != 'REMOVED'
      AND ${RANGE}
    ORDER BY ad_group.name, ad_group_criterion.keyword.text`, 'keyword_view (since)');
  // Keywords with zero impressions in 30d are dropped by the segmented query — fetch the full list unsegmented too.
  const kwsAll = await safeQuery(customer, `
    SELECT ad_group.id, ad_group.name,
           ad_group_criterion.criterion_id, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type,
           ad_group_criterion.status, ad_group_criterion.cpc_bid_micros, ad_group_criterion.effective_cpc_bid_micros,
           ad_group_criterion.final_urls,
           ad_group_criterion.quality_info.quality_score,
           ad_group_criterion.quality_info.creative_quality_score,
           ad_group_criterion.quality_info.post_click_quality_score,
           ad_group_criterion.quality_info.search_predicted_ctr
    FROM keyword_view WHERE campaign.name='${q(CAMPAIGN)}' AND ad_group_criterion.status != 'REMOVED'
    ORDER BY ad_group.name, ad_group_criterion.keyword.text`, 'keyword_view');
  const statsByCrit = new Map();
  for (const r of kws || []) statsByCrit.set(r.ad_group_criterion.criterion_id, r.metrics);

  for (const agRow of ags || []) {
    const ag = agRow.ad_group;
    p(`### Ad group: ${ag.name} (id ${ag.id}, ${name('AdGroupStatus', ag.status)}, default max CPC ${chf(ag.cpc_bid_micros)})`);
    p('');
    p(`| Keyword | Match | Status | Max CPC (kw / effective) | QS | Ad relevance | Landing page | Exp. CTR | Since ${SINCE}: impr / clicks / conv / cost |`);
    p('|---|---|---|---|---|---|---|---|---|');
    for (const r of (kwsAll || []).filter(x => x.ad_group.id === ag.id)) {
      const c = r.ad_group_criterion, qi = c.quality_info || {};
      const m = statsByCrit.get(c.criterion_id) || {};
      p(`| ${c.keyword.text} | ${name('KeywordMatchType', c.keyword.match_type)} | ${name('AdGroupCriterionStatus', c.status)} | ` +
        `${chf(c.cpc_bid_micros)} / ${chf(c.effective_cpc_bid_micros)} | ${qi.quality_score ?? '- (no QS yet)'} | ` +
        `${BUCKET[qi.creative_quality_score] || '-'} | ${BUCKET[qi.post_click_quality_score] || '-'} | ${BUCKET[qi.search_predicted_ctr] || '-'} | ` +
        `${m.impressions || 0} / ${m.clicks || 0} / ${(m.conversions || 0).toFixed(1)} / ${chf(m.cost_micros || 0)} |`);
    }
    p('');
  }

  // ── 2. RSAs ──
  p(`## 2. Responsive Search Ads`);
  p('');
  const ads = await safeQuery(customer, `
    SELECT ad_group.id, ad_group.name, ad_group_ad.status, ad_group_ad.ad_strength,
           ad_group_ad.policy_summary.approval_status,
           ad_group_ad.ad.id, ad_group_ad.ad.type, ad_group_ad.ad.final_urls,
           ad_group_ad.ad.responsive_search_ad.headlines, ad_group_ad.ad.responsive_search_ad.descriptions,
           ad_group_ad.ad.responsive_search_ad.path1, ad_group_ad.ad.responsive_search_ad.path2
    FROM ad_group_ad WHERE campaign.name='${q(CAMPAIGN)}' AND ad_group_ad.status != 'REMOVED'
    ORDER BY ad_group.name`, 'ad_group_ad');
  for (const r of ads || []) {
    const ad = r.ad_group_ad.ad;
    if (ad.type !== enums.AdType.RESPONSIVE_SEARCH_AD && ad.type !== 'RESPONSIVE_SEARCH_AD') {
      p(`- ad ${ad.id} in **${r.ad_group.name}** is type ${name('AdType', ad.type)} (not an RSA) — skipped`);
      continue;
    }
    const rsa = ad.responsive_search_ad || {};
    const hs = rsa.headlines || [], ds = rsa.descriptions || [];
    const pinned = [...hs, ...ds].filter(x => x.pinned_field);
    p(`### RSA ${ad.id} — ad group **${r.ad_group.name}**`);
    p('');
    p(`- status ${name('AdGroupAdStatus', r.ad_group_ad.status)}, approval ${name('PolicyApprovalStatus', r.ad_group_ad.policy_summary && r.ad_group_ad.policy_summary.approval_status)}, ` +
      `ad strength **${name('AdStrength', r.ad_group_ad.ad_strength)}**`);
    p(`- final URL: ${(ad.final_urls || []).join(', ')}${rsa.path1 ? ` — path /${rsa.path1}${rsa.path2 ? '/' + rsa.path2 : ''}` : ''}`);
    p(`- **${hs.length}/15 headlines**, **${ds.length}/4 descriptions**, pinned fields: ${pinned.length ? pinned.map(x => `"${x.text}" → ${name('ServedAssetFieldType', x.pinned_field)}`).join('; ') : 'none'}`);
    p('- headlines:');
    hs.forEach((h, i) => p(`  ${String(i + 1).padStart(2)}. ${h.text} (${h.text.length})`));
    p('- descriptions:');
    ds.forEach((d, i) => p(`  ${i + 1}. ${d.text} (${d.text.length})`));
    p('');
  }

  // ── 3. Assets ──
  p(`## 3. Linked assets (customer / campaign / ad group level)`);
  p('');
  const ASSET_SELECT = `asset.resource_name, asset.id, asset.name, asset.type, asset.final_urls,
           asset.sitelink_asset.link_text, asset.sitelink_asset.description1, asset.sitelink_asset.description2,
           asset.callout_asset.callout_text,
           asset.structured_snippet_asset.header, asset.structured_snippet_asset.values,
           asset.image_asset.full_size.url, asset.image_asset.full_size.width_pixels, asset.image_asset.full_size.height_pixels,
           asset.text_asset.text,
           asset.promotion_asset.promotion_target, asset.promotion_asset.percent_off, asset.promotion_asset.money_amount_off.amount_micros,
           asset.call_asset.phone_number, asset.call_asset.country_code,
           asset.lead_form_asset.business_name, asset.price_asset.type, asset.policy_summary.approval_status`;
  const describe = a => {
    switch (name('AssetType', a.type)) {
      case 'SITELINK': return `«${a.sitelink_asset.link_text}» — ${a.sitelink_asset.description1 || ''} / ${a.sitelink_asset.description2 || ''} → ${(a.final_urls || []).join(', ')}`;
      case 'CALLOUT': return `«${a.callout_asset.callout_text}»`;
      case 'STRUCTURED_SNIPPET': return `${name('StructuredSnippetHeader', a.structured_snippet_asset.header) || a.structured_snippet_asset.header}: ${(a.structured_snippet_asset.values || []).join(', ')}`;
      case 'IMAGE': { const f = a.image_asset && a.image_asset.full_size; return `${a.name || '(unnamed)'} ${f ? `${f.width_pixels}x${f.height_pixels}` : ''} ${f && f.url ? f.url : ''}`; }
      case 'TEXT': return `«${a.text_asset.text}»`;
      case 'PROMOTION': return `target «${a.promotion_asset.promotion_target}» ${a.promotion_asset.percent_off ? a.promotion_asset.percent_off / 1e6 + '% off' : ''}${a.promotion_asset.money_amount_off ? chf(a.promotion_asset.money_amount_off.amount_micros) + ' off' : ''}`;
      case 'CALL': return `${a.call_asset.country_code || ''} ${a.call_asset.phone_number || ''}`;
      default: return a.name || '(unnamed)';
    }
  };
  const printLinks = (rows, level, keyRow) => {
    if (!rows) return;
    if (!rows.length) { p(`_none_`); p(''); return; }
    const byField = {};
    for (const r of rows) {
      const link = r[keyRow];
      const ft = name('AssetFieldType', link.field_type);
      (byField[ft] = byField[ft] || []).push({ link, asset: r.asset, extra: r });
    }
    for (const ft of Object.keys(byField).sort()) {
      p(`**${ft}** (${byField[ft].length})`);
      for (const { link, asset, extra } of byField[ft]) {
        const scope = level === 'campaign' ? ` [${extra.campaign.name}]` : level === 'adgroup' ? ` [${extra.ad_group.name}]` : '';
        p(`- ${describe(asset)} — link ${name('AssetLinkStatus', link.status)}, policy ${name('PolicyApprovalStatus', asset.policy_summary && asset.policy_summary.approval_status)}, asset id ${asset.id}${scope}`);
      }
      p('');
    }
  };

  p(`### 3a. Customer-level (customer_asset) — apply to every campaign`);
  p('');
  const ca = await safeQuery(customer, `
    SELECT customer_asset.field_type, customer_asset.status, ${ASSET_SELECT}
    FROM customer_asset WHERE customer_asset.status != 'REMOVED'`, 'customer_asset');
  printLinks(ca, 'customer', 'customer_asset');

  p(`### 3b. Campaign-level (campaign_asset) — all non-removed campaigns`);
  p('');
  const cpa = await safeQuery(customer, `
    SELECT campaign.name, campaign.status, campaign_asset.field_type, campaign_asset.status, ${ASSET_SELECT}
    FROM campaign_asset WHERE campaign_asset.status != 'REMOVED' AND campaign.status != 'REMOVED'
    ORDER BY campaign.name`, 'campaign_asset');
  printLinks(cpa, 'campaign', 'campaign_asset');

  p(`### 3c. Ad-group-level (ad_group_asset) — ${CAMPAIGN}`);
  p('');
  const aga = await safeQuery(customer, `
    SELECT campaign.name, ad_group.name, ad_group_asset.field_type, ad_group_asset.status, ${ASSET_SELECT}
    FROM ad_group_asset WHERE campaign.name='${q(CAMPAIGN)}' AND ad_group_asset.status != 'REMOVED'`, 'ad_group_asset');
  printLinks(aga, 'adgroup', 'ad_group_asset');

  p(`### 3d. All assets in the account by type (linked or orphaned)`);
  p('');
  const allAssets = await safeQuery(customer, `SELECT ${ASSET_SELECT} FROM asset ORDER BY asset.type`, 'asset');
  if (allAssets) {
    const linked = new Set([...(ca || []), ...(cpa || []), ...(aga || [])].map(r => r.asset.resource_name));
    const byType = {};
    for (const r of allAssets) (byType[name('AssetType', r.asset.type)] = byType[name('AssetType', r.asset.type)] || []).push(r.asset);
    for (const t of Object.keys(byType).sort()) {
      const arr = byType[t];
      const orphan = arr.filter(a => !linked.has(a.resource_name)).length;
      p(`- **${t}**: ${arr.length} asset(s), ${orphan} not linked at customer/campaign/ad-group level` +
        (['SITELINK', 'CALLOUT', 'STRUCTURED_SNIPPET', 'PROMOTION', 'CALL'].includes(t) ? ` — ${arr.map(a => describe(a)).join(' | ')}` : ''));
    }
    p('');
    p('_Note: TEXT assets are PMax/Demand-Gen headlines and descriptions (listed by count only). "Not linked" counts links from customer_asset, campaign_asset (all campaigns) and ad_group_asset (this campaign only); an image used only inside a PMax asset_group is counted as not linked here._');
    p('');
  }

  const bn = await safeQuery(customer, `
    SELECT customer_asset.field_type, customer_asset.status, asset.id, asset.text_asset.text, asset.policy_summary.approval_status
    FROM customer_asset WHERE customer_asset.field_type IN ('BUSINESS_NAME','BUSINESS_LOGO')`, 'customer_asset business name/logo (any status)');
  p('### 3e. Business name / logo links (any link status)');
  p('');
  if (bn && !bn.length) p('_none_');
  for (const r of bn || []) p(`- ${name('AssetFieldType', r.customer_asset.field_type)} asset ${r.asset.id}${r.asset.text_asset && r.asset.text_asset.text ? ` «${r.asset.text_asset.text}»` : ''} — link ${name('AssetLinkStatus', r.customer_asset.status)}, policy ${name('PolicyApprovalStatus', r.asset.policy_summary && r.asset.policy_summary.approval_status)}`);
  p('');
  // Advertiser identity verification is not exposed via GAQL — say so.
  p('> Advertiser identity verification status (gates logo/business-name display) is NOT queryable via GAQL; check Google Ads UI → Billing → Advertiser verification.');
  p('');

  // ── 4. Negatives ──
  p(`## 4. Negative keywords`);
  p('');
  p(`### 4a. Campaign-level (campaign_criterion) — ${CAMPAIGN}`);
  p('');
  const negs = await safeQuery(customer, `
    SELECT campaign_criterion.keyword.text, campaign_criterion.keyword.match_type, campaign_criterion.negative
    FROM campaign_criterion WHERE campaign.name='${q(CAMPAIGN)}' AND campaign_criterion.type='KEYWORD' AND campaign_criterion.negative=TRUE
    ORDER BY campaign_criterion.keyword.text`, 'campaign_criterion negatives');
  if (negs) {
    if (!negs.length) p('_none_');
    for (const r of negs) p(`- ${r.campaign_criterion.keyword.text} (${name('KeywordMatchType', r.campaign_criterion.keyword.match_type)})`);
    p('');
    p(`Total: ${negs.length}`);
  }
  p('');
  p(`### 4b. Shared negative lists attached to the campaign`);
  p('');
  const sets = await safeQuery(customer, `
    SELECT shared_set.id, shared_set.name, shared_set.type, campaign_shared_set.status
    FROM campaign_shared_set WHERE campaign.name='${q(CAMPAIGN)}' AND campaign_shared_set.status != 'REMOVED'`, 'campaign_shared_set');
  if (sets) {
    if (!sets.length) p('_none_');
    for (const r of sets) {
      p(`- list **${r.shared_set.name}** (${name('SharedSetType', r.shared_set.type)})`);
      const crit = await safeQuery(customer, `
        SELECT shared_criterion.keyword.text, shared_criterion.keyword.match_type
        FROM shared_criterion WHERE shared_set.id=${r.shared_set.id}`, 'shared_criterion');
      for (const c of crit || []) p(`  - ${c.shared_criterion.keyword.text} (${name('KeywordMatchType', c.shared_criterion.keyword.match_type)})`);
    }
  }
  p('');
  p(`### 4c. Other campaign criteria (geo / language / device) — ${CAMPAIGN}`);
  p('');
  const other = await safeQuery(customer, `
    SELECT campaign_criterion.type, campaign_criterion.negative, campaign_criterion.location.geo_target_constant,
           campaign_criterion.language.language_constant, campaign_criterion.device.type, campaign_criterion.bid_modifier
    FROM campaign_criterion WHERE campaign.name='${q(CAMPAIGN)}' AND campaign_criterion.type != 'KEYWORD'`, 'campaign_criterion other');
  for (const r of other || []) {
    const c = r.campaign_criterion;
    const what = c.location ? c.location.geo_target_constant : c.language ? c.language.language_constant : c.device ? name('Device', c.device.type) : '';
    p(`- ${name('CriterionType', c.type)}${c.negative ? ' (negative)' : ''}: ${what}${c.bid_modifier != null ? ` bid mod ${c.bid_modifier}` : ''}`);
  }
  p('');

  // ── 5. Conversions ──
  p(`## 5. Conversion actions & goals`);
  p('');
  const convs = await safeQuery(customer, `
    SELECT conversion_action.id, conversion_action.name, conversion_action.status, conversion_action.type,
           conversion_action.category, conversion_action.origin, conversion_action.primary_for_goal,
           conversion_action.counting_type, conversion_action.include_in_conversions_metric,
           conversion_action.value_settings.default_value, conversion_action.attribution_model_settings.attribution_model
    FROM conversion_action WHERE conversion_action.status != 'REMOVED' ORDER BY conversion_action.name`, 'conversion_action');
  const goals = await safeQuery(customer, `
    SELECT customer_conversion_goal.category, customer_conversion_goal.origin, customer_conversion_goal.biddable
    FROM customer_conversion_goal`, 'customer_conversion_goal');
  const biddable = new Map();
  for (const g of goals || []) biddable.set(`${name('ConversionActionCategory', g.customer_conversion_goal.category)}|${name('ConversionOrigin', g.customer_conversion_goal.origin)}`, g.customer_conversion_goal.biddable);
  p('| Conversion action | Status | Type | Category | Origin | Primary for goal | Counting | In "Conversions" | Default value | Attribution | Goal biddable (customer_conversion_goal) |');
  p('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of convs || []) {
    const c = r.conversion_action;
    const key = `${name('ConversionActionCategory', c.category)}|${name('ConversionOrigin', c.origin)}`;
    p(`| ${c.name} | ${name('ConversionActionStatus', c.status)} | ${name('ConversionActionType', c.type)} | ${name('ConversionActionCategory', c.category)} | ${name('ConversionOrigin', c.origin)} | ` +
      `${c.primary_for_goal === true ? 'yes' : c.primary_for_goal === false ? 'no' : '-'} | ${name('ConversionActionCountingType', c.counting_type)} | ${c.include_in_conversions_metric ? 'yes' : 'no'} | ` +
      `${c.value_settings && c.value_settings.default_value != null ? c.value_settings.default_value : '-'} | ${name('AttributionModel', c.attribution_model_settings && c.attribution_model_settings.attribution_model)} | ` +
      `${biddable.has(key) ? (biddable.get(key) ? 'yes' : 'no') : 'no goal row'} |`);
  }
  p('');
  p('Customer conversion goals (category / origin → biddable):');
  for (const g of goals || []) p(`- ${name('ConversionActionCategory', g.customer_conversion_goal.category)} / ${name('ConversionOrigin', g.customer_conversion_goal.origin)} → ${g.customer_conversion_goal.biddable ? 'biddable' : 'observation only'}`);
  const campGoals = await safeQuery(customer, `
    SELECT campaign_conversion_goal.category, campaign_conversion_goal.origin, campaign_conversion_goal.biddable
    FROM campaign_conversion_goal WHERE campaign.name='${q(CAMPAIGN)}'`, 'campaign_conversion_goal');
  if (campGoals && campGoals.length) {
    p('');
    p(`Campaign-level goal overrides for ${CAMPAIGN}:`);
    for (const g of campGoals) p(`- ${name('ConversionActionCategory', g.campaign_conversion_goal.category)} / ${name('ConversionOrigin', g.campaign_conversion_goal.origin)} → ${g.campaign_conversion_goal.biddable ? 'biddable' : 'observation only'}`);
  }
  // 30d conversions by action for this campaign
  const convBy = await safeQuery(customer, `
    SELECT segments.conversion_action_name, metrics.conversions, metrics.all_conversions
    FROM campaign WHERE campaign.name='${q(CAMPAIGN)}' AND ${RANGE} AND metrics.all_conversions > 0`, 'conversions by action');
  p('');
  p(`Conversions since ${SINCE} (${CAMPAIGN}) by action:`);
  if (convBy && !convBy.length) p('- none');
  for (const r of convBy || []) p(`- ${r.segments.conversion_action_name}: ${r.metrics.conversions} counted (${r.metrics.all_conversions} all)`);
  p('');

  // ── 6. Search terms (history) — informs B3 moves and the new ad group ──
  p(`## 6. Search terms since ${SINCE} (top 40 by clicks, then impressions)`);
  p('');
  const st = await safeQuery(customer, `
    SELECT ad_group.name, search_term_view.search_term, segments.keyword.info.text,
           metrics.impressions, metrics.clicks, metrics.conversions, metrics.cost_micros
    FROM search_term_view WHERE campaign.name='${q(CAMPAIGN)}' AND ${RANGE}
    ORDER BY metrics.clicks DESC, metrics.impressions DESC LIMIT 40`, 'search_term_view');
  if (st) {
    p('| Ad group | Triggering keyword | Search term | Impr | Clicks | Conv | Cost |');
    p('|---|---|---|---|---|---|---|');
    for (const r of st) p(`| ${r.ad_group.name} | ${r.segments.keyword && r.segments.keyword.info ? r.segments.keyword.info.text : '-'} | ${r.search_term_view.search_term} | ${r.metrics.impressions} | ${r.metrics.clicks} | ${(r.metrics.conversions || 0).toFixed(1)} | ${chf(r.metrics.cost_micros || 0)} |`);
    p('');
  }

  process.stdout.write(out.join('\n') + '\n');
}

main().catch(e => {
  process.stdout.write(out.join('\n') + '\n');
  console.error('ERR:', e.message);
  if (e.errors) console.error(JSON.stringify(e.errors, null, 2).slice(0, 2000));
  process.exit(1);
});
