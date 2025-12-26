import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLanguage } from '@/context/LanguageContext';
import { useAuth } from '@/context/AuthContext';
import { Navigation } from '@/components/common';
import { Button } from '@/components/common/Button';
import { CheckCircle, Sparkles, Loader2, Monitor } from 'lucide-react';

const translations = {
  en: {
    title: 'Email Verified!',
    description: 'Your email has been verified successfully. You can now create your magical story.',
    checkingOtherWindow: 'Checking if your story is starting in the other window...',
    generatingInOtherWindow: 'Your story is being generated in your other browser window!',
    otherWindowHint: 'You can close this tab and return to your original window.',
    autoGenerating: 'Starting your story generation...',
    createStory: 'Create Your Story',
    goHome: 'Go to Homepage',
  },
  de: {
    title: 'E-Mail bestätigt!',
    description: 'Ihre E-Mail wurde erfolgreich bestätigt. Sie können jetzt Ihre magische Geschichte erstellen.',
    checkingOtherWindow: 'Prüfe, ob Ihre Geschichte im anderen Fenster startet...',
    generatingInOtherWindow: 'Ihre Geschichte wird im anderen Browserfenster generiert!',
    otherWindowHint: 'Sie können diesen Tab schließen und zu Ihrem ursprünglichen Fenster zurückkehren.',
    autoGenerating: 'Starte Ihre Geschichte...',
    createStory: 'Geschichte erstellen',
    goHome: 'Zur Startseite',
  },
  fr: {
    title: 'E-mail verifie!',
    description: 'Votre e-mail a ete verifie avec succes. Vous pouvez maintenant creer votre histoire magique.',
    checkingOtherWindow: 'Verification si votre histoire demarre dans l\'autre fenetre...',
    generatingInOtherWindow: 'Votre histoire est en cours de generation dans votre autre fenetre!',
    otherWindowHint: 'Vous pouvez fermer cet onglet et retourner a votre fenetre d\'origine.',
    autoGenerating: 'Demarrage de votre histoire...',
    createStory: 'Creer votre histoire',
    goHome: 'Aller a l\'accueil',
  },
};

type Status = 'checking' | 'other_window' | 'redirecting' | 'idle';

export default function EmailVerified() {
  const navigate = useNavigate();
  const { language } = useLanguage();
  const { refreshUser } = useAuth();
  const t = translations[language as keyof typeof translations] || translations.en;
  const [status, setStatus] = useState<Status>('idle');

  useEffect(() => {
    const handleVerification = async () => {
      // Refresh user state so emailVerified is updated
      await refreshUser();

      const pendingGeneration = localStorage.getItem('pendingStoryGeneration');
      if (pendingGeneration !== 'true') {
        // No pending generation - just show verified message
        setStatus('idle');
        return;
      }

      // There's a pending generation - give the original window 5 seconds to start
      setStatus('checking');

      // Wait 5 seconds for the original window (polling every 3s) to detect verification
      await new Promise(resolve => setTimeout(resolve, 5000));

      // Check if the original window started generation
      const generationStarted = localStorage.getItem('verificationGenerationStarted');

      if (generationStarted) {
        // Original window is handling it - show message
        setStatus('other_window');
        // Clear the pending flag since original window is handling it
        localStorage.removeItem('pendingStoryGeneration');
      } else {
        // Original window didn't start (probably closed) - we'll handle it
        setStatus('redirecting');
        localStorage.removeItem('pendingStoryGeneration');
        // Small delay so user sees the message
        setTimeout(() => {
          navigate('/create?autoGenerate=true');
        }, 1000);
      }
    };

    handleVerification();
  }, [navigate, refreshUser]);

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      <Navigation currentStep={0} />

      <div className="flex-1 flex items-center justify-center p-4">
        <div className="bg-white rounded-xl shadow-lg max-w-md w-full p-8 text-center">
          <div className={`w-20 h-20 rounded-full flex items-center justify-center mx-auto mb-6 ${
            status === 'other_window' ? 'bg-indigo-100' : 'bg-green-100'
          }`}>
            {status === 'other_window' ? (
              <Monitor className="w-10 h-10 text-indigo-600" />
            ) : (
              <CheckCircle className="w-10 h-10 text-green-600" />
            )}
          </div>

          <h1 className="text-3xl font-bold text-gray-800 mb-3">{t.title}</h1>

          {status === 'checking' && (
            <div className="mb-8">
              <p className="text-gray-600 flex items-center justify-center gap-2">
                <Loader2 className="w-5 h-5 animate-spin" />
                {t.checkingOtherWindow}
              </p>
            </div>
          )}

          {status === 'other_window' && (
            <div className="mb-8">
              <p className="text-indigo-600 font-medium mb-2">
                {t.generatingInOtherWindow}
              </p>
              <p className="text-gray-500 text-sm">
                {t.otherWindowHint}
              </p>
            </div>
          )}

          {status === 'redirecting' && (
            <div className="mb-8">
              <p className="text-indigo-600 font-medium flex items-center justify-center gap-2">
                <Loader2 className="w-5 h-5 animate-spin" />
                {t.autoGenerating}
              </p>
            </div>
          )}

          {status === 'idle' && (
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

          {status === 'other_window' && (
            <div className="space-y-3 mt-6">
              <Button
                onClick={() => navigate('/')}
                variant="secondary"
                className="w-full"
              >
                {t.goHome}
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
