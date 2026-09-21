#!/usr/bin/env node
/**
 * Create the PAUSED cheap-click Search campaigns (plan: tasks/ads-cheap-clicks-2026-09-09.md).
 *
 * Split into TWO campaigns on 2026-09-21 (owner: "split it") so the age-gift and occasion clusters
 * carry their own daily budget and their own line in attribution-report.js:
 *
 *   Search-Cheap-Age-CH        CHF 3/day   Alter-3 … Alter-9-10   (the only family with real volume)
 *   Search-Cheap-Occasion-CH   CHF 2/day   Goettikind, Einschulung, Geschwisterkind
 *
 *   node scripts/ads/create-search-cheap.js --set=age              # DRY-RUN: prints every op it WOULD send
 *   node scripts/ads/create-search-cheap.js --set=occasion --apply # LIVE create — only after the owner's go
 *   node scripts/ads/create-search-cheap.js --set=both             # both specs, in order
 *
 * Owner target (tasks/ads-reactivation-2026-09-09.md): as many clicks as possible under CHF 0.20, then let
 * scripts/ads/attribution-report.js show what converts.
 *
 *   MANUAL_CPC, no enhanced CPC · every ad group max CPC CHF 0.20 · SEARCH (budget per spec, see above)
 *   Geo: read at runtime from Search-Deutschschweiz-v1 (the 19 German-speaking cantons) · language German (1001)
 *   No device bid modifiers (the audit flagged the −30 % mobile modifier on the main campaign as self-inflicted rank loss)
 *   Keywords: PHRASE, every one measured by Keyword Planner on 2026-09-09 with a LOW top-of-page bid <= CHF 0.20 or no
 *   estimate at all (unbid); direction traps (gift for the godparent / teacher, toys, crafts, baby, rites) are negatives.
 *   Final URLs carry utm_term={keyword} (ValueTrack) so trial_events → attribution-report.js can attribute per keyword.
 *
 * Idempotent by name: an existing campaign / budget / ad group / keyword / RSA / negative is detected and skipped, so a
 * re-run after --apply is a no-op and a half-finished run can be completed by running again.
 */
const { run, CHF } = require('./lib/search-campaign');

const APPLY = process.argv.includes('--apply');
const SET = (process.argv.find(a => a.startsWith('--set=')) || '').slice(6);

const SITE = 'https://magicalstory.ch';
const COMMON = {
  maxCpcMicros: CHF(0.20),
  geoSource: 'Search-Deutschschweiz-v1',
  languageConstant: 'languageConstants/1001',
  site: SITE,
};

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

const AGE_GROUPS = [
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
];

const OCCASION_GROUPS = [
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
];

// ─── The two specs ────────────────────────────────────────────────────────────────────────────────────────────
const SPECS = {
  age: {
    ...COMMON,
    name: 'Search-Cheap-Age-CH',
    budgetName: 'Search-Cheap-Age-CH-Budget',
    dailyBudgetMicros: CHF(3),
    utm: 'utm_source=google&utm_medium=search&utm_campaign=cheap-age-ch&utm_term={keyword}',
    adGroups: AGE_GROUPS,
    negatives: NEGATIVES,
  },
  occasion: {
    ...COMMON,
    name: 'Search-Cheap-Occasion-CH',
    budgetName: 'Search-Cheap-Occasion-CH-Budget',
    dailyBudgetMicros: CHF(2),
    utm: 'utm_source=google&utm_medium=search&utm_campaign=cheap-occasion-ch&utm_term={keyword}',
    adGroups: OCCASION_GROUPS,
    negatives: NEGATIVES,
  },
};

// --- Dispatch --------------------------------------------------------------------------------------------------
async function main() {
  const which = SET === 'both' ? ['age', 'occasion'] : SET ? [SET] : [];
  if (!which.length || which.some(k => !SPECS[k])) {
    console.error('Usage: node scripts/ads/create-search-cheap.js --set=age|occasion|both [--apply]');
    process.exit(1);
  }
  for (const k of which) {
    await run(SPECS[k], APPLY);
    console.log('');
  }
}

module.exports = { SPECS, AGE_GROUPS, OCCASION_GROUPS, NEGATIVES, SITE };
if (require.main === module) main().catch(e => {
  console.error('ERR:', e.message);
  if (e.errors) console.error(JSON.stringify(e.errors, null, 2).slice(0, 3000));
  process.exit(1);
});
