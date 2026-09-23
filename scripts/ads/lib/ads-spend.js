/**
 * Google Ads spend for a window of whole account-timezone days (Europe/Zurich), keyed the way our own
 * database keys a click: by utm_campaign, and by (utm_campaign, keyword).
 *
 * The utm_campaign <-> Ads campaign link is READ from each campaign's live final URLs (and its final URL
 * suffix), never kept as a hand-written table: the account already has a campaign named
 * Search-Deutschschweiz-v1 whose ads say utm_campaign=zurich, which is exactly the kind of mapping that drifts.
 *
 * Keyword keys use the keyword text lower-cased, which is what ValueTrack {keyword} inserts and what
 * trial_events stores after URLSearchParams decoding.
 */
const { getClient } = require('./client');

function utmCampaignOf(url) {
  if (!url) return null;
  const i = url.indexOf('?');
  if (i < 0) return null;
  return new URLSearchParams(url.slice(i + 1)).get('utm_campaign');
}

/** @param {{startDate: string, endDate: string}} window YYYY-MM-DD, inclusive, account timezone */
async function fetchSpend({ startDate, endDate }) {
  const { customer } = getClient();
  if (!customer) throw new Error('Missing refresh_token in scripts/ads/config.json - run node scripts/ads/authorize.js');
  const range = `segments.date BETWEEN '${startDate}' AND '${endDate}'`;

  // utm_campaign per Ads campaign, from the ads that actually serve.
  const adRows = await customer.query(`
    SELECT campaign.id, campaign.name, campaign.final_url_suffix, ad_group_ad.ad.final_urls
      FROM ad_group_ad WHERE campaign.status != 'REMOVED' AND ad_group_ad.status != 'REMOVED'`);
  const utmByCampaignId = new Map();
  for (const r of adRows) {
    const tags = utmByCampaignId.get(r.campaign.id) || new Set();
    for (const u of r.ad_group_ad.ad.final_urls || []) { const t = utmCampaignOf(u); if (t) tags.add(t); }
    const s = utmCampaignOf('?' + (r.campaign.final_url_suffix || ''));
    if (s) tags.add(s);
    utmByCampaignId.set(r.campaign.id, tags);
  }
  const utmOf = (id, name) => {
    const tags = [...(utmByCampaignId.get(id) || [])];
    if (tags.length === 1) return tags[0];
    // Zero tags = the clicks cannot be joined to our data; two+ = one campaign's clicks split across labels.
    // Both are real, reportable states - never guess a label.
    return tags.length ? `(ambiguous: ${tags.join('/')} - ${name})` : `(untagged: ${name})`;
  };

  const byUtmCampaign = new Map();
  for (const r of await customer.query(`
      SELECT campaign.id, campaign.name, metrics.clicks, metrics.cost_micros, metrics.impressions
        FROM campaign WHERE ${range} AND campaign.status != 'REMOVED'`)) {
    const m = r.metrics;
    if (!m.impressions && !m.clicks && !m.cost_micros) continue;
    const key = utmOf(r.campaign.id, r.campaign.name);
    const e = byUtmCampaign.get(key) || { campaigns: new Set(), impressions: 0, clicks: 0, costMicros: 0 };
    e.campaigns.add(r.campaign.name);
    e.impressions += m.impressions || 0; e.clicks += m.clicks || 0; e.costMicros += m.cost_micros || 0;
    byUtmCampaign.set(key, e);
  }

  const byKeyword = new Map();
  for (const r of await customer.query(`
      SELECT campaign.id, campaign.name, ad_group.name, ad_group_criterion.keyword.text,
             metrics.clicks, metrics.cost_micros, metrics.impressions
        FROM keyword_view WHERE ${range}`)) {
    const m = r.metrics;
    if (!m.clicks && !m.cost_micros) continue;
    const kw = r.ad_group_criterion.keyword.text.toLowerCase();
    const key = `${utmOf(r.campaign.id, r.campaign.name)}|${kw}`;
    const e = byKeyword.get(key) || { campaign: r.campaign.name, adGroup: r.ad_group.name, keyword: kw, impressions: 0, clicks: 0, costMicros: 0 };
    e.impressions += m.impressions || 0; e.clicks += m.clicks || 0; e.costMicros += m.cost_micros || 0;
    byKeyword.set(key, e);
  }

  return { byUtmCampaign, byKeyword };
}

module.exports = { fetchSpend, utmCampaignOf };
