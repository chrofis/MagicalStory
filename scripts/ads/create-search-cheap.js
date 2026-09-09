#!/usr/bin/env node
/**
 * Create the PAUSED cheap-click Search campaign `Search-Cheap-CH` (plan: tasks/ads-cheap-clicks-2026-09-09.md).
 *
 *   node scripts/ads/create-search-cheap.js            # DRY-RUN (default): prints every op it WOULD send
 *   node scripts/ads/create-search-cheap.js --apply    # LIVE create — only after the owner's explicit go
 *
 * Owner target (tasks/ads-reactivation-2026-09-09.md): as many clicks as possible under CHF 0.20, then let
 * scripts/ads/attribution-report.js show what converts.
 *
 *   Budget CHF 5/day · MANUAL_CPC, no enhanced CPC · every ad group max CPC CHF 0.20 · SEARCH
 *   Geo: read at runtime from Search-Deutschschweiz-v1 (the 19 German-speaking cantons) · language German (1001)
 *   No device bid modifiers (the audit flagged the −30 % mobile modifier on the main campaign as self-inflicted rank loss)
 *   Keywords: PHRASE, every one measured by Keyword Planner on 2026-09-09 with a LOW top-of-page bid <= CHF 0.20 or no
 *   estimate at all (unbid); direction traps (gift for the godparent / teacher, toys, crafts, baby, rites) are negatives.
 *   Final URLs carry utm_term={keyword} (ValueTrack) so trial_events → attribution-report.js can attribute per keyword.
 *
 * Idempotent by name: an existing campaign / budget / ad group / keyword / RSA / negative is detected and skipped, so a
 * re-run after --apply is a no-op and a half-finished run can be completed by running again.
 */
const { getClient } = require('./lib/client');
const { enums } = require('google-ads-api');

const APPLY = process.argv.includes('--apply');
const CHF = n => Math.round(n * 1e6);

const CAMPAIGN = {
  name: 'Search-Cheap-CH',
  budgetName: 'Search-Cheap-CH-Budget',
  dailyBudgetMicros: CHF(5),
  maxCpcMicros: CHF(0.20),
  geoSource: 'Search-Deutschschweiz-v1',
  languageConstant: 'languageConstants/1001',
};
const SITE = 'https://magicalstory.ch';
const UTM = 'utm_source=google&utm_medium=search&utm_campaign=cheap-ch&utm_term={keyword}';
const LIMITS = { headline: 30, description: 90, path: 15 };

// ─── Copy (Swiss German: ss not ß, «» guillemets) ─────────────────────────────────────────────────────────────
// Age groups share one validated template; {A} = adjective form («3-Jährige»), {Y} = year form («3 Jahre»).
function ageCopy(A, Y) {
  return {
    headlines: [
      `Geschenk für ${A}`, `Geschenkidee ${Y}`, `Geburtstagsgeschenk ${Y}`, `Sinnvolles Geschenk ${Y}`,
      'Personalisiertes Kinderbuch', 'Dein Kind, die Hauptfigur', 'Mit Foto deines Kindes', 'Mehr als Spielzeug',
      'Erste Geschichte gratis', 'In 3 Minuten erstellt', 'Gedruckt in der Schweiz', 'Für Jungs und Mädchen',
      'Nur für dein Kind gemacht', 'Ab CHF 5 starten', 'Jedes Kind hat eine Geschichte',
    ],
    descriptions: [
      `Ein Kinderbuch, in dem dein Kind (${Y}) der Held ist. Foto rein, fertig.`,
      'Kein Spielzeug, das nach einer Woche vergessen ist: eine Geschichte nur über dein Kind.',
      'Erste Geschichte gratis testen. Als PDF sofort oder gedruckt in der Schweiz nach Hause.',
      'Personalisiertes Geschenk für Jungs und Mädchen. Dein Kind als Hauptfigur, in 3 Minuten.',
    ],
  };
}

const AD_GROUPS = [
  { name: 'Alter-3', lp: '/geschenk/geschenk-3-jahre', path: ['Geschenk', '3-Jahre'], copy: ageCopy('3-Jährige', '3 Jahre'),
    keywords: ['geschenke 3 jährige jungs', 'geschenk 3 jährig', 'geschenke für 3 jährige', 'geschenke für jungs 3 jahre', 'geschenk 3 jahre',
      'geschenke 3 jährige', 'geschenke zum 3 geburtstag', 'geburtstagsgeschenk 3 jährige', 'geburtstagsgeschenk 3 jahre', 'weihnachtsgeschenk 3 jährige',
      'geschenke für dreijährige', 'geschenke ab 3 jahren', 'sinnvolle geschenke 3 jährige'] },
  { name: 'Alter-4', lp: '/geschenk/geschenk-4-jahre', path: ['Geschenk', '4-Jahre'], copy: ageCopy('4-Jährige', '4 Jahre'),
    keywords: ['geschenk 4 jährige jungs', 'geschenke für jungs 4 jahre', 'geschenk 4 jährig', 'geschenke für 4 jährige', 'geschenke für 4 jährige jungs',
      'geschenk 4 jahre', 'geschenkideen 4 jährige jungs', 'geschenke zum 4 geburtstag', 'geburtstagsgeschenk 4 jährige', 'geburtstagsgeschenk 4 jahre',
      'weihnachtsgeschenk 4 jährige', 'geschenkideen 4 jährige', 'geschenke für vierjährige', 'geschenk ab 4 jahren', 'geschenk für 4 jährige tochter'] },
  { name: 'Alter-5', lp: '/geschenk/geschenk-5-jahre', path: ['Geschenk', '5-Jahre'], copy: ageCopy('5-Jährige', '5 Jahre'),
    keywords: ['geschenke für jungs 5 jahre', 'geschenk für 5 jährige jungs', 'sinnvolles geschenk für 5 jährige jungs', 'geschenke für 5 jährige',
      'geschenk für 5 jährige', 'geschenk 5 jahre', 'geschenke 5 jährige', 'geschenke zum 5 geburtstag', 'weihnachtsgeschenk 5 jährige',
      'geschenkideen 5 jährige', 'geburtstagsgeschenk 5 jährige', 'geburtstagsgeschenk 5 jahre', 'geschenk ab 5 jahre', 'geschenk für 5 jährige tochter'] },
  { name: 'Alter-6', lp: '/geschenk/geschenk-6-jahre', path: ['Geschenk', '6-Jahre'], copy: ageCopy('6-Jährige', '6 Jahre'),
    keywords: ['geschenke für jungs 6 jahre', 'kindergeschenke 6 jahre', 'geschenke 6 jährige', 'geschenk 6 jahre', 'sinnvolles geschenk für 6 jährigen',
      'mädchengeschenke 6 jahre', 'geschenke zum 6 geburtstag', 'geburtstagsgeschenk 6 jährige', 'geburtstagsgeschenk 6 jahre', 'geschenk für 6 jährigen',
      'geschenke kindergeburtstag 6 jahre', 'sinnvolle geschenke für 6 jährige jungs', 'geschenk für 6 jährige tochter'] },
  { name: 'Alter-7-8', lp: '/geschenk/geschenk-7-8-jahre', path: ['Geschenk', '7-8-Jahre'], copy: ageCopy('7- und 8-Jährige', '7–8 Jahre'),
    keywords: ['geschenke 8 jährige jungs', 'geschenke für 7 jährige jungs', 'sinnvolle geschenke für 8 jährige jungs', 'geschenke 7 jährige', 'geschenk 7 jahre',
      'coole geschenke für 7 jährige', 'geschenke 8 jährige', 'geschenk 8 jahre', 'geschenke für jungs ab 8', 'geschenk 7 jähriger', 'sinnvolle geschenke für 8 jährige',
      'geschenke zum 7 geburtstag', 'geschenkideen 7 jährige jungs', 'geburtstagsgeschenk 7 jährige', 'geschenk für 7 jährige tochter', 'geschenk für 8 jährige tochter'] },
  { name: 'Alter-9-10', lp: '/geschenk/fuer-kinder', path: ['Geschenk', '9-10-Jahre'], copy: ageCopy('9- und 10-Jährige', '9–10 Jahre'),
    keywords: ['geschenke für 10 jährige jungs', 'geschenke für jungs ab 10', 'sinnvolle geschenke für 9 jährige', 'sinnvolle geschenke für 9 jährige jungs',
      'geschenk 10 jährige', 'geschenke jungs 10 jahre', 'coole geschenke für 10 jährige jungs', 'geschenkideen 9 jährige jungs', 'geburtstagsgeschenk 10 jährige',
      'coole geschenke für 9 jährige jungs'] },
  { name: 'Goettikind', lp: '/geschenk/fuer-patenkind', path: ['Geschenk', 'Goettikind'],
    copy: {
      headlines: ['Geschenk fürs Göttikind', 'Geschenk fürs Patenkind', 'Göttibub oder Göttimeitli', 'Personalisiertes Kinderbuch', 'Dein Göttikind als Held',
        'Mehr als Geld im Couvert', 'Mit Foto des Kindes', 'Erste Geschichte gratis', 'In 3 Minuten erstellt', 'Gedruckt in der Schweiz', 'Für Geburtstag und Weihnachten',
        'Zur Einschulung schenken', 'Ein Geschenk, das bleibt', 'Nur für dein Göttikind', 'Jedes Kind hat eine Geschichte'],
      descriptions: [
        'Ein Kinderbuch, in dem dein Göttikind die Hauptfigur ist. Foto rein, Thema wählen, fertig.',
        'Persönlicher als Geld: eine Geschichte nur über dein Patenkind, von dir geschenkt.',
        'Erste Geschichte gratis testen. Als PDF sofort oder gedruckt in der Schweiz nach Hause.',
        'Für Göttibub und Göttimeitli von 3 bis 10 Jahren. In 3 Minuten erstellt.',
      ],
    },
    keywords: ['göttikind geschenk', 'göttibub geschenk', 'göttimeitli geschenk', 'geschenk patenkind 3 jahre', 'geschenk patenkind 4 jahre', 'geschenk patenkind 6 jahre',
      'geschenk patenkind schulanfang', 'patenkind geschenk einschulung', 'patenkind kindergarten geschenk', 'geburtstagsgeschenk patenkind', 'personalisierte geschenke patenkind',
      'persönliches geschenk patenkind', 'personalisiertes buch patenkind', 'geschenkideen patenkind', 'weihnachtsgeschenk patenkind', 'kreatives geschenk patenkind'] },
  { name: 'Einschulung', lp: '/geschenk/einschulungsgeschenk', path: ['Geschenk', 'Einschulung'],
    copy: {
      headlines: ['Geschenk zur Einschulung', 'Einschulungsgeschenk', 'Geschenk zum Schulanfang', 'Buch zur Einschulung', 'Dein Schulkind als Held',
        'Personalisiertes Kinderbuch', 'Mit Foto deines Kindes', 'Mehr als eine Schultüte', 'Erste Geschichte gratis', 'In 3 Minuten erstellt', 'Gedruckt in der Schweiz',
        'Mut für den ersten Schultag', 'Für Jungs und Mädchen', 'Nur für dein Kind gemacht', 'Jedes Kind hat eine Geschichte'],
      descriptions: [
        'Ein Kinderbuch, in dem dein Kind den ersten Schultag als Held erlebt. Foto rein, fertig.',
        'Sinnvoller als Süsses in der Schultüte: eine Geschichte, die Mut für die Schule macht.',
        'Erste Geschichte gratis testen. Als PDF sofort oder gedruckt in der Schweiz nach Hause.',
        'Personalisiertes Einschulungsgeschenk für Jungs und Mädchen. Dein Kind als Hauptfigur.',
      ],
    },
    keywords: ['sinnvolle geschenke zur einschulung', 'geschenke für jungs zur einschulung', 'personalisiertes buch einschulung', 'buch zur einschulung',
      'personalisiertes kinderbuch einschulung', 'personalisierte einschulungsgeschenke', 'geschenkideen zur einschulung', 'schulanfangsgeschenke',
      'geschenke für schulanfänger jungs', 'personalisiertes buch schulkind', 'coole geschenke zur einschulung', 'kleinigkeit zur einschulung',
      'kindergarten abschiedsgeschenk', 'abschiedsgeschenk für kindergartenkinder', 'geschenke zum abschied kindergarten', 'abschiedsgeschenk kindergarten schulkinder'] },
  { name: 'Geschwisterkind', lp: '/anlass/geschwisterchen', path: ['Geschenk', 'Geschwister'],
    copy: {
      headlines: ['Buch für die grosse Schwester', 'Buch für den grossen Bruder', 'Geschenk fürs Geschwisterkind', 'Grosse Schwester werden', 'Grosser Bruder werden',
        'Personalisiertes Kinderbuch', 'Dein Kind, die Hauptfigur', 'Mit Foto deines Kindes', 'Erste Geschichte gratis', 'In 3 Minuten erstellt', 'Gedruckt in der Schweiz',
        'Stolz aufs Geschwisterchen', 'Nur für dein Kind gemacht', 'Ein Geschenk, das bleibt', 'Jedes Kind hat eine Geschichte'],
      descriptions: [
        'Ein Kinderbuch, in dem dein Kind grosse Schwester oder grosser Bruder wird. Mit Foto.',
        'Wenn das Baby kommt, ist das ältere Kind der Held: eine Geschichte nur über dein Kind.',
        'Erste Geschichte gratis testen. Als PDF sofort oder gedruckt in der Schweiz nach Hause.',
        'Personalisiertes Geschenk zur Geburt des Geschwisterchens, für das grosse Kind gemacht.',
      ],
    },
    keywords: ['kinderbuch grosse schwester', 'kinderbuch grosser bruder', 'bilderbuch grosse schwester', 'bilderbuch grosser bruder', 'buch grosse schwester werden',
      'buch grosser bruder werden', 'geschenk für werdende grosse schwester', 'geschenke für werdende geschwister', 'ich werde grosse schwester buch',
      'buch ich werde grosser bruder', 'einschulung geschenk geschwisterkind'] },
];

// Campaign-level negatives: the main campaign's 12 + the audit's 7 (B3b) + the direction traps measured for these seed families.
const NEGATIVES = [
  // from Search-Deutschschweiz-v1
  'ausmalbuch', 'bubbleboo', 'conni', 'elsa', 'globi', 'kostenlos', 'librio', 'little yeti', 'paw patrol', 'pixastory', 'selber basteln', 'wimmelbuch',
  // audit B3b
  'wonderbly', 'eiskönigin', 'kinderbibel', 'freundebuch', 'kleinauflage', { text: 'drucken lassen', match: 'PHRASE' }, 'pappbilderbuch',
  // gift FOR the godparent / for the teacher
  { text: 'götti geschenk', match: 'PHRASE' }, { text: 'geschenk für götti', match: 'PHRASE' }, { text: 'gotti geschenk', match: 'PHRASE' },
  { text: 'geschenk für gotti', match: 'PHRASE' }, 'gotte', 'pate', 'paten', 'patin', 'patentante', 'patenonkel', 'taufpate',
  'kindergärtnerin', 'lehrerin', 'lehrer', 'erzieherin', 'erzieher', 'kita team', 'kindergarten team', 'tagesmutter',
  // mug / craft / asking / card / money / rites / adult godchild
  'tasse', 'basteln', 'bastelidee', 'fragen', 'glückwünsche', 'sprüche', 'spruch', 'gedicht', 'karte', 'geld', 'geldgeschenk', 'wieviel',
  'konfirmation', 'firmung', 'kommunion', 'abitur', 'matura', 'hochzeit', 'führerschein', { text: '18 geburtstag', match: 'PHRASE' },
  // baby as recipient
  'baby', 'taufe', 'taufgeschenk', 'neugeborene', { text: '1 geburtstag', match: 'PHRASE' }, { text: 'erster geburtstag', match: 'PHRASE' },
  // specific products, not a book
  'spielzeug', 'spielzeuge', 'spielsachen', 'lego', 'playmobil', 'puzzle', 'kuscheltier', 'fahrrad', 'velo', 'laufrad', 'trottinett', 'tonies', 'tonie',
  'schultüte', 'schultüten', 'inhalt', 'gastgeschenk', 'gastgeschenke', 'fotoalbum', 'montessori', 'outdoor', 'fussball', 'fußball', 'einhorn', 'kleidung', 'gymnasium',
  // competitor / licensed / retailer
  'peppa', 'bibi und tina', 'feuerwehrmann sam', 'lausemaus', 'tchibo', 'etsy', 'amazon', 'galaxus', 'manor', 'migros', 'coop',
].map(n => (typeof n === 'string' ? { text: n, match: 'BROAD' } : n));

// ─── Validation ───────────────────────────────────────────────────────────────────────────────────────────────
function validate() {
  const problems = [];
  const check = (kind, text, max) => {
    if (text.length > max) problems.push(`${kind} "${text}" is ${text.length} chars (max ${max})`);
    if (/ß/.test(text)) problems.push(`${kind} "${text}" uses ß (Swiss spelling: ss)`);
    if (/["“”„]/.test(text)) problems.push(`${kind} "${text}" uses straight/curly quotes (use «»)`);
    if (kind === 'headline' && /!/.test(text)) problems.push(`headline "${text}" contains ! (not allowed)`);
  };
  const seenKw = new Map();
  for (const g of AD_GROUPS) {
    g.copy.headlines.forEach(h => check('headline', h, LIMITS.headline));
    g.copy.descriptions.forEach(d => check('description', d, LIMITS.description));
    g.path.forEach(p => check('path', p, LIMITS.path));
    if (g.copy.headlines.length !== 15) problems.push(`${g.name}: ${g.copy.headlines.length} headlines (need 15)`);
    if (g.copy.descriptions.length !== 4) problems.push(`${g.name}: ${g.copy.descriptions.length} descriptions (need 4)`);
    if (new Set(g.copy.headlines.map(h => h.toLowerCase())).size !== g.copy.headlines.length) problems.push(`${g.name}: duplicate headlines`);
    for (const k of g.keywords) {
      if (/ß/.test(k)) problems.push(`keyword "${k}" uses ß`);
      if (seenKw.has(k)) problems.push(`keyword "${k}" in both ${seenKw.get(k)} and ${g.name}`);
      seenKw.set(k, g.name);
      if (NEGATIVES.some(n => n.match === 'BROAD' && new RegExp(`(^|\\s)${n.text}(\\s|$)`).test(k))) problems.push(`keyword "${k}" is blocked by a negative`);
    }
  }
  if (problems.length) { console.error('VALIDATION FAILED:\n  ' + problems.join('\n  ')); process.exit(1); }
}

// ─── Output + execution helper ────────────────────────────────────────────────────────────────────────────────
const MODE = APPLY ? 'LIVE' : 'DRY';
let opCount = 0, skipCount = 0;
async function op(label, detail, fn) {
  opCount++;
  console.log(`  [${MODE}] ${label}`);
  for (const l of detail) console.log('    ' + l);
  if (!APPLY) return null;
  const res = await fn();
  const rn = res && res.results && res.results[0] && res.results[0].resource_name;
  console.log(`    ✓ ${rn || 'ok'}`);
  return rn;
}
function skip(label, why) { skipCount++; console.log(`  [SKIP] ${label} — ${why}`); }
const q = s => String(s).replace(/'/g, "\\'");
const enumName = (en, v) => (typeof v === 'string' ? v : (enums[en] && enums[en][v]) || String(v));

async function main() {
  validate();
  const { customer } = getClient();
  if (!customer) throw new Error('Missing refresh_token in scripts/ads/config.json');
  console.log(`Campaign: ${CAMPAIGN.name}`);
  console.log(`Mode: ${APPLY ? 'LIVE — creates the campaign PAUSED' : 'DRY-RUN — nothing is sent (pass --apply to execute)'}\n`);

  // ── Geo list from the existing campaign (read-only) ──
  const geoRows = await customer.query(`
    SELECT campaign.id, campaign_criterion.location.geo_target_constant FROM campaign_criterion
    WHERE campaign.name='${q(CAMPAIGN.geoSource)}' AND campaign_criterion.type='LOCATION' AND campaign_criterion.negative=false`);
  const geos = geoRows.map(r => r.campaign_criterion.location.geo_target_constant);
  if (!geos.length) throw new Error(`No location criteria found on ${CAMPAIGN.geoSource}`);
  const geoNames = await customer.query(`SELECT geo_target_constant.resource_name, geo_target_constant.name FROM geo_target_constant WHERE geo_target_constant.resource_name IN (${geos.map(g => `'${g}'`).join(',')})`);
  const nameOf = new Map(geoNames.map(r => [r.geo_target_constant.resource_name, r.geo_target_constant.name]));
  console.log(`Geo (from ${CAMPAIGN.geoSource}, ${geos.length} regions): ${geos.map(g => nameOf.get(g) || g).join(', ')}\n`);

  // ── Existing state (idempotency) ──
  const camps = await customer.query(`SELECT campaign.id, campaign.resource_name, campaign.status FROM campaign WHERE campaign.name='${q(CAMPAIGN.name)}' AND campaign.status != 'REMOVED'`);
  const budgets = await customer.query(`SELECT campaign_budget.resource_name FROM campaign_budget WHERE campaign_budget.name='${q(CAMPAIGN.budgetName)}' AND campaign_budget.status != 'REMOVED'`);
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

  // ── 1. Budget + campaign ──
  console.log('━━━ 1. Budget + campaign');
  let budgetRn = budgets[0] && budgets[0].campaign_budget.resource_name;
  if (budgetRn) skip(`campaign_budgets.create ${CAMPAIGN.budgetName}`, `exists (${budgetRn})`);
  else budgetRn = (await op(`campaign_budgets.create ${CAMPAIGN.budgetName}`, [`amount_micros=${CAMPAIGN.dailyBudgetMicros} (CHF 5.00/day) delivery_method=STANDARD explicitly_shared=false`],
    () => customer.campaignBudgets.create([{ name: CAMPAIGN.budgetName, amount_micros: CAMPAIGN.dailyBudgetMicros, delivery_method: enums.BudgetDeliveryMethod.STANDARD, explicitly_shared: false }]))) || `[NEW budget ${CAMPAIGN.budgetName}]`;
  if (campaignRn) skip(`campaigns.create ${CAMPAIGN.name}`, `exists (${campaignRn}, ${enumName('CampaignStatus', camps[0].campaign.status)})`);
  else {
    const o = {
      name: CAMPAIGN.name, status: enums.CampaignStatus.PAUSED, advertising_channel_type: enums.AdvertisingChannelType.SEARCH, campaign_budget: budgetRn,
      bidding_strategy_type: enums.BiddingStrategyType.MANUAL_CPC, manual_cpc: { enhanced_cpc_enabled: false },
      network_settings: { target_google_search: true, target_search_network: true, target_content_network: false, target_partner_search_network: false },
      contains_eu_political_advertising: enums.EuPoliticalAdvertisingStatus.DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING,
    };
    campaignRn = (await op(`campaigns.create ${CAMPAIGN.name}`, ['status=PAUSED channel=SEARCH bidding=MANUAL_CPC enhanced_cpc=false', `budget=${budgetRn}`, 'network: google search + search partners, no display'],
      () => customer.campaigns.create([o]))) || `[NEW campaign ${CAMPAIGN.name}]`;
  }
  console.log('');

  // ── 2. Geo + language ──
  console.log('━━━ 2. Geo + language criteria');
  const geoOps = geos.filter(g => !existing.geos.has(g)).map(g => ({ campaign: campaignRn, negative: false, location: { geo_target_constant: g } }));
  if (!geoOps.length) skip('campaign_criteria.create locations', 'all present');
  else await op(`campaign_criteria.create ×${geoOps.length} locations`, geoOps.map(o => `${o.location.geo_target_constant} (${nameOf.get(o.location.geo_target_constant) || '?'})`), () => customer.campaignCriteria.create(geoOps));
  if (existing.lang) skip('campaign_criteria.create language', 'present');
  else await op('campaign_criteria.create language', [`${CAMPAIGN.languageConstant} (German)`], () => customer.campaignCriteria.create([{ campaign: campaignRn, negative: false, language: { language_constant: CAMPAIGN.languageConstant } }]));
  console.log('');

  // ── 3. Ad groups ──
  for (const g of AD_GROUPS) {
    console.log(`━━━ 3. Ad group ${g.name} → ${SITE}${g.lp} (${g.keywords.length} keywords)`);
    let agRn = existing.adGroups.get(g.name);
    if (agRn) skip(`ad_groups.create ${g.name}`, `exists (${agRn})`);
    else agRn = (await op(`ad_groups.create ${g.name}`, [`campaign=${campaignRn} status=ENABLED type=SEARCH_STANDARD cpc_bid_micros=${CAMPAIGN.maxCpcMicros} (CHF 0.20)`],
      () => customer.adGroups.create([{ name: g.name, campaign: campaignRn, status: enums.AdGroupStatus.ENABLED, type: enums.AdGroupType.SEARCH_STANDARD, cpc_bid_micros: CAMPAIGN.maxCpcMicros }]))) || `[NEW ad_group ${g.name}]`;

    const kwOps = g.keywords.filter(k => !existing.keywords.has(`${g.name}|${k}|PHRASE`)).map(text => ({ ad_group: agRn, status: enums.AdGroupCriterionStatus.ENABLED, keyword: { text, match_type: enums.KeywordMatchType.PHRASE } }));
    const kwSkipped = g.keywords.length - kwOps.length;
    if (kwSkipped) skip(`ad_group_criteria.create ×${kwSkipped} keywords in ${g.name}`, 'exist');
    if (kwOps.length) await op(`ad_group_criteria.create ×${kwOps.length} keywords in ${g.name}`, kwOps.map(o => `[PHRASE] "${o.keyword.text}"`), () => customer.adGroupCriteria.create(kwOps));

    const finalUrl = `${SITE}${g.lp}?${UTM}`;
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

  // ── 4. Negatives ──
  console.log(`━━━ 4. Campaign negatives (${NEGATIVES.length})`);
  const negOps = NEGATIVES.filter(n => !existing.negatives.has(n.text)).map(n => ({ campaign: campaignRn, negative: true, keyword: { text: n.text, match_type: enums.KeywordMatchType[n.match] } }));
  if (NEGATIVES.length - negOps.length) skip(`campaign_criteria.create ×${NEGATIVES.length - negOps.length} negatives`, 'exist');
  if (negOps.length) await op(`campaign_criteria.create ×${negOps.length} negatives`, negOps.map(o => `[${enumName('KeywordMatchType', o.keyword.match_type)}] "${o.keyword.text}"`), () => customer.campaignCriteria.create(negOps));
  console.log('');

  console.log(`${APPLY ? 'Sent' : 'Would send'} ${opCount} operation(s), skipped ${skipCount}.`);
  if (!APPLY) console.log('DRY-RUN — nothing was sent to Google Ads.');
  else console.log('Campaign created PAUSED — activate in the Google Ads UI when the owner says so.');
}

module.exports = { CAMPAIGN, AD_GROUPS, NEGATIVES, SITE, UTM };
if (require.main === module) main().catch(e => {
  console.error('ERR:', e.message);
  if (e.errors) console.error(JSON.stringify(e.errors, null, 2).slice(0, 3000));
  process.exit(1);
});
