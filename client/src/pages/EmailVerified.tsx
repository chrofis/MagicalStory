import { useNavigate } from 'react-router-dom';
import { useLanguage } from '@/context/LanguageContext';
import { Navigation } from '@/components/common';
import { Button } from '@/components/common/Button';
import { CheckCircle, Sparkles } from 'lucide-react';

const translations = {
  en: {
    title: 'Email Verified!',
    description: 'Your email has been verified successfully. You can now create your magical story.',
    createStory: 'Create Your Story',
    goHome: 'Go to Homepage',
  },
  de: {
    title: 'E-Mail bestaetigt!',
    description: 'Ihre E-Mail wurde erfolgreich bestaetigt. Sie koennen jetzt Ihre magische Geschichte erstellen.',
    createStory: 'Geschichte erstellen',
    goHome: 'Zur Startseite',
  },
  fr: {
    title: 'E-mail verifie!',
    description: 'Votre e-mail a ete verifie avec succes. Vous pouvez maintenant creer votre histoire magique.',
    createStory: 'Creer votre histoire',
    goHome: 'Aller a l\'accueil',
  },
};

export default function EmailVerified() {
  const navigate = useNavigate();
  const { language } = useLanguage();
  const t = translations[language as keyof typeof translations] || translations.en;

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      <Navigation currentStep={0} />

      <div className="flex-1 flex items-center justify-center p-4">
        <div className="bg-white rounded-xl shadow-lg max-w-md w-full p-8 text-center">
          <div className="w-20 h-20 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-6">
            <CheckCircle className="w-10 h-10 text-green-600" />
          </div>

          <h1 className="text-3xl font-bold text-gray-800 mb-3">{t.title}</h1>
          <p className="text-gray-500 mb-8">{t.description}</p>

          <div className="space-y-3">
            <Button
              onClick={() => navigate('/create')}
              variant="primary"
              className="w-full"
            >
              <Sparkles size={18} className="mr-2" />
              {t.createStory}
            </Button>

            <Button
              onClick={() => navigate('/')}
              variant="secondary"
              className="w-full"
            >
              {t.goHome}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
