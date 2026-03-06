import { useNavigate } from 'react-router-dom';
import { useLanguage } from '@/context/LanguageContext';
import { useAuth } from '@/context/AuthContext';
import { useEffect } from 'react';
import { Camera, Sparkles, BookOpen, ArrowRight, Gift, Coins } from 'lucide-react';

const translations = {
  en: {
    welcome: 'Welcome to MagicalStory!',
    subtitle: "Let's create your personalized storybook. Here's how it works:",

    step1Title: 'Create Characters',
    step1Desc: 'Upload photos of family and friends. Add character details to bring the story to life.',

    step2Title: 'Design Your Story',
    step2Desc: 'Choose a theme, art style, and personalize the story. Once ready, we create your story and send you an email.',

    step3Title: 'Print & Share',
    step3Desc: 'Download as PDF instantly or order a printed book.',

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
    subtitle: 'Erstellen wir dein personalisiertes Geschichtenbuch. So funktioniert es:',

    step1Title: 'Charaktere erstellen',
    step1Desc: 'Lade Fotos von Familie und Freunden hoch. Füge Charakter-Details hinzu, um die Geschichte lebendig zu machen.',

    step2Title: 'Geschichte gestalten',
    step2Desc: 'Wähle ein Thema, einen Kunststil und personalisiere die Geschichte. Sobald alles fertig ist, erstellen wir deine Geschichte und senden dir eine E-Mail.',

    step3Title: 'Drucken & Teilen',
    step3Desc: 'Sofort als PDF herunterladen oder ein gedrucktes Buch bestellen.',

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
    subtitle: "Créons votre livre d'histoires personnalisé. Voici comment ça marche:",

    step1Title: 'Créer des personnages',
    step1Desc: "Téléchargez des photos de votre famille et amis. Ajoutez des détails aux personnages pour donner vie à l'histoire.",

    step2Title: 'Concevoir votre histoire',
    step2Desc: "Choisissez un thème, un style artistique et personnalisez l'histoire. Une fois prêt, nous créons votre histoire et vous envoyons un e-mail.",

    step3Title: 'Imprimer & Partager',
    step3Desc: 'Téléchargez en PDF instantanément ou commandez un livre imprimé.',

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
  // Admins can view this page without redirect (for testing/preview)
  useEffect(() => {
    if (!isAuthenticated) {
      navigate('/');
      return;
    }
    if (user?.photoConsentAt && user?.role !== 'admin') {
      // User has already been through onboarding, redirect to create
      navigate('/create');
    }
  }, [isAuthenticated, user?.photoConsentAt, user?.role, navigate]);

  const handleStart = () => {
    // Clear wizard step so new users start at step 1
    localStorage.removeItem('wizard_step');
    navigate('/create');
  };

  const steps = [
    {
      icon: Camera,
      title: t.step1Title,
      desc: t.step1Desc,
      color: 'bg-indigo-500',
    },
    {
      icon: Sparkles,
      title: t.step2Title,
      desc: t.step2Desc,
      color: 'bg-indigo-500',
    },
    {
      icon: BookOpen,
      title: t.step3Title,
      desc: t.step3Desc,
      color: 'bg-indigo-500',
    },
  ];

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 via-white to-purple-50">
      {/* Main Content */}
      <div className="px-4 py-12">
        <div className="max-w-2xl mx-auto">
          {/* Welcome Message */}
          <div className="text-center mb-8">
            <h1 className="text-3xl md:text-4xl font-bold text-gray-900 mb-3">
              {t.welcome}
            </h1>
            <p className="text-lg text-gray-600">
              {t.subtitle}
            </p>
          </div>

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
