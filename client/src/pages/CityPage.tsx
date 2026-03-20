import { useState, useEffect, useMemo } from 'react';
import { Link, useParams, Navigate } from 'react-router-dom';
import { useLanguage } from '@/context/LanguageContext';
import { Navigation, Footer } from '@/components/common';
import { ArrowRight, ChevronRight, ChevronDown, MapPin, BookOpen, Sparkles } from 'lucide-react';

interface LocalizedString { en: string; de: string; fr: string }

interface StoryIdea {
  id: string;
  title: LocalizedString;
  description: LocalizedString;
  context: LocalizedString;
}

interface City {
  id: string;
  name: LocalizedString;
  canton: string;
  lat: number;
  lon: number;
  ideas: StoryIdea[];
}

interface Sage {
  id: string;
  title: LocalizedString;
  description: LocalizedString;
  context: LocalizedString;
  emoji: string;
  age: string;
}

interface ApiResponse {
  cantons: Record<string, LocalizedString>;
  cities: City[];
  sagen: Sage[];
}

// Map sage IDs to city IDs where they're most relevant
const SAGE_CITY_MAP: Record<string, string[]> = {
  andermatt: ['sage-devils-bridge'],
  luzern: ['sage-dragons-pilatus'],
  stgallen: ['sage-st-gall-bear'],
  basel: ['sage-vogel-gryff'],
  chur: ['sage-heidi'],
  maienfeld: ['sage-heidi'],
  zermatt: ['sage-gargantua-matterhorn'],
};

const pageTexts: Record<string, {
  breadcrumbRoot: string;
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
    ideasTitle: 'Story Ideas',
    ideasSubtitle: 'Each story is rooted in real local history and landmarks',
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
    ideasTitle: 'Geschichten-Ideen',
    ideasSubtitle: 'Jede Geschichte basiert auf echter lokaler Geschichte und Sehenswürdigkeiten',
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
    ideasTitle: 'Idées d\'histoires',
    ideasSubtitle: 'Chaque histoire est ancrée dans l\'histoire et les monuments locaux',
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
  const [data, setData] = useState<ApiResponse | null>(null);
  const [openContext, setOpenContext] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/swiss-stories')
      .then(r => r.json())
      .then(setData)
      .catch(() => {});
  }, []);

  const city = useMemo(() => {
    if (!data || !cityId) return null;
    return data.cities.find(c => c.id === cityId) || null;
  }, [data, cityId]);

  const cantonName = useMemo(() => {
    if (!data || !city) return '';
    const cn = data.cantons[city.canton];
    return cn?.[language as keyof typeof cn] || cn?.de || city.canton;
  }, [data, city, language]);

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
        <div className="max-w-4xl mx-auto px-4 pt-4 pb-0">
          <nav className="flex items-center gap-1.5 text-sm text-stone-500">
            <Link to="/stadt" className="hover:text-indigo-600 transition-colors">{t.breadcrumbRoot}</Link>
            <ChevronRight size={14} className="text-stone-300" />
            <span className="text-stone-800 font-medium">{city ? loc(city.name) : '...'}</span>
          </nav>
        </div>
      </div>

      {/* Hero */}
      <div className="bg-white border-b border-stone-100">
        <div className="max-w-3xl mx-auto px-4 pt-10 pb-10 text-center">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-indigo-50 mb-5">
            <MapPin className="w-8 h-8 text-indigo-600" />
          </div>
          <h1 className="font-title text-3xl md:text-4xl font-bold text-stone-900 mb-2">
            {city ? loc(city.name) : '...'}
          </h1>
          {cantonName && (
            <p className="text-stone-400 text-sm mb-5">
              <span className="inline-flex items-center gap-1.5">
                <span className="bg-stone-100 text-stone-600 text-xs font-bold px-2 py-0.5 rounded-full">{city?.canton}</span>
                {cantonName}
              </span>
            </p>
          )}
          <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
            <Link
              to="/create"
              className="inline-flex items-center gap-2 px-8 py-3.5 rounded-lg bg-indigo-600 text-white font-semibold hover:bg-indigo-700 transition-colors text-lg"
            >
              {t.ctaButton} <ArrowRight size={20} />
            </Link>
            <Link
              to="/try"
              className="inline-flex items-center gap-2 px-6 py-3 rounded-lg border-2 border-indigo-200 text-indigo-600 font-medium hover:bg-indigo-50 transition-colors text-sm"
            >
              {t.ctaTrialButton}
            </Link>
          </div>
        </div>
      </div>

      <div className="flex-1 max-w-4xl mx-auto px-4 py-10 w-full">
        {/* Story Ideas */}
        {city && city.ideas.length > 0 && (
          <div className="mb-12">
            <div className="text-center mb-6">
              <div className="flex items-center justify-center gap-2 mb-2">
                <BookOpen size={20} className="text-indigo-600" />
                <h2 className="font-title text-xl font-bold text-stone-900">{t.ideasTitle}</h2>
              </div>
              <p className="text-sm text-stone-500">{t.ideasSubtitle}</p>
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
                          className="text-xs font-medium text-indigo-600 hover:text-indigo-700 transition-colors flex items-center gap-1"
                        >
                          {t.contextLabel}
                          <ChevronDown size={14} className={`transition-transform ${isOpen ? 'rotate-180' : ''}`} />
                        </button>
                        <Link
                          to="/create"
                          className="ml-auto inline-flex items-center gap-1.5 text-sm font-medium text-indigo-600 hover:text-indigo-700 transition-colors"
                          title={t.createAccountNote}
                        >
                          {t.createButton} <ArrowRight size={14} />
                        </Link>
                      </div>
                    </div>
                    {isOpen && (
                      <div className="px-5 pb-5 md:px-6 md:pb-6 pt-0">
                        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4">
                          <p className="text-amber-900 text-sm leading-relaxed">{loc(idea.context)}</p>
                        </div>
                      </div>
                    )}
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
              <Sparkles size={20} className="text-indigo-600" />
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
                <div className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-indigo-50 text-indigo-600 font-bold text-lg mb-3">
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
                  <span className="font-medium text-stone-800 group-hover:text-indigo-600 transition-colors">
                    {loc(nc.name)}
                  </span>
                  <span className="block text-xs text-stone-400 mt-1">{Math.round(nc.dist)} km</span>
                </Link>
              ))}
            </div>
          </div>
        )}

        {/* CTA */}
        <div className="bg-indigo-600 rounded-2xl p-8 md:p-12 text-center text-white">
          <h2 className="font-title text-2xl md:text-3xl font-bold mb-3">{t.ctaTitle}</h2>
          <p className="text-indigo-100 mb-6 max-w-lg mx-auto">{t.ctaSubtitle}</p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
            <Link
              to="/create"
              className="inline-flex items-center gap-2 px-8 py-3 rounded-lg bg-white text-indigo-600 font-semibold hover:bg-indigo-50 transition-colors"
            >
              {t.ctaButton} <ArrowRight size={18} />
            </Link>
            <Link
              to="/try"
              className="inline-flex items-center gap-2 px-6 py-2.5 rounded-lg border-2 border-indigo-300 text-white font-medium hover:bg-indigo-500 transition-colors text-sm"
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
