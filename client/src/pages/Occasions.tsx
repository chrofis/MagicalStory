import { Link } from 'react-router-dom';
import { useLanguage } from '@/context/LanguageContext';
import { Navigation, Footer } from '@/components/common';
import { Gift, ArrowRight } from 'lucide-react';
import { occasions } from '@/constants/occasionData';

const texts: Record<string, {
  title: string;
  subtitle: string;
  ctaTitle: string;
  ctaSubtitle: string;
  ctaButton: string;
}> = {
  en: {
    title: 'The Perfect Gift for Every Occasion',
    subtitle: 'Whether it\'s a birthday, Christmas, or a big life milestone — a personalized story book is the most meaningful gift you can give a child. Explore our occasion guides below.',
    ctaTitle: 'Create Your Free Story',
    ctaSubtitle: 'Choose any theme and create a personalized story in minutes. Your first story is completely free.',
    ctaButton: 'Start Creating',
  },
  de: {
    title: 'Das perfekte Geschenk für jeden Anlass',
    subtitle: 'Ob Geburtstag, Weihnachten oder ein grosser Meilenstein — ein personalisiertes Geschichtenbuch ist das bedeutungsvollste Geschenk, das du einem Kind machen kannst. Entdecke unsere Anlass-Ratgeber.',
    ctaTitle: 'Erstelle deine Gratis-Geschichte',
    ctaSubtitle: 'Wähle ein Thema und erstelle eine personalisierte Geschichte in wenigen Minuten. Deine erste Geschichte ist komplett kostenlos.',
    ctaButton: 'Jetzt starten',
  },
  fr: {
    title: 'Le cadeau parfait pour chaque occasion',
    subtitle: 'Que ce soit un anniversaire, Noël ou une grande étape de vie — un livre d\'histoires personnalisé est le cadeau le plus significatif que vous puissiez offrir à un enfant. Découvrez nos guides par occasion.',
    ctaTitle: 'Créez votre histoire gratuite',
    ctaSubtitle: 'Choisissez un thème et créez une histoire personnalisée en quelques minutes. Votre première histoire est entièrement gratuite.',
    ctaButton: 'Commencer',
  },
};

export default function Occasions() {
  const { language } = useLanguage();
  const t = texts[language] || texts.en;

  return (
    <div className="min-h-screen bg-stone-50 flex flex-col">
      <Navigation currentStep={0} />

      {/* Header */}
      <div className="bg-white border-b border-stone-100">
        <div className="max-w-4xl mx-auto px-4 pt-10 pb-8 text-center">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-indigo-50 mb-5">
            <Gift className="w-8 h-8 text-indigo-600" />
          </div>
          <h1 className="font-title text-3xl md:text-4xl font-bold text-stone-900 mb-3">{t.title}</h1>
          <p className="text-stone-500 text-lg max-w-2xl mx-auto">{t.subtitle}</p>
        </div>
      </div>

      <div className="flex-1 max-w-5xl mx-auto px-4 py-10 w-full">
        {/* Occasion Cards Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4 mb-16">
          {occasions.map((occasion) => {
            const name = occasion.name[language] || occasion.name.en;
            const description = occasion.description[language] || occasion.description.en;
            // Truncate description to ~100 chars for the card
            const shortDesc = description.length > 110 ? description.slice(0, 110).replace(/\s+\S*$/, '') + '...' : description;

            return (
              <Link
                key={occasion.id}
                to={`/anlass/${occasion.id}`}
                className="bg-white rounded-2xl shadow-sm border border-stone-100 p-5 hover:shadow-md hover:border-indigo-200 transition-all group"
              >
                <span className="text-4xl block mb-3">{occasion.emoji}</span>
                <h2 className="font-title text-lg font-bold text-stone-900 group-hover:text-indigo-600 transition-colors mb-1.5">
                  {name}
                </h2>
                <p className="text-sm text-stone-500 mb-3 line-clamp-3">{shortDesc}</p>
                <span className="inline-flex items-center gap-1 text-sm font-medium text-indigo-600 group-hover:gap-2 transition-all">
                  <ArrowRight size={16} />
                </span>
              </Link>
            );
          })}
        </div>

        {/* CTA Section */}
        <div className="bg-indigo-600 rounded-2xl p-8 md:p-12 text-center text-white">
          <h2 className="font-title text-2xl md:text-3xl font-bold mb-3">{t.ctaTitle}</h2>
          <p className="text-indigo-100 mb-6 max-w-lg mx-auto">{t.ctaSubtitle}</p>
          <Link
            to="/try"
            className="inline-flex items-center gap-2 px-8 py-3 rounded-lg bg-white text-indigo-600 font-semibold hover:bg-indigo-50 transition-colors"
          >
            {t.ctaButton} <ArrowRight size={18} />
          </Link>
        </div>
      </div>

      <Footer />
    </div>
  );
}
