import { Link } from 'react-router-dom';
import { useLanguage } from '@/context/LanguageContext';
import { Navigation, Footer } from '@/components/common';
import { Gift, ArrowRight } from 'lucide-react';
import { giftPages } from '@/constants/giftData';

type Category = 'recipient' | 'occasion' | 'attribute' | 'age';

const texts: Record<string, {
  title: string;
  subtitle: string;
  ctaTitle: string;
  ctaSubtitle: string;
  ctaButton: string;
  sections: Record<Category, string>;
}> = {
  en: {
    title: 'Gift Ideas for Kids',
    subtitle: 'Find the perfect personalized children\'s book as a gift',
    ctaTitle: 'Create Your Free Story',
    ctaSubtitle: 'Choose any theme and create a personalized story in minutes. Your first story is completely free.',
    ctaButton: 'Start Creating',
    sections: {
      recipient: 'For whom?',
      occasion: 'By occasion',
      attribute: 'Special gifts',
      age: 'By age',
    },
  },
  de: {
    title: 'Geschenkideen für Kinder',
    subtitle: 'Finde das perfekte personalisierte Kinderbuch als Geschenk',
    ctaTitle: 'Erstelle deine Gratis-Geschichte',
    ctaSubtitle: 'Wähle ein Thema und erstelle eine personalisierte Geschichte in wenigen Minuten. Deine erste Geschichte ist komplett kostenlos.',
    ctaButton: 'Jetzt starten',
    sections: {
      recipient: 'Für wen?',
      occasion: 'Zum Anlass',
      attribute: 'Besondere Geschenke',
      age: 'Nach Alter',
    },
  },
  fr: {
    title: 'Idées cadeaux pour enfants',
    subtitle: 'Trouvez le livre personnalisé parfait comme cadeau',
    ctaTitle: 'Créez votre histoire gratuite',
    ctaSubtitle: 'Choisissez un thème et créez une histoire personnalisée en quelques minutes. Votre première histoire est entièrement gratuite.',
    ctaButton: 'Commencer',
    sections: {
      recipient: 'Pour qui?',
      occasion: 'Par occasion',
      attribute: 'Cadeaux spéciaux',
      age: 'Par âge',
    },
  },
};

const categoryOrder: Category[] = ['recipient', 'occasion', 'attribute', 'age'];

export default function GiftHub() {
  const { language } = useLanguage();
  const t = texts[language] || texts.de;

  const grouped = categoryOrder.map(cat => ({
    category: cat,
    label: t.sections[cat],
    items: giftPages.filter(g => g.category === cat),
  }));

  return (
    <div className="min-h-screen bg-stone-50 flex flex-col">
      <Navigation currentStep={0} />

      {/* Header */}
      <div className="bg-white border-b border-stone-100">
        <div className="max-w-4xl mx-auto px-4 pt-10 pb-8 text-center">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-indigo-50 mb-5">
            <Gift className="w-8 h-8 text-indigo-500" />
          </div>
          <h1 className="font-title text-3xl md:text-4xl font-bold text-stone-900 mb-3">{t.title}</h1>
          <p className="text-stone-500 text-lg max-w-2xl mx-auto">{t.subtitle}</p>
        </div>
      </div>

      <div className="flex-1 max-w-5xl mx-auto px-4 py-10 w-full">
        {/* Category sections */}
        {grouped.map(({ category, label, items }) => {
          if (items.length === 0) return null;
          return (
            <div key={category} className="mb-12">
              <h2 className="font-title text-xl font-bold text-stone-900 mb-5">{label}</h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
                {items.map((gift) => {
                  const name = gift.name[language as 'en' | 'de' | 'fr'] || gift.name.en;
                  const description = gift.description[language as 'en' | 'de' | 'fr'] || gift.description.en;
                  const shortDesc = description.length > 110 ? description.slice(0, 110).replace(/\s+\S*$/, '') + '...' : description;

                  return (
                    <Link
                      key={gift.id}
                      to={`/geschenk/${gift.id}`}
                      className="bg-white rounded-2xl shadow-sm border border-stone-100 p-5 hover:shadow-md hover:border-indigo-200 transition-all group"
                    >
                      <span className="text-4xl block mb-3">{gift.emoji}</span>
                      <h3 className="font-title text-lg font-bold text-stone-900 group-hover:text-indigo-500 transition-colors mb-1.5">
                        {name}
                      </h3>
                      <p className="text-sm text-stone-500 mb-3 line-clamp-3">{shortDesc}</p>
                      <span className="inline-flex items-center gap-1 text-sm font-medium text-indigo-500 group-hover:gap-2 transition-all">
                        <ArrowRight size={16} />
                      </span>
                    </Link>
                  );
                })}
              </div>
            </div>
          );
        })}

        {/* CTA Section */}
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
