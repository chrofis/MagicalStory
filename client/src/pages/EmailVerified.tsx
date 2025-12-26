import { useEffect, useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLanguage } from '@/context/LanguageContext';
import { useAuth } from '@/context/AuthContext';
import { Navigation } from '@/components/common';
import { Button } from '@/components/common/Button';
import { CheckCircle, Loader2, Monitor, Sparkles } from 'lucide-react';

const translations = {
  en: {
    title: 'Email Verified!',
    checkingOtherWindow: 'Checking if your story is starting in the other window...',
    generatingInOtherWindow: 'Your story is being generated in your other browser window!',
    otherWindowHint: 'You can close this tab and return to your original window.',
    manualHint: 'Your original window may have been closed. Click below to create your story.',
    createStory: 'Create Your Story',
    goHome: 'Go to Homepage',
  },
  de: {
    title: 'E-Mail bestätigt!',
    checkingOtherWindow: 'Prüfe, ob Ihre Geschichte im anderen Fenster startet...',
    generatingInOtherWindow: 'Ihre Geschichte wird im anderen Browserfenster generiert!',
    otherWindowHint: 'Sie können diesen Tab schließen und zu Ihrem ursprünglichen Fenster zurückkehren.',
    manualHint: 'Ihr ursprüngliches Fenster wurde möglicherweise geschlossen. Klicken Sie unten, um Ihre Geschichte zu erstellen.',
    createStory: 'Geschichte erstellen',
    goHome: 'Zur Startseite',
  },
  fr: {
    title: 'E-mail verifie!',
    checkingOtherWindow: 'Verification si votre histoire demarre dans l\'autre fenetre...',
    generatingInOtherWindow: 'Votre histoire est en cours de generation dans votre autre fenetre!',
    otherWindowHint: 'Vous pouvez fermer cet onglet et retourner a votre fenetre d\'origine.',
    manualHint: 'Votre fenetre d\'origine a peut-etre ete fermee. Cliquez ci-dessous pour creer votre histoire.',
    createStory: 'Creer votre histoire',
    goHome: 'Aller a l\'accueil',
  },
};

type Status = 'checking' | 'other_window' | 'manual';

export default function EmailVerified() {
  const navigate = useNavigate();
  const { language } = useLanguage();
  const { refreshUser } = useAuth();
  const t = translations[language as keyof typeof translations] || translations.en;
  // Always start with 'checking' - user should never see buttons
  const [status, setStatus] = useState<Status>('checking');

  // Track if component is still mounted to prevent navigation after unmount
  const isMountedRef = useRef(true);
  const hasHandledRef = useRef(false);

  useEffect(() => {
    isMountedRef.current = true;

    // Prevent duplicate handling (React Strict Mode runs effects twice)
    if (hasHandledRef.current) {
      return;
    }

    // Helper to check if generation flag is recent (within last 2 minutes)
    const isRecentGeneration = (timestamp: string | null): boolean => {
      if (!timestamp) return false;
      const startedTime = parseInt(timestamp, 10);
      const twoMinutesAgo = Date.now() - 2 * 60 * 1000;
      return startedTime > twoMinutesAgo;
    };

    const handleVerification = async () => {
      // First check if original window already started generation (recently)
      const alreadyStarted = localStorage.getItem('verificationGenerationStarted');
      if (isRecentGeneration(alreadyStarted)) {
        if (isMountedRef.current) {
          hasHandledRef.current = true;
          setStatus('other_window');
          localStorage.removeItem('pendingStoryGeneration');
        }
        return;
      }

      // Refresh user state so emailVerified is updated
      await refreshUser();

      if (!isMountedRef.current) return;

      // Re-check if generation started during refreshUser
      const startedDuringRefresh = localStorage.getItem('verificationGenerationStarted');
      if (isRecentGeneration(startedDuringRefresh)) {
        hasHandledRef.current = true;
        setStatus('other_window');
        localStorage.removeItem('pendingStoryGeneration');
        return;
      }

      // Wait 5 seconds for original window (polling every 3s) to detect verification and start
      await new Promise(resolve => setTimeout(resolve, 5000));

      if (!isMountedRef.current) return;

      // Final check - did the original window start generation?
      const generationStarted = localStorage.getItem('verificationGenerationStarted');

      hasHandledRef.current = true;

      if (isRecentGeneration(generationStarted)) {
        // Original window is handling it
        setStatus('other_window');
        localStorage.removeItem('pendingStoryGeneration');
      } else {
        // Original window didn't start (probably closed) - show manual button
        // DON'T auto-redirect to prevent duplicate generation
        setStatus('manual');
        localStorage.removeItem('pendingStoryGeneration');
      }
    };

    handleVerification();

    return () => {
      isMountedRef.current = false;
    };
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

          {status === 'manual' && (
            <div className="mb-8">
              <p className="text-gray-600 mb-4">
                {t.manualHint}
              </p>
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
