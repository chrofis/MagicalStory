import { Link, useParams, Navigate } from 'react-router-dom';
import { ArrowRight, ArrowLeft, Clock } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import { Navigation, Footer } from '@/components/common';
import { guides } from '@/constants/guideData';

const texts = {
  en: {
    back: 'All guides',
    themeLink: 'A personalized story about exactly this',
    faqTitle: 'Frequently asked',
    relatedTitle: 'Keep reading',
    ctaTitle: 'Try it on your own story',
    ctaDesc: 'Your first story is free — no account, no card. Describe what should happen and see the result.',
    ctaButton: 'Create a story',
    minutes: 'min read',
  },
  de: {
    back: 'Alle Ratgeber',
    themeLink: 'Eine personalisierte Geschichte genau dazu',
    faqTitle: 'Häufige Fragen',
    relatedTitle: 'Weiterlesen',
    ctaTitle: 'Probier es an deiner eigenen Geschichte',
    ctaDesc: 'Die erste Geschichte ist gratis — ohne Konto, ohne Karte. Beschreibe, was passieren soll, und sieh dir das Ergebnis an.',
    ctaButton: 'Geschichte erstellen',
    minutes: 'Min. Lesezeit',
  },
  fr: {
    back: 'Tous les guides',
    themeLink: 'Une histoire personnalisée sur ce thème',
    faqTitle: 'Questions fréquentes',
    relatedTitle: 'À lire ensuite',
    ctaTitle: 'Essayez sur votre propre histoire',
    ctaDesc: 'La première histoire est gratuite — sans compte, sans carte. Décrivez ce qui doit se passer et voyez le résultat.',
    ctaButton: 'Créer une histoire',
    minutes: 'min de lecture',
  },
};

export default function GuidePage() {
  const { guideSlug } = useParams<{ guideSlug: string }>();
  const { language } = useLanguage();
  const lang = (language in texts ? language : 'de') as keyof typeof texts;
  const t = texts[lang];
  const suffix = lang !== 'de' ? `?lang=${lang}` : '';

  const guide = guides.find((g) => g.id === guideSlug);
  if (!guide) return <Navigate to={`/ratgeber${suffix}`} replace />;

  const related = guides.filter((g) => g.id !== guide.id);

  return (
    <div className="min-h-screen bg-white">
      <Navigation currentStep={0} />

      <article>
        <header className="pt-24 pb-8 px-4 bg-gradient-to-b from-indigo-50 to-white">
          <div className="max-w-3xl mx-auto">
            <Link
              to={`/ratgeber${suffix}`}
              className="inline-flex items-center gap-1.5 text-sm text-indigo-500 hover:underline mb-4"
            >
              <ArrowLeft size={14} />
              {t.back}
            </Link>
            <h1 className="text-3xl md:text-4xl font-bold text-gray-900 mb-4">{guide.title[lang]}</h1>
            <p className="text-lg text-gray-600 leading-relaxed mb-3">{guide.intro[lang]}</p>
            <span className="inline-flex items-center gap-1.5 text-sm text-stone-500">
              <Clock size={14} />
              {guide.readingMinutes} {t.minutes}
            </span>
          </div>
        </header>

        <div className="py-10 px-4">
          <div className="max-w-3xl mx-auto space-y-10">
            {guide.sections.map((s, i) => (
              <section key={i}>
                <h2 className="text-2xl font-bold text-gray-900 mb-3">{s.heading[lang]}</h2>
                <div className="space-y-4">
                  {s.body[lang].map((p, j) => (
                    <p key={j} className="text-gray-700 leading-relaxed">{p}</p>
                  ))}
                </div>
              </section>
            ))}
          </div>
        </div>

        {guide.faq.length > 0 && (
          <section className="py-10 px-4 bg-stone-50 border-y border-stone-100">
            <div className="max-w-3xl mx-auto">
              <h2 className="text-2xl font-bold text-gray-900 mb-6">{t.faqTitle}</h2>
              <div className="space-y-6">
                {guide.faq.map((f, i) => (
                  <div key={i}>
                    <h3 className="text-lg font-bold text-gray-900 mb-2">{f.q[lang]}</h3>
                    <p className="text-gray-700 leading-relaxed">{f.a[lang]}</p>
                  </div>
                ))}
              </div>
            </div>
          </section>
        )}
      </article>

      {related.length > 0 && (
        <section className="py-10 px-4">
          <div className="max-w-3xl mx-auto">
            <h2 className="text-xl font-bold text-gray-900 mb-4">{t.relatedTitle}</h2>
            <div className="space-y-3">
              {related.map((g) => (
                <Link
                  key={g.id}
                  to={`/ratgeber/${g.id}${suffix}`}
                  className="block bg-stone-50 border border-stone-200 rounded-xl p-4 hover:border-indigo-300 transition-colors"
                >
                  <span className="font-semibold text-gray-900">{g.title[lang]}</span>
                </Link>
              ))}
              {guide.relatedTheme && (
                <Link
                  to={`/themes/life-challenges/${guide.relatedTheme}${suffix}`}
                  className="block bg-stone-50 border border-stone-200 rounded-xl p-4 hover:border-indigo-300 transition-colors"
                >
                  <span className="font-semibold text-gray-900">{t.themeLink}</span>
                </Link>
              )}
              <Link
                to={`/kinderbuch-erstellen${suffix}`}
                className="block bg-stone-50 border border-stone-200 rounded-xl p-4 hover:border-indigo-300 transition-colors"
              >
                <span className="font-semibold text-gray-900">
                  {lang === 'de'
                    ? 'Kinderbuch erstellen mit KI'
                    : lang === 'fr'
                      ? 'Créer un livre pour enfant avec l\'IA'
                      : 'Create a children\'s book with AI'}
                </span>
              </Link>
            </div>
          </div>
        </section>
      )}

      <section className="py-16 px-4 bg-gradient-to-b from-white to-indigo-50">
        <div className="max-w-2xl mx-auto text-center">
          <h2 className="text-3xl font-bold text-gray-900 mb-4">{t.ctaTitle}</h2>
          <p className="text-lg text-gray-600 mb-8">{t.ctaDesc}</p>
          <Link
            to={`/try${suffix}`}
            className="inline-flex items-center gap-2 bg-indigo-500 text-white px-8 py-4 rounded-xl text-lg font-semibold hover:bg-indigo-600 transition-colors shadow-lg shadow-indigo-200"
          >
            {t.ctaButton}
            <ArrowRight size={20} />
          </Link>
        </div>
      </section>

      <Footer />
    </div>
  );
}
