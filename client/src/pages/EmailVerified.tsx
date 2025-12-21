import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLanguage } from '@/context/LanguageContext';
import { useAuth } from '@/context/AuthContext';
import { Navigation } from '@/components/common';
import { Button } from '@/components/common/Button';
import { CheckCircle, Sparkles, Loader2 } from 'lucide-react';

const translations = {
  en: {
    title: 'Email Verified!',
    description: 'Your email has been verified successfully. You can now create your magical story.',
    autoGenerating: 'Starting your story generation...',
    createStory: 'Create Your Story',
    goHome: 'Go to Homepage',
  },
  de: {
    title: 'E-Mail bestaetigt!',
    description: 'Ihre E-Mail wurde erfolgreich bestaetigt. Sie koennen jetzt Ihre magische Geschichte erstellen.',
    autoGenerating: 'Starte Ihre Geschichte...',
    createStory: 'Geschichte erstellen',
    goHome: 'Zur Startseite',
  },
  fr: {
    title: 'E-mail verifie!',
    description: 'Votre e-mail a ete verifie avec succes. Vous pouvez maintenant creer votre histoire magique.',
    autoGenerating: 'Demarrage de votre histoire...',
    createStory: 'Creer votre histoire',
    goHome: 'Aller a l\'accueil',
  },
};

export default function EmailVerified() {
  const navigate = useNavigate();
  const { language } = useLanguage();
  useAuth(); // Keep auth context active
  const t = translations[language as keyof typeof translations] || translations.en;
  const [isRedirecting, setIsRedirecting] = useState(false);

  // Check if there's a pending story generation and auto-redirect
  useEffect(() => {
    const pendingGeneration = localStorage.getItem('pendingStoryGeneration');
    if (pendingGeneration === 'true') {
      setIsRedirecting(true);
      localStorage.removeItem('pendingStoryGeneration');
      // Small delay so user sees the success message
      setTimeout(() => {
        navigate('/create?autoGenerate=true');
      }, 1500);
    }
  }, [navigate]);

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      <Navigation currentStep={0} />

      <div className="flex-1 flex items-center justify-center p-4">
        <div className="bg-white rounded-xl shadow-lg max-w-md w-full p-8 text-center">
          <div className="w-20 h-20 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-6">
            <CheckCircle className="w-10 h-10 text-green-600" />
          </div>

          <h1 className="text-3xl font-bold text-gray-800 mb-3">{t.title}</h1>

          {isRedirecting ? (
            <div className="mb-8">
              <p className="text-indigo-600 font-medium flex items-center justify-center gap-2">
                <Loader2 className="w-5 h-5 animate-spin" />
                {t.autoGenerating}
              </p>
            </div>
          ) : (
            <>
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
            </>
          )}
        </div>
      </div>
    </div>
  );
}
