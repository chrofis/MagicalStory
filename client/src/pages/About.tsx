import { useLanguage } from '@/context/LanguageContext';
import { Navigation, Footer } from '@/components/common';
import { ArrowLeft, Shield, BookOpen, Heart } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

const aboutContent: Record<string, {
  title: string;
  mission: string;
  missionText: string;
  values: { icon: string; title: string; text: string }[];
  swissTitle: string;
  swissText: string;
}> = {
  en: {
    title: 'About Magical Story',
    mission: 'Our Mission',
    missionText: 'We believe every child deserves to see themselves as the hero of their own story. Magical Story uses AI illustration technology to turn your family photos into personalized children\'s books — unique stories that feature your child on every page.\n\nWe built Magical Story because we wanted to create something more personal than off-the-shelf children\'s books. Something that captures who your child really is and makes reading together even more special.',
    values: [
      {
        icon: 'shield',
        title: 'Privacy First',
        text: 'Your photos are used only to create your story. We never share, sell, or repurpose them. Your family\'s privacy is non-negotiable.',
      },
      {
        icon: 'book',
        title: 'Quality You Can Hold',
        text: 'Every story is professionally printed on high-quality paper with vibrant colors. A real book, not just a digital file.',
      },
      {
        icon: 'heart',
        title: 'Made with Care',
        text: 'We review our AI output continuously to ensure illustrations are beautiful, age-appropriate, and true to your child\'s appearance.',
      },
    ],
    swissTitle: 'Made in Switzerland',
    swissText: 'Magical Story is designed and operated in Switzerland. We care about doing things right — quality, privacy, and reliability.',
  },
  de: {
    title: 'Über Magical Story',
    mission: 'Unsere Mission',
    missionText: 'Wir glauben, dass jedes Kind verdient, sich als Held seiner eigenen Geschichte zu sehen. Magical Story nutzt KI-Illustrationstechnologie, um aus deinen Familienfotos personalisierte Kinderbücher zu machen — einzigartige Geschichten, in denen dein Kind auf jeder Seite vorkommt.\n\nWir haben Magical Story entwickelt, weil wir etwas Persönlicheres schaffen wollten als Kinderbücher von der Stange. Etwas, das einfängt, wer dein Kind wirklich ist, und das gemeinsame Lesen noch spezieller macht.',
    values: [
      {
        icon: 'shield',
        title: 'Datenschutz an erster Stelle',
        text: 'Deine Fotos werden ausschliesslich zur Erstellung deiner Geschichte verwendet. Wir teilen, verkaufen oder verwenden sie niemals anderweitig.',
      },
      {
        icon: 'book',
        title: 'Qualität zum Anfassen',
        text: 'Jede Geschichte wird professionell auf hochwertigem Papier mit lebendigen Farben gedruckt. Ein echtes Buch, nicht nur eine digitale Datei.',
      },
      {
        icon: 'heart',
        title: 'Mit Sorgfalt gemacht',
        text: 'Wir überprüfen unsere KI-Ergebnisse laufend, um sicherzustellen, dass die Illustrationen schön, altersgerecht und dem Aussehen deines Kindes treu sind.',
      },
    ],
    swissTitle: 'Made in Switzerland',
    swissText: 'Magical Story wird in der Schweiz entwickelt und betrieben. Qualität, Datenschutz und Zuverlässigkeit sind uns wichtig.',
  },
  fr: {
    title: 'À propos de Magical Story',
    mission: 'Notre Mission',
    missionText: 'Nous croyons que chaque enfant mérite de se voir comme le héros de sa propre histoire. Magical Story utilise la technologie d\'illustration par IA pour transformer vos photos de famille en livres pour enfants personnalisés — des histoires uniques où votre enfant apparaît sur chaque page.\n\nNous avons créé Magical Story parce que nous voulions quelque chose de plus personnel que les livres pour enfants standards. Quelque chose qui capture qui est vraiment votre enfant et rend la lecture ensemble encore plus spéciale.',
    values: [
      {
        icon: 'shield',
        title: 'Confidentialité d\'abord',
        text: 'Vos photos sont utilisées uniquement pour créer votre histoire. Nous ne les partageons, vendons ou réutilisons jamais.',
      },
      {
        icon: 'book',
        title: 'Une qualité que vous pouvez toucher',
        text: 'Chaque histoire est imprimée professionnellement sur du papier de haute qualité avec des couleurs vives. Un vrai livre, pas juste un fichier numérique.',
      },
      {
        icon: 'heart',
        title: 'Fait avec soin',
        text: 'Nous révisons continuellement nos résultats IA pour garantir que les illustrations sont belles, adaptées à l\'âge et fidèles à l\'apparence de votre enfant.',
      },
    ],
    swissTitle: 'Made in Switzerland',
    swissText: 'Magical Story est conçu et opéré en Suisse. La qualité, la confidentialité et la fiabilité nous tiennent à cœur.',
  },
};

const iconMap = {
  shield: Shield,
  book: BookOpen,
  heart: Heart,
};

export default function About() {
  const { language } = useLanguage();
  const navigate = useNavigate();
  const content = aboutContent[language] || aboutContent.en;

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      <Navigation currentStep={0} />

      <div className="flex-1 max-w-3xl mx-auto px-4 py-8 w-full">
        <button
          onClick={() => window.history.length > 1 ? navigate(-1) : navigate('/')}
          className="flex items-center gap-2 text-indigo-600 hover:text-indigo-800 mb-6"
        >
          <ArrowLeft size={20} />
          {language === 'de' ? 'Zurück' : language === 'fr' ? 'Retour' : 'Back'}
        </button>

        <h1 className="text-3xl font-bold text-gray-900 mb-8">{content.title}</h1>

        {/* Mission */}
        <div className="bg-white rounded-2xl shadow-sm p-6 md:p-8 mb-6">
          <h2 className="text-xl font-semibold text-gray-800 mb-4">{content.mission}</h2>
          <div className="text-gray-600 leading-relaxed whitespace-pre-line">
            {content.missionText}
          </div>
        </div>

        {/* Values */}
        <div className="grid gap-4 md:grid-cols-3 mb-6">
          {content.values.map((value, index) => {
            const Icon = iconMap[value.icon as keyof typeof iconMap];
            return (
              <div key={index} className="bg-white rounded-2xl shadow-sm p-6 text-center">
                <div className="bg-indigo-100 w-12 h-12 rounded-full flex items-center justify-center mx-auto mb-3">
                  <Icon className="w-6 h-6 text-indigo-600" />
                </div>
                <h3 className="font-semibold text-gray-800 mb-2">{value.title}</h3>
                <p className="text-gray-600 text-sm">{value.text}</p>
              </div>
            );
          })}
        </div>

        {/* Swiss */}
        <div className="bg-white rounded-2xl shadow-sm p-6 md:p-8">
          <h2 className="text-xl font-semibold text-gray-800 mb-3">{content.swissTitle}</h2>
          <p className="text-gray-600">{content.swissText}</p>
        </div>
      </div>

      <Footer />
    </div>
  );
}
