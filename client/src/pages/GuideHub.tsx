import { Link } from 'react-router-dom';
import { BookOpen, ArrowRight, Clock } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import { Navigation, Footer } from '@/components/common';
import { guides, guidesByCategory, type GuideCategory } from '@/constants/guideData';

const texts = {
  en: {
    title: 'Guides',
    subtitle: 'How to make a children\'s book worth reading twice — and how to choose between the services that make them.',
    sections: { helping: 'Helping through hard times', creating: 'Creating a book', choosing: 'Choosing a service' } as Record<GuideCategory, string>,
    minutes: 'min read',
    ctaTitle: 'Create your first story free',
    ctaDesc: 'Upload a photo, describe the story you want, and see the result before paying anything.',
    ctaButton: 'Start creating',
  },
  de: {
    title: 'Ratgeber',
    subtitle: 'Ein Kind durch eine schwierige Zeit begleiten, ein Buch machen, das zweimal vorgelesen wird — und zwischen den Anbietern wählen.',
    sections: { helping: 'Mutmacher — durch schwierige Zeiten', creating: 'Buch erstellen', choosing: 'Anbieter wählen' } as Record<GuideCategory, string>,
    minutes: 'Min. Lesezeit',
    ctaTitle: 'Erste Geschichte gratis erstellen',
    ctaDesc: 'Foto hochladen, gewünschte Geschichte beschreiben und das Ergebnis ansehen, bevor du etwas bezahlst.',
    ctaButton: 'Jetzt starten',
  },
  fr: {
    title: 'Guides',
    subtitle: 'Comment créer un livre qu\'on relit — et comment choisir entre les services qui les fabriquent.',
    sections: { helping: 'Accompagner les moments difficiles', creating: 'Créer un livre', choosing: 'Choisir un service' } as Record<GuideCategory, string>,
    minutes: 'min de lecture',
    ctaTitle: 'Créez votre première histoire gratuitement',
    ctaDesc: 'Téléchargez une photo, décrivez l\'histoire souhaitée et voyez le résultat avant de payer.',
    ctaButton: 'Commencer',
  },
};

const categoryOrder: GuideCategory[] = ['helping', 'creating', 'choosing'];

export default function GuideHub() {
  const { language } = useLanguage();
  const lang = (language in texts ? language : 'de') as keyof typeof texts;
  const t = texts[lang];
  const suffix = lang !== 'de' ? `?lang=${lang}` : '';

  return (
    <div className="min-h-screen bg-white">
      <Navigation currentStep={0} />

      <section className="pt-24 pb-10 px-4 bg-gradient-to-b from-indigo-50 to-white">
        <div className="max-w-3xl mx-auto text-center">
          <h1 className="text-4xl md:text-5xl font-bold text-gray-900 mb-4">{t.title}</h1>
          <p className="text-lg text-gray-600 leading-relaxed">{t.subtitle}</p>
        </div>
      </section>

      <section className="py-10 px-4">
        <div className="max-w-3xl mx-auto space-y-10">
          {categoryOrder.map((cat) => {
            const items = guidesByCategory(cat);
            if (items.length === 0) return null;
            return (
              <div key={cat}>
                <h2 className="text-2xl font-bold text-gray-900 mb-4">{t.sections[cat]}</h2>
                <div className="space-y-4">
                  {items.map((g) => (
                    <Link
                      key={g.id}
                      to={`/ratgeber/${g.id}${suffix}`}
                      className="block bg-stone-50 border border-stone-200 rounded-2xl p-6 hover:border-indigo-300 transition-colors"
                    >
                      <div className="flex items-start gap-4">
                        <div className="shrink-0 w-11 h-11 rounded-xl bg-white shadow-sm flex items-center justify-center text-indigo-600">
                          <BookOpen size={22} />
                        </div>
                        <div>
                          <h3 className="text-lg font-bold text-gray-900 mb-1">{g.title[lang]}</h3>
                          <p className="text-gray-600 mb-2">{g.description[lang]}</p>
                          <span className="inline-flex items-center gap-1.5 text-sm text-stone-500">
                            <Clock size={14} />
                            {g.readingMinutes} {t.minutes}
                          </span>
                        </div>
                      </div>
                    </Link>
                  ))}
                </div>
              </div>
            );
          })}
          {guides.length === 0 && null}
        </div>
      </section>

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
