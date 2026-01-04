import { useNavigate } from 'react-router-dom';
import { useLanguage } from '@/context/LanguageContext';
import { useAuth } from '@/context/AuthContext';
import { useEffect } from 'react';
import { Camera, Sparkles, BookOpen, ArrowRight, Gift, Coins } from 'lucide-react';

const translations = {
  en: {
    welcome: 'Welcome to MagicalStory!',
    subtitle: "Let's create your personalized storybook",
    introText: "You're about to turn your photos into a magical illustrated story. Here's how it works:",

    step1Title: 'Create Characters',
    step1Desc: 'Upload photos of your family and friends. Our AI transforms them into beautiful illustrated characters.',

    step2Title: 'Design Your Story',
    step2Desc: 'Choose a theme, art style, and story length. Add personal details to make it unique.',

    step3Title: 'Print & Share',
    step3Desc: 'Download as PDF instantly or order a professionally printed hardcover book.',

    creditsTitle: 'Your Starting Credits',
    creditsAmount: '500',
    creditsLabel: 'free credits',
    creditsExplain: 'Each story page costs 10 credits. A 20-page story = 200 credits.',
    creditsBonus: 'Order a printed book and get your credits back!',

    cta: 'Create Your First Story',

    step: 'Step',
  },
  de: {
    welcome: 'Willkommen bei MagicalStory!',
    subtitle: 'Erstellen wir dein personalisiertes Geschichtenbuch',
    introText: 'Du wirst gleich deine Fotos in eine magische illustrierte Geschichte verwandeln. So funktioniert es:',

    step1Title: 'Charaktere erstellen',
    step1Desc: 'Lade Fotos von Familie und Freunden hoch. Unsere KI verwandelt sie in wunderschöne illustrierte Charaktere.',

    step2Title: 'Geschichte gestalten',
    step2Desc: 'Wähle ein Thema, einen Kunststil und die Länge der Geschichte. Füge persönliche Details hinzu.',

    step3Title: 'Drucken & Teilen',
    step3Desc: 'Sofort als PDF herunterladen oder ein professionell gedrucktes Hardcover-Buch bestellen.',

    creditsTitle: 'Deine Startguthaben',
    creditsAmount: '500',
    creditsLabel: 'Gratis-Credits',
    creditsExplain: 'Jede Seite kostet 10 Credits. Eine 20-seitige Geschichte = 200 Credits.',
    creditsBonus: 'Bestelle ein gedrucktes Buch und erhalte deine Credits zurück!',

    cta: 'Erstelle deine erste Geschichte',

    step: 'Schritt',
  },
  fr: {
    welcome: 'Bienvenue sur MagicalStory!',
    subtitle: 'Créons votre livre d\'histoires personnalisé',
    introText: 'Vous allez transformer vos photos en une histoire illustrée magique. Voici comment ça marche:',

    step1Title: 'Créer des personnages',
    step1Desc: 'Téléchargez des photos de votre famille et amis. Notre IA les transforme en magnifiques personnages illustrés.',

    step2Title: 'Concevoir votre histoire',
    step2Desc: 'Choisissez un thème, un style artistique et la longueur. Ajoutez des détails personnels.',

    step3Title: 'Imprimer & Partager',
    step3Desc: 'Téléchargez en PDF instantanément ou commandez un livre relié imprimé professionnellement.',

    creditsTitle: 'Vos crédits de départ',
    creditsAmount: '500',
    creditsLabel: 'crédits gratuits',
    creditsExplain: 'Chaque page coûte 10 crédits. Une histoire de 20 pages = 200 crédits.',
    creditsBonus: 'Commandez un livre imprimé et récupérez vos crédits!',

    cta: 'Créer votre première histoire',

    step: 'Étape',
  },
};

export default function WelcomePage() {
  const navigate = useNavigate();
  const { language } = useLanguage();
  const { isAuthenticated, user } = useAuth();
  const t = translations[language] || translations.en;

  // Redirect if user has already consented (not a new user)
  useEffect(() => {
    if (!isAuthenticated) {
      navigate('/');
      return;
    }
    if (user?.photoConsentAt) {
      // User has already been through onboarding, redirect to create
      navigate('/create');
    }
  }, [isAuthenticated, user?.photoConsentAt, navigate]);

  const handleStart = () => {
    navigate('/create');
  };

  const steps = [
    {
      icon: Camera,
      title: t.step1Title,
      desc: t.step1Desc,
      color: 'bg-blue-500',
    },
    {
      icon: Sparkles,
      title: t.step2Title,
      desc: t.step2Desc,
      color: 'bg-purple-500',
    },
    {
      icon: BookOpen,
      title: t.step3Title,
      desc: t.step3Desc,
      color: 'bg-green-500',
    },
  ];

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 via-white to-purple-50">
      {/* Header */}
      <div className="pt-8 pb-4 px-4">
        <div className="max-w-2xl mx-auto text-center">
          <div className="inline-flex items-center gap-2 mb-6">
            <Sparkles className="w-8 h-8 text-indigo-600" />
            <span className="text-2xl font-bold text-indigo-600">MagicalStory</span>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="px-4 pb-12">
        <div className="max-w-2xl mx-auto">
          {/* Welcome Message */}
          <div className="text-center mb-8">
            <h1 className="text-3xl md:text-4xl font-bold text-gray-900 mb-3">
              {t.welcome}
            </h1>
            <p className="text-lg text-gray-600 mb-2">
              {t.subtitle}
            </p>
            {user?.username && (
              <p className="text-indigo-600 font-medium">
                {user.username}
              </p>
            )}
          </div>

          {/* Intro Text */}
          <p className="text-center text-gray-600 mb-8">
            {t.introText}
          </p>

          {/* Steps */}
          <div className="space-y-4 mb-8">
            {steps.map((step, index) => (
              <div
                key={index}
                className="bg-white rounded-xl p-4 shadow-sm border border-gray-100 flex items-start gap-4"
              >
                <div className={`${step.color} rounded-full p-3 flex-shrink-0`}>
                  <step.icon className="w-6 h-6 text-white" />
                </div>
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs font-semibold text-gray-400 uppercase">
                      {t.step} {index + 1}
                    </span>
                  </div>
                  <h3 className="font-semibold text-gray-900 mb-1">
                    {step.title}
                  </h3>
                  <p className="text-sm text-gray-600">
                    {step.desc}
                  </p>
                </div>
              </div>
            ))}
          </div>

          {/* Credits Info Box */}
          <div className="bg-gradient-to-r from-amber-50 to-yellow-50 rounded-xl p-6 mb-8 border border-amber-200">
            <div className="flex items-start gap-4">
              <div className="bg-amber-400 rounded-full p-3 flex-shrink-0">
                <Coins className="w-6 h-6 text-white" />
              </div>
              <div className="flex-1">
                <h3 className="font-semibold text-gray-900 mb-2">
                  {t.creditsTitle}
                </h3>
                <div className="flex items-baseline gap-2 mb-2">
                  <span className="text-4xl font-bold text-amber-600">
                    {t.creditsAmount}
                  </span>
                  <span className="text-amber-700 font-medium">
                    {t.creditsLabel}
                  </span>
                </div>
                <p className="text-sm text-gray-600 mb-2">
                  {t.creditsExplain}
                </p>
                <div className="flex items-center gap-2 text-sm text-green-700 bg-green-50 rounded-lg px-3 py-2">
                  <Gift className="w-4 h-4 flex-shrink-0" />
                  <span className="font-medium">{t.creditsBonus}</span>
                </div>
              </div>
            </div>
          </div>

          {/* CTA Button */}
          <button
            onClick={handleStart}
            className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-semibold py-4 px-6 rounded-xl shadow-lg hover:shadow-xl transition-all flex items-center justify-center gap-2 text-lg"
          >
            {t.cta}
            <ArrowRight className="w-5 h-5" />
          </button>
        </div>
      </div>
    </div>
  );
}
