import { useState, useEffect, useRef, FormEvent, useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Loader2, CheckCircle, BookOpen, Mail, AlertTriangle } from 'lucide-react';
import { GoogleIcon } from '@/components/auth/GoogleIcon';
import { signInWithGoogle, getIdToken, handleRedirectResult } from '@/services/firebase';
import storage from '@/services/storage';
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
    emailSent: 'Almost there — check your email!',
    emailSentDesc: 'Click the link in your email to finish setting up your account and access your story.',
    emailSentNote: 'Didn\'t get it? Check your spam folder.',
    emailSentWarning: 'Without verification your story will be lost.',
    differentEmail: 'Use a different email',
    linkedSuccess: 'Account linked successfully!',
    redirecting: 'Redirecting to your story...',
    error: 'Something went wrong. Please try again.',
    failedTitle: 'Something went wrong',
    failedDesc: 'Story generation failed. Please try again.',
    tryAgain: 'Try Again',
    accountReady: 'Account ready!',
    creditsReceived: 'You received 300 free credits!',
    waitingForStory: 'Your story is almost done. You\'ll be redirected automatically.',
    verifiedWaiting: 'Email verified! Your story is still being created...',
    upsellTitle: 'This is a trial story. With a free account you can create full stories:',
    upsellDesc: '',
    upsellFeatures: [
      'Multiple characters in one story',
      'Longer stories with more pages',
      'Different drawing styles',
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
    emailSent: 'Fast geschafft — prüfe deine E-Mails!',
    emailSentDesc: 'Klicke auf den Link in deiner E-Mail, um dein Konto einzurichten und deine Geschichte zu lesen.',
    emailSentNote: 'Nicht erhalten? Prüfe deinen Spam-Ordner.',
    emailSentWarning: 'Ohne Bestätigung geht deine Geschichte verloren.',
    differentEmail: 'Andere E-Mail verwenden',
    linkedSuccess: 'Konto erfolgreich verknüpft!',
    redirecting: 'Weiterleitung zu deiner Geschichte...',
    error: 'Etwas ist schiefgelaufen. Bitte versuche es erneut.',
    failedTitle: 'Etwas ist schiefgelaufen',
    failedDesc: 'Die Geschichte konnte nicht erstellt werden. Bitte versuche es erneut.',
    tryAgain: 'Erneut versuchen',
    accountReady: 'Konto bereit!',
    creditsReceived: 'Du hast 300 Gratis-Credits erhalten!',
    waitingForStory: 'Deine Geschichte ist fast fertig. Du wirst automatisch weitergeleitet.',
    verifiedWaiting: 'E-Mail bestätigt! Deine Geschichte wird noch erstellt...',
    upsellTitle: 'Das ist eine Probegeschichte. Mit einem kostenlosen Konto kannst du vollständige Geschichten erstellen:',
    upsellDesc: '',
    upsellFeatures: [
      'Mehrere Figuren in einer Geschichte',
      'Längere Geschichten mit mehr Seiten',
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
    emailSent: 'Presque terminé — vérifiez vos e-mails !',
    emailSentDesc: 'Cliquez sur le lien dans votre e-mail pour finaliser votre compte et accéder à votre histoire.',
    emailSentNote: 'Pas reçu ? Vérifiez votre dossier spam.',
    emailSentWarning: 'Sans vérification, votre histoire sera perdue.',
    differentEmail: 'Utiliser une autre adresse',
    linkedSuccess: 'Compte lié avec succès !',
    redirecting: 'Redirection vers votre histoire...',
    error: 'Quelque chose s\'est mal passé. Veuillez réessayer.',
    failedTitle: 'Quelque chose s\'est mal passé',
    failedDesc: 'La création de l\'histoire a échoué. Veuillez réessayer.',
    tryAgain: 'Réessayer',
    accountReady: 'Compte prêt !',
    creditsReceived: 'Vous avez reçu 300 crédits gratuits !',
    waitingForStory: 'Votre histoire est presque terminée. Vous serez redirigé automatiquement.',
    verifiedWaiting: 'E-mail vérifié ! Votre histoire est encore en cours de création...',
    upsellTitle: 'Ceci est une histoire d\'essai. Avec un compte gratuit, vous pouvez créer des histoires complètes :',
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

  // Recover state from localStorage if location.state is lost (e.g., after Google redirect)
  const locationState = location.state as LocationState | null;
  const state = locationState || (() => {
    const savedToken = storage.getItem('trial_gen_session_token');
    if (savedToken) {
      return {
        sessionToken: savedToken,
        characterId: storage.getItem('trial_gen_character_id') || '',
        storyInput: {},
        characterName: storage.getItem('trial_gen_character_name') || '',
      } as LocationState;
    }
    return null;
  })();

  // If we arrived with fresh navigation state, clear stale localStorage from previous sessions
  if (locationState) {
    storage.removeItem('trial_gen_job_id');
  }

  // Redirect if no state (and no saved state from localStorage)
  useEffect(() => {
    if (!state?.sessionToken) {
      navigate('/try', { replace: true });
    }
  }, [state, navigate]);

  // Generation state
  const [pageState, setPageState] = useState<PageState>('starting');
  const [progress, setProgress] = useState(0);
  // Only restore jobId from localStorage if we're recovering from a redirect (no location.state)
  const [jobId, setJobId] = useState<string | null>(
    locationState ? null : storage.getItem('trial_gen_job_id')
  );
  const hasStartedRef = useRef(false);
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollStartRef = useRef<number>(0);

  // Title page image (may arrive late via polling if not ready at navigation time)
  const [titlePageImage, setTitlePageImage] = useState<string | null>(
    state?.titlePageData?.titlePageImage || null
  );
  const [titlePageTitle, setTitlePageTitle] = useState<string | null>(
    state?.titlePageData?.title || null
  );

  // Slideshow of page images as they arrive during generation
  const [pageImages, setPageImages] = useState<Array<{ pageNumber: number; imageData: string }>>([]);
  const [slideshowIndex, setSlideshowIndex] = useState(0);

  // Auth state
  const [email, setEmail] = useState('');
  const [authError, setAuthError] = useState('');
  const [isAuthLoading, setIsAuthLoading] = useState(false);
  const [emailLinked, setEmailLinked] = useState(false);
  const [googleLinked, setGoogleLinked] = useState(false);
  const [isVerified, setIsVerified] = useState(false);

  const isLinked = emailLinked || googleLinked;

  // Poll for email verification after email is linked — auto-redirect when verified
  // Stops after 10 minutes to avoid running forever if user never verifies
  useEffect(() => {
    if (!emailLinked || !state?.sessionToken) return;

    const startTime = Date.now();
    const TEN_MINUTES = 10 * 60 * 1000;

    const interval = setInterval(async () => {
      if (Date.now() - startTime > TEN_MINUTES) {
        clearInterval(interval);
        return;
      }

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
            storage.setItem('auth_token', token);
            storage.removeItem('trial_session_token');
          }
          setIsVerified(true);
        }
      } catch {
        // Ignore polling errors
      }
    }, 5000);

    return () => clearInterval(interval);
  }, [emailLinked, state?.sessionToken]);

  // Start story generation on mount (skip if resuming after Google redirect — jobId already set)
  useEffect(() => {
    if (!state?.sessionToken || hasStartedRef.current) return;
    hasStartedRef.current = true;
    if (jobId) {
      // Resuming after redirect — job was already started
      setPageState('generating');
      return;
    }

    const startGeneration = async () => {
      try {
        const response = await fetch(`${API_URL}/api/trial/create-story`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${state.sessionToken}`,
          },
          body: JSON.stringify({
            ...state.storyInput,
            ...(state.titlePageData?.titlePageImage ? { preGeneratedTitlePage: state.titlePageData.titlePageImage } : {}),
          }),
        });

        const data = await response.json();

        if (!response.ok) {
          if (data.code === 'TRIAL_USED') {
            // Story already exists — show the claim UI so user can sign up to view it
            setPageState('completed');
            setProgress(100);
            return;
          }
          setPageState('failed');
          return;
        }

        setJobId(data.jobId);
        storage.setItem('trial_gen_job_id', data.jobId);
        setPageState('generating');
      } catch {
        setPageState('failed');
      }
    };

    startGeneration();
  }, [state]);

  // Poll job status
  const pollJobStatus = useCallback(async (currentJobId: string, token: string, needTitlePage: boolean) => {
    try {
      const url = needTitlePage
        ? `${API_URL}/api/trial/job-status/${currentJobId}?needTitlePage=1`
        : `${API_URL}/api/trial/job-status/${currentJobId}`;
      const response = await fetch(url, {
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

      // Pick up title page image from poll response (stop asking once received)
      if (data.titlePageImage) {
        setTitlePageImage(data.titlePageImage);
        needTitlePageRef.current = false;
        if (data.titlePageTitle) setTitlePageTitle(data.titlePageTitle);
      }

      // Collect page images as they arrive
      if (data.pageImages && data.pageImages.length > 0) {
        setPageImages(data.pageImages);
      }

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

  // Track whether we still need to fetch the title page (ref so polling closure sees latest value)
  const needTitlePageRef = useRef(!state?.titlePageData?.titlePageImage);

  useEffect(() => {
    if (!jobId || !state?.sessionToken) return;

    // Initial poll
    pollStartRef.current = Date.now();
    pollJobStatus(jobId, state.sessionToken, needTitlePageRef.current);

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
      const shouldStop = await pollJobStatus(jobId, state.sessionToken, needTitlePageRef.current);
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

  // ── Auto-redirect when story is complete AND user is verified ──────────────
  useEffect(() => {
    if (pageState === 'completed' && (isVerified || googleLinked)) {
      // Small delay so user sees the "100% complete" state
      const timer = setTimeout(() => {
        // Clean up trial generation state from localStorage
        storage.removeItem('trial_gen_session_token');
        storage.removeItem('trial_gen_character_id');
        storage.removeItem('trial_gen_character_name');
        storage.removeItem('trial_gen_job_id');
        window.location.href = '/stories';
      }, 1500);
      return () => clearTimeout(timer);
    }
  }, [pageState, isVerified, googleLinked]);

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

  // Complete Google linking with a Firebase user (shared by popup and redirect flows)
  const completeGoogleLink = async (firebaseUser: import('@/services/firebase').FirebaseUser) => {
    const idToken = await getIdToken(firebaseUser);
    const sessionToken = state?.sessionToken;
    if (!sessionToken) return;

    const response = await fetch(`${API_URL}/api/trial/link-google`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${sessionToken}`,
      },
      body: JSON.stringify({ idToken }),
    });

    const data = await response.json();

    if (!response.ok) {
      setAuthError(data.error || t.error);
      return;
    }

    // Store JWT token + user data for authenticated access
    if (data.token) {
      storage.setItem('auth_token', data.token);
      if (data.user) {
        storage.setItem('current_user', JSON.stringify(data.user));
      }
      storage.removeItem('trial_session_token');
    }

    // Clean up saved trial state
    storage.removeItem('trial_gen_session_token');
    storage.removeItem('trial_gen_character_id');
    storage.removeItem('trial_gen_character_name');

    setGoogleLinked(true);
    setIsVerified(true);
  };

  // Handle Google redirect result on page load (when popup was blocked → redirect flow)
  const redirectHandledRef = useRef(false);
  useEffect(() => {
    if (redirectHandledRef.current || !state?.sessionToken) return;
    // Only run if we have saved trial state (meaning we initiated a Google redirect)
    if (!storage.getItem('trial_gen_session_token')) return;
    redirectHandledRef.current = true;

    (async () => {
      try {
        const firebaseUser = await handleRedirectResult();
        if (firebaseUser) {
          setIsAuthLoading(true);
          await completeGoogleLink(firebaseUser);
          setIsAuthLoading(false);
        }
      } catch (err) {
        console.error('Google redirect completion failed:', err);
        setIsAuthLoading(false);
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.sessionToken]);

  const handleGoogleSignIn = async () => {
    if (isAuthLoading || !state?.sessionToken) return;

    setAuthError('');
    setIsAuthLoading(true);

    // Save trial state to localStorage before Google sign-in
    // (in case popup is blocked and we fall back to redirect, which loses location.state)
    storage.setItem('trial_gen_session_token', state.sessionToken);
    if (state.characterId) storage.setItem('trial_gen_character_id', state.characterId);
    if (state.characterName) storage.setItem('trial_gen_character_name', state.characterName);

    try {
      const firebaseUser = await signInWithGoogle();
      await completeGoogleLink(firebaseUser);
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

  // Rotate slideshow every 5 seconds when multiple images available
  useEffect(() => {
    if (pageImages.length <= 1) return;
    const interval = setInterval(() => {
      setSlideshowIndex(prev => (prev + 1) % pageImages.length);
    }, 5000);
    return () => clearInterval(interval);
  }, [pageImages.length]);

  // Scroll to top on mount (mobile)
  useEffect(() => {
    window.scrollTo(0, 0);
  }, []);

  // Don't render if no state (will redirect)
  if (!state?.sessionToken) return null;

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-gray-50 overflow-x-hidden">
      {/* Navigation bar matching the trial wizard */}
      <nav className="bg-black text-white px-3 py-3">
        <div className="flex justify-between items-center">
          <span className="text-sm md:text-base font-bold whitespace-nowrap flex items-center gap-1.5">
            <img src="/images/logo-book.png" alt="" className="h-10 md:h-11 -my-2 w-auto" />
            {t.brand}
          </span>
        </div>
      </nav>

      {/* Content */}
      <div className="px-3 md:px-8 py-4 md:py-8">
        <div className="max-w-lg mx-auto bg-white rounded-2xl shadow-xl p-5 md:p-8">

          {/* ── Progress / Status (compact, on top) ────────────────── */}
          <div className="flex flex-col items-center text-center mb-3">
            {/* Progress: spinner + text + bar */}
            {(pageState === 'starting' || pageState === 'generating') && (
              <div className="w-full flex items-center gap-3 mb-2">
                <Loader2 className="w-4 h-4 text-indigo-500 animate-spin flex-shrink-0" />
                <span className="text-sm text-gray-600">{t.creatingStory}</span>
                <span className="text-xs text-gray-400 ml-auto">{Math.round(progress)}%</span>
              </div>
            )}
            {(pageState === 'starting' || pageState === 'generating') && (
              <div className="w-full bg-gray-200 rounded-full h-1.5 overflow-hidden mb-2">
                <div
                  className="bg-indigo-500 h-1.5 rounded-full transition-all duration-500 ease-out"
                  style={{ width: `${Math.max(progress, 3)}%` }}
                />
              </div>
            )}

            {/* Completed */}
            {pageState === 'completed' && (
              <div className="flex items-center gap-2 text-green-600 mb-2">
                <CheckCircle className="w-4 h-4" />
                <span className="text-sm font-medium">{t.storyComplete}</span>
              </div>
            )}

            {/* Failed state */}
            {pageState === 'failed' && (
              <div className="text-center">
                <div className="w-14 h-14 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-3">
                  <AlertTriangle className="w-7 h-7 text-red-600" />
                </div>
                <h2 className="text-lg font-bold text-gray-800 mb-1">{t.failedTitle}</h2>
                <p className="text-gray-500 text-sm mb-4">{t.failedDesc}</p>
                <button
                  onClick={() => navigate('/try', { replace: true })}
                  className="text-indigo-500 hover:text-indigo-800 font-medium text-sm"
                >
                  {t.tryAgain}
                </button>
              </div>
            )}
          </div>

          {/* ── Image preview — slideshow of pages as they arrive ──── */}
          {pageState !== 'failed' && (
            <div className="flex flex-col items-center mb-4">
              {pageImages.length > 0 ? (
                <>
                  <img
                    src={pageImages[slideshowIndex % pageImages.length].imageData}
                    alt={`Page ${pageImages[slideshowIndex % pageImages.length].pageNumber}`}
                    className="w-full h-auto rounded-xl shadow-lg"
                  />
                  {pageImages.length > 1 && (
                    <div className="flex gap-1.5 mt-2">
                      {pageImages.map((_, i) => (
                        <div key={i} className={`w-2 h-2 rounded-full transition-colors ${i === slideshowIndex % pageImages.length ? 'bg-indigo-500' : 'bg-gray-300'}`} />
                      ))}
                    </div>
                  )}
                </>
              ) : titlePageImage ? (
                <img
                  src={titlePageImage}
                  alt={titlePageTitle || 'Story cover'}
                  className="w-full h-auto rounded-xl shadow-lg"
                />
              ) : state.previewAvatar ? (
                <img
                  src={state.previewAvatar}
                  alt={state.characterName || 'Character'}
                  className="w-48 h-auto rounded-xl object-cover border-4 border-indigo-100 shadow-lg"
                />
              ) : (
                <div className="w-16 h-16 bg-indigo-100 rounded-full flex items-center justify-center">
                  <BookOpen className="w-8 h-8 text-indigo-500" />
                </div>
              )}
            </div>
          )}

          {/* ── Divider ──────────────────────────────────────────────── */}
          {pageState !== 'failed' && <div className="h-px bg-gray-200 mb-6" />}

          {/* ── Sign-in section (hidden on failure) */}
          {pageState !== 'failed' && (
            <>
              {/* Linked success states */}
              {googleLinked && (
                <div className="py-6 text-center">
                  <div className="w-14 h-14 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-3">
                    <CheckCircle className="w-7 h-7 text-green-600" />
                  </div>
                  <h2 className="text-lg font-bold text-gray-800 mb-1">{t.accountReady}</h2>
                  <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 mb-3 text-left">
                    <p className="text-amber-800 text-sm font-semibold mb-2">{t.creditsReceived}</p>
                    <ul className="text-amber-700 text-xs space-y-0.5">
                      {t.upsellFeatures.map((f, i) => <li key={i}>&#x2022; {f}</li>)}
                    </ul>
                  </div>
                  {pageState !== 'completed' ? (
                    <p className="text-gray-500 text-sm">{t.waitingForStory}</p>
                  ) : (
                    <p className="text-gray-500 text-sm">{t.redirecting}</p>
                  )}
                </div>
              )}

              {emailLinked && !isVerified && (
                <div className="py-6 text-center">
                  <div className="w-14 h-14 bg-amber-100 rounded-full flex items-center justify-center mx-auto mb-3">
                    <Mail className="w-7 h-7 text-amber-600" />
                  </div>
                  <h2 className="text-lg font-bold text-gray-800 mb-1">{t.emailSent}</h2>
                  <p className="text-gray-600 text-sm mb-2">{t.emailSentDesc}</p>
                  <p className="text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-xs font-medium mb-3">{t.emailSentWarning}</p>
                  <p className="text-xs text-gray-400 mb-3">{t.emailSentNote}</p>
                  <button
                    onClick={() => { setEmailLinked(false); setEmail(''); setAuthError(''); }}
                    className="text-indigo-500 text-sm font-medium hover:text-indigo-800 underline underline-offset-2"
                  >
                    {t.differentEmail}
                  </button>
                </div>
              )}

              {emailLinked && isVerified && (
                <div className="py-6 text-center">
                  <div className="w-14 h-14 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-3">
                    <CheckCircle className="w-7 h-7 text-green-600" />
                  </div>
                  <h2 className="text-lg font-bold text-gray-800 mb-1">{t.accountReady}</h2>
                  {pageState !== 'completed' ? (
                    <p className="text-gray-500 text-sm">{t.verifiedWaiting}</p>
                  ) : (
                    <p className="text-gray-500 text-sm">{t.redirecting}</p>
                  )}
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
                      className="w-full bg-indigo-500 text-white py-3 rounded-lg font-semibold hover:bg-indigo-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
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
