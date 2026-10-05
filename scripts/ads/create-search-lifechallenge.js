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
  // Added 2026-10-05, each checked HTTP 200 with its own German title on production (an unknown id also returns 200 but with the
  // generic homepage title, so the title is the real check).
  potty: '/themes/life-challenges/potty-training',         // "Töpfchen-Training"
  newSibling: '/themes/life-challenges/new-sibling',       // "Neues Geschwisterchen"
  siblingFight: '/themes/life-challenges/sibling-fighting', // "Geschwisterstreit"
  jealousy: '/themes/life-challenges/jealousy',            // "Mit Eifersucht umgehen"
  kindergarten: '/themes/life-challenges/first-kindergarten', // "Erster Kindergartentag"
  moving: '/themes/life-challenges/moving-house',          // "Umzug"
  split: '/themes/life-challenges/parents-splitting',      // "Eltern leben getrennt"
  teeth: '/themes/life-challenges/brushing-teeth',         // "Zähne putzen"
  truth: '/themes/life-challenges/telling-truth',          // "Die Wahrheit sagen"
  friends: '/themes/life-challenges/making-friends',       // "Echte Freunde finden"
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

  // Added 2026-10-05 (owner: extend with more topics, bid stays CHF 0.20). Keywords: Keyword Planner CH/DE 2026-10-05
  // (raw rows in tasks/ads-keywords-2026-10-05/), volume floor 10/mo. Topics checked and left out: going to bed / sleeping (planner
  // returns only adult "einschlafen" terms), eating vegetables (only picture-book/cookbook intent), death of a pet or grandparent
  // (volume is generic "tod kinderbuch" and has no matching landing page), bullying ("kinderbuch mobbing" is school/teen intent).
  {
    name: 'Toepfchen', lp: LP.potty, path: ['Kinderbuch', 'Toepfchen'],
    copy: {
      headlines: ['Kinderbuch Töpfchentraining', 'Windeln abgewöhnen mit Buch', 'Auf das Töpfchen gehen', 'Trocken werden mit Geschichte',
        'Töpfchen ohne Druck', 'Abschied von der Windel', 'Für 2- bis 6-Jährige', ...CLOSE],
      descriptions: [
        'Ein Kinderbuch, in dem dein Kind aufs Töpfchen geht und stolz auf sich ist. Mit Foto.',
        'Windeln abgewöhnen ohne Drama: eine Geschichte nur über dein Kind.',
        TESTEN,
        'Personalisiert mit Namen und Foto. In 3 Minuten erstellt, für 2 bis 6 Jahre.',
      ],
    },
    keywords: ['töpfchentraining', 'töpfchentraining ab wann', 'ab wann töpfchentraining', 'windel abgewöhnen', 'kinderbuch töpfchen', 'bilderbuch töpfchen',
      'bilderbuch töpfchen gehen', 'kinderbuch aufs töpfchen gehen', 'kinderbücher töpfchen gehen', 'kinderbuch toilettentraining', 'buch windel abgewöhnen',
      'bücher töpfchentraining', 'töpfchentraining 3 jahre', 'windel abgewöhnen 3 jahre'],
  },
  {
    name: 'Geschwisterchen', lp: LP.newSibling, path: ['Kinderbuch', 'Geschwisterchen'],
    copy: {
      headlines: ['Buch für neues Geschwisterchen', 'Ich werde grosse Schwester', 'Wenn ein Baby kommt', 'Eifersucht aufs Baby',
        'Grosse Geschwister werden', 'Freude aufs Geschwisterchen', 'Für 2- bis 6-Jährige', ...CLOSE],
      descriptions: [
        'Ein Kinderbuch, in dem dein Kind sich aufs Geschwisterchen freut. Mit Namen und Foto.',
        'Ein Baby kommt und Eifersucht ist da: eine Geschichte nur über dein Kind.',
        TESTEN,
        'Personalisiert mit Namen und Foto. In 3 Minuten erstellt, für 2 bis 6 Jahre.',
      ],
    },
    keywords: ['kinderbuch geschwisterchen', 'kinderbuch ich bekomme ein geschwisterchen', 'bilderbuch geschwisterchen', 'kinderbuch geschwisterchen bekommen',
      'kinderbuch neues geschwisterchen', 'kinderbücher ich bekomme ein geschwisterchen', 'neues geschwisterchen eifersucht'],
  },
  {
    name: 'Geschwisterstreit', lp: LP.siblingFight, path: ['Kinderbuch', 'Geschwister'],
    copy: {
      headlines: ['Buch bei Geschwisterstreit', 'Wenn Geschwister streiten', 'Streit unter Geschwistern', 'Friedlich miteinander spielen',
        'Geschichte über Geschwister', 'Streit verstehen und lösen', 'Für 3- bis 8-Jährige', ...CLOSE],
      descriptions: [
        'Ein Kinderbuch, in dem dein Kind lernt, mit Geschwisterstreit umzugehen. Mit Foto.',
        'Geschwister streiten ständig? Eine Geschichte, in der dein Kind die Hauptfigur ist.',
        TESTEN,
        'Personalisiert mit Namen und Foto. In 3 Minuten erstellt, für 3 bis 8 Jahre.',
      ],
    },
    keywords: ['geschwisterstreit', 'streit geschwister', 'geschwisterstreit kleinkinder', 'geschwister streiten immer', 'wenn geschwister streiten',
      'geschwisterstreit lösen', 'geschwisterstreit schlichten', 'ständiger geschwisterstreit'],
  },
  {
    name: 'Eifersucht', lp: LP.jealousy, path: ['Kinderbuch', 'Eifersucht'],
    copy: {
      headlines: ['Kinderbuch über Eifersucht', 'Eifersucht unter Geschwistern', 'Mit Eifersucht umgehen', 'Kind ist eifersüchtig',
        'Eifersucht verstehen lernen', 'Geschichte über Gefühle', 'Für 3- bis 8-Jährige', ...CLOSE],
      descriptions: [
        'Ein Kinderbuch, in dem dein Kind lernt, mit Eifersucht umzugehen. Mit Namen und Foto.',
        'Eifersucht auf Geschwister: eine Geschichte nur über dein Kind.',
        TESTEN,
        'Personalisiert mit Namen und Foto. In 3 Minuten erstellt, für 3 bis 8 Jahre.',
      ],
    },
    keywords: ['kinderbuch eifersucht', 'kinderbuch eifersucht geschwister', 'kinderbuch geschwister eifersucht', 'bilderbuch geschwister eifersucht',
      'buch eifersucht geschwister', 'buch geschwister eifersucht', 'eifersucht geschwister buch'],
  },
  {
    name: 'Kindergartenstart', lp: LP.kindergarten, path: ['Kinderbuch', 'Kindergarten'],
    copy: {
      headlines: ['Buch zum Kindergartenstart', 'Erster Kindergartentag', 'Mut für den Kindergarten', 'Dein Kind im Kindergarten',
        'Aufregung vor dem Start', 'Geschichte zum Start', 'Für 2- bis 6-Jährige', ...CLOSE],
      descriptions: [
        'Ein Kinderbuch, in dem dein Kind den ersten Kindergartentag als Held erlebt. Mit Foto.',
        'Aufregung vor dem Start: eine Mutgeschichte nur über dein Kind.',
        TESTEN,
        'Personalisiert mit Namen und Foto. In 3 Minuten erstellt, für 2 bis 6 Jahre.',
      ],
    },
    keywords: ['erster kindergartentag', 'erste kindergartentag', 'erste kindergarten tag', 'bilderbuch kindergartenstart', 'der erste kindergartentag'],
  },
  {
    name: 'Umzug', lp: LP.moving, path: ['Kinderbuch', 'Umzug'],
    copy: {
      headlines: ['Kinderbuch zum Umzug', 'Wir ziehen um', 'Neues Zuhause, neuer Mut', 'Abschied vom alten Zuhause',
        'Umziehen mit Kindern', 'Neue Wohnung, neue Freunde', 'Für 3- bis 8-Jährige', ...CLOSE],
      descriptions: [
        'Ein Kinderbuch, in dem dein Kind sich auf das neue Zuhause freut. Mit Namen und Foto.',
        'Umzug und Abschied: eine Geschichte, in der dein Kind die Hauptfigur ist.',
        TESTEN,
        'Personalisiert mit Namen und Foto. In 3 Minuten erstellt, für 3 bis 8 Jahre.',
      ],
    },
    keywords: ['umzug kinderbuch', 'kinderbuch umzug', 'kinderbücher umzug', 'bilderbuch umzug', 'kinderbuch über umzug', 'kinderbuch zum thema umzug',
      'kinderbuch abschied umzug', 'kinderbuch umzug neuer kindergarten'],
  },
  {
    name: 'Trennung', lp: LP.split, path: ['Kinderbuch', 'Trennung'],
    copy: {
      headlines: ['Kinderbuch bei Trennung', 'Wenn Eltern sich trennen', 'Kinderbuch über Scheidung', 'Trennung kindgerecht erklärt',
        'Zwei Zuhause für dein Kind', 'Geborgenheit im Buch', 'Für 3- bis 8-Jährige', ...CLOSE],
      descriptions: [
        'Ein Kinderbuch für Kinder getrennter Eltern, in dem dein Kind die Hauptfigur ist.',
        'Trennung und Veränderung: eine behutsame Geschichte nur über dein Kind.',
        TESTEN,
        'Personalisiert mit Namen und Foto. In 3 Minuten erstellt, für 3 bis 8 Jahre.',
      ],
    },
    keywords: ['kinderbuch trennung eltern', 'kinderbücher trennung eltern', 'kinderbuch über trennung der eltern', 'kinderbuch trennung der eltern',
      'scheidung kinderbuch', 'bilderbuch trennung eltern', 'kinderbuch scheidung', 'bilderbuch scheidung', 'kinderbuch scheidung der eltern',
      'kinderbuch trennung scheidung', 'kinderbücher zum thema scheidung', 'kinderbücher über scheidung'],
  },
  {
    name: 'Zaehneputzen', lp: LP.teeth, path: ['Kinderbuch', 'Zaehneputzen'],
    copy: {
      headlines: ['Kinderbuch Zähneputzen', 'Zähne putzen mit Freude', 'Zähneputzen ohne Streit', 'Kind will nicht Zähne putzen',
        'Geschichte zum Zähneputzen', 'Dein Kind als Zahnputz-Held', 'Für 2- bis 6-Jährige', ...CLOSE],
      descriptions: [
        'Ein Kinderbuch, in dem dein Kind gerne die Zähne putzt. Mit Namen und Foto.',
        'Zähneputzen ohne Drama: eine Geschichte nur über dein Kind.',
        TESTEN,
        'Personalisiert mit Namen und Foto. In 3 Minuten erstellt, für 2 bis 6 Jahre.',
      ],
    },
    keywords: ['zähneputzen kinderbuch', 'kinderbuch zähneputzen', 'bilderbuch zähne putzen', 'kinderbuch über zähneputzen', 'kinderbücher zähne putzen',
      'zähne putzen kinderbuch'],
  },
  {
    name: 'Luegen', lp: LP.truth, path: ['Kinderbuch', 'Wahrheit'],
    copy: {
      headlines: ['Kinderbuch über Lügen', 'Die Wahrheit sagen lernen', 'Wenn dein Kind lügt', 'Ehrlich sein im Buch',
        'Geschichte über Wahrheit', 'Mut zur Wahrheit', 'Für 3- bis 8-Jährige', ...CLOSE],
      descriptions: [
        'Ein Kinderbuch, in dem dein Kind lernt, die Wahrheit zu sagen. Mit Namen und Foto.',
        'Lügen und Ausreden: eine Geschichte, in der dein Kind die Hauptfigur ist.',
        TESTEN,
        'Personalisiert mit Namen und Foto. In 3 Minuten erstellt, für 3 bis 8 Jahre.',
      ],
    },
    keywords: ['kinderbuch lügen', 'lügen kinderbuch', 'kinderbuch über lügen', 'kinderbuch thema lügen', 'kinderbücher über lügen', 'bilderbuch lügen',
      'bilderbuch über lügen', 'kinderbuch wahrheit sagen', 'kinderbücher zum thema lügen'],
  },
  {
    name: 'Freunde-finden', lp: LP.friends, path: ['Kinderbuch', 'Freunde'],
    copy: {
      headlines: ['Kinderbuch Freunde finden', 'Echte Freunde finden', 'Wenn dein Kind Anschluss sucht', 'Freundschaft im Buch',
        'Mut, auf andere zuzugehen', 'Geschichte über Freundschaft', 'Für 3- bis 8-Jährige', ...CLOSE],
      descriptions: [
        'Ein Kinderbuch, in dem dein Kind Freunde findet. Mit Namen und Foto.',
        'Neue Kinder kennenlernen: eine Geschichte nur über dein Kind.',
        TESTEN,
        'Personalisiert mit Namen und Foto. In 3 Minuten erstellt, für 3 bis 8 Jahre.',
      ],
    },
    keywords: ['kinderbuch freunde finden', 'bilderbuch freunde finden', 'freunde finden kinderbuch', 'kinderbücher freunde finden'],
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
  'schnullerkette', 'nuggikette', 'schnullerbaum', 'spielzeug', 'kinderspielzeug', 'zahnpasta', 'zahnspange', 'nachtlicht', 'kuscheltier',
  // institutional buyers
  'krippe', 'grundschule', 'kita team', 'kindergarten team',
  // 2026-10-05 additions, each seen in the raw planner rows of the new topics: teen intent, potty tools, kindergarten portfolios, DDR history
  'pubertät', 'jugendbuch', 'trainerhosen', 'belohnungstafel', 'portfolio', 'ddr',
];

const SPEC = {
  name: 'Search-LifeChallenge-CH',
  budgetName: 'Search-LifeChallenge-CH-Budget',
  // BROAD since 2026-09-27 (owner): 6 days on PHRASE, 1 impression; Schnuller and Buch-Gefuehle had no eligible
  // auctions at all. The adult/clinical and professional negatives above are what make broad safe here.
  matchType: 'BROAD',
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
