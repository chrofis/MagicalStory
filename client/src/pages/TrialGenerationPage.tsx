import { useState, useEffect, useRef, useMemo, FormEvent, useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Loader2, CheckCircle, BookOpen, Mail, AlertTriangle } from 'lucide-react';
import { GoogleIcon } from '@/components/auth/GoogleIcon';
import { signInWithGooglePopup } from '@/services/googleAuth';
import storage from '@/services/storage';
import { useLanguage } from '@/context/LanguageContext';
import { INITIAL_USER_CREDITS } from '@/constants/credits';
import { trackEmailLead, trackTrialStoryCompleted } from '@/utils/gtagConversion';

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
    costumeType: string | null;
    avatarSlides?: string[];
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
    creditsReceived: `You received ${INITIAL_USER_CREDITS} free credits!`,
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
    rotationTrialIntro: 'This is a trial story — it should be ready in about a minute. Trial stories are short. A full story takes a bit longer but gives you many more pages and richer scenes.',
    rotationEmailHint: 'Add your email after the story finishes so we can send you the PDF. Set a password too and you get free credits for a full-length story.',
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
    creditsReceived: `Du hast ${INITIAL_USER_CREDITS} Gratis-Credits erhalten!`,
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
    rotationTrialIntro: 'Das ist eine Probegeschichte — sie sollte in etwa einer Minute fertig sein. Probegeschichten sind kurz. Eine vollständige Geschichte dauert etwas länger, hat dafür viel mehr Seiten und reichhaltigere Szenen.',
    rotationEmailHint: 'Gib am Ende deine E-Mail an, damit wir dir die Geschichte als PDF schicken können. Setze auch ein Passwort, dann bekommst du Gratis-Credits für eine richtige Geschichte in voller Länge.',
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
    creditsReceived: `Vous avez reçu ${INITIAL_USER_CREDITS} crédits gratuits !`,
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
    rotationTrialIntro: 'Ceci est une histoire d\'essai — elle devrait être prête en environ une minute. Les histoires d\'essai sont courtes. Une histoire complète prend un peu plus de temps mais offre beaucoup plus de pages et des scènes plus riches.',
    rotationEmailHint: 'Saisis ton e-mail à la fin pour que nous puissions t\'envoyer le PDF de l\'histoire. Définis aussi un mot de passe et tu reçois des crédits gratuits pour une histoire complète.',
  },
};

// Funny messages reused inside the rotation. Module-scope so the
// slideshowItems memo (which references them) doesn't hit a TDZ — the
// previous in-component declaration sat AFTER the memo, so the first
// render threw "Cannot access 'funnyMessages' before initialization"
// and the whole page rendered blank.
const funnyMessages = [
  { en: '{name} is getting ready for their big adventure...', de: '{name} macht sich bereit für das grosse Abenteuer...', fr: '{name} se prépare pour sa grande aventure...' },
  { en: '{name} is practicing their hero pose...', de: '{name} übt gerade die Heldenpose...', fr: '{name} s\'entraîne à prendre la pose du héros...' },
  { en: '{name} can\'t wait to see what happens next!', de: '{name} kann es kaum erwarten zu sehen, was als Nächstes passiert!', fr: '{name} a hâte de voir ce qui va se passer !' },
  { en: '{name} just found a magic feather! Adding it to the story...', de: '{name} hat gerade eine Zauberfeder gefunden!', fr: '{name} vient de trouver une plume magique !' },
  { en: '{name} is whispering secrets to the story wizard...', de: '{name} flüstert dem Geschichtenzauberer Geheimnisse zu...', fr: '{name} chuchote des secrets au magicien des histoires...' },
  { en: '{name} is doing a little happy dance!', de: '{name} macht einen kleinen Freudentanz!', fr: '{name} fait une petite danse de joie !' },
  { en: '{name} is painting the next scene with imagination...', de: '{name} malt die nächste Szene mit viel Fantasie...', fr: '{name} peint la prochaine scène avec imagination...' },
  { en: '{name} made friends with a talking squirrel!', de: '{name} hat sich mit einem sprechenden Eichhörnchen angefreundet!', fr: '{name} s\'est fait ami avec un écureuil parlant !' },
  { en: 'The story wizard is adding extra sparkle for {name}...', de: 'Der Geschichtenzauberer fügt extra Glitzer für {name} hinzu...', fr: 'Le magicien ajoute des paillettes supplémentaires pour {name}...' },
  { en: '{name} is choosing the perfect adventure outfit...', de: '{name} sucht das perfekte Abenteuer-Outfit aus...', fr: '{name} choisit la tenue d\'aventure parfaite...' },
  { en: '{name} is teaching the story characters a secret handshake...', de: '{name} bringt den Geschichtsfiguren einen geheimen Handschlag bei...', fr: '{name} apprend une poignée de main secrète aux personnages...' },
  { en: '{name} is sneaking into the next page already...', de: '{name} schleicht sich schon auf die nächste Seite...', fr: '{name} se glisse déjà dans la page suivante...' },
  { en: 'The illustrator is mixing fresh paint just for {name}...', de: 'Der Illustrator mischt neue Farben — extra für {name}...', fr: 'L\'illustrateur prépare des couleurs neuves pour {name}...' },
  { en: '{name} is double-checking every comma...', de: '{name} prüft noch einmal jedes Komma...', fr: '{name} relit chaque virgule...' },
  { en: '{name} is asking the moon for a tiny smile...', de: '{name} bittet den Mond um ein kleines Lächeln...', fr: '{name} demande à la lune un petit sourire...' },
  { en: 'A tiny dragon just offered {name} some help. Polite refusal.', de: 'Ein kleiner Drache hat {name} Hilfe angeboten. Höflich abgelehnt.', fr: 'Un petit dragon propose son aide à {name}. Refus poli.' },
  { en: '{name} is collecting just one more sparkle...', de: '{name} sammelt noch ein letztes Glitzern...', fr: '{name} ramasse encore un éclat de paillette...' },
  { en: 'The story wizard mislaid a comma. Looking now.', de: 'Der Geschichtenzauberer hat ein Komma verlegt. Sucht es gerade.', fr: 'Le magicien a égaré une virgule. Il la cherche.' },
  { en: '{name} is humming the title page tune...', de: '{name} summt die Melodie vom Titelbild...', fr: '{name} fredonne l\'air de la couverture...' },
  { en: 'Adding extra colours to {name}\'s scarf...', de: 'Mehr Farben für {name}s Schal...', fr: 'Encore des couleurs pour l\'écharpe de {name}...' },
  { en: '{name} is reading the last chapter twice for luck...', de: '{name} liest das letzte Kapitel zweimal, für\'s Glück...', fr: '{name} relit le dernier chapitre, pour porter chance...' },
  { en: 'A fox in the margins waves at {name}...', de: 'Ein Fuchs am Seitenrand winkt {name} zu...', fr: 'Un renard dans la marge salue {name}...' },
  { en: '{name} is stretching before the final scene...', de: '{name} streckt sich vor der letzten Szene...', fr: '{name} s\'étire avant la dernière scène...' },
  { en: 'The font is fluffing its serifs for {name}...', de: 'Die Schrift macht ihre Serifen schön für {name}...', fr: 'La police arrange ses sérifs pour {name}...' },
  { en: '{name} just found a hidden door in the story!', de: '{name} hat eine geheime Tür in der Geschichte entdeckt!', fr: '{name} a trouvé une porte secrète dans l\'histoire !' },
  { en: 'Polishing the moonlight before the night scene...', de: 'Das Mondlicht wird poliert für die Nachtszene...', fr: 'On lustre le clair de lune pour la scène nocturne...' },
  { en: '{name} is convincing a cloud to pose nicely...', de: '{name} überredet eine Wolke, schön zu posieren...', fr: '{name} convainc un nuage de poser joliment...' },
  { en: '{name} is checking that all the leaves are the right green...', de: '{name} prüft, ob alle Blätter im richtigen Grün leuchten...', fr: '{name} vérifie que toutes les feuilles ont le bon vert...' },
  { en: 'A page is being rewritten because it wasn\'t magical enough...', de: 'Eine Seite wird neu geschrieben — sie war nicht magisch genug...', fr: 'Une page est réécrite — elle n\'était pas assez magique...' },
  { en: '{name} is rehearsing the very last sentence...', de: '{name} probt den allerletzten Satz...', fr: '{name} répète la toute dernière phrase...' },
  { en: 'The story wizard is brewing one last bit of imagination...', de: 'Der Geschichtenzauberer braut die letzte Portion Fantasie...', fr: 'Le magicien brasse une dernière dose d\'imagination...' },
  { en: '{name} is asking a star for an extra wish...', de: '{name} bittet einen Stern um einen weiteren Wunsch...', fr: '{name} demande à une étoile un voeu de plus...' },
];

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
  // Smoothed bar value — guarantees forward motion during the long pre-job wait
  // when server-side `progress` sits at 0 for ~60s before the story job emits
  // its first event. Never exceeds the actual server progress when the server
  // overtakes the curve, and never decreases.
  const [displayProgress, setDisplayProgress] = useState(0);
  const generationStartRef = useRef<number | null>(null);
  // Only restore jobId from localStorage if we're recovering from a redirect (no location.state)
  const [jobId, setJobId] = useState<string | null>(
    locationState ? null : storage.getItem('trial_gen_job_id')
  );
  const hasStartedRef = useRef(false);
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollStartRef = useRef<number>(0);

  // Title page image — always arrives via polling from the story generation pipeline
  const [titlePageImage, setTitlePageImage] = useState<string | null>(null);


  // Slideshow of page images as they arrive during generation
  const [pageImages, setPageImages] = useState<Array<{ pageNumber: number; imageData: string }>>([]);
  const [avatarSlides, setAvatarSlides] = useState<string[]>(state?.titlePageData?.avatarSlides || []);
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

      // Pick up title page image and avatar slides from poll response
      if (data.titlePageImage) {
        setTitlePageImage(data.titlePageImage);
        needTitlePageRef.current = false;

        if (data.avatarSlides?.length) setAvatarSlides(data.avatarSlides);
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
  const needTitlePageRef = useRef(true);

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

  // ── Fire 'Trial story completed' Google Ads conversion ─────────────────────
  // Two state transitions land us in 'completed' (line ~348 + the polling
  // handler ~401), and the dedicated useEffect below redirects shortly
  // after. To keep the fire-event in one place and dedupe across the two
  // entry points (plus React StrictMode double-render in dev), gate it on a
  // ref so the same mount can only fire once. Counting type on the Ads side
  // is ONE_PER_CLICK, which would dedupe a re-fire too, but firing once is
  // cleaner.
  const storyCompletionFiredRef = useRef(false);
  useEffect(() => {
    if (pageState === 'completed' && !storyCompletionFiredRef.current) {
      storyCompletionFiredRef.current = true;
      trackTrialStoryCompleted();
    }
  }, [pageState]);

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
      trackEmailLead();
    } catch {
      setAuthError(t.error);
    } finally {
      setIsAuthLoading(false);
    }
  };

  // ── Google linking ─────────────────────────────────────────────────────────

  // Complete Google linking — server upgrades the trial account to a full account
  const completeGoogleLink = async (idToken: string) => {
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

  // (Google Identity Services uses an in-page popup — no redirect flow to handle.)

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
      const { idToken } = await signInWithGooglePopup();
      await completeGoogleLink(idToken);
    } catch (err) {
      console.error('Google sign-in failed:', err);
      setAuthError(t.error);
    } finally {
      setIsAuthLoading(false);
    }
  };

  // Every slide is image + caption together. Image fills the top of the slot
  // (stable, fixed-aspect frame). Caption sits below. Captions rotate
  // through 3 kinds: info messages, funny one-liners, and no caption when a
  // real story image arrives (the image speaks for itself).
  //
  // Initial sequence (before any story images):
  //   1. avatar A + "trial intro" message
  //   2. avatar B + funny
  //   3. avatar C + funny
  //   4. avatar D + "email/credits" message
  //   5. avatar E + funny
  //   6. avatar F + funny
  // Then title + page images take over as they arrive, each paired with a
  // funny line. Once we run out of avatars (small pool early), we recycle.
  type SlideCaption =
    | { kind: 'message'; text: string; tone: 'info' }
    | { kind: 'funny';   text: string }
    | { kind: 'none' };
  type Slide = { imageSrc: string; emphasis: 'avatar' | 'title' | 'page'; label: string; caption: SlideCaption };

  const slideshowItems = useMemo<Slide[]>(() => {
    const items: Slide[] = [];
    const lang = (state?.storyInput?.language || 'de').split('-')[0] as 'en' | 'de' | 'fr';
    const characterName = state?.characterName || 'Your hero';

    // Once any real story image has arrived (cover OR a story page), the
    // rotation shifts entirely to those — they're what the user actually
    // wants to see. Intro slides (avatar + tip / funny) are only for the
    // pre-content wait. This also prevents the rotation from wrapping back
    // through "Lukas is choosing the perfect outfit..." messages after the
    // cover is already on screen.
    const hasStoryContent = !!titlePageImage || pageImages.length > 0;
    if (hasStoryContent) {
      if (titlePageImage) {
        items.push({ imageSrc: titlePageImage, emphasis: 'title', label: 'Cover', caption: { kind: 'none' } });
      }
      for (let i = 0; i < pageImages.length; i++) {
        const img = pageImages[i];
        items.push({
          imageSrc: img.imageData,
          emphasis: 'page',
          label: `Page ${img.pageNumber}`,
          caption: { kind: 'none' },
        });
      }
      return items;
    }

    // Intro phase — no story images yet. Rotate avatar + benefits/funny
    // captions while the pipeline warms up.
    const avatarPool: { src: string; label: string }[] = [];
    if (state?.previewAvatar) avatarPool.push({ src: state.previewAvatar, label: characterName });
    for (let i = 0; i < avatarSlides.length; i++) {
      avatarPool.push({ src: avatarSlides[i], label: `${characterName} - Style ${i + 1}` });
    }
    const pickAvatar = (i: number) => avatarPool.length > 0 ? avatarPool[i % avatarPool.length] : null;
    // Pick funny captions WITHOUT repeating until the whole pool is exhausted.
    // shuffleDeck draws once per intro build so the deck is stable across
    // re-renders within the same intro phase.
    const shuffledFunny = (() => {
      const idx = funnyMessages.map((_, i) => i);
      for (let i = idx.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [idx[i], idx[j]] = [idx[j], idx[i]];
      }
      return idx;
    })();
    const funnyAt = (slot: number) => {
      const msg = funnyMessages[shuffledFunny[slot % shuffledFunny.length]];
      const tmpl = msg[lang] || msg.en;
      return tmpl.replace('{name}', characterName);
    };

    const trialIntro = (t as { rotationTrialIntro?: string }).rotationTrialIntro || '';
    const emailHint  = (t as { rotationEmailHint?: string  }).rotationEmailHint  || '';

    const introSpecs: SlideCaption[] = [
      { kind: 'message', text: trialIntro, tone: 'info' },
      { kind: 'funny', text: funnyAt(0) },
      { kind: 'funny', text: funnyAt(1) },
      { kind: 'message', text: emailHint, tone: 'info' },
      { kind: 'funny', text: funnyAt(2) },
      { kind: 'funny', text: funnyAt(3) },
    ];
    for (let i = 0; i < introSpecs.length; i++) {
      const a = pickAvatar(i);
      if (!a) break;
      items.push({ imageSrc: a.src, emphasis: 'avatar', label: a.label, caption: introSpecs[i] });
    }
    return items;
  // funnyMessages is a module-scope const (declared above the component); safe to omit from deps
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.previewAvatar, state?.characterName, state?.storyInput?.language, avatarSlides, titlePageImage, pageImages, t]);

  // Rotate slideshow — info messages stay up longer so they're readable;
  // funny + image-only slides tick faster. The interval re-fires on every
  // slide change because the next slide's caption type drives the next dwell.
  useEffect(() => {
    if (slideshowItems.length === 0) return;
    const currentSlide = slideshowItems[slideshowIndex % slideshowItems.length];
    // Dwell rules:
    //   - info messages (trial intro / email hint):   9s — readable, longer
    //   - title + page images (caption: 'none'):     10s — the real content
    //   - avatar + funny line:                        6s — light rotation
    let dwellMs = 6000;
    if (currentSlide.caption.kind === 'message') dwellMs = 9000;
    else if (currentSlide.caption.kind === 'none') dwellMs = 10000;
    const id = setTimeout(() => {
      setSlideshowIndex(prev => (prev + 1) % Math.max(1, slideshowItems.length));
    }, dwellMs);
    return () => clearTimeout(id);
  }, [slideshowIndex, slideshowItems]);

  // Smoothed-progress driver. Floors the visible bar with a time-based optimistic
  // curve so the user sees forward motion immediately, even when the server
  // hasn't emitted anything yet. Curve: 70 * (1 - e^(-t/60)) — reaches ~38% at
  // 30s, ~57% at 60s, asymptotes near 70%. Real server progress overtakes once
  // page-image events start.
  useEffect(() => {
    if (pageState !== 'starting' && pageState !== 'generating') return;
    if (generationStartRef.current === null) generationStartRef.current = Date.now();
    const tick = () => {
      const elapsedS = (Date.now() - (generationStartRef.current || Date.now())) / 1000;
      const optimistic = 70 * (1 - Math.exp(-elapsedS / 60));
      setDisplayProgress(prev => Math.max(prev, progress, optimistic));
    };
    tick();
    const id = setInterval(tick, 500);
    return () => clearInterval(id);
  }, [pageState, progress]);

  useEffect(() => {
    if (pageState === 'completed') setDisplayProgress(100);
  }, [pageState]);

  // Scroll to top on mount (mobile)
  useEffect(() => {
    window.scrollTo(0, 0);
  }, []);

  // Scroll to top whenever the rotation crosses from intro slides into
  // story content. The user may have scrolled down to read the upsell
  // panel below; when the title page first arrives we want them looking
  // at THE TITLE, not at the email-claim form.
  const hasStoryContent = !!titlePageImage || pageImages.length > 0;
  const prevHadStoryContent = useRef(false);
  useEffect(() => {
    if (hasStoryContent && !prevHadStoryContent.current) {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
    prevHadStoryContent.current = hasStoryContent;
  }, [hasStoryContent]);

  // Don't render if no state (will redirect)
  if (!state?.sessionToken) return null;

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-gray-50 overflow-x-hidden">
      {/* Navigation bar — sticky during trial generation so the user can
          always see where they are even after scrolling down to read the
          benefits / funny messages further down the page. */}
      <nav className="bg-black text-white px-3 py-3 sticky top-0 z-50 shadow-md">
        <div className="flex justify-between items-center">
          <span className="text-sm md:text-base font-bold whitespace-nowrap flex items-center gap-1.5">
            <img src="/images/logo-book.webp" alt="" width="88" height="88" fetchPriority="high" className="h-10 md:h-11 -my-2 w-auto" />
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
                <span className="text-xs text-gray-400 ml-auto">{Math.round(displayProgress)}%</span>
              </div>
            )}
            {(pageState === 'starting' || pageState === 'generating') && (
              <div className="w-full bg-gray-200 rounded-full h-1.5 overflow-hidden mb-2">
                <div
                  className="bg-indigo-500 h-1.5 rounded-full transition-all duration-500 ease-out"
                  style={{ width: `${Math.max(displayProgress, 3)}%` }}
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

          {/* ── Rotating slot — image + caption together. Fixed-aspect image
                area on top, fixed-min-height caption area below. Both kinds
                of caption (info messages + funny lines) use the same
                indigo brand colours so the page doesn't change palette
                between slides. */}
          {pageState !== 'failed' && (
            <div className="flex flex-col items-center mb-4">
              {slideshowItems.length > 0 ? (() => {
                const item = slideshowItems[slideshowIndex % slideshowItems.length];
                const isAvatarLike = item.emphasis === 'avatar';
                return (
                  <>
                    {/* Image area — fixed aspect-square frame keeps the slot
                        stable when avatars/title/pages of different aspect
                        ratios rotate through. object-contain prevents
                        cropping; items-start TOP-ALIGNS so portrait
                        images (avatar 9:16 with face at top, title 3:4
                        with title text at top) don't get their top half
                        pushed off-screen by vertical centering. */}
                    <div
                      className={`relative w-full ${isAvatarLike ? 'max-w-xs' : 'max-w-sm'} aspect-square flex items-start justify-center rounded-xl overflow-hidden bg-indigo-50 ${isAvatarLike ? 'border-4 border-indigo-100' : 'shadow-lg'} transition-opacity duration-300`}
                    >
                      <img
                        src={item.imageSrc}
                        alt={item.label}
                        className="max-w-full max-h-full object-contain"
                      />
                    </div>

                    {/* Caption area — fixed min-height so the rest of the
                        page doesn't bounce when a one-line funny is replaced
                        by a multi-line info message, or by no caption at all
                        once real story images take over. */}
                    {pageState !== 'completed' && (
                      <div className="mt-3 min-h-[80px] w-full max-w-md flex items-center justify-center px-3 transition-opacity duration-300">
                        {item.caption.kind === 'message' && (
                          <p className="text-sm text-indigo-700 font-medium text-center leading-relaxed">
                            {item.caption.text}
                          </p>
                        )}
                        {item.caption.kind === 'funny' && (
                          <p className="text-sm text-indigo-600 font-medium text-center italic">
                            {item.caption.text}
                          </p>
                        )}
                        {/* caption.kind === 'none' renders the empty
                            min-height block — keeps the layout stable. */}
                      </div>
                    )}
                  </>
                );
              })() : (
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
                  <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-4 mb-3 text-left">
                    <p className="text-amber-800 text-sm font-bold mb-2">{t.creditsReceived}</p>
                    <ul className="text-amber-700 text-sm space-y-1.5">
                      {t.upsellFeatures.map((f, i) => <li key={i} className="flex items-center gap-2"><span className="text-amber-500 font-bold">&#x2022;</span> {f}</li>)}
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

                  {/* Upsell — account benefits */}
                  <div className="mt-5 bg-indigo-50 rounded-xl p-4 border border-indigo-100 text-left">
                    <p className="text-sm font-bold text-indigo-700 mb-2">{t.upsellTitle}</p>
                    <ul className="text-sm text-gray-700 space-y-1.5">
                      {t.upsellFeatures.map((f, i) => (
                        <li key={i} className="flex items-center gap-2">
                          <span className="text-indigo-500 font-bold text-base">+</span> {f}
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
