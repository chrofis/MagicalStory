/**
 * Traffic-source bucketing for trial_events — the ONE definition of what
 * "paid", "organic" and "direct" mean for the admin step funnel.
 *
 * Paid is anything a paid click can be recognised by: a paid utm_medium, a
 * known ad-network utm_source, OR a gclid. Google Ads auto-tagging appends the
 * gclid to every paid click even when the UTM tags are stripped (redirects,
 * link shorteners, a landing URL without the tags), so before 2026-09-09 such
 * a click carried no utm_source and was counted as "direct".
 */
const PAID_MEDIUMS = ['cpc', 'ppc', 'paid', 'search'];
const AD_NETWORK_SOURCES = ['google', 'bing', 'meta', 'facebook'];

const sqlList = (values) => values.map((v) => `'${v}'`).join(',');

const PAID_SQL = `(gclid IS NOT NULL OR utm_medium IN (${sqlList(PAID_MEDIUMS)}) OR utm_source IN (${sqlList(AD_NETWORK_SOURCES)}))`;

const TRIAL_SOURCE_SQL = {
  all: null,
  paid: PAID_SQL,
  organic: `(utm_source IS NOT NULL AND NOT ${PAID_SQL})`,
  direct: '(utm_source IS NULL AND gclid IS NULL)',
};

const TRIAL_SOURCES = Object.keys(TRIAL_SOURCE_SQL);

/**
 * WHERE fragment (no leading AND) selecting trial_events rows of one source,
 * or null for 'all'. Throws on an unknown source so a typo can't silently
 * widen a filter to everything.
 */
function trialSourceWhereClause(source) {
  if (!Object.prototype.hasOwnProperty.call(TRIAL_SOURCE_SQL, source)) {
    throw new Error(`Unknown trial source: ${source}`);
  }
  return TRIAL_SOURCE_SQL[source];
}

/**
 * Same bucketing as the SQL, for one row in JS. Kept next to the SQL so the
 * two cannot drift apart unnoticed — the unit test pins both to the same cases.
 */
function classifyTrialSource(row) {
  const paid = row.gclid != null
    || PAID_MEDIUMS.includes(row.utm_medium)
    || AD_NETWORK_SOURCES.includes(row.utm_source);
  if (paid) return 'paid';
  return row.utm_source != null ? 'organic' : 'direct';
}

module.exports = { TRIAL_SOURCES, PAID_MEDIUMS, AD_NETWORK_SOURCES, trialSourceWhereClause, classifyTrialSource };
