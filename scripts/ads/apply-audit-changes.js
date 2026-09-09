#!/usr/bin/env node
/**
 * Apply the 11-step write list from tasks/ads-audit-2026-09-09.md to Search-Deutschschweiz-v1.
 *
 *   node scripts/ads/apply-audit-changes.js                 # DRY-RUN (default): prints every op it WOULD send
 *   node scripts/ads/apply-audit-changes.js --step=6        # one step only (still dry-run)
 *   node scripts/ads/apply-audit-changes.js --apply         # LIVE — only after the owner's explicit go
 *   node scripts/ads/apply-audit-changes.js --apply --step=1
 *
 * Owner decisions baked in (tasks/ads-reactivation-2026-09-09.md, "Owner decisions 2026-09-09 (evening)"):
 *   - new ad group Kinderbuch-Selbst-Gestalten lands on https://magicalstory.ch/kinderbuch-erstellen
 *   - the «Geschichten in Zürich» sitelink is unlinked from this campaign (asset kept for other campaigns)
 *   - C4-1 Styles structured snippet is included; C4-2 (occasion Types) is not
 *   - writes must not run before the S2/S3/S4 staging commits are on production
 *
 * Idempotent: every step re-reads the account first and skips what already exists (ad group by name, keyword by
 * text+match type in its ad group, asset by type+text, campaign link by asset id, negative by text). Re-running
 * after --apply must be a no-op.
 *
 * Steps (execution order = the audit's "Exact write list for approval"):
 *   1  ad_groups.create Kinderbuch-Selbst-Gestalten (CPC 1.20)
 *   2  ad_group_criteria.create ×4 keywords in the new group; remove `kinderbuch selbst gestalten` from Personalisiertes-Kinderbuch
 *   3  move `bilderbuch personalisiert` Personalisiertes-Kinderbuch → Bilderbuch-Mit-Eigenem-Kind
 *   4  ad_group_criteria.update `personalisiertes bilderbuch`: clear cpc_bid_micros
 *   5  ad_group_ads.create RSA in the new group
 *   6  ads.update ×3 existing RSAs: headline swaps + utm_campaign=deutschschweiz
 *   7  assets.update sitelink «Über 44 Themen entdecken» → «170+ Themen entdecken»
 *   8  assets.create + campaign_assets.create ×3 sitelinks; campaign_assets.remove «Geschichten in Zürich»
 *   9  assets.create + campaign_assets.create ×4 callouts; campaign_assets.remove ×2
 *      (the audit's "assets.remove orphan «Magical Story»" is NOT possible — AssetService has no remove operation;
 *      an unlinked asset never serves, so it is reported and skipped)
 *  10  assets.create + campaign_assets.create structured snippet Styles
 *  11  campaign_criteria.create ×7 negatives
 */
const { getClient } = require('./lib/client');
const { enums } = require('google-ads-api');

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = a.match(/^--([^=]+)=(.*)$/);
  return m ? [m[1], m[2]] : [a.replace(/^--/, ''), 'true'];
}));
const APPLY = args.apply === 'true';
const ONLY_STEP = args.step ? Number(args.step) : null;
const CAMPAIGN = 'Search-Deutschschweiz-v1';
const CHF = n => Math.round(n * 1e6);

// ─── Copy (Swiss German: ss not ß, «» guillemets) ─────────────────────────────────────────────────────────────
const LIMITS = { headline: 30, description: 90, sitelinkText: 25, sitelinkLine: 35, callout: 25, snippetValue: 25, path: 15 };
const UTM = 'utm_source=google&utm_medium=search&utm_campaign=deutschschweiz';

const NEW_GROUP = {
  name: 'Kinderbuch-Selbst-Gestalten',
  cpcBidMicros: CHF(1.20),
  finalUrl: `https://magicalstory.ch/kinderbuch-erstellen?${UTM}`, // route: client/src/App.tsx → HowItWorks
  keywords: [
    'kinderbuch selbst gestalten',   // moved from Personalisiertes-Kinderbuch (B3-2)
    'kinderbuch selber gestalten',   // observed Swiss variant, 5 clicks
    'kinderbuch online gestalten',
    'eigenes kinderbuch erstellen',
  ],
  path1: 'Kinderbuch', path2: 'Gestalten',
  headlines: [
    'Kinderbuch selbst gestalten',
    'Kinderbuch selber gestalten',
    'Kinderbuch online gestalten',
    'Eigenes Kinderbuch erstellen',
    'Gestalten in 3 Minuten',
    'Foto rein, Buch raus',
    'Dein Kind, die Hauptfigur',
    'Keine Vorlage, deine Story',
    'Gratis erste Geschichte',
    'Kein Konto nötig',
    'Thema und Stil selbst wählen',
    'Als PDF oder gedrucktes Buch',
    'Nur für dein Kind gemacht',
    'Jedes Kind hat eine Geschichte',
    'Lernt spielerisch fürs Leben',
  ],
  descriptions: [
    'Gestalte ein Kinderbuch mit deinem Kind als Hauptfigur. Foto rein, Thema wählen, fertig.',
    'Keine Vorlage mit ausgetauschtem Namen: eine eigene Geschichte, in 3 Minuten erstellt.',
    'Wähle Thema und Kunststil selbst. Als PDF sofort oder als gedrucktes Buch nach Hause.',
    'Erste Geschichte gratis testen, kein Konto nötig. Dein Kind wird zum Helden.',
  ],
};

// B2/B4 headline swaps per existing ad group (descriptions unchanged, no pins)
const RSA_SWAPS = {
  'Personalisiertes-Kinderbuch': {
    out: ['Dein Kind wird zum Helden', 'Foto rein, Abenteuer raus', 'Ein Abenteuer in deiner Stadt'],
    in: ['Kinderbuch mit eigenem Namen', 'Kinderbuch mit deinem Foto', 'Personalisiert in 3 Minuten'],
  },
  'Bilderbuch-Mit-Eigenem-Kind': {
    out: ['Dein Kind wird zum Helden', 'Foto rein, Abenteuer raus'],
    in: ['Personalisiertes Bilderbuch', 'Bilderbuch mit eigenem Foto'],
  },
  'Geschenk-Kind-Buch': {
    out: ['Dein Kind wird zum Helden'],
    in: ['Geschenk mit deinem Kind drin'],
  },
};

const SITELINK_UPDATE = { // C2-1
  oldText: 'Über 44 Themen entdecken',
  linkText: '170+ Themen entdecken',
  description1: 'Mut, Ängste, ABC, Geschwister',
  description2: 'und über 160 weitere Themen',
};
const SITELINKS_NEW = [ // C2-2..4 — every path is a route in client/src/App.tsx
  { name: 'sitelink-de-so-funktionierts', linkText: 'So funktioniert\'s', description1: 'Foto hochladen, Thema wählen,', description2: 'in 3 Minuten fertig', url: 'https://www.magicalstory.ch/kinderbuch-erstellen' },
  { name: 'sitelink-de-anlass', linkText: 'Für jeden Anlass', description1: 'Geburtstag, Taufe, Einschulung,', description2: 'Weihnachten, Ostern und mehr', url: 'https://www.magicalstory.ch/anlass' },
  { name: 'sitelink-de-staedte', linkText: 'Schweizer Städte', description1: 'Echte Wahrzeichen deiner Stadt', description2: 'als Schauplatz der Geschichte', url: 'https://www.magicalstory.ch/stadt' },
];
const SITELINK_UNLINK = 'Geschichten in Zürich'; // C2-4, owner decision

const CALLOUTS_NEW = ['Kein Konto nötig', 'Hardcover oder Softcover', 'PDF sofort herunterladen', 'Lieferung: 5–7 Werktage']; // C3-1..4
const CALLOUTS_UNLINK = ['Dein Kind als Held', 'Vom Zähneputzen bis Mut']; // C3-5, C3-6
const CALLOUT_ORPHAN = 'Magical Story'; // C3-7 — reported only (no assets.remove in the API)

const SNIPPET = { header: 'Styles', values: ['Aquarell', 'Pixar 3D', 'Comic', 'Anime', 'Realistisch', 'Cartoon', 'Ölgemälde', 'Manga'] }; // C4-1, client/src/constants/artStyles.ts de names

const NEGATIVES = [ // B3b
  { text: 'wonderbly', match: 'BROAD' },
  { text: 'eiskönigin', match: 'BROAD' },
  { text: 'kinderbibel', match: 'BROAD' },
  { text: 'freundebuch', match: 'BROAD' },
  { text: 'kleinauflage', match: 'BROAD' },
  { text: 'drucken lassen', match: 'PHRASE' },
  { text: 'pappbilderbuch', match: 'BROAD' },
];

// ─── Copy validation (fails before anything is printed or sent) ───────────────────────────────────────────────
function validateCopy() {
  const problems = [];
  const check = (kind, text, max) => {
    if (text.length > max) problems.push(`${kind} "${text}" is ${text.length} chars (max ${max})`);
    if (/ß/.test(text)) problems.push(`${kind} "${text}" uses ß (Swiss spelling: ss)`);
    if (/["“”„]/.test(text)) problems.push(`${kind} "${text}" uses straight/curly quotes (use «»)`);
    if (/!/.test(text) && kind === 'headline') problems.push(`${kind} "${text}" — Google disallows ! in headlines`);
  };
  NEW_GROUP.headlines.forEach(h => check('headline', h, LIMITS.headline));
  NEW_GROUP.descriptions.forEach(d => check('description', d, LIMITS.description));
  Object.values(RSA_SWAPS).forEach(s => s.in.forEach(h => check('headline', h, LIMITS.headline)));
  check('path1', NEW_GROUP.path1, LIMITS.path); check('path2', NEW_GROUP.path2, LIMITS.path);
  check('sitelink text', SITELINK_UPDATE.linkText, LIMITS.sitelinkText);
  check('sitelink line', SITELINK_UPDATE.description1, LIMITS.sitelinkLine);
  check('sitelink line', SITELINK_UPDATE.description2, LIMITS.sitelinkLine);
  for (const s of SITELINKS_NEW) {
    check('sitelink text', s.linkText, LIMITS.sitelinkText);
    check('sitelink line', s.description1, LIMITS.sitelinkLine);
    check('sitelink line', s.description2, LIMITS.sitelinkLine);
  }
  CALLOUTS_NEW.forEach(c => check('callout', c, LIMITS.callout));
  SNIPPET.values.forEach(v => check('snippet value', v, LIMITS.snippetValue));
  if (NEW_GROUP.headlines.length !== 15) problems.push(`new RSA has ${NEW_GROUP.headlines.length} headlines (need 15)`);
  if (NEW_GROUP.descriptions.length !== 4) problems.push(`new RSA has ${NEW_GROUP.descriptions.length} descriptions (need 4)`);
  if (new Set(NEW_GROUP.headlines.map(h => h.toLowerCase())).size !== 15) problems.push('new RSA has duplicate headlines');
  if (problems.length) { console.error('COPY VALIDATION FAILED:\n  ' + problems.join('\n  ')); process.exit(1); }
}

// ─── Output + execution helper ────────────────────────────────────────────────────────────────────────────────
const MODE = APPLY ? 'LIVE' : 'DRY';
let opCount = 0, skipCount = 0;
function show(lines) { for (const l of lines) console.log('    ' + l); }
/** Print what would be sent; execute only with --apply. `fn` returns the mutate response. */
async function op(label, detail, fn) {
  opCount++;
  console.log(`  [${MODE}] ${label}`);
  show(detail);
  if (!APPLY) return null;
  const res = await fn();
  const rn = res && res.results && res.results[0] && res.results[0].resource_name;
  console.log(`    ✓ ${rn || 'ok'}`);
  return rn;
}
function skip(label, why) { skipCount++; console.log(`  [SKIP] ${label} — ${why}`); }
const q = s => String(s).replace(/'/g, "\\'");
const enumName = (en, v) => (typeof v === 'string' ? v : (enums[en] && enums[en][v]) || String(v));

// ─── Account state (read-only GAQL; re-read before every run so the plan is idempotent) ───────────────────────
async function loadState(customer) {
  const st = { adGroups: new Map(), keywords: new Map(), rsas: new Map(), campaignAssets: [], assets: [], negatives: new Set() };
  const camps = await customer.query(`SELECT campaign.id, campaign.resource_name FROM campaign WHERE campaign.name='${q(CAMPAIGN)}' AND campaign.status != 'REMOVED'`);
  if (!camps.length) throw new Error(`Campaign "${CAMPAIGN}" not found`);
  st.campaignId = camps[0].campaign.id;
  st.campaignRn = camps[0].campaign.resource_name;

  for (const r of await customer.query(`SELECT campaign.id, ad_group.id, ad_group.name, ad_group.resource_name, ad_group.cpc_bid_micros FROM ad_group WHERE campaign.id=${st.campaignId} AND ad_group.status != 'REMOVED'`))
    st.adGroups.set(r.ad_group.name, r.ad_group);

  for (const r of await customer.query(`
    SELECT campaign.id, ad_group.name, ad_group_criterion.resource_name, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, ad_group_criterion.cpc_bid_micros
    FROM ad_group_criterion WHERE campaign.id=${st.campaignId} AND ad_group_criterion.type='KEYWORD' AND ad_group_criterion.negative=false AND ad_group_criterion.status != 'REMOVED'`)) {
    const c = r.ad_group_criterion;
    st.keywords.set(`${r.ad_group.name}|${c.keyword.text.toLowerCase()}|${enumName('KeywordMatchType', c.keyword.match_type)}`, { rn: c.resource_name, cpcBidMicros: c.cpc_bid_micros });
  }

  for (const r of await customer.query(`
    SELECT campaign.id, ad_group.name, ad_group_ad.ad.resource_name, ad_group_ad.ad.id, ad_group_ad.ad.final_urls,
           ad_group_ad.ad.responsive_search_ad.headlines, ad_group_ad.ad.responsive_search_ad.descriptions
    FROM ad_group_ad WHERE campaign.id=${st.campaignId} AND ad_group_ad.status != 'REMOVED' AND ad_group_ad.ad.type='RESPONSIVE_SEARCH_AD'`))
    st.rsas.set(r.ad_group.name, r.ad_group_ad.ad);

  const ASSET = `asset.resource_name, asset.id, asset.type, asset.final_urls, asset.sitelink_asset.link_text, asset.sitelink_asset.description1,
    asset.sitelink_asset.description2, asset.callout_asset.callout_text, asset.structured_snippet_asset.header, asset.structured_snippet_asset.values`;
  st.campaignAssets = (await customer.query(`
    SELECT campaign.id, campaign_asset.resource_name, campaign_asset.field_type, ${ASSET}
    FROM campaign_asset WHERE campaign.id=${st.campaignId} AND campaign_asset.status != 'REMOVED'`))
    .map(r => ({ linkRn: r.campaign_asset.resource_name, fieldType: enumName('AssetFieldType', r.campaign_asset.field_type), asset: r.asset }));
  st.assets = (await customer.query(`SELECT ${ASSET} FROM asset WHERE asset.type IN ('SITELINK','CALLOUT','STRUCTURED_SNIPPET')`)).map(r => r.asset);

  for (const r of await customer.query(`
    SELECT campaign.id, campaign_criterion.keyword.text, campaign_criterion.keyword.match_type FROM campaign_criterion
    WHERE campaign.id=${st.campaignId} AND campaign_criterion.type='KEYWORD' AND campaign_criterion.negative=true AND campaign_criterion.status != 'REMOVED'`))
    st.negatives.add(r.campaign_criterion.keyword.text.toLowerCase());
  return st;
}
const assetText = a => {
  const t = enumName('AssetType', a.type);
  if (t === 'SITELINK') return a.sitelink_asset && a.sitelink_asset.link_text;
  if (t === 'CALLOUT') return a.callout_asset && a.callout_asset.callout_text;
  if (t === 'STRUCTURED_SNIPPET') return a.structured_snippet_asset && `${a.structured_snippet_asset.header}: ${(a.structured_snippet_asset.values || []).join(', ')}`;
  return null;
};
/** Same type + same text; sitelinks additionally need the same final URL (the account holds older same-text sitelinks pointing elsewhere). */
const findAsset = (st, type, text, url) => st.assets.find(a => enumName('AssetType', a.type) === type && (assetText(a) || '').toLowerCase() === text.toLowerCase()
  && (!url || (a.final_urls || []).map(u => u.replace(/\/$/, '')).includes(url.replace(/\/$/, ''))));
const findLink = (st, assetId) => st.campaignAssets.find(l => String(l.asset.id) === String(assetId));

// ─── Steps ────────────────────────────────────────────────────────────────────────────────────────────────────
// Ad group resource name for the new group: from the account if it exists, from step 1 in this run, or a placeholder in dry-run.
let newGroupRn = null;
function requireNewGroup(st) {
  const ag = st.adGroups.get(NEW_GROUP.name);
  if (ag) return ag.resource_name;
  if (newGroupRn) return newGroupRn;
  if (APPLY) throw new Error(`Ad group ${NEW_GROUP.name} does not exist — run step 1 first`);
  return `[NEW ad_group ${NEW_GROUP.name}]`;
}

async function step1(customer, st) {
  if (st.adGroups.has(NEW_GROUP.name)) return skip(`ad_groups.create ${NEW_GROUP.name}`, `exists (id ${st.adGroups.get(NEW_GROUP.name).id})`);
  const o = { name: NEW_GROUP.name, campaign: st.campaignRn, status: enums.AdGroupStatus.ENABLED, type: enums.AdGroupType.SEARCH_STANDARD, cpc_bid_micros: NEW_GROUP.cpcBidMicros };
  newGroupRn = await op('ad_groups.create', [`name=${o.name} campaign=${st.campaignRn} status=ENABLED type=SEARCH_STANDARD cpc_bid_micros=${o.cpc_bid_micros} (CHF 1.20)`],
    () => customer.adGroups.create([o]));
}

async function createKeyword(customer, st, groupName, groupRn, text) {
  const key = `${groupName}|${text}|PHRASE`;
  if (st.keywords.has(key)) return skip(`ad_group_criteria.create [PHRASE] "${text}" in ${groupName}`, 'exists');
  await op(`ad_group_criteria.create [PHRASE] "${text}" in ${groupName}`, [`ad_group=${groupRn} status=ENABLED keyword.text="${text}" keyword.match_type=PHRASE`],
    () => customer.adGroupCriteria.create([{ ad_group: groupRn, status: enums.AdGroupCriterionStatus.ENABLED, keyword: { text, match_type: enums.KeywordMatchType.PHRASE } }]));
}
async function removeKeyword(customer, st, groupName, text) {
  const kw = st.keywords.get(`${groupName}|${text}|PHRASE`);
  if (!kw) return skip(`ad_group_criteria.remove [PHRASE] "${text}" from ${groupName}`, 'not present');
  await op(`ad_group_criteria.remove [PHRASE] "${text}" from ${groupName}`, [`resource_name=${kw.rn}`], () => customer.adGroupCriteria.remove([kw.rn]));
}

async function step2(customer, st) {
  const rn = requireNewGroup(st);
  for (const text of NEW_GROUP.keywords) await createKeyword(customer, st, NEW_GROUP.name, rn, text);
  await removeKeyword(customer, st, 'Personalisiertes-Kinderbuch', 'kinderbuch selbst gestalten');
}

async function step3(customer, st) {
  const target = st.adGroups.get('Bilderbuch-Mit-Eigenem-Kind');
  if (!target) throw new Error('Ad group Bilderbuch-Mit-Eigenem-Kind not found');
  await createKeyword(customer, st, 'Bilderbuch-Mit-Eigenem-Kind', target.resource_name, 'bilderbuch personalisiert');
  await removeKeyword(customer, st, 'Personalisiertes-Kinderbuch', 'bilderbuch personalisiert');
}

async function step4(customer, st) {
  const kw = st.keywords.get('Bilderbuch-Mit-Eigenem-Kind|personalisiertes bilderbuch|PHRASE');
  if (!kw) throw new Error('Keyword "personalisiertes bilderbuch" not found in Bilderbuch-Mit-Eigenem-Kind');
  if (kw.cpcBidMicros == null) return skip('ad_group_criteria.update "personalisiertes bilderbuch" clear cpc_bid_micros', 'already inherits the ad-group bid');
  await op('ad_group_criteria.update "personalisiertes bilderbuch" clear cpc_bid_micros', [`resource_name=${kw.rn} cpc_bid_micros: CHF ${(kw.cpcBidMicros / 1e6).toFixed(2)} → (unset, inherits group default CHF 1.20)`, 'update_mask=cpc_bid_micros'],
    () => customer.adGroupCriteria.update([{ resource_name: kw.rn, cpc_bid_micros: null }]));
}

async function step5(customer, st) {
  if (st.rsas.has(NEW_GROUP.name)) return skip(`ad_group_ads.create RSA in ${NEW_GROUP.name}`, `RSA ${st.rsas.get(NEW_GROUP.name).id} exists`);
  const rn = requireNewGroup(st);
  const o = {
    ad_group: rn, status: enums.AdGroupAdStatus.ENABLED,
    ad: { final_urls: [NEW_GROUP.finalUrl], responsive_search_ad: { headlines: NEW_GROUP.headlines.map(text => ({ text })), descriptions: NEW_GROUP.descriptions.map(text => ({ text })), path1: NEW_GROUP.path1, path2: NEW_GROUP.path2 } },
  };
  await op(`ad_group_ads.create RSA in ${NEW_GROUP.name}`, [
    `ad_group=${rn} status=ENABLED final_urls=[${NEW_GROUP.finalUrl}] path=/${NEW_GROUP.path1}/${NEW_GROUP.path2}`,
    ...NEW_GROUP.headlines.map((h, i) => `H${String(i + 1).padStart(2)}: ${h} (${h.length})`),
    ...NEW_GROUP.descriptions.map((d, i) => `D${i + 1}: ${d} (${d.length})`),
  ], () => customer.adGroupAds.create([o]));
}

async function step6(customer, st) {
  for (const [group, swap] of Object.entries(RSA_SWAPS)) {
    const ad = st.rsas.get(group);
    if (!ad) throw new Error(`No RSA in ad group ${group}`);
    const current = (ad.responsive_search_ad.headlines || []).map(h => h.text);
    const outSet = new Set(swap.out.map(t => t.toLowerCase()));
    const have = new Set(current.map(t => t.toLowerCase()));
    const kept = current.filter(t => !outSet.has(t.toLowerCase()));
    const added = swap.in.filter(t => !have.has(t.toLowerCase()));
    const target = [...kept, ...added];
    if (target.length > 15) throw new Error(`${group}: ${target.length} headlines after swap (max 15) — swap-outs already gone?`);
    const oldUrls = ad.final_urls || [];
    const newUrls = oldUrls.map(u => u.replace('utm_campaign=zurich', 'utm_campaign=deutschschweiz'));
    const headlinesChanged = target.join('\n') !== current.join('\n');
    const urlChanged = newUrls.join() !== oldUrls.join();
    if (!headlinesChanged && !urlChanged) { skip(`ads.update RSA ${ad.id} (${group})`, 'headlines and final URL already match'); continue; }
    const detail = [`resource_name=${ad.resource_name} update_mask=final_urls,responsive_search_ad.headlines,responsive_search_ad.descriptions`];
    if (urlChanged) detail.push(`final_urls: ${oldUrls.join(', ')} → ${newUrls.join(', ')}`);
    if (headlinesChanged) {
      current.filter(t => outSet.has(t.toLowerCase())).forEach(t => detail.push(`− ${t}`));
      added.forEach(t => detail.push(`+ ${t} (${t.length})`));
      detail.push(`= ${target.length}/15 headlines, descriptions unchanged (${(ad.responsive_search_ad.descriptions || []).length}/4)`);
    }
    await op(`ads.update RSA ${ad.id} (${group})`, detail, () => customer.ads.update([{
      resource_name: ad.resource_name, final_urls: newUrls,
      responsive_search_ad: { headlines: target.map(text => ({ text })), descriptions: ad.responsive_search_ad.descriptions },
    }]));
  }
}

async function step7(customer, st) {
  if (findAsset(st, 'SITELINK', SITELINK_UPDATE.linkText)) return skip(`assets.update sitelink «${SITELINK_UPDATE.linkText}»`, 'already reads that');
  const a = findAsset(st, 'SITELINK', SITELINK_UPDATE.oldText);
  if (!a) throw new Error(`Sitelink «${SITELINK_UPDATE.oldText}» not found`);
  await op(`assets.update sitelink ${a.id} «${SITELINK_UPDATE.oldText}» → «${SITELINK_UPDATE.linkText}»`, [
    `resource_name=${a.resource_name} update_mask=sitelink_asset.link_text,sitelink_asset.description1,sitelink_asset.description2`,
    `link_text="${SITELINK_UPDATE.linkText}" (${SITELINK_UPDATE.linkText.length}) description1="${SITELINK_UPDATE.description1}" description2="${SITELINK_UPDATE.description2}"`,
  ], () => customer.assets.update([{ resource_name: a.resource_name, sitelink_asset: { link_text: SITELINK_UPDATE.linkText, description1: SITELINK_UPDATE.description1, description2: SITELINK_UPDATE.description2 } }]));
}

/** Create an asset unless one with the same text exists, then link it to the campaign unless already linked. */
async function ensureAssetLinked(customer, st, type, text, fieldType, payload) {
  let assetRn = null;
  const existing = findAsset(st, type, text, payload.final_urls && payload.final_urls[0]);
  if (existing) { skip(`assets.create ${type} «${text}»`, `exists (id ${existing.id})`); assetRn = existing.resource_name; }
  else {
    assetRn = await op(`assets.create ${type} «${text}»`, [JSON.stringify({ ...payload, type })], () => customer.assets.create([payload]));
    if (!assetRn) assetRn = `[NEW asset «${text}»]`;
  }
  if (existing && findLink(st, existing.id)) return skip(`campaign_assets.create ${fieldType} «${text}»`, 'already linked to the campaign');
  await op(`campaign_assets.create ${fieldType} «${text}»`, [`campaign=${st.campaignRn} asset=${assetRn} field_type=${fieldType}`],
    () => customer.campaignAssets.create([{ campaign: st.campaignRn, asset: assetRn, field_type: enums.AssetFieldType[fieldType] }]));
}
async function unlinkAsset(customer, st, type, text) {
  const a = findAsset(st, type, text);
  const link = a && findLink(st, a.id);
  if (!link) return skip(`campaign_assets.remove ${type} «${text}»`, a ? 'not linked to this campaign' : 'asset does not exist');
  await op(`campaign_assets.remove ${type} «${text}»`, [`resource_name=${link.linkRn} (asset ${a.id} is kept)`], () => customer.campaignAssets.remove([link.linkRn]));
}

async function step8(customer, st) {
  for (const s of SITELINKS_NEW)
    await ensureAssetLinked(customer, st, 'SITELINK', s.linkText, 'SITELINK',
      { name: s.name, type: enums.AssetType.SITELINK, final_urls: [s.url], sitelink_asset: { link_text: s.linkText, description1: s.description1, description2: s.description2 } });
  await unlinkAsset(customer, st, 'SITELINK', SITELINK_UNLINK);
}

async function step9(customer, st) {
  for (const text of CALLOUTS_NEW)
    await ensureAssetLinked(customer, st, 'CALLOUT', text, 'CALLOUT', { type: enums.AssetType.CALLOUT, callout_asset: { callout_text: text } });
  for (const text of CALLOUTS_UNLINK) await unlinkAsset(customer, st, 'CALLOUT', text);
  const orphan = findAsset(st, 'CALLOUT', CALLOUT_ORPHAN);
  if (orphan) skip(`assets.remove CALLOUT «${CALLOUT_ORPHAN}» (id ${orphan.id})`, 'NOT POSSIBLE: AssetService has no remove operation; the asset is unlinked and never serves');
  else skip(`assets.remove CALLOUT «${CALLOUT_ORPHAN}»`, 'asset does not exist');
}

async function step10(customer, st) {
  const text = `${SNIPPET.header}: ${SNIPPET.values.join(', ')}`;
  await ensureAssetLinked(customer, st, 'STRUCTURED_SNIPPET', text, 'STRUCTURED_SNIPPET',
    { type: enums.AssetType.STRUCTURED_SNIPPET, structured_snippet_asset: { header: SNIPPET.header, values: SNIPPET.values } });
}

async function step11(customer, st) {
  for (const n of NEGATIVES) {
    if (st.negatives.has(n.text)) { skip(`campaign_criteria.create negative [${n.match}] "${n.text}"`, 'exists'); continue; }
    await op(`campaign_criteria.create negative [${n.match}] "${n.text}"`, [`campaign=${st.campaignRn} negative=true keyword.text="${n.text}" keyword.match_type=${n.match}`],
      () => customer.campaignCriteria.create([{ campaign: st.campaignRn, negative: true, keyword: { text: n.text, match_type: enums.KeywordMatchType[n.match] } }]));
  }
}

const STEPS = [
  [1, 'ad group Kinderbuch-Selbst-Gestalten', step1],
  [2, 'keywords in the new group + remove selbst-gestalten from Personalisiertes-Kinderbuch', step2],
  [3, 'move bilderbuch personalisiert → Bilderbuch-Mit-Eigenem-Kind', step3],
  [4, 'clear keyword-level CPC on personalisiertes bilderbuch', step4],
  [5, 'RSA in the new group', step5],
  [6, 'headline swaps + utm_campaign=deutschschweiz on the 3 existing RSAs', step6],
  [7, 'sitelink «170+ Themen entdecken»', step7],
  [8, '3 new sitelinks + unlink «Geschichten in Zürich»', step8],
  [9, '4 new callouts + unlink 2 + orphan report', step9],
  [10, 'structured snippet Styles', step10],
  [11, '7 campaign negatives', step11],
];

async function main() {
  validateCopy();
  const { customer } = getClient();
  if (!customer) throw new Error('Missing refresh_token in scripts/ads/config.json');
  console.log(`Campaign: ${CAMPAIGN}`);
  console.log(`Mode: ${APPLY ? 'LIVE — writes go to the account' : 'DRY-RUN — nothing is sent (pass --apply to execute)'}${ONLY_STEP ? ` — step ${ONLY_STEP} only` : ''}`);
  const st = await loadState(customer);
  console.log(`State: campaign id ${st.campaignId}, ${st.adGroups.size} ad groups, ${st.keywords.size} keywords, ${st.rsas.size} RSAs, ${st.campaignAssets.length} campaign asset links, ${st.negatives.size} negatives\n`);
  for (const [n, title, fn] of STEPS) {
    if (ONLY_STEP && n !== ONLY_STEP) continue;
    console.log(`━━━ Step ${n} — ${title}`);
    await fn(customer, st);
    console.log('');
  }
  console.log(`${APPLY ? 'Sent' : 'Would send'} ${opCount} operation(s), skipped ${skipCount} (already in place or not possible).`);
  if (!APPLY) console.log('DRY-RUN — nothing was sent to Google Ads.');
}

main().catch(e => {
  console.error('ERR:', e.message);
  if (e.errors) console.error(JSON.stringify(e.errors, null, 2).slice(0, 3000));
  process.exit(1);
});
