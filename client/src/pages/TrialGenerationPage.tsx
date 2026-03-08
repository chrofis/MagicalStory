import { useState, useEffect, useRef, FormEvent, useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Loader2, CheckCircle, BookOpen, Mail } from 'lucide-react';
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
  titlePageData?: {
    titlePageImage: string | null;
    title: string | null;
    costumeType: string | null;
  } | null;
}

// ─── Translations ────────────────────────────────────────────────────────────

const translations = {
  en: {
    brand: 'Magical Story',
    creatingStory: 'Creating your story...',
    storyComplete: 'Your story is ready!',
    signInToSee: 'Sign in to read your story',
    signInDesc: 'Your story will be ready in a few minutes. Create a free account now so you can read it as soon as it\'s done!',
    googleButton: 'Continue with Google',
    orDivider: 'or',
    emailLabel: 'Email address',
    emailPlaceholder: 'you@example.com',
    emailSubmit: 'View my story',
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
    creatingStory: 'Deine Geschichte wird erstellt...',
    storyComplete: 'Deine Geschichte ist fertig!',
    signInToSee: 'Melde dich an, um deine Geschichte zu lesen',
    signInDesc: 'Deine Geschichte ist in wenigen Minuten fertig. Erstelle jetzt ein kostenloses Konto, damit du sie sofort lesen kannst!',
    googleButton: 'Weiter mit Google',
    orDivider: 'oder',
    emailLabel: 'E-Mail-Adresse',
    emailPlaceholder: 'du@beispiel.com',
    emailSubmit: 'Geschichte ansehen',
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
    creatingStory: 'Votre histoire est en cours de création...',
    storyComplete: 'Votre histoire est prête !',
    signInToSee: 'Connectez-vous pour lire votre histoire',
    signInDesc: 'Votre histoire sera prête dans quelques minutes. Créez un compte gratuit maintenant pour la lire dès qu\'elle est terminée !',
    googleButton: 'Continuer avec Google',
    orDivider: 'ou',
    emailLabel: 'Adresse e-mail',
    emailPlaceholder: 'vous@exemple.com',
    emailSubmit: 'Voir mon histoire',
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
  const [jobId, setJobId] = useState<string | null>(null);
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

  // Poll for email verification after email is linked — auto-redirect when verified
  useEffect(() => {
    if (!emailLinked || !state?.sessionToken) return;

    const interval = setInterval(async () => {
      try {
        const statusRes = await fetch(`${API_URL}/api/trial/check-status`, {
          headers: { 'Authorization': `Bearer ${state.sessionToken}` },
        });
        if (!statusRes.ok) return;
        const statusData = await statusRes.json();

        if (statusData.emailVerified) {
          clearInterval(interval);
          // Exchange session token for a full JWT
          const claimRes = await fetch(`${API_URL}/api/trial/claim-session`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${state.sessionToken}` },
          });
          if (claimRes.ok) {
            const { token } = await claimRes.json();
            localStorage.setItem('auth_token', token);
            localStorage.removeItem('trial_session_token');
          }
          navigate('/stories', { replace: true });
        }
      } catch {
        // Ignore polling errors
      }
    }, 5000);

    return () => clearInterval(interval);
  }, [emailLinked, state?.sessionToken, navigate]);

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
          if (data.code === 'TRIAL_USED') {
            navigate('/try', { replace: true });
            return;
          }
          setPageState('failed');
          return;
        }

        setJobId(data.jobId);
        setPageState('generating');
      } catch {
        setPageState('failed');
      }
    };

    startGeneration();
  }, [state]);

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
        return true; // stop polling
      }

      if (data.progress !== undefined) setProgress(data.progress);

      if (data.status === 'completed') {
        setPageState('completed');
        setProgress(100);
        return true; // stop polling
      }

      if (data.status === 'failed') {
        setPageState('failed');
        return true; // stop polling
      }

      return false; // continue polling
    } catch {
      // Network error — continue polling, don't fail immediately
      return false;
    }
  }, []);

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

      {/* Content — single centered card */}
      <div className="flex-1 flex items-start justify-center p-4 pt-8 md:pt-16">
        <div className="max-w-md w-full bg-white rounded-2xl shadow-lg p-8">

          {/* ── Avatar + Progress ─────────────────────────────────────── */}
          <div className="flex flex-col items-center text-center mb-6">
            {/* Title page or avatar preview */}
            {state.titlePageData?.titlePageImage ? (
              <div className="mb-4">
                <img
                  src={state.titlePageData.titlePageImage}
                  alt={state.titlePageData.title || 'Story cover'}
                  className="w-48 h-auto rounded-xl shadow-lg mx-auto"
                />
              </div>
            ) : state.previewAvatar ? (
              <div className="mb-4">
                <img
                  src={state.previewAvatar}
                  alt={state.characterName || 'Character'}
                  className="w-48 h-48 rounded-full object-cover border-4 border-indigo-100 shadow-md"
                />
              </div>
            ) : (
              <div className="w-16 h-16 bg-indigo-100 rounded-full flex items-center justify-center mb-4">
                <BookOpen className="w-8 h-8 text-indigo-600" />
              </div>
            )}

            {/* Title */}
            <h1 className="text-xl font-bold text-gray-800 mb-1">
              {pageState === 'completed'
                ? t.storyComplete
                : t.creatingStory}
            </h1>

            {/* Character name */}
            {state.characterName && (
              <p className="text-indigo-600 font-medium text-sm mb-3">
                {state.characterName}
              </p>
            )}

            {/* Progress bar — % only, no text messages */}
            {(pageState === 'starting' || pageState === 'generating') && (
              <div className="w-full">
                <div className="w-full bg-gray-200 rounded-full h-2.5 overflow-hidden">
                  <div
                    className="bg-indigo-600 h-2.5 rounded-full transition-all duration-500 ease-out"
                    style={{ width: `${Math.max(progress, 3)}%` }}
                  />
                </div>
                <p className="text-xs text-gray-400 mt-1.5">{Math.round(progress)}%</p>
              </div>
            )}

            {/* Completed checkmark */}
            {pageState === 'completed' && (
              <div className="flex items-center gap-1.5 text-green-600">
                <CheckCircle className="w-4 h-4" />
                <span className="text-sm font-medium">100%</span>
              </div>
            )}
          </div>

          {/* ── Divider ──────────────────────────────────────────────── */}
          <div className="h-px bg-gray-200 mb-6" />

          {/* ── Sign-in section (always shown — even on failure, drive sign-up) */}
          {(
            <>
              {/* Linked success states */}
              {googleLinked && (
                <div className="py-6 text-center">
                  <div className="w-14 h-14 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-3">
                    <CheckCircle className="w-7 h-7 text-green-600" />
                  </div>
                  <h2 className="text-lg font-bold text-gray-800 mb-1">{t.linkedSuccess}</h2>
                  <p className="text-gray-500 text-sm">{t.redirecting}</p>
                </div>
              )}

              {emailLinked && (
                <div className="py-6 text-center">
                  <div className="w-14 h-14 bg-indigo-100 rounded-full flex items-center justify-center mx-auto mb-3">
                    <Mail className="w-7 h-7 text-indigo-600" />
                  </div>
                  <h2 className="text-lg font-bold text-gray-800 mb-1">{t.emailSent}</h2>
                  <p className="text-gray-600 text-sm mb-1">{t.emailSentDesc}</p>
                  <p className="text-xs text-gray-400">{t.emailSentNote}</p>
                </div>
              )}

              {/* Sign-in form */}
              {!isLinked && (
                <>
                  <div className="text-center mb-5">
                    <h2 className="text-xl font-bold text-gray-800 mb-2">{t.signInToSee}</h2>
                    <p className="text-gray-600 text-sm">{t.signInDesc}</p>
                  </div>

                  {/* Error */}
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
                  <div className="flex items-center gap-3 my-4">
                    <div className="flex-1 h-px bg-gray-200" />
                    <span className="text-sm text-gray-400 font-medium">{t.orDivider}</span>
                    <div className="flex-1 h-px bg-gray-200" />
                  </div>

                  {/* Email form */}
                  <form onSubmit={handleEmailSubmit} className="space-y-3">
                    <input
                      id="trial-gen-email"
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder={t.emailPlaceholder}
                      required
                      disabled={isAuthLoading}
                      aria-label={t.emailLabel}
                      className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none transition-all disabled:opacity-50 disabled:bg-gray-50"
                    />

                    <button
                      type="submit"
                      disabled={isAuthLoading || !email.trim()}
                      className="w-full bg-indigo-600 text-white py-3 rounded-lg font-semibold hover:bg-indigo-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                    >
                      {isAuthLoading && <Loader2 className="w-5 h-5 animate-spin" />}
                      {t.emailSubmit}
                    </button>
                  </form>

                  {/* Terms */}
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

                  {/* Upsell — compact */}
                  <div className="mt-5 bg-indigo-50 rounded-xl p-3 border border-indigo-100 text-left">
                    <p className="text-xs font-semibold text-indigo-700 mb-1">{t.upsellTitle}</p>
                    <ul className="text-xs text-gray-600 space-y-0.5">
                      {t.upsellFeatures.map((f, i) => (
                        <li key={i} className="flex items-center gap-1.5">
                          <span className="text-indigo-500 font-bold">+</span> {f}
                        </li>
                      ))}
                    </ul>
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
