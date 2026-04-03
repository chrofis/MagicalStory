import { useMemo } from 'react';
import { Link, useParams, Navigate } from 'react-router-dom';
import { useLanguage } from '@/context/LanguageContext';
import { Navigation, Footer } from '@/components/common';
import { ArrowRight, ChevronRight, Upload, Palette, BookOpen, Check } from 'lucide-react';
import {
  storyTypes,
  lifeChallenges,
  educationalTopics,
  historicalEvents,
} from '@/constants/storyTypes';
import { themeContent } from '@/constants/themeContent';
import type { LocalizedString } from '@/types/character';

type CategorySlug = 'adventure' | 'life-challenges' | 'educational' | 'historical';

interface ThemeData {
  id: string;
  name: LocalizedString;
  emoji: string;
  year?: number | string;
  mainPerson?: string;
}

const pageTexts: Record<string, {
  breadcrumbRoot: string;
  createButton: string;
  whatToExpect: string;
  howItWorks: string;
  howStep1Title: string;
  howStep1Desc: string;
  howStep2Title: string;
  howStep2Desc: string;
  howStep3Title: string;
  howStep3Desc: string;
  relatedThemes: string;
  ctaTitle: string;
  ctaSubtitle: string;
  ctaButton: string;
  yearLabel: string;
  personLabel: string;
}> = {
  en: {
    breadcrumbRoot: 'Themes',
    createButton: 'Create This Story',
    whatToExpect: 'What to Expect',
    howItWorks: 'How It Works',
    howStep1Title: 'Upload a Photo',
    howStep1Desc: 'Upload a photo of your child. They become the illustrated hero of the story.',
    howStep2Title: 'Choose This Theme',
    howStep2Desc: 'Select this theme and customize the story settings to your liking.',
    howStep3Title: 'Get Your Story',
    howStep3Desc: 'Your personalized illustrated story is ready in minutes. Read online or order a printed book.',
    relatedThemes: 'Related Themes',
    ctaTitle: 'Make It Personal',
    ctaSubtitle: 'Your child as the main character in their very own story. Try it free.',
    ctaButton: 'Create Your Free Story',
    yearLabel: 'Year',
    personLabel: 'Historical figure',
  },
  de: {
    breadcrumbRoot: 'Themen',
    createButton: 'Diese Geschichte erstellen',
    whatToExpect: 'Was erwartet dich',
    howItWorks: 'So funktioniert es',
    howStep1Title: 'Foto hochladen',
    howStep1Desc: 'Lade ein Foto deines Kindes hoch. Es wird zum illustrierten Helden der Geschichte.',
    howStep2Title: 'Thema wählen',
    howStep2Desc: 'Wähle dieses Thema und passe die Geschichte nach deinen Wünschen an.',
    howStep3Title: 'Geschichte erhalten',
    howStep3Desc: 'Deine personalisierte illustrierte Geschichte ist in Minuten fertig. Online lesen oder als Buch bestellen.',
    relatedThemes: 'Ähnliche Themen',
    ctaTitle: 'Mach es persönlich',
    ctaSubtitle: 'Dein Kind als Hauptfigur in seiner eigenen Geschichte. Jetzt kostenlos testen.',
    ctaButton: 'Gratis-Geschichte erstellen',
    yearLabel: 'Jahr',
    personLabel: 'Historische Persönlichkeit',
  },
  fr: {
    breadcrumbRoot: 'Thèmes',
    createButton: 'Créer cette histoire',
    whatToExpect: 'À quoi s\'attendre',
    howItWorks: 'Comment ça marche',
    howStep1Title: 'Télécharger une photo',
    howStep1Desc: 'Téléchargez une photo de votre enfant. Il devient le héros illustré de l\'histoire.',
    howStep2Title: 'Choisir ce thème',
    howStep2Desc: 'Sélectionnez ce thème et personnalisez les paramètres de l\'histoire.',
    howStep3Title: 'Recevoir votre histoire',
    howStep3Desc: 'Votre histoire personnalisée illustrée est prête en quelques minutes. Lisez en ligne ou commandez un livre imprimé.',
    relatedThemes: 'Thèmes similaires',
    ctaTitle: 'Rendez-le personnel',
    ctaSubtitle: 'Votre enfant comme personnage principal de sa propre histoire. Essayez gratuitement.',
    ctaButton: 'Créer votre histoire gratuite',
    yearLabel: 'Année',
    personLabel: 'Personnage historique',
  },
};

function getCategoryName(category: CategorySlug, language: string): string {
  const names: Record<CategorySlug, Record<string, string>> = {
    adventure: { en: 'Adventure', de: 'Abenteuer', fr: 'Aventure' },
    'life-challenges': { en: 'Life Skills', de: 'Lebenskompetenzen', fr: 'Compétences de vie' },
    educational: { en: 'Learning', de: 'Lernen', fr: 'Apprentissage' },
    historical: { en: 'History', de: 'Geschichte', fr: 'Histoire' },
  };
  return names[category]?.[language] || names[category]?.en || category;
}

function getDescription(themeId: string, language: string = 'en'): string {
  const content = themeContent[themeId];
  if (content?.description) {
    const desc = content.description;
    return (desc as Record<string, string>)[language] || desc.en;
  }
  return '';
}

function getLongDescription(themeId: string, language: string = 'en'): string {
  const content = themeContent[themeId];
  if (content?.longDescription) {
    const desc = content.longDescription;
    return (desc as Record<string, string>)[language] || desc.en;
  }
  return '';
}

function getSkills(themeId: string, language: string = 'en'): string {
  const content = themeContent[themeId];
  if (content?.skills) {
    const skills = content.skills;
    return (skills as Record<string, string>)[language] || skills.en;
  }
  return '';
}

function getAgeRecommendation(themeId: string): string {
  return themeContent[themeId]?.ageRecommendation || '';
}

function getFaq(themeId: string, language: string = 'en'): Array<{ q: string; a: string }> {
  const content = themeContent[themeId];
  if (!content?.faq) return [];
  return content.faq.map(item => ({
    q: (item.q as Record<string, string>)[language] || item.q.en,
    a: (item.a as Record<string, string>)[language] || item.a.en,
  }));
}

function getExpectBullets(category: CategorySlug, language: string): string[] {
  const bullets: Record<CategorySlug, Record<string, string[]>> = {
    adventure: {
      en: ['Your child as the main character', 'Exciting plot with surprises', 'Beautiful illustrations in your chosen style'],
      de: ['Dein Kind als Hauptfigur', 'Spannende Handlung mit Überraschungen', 'Wunderschöne Illustrationen im gewählten Stil'],
      fr: ['Votre enfant comme personnage principal', 'Une intrigue passionnante avec des surprises', 'De belles illustrations dans le style choisi'],
    },
    'life-challenges': {
      en: ['Your child facing the challenge with confidence', 'Positive, empowering message', 'Age-appropriate language and situations'],
      de: ['Dein Kind meistert die Herausforderung mit Selbstvertrauen', 'Positive, stärkende Botschaft', 'Altersgerechte Sprache und Situationen'],
      fr: ['Votre enfant affronte le défi avec confiance', 'Un message positif et encourageant', 'Un langage et des situations adaptés à l\'âge'],
    },
    educational: {
      en: ['Fun learning integrated into the story', 'Your child discovering new concepts', 'Interactive elements on every page'],
      de: ['Spielerisches Lernen in die Geschichte integriert', 'Dein Kind entdeckt neue Konzepte', 'Interaktive Elemente auf jeder Seite'],
      fr: ['Un apprentissage ludique intégré à l\'histoire', 'Votre enfant découvre de nouveaux concepts', 'Des éléments interactifs à chaque page'],
    },
    historical: {
      en: ['Historically accurate setting and details', 'Your child as a witness to history', 'Educational and entertaining'],
      de: ['Historisch akkurate Kulisse und Details', 'Dein Kind als Zeitzeuge', 'Lehrreich und unterhaltsam'],
      fr: ['Un cadre et des détails historiquement précis', 'Votre enfant comme témoin de l\'histoire', 'Éducatif et divertissant'],
    },
  };
  return bullets[category]?.[language] || bullets[category]?.en || [];
}

function findTheme(category: CategorySlug, themeId: string): ThemeData | null {
  switch (category) {
    case 'adventure': {
      const t = storyTypes.find(s => s.id === themeId);
      return t ? { id: t.id, name: t.name, emoji: t.emoji } : null;
    }
    case 'life-challenges': {
      const c = lifeChallenges.find(c => c.id === themeId);
      return c ? { id: c.id, name: c.name, emoji: c.emoji } : null;
    }
    case 'educational': {
      const t = educationalTopics.find(t => t.id === themeId);
      return t ? { id: t.id, name: t.name, emoji: t.emoji } : null;
    }
    case 'historical': {
      const e = historicalEvents.find(e => e.id === themeId);
      return e ? { id: e.id, name: e.name, emoji: e.emoji, year: e.year, mainPerson: e.mainPerson } : null;
    }
    default:
      return null;
  }
}

function getRelatedThemes(category: CategorySlug, currentId: string): ThemeData[] {
  let pool: ThemeData[] = [];
  switch (category) {
    case 'adventure':
      pool = storyTypes.filter(t => t.id !== currentId && t.id !== 'custom').map(t => ({ id: t.id, name: t.name, emoji: t.emoji }));
      break;
    case 'life-challenges':
      pool = lifeChallenges.filter(c => c.id !== currentId).map(c => ({ id: c.id, name: c.name, emoji: c.emoji }));
      break;
    case 'educational':
      pool = educationalTopics.filter(t => t.id !== currentId).map(t => ({ id: t.id, name: t.name, emoji: t.emoji }));
      break;
    case 'historical':
      pool = historicalEvents.filter(e => e.id !== currentId).map(e => ({ id: e.id, name: e.name, emoji: e.emoji, year: e.year }));
      break;
  }
  return pool.slice(0, 6);
}

export default function ThemePage() {
  const { category, themeId } = useParams<{ category: string; themeId: string }>();
  const { language } = useLanguage();
  const t = pageTexts[language] || pageTexts.en;

  const theme = useMemo(() => {
    if (!category || !themeId) return null;
    return findTheme(category as CategorySlug, themeId);
  }, [category, themeId]);

  const relatedThemes = useMemo(() => {
    if (!category || !themeId) return [];
    return getRelatedThemes(category as CategorySlug, themeId);
  }, [category, themeId]);

  if (!theme || !category) {
    return <Navigate to="/themes" replace />;
  }

  const catSlug = category as CategorySlug;
  const themeName = theme.name[language] || theme.name.en;
  const categoryName = getCategoryName(catSlug, language);
  const description = getDescription(themeId!, language);
  const longDescription = getLongDescription(themeId!, language);
  const skills = getSkills(themeId!, language);
  const ageRec = getAgeRecommendation(themeId!);
  const faq = getFaq(themeId!, language);
  const bullets = getExpectBullets(catSlug, language);

  const howSteps = [
    { icon: Upload, title: t.howStep1Title, desc: t.howStep1Desc },
    { icon: Palette, title: t.howStep2Title, desc: t.howStep2Desc },
    { icon: BookOpen, title: t.howStep3Title, desc: t.howStep3Desc },
  ];

  return (
    <div className="min-h-screen bg-stone-50 flex flex-col">
      <Navigation currentStep={0} />

      {/* Breadcrumb */}
      <div className="bg-white border-b border-stone-100">
        <div className="max-w-4xl mx-auto px-4 pt-4 pb-0">
          <nav className="flex items-center gap-1.5 text-sm text-stone-500">
            <Link to="/themes" className="hover:text-indigo-500 transition-colors">{t.breadcrumbRoot}</Link>
            <ChevronRight size={14} className="text-stone-300" />
            <Link to={`/themes/${category}`} className="hover:text-indigo-500 transition-colors">{categoryName}</Link>
            <ChevronRight size={14} className="text-stone-300" />
            <span className="text-stone-800 font-medium">{themeName}</span>
          </nav>
        </div>
      </div>

      {/* Hero Section */}
      <div className="bg-white border-b border-stone-100">
        <div className="max-w-3xl mx-auto px-4 pt-10 pb-10 text-center">
          <span className="text-6xl block mb-5">{theme.emoji}</span>
          <h1 className="font-title text-3xl md:text-4xl font-bold text-stone-900 mb-4">{themeName}</h1>

          {/* Year and person badges for historical */}
          {catSlug === 'historical' && (theme.year || theme.mainPerson) && (
            <div className="flex items-center justify-center gap-3 mb-4 flex-wrap">
              {theme.year && (
                <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-amber-50 text-amber-700 text-sm font-medium border border-amber-200">
                  {t.yearLabel}: {theme.year}
                </span>
              )}
              {theme.mainPerson && (
                <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-indigo-50 text-indigo-700 text-sm font-medium border border-indigo-200">
                  {t.personLabel}: {theme.mainPerson}
                </span>
              )}
            </div>
          )}

          <p className="text-stone-500 text-lg max-w-xl mx-auto mb-6">{description}</p>

          {(() => {
            // Map URL category slugs to internal category IDs for StoryWizard
            const categoryMap: Record<string, string> = { 'life-challenges': 'life-challenge', 'adventure': 'adventure', 'educational': 'educational', 'historical': 'historical' };
            const wizardCategory = categoryMap[catSlug] || catSlug;
            return (
              <Link
                to={`/try?category=${wizardCategory}&topic=${themeId}`}
                className="inline-flex items-center gap-2 px-8 py-3.5 rounded-lg bg-indigo-500 text-white font-semibold hover:bg-indigo-600 transition-colors text-lg"
              >
                {t.createButton} <ArrowRight size={20} />
              </Link>
            );
          })()}
        </div>
      </div>

      <div className="flex-1 max-w-4xl mx-auto px-4 py-10 w-full">
        {/* Long Description + Skills + Age */}
        {(longDescription || skills || ageRec) && (
          <div className="mb-12">
            <div className="bg-white rounded-2xl shadow-sm border border-stone-100 p-6 space-y-4">
              {longDescription && (
                <p className="text-stone-600 leading-relaxed">{longDescription}</p>
              )}
              {(skills || ageRec) && (
                <div className="flex flex-wrap gap-4 pt-2 border-t border-stone-100">
                  {skills && (
                    <div className="flex-1 min-w-[200px]">
                      <h3 className="text-sm font-semibold text-stone-500 mb-1">
                        {language === 'de' ? 'Was dein Kind lernt' : language === 'fr' ? 'Ce que votre enfant apprend' : 'What your child learns'}
                      </h3>
                      <p className="text-sm text-stone-700">{skills}</p>
                    </div>
                  )}
                  {ageRec && (
                    <div>
                      <h3 className="text-sm font-semibold text-stone-500 mb-1">
                        {language === 'de' ? 'Empfohlenes Alter' : language === 'fr' ? 'Âge recommandé' : 'Recommended age'}
                      </h3>
                      <p className="text-sm text-stone-700">{ageRec} {language === 'de' ? 'Jahre' : language === 'fr' ? 'ans' : 'years'}</p>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {/* FAQ */}
        {faq.length > 0 && (
          <div className="mb-12">
            <h2 className="font-title text-xl font-bold text-stone-900 mb-5 text-center">
              {language === 'de' ? 'Häufige Fragen' : language === 'fr' ? 'Questions fréquentes' : 'Frequently Asked Questions'}
            </h2>
            <div className="space-y-3">
              {faq.map((item, i) => (
                <div key={i} className="bg-white rounded-2xl shadow-sm border border-stone-100 p-5">
                  <h3 className="font-semibold text-stone-800 mb-2">{item.q}</h3>
                  <p className="text-sm text-stone-600">{item.a}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* What to Expect */}
        <div className="mb-12">
          <h2 className="font-title text-xl font-bold text-stone-900 mb-5 text-center">{t.whatToExpect}</h2>
          <div className="bg-white rounded-2xl shadow-sm border border-stone-100 p-6">
            <div className="space-y-3">
              {bullets.map((bullet, i) => (
                <div key={i} className="flex items-start gap-3">
                  <div className="flex-shrink-0 w-6 h-6 rounded-full bg-indigo-50 flex items-center justify-center mt-0.5">
                    <Check size={14} className="text-indigo-500" />
                  </div>
                  <span className="text-stone-700">{bullet}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* How It Works */}
        <div className="mb-12">
          <h2 className="font-title text-xl font-bold text-stone-900 mb-5 text-center">{t.howItWorks}</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {howSteps.map((step, i) => {
              const Icon = step.icon;
              return (
                <div key={i} className="bg-white rounded-2xl shadow-sm border border-stone-100 p-6 text-center">
                  <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-indigo-50 mb-4">
                    <Icon size={22} className="text-indigo-500" />
                  </div>
                  <div className="text-xs font-semibold text-indigo-500 mb-2">
                    {i + 1}.
                  </div>
                  <h3 className="font-semibold text-stone-800 mb-1">{step.title}</h3>
                  <p className="text-sm text-stone-500">{step.desc}</p>
                </div>
              );
            })}
          </div>
        </div>

        {/* Related Themes */}
        {relatedThemes.length > 0 && (
          <div className="mb-12">
            <h2 className="font-title text-xl font-bold text-stone-900 mb-5 text-center">{t.relatedThemes}</h2>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {relatedThemes.map((related) => (
                <Link
                  key={related.id}
                  to={`/themes/${category}/${related.id}`}
                  className="bg-white rounded-2xl shadow-sm border border-stone-100 p-4 text-center hover:shadow-md hover:border-indigo-200 transition-all group"
                >
                  <span className="text-2xl block mb-2">{related.emoji}</span>
                  <span className="text-sm font-medium text-stone-700 group-hover:text-indigo-500 transition-colors">
                    {related.name[language] || related.name.en}
                  </span>
                  {catSlug === 'historical' && related.year && (
                    <span className="block text-xs text-stone-400 mt-0.5">{related.year}</span>
                  )}
                </Link>
              ))}
            </div>
          </div>
        )}

        {/* CTA Section */}
        <div className="bg-indigo-500 rounded-2xl p-8 md:p-12 text-center text-white">
          <h2 className="font-title text-2xl md:text-3xl font-bold mb-3">{t.ctaTitle}</h2>
          <p className="text-indigo-100 mb-6 max-w-lg mx-auto">{t.ctaSubtitle}</p>
          {(() => {
            const categoryMap: Record<string, string> = { 'life-challenges': 'life-challenge', 'adventure': 'adventure', 'educational': 'educational', 'historical': 'historical' };
            const wizardCategory = categoryMap[catSlug] || catSlug;
            return (
              <Link
                to={`/try?category=${wizardCategory}&topic=${themeId}`}
                className="inline-flex items-center gap-2 px-8 py-3 rounded-lg bg-white text-indigo-500 font-semibold hover:bg-indigo-50 transition-colors"
              >
                {t.ctaButton} <ArrowRight size={18} />
              </Link>
            );
          })()}
        </div>
      </div>

      <Footer />
    </div>
  );
}
