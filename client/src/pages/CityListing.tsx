import { useState, useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useLanguage } from '@/context/LanguageContext';
import { Navigation, Footer } from '@/components/common';
import { MapPin, ArrowRight, ChevronDown } from 'lucide-react';

interface City {
  id: string;
  name: { en: string; de: string; fr: string };
  canton: string;
  ideas: { id: string }[];
}

interface ApiResponse {
  cantons: Record<string, { en: string; de: string; fr: string }>;
  cities: City[];
}

const texts: Record<string, {
  title: string;
  subtitle: string;
  ctaTitle: string;
  ctaSubtitle: string;
  ctaButton: string;
  stories: string;
  story: string;
}> = {
  en: {
    title: 'Children\'s Stories from Switzerland',
    subtitle: 'Discover personalized stories rooted in real Swiss history and local legends. Pick your city and let your child become the hero of their own Swiss adventure.',
    ctaTitle: 'Create Your Free Story',
    ctaSubtitle: 'Choose a city, pick a story idea, and create a personalized illustrated book in minutes. Your first story is free.',
    ctaButton: 'Start Creating',
    stories: 'stories',
    story: 'story',
  },
  de: {
    title: 'Kindergeschichten aus der Schweiz',
    subtitle: 'Entdecke personalisierte Geschichten, die auf echter Schweizer Geschichte und lokalen Sagen basieren. Wähle deine Stadt und lass dein Kind zum Helden seines eigenen Schweizer Abenteuers werden.',
    ctaTitle: 'Erstelle deine Gratis-Geschichte',
    ctaSubtitle: 'Wähle eine Stadt, eine Geschichtenidee und erstelle in wenigen Minuten ein personalisiertes illustriertes Buch. Deine erste Geschichte ist kostenlos.',
    ctaButton: 'Jetzt starten',
    stories: 'Geschichten',
    story: 'Geschichte',
  },
  fr: {
    title: 'Histoires pour enfants de Suisse',
    subtitle: 'Découvrez des histoires personnalisées enracinées dans l\'histoire suisse et les légendes locales. Choisissez votre ville et laissez votre enfant devenir le héros de sa propre aventure suisse.',
    ctaTitle: 'Créez votre histoire gratuite',
    ctaSubtitle: 'Choisissez une ville, une idée d\'histoire et créez un livre illustré personnalisé en quelques minutes. Votre première histoire est gratuite.',
    ctaButton: 'Commencer',
    stories: 'histoires',
    story: 'histoire',
  },
};

export default function CityListing() {
  const { language } = useLanguage();
  const t = texts[language] || texts.de;
  const [data, setData] = useState<ApiResponse | null>(null);
  const [openCantons, setOpenCantons] = useState<Set<string>>(new Set());

  useEffect(() => {
    fetch('/api/swiss-stories')
      .then(r => r.json())
      .then(setData)
      .catch(() => {});
  }, []);

  // Group cities by canton, sorted by canton name
  const cantonGroups = useMemo(() => {
    if (!data) return [];
    const groups: Record<string, { cantonName: string; cities: City[] }> = {};
    for (const city of data.cities) {
      if (!groups[city.canton]) {
        const cantonNames = data.cantons[city.canton];
        groups[city.canton] = {
          cantonName: cantonNames?.[language as keyof typeof cantonNames] || cantonNames?.de || city.canton,
          cities: [],
        };
      }
      groups[city.canton].cities.push(city);
    }
    // Sort cantons alphabetically by name
    return Object.entries(groups)
      .sort(([, a], [, b]) => a.cantonName.localeCompare(b.cantonName))
      .map(([code, group]) => ({ code, ...group }));
  }, [data, language]);

  const toggleCanton = (code: string) => {
    setOpenCantons(prev => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  };

  // Start with all cantons open
  useEffect(() => {
    if (cantonGroups.length > 0 && openCantons.size === 0) {
      setOpenCantons(new Set(cantonGroups.map(g => g.code)));
    }
  }, [cantonGroups]);

  return (
    <div className="min-h-screen bg-stone-50 flex flex-col">
      <Navigation currentStep={0} />

      {/* Hero */}
      <div className="bg-white border-b border-stone-100">
        <div className="max-w-4xl mx-auto px-4 pt-10 pb-8 text-center">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-indigo-50 mb-5">
            <MapPin className="w-8 h-8 text-indigo-500" />
          </div>
          <h1 className="font-title text-3xl md:text-4xl font-bold text-stone-900 mb-3">{t.title}</h1>
          <p className="text-stone-500 text-lg max-w-2xl mx-auto">{t.subtitle}</p>
        </div>
      </div>

      <div className="flex-1 max-w-5xl mx-auto px-4 py-10 w-full">
        {!data ? (
          <div className="text-center text-stone-400 py-12">Loading...</div>
        ) : (
          <div className="space-y-4 mb-16">
            {cantonGroups.map(({ code, cantonName, cities }) => {
              const isOpen = openCantons.has(code);
              return (
                <div key={code} className="bg-white rounded-2xl shadow-sm border border-stone-100 overflow-hidden">
                  <button
                    onClick={() => toggleCanton(code)}
                    className="w-full flex items-center justify-between p-5 hover:bg-stone-50 transition-colors"
                  >
                    <div className="flex items-center gap-3">
                      <span className="text-xs font-bold bg-indigo-50 text-indigo-500 px-2.5 py-1 rounded-full">{code}</span>
                      <h2 className="font-title text-lg font-bold text-stone-900">{cantonName}</h2>
                      <span className="text-sm text-stone-400">({cities.length})</span>
                    </div>
                    <ChevronDown
                      size={18}
                      className={`text-stone-400 transition-transform ${isOpen ? 'rotate-180' : ''}`}
                    />
                  </button>
                  {isOpen && (
                    <div className="px-5 pb-5 pt-0">
                      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
                        {cities.map(city => {
                          const cityName = city.name[language as keyof typeof city.name] || city.name.de;
                          const ideaCount = city.ideas?.length || 0;
                          return (
                            <Link
                              key={city.id}
                              to={`/stadt/${city.id}`}
                              className="flex items-center justify-between p-3 rounded-xl border border-stone-100 hover:border-indigo-200 hover:shadow-sm transition-all group"
                            >
                              <div>
                                <span className="font-medium text-stone-800 group-hover:text-indigo-500 transition-colors">
                                  {cityName}
                                </span>
                                {ideaCount > 0 && (
                                  <span className="block text-xs text-stone-400 mt-0.5">
                                    {ideaCount} {ideaCount === 1 ? t.story : t.stories}
                                  </span>
                                )}
                              </div>
                              <ArrowRight size={16} className="text-stone-300 group-hover:text-indigo-400 transition-colors" />
                            </Link>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* CTA */}
        <div className="bg-indigo-500 rounded-2xl p-8 md:p-12 text-center text-white">
          <h2 className="font-title text-2xl md:text-3xl font-bold mb-3">{t.ctaTitle}</h2>
          <p className="text-indigo-100 mb-6 max-w-lg mx-auto">{t.ctaSubtitle}</p>
          <Link
            to="/try"
            className="inline-flex items-center gap-2 px-8 py-3 rounded-lg bg-white text-indigo-500 font-semibold hover:bg-indigo-50 transition-colors"
          >
            {t.ctaButton} <ArrowRight size={18} />
          </Link>
        </div>
      </div>

      <Footer />
    </div>
  );
}
