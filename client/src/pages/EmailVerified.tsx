import { useEffect, useState, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useLanguage } from '@/context/LanguageContext';
import { useAuth } from '@/context/AuthContext';
import { Navigation } from '@/components/common';
import { Button } from '@/components/common/Button';
import { CheckCircle, Loader2, Monitor, Sparkles, LogIn } from 'lucide-react';

const translations = {
  en: {
    title: 'Email Verified!',
    checkingOtherWindow: 'Please return to your original browser window where your story should now be generating...',
    generatingInOtherWindow: 'Your story is being generated in your other browser window!',
    otherWindowHint: 'You can close this tab and return to your original window.',
    manualHint: 'Your original window may have been closed. Click below to create your story.',
    notLoggedInHint: 'Please log in to create your story.',
    createStory: 'Create Your Story',
    login: 'Log In',
    goHome: 'Go to Homepage',
    upsellTitle: 'More features with a full account',
    upsellFeatures: [
      'Multiple characters in one story',
      'Longer stories',
      'Multiple drawing styles',
      'Higher image quality and title page',
      'Order as a printed book',
    ],
  },
  de: {
    title: 'E-Mail bestätigt!',
    checkingOtherWindow: 'Bitte kehre zu deinem ursprünglichen Browserfenster zurück, wo deine Geschichte nun generiert werden sollte...',
    generatingInOtherWindow: 'Deine Geschichte wird im anderen Browserfenster generiert!',
    otherWindowHint: 'Du kannst diesen Tab schliessen und zu deinem ursprünglichen Fenster zurückkehren.',
    manualHint: 'Dein ursprüngliches Fenster wurde möglicherweise geschlossen. Klicke unten, um deine Geschichte zu erstellen.',
    notLoggedInHint: 'Bitte melde dich an, um deine Geschichte zu erstellen.',
    createStory: 'Geschichte erstellen',
    login: 'Anmelden',
    goHome: 'Zur Startseite',
    upsellTitle: 'Mehr Möglichkeiten mit einem vollständigen Konto',
    upsellFeatures: [
      'Mehrere Figuren in einer Geschichte',
      'Längere Geschichten',
      'Verschiedene Zeichenstile',
      'Höhere Bildqualität und Titelseite',
      'Als gedrucktes Buch bestellen',
    ],
  },
  fr: {
    title: 'E-mail vérifié !',
    checkingOtherWindow: 'Veuillez retourner à votre fenêtre de navigateur d\'origine où votre histoire devrait maintenant être générée...',
    generatingInOtherWindow: 'Votre histoire est en cours de génération dans votre autre fenêtre !',
    otherWindowHint: 'Vous pouvez fermer cet onglet et retourner à votre fenêtre d\'origine.',
    manualHint: 'Votre fenêtre d\'origine a peut-être été fermée. Cliquez ci-dessous pour créer votre histoire.',
    notLoggedInHint: 'Veuillez vous connecter pour créer votre histoire.',
    createStory: 'Créer votre histoire',
    login: 'Se connecter',
    goHome: 'Aller à l\'accueil',
    upsellTitle: 'Plus de fonctionnalités avec un compte complet',
    upsellFeatures: [
      'Plusieurs personnages dans une même histoire',
      'Des histoires plus longues',
      'Plusieurs styles de dessin',
      'Qualité d\'image supérieure et page de titre',
      'Commander en livre imprimé',
    ],
  },
};

type Status = 'checking' | 'other_window' | 'manual';

export default function EmailVerified() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { language } = useLanguage();
  const { user, refreshUser } = useAuth();
  const t = translations[language as keyof typeof translations] || translations.en;
  const isLoggedIn = !!user;
  // Always start with 'checking' - user should never see buttons
  const [status, setStatus] = useState<Status>('checking');

  // Track if component is still mounted to prevent navigation after unmount
  const isMountedRef = useRef(true);
  const hasHandledRef = useRef(false);

  // Handle trial user redirect: ?token=...&trial=true
  useEffect(() => {
    const token = searchParams.get('token');
    const isTrial = searchParams.get('trial') === 'true';
    if (token && isTrial) {
      localStorage.setItem('auth_token', token);
      localStorage.removeItem('trial_session_token');
      navigate('/stories', { replace: true });
    }
  }, [searchParams, navigate]);

  useEffect(() => {
    isMountedRef.current = true;

    // Prevent duplicate handling (React Strict Mode runs effects twice)
    if (hasHandledRef.current) {
      return;
    }

    // Skip if trial redirect will handle it
    if (searchParams.get('token') && searchParams.get('trial') === 'true') {
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

      // Wait 10 seconds for original window (polling every 3s) to detect verification and start
      await new Promise(resolve => setTimeout(resolve, 10000));

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
                {isLoggedIn ? (
                  <Button
                    onClick={() => navigate('/create')}
                    variant="primary"
                    className="w-full"
                  >
                    <Sparkles size={18} className="mr-2" />
                    {t.createStory}
                  </Button>
                ) : (
                  <Button
                    onClick={() => navigate('/?login=true&redirect=%2Fcreate')}
                    variant="primary"
                    className="w-full"
                  >
                    <LogIn size={18} className="mr-2" />
                    {t.login}
                  </Button>
                )}
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

          {/* Upsell banner */}
          <div className="bg-gradient-to-r from-indigo-50 to-indigo-50 rounded-xl p-5 mt-6 border border-indigo-100 text-left">
            <p className="text-sm font-semibold text-indigo-700 mb-3">{t.upsellTitle}</p>
            <ul className="text-sm text-gray-600 space-y-1.5">
              {t.upsellFeatures.map((f, i) => (
                <li key={i} className="flex items-start gap-2">
                  <span className="text-indigo-500 font-bold">+</span> {f}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
