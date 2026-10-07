/**
 * Traffic-source bucketing for trial_events — the ONE definition of what
 * "paid", "chatgpt" (and the other assistants), "organic" and "direct" mean for
 * the admin step funnel.
 *
 * Paid is anything a paid click can be recognised by: a paid utm_medium, a
 * known ad-network utm_source, OR a gclid. Google Ads auto-tagging appends the
 * gclid to every paid click even when the UTM tags are stripped (redirects,
 * link shorteners, a landing URL without the tags), so before 2026-09-09 such
 * a click carried no utm_source and was counted as "direct".
 *
 * AI assistants get their own buckets (owner, 2026-09: chatgpt.com sent 5 of 8
 * trials and was invisible inside "organic"). An assistant is recognised by
 * the utm_source it appends to the links it emits (ChatGPT: utm_source=chatgpt.com)
 * OR by the referrer host, because not every assistant tags its links and a
 * referral with no utm_source used to land in "direct". Paid wins over an
 * assistant (a gclid is a paid click wherever it was pasted); an assistant
 * wins over organic/direct.
 */
const PAID_MEDIUMS = ['cpc', 'ppc', 'paid', 'search'];
const AD_NETWORK_SOURCES = ['google', 'bing', 'meta', 'facebook'];

// bucket → referrer hosts (subdomains match). The bucket name itself is also
// accepted as a utm_source, next to the hosts.
const ASSISTANT_SOURCES = {
  chatgpt: ['chatgpt.com', 'chat.openai.com'],
  perplexity: ['perplexity.ai'],
  gemini: ['gemini.google.com', 'bard.google.com'],
  copilot: ['copilot.microsoft.com'],
};

const sqlList = (values) => values.map((v) => `'${v}'`).join(',');
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Anchored, case-insensitive: the referrer's host is one of `hosts` or a subdomain of one. */
const hostPattern = (hosts) => `^https?://([a-z0-9-]+\\.)*(${hosts.map(escapeRe).join('|')})(/|$)`;

const PAID_SQL = `(gclid IS NOT NULL OR utm_medium IN (${sqlList(PAID_MEDIUMS)}) OR utm_source IN (${sqlList(AD_NETWORK_SOURCES)}))`;

const assistantSql = (bucket) => {
  const hosts = ASSISTANT_SOURCES[bucket];
  return `(utm_source IN (${sqlList([bucket, ...hosts])}) OR referrer ~* '${hostPattern(hosts)}')`;
};
const ANY_ASSISTANT_SQL = `(${Object.keys(ASSISTANT_SOURCES).map(assistantSql).join(' OR ')})`;

const TRIAL_SOURCE_SQL = {
  all: null,
  paid: PAID_SQL,
  ...Object.fromEntries(Object.keys(ASSISTANT_SOURCES).map((b) => [b, `(${assistantSql(b)} AND NOT ${PAID_SQL})`])),
  organic: `(utm_source IS NOT NULL AND NOT ${PAID_SQL} AND NOT ${ANY_ASSISTANT_SQL})`,
  direct: `(utm_source IS NULL AND gclid IS NULL AND NOT ${ANY_ASSISTANT_SQL})`,
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

const ASSISTANT_RE = Object.fromEntries(
  Object.entries(ASSISTANT_SOURCES).map(([bucket, hosts]) => [bucket, new RegExp(hostPattern(hosts), 'i')])
);

/** The assistant bucket a row belongs to, or null. Same rule as assistantSql. */
function assistantBucket(row) {
  for (const [bucket, hosts] of Object.entries(ASSISTANT_SOURCES)) {
    if (row.utm_source != null && [bucket, ...hosts].includes(row.utm_source)) return bucket;
    if (row.referrer != null && ASSISTANT_RE[bucket].test(row.referrer)) return bucket;
  }
  return null;
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
  const assistant = assistantBucket(row);
  if (assistant) return assistant;
  return row.utm_source != null ? 'organic' : 'direct';
}

module.exports = {
  TRIAL_SOURCES,
  PAID_MEDIUMS,
  AD_NETWORK_SOURCES,
  ASSISTANT_SOURCES,
  trialSourceWhereClause,
  classifyTrialSource,
};
