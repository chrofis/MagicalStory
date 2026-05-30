import { useState, useMemo, useEffect } from 'react';
import { Link, useParams, Navigate } from 'react-router-dom';
import { useLanguage } from '@/context/LanguageContext';
import { useSwissStories } from '@/context/SEODataContext';
import { Navigation, Footer } from '@/components/common';
import { ArrowRight, ChevronRight, ChevronDown, BookOpen, Sparkles } from 'lucide-react';

interface LocalizedString { en: string; de: string; fr: string }

// ─── Per-city illustration gallery ──────────────────────────────────────────
// Shown on /stadt/{cityId} above the story ideas, so a visitor immediately
// sees what a story set in this city actually looks like. Images live in
// client/public/images/cities/{cityId}/ (copied from scripts/ads/approved
// at build time — those creatives are reused so we don't generate new
// illustrations just for this page).
//
// Cities without approved illustrations yet (e.g. Zürich) are omitted —
// the intro text alone is shown, no gallery row.
interface CityGalleryItem {
  src: string;
  landmark: string; // caption shown under the image
}
// Image order matters: slice(0,2) renders at the top of the hero, slice(2,4)
// renders above the bottom CTA. Pairs are arranged boy + girl on each row
// (knight/pirate/superhero are boy-coded, princess/wizard girl-coded in our
// approved creatives) so both rows feel inclusive.
const CITY_GALLERIES: Record<string, CityGalleryItem[]> = {
  aarau: [
    // top pair
    { src: '/images/cities/aarau/aarau-book-knight-ethan-oberer-turm-aarau.jpg', landmark: 'Oberer Turm' },        // boy
    { src: '/images/cities/aarau/aarau-book-princess-lily-stadtkirche-aarau.jpg', landmark: 'Stadtkirche' },      // girl
    // bottom pair
    { src: '/images/cities/aarau/aarau-book-pirate-ethan-biberstein-castle.jpg', landmark: 'Schloss Biberstein' }, // boy
    { src: '/images/cities/aarau/aarau-book-wizard-lily-kloster-st-ursula-aarau.jpg', landmark: 'Kloster St. Ursula' }, // girl
  ],
  baden: [
    // top pair
    { src: '/images/cities/baden/baden-book-knight-holzbruecke-square-v3.jpg', landmark: 'Holzbrücke' },     // boy
    { src: '/images/cities/baden/baden-book-princess-action-ref.jpg', landmark: 'Altstadt' },                // girl
    // bottom pair
    { src: '/images/cities/baden/baden-book-superhero-panorama.jpg', landmark: 'Panorama' },                 // boy
    { src: '/images/cities/baden/baden-book-wizard-stadtturm-portrait.jpg', landmark: 'Stadtturm' },         // girl
  ],
  winterthur: [
    // top pair
    { src: '/images/cities/winterthur/winterthur-book-knight-ethan-alte-kaserne-winterthur.jpg', landmark: 'Alte Kaserne' },  // boy
    { src: '/images/cities/winterthur/winterthur-book-princess-stadtkirche.jpg', landmark: 'Stadtkirche' },                   // girl
    // bottom pair
    { src: '/images/cities/winterthur/winterthur-book-pirate-ethan-fischmaedchenbrunnen.jpg', landmark: 'Fischmädchenbrunnen' }, // boy
    { src: '/images/cities/winterthur/winterthur-book-wizard-lily-casinotheater-winterthur.jpg', landmark: 'Casinotheater' },    // girl
  ],
};

// Map sage IDs to city IDs where they're most relevant
const SAGE_CITY_MAP: Record<string, string[]> = {
  andermatt: ['sage-devils-bridge'],
  luzern: ['sage-dragons-pilatus'],
  stgallen: ['sage-st-gall-bear'],
  basel: ['sage-vogel-gryff'],
  chur: ['sage-heidi'],
  maienfeld: ['sage-heidi'],
  zermatt: ['sage-gargantua-matterhorn'],
  altdorf: ['sage-wilhelm-tell'],
  buerglen: ['sage-wilhelm-tell'],
  sempach: ['sage-winkelried-sempach'],
  stans: ['sage-winkelried-sempach'],
};

const pageTexts: Record<string, {
  breadcrumbRoot: string;
  // Intro block — three paragraphs.
  //   intro.scene: opening line that puts the child in the city
  //   intro.customLabel + customBody: path A (pick any topic, we set it here)
  //   intro.historicalLabel + historicalBody: path B (pick a historical
  //     tale below)
  // All strings support a {city} placeholder substituted at render time.
  intro: {
    scene: string;
    customLabel: string;
    customBody: string;
    historicalLabel: string;
    historicalBody: string;
  };
  ideasTitle: string;
  ideasSubtitle: string;
  contextLabel: string;
  sagenTitle: string;
  howTitle: string;
  howSteps: { title: string; desc: string }[];
  nearbyTitle: string;
  ctaTitle: string;
  ctaSubtitle: string;
  ctaButton: string;
  ctaTrialButton: string;
  ctaTrialNote: string;
  createButton: string;
  createAccountButton: string;
  createAccountNote: string;
}> = {
  en: {
    breadcrumbRoot: 'Swiss Cities',
    intro: {
      scene: 'Your child becomes the hero of a story set right here in {city} — at the city\'s real landmarks, in the familiar streets, in front of the buildings they know from everyday life.',
      customLabel: 'You pick the topic',
      customBody: 'A fantasy adventure, a birthday gift, courage at the dentist, friendship on the first day of school — or any of 170+ themes from our library. Create a free account, pick your topic in the wizard, we set the story in {city}.',
      historicalLabel: 'Or become part of {city}\'s history',
      historicalBody: 'Below you find {city}\'s historical tales — from old legends to famous local events. Create a free account, pick one as your starting point, your child takes a role inside it.',
    },
    ideasTitle: 'Historical tales from {city}',
    ideasSubtitle: 'Real stories from {city}\'s past — pick one and your child takes a role',
    contextLabel: 'Historical context',
    sagenTitle: 'Local Legends',
    howTitle: 'How It Works',
    howSteps: [
      { title: 'Upload a photo', desc: 'Your child becomes the illustrated hero of the story.' },
      { title: 'Pick a story idea', desc: 'Choose from local stories or 170+ other themes.' },
      { title: 'Get your book', desc: 'A personalized illustrated story ready in minutes.' },
    ],
    nearbyTitle: 'Nearby Cities',
    ctaTitle: 'Create Your Swiss Story',
    ctaSubtitle: 'Your child as the main character in a story set right here.',
    ctaButton: 'Create Account (Free)',
    ctaTrialButton: 'Or try a free trial story first',
    ctaTrialNote: 'Swiss Stories require a free account. Trial stories use other themes.',
    createButton: 'Create This Story',
    createAccountButton: 'Create free account',
    createAccountNote: 'Swiss Stories require a free account',
  },
  de: {
    breadcrumbRoot: 'Schweizer Städte',
    intro: {
      scene: 'Dein Kind wird zum Helden einer Geschichte, die in {city} spielt — an echten Wahrzeichen der Stadt, in den vertrauten Gassen, vor den Gebäuden, die es aus dem Alltag kennt.',
      customLabel: 'Du wählst das Thema selbst',
      customBody: 'Ein fantastisches Abenteuer, ein Geburtstagsgeschenk, Mut beim Zahnarzt, Freundschaft im ersten Schuljahr — oder eines von über 170 Themen aus unserer Bibliothek. Erstelle ein kostenloses Konto, wähle dein Thema im Assistenten, wir lassen die Geschichte in {city} spielen.',
      historicalLabel: 'Oder werde Teil von {city}s Geschichte',
      historicalBody: 'Unten findest du {city}s historische Geschichten — von alten Sagen bis zu berühmten Ereignissen. Erstelle ein kostenloses Konto, wähle eine als Vorlage, dein Kind übernimmt darin eine Rolle.',
    },
    ideasTitle: 'Historische Geschichten aus {city}',
    ideasSubtitle: 'Echte Geschichten aus {city}s Vergangenheit — wähle eine und dein Kind übernimmt eine Rolle',
    contextLabel: 'Historischer Hintergrund',
    sagenTitle: 'Lokale Sagen',
    howTitle: 'So funktioniert\'s',
    howSteps: [
      { title: 'Foto hochladen', desc: 'Dein Kind wird zum illustrierten Helden der Geschichte.' },
      { title: 'Geschichte wählen', desc: 'Wähle aus lokalen Geschichten oder 170+ weiteren Themen.' },
      { title: 'Buch erhalten', desc: 'Eine personalisierte illustrierte Geschichte in wenigen Minuten.' },
    ],
    nearbyTitle: 'Städte in der Nähe',
    ctaTitle: 'Erstelle deine Schweizer Geschichte',
    ctaSubtitle: 'Dein Kind als Hauptfigur in einer Geschichte, die genau hier spielt.',
    ctaButton: 'Konto erstellen (gratis)',
    ctaTrialButton: 'Oder zuerst eine Gratis-Probegeschichte erstellen',
    ctaTrialNote: 'Schweizer Geschichten benötigen ein kostenloses Konto. Probegeschichten nutzen andere Themen.',
    createButton: 'Diese Geschichte erstellen',
    createAccountButton: 'Gratis-Konto erstellen',
    createAccountNote: 'Schweizer Geschichten benötigen ein kostenloses Konto',
  },
  fr: {
    breadcrumbRoot: 'Villes suisses',
    intro: {
      scene: 'Votre enfant devient le héros d\'une histoire qui se déroule à {city} — sur les véritables sites de la ville, dans les rues familières, devant les bâtiments qu\'il reconnaît au quotidien.',
      customLabel: 'Vous choisissez le sujet',
      customBody: 'Une aventure fantastique, un cadeau d\'anniversaire, du courage chez le dentiste, l\'amitié dès la rentrée — ou l\'un des 170+ thèmes de notre bibliothèque. Créez un compte gratuit, choisissez votre sujet dans l\'assistant, nous plaçons l\'histoire à {city}.',
      historicalLabel: 'Ou entrez dans l\'histoire de {city}',
      historicalBody: 'Plus bas vous trouvez les histoires historiques de {city} — des anciennes légendes aux événements célèbres. Créez un compte gratuit, choisissez-en une comme point de départ, votre enfant y tient un rôle.',
    },
    ideasTitle: 'Histoires historiques de {city}',
    ideasSubtitle: 'Histoires réelles tirées du passé de {city} — choisissez-en une et votre enfant y joue un rôle',
    contextLabel: 'Contexte historique',
    sagenTitle: 'Légendes locales',
    howTitle: 'Comment ça marche',
    howSteps: [
      { title: 'Télécharger une photo', desc: 'Votre enfant devient le héros illustré de l\'histoire.' },
      { title: 'Choisir une histoire', desc: 'Choisissez parmi les histoires locales ou 170+ autres thèmes.' },
      { title: 'Recevoir votre livre', desc: 'Une histoire personnalisée illustrée prête en quelques minutes.' },
    ],
    nearbyTitle: 'Villes proches',
    ctaTitle: 'Créez votre histoire suisse',
    ctaSubtitle: 'Votre enfant comme personnage principal dans une histoire qui se déroule ici.',
    ctaButton: 'Créer un compte (gratuit)',
    ctaTrialButton: 'Ou essayez d\'abord une histoire gratuite',
    ctaTrialNote: 'Les histoires suisses nécessitent un compte gratuit. Les histoires d\'essai utilisent d\'autres thèmes.',
    createButton: 'Créer cette histoire',
    createAccountButton: 'Créer un compte gratuit',
    createAccountNote: 'Les histoires suisses nécessitent un compte gratuit',
  },
  it: {
    breadcrumbRoot: 'Città svizzere',
    intro: {
      scene: 'Tuo figlio diventa il protagonista di una storia ambientata proprio qui a {city} — nei monumenti reali della città, nelle strade familiari, davanti agli edifici che riconosce dalla vita quotidiana.',
      customLabel: 'Scegli tu l\'argomento',
      customBody: 'Un\'avventura fantastica, un regalo di compleanno, coraggio dal dentista, amicizia il primo giorno di scuola — o uno degli oltre 170 temi della nostra biblioteca. Crea un account gratuito, scegli il tuo argomento nella procedura guidata, ambientiamo la storia a {city}.',
      historicalLabel: 'Oppure entra nella storia di {city}',
      historicalBody: 'Più sotto trovi le storie storiche di {city} — da antiche leggende a eventi famosi. Crea un account gratuito, scegline una come punto di partenza, tuo figlio interpreta un ruolo all\'interno.',
    },
    ideasTitle: 'Storie storiche di {city}',
    ideasSubtitle: 'Storie vere dal passato di {city} — scegline una e tuo figlio interpreta un ruolo',
    contextLabel: 'Contesto storico',
    sagenTitle: 'Leggende locali',
    howTitle: 'Come funziona',
    howSteps: [
      { title: 'Carica una foto', desc: 'Tuo figlio diventa il protagonista illustrato della storia.' },
      { title: 'Scegli un\'idea per la storia', desc: 'Scegli tra storie locali o oltre 170 altri temi.' },
      { title: 'Ricevi il tuo libro', desc: 'Una storia personalizzata illustrata pronta in pochi minuti.' },
    ],
    nearbyTitle: 'Città vicine',
    ctaTitle: 'Crea la tua storia svizzera',
    ctaSubtitle: 'Tuo figlio come protagonista di una storia ambientata proprio qui.',
    ctaButton: 'Crea account (gratuito)',
    ctaTrialButton: 'O prova prima una storia gratuita',
    ctaTrialNote: 'Le storie svizzere richiedono un account gratuito. Le storie di prova usano altri temi.',
    createButton: 'Crea questa storia',
    createAccountButton: 'Crea account gratuito',
    createAccountNote: 'Le storie svizzere richiedono un account gratuito',
  },
};

/** Haversine distance in km */
function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export default function CityPage() {
  const { cityId } = useParams<{ cityId: string }>();
  const { language } = useLanguage();
  const t = pageTexts[language] || pageTexts.de;
  const { data } = useSwissStories();
  const [openContext, setOpenContext] = useState<string | null>(null);

  // Reset scroll + collapse any expanded context box whenever the user
  // navigates from one city page to another (e.g. via a 'nearby city' link
  // at the bottom). React Router reuses the CityPage instance because both
  // routes match /stadt/:cityId, so the global ScrollToTop and useState
  // both miss this transition — the user lands already-scrolled past the
  // historical stories section, thinking it's missing. This effect makes
  // the cityId change feel like a fresh page load.
  useEffect(() => {
    window.scrollTo(0, 0);
    setOpenContext(null);
  }, [cityId]);

  const city = useMemo(() => {
    if (!data || !cityId) return null;
    return data.cities.find(c => c.id === cityId) || null;
  }, [data, cityId]);

  // (cantonName useMemo removed — no longer displayed in the hero. The
  // h1 now shows only the city name, with the canton appended via
  // city.canton only when another Swiss city shares the same name —
  // see hasNameClash in the hero render block.)

  // Related Sagen for this city
  const relatedSagen = useMemo(() => {
    if (!data || !cityId) return [];
    const sageIds = SAGE_CITY_MAP[cityId] || [];
    return data.sagen.filter(s => sageIds.includes(s.id));
  }, [data, cityId]);

  // Nearby cities (4-6 nearest)
  const nearbyCities = useMemo(() => {
    if (!data || !city) return [];
    return data.cities
      .filter(c => c.id !== city.id)
      .map(c => ({ ...c, dist: haversineKm(city.lat, city.lon, c.lat, c.lon) }))
      .sort((a, b) => a.dist - b.dist)
      .slice(0, 6);
  }, [data, city]);

  if (data && !city) {
    return <Navigate to="/stadt" replace />;
  }

  const loc = (s: LocalizedString) => s[language as keyof LocalizedString] || s.de;

  return (
    <div className="min-h-screen bg-stone-50 flex flex-col">
      <Navigation currentStep={0} />

      {/* Breadcrumb */}
      <div className="bg-white border-b border-stone-100">
        <div className="max-w-5xl mx-auto px-4 pt-4 pb-0">
          <nav className="flex items-center gap-1.5 text-sm text-stone-500">
            <Link to="/stadt" className="hover:text-indigo-500 transition-colors">{t.breadcrumbRoot}</Link>
            <ChevronRight size={14} className="text-stone-300" />
            <span className="text-stone-800 font-medium">{city ? loc(city.name) : '...'}</span>
          </nav>
        </div>
      </div>

      {/* ── Hero: two illustrations on top, city name as h1, intro body,
              primary CTAs. Replaces the older separate hero + intro card
              (which duplicated the city name and showed an AG canton chip
              that the user found noisy). One unified block. ─────────── */}
      <div className="bg-white border-b border-stone-100">
        <div className="max-w-5xl mx-auto px-4 pt-6 pb-10">
          {city && (() => {
            const cityName = loc(city.name);
            const fill = (s: string) => s.replace(/\{city\}/g, cityName);
            const gallery = CITY_GALLERIES[city.id] || [];
            const topImages = gallery.slice(0, 2);
            // Disambiguator: only show the canton next to the h1 when another
            // Swiss city shares this exact name in any language (e.g.
            // 'Bremgarten' exists in both AG and BE). For unique names like
            // Baden/Aarau, the canton is redundant and the user finds it
            // noisy.
            const hasNameClash = data
              ? data.cities.filter(c => loc(c.name).toLowerCase() === cityName.toLowerCase()).length > 1
              : false;
            return (
              <>
                {topImages.length > 0 && (
                  <div className="grid grid-cols-2 gap-4 md:gap-6 mb-6">
                    {topImages.map((g) => (
                      <img
                        key={g.src}
                        src={g.src}
                        alt={`${cityName} — ${g.landmark}`}
                        loading="eager"
                        className="w-full aspect-square object-cover rounded-2xl"
                      />
                    ))}
                  </div>
                )}
                <div className="text-center">
                  <h1 className="font-title text-3xl md:text-4xl font-bold text-stone-900 mb-4">
                    {cityName}
                    {hasNameClash && (
                      <span className="ml-2 text-stone-400 text-2xl md:text-3xl font-normal align-middle">
                        {city.canton}
                      </span>
                    )}
                  </h1>
                  {/* Scene-setting line — sits below the h1, above the two
                      option blocks. Reads as a continuation of the title. */}
                  <p className="text-stone-600 text-base md:text-lg max-w-2xl mx-auto leading-relaxed mb-6">
                    {fill(t.intro.scene)}
                  </p>
                </div>

                {/* Two-path option blocks. Path A (custom topic) leads to
                    /create via the existing CTA below. Path B (historical)
                    lives in the Story Ideas section further down — a small
                    in-page anchor would be nice eventually, but for now the
                    section header and gallery imagery make it discoverable. */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 md:gap-5 mb-8">
                  <section className="bg-indigo-50 border border-indigo-100 rounded-2xl p-5 md:p-6 text-left">
                    <h2 className="font-title text-lg md:text-xl font-bold text-stone-900 mb-2">
                      {fill(t.intro.customLabel)}
                    </h2>
                    <p className="text-stone-600 text-sm md:text-base leading-relaxed">
                      {fill(t.intro.customBody)}
                    </p>
                  </section>
                  <section className="bg-stone-100 border border-stone-200 rounded-2xl p-5 md:p-6 text-left">
                    <h2 className="font-title text-lg md:text-xl font-bold text-stone-900 mb-2">
                      {fill(t.intro.historicalLabel)}
                    </h2>
                    <p className="text-stone-600 text-sm md:text-base leading-relaxed">
                      {fill(t.intro.historicalBody)}
                    </p>
                  </section>
                </div>

                {/* Universal CTAs — apply to both paths (the wizard lets the
                    user pick their topic, and our Swiss-story prompt drops
                    the city in automatically when started from /stadt/...). */}
                <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
                  <Link
                    to="/create"
                    className="inline-flex items-center gap-2 px-8 py-3.5 rounded-lg bg-indigo-500 text-white font-semibold hover:bg-indigo-600 transition-colors text-lg"
                  >
                    {t.ctaButton} <ArrowRight size={20} />
                  </Link>
                  <Link
                    to="/try"
                    className="inline-flex items-center gap-2 px-6 py-3 rounded-lg border-2 border-indigo-200 text-indigo-500 font-medium hover:bg-indigo-50 transition-colors text-sm"
                  >
                    {t.ctaTrialButton}
                  </Link>
                </div>
              </>
            );
          })()}
        </div>
      </div>

      <div className="flex-1 max-w-5xl mx-auto px-4 py-10 w-full">

        {/* Story Ideas */}
        {city && city.ideas.length > 0 && (
          <div className="mb-12">
            <div className="text-center mb-6">
              <div className="flex items-center justify-center gap-2 mb-2">
                <BookOpen size={20} className="text-indigo-500" />
                <h2 className="font-title text-xl font-bold text-stone-900">{t.ideasTitle.replace('{city}', loc(city.name))}</h2>
              </div>
              <p className="text-sm text-stone-500">{t.ideasSubtitle.replace(/\{city\}/g, loc(city.name))}</p>
            </div>
            <div className="space-y-4">
              {city.ideas.map(idea => {
                const isOpen = openContext === idea.id;
                return (
                  <div key={idea.id} className="bg-white rounded-2xl shadow-sm border border-stone-100 overflow-hidden">
                    <div className="p-5 md:p-6">
                      <h3 className="font-title text-lg font-bold text-stone-900 mb-2">{loc(idea.title)}</h3>
                      <p className="text-stone-600 text-sm leading-relaxed mb-3">{loc(idea.description)}</p>
                      <div className="flex items-center gap-3 flex-wrap">
                        <button
                          onClick={() => setOpenContext(isOpen ? null : idea.id)}
                          className="text-xs font-medium text-indigo-500 hover:text-indigo-700 transition-colors flex items-center gap-1"
                        >
                          {t.contextLabel}
                          <ChevronDown size={14} className={`transition-transform ${isOpen ? 'rotate-180' : ''}`} />
                        </button>
                        <Link
                          to="/create"
                          className="ml-auto inline-flex items-center gap-1.5 text-sm font-medium text-indigo-500 hover:text-indigo-700 transition-colors"
                          title={t.createAccountNote}
                        >
                          {t.createButton} <ArrowRight size={14} />
                        </Link>
                      </div>
                    </div>
                    {/* Always rendered (so it's in the DOM for SEO crawlers); CSS hides when collapsed */}
                    <div className={`px-5 pb-5 md:px-6 md:pb-6 pt-0 ${isOpen ? '' : 'hidden'}`}>
                      <div className="bg-amber-50 border border-amber-200 rounded-xl p-4">
                        <p className="text-amber-900 text-sm leading-relaxed">{loc(idea.context)}</p>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Related Sagen */}
        {relatedSagen.length > 0 && (
          <div className="mb-12">
            <div className="flex items-center justify-center gap-2 mb-5">
              <Sparkles size={20} className="text-indigo-500" />
              <h2 className="font-title text-xl font-bold text-stone-900">{t.sagenTitle}</h2>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {relatedSagen.map(sage => (
                <div key={sage.id} className="bg-white rounded-2xl shadow-sm border border-stone-100 p-5">
                  <span className="text-4xl block mb-3">{sage.emoji}</span>
                  <h3 className="font-title text-lg font-bold text-stone-900 mb-2">{loc(sage.title)}</h3>
                  <p className="text-stone-600 text-sm leading-relaxed mb-2">{loc(sage.description)}</p>
                  <p className="text-xs text-stone-400">{loc(sage.context)}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* How It Works */}
        <div className="mb-12">
          <h2 className="font-title text-xl font-bold text-stone-900 mb-5 text-center">{t.howTitle}</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {t.howSteps.map((step, i) => (
              <div key={i} className="bg-white rounded-2xl shadow-sm border border-stone-100 p-5 text-center">
                <div className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-indigo-50 text-indigo-500 font-bold text-lg mb-3">
                  {i + 1}
                </div>
                <h3 className="font-title font-bold text-stone-900 mb-1">{step.title}</h3>
                <p className="text-sm text-stone-500">{step.desc}</p>
              </div>
            ))}
          </div>
        </div>

        {/* Nearby Cities */}
        {nearbyCities.length > 0 && (
          <div className="mb-12">
            <h2 className="font-title text-xl font-bold text-stone-900 mb-5 text-center">{t.nearbyTitle}</h2>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {nearbyCities.map(nc => (
                <Link
                  key={nc.id}
                  to={`/stadt/${nc.id}`}
                  className="bg-white rounded-2xl shadow-sm border border-stone-100 p-4 text-center hover:shadow-md hover:border-indigo-200 transition-all group"
                >
                  <span className="font-medium text-stone-800 group-hover:text-indigo-500 transition-colors">
                    {loc(nc.name)}
                  </span>
                  <span className="block text-xs text-stone-400 mt-1">{Math.round(nc.dist)} km</span>
                </Link>
              ))}
            </div>
          </div>
        )}

        {/* Lower image pair — the remaining two illustrations from the
            gallery. Sits just above the conversion CTA to give a final
            visual reminder of what a city story looks like. */}
        {city && (() => {
          const cityName = loc(city.name);
          const gallery = CITY_GALLERIES[city.id] || [];
          const bottomImages = gallery.slice(2, 4);
          if (bottomImages.length === 0) return null;
          return (
            <div className="grid grid-cols-2 gap-4 md:gap-6 mb-10">
              {bottomImages.map((g) => (
                <img
                  key={g.src}
                  src={g.src}
                  alt={`${cityName} — ${g.landmark}`}
                  loading="lazy"
                  className="w-full aspect-square object-cover rounded-2xl shadow-sm border border-stone-100"
                />
              ))}
            </div>
          );
        })()}

        {/* CTA */}
        <div className="bg-indigo-500 rounded-2xl p-8 md:p-12 text-center text-white">
          <h2 className="font-title text-2xl md:text-3xl font-bold mb-3">{t.ctaTitle}</h2>
          <p className="text-indigo-100 mb-6 max-w-lg mx-auto">{t.ctaSubtitle}</p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
            <Link
              to="/create"
              className="inline-flex items-center gap-2 px-8 py-3 rounded-lg bg-white text-indigo-500 font-semibold hover:bg-indigo-50 transition-colors"
            >
              {t.ctaButton} <ArrowRight size={18} />
            </Link>
            <Link
              to="/try"
              className="inline-flex items-center gap-2 px-6 py-2.5 rounded-lg border-2 border-indigo-300 text-white font-medium hover:bg-indigo-600 transition-colors text-sm"
            >
              {t.ctaTrialButton}
            </Link>
          </div>
          <p className="text-indigo-200 text-xs mt-4">{t.ctaTrialNote}</p>
        </div>
      </div>

      <Footer />
    </div>
  );
}
