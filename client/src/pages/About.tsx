import { useLanguage } from '@/context/LanguageContext';
import { Navigation, Footer } from '@/components/common';
import { Shield, BookOpen, Heart, Sparkles, MapPin } from 'lucide-react';
import { Link } from 'react-router-dom';

const aboutContent: Record<string, {
  title: string;
  tagline: string;
  missionTitle: string;
  missionText: string[];
  valuesTitle: string;
  values: { icon: string; title: string; text: string }[];
  swissTitle: string;
  swissText: string;
  ctaTitle: string;
  ctaText: string;
  ctaButton: string;
}> = {
  en: {
    title: 'About Magical Story',
    tagline: 'Personalized children\'s books where your child is the star.',
    missionTitle: 'Why we built this',
    missionText: [
      'We believe every child deserves to see themselves as the hero of their own story. Magical Story turns your family photos into personalized children\'s books — unique stories that feature your child on every page.',
      'We wanted to create something more personal than off-the-shelf children\'s books. Something that captures who your child really is and makes reading together even more special.',
    ],
    valuesTitle: 'What we stand for',
    values: [
      {
        icon: 'shield',
        title: 'Privacy First',
        text: 'Your photos are used only to create your story. We never share, sell, or repurpose them.',
      },
      {
        icon: 'book',
        title: 'Quality You Can Hold',
        text: 'Professionally printed on high-quality paper with vibrant colors. A real book, not just a digital file.',
      },
      {
        icon: 'heart',
        title: 'Made with Care',
        text: 'We continuously review our output to ensure illustrations are beautiful, age-appropriate, and true to your child.',
      },
    ],
    swissTitle: 'Made in Switzerland',
    swissText: 'Designed and operated in Switzerland. We care about doing things right — quality, privacy, and reliability.',
    ctaTitle: 'Try it free',
    ctaText: 'Create your first personalized story in under 3 minutes. No account needed.',
    ctaButton: 'Create a Free Story',
  },
  de: {
    title: 'Über Magical Story',
    tagline: 'Personalisierte Kinderbücher, in denen dein Kind der Star ist.',
    missionTitle: 'Warum wir das gebaut haben',
    missionText: [
      'Wir glauben, dass jedes Kind verdient, sich als Held seiner eigenen Geschichte zu sehen. Magical Story verwandelt deine Familienfotos in personalisierte Kinderbücher — einzigartige Geschichten, in denen dein Kind auf jeder Seite vorkommt.',
      'Wir wollten etwas Persönlicheres schaffen als Kinderbücher von der Stange. Etwas, das einfängt, wer dein Kind wirklich ist, und das gemeinsame Lesen noch spezieller macht.',
    ],
    valuesTitle: 'Wofür wir stehen',
    values: [
      {
        icon: 'shield',
        title: 'Datenschutz zuerst',
        text: 'Deine Fotos werden ausschliesslich zur Erstellung deiner Geschichte verwendet. Wir teilen oder verkaufen sie niemals.',
      },
      {
        icon: 'book',
        title: 'Qualität zum Anfassen',
        text: 'Professionell gedruckt auf hochwertigem Papier mit lebendigen Farben. Ein echtes Buch, nicht nur eine Datei.',
      },
      {
        icon: 'heart',
        title: 'Mit Sorgfalt gemacht',
        text: 'Wir überprüfen laufend unsere Ergebnisse, damit die Illustrationen schön, altersgerecht und deinem Kind treu sind.',
      },
    ],
    swissTitle: 'Made in Switzerland',
    swissText: 'Entwickelt und betrieben in der Schweiz. Qualität, Datenschutz und Zuverlässigkeit sind uns wichtig.',
    ctaTitle: 'Gratis ausprobieren',
    ctaText: 'Erstelle deine erste personalisierte Geschichte in unter 3 Minuten. Ohne Konto.',
    ctaButton: 'Gratis Geschichte erstellen',
  },
  fr: {
    title: 'À propos de Magical Story',
    tagline: 'Des livres pour enfants personnalisés où votre enfant est la star.',
    missionTitle: 'Pourquoi nous avons créé ceci',
    missionText: [
      'Nous croyons que chaque enfant mérite de se voir comme le héros de sa propre histoire. Magical Story transforme vos photos de famille en livres pour enfants personnalisés — des histoires uniques où votre enfant apparaît sur chaque page.',
      'Nous voulions quelque chose de plus personnel que les livres pour enfants standards. Quelque chose qui capture qui est vraiment votre enfant et rend la lecture ensemble encore plus spéciale.',
    ],
    valuesTitle: 'Nos valeurs',
    values: [
      {
        icon: 'shield',
        title: 'Confidentialité d\'abord',
        text: 'Vos photos sont utilisées uniquement pour créer votre histoire. Nous ne les partageons ou vendons jamais.',
      },
      {
        icon: 'book',
        title: 'Qualité que vous pouvez toucher',
        text: 'Imprimé professionnellement sur du papier de haute qualité avec des couleurs vives. Un vrai livre, pas juste un fichier.',
      },
      {
        icon: 'heart',
        title: 'Fait avec soin',
        text: 'Nous révisons continuellement nos résultats pour des illustrations belles, adaptées à l\'âge et fidèles à votre enfant.',
      },
    ],
    swissTitle: 'Made in Switzerland',
    swissText: 'Conçu et opéré en Suisse. La qualité, la confidentialité et la fiabilité nous tiennent à cœur.',
    ctaTitle: 'Essayez gratuitement',
    ctaText: 'Créez votre première histoire personnalisée en moins de 3 minutes. Sans compte.',
    ctaButton: 'Créer une histoire gratuite',
  },
};

const iconMap = {
  shield: Shield,
  book: BookOpen,
  heart: Heart,
};

const iconColors = {
  shield: { bg: 'bg-rose-50', text: 'text-rose-500', border: 'border-rose-100' },
  book: { bg: 'bg-emerald-50', text: 'text-emerald-500', border: 'border-emerald-100' },
  heart: { bg: 'bg-purple-50', text: 'text-purple-500', border: 'border-purple-100' },
};

export default function About() {
  const { language } = useLanguage();
  const content = aboutContent[language] || aboutContent.en;

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      <Navigation currentStep={0} />

      {/* Hero header */}
      <div className="bg-white border-b border-gray-100">
        <div className="max-w-3xl mx-auto px-4 pt-10 pb-10 text-center">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-indigo-50 mb-5">
            <Sparkles className="w-8 h-8 text-indigo-600" />
          </div>
          <h1 className="text-3xl md:text-4xl font-bold text-gray-900 mb-3">{content.title}</h1>
          <p className="text-gray-500 text-lg max-w-xl mx-auto">{content.tagline}</p>
        </div>
      </div>

      <div className="flex-1 max-w-3xl mx-auto px-4 py-10 w-full">
        {/* Mission */}
        <div className="mb-10">
          <h2 className="text-xl font-semibold text-gray-800 mb-5">{content.missionTitle}</h2>
          <div className="space-y-4">
            {content.missionText.map((paragraph, i) => (
              <p key={i} className="text-gray-600 leading-relaxed text-[15px]">{paragraph}</p>
            ))}
          </div>
        </div>

        {/* Values */}
        <div className="mb-10">
          <h2 className="text-xl font-semibold text-gray-800 mb-5">{content.valuesTitle}</h2>
          <div className="grid gap-4 md:grid-cols-3">
            {content.values.map((value, index) => {
              const Icon = iconMap[value.icon as keyof typeof iconMap];
              const colors = iconColors[value.icon as keyof typeof iconColors];
              return (
                <div key={index} className={`bg-white rounded-2xl border ${colors.border} p-6`}>
                  <div className={`${colors.bg} w-11 h-11 rounded-xl flex items-center justify-center mb-4`}>
                    <Icon className={`w-5 h-5 ${colors.text}`} />
                  </div>
                  <h3 className="font-semibold text-gray-800 mb-2">{value.title}</h3>
                  <p className="text-gray-500 text-sm leading-relaxed">{value.text}</p>
                </div>
              );
            })}
          </div>
        </div>

        {/* Swiss badge */}
        <div className="bg-white rounded-2xl border border-gray-100 p-6 md:p-8 flex items-start gap-5 mb-10">
          <div className="bg-red-50 w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0">
            <MapPin className="w-5 h-5 text-red-500" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-gray-800 mb-1">{content.swissTitle}</h2>
            <p className="text-gray-500 text-[15px] leading-relaxed">{content.swissText}</p>
          </div>
        </div>

        {/* CTA */}
        <div className="bg-gradient-to-br from-indigo-50 to-purple-50 rounded-2xl p-8 text-center border border-indigo-100">
          <h3 className="text-xl font-semibold text-gray-800 mb-2">{content.ctaTitle}</h3>
          <p className="text-gray-600 mb-5 max-w-md mx-auto">{content.ctaText}</p>
          <Link
            to="/try"
            className="inline-flex items-center gap-2 px-6 py-3 rounded-lg bg-indigo-600 text-white font-medium hover:bg-indigo-700 transition-colors"
          >
            <Sparkles size={18} />
            {content.ctaButton}
          </Link>
        </div>
      </div>

      <Footer />
    </div>
  );
}
