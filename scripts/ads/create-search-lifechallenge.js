#!/usr/bin/env node
/**
 * Create the PAUSED life-challenge Search campaign `Search-LifeChallenge-CH`.
 *
 *   node scripts/ads/create-search-lifechallenge.js            # DRY-RUN: prints every op it WOULD send
 *   node scripts/ads/create-search-lifechallenge.js --apply     # LIVE create - only after the owner's go
 *
 * Owner mandate 2026-09-21: the 4th arm of the CHF 10/day week - "something like anxiety or getting rid of
 * pacifier or some other life challenge that no one is buying". CHF 2/day, Manual CPC 0.20, same engine and
 * same geo (19 German-speaking cantons) as the cheap campaigns.
 *
 * THE THESIS: these topics have real Swiss search volume and essentially NO advertisers, so a CHF 0.20 cap
 * can win the auction outright. The counter-thesis, stated to the owner before spending: the intent is
 * INFORMATIONAL - a parent typing "trotzphase" wants advice tonight, not a CHF 39 book. The `Buch-Gefuehle`
 * ad group is the hedge: same topics, but people explicitly searching for a BOOK.
 *
 * Every keyword below was measured by Keyword Planner on 2026-09-21 (German / Switzerland) via
 * scripts/ads/keyword-ideas.js; raw rows in tasks/ads-lifechallenge-keywords-2026-09-21/. Nothing here is inferred from a
 * topic name. Deliberately DROPPED families and rows, so a later session does not "restore" them:
 *   - Eingewoehnung Kindergarten: the volume is daycare STAFF, not parents ("berliner eingewoehnungsmodell"
 *     70/mo, "beobachtungsbogen", "checkliste", "fortbildung"). Only one parent-facing row had volume.
 *   - Adult anxiety: "trennungsangst erwachsene", "angst im dunkeln erwachsene", "angstzustaende im dunkeln",
 *     "panische angst im dunkeln", "schulphobie". Clinical / adult intent - we do not put a children's book
 *     in front of someone searching panic-attack terms. All are campaign negatives below.
 *   - Named competitor titles ("bilderbuch jim ist mies drauf", "das gewuenschteste wunschkind trotzphase").
 *   - Institutional buyers ("bilderbuch gefuehle krippe / grundschule").
 *   - Thumb-sucking ("daumen abgewoehnen") - we have no landing page for it.
 */
const { run, CHF } = require('./lib/search-campaign');

const APPLY = process.argv.includes('--apply');
const SITE = 'https://magicalstory.ch';

// Landing pages verified live on production 2026-09-21 (HTTP 200, German titles).
const LP = {
  emotions: '/themes/life-challenges/managing-emotions',   // "Grosse Gefühle bewältigen"
  pacifier: '/themes/life-challenges/no-pacifier',         // "Ohne Schnuller"
  anxiety: '/themes/life-challenges/anxiety-worrying',     // "Sorgen & Ängste"
};

// Shared closing copy - identical wording across groups on purpose (one claim, one phrasing).
const CLOSE = ['Erste Geschichte gratis', 'In 3 Minuten erstellt', 'Gedruckt in der Schweiz', 'Nur für dein Kind gemacht',
  'Personalisiertes Kinderbuch', 'Mit Foto deines Kindes', 'Dein Kind als Hauptfigur', 'Jedes Kind hat eine Geschichte'];
const TESTEN = 'Erste Geschichte gratis testen. Als PDF sofort oder gedruckt in der Schweiz.';

const AD_GROUPS = [
  {
    name: 'Trotzphase-Wut', lp: LP.emotions, path: ['Kinderbuch', 'Gefuehle'],
    copy: {
      headlines: ['Kinderbuch über Wut', 'Buch für die Trotzphase', 'Wenn das Kind wütend wird', 'Grosse Gefühle im Buch',
        'Wut verstehen lernen', 'Geschichte über Gefühle', 'Für 2- bis 6-Jährige', ...CLOSE],
      descriptions: [
        'Ein Kinderbuch, in dem dein Kind lernt, mit Wut und grossen Gefühlen umzugehen.',
        'Trotzphase? Eine Geschichte, in der dein Kind selbst die Hauptfigur ist.',
        TESTEN,
        'Personalisiert mit Namen und Foto. In 3 Minuten erstellt, für 2 bis 6 Jahre.',
      ],
    },
    keywords: ['trotzphase', 'trotz phase', 'trotzphase bei kleinkindern', 'trotzphase kleinkinder', 'autonomiephase', 'trotzalter',
      'trotzphase mit 2', 'trotzphase mit 3', 'trotzphase mit 4', 'trotzphase 2 jahre', 'trotzphase 3 jahre', 'trotzphase bis wann',
      'trotzanfall 2 jahre', 'trotzalter 3 jahre'],
  },
  {
    name: 'Schnuller', lp: LP.pacifier, path: ['Kinderbuch', 'Schnuller'],
    copy: {
      headlines: ['Buch: Schnuller abgewöhnen', 'Nuggi abgewöhnen mit Buch', 'Abschied vom Schnuller', 'Ohne Nuggi einschlafen',
        'Sanft und ohne Druck', 'Die Schnullerfee kommt', 'Für 2- bis 5-Jährige', ...CLOSE],
      descriptions: [
        'Ein Kinderbuch, in dem dein Kind sich vom Schnuller verabschiedet. Mit Foto.',
        'Nuggi abgewöhnen ohne Drama: eine Geschichte nur über dein Kind.',
        TESTEN,
        'Personalisiert mit Namen und Foto. In 3 Minuten erstellt, für 2 bis 5 Jahre.',
      ],
    },
    keywords: ['schnuller abgewöhnen', 'nuggi abgewöhnen', 'schnuller entwöhnung', 'nuggi entwöhnung', 'schnuller wann abgewöhnen',
      'ab wann nuggi abgewöhnen', 'nuggi abgewöhnen mit 3', 'nuggi abgewöhnen mit 4', 'schnuller abgewöhnen ab wann',
      'schnuller abgewöhnen buch', 'buch schnuller abgewöhnen', 'kinderbuch schnuller abgewöhnen', 'bücher schnuller abgewöhnen',
      'buch schnuller weg', 'schnuller abgewöhnen mit 3 jahren', 'schnuller abgewöhnen mit 4 jahren', 'schnuller entwöhnen', 'nuckel abgewöhnen'],
  },
  {
    // The hedge: same topics, but the searcher is explicitly looking for a BOOK. Best intent in the campaign.
    name: 'Buch-Gefuehle', lp: LP.emotions, path: ['Bilderbuch', 'Gefuehle'],
    copy: {
      headlines: ['Kinderbuch über Gefühle', 'Bilderbuch zum Thema Mut', 'Buch über Geschwisterstreit', 'Emotionen kindgerecht',
        'Mut, Wut und Freude', 'Bilderbuch über Emotionen', 'Für 2- bis 8-Jährige', ...CLOSE],
      descriptions: [
        'Ein Bilderbuch über Gefühle, in dem dein Kind selbst die Hauptfigur ist.',
        'Mut, Wut, Eifersucht: die Geschichte, die dein Kind gerade braucht.',
        TESTEN,
        'Personalisiert mit Namen und Foto. In 3 Minuten erstellt, für 2 bis 8 Jahre.',
      ],
    },
    keywords: ['kinderbuch über wut', 'kinderbücher über wut', 'kinderbuch emotionen', 'bilderbuch wut', 'wut bilderbuch',
      'bilderbuch mut', 'kinderbuch mut', 'kinderbuch geschwisterstreit', 'kinderbuch gefühle ab 2', 'kinderbuch gefühle ab 3',
      'kinderbuch gefühle ab 4', 'kinderbuch gefühle ab 5', 'kinderbuch gefühle ab 2 jahre', 'kinderbuch über wut ab 2',
      'kinderbuch wut ab 3', 'bilderbuch emotionen', 'bilderbuch gefühle kindergarten', 'bilderbuch thema gefühle',
      'bilderbuch thema mut', 'bilderbuch thema wut', 'bilderbuch thema angst', 'bilderbuch zum thema gefühle',
      'bilderbücher zum thema angst', 'buch gefühle kindergarten'],
  },
  {
    name: 'Aengste', lp: LP.anxiety, path: ['Kinderbuch', 'Mut'],
    copy: {
      headlines: ['Buch gegen Angst im Dunkeln', 'Wenn dein Kind Angst hat', 'Mutgeschichte für dein Kind', 'Kinderbuch über Ängste',
        'Mut für kleine Sorgen', 'Trennungsangst begleiten', 'Für 3- bis 8-Jährige', ...CLOSE],
      descriptions: [
        'Ein Kinderbuch, in dem dein Kind seine Angst überwindet. Mit Namen und Foto.',
        'Angst im Dunkeln oder beim Abschied: eine Mutgeschichte nur über dein Kind.',
        TESTEN,
        'Personalisiert mit Namen und Foto. In 3 Minuten erstellt, für 3 bis 8 Jahre.',
      ],
    },
    keywords: ['angst im dunkeln', 'angst vor dem dunkeln', 'angst vorm dunkeln', 'angst alleine im dunkeln', 'angst im dunkeln alleine',
      'angst im dunkeln schlafen', 'angst im dunkeln zu schlafen', 'angst im dunkeln was tun', 'angst im dunkeln überwinden',
      'kinderängste', 'kinderangst', 'kinderängste verstehen', 'kinderängste mit 5 jahren', 'trennungsangst'],
  },
];

const NEGATIVES = [
  // adult / clinical intent - the biggest trap in this cluster (see the header note)
  'erwachsene', 'erwachsener', 'angstzustände', 'panikattacke', 'panikattacken', 'panische', 'phobie', 'schulphobie',
  'therapie', 'therapeut', 'psychologe', 'psychiater', 'psychotherapie', 'medikament', 'symptome', 'diagnose', 'adhs', 'autismus', 'trauma',
  // professionals and students, not parents
  'berliner', 'eingewöhnungsmodell', 'beobachtungsbogen', 'checkliste', 'erzieherin', 'erzieher', 'kindergärtnerin', 'lehrerin', 'lehrer',
  'fortbildung', 'weiterbildung', 'praktikum', 'hausarbeit', 'facharbeit', 'bachelorarbeit', 'unterrichtsmaterial', 'arbeitsblatt', 'arbeitsblätter',
  // free / non-purchase intent
  'kostenlos', 'gratis', 'pdf download', 'download', 'ausmalbuch', 'ausmalbild', 'hörbuch', 'youtube', 'podcast', 'app', 'zum ausdrucken',
  // named competitor / existing titles
  { text: 'jim ist mies drauf', match: 'PHRASE' }, { text: 'gewünschteste wunschkind', match: 'PHRASE' },
  'conni', 'bobo', 'elsa', 'globi', 'librio', 'wonderbly', 'kindsgut',
  // products that are not a book
  'schnullerkette', 'nuggikette', 'schnullerbaum', 'spielzeug', 'zahnpasta', 'zahnspange', 'nachtlicht', 'kuscheltier',
  // institutional buyers
  'krippe', 'grundschule', 'kita team', 'kindergarten team',
];

const SPEC = {
  name: 'Search-LifeChallenge-CH',
  budgetName: 'Search-LifeChallenge-CH-Budget',
  dailyBudgetMicros: CHF(2),
  maxCpcMicros: CHF(0.20),
  geoSource: 'Search-Deutschschweiz-v1',
  languageConstant: 'languageConstants/1001',
  site: SITE,
  utm: 'utm_source=google&utm_medium=search&utm_campaign=lifechallenge-ch&utm_term={keyword}',
  adGroups: AD_GROUPS,
  negatives: NEGATIVES,
};

module.exports = { SPEC, AD_GROUPS, NEGATIVES };
if (require.main === module) run(SPEC, APPLY).catch(e => {
  console.error('ERR:', e.message);
  if (e.errors) console.error(JSON.stringify(e.errors, null, 2).slice(0, 3000));
  process.exit(1);
});
