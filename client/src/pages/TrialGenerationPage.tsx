import { useState, useEffect, useRef, FormEvent, useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Loader2, CheckCircle, BookOpen, AlertCircle, Mail, Sparkles } from 'lucide-react';
import { GoogleIcon } from '@/components/auth/GoogleIcon';
import { signInWithGoogle, getIdToken } from '@/services/firebase';
import { useLanguage } from '@/context/LanguageContext';

const API_URL = import.meta.env.VITE_API_URL || '';

// ─── Types ───────────────────────────────────────────────────────────────────

type PageState = 'starting' | 'generating' | 'completed' | 'failed';

interface LocationState {
  sessionToken: string;
  characterId: string | null;
  storyInput: {
    storyCategory: string;
    storyTopic: string;
    storyTheme: string;
    storyDetails: string;
    language: string;
  };
  characterName: string;
  previewAvatar: string | null;
}

// ─── Translations ────────────────────────────────────────────────────────────

const translations = {
  en: {
    brand: 'Magical Story',
    creatingStory: 'Your story is being created!',
    startingGeneration: 'Starting story generation...',
    storyComplete: 'Your story is ready!',
    storyFailed: 'Something went wrong',
    storyFailedDesc: 'We couldn\'t create your story. Please try again.',
    tryAgain: 'Try again',
    saveYourStory: 'Save your story',
    saveDescription: 'Enter your email or sign in with Google to save your story and receive it as a PDF.',
    saveDescriptionComplete: 'Your story is ready! Enter your email or sign in with Google to access it.',
    googleButton: 'Continue with Google',
    orDivider: 'or',
    emailLabel: 'Email address',
    emailPlaceholder: 'you@example.com',
    emailSubmit: 'Save my story',
    terms: 'By continuing, you agree to our',
    termsLink: 'Terms of Service',
    and: 'and',
    privacyLink: 'Privacy Policy',
    emailSent: 'Check your inbox!',
    emailSentDesc: 'We sent a link to your email. Click it to access your story.',
    emailSentNote: 'Didn\'t get it? Check your spam folder.',
    linkedSuccess: 'Account linked successfully!',
    redirecting: 'Redirecting to your story...',
    error: 'Something went wrong. Please try again.',
    upsellTitle: 'Want even more?',
    upsellDesc: 'With a full account you unlock:',
    upsellFeatures: [
      'Multiple characters in one story',
      'Longer stories',
      'Multiple drawing styles',
      'Higher image quality and title page',
      'Order as a printed book',
    ],
  },
  de: {
    brand: 'Magical Story',
    creatingStory: 'Deine Geschichte wird erstellt!',
    startingGeneration: 'Geschichten-Erstellung wird gestartet...',
    storyComplete: 'Deine Geschichte ist fertig!',
    storyFailed: 'Etwas ist schiefgelaufen',
    storyFailedDesc: 'Die Geschichte konnte nicht erstellt werden. Bitte versuche es erneut.',
    tryAgain: 'Erneut versuchen',
    saveYourStory: 'Sichere deine Geschichte',
    saveDescription: 'Gib deine E-Mail ein oder melde dich mit Google an, um deine Geschichte zu speichern und als PDF zu erhalten.',
    saveDescriptionComplete: 'Deine Geschichte ist fertig! Gib deine E-Mail ein oder melde dich mit Google an, um darauf zuzugreifen.',
    googleButton: 'Weiter mit Google',
    orDivider: 'oder',
    emailLabel: 'E-Mail-Adresse',
    emailPlaceholder: 'du@beispiel.com',
    emailSubmit: 'Geschichte speichern',
    terms: 'Mit der Fortsetzung stimmst du unseren',
    termsLink: 'Nutzungsbedingungen',
    and: 'und',
    privacyLink: 'Datenschutzrichtlinien',
    emailSent: 'Prüfe deinen Posteingang!',
    emailSentDesc: 'Wir haben dir einen Link per E-Mail gesendet. Klicke darauf, um auf deine Geschichte zuzugreifen.',
    emailSentNote: 'Nicht erhalten? Prüfe deinen Spam-Ordner.',
    linkedSuccess: 'Konto erfolgreich verknüpft!',
    redirecting: 'Weiterleitung zu deiner Geschichte...',
    error: 'Etwas ist schiefgelaufen. Bitte versuche es erneut.',
    upsellTitle: 'Du willst noch mehr?',
    upsellDesc: 'Mit einem vollständigen Konto erhältst du:',
    upsellFeatures: [
      'Mehrere Figuren in einer Geschichte',
      'Längere Geschichten',
      'Verschiedene Zeichenstile',
      'Höhere Bildqualität und Titelseite',
      'Als gedrucktes Buch bestellen',
    ],
  },
  fr: {
    brand: 'Magical Story',
    creatingStory: 'Votre histoire est en cours de création !',
    startingGeneration: 'Démarrage de la création...',
    storyComplete: 'Votre histoire est prête !',
    storyFailed: 'Quelque chose s\'est mal passé',
    storyFailedDesc: 'Nous n\'avons pas pu créer votre histoire. Veuillez réessayer.',
    tryAgain: 'Réessayer',
    saveYourStory: 'Sauvegardez votre histoire',
    saveDescription: 'Entrez votre e-mail ou connectez-vous avec Google pour sauvegarder votre histoire et la recevoir en PDF.',
    saveDescriptionComplete: 'Votre histoire est prête ! Entrez votre e-mail ou connectez-vous avec Google pour y accéder.',
    googleButton: 'Continuer avec Google',
    orDivider: 'ou',
    emailLabel: 'Adresse e-mail',
    emailPlaceholder: 'vous@exemple.com',
    emailSubmit: 'Sauvegarder mon histoire',
    terms: 'En continuant, vous acceptez nos',
    termsLink: 'Conditions d\'utilisation',
    and: 'et',
    privacyLink: 'Politique de confidentialité',
    emailSent: 'Vérifiez votre boîte de réception !',
    emailSentDesc: 'Nous vous avons envoyé un lien par e-mail. Cliquez dessus pour accéder à votre histoire.',
    emailSentNote: 'Pas reçu ? Vérifiez votre dossier spam.',
    linkedSuccess: 'Compte lié avec succès !',
    redirecting: 'Redirection vers votre histoire...',
    error: 'Quelque chose s\'est mal passé. Veuillez réessayer.',
    upsellTitle: 'Vous en voulez plus ?',
    upsellDesc: 'Avec un compte complet, vous débloquez :',
    upsellFeatures: [
      'Plusieurs personnages dans une même histoire',
      'Des histoires plus longues',
      'Plusieurs styles de dessin',
      'Qualité d\'image supérieure et page de titre',
      'Commander en livre imprimé',
    ],
  },
};

// ─── Component ───────────────────────────────────────────────────────────────

export default function TrialGenerationPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const { language } = useLanguage();
  const t = translations[language as keyof typeof translations] || translations.en;

  const state = location.state as LocationState | null;

  // Redirect if no state
  useEffect(() => {
    if (!state?.sessionToken) {
      navigate('/try', { replace: true });
    }
  }, [state, navigate]);

  // Generation state
  const [pageState, setPageState] = useState<PageState>('starting');
  const [progress, setProgress] = useState(0);
  const [progressMessage, setProgressMessage] = useState(t.startingGeneration);
  const [jobId, setJobId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const hasStartedRef = useRef(false);
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollStartRef = useRef<number>(0);

  // Auth state
  const [email, setEmail] = useState('');
  const [authError, setAuthError] = useState('');
  const [isAuthLoading, setIsAuthLoading] = useState(false);
  const [emailLinked, setEmailLinked] = useState(false);
  const [googleLinked, setGoogleLinked] = useState(false);

  const isLinked = emailLinked || googleLinked;

  // Start story generation on mount
  useEffect(() => {
    if (!state?.sessionToken || hasStartedRef.current) return;
    hasStartedRef.current = true;

    const startGeneration = async () => {
      try {
        const response = await fetch(`${API_URL}/api/trial/create-story`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${state.sessionToken}`,
          },
          body: JSON.stringify(state.storyInput),
        });

        const data = await response.json();

        if (!response.ok) {
          setPageState('failed');
          setErrorMessage(data.error || t.error);
          return;
        }

        setJobId(data.jobId);
        setPageState('generating');
      } catch {
        setPageState('failed');
        setErrorMessage(t.error);
      }
    };

    startGeneration();
  }, [state, t.error]);

  // Poll job status
  const pollJobStatus = useCallback(async (currentJobId: string, token: string) => {
    try {
      const response = await fetch(`${API_URL}/api/trial/job-status/${currentJobId}`, {
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });

      const data = await response.json();

      if (!response.ok) {
        setPageState('failed');
        setErrorMessage(data.error || t.error);
        return true; // stop polling
      }

      if (data.progress !== undefined) setProgress(data.progress);
      if (data.progressMessage) setProgressMessage(data.progressMessage);

      if (data.status === 'completed') {
        setPageState('completed');
        setProgress(100);
        return true; // stop polling
      }

      if (data.status === 'failed') {
        setPageState('failed');
        setErrorMessage(data.errorMessage || t.error);
        return true; // stop polling
      }

      return false; // continue polling
    } catch {
      // Network error — continue polling, don't fail immediately
      return false;
    }
  }, [t.error]);

  useEffect(() => {
    if (!jobId || !state?.sessionToken) return;

    // Initial poll
    pollStartRef.current = Date.now();
    pollJobStatus(jobId, state.sessionToken);

    // Set up interval with 15-minute timeout
    pollIntervalRef.current = setInterval(async () => {
      if (Date.now() - pollStartRef.current > 15 * 60 * 1000) {
        if (pollIntervalRef.current) {
          clearInterval(pollIntervalRef.current);
          pollIntervalRef.current = null;
        }
        setPageState('failed');
        setErrorMessage(t.error);
        return;
      }
      const shouldStop = await pollJobStatus(jobId, state.sessionToken);
      if (shouldStop && pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
    }, 3000);

    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
    };
  }, [jobId, state?.sessionToken, pollJobStatus]);

  // ── Email linking ──────────────────────────────────────────────────────────

  const handleEmailSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!email.trim() || isAuthLoading || !state?.sessionToken) return;

    setAuthError('');
    setIsAuthLoading(true);

    try {
      const response = await fetch(`${API_URL}/api/trial/link-email`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${state.sessionToken}`,
        },
        body: JSON.stringify({ email: email.trim() }),
      });

      const data = await response.json();

      if (!response.ok) {
        setAuthError(data.error || t.error);
        return;
      }

      setEmailLinked(true);
    } catch {
      setAuthError(t.error);
    } finally {
      setIsAuthLoading(false);
    }
  };

  // ── Google linking ─────────────────────────────────────────────────────────

  const handleGoogleSignIn = async () => {
    if (isAuthLoading || !state?.sessionToken) return;

    setAuthError('');
    setIsAuthLoading(true);

    try {
      const firebaseUser = await signInWithGoogle();
      const idToken = await getIdToken(firebaseUser);

      const response = await fetch(`${API_URL}/api/trial/link-google`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${state.sessionToken}`,
        },
        body: JSON.stringify({ idToken }),
      });

      const data = await response.json();

      if (!response.ok) {
        setAuthError(data.error || t.error);
        return;
      }

      // Store JWT token for authenticated access
      if (data.token) {
        localStorage.setItem('auth_token', data.token);
        localStorage.removeItem('trial_session_token');
      }

      setGoogleLinked(true);

      // Navigate to stories page after a brief moment
      setTimeout(() => {
        navigate('/stories', { replace: true });
      }, 2000);
    } catch (err) {
      // Don't show error for redirect-based auth
      if (err instanceof Error && err.message === 'Redirecting to Google...') {
        return;
      }
      setAuthError(t.error);
    } finally {
      setIsAuthLoading(false);
    }
  };

  // Don't render if no state (will redirect)
  if (!state?.sessionToken) return null;

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen flex flex-col bg-gradient-to-br from-indigo-50 via-white to-indigo-50">
      {/* Header */}
      <header className="bg-white/80 backdrop-blur-sm border-b border-gray-100">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center">
          <button
            onClick={() => navigate('/')}
            className="flex items-center gap-2 text-indigo-700 font-bold text-lg hover:opacity-80 transition-opacity"
          >
            <BookOpen className="w-5 h-5" />
            {t.brand}
          </button>
        </div>
      </header>

      {/* Content */}
      <div className="flex-1 flex items-start justify-center p-4 pt-8 md:pt-16">
        <div className="max-w-4xl w-full grid grid-cols-1 md:grid-cols-2 gap-6 md:gap-8">

          {/* ── Left: Progress ─────────────────────────────────────────── */}
          <div className="bg-white rounded-2xl shadow-lg p-8 flex flex-col items-center text-center">
            {/* Preview avatar */}
            {state.previewAvatar && (
              <div className="mb-6">
                <img
                  src={state.previewAvatar}
                  alt={state.characterName || 'Character'}
                  className="w-28 h-28 rounded-full object-cover border-4 border-indigo-100 shadow-md"
                />
              </div>
            )}

            {/* Status icon */}
            {!state.previewAvatar && (
              <div className="w-16 h-16 bg-indigo-100 rounded-full flex items-center justify-center mb-6">
                {pageState === 'completed' ? (
                  <CheckCircle className="w-8 h-8 text-green-600" />
                ) : pageState === 'failed' ? (
                  <AlertCircle className="w-8 h-8 text-red-600" />
                ) : (
                  <Sparkles className="w-8 h-8 text-indigo-600 animate-pulse" />
                )}
              </div>
            )}

            {/* Title */}
            <h1 className="text-2xl font-bold text-gray-800 mb-2">
              {pageState === 'completed'
                ? t.storyComplete
                : pageState === 'failed'
                  ? t.storyFailed
                  : t.creatingStory}
            </h1>

            {/* Character name subtitle */}
            {state.characterName && pageState !== 'failed' && (
              <p className="text-indigo-600 font-medium mb-4">
                {state.characterName}
              </p>
            )}

            {/* Progress bar */}
            {(pageState === 'starting' || pageState === 'generating') && (
              <div className="w-full mb-4">
                <div className="w-full bg-gray-200 rounded-full h-3 overflow-hidden">
                  <div
                    className="bg-indigo-600 h-3 rounded-full transition-all duration-500 ease-out"
                    style={{ width: `${Math.max(progress, 5)}%` }}
                  />
                </div>
                <p className="text-sm text-gray-500 mt-2">{progressMessage}</p>
              </div>
            )}

            {/* Loading spinner for starting/generating */}
            {(pageState === 'starting' || pageState === 'generating') && (
              <Loader2 className="w-6 h-6 text-indigo-500 animate-spin mt-2" />
            )}

            {/* Completed icon when avatar is shown */}
            {pageState === 'completed' && state.previewAvatar && (
              <div className="flex items-center gap-2 text-green-600 mb-2">
                <CheckCircle className="w-5 h-5" />
                <span className="font-medium">{t.storyComplete}</span>
              </div>
            )}

            {/* Failed state */}
            {pageState === 'failed' && (
              <div className="mt-2">
                <p className="text-gray-600 mb-4">
                  {errorMessage || t.storyFailedDesc}
                </p>
                <button
                  onClick={() => navigate('/try', { replace: true })}
                  className="text-indigo-600 hover:text-indigo-800 font-medium transition-colors"
                >
                  {t.tryAgain}
                </button>
              </div>
            )}

            {/* Upsell box */}
            {pageState !== 'failed' && (
              <div className="mt-6 w-full bg-gradient-to-r from-indigo-50 to-indigo-50 rounded-xl p-4 border border-indigo-100 text-left">
                <p className="text-sm font-semibold text-indigo-700 mb-2">{t.upsellTitle}</p>
                <p className="text-xs text-gray-600 mb-2">{t.upsellDesc}</p>
                <ul className="text-xs text-gray-600 space-y-1">
                  {t.upsellFeatures.map((f, i) => (
                    <li key={i} className="flex items-center gap-1.5">
                      <span className="text-indigo-500 font-bold">+</span> {f}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          {/* ── Right: Email/Google sign-in ──────────────────────────── */}
          <div className="bg-white rounded-2xl shadow-lg p-8">
            {/* Linked success state */}
            {googleLinked && (
              <div className="py-8 text-center">
                <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
                  <CheckCircle className="w-8 h-8 text-green-600" />
                </div>
                <h2 className="text-xl font-bold text-gray-800 mb-2">{t.linkedSuccess}</h2>
                <p className="text-gray-500">{t.redirecting}</p>
              </div>
            )}

            {emailLinked && (
              <div className="py-8 text-center">
                <div className="w-16 h-16 bg-indigo-100 rounded-full flex items-center justify-center mx-auto mb-4">
                  <Mail className="w-8 h-8 text-indigo-600" />
                </div>
                <h2 className="text-xl font-bold text-gray-800 mb-2">{t.emailSent}</h2>
                <p className="text-gray-600 mb-2">{t.emailSentDesc}</p>
                <p className="text-sm text-gray-400">{t.emailSentNote}</p>
              </div>
            )}

            {/* Input form */}
            {!isLinked && (
              <>
                <div className="text-center mb-6">
                  <h2 className="text-xl font-bold text-gray-800 mb-1">{t.saveYourStory}</h2>
                  <p className="text-gray-500 text-sm">
                    {pageState === 'completed' ? t.saveDescriptionComplete : t.saveDescription}
                  </p>
                </div>

                {/* Error display */}
                {authError && (
                  <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-3 mb-4 text-sm">
                    {authError}
                  </div>
                )}

                {/* Google button */}
                <button
                  type="button"
                  onClick={handleGoogleSignIn}
                  disabled={isAuthLoading}
                  className="w-full flex items-center justify-center gap-3 bg-white border border-gray-300 text-gray-700 py-3 rounded-lg font-semibold hover:bg-gray-50 transition-colors disabled:opacity-50"
                >
                  {isAuthLoading ? (
                    <Loader2 className="w-5 h-5 animate-spin" />
                  ) : (
                    <GoogleIcon />
                  )}
                  {t.googleButton}
                </button>

                {/* Divider */}
                <div className="flex items-center gap-3 my-5">
                  <div className="flex-1 h-px bg-gray-200" />
                  <span className="text-sm text-gray-400 font-medium">{t.orDivider}</span>
                  <div className="flex-1 h-px bg-gray-200" />
                </div>

                {/* Email form */}
                <form onSubmit={handleEmailSubmit} className="space-y-3">
                  <div>
                    <label htmlFor="trial-gen-email" className="block text-sm font-medium text-gray-700 mb-1">
                      {t.emailLabel}
                    </label>
                    <input
                      id="trial-gen-email"
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder={t.emailPlaceholder}
                      required
                      disabled={isAuthLoading}
                      className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none transition-all disabled:opacity-50 disabled:bg-gray-50"
                    />
                  </div>

                  <button
                    type="submit"
                    disabled={isAuthLoading || !email.trim()}
                    className="w-full bg-indigo-600 text-white py-3 rounded-lg font-semibold hover:bg-indigo-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                  >
                    {isAuthLoading ? (
                      <Loader2 className="w-5 h-5 animate-spin" />
                    ) : (
                      <CheckCircle className="w-5 h-5" />
                    )}
                    {t.emailSubmit}
                  </button>
                </form>

                {/* Terms note */}
                <p className="text-xs text-gray-400 text-center mt-4">
                  {t.terms}{' '}
                  <a href="/terms" target="_blank" className="underline hover:text-gray-600">
                    {t.termsLink}
                  </a>{' '}
                  {t.and}{' '}
                  <a href="/privacy" target="_blank" className="underline hover:text-gray-600">
                    {t.privacyLink}
                  </a>
                  .
                </p>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
