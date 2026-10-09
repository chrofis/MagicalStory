import { useState, useEffect, useRef, useMemo, FormEvent, useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Loader2, CheckCircle, BookOpen, Mail, AlertTriangle } from 'lucide-react';
import { GoogleIcon } from '@/components/auth/GoogleIcon';
import { signInWithGooglePopup } from '@/services/googleAuth';
import storage from '@/services/storage';
import { useLanguage } from '@/context/LanguageContext';
import { INITIAL_USER_CREDITS } from '@/constants/credits';
import { trackEmailLead, trackTrialStoryCompleted } from '@/utils/gtagConversion';
import { trackEvent } from '@/utils/analytics';
import { trackTrialStep } from '@/utils/trialFunnel';
import { FUNNY_MESSAGES, NAMELESS_FUNNY_MESSAGES, funnyDeck, funnyLine } from '@/utils/funnyMessages';
import { classifyJobStatusHttp, MAX_TRANSIENT_POLL_ERRORS, pollBackoffMs, mergeAvatarSlides } from '@/utils/trialPoll';
import { Navigation } from '@/components/common';
import TrialBook, { TrialGateProvider } from '@/components/book/TrialBook';
import { isTrialBookReady } from '@/utils/trialBook';
import { localizedApiError } from '@/utils/apiErrors';

const API_URL = import.meta.env.VITE_API_URL || '';

// ─── Types ───────────────────────────────────────────────────────────────────

type PageState = 'starting' | 'generating' | 'completed' | 'failed';

// One page of the story preview, as job-status returns it. `text` is absent on
// a locked page: the server withholds it and sends only a `teaser`.
interface PreviewPage {
  pageNumber: number;
  imageData?: string;
  text?: string;
  teaser?: string;
  locked: boolean;
}

interface LocationState {
  sessionToken: string;
  characterId: string | null;
  storyInput: {
    storyCategory: string;
    storyTopic: string;
    storyTheme: string;
    storyDetails: string;
    language: string;
    ideaKind?: 'local' | 'fantasy';
    ideaPick?: { index: 0 | 1; attempt: number; offered: { title: string; summary: string }[] };
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
    emailSentDesc: 'Click the link in your email to finish setting up your account and keep your story.',
    emailSentNote: 'Didn\'t get it? Check your spam folder.',
    claimFailed: 'Your email is confirmed, but we could not sign you in automatically yet. We keep retrying. If this stays, log in with your email address.',
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
    rotationTrialIntro: 'This is a trial story — it should be ready in a few minutes. Trial stories are short. A full story takes a bit longer but gives you many more pages and richer scenes.',
    storyReadyKicker: 'Your story is ready to read',
    imagePending: 'The picture is being painted...',
    gateTitle: 'What happens next?',
    gateDesc: 'Leave your email or sign in with Google and read on right away.',
    keepStoryNote: 'Check your email to keep your story',
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
    emailSentDesc: 'Klicke auf den Link in deiner E-Mail, um dein Konto einzurichten und deine Geschichte zu behalten.',
    emailSentNote: 'Nicht erhalten? Prüfe deinen Spam-Ordner.',
    claimFailed: 'Deine E-Mail ist bestätigt, aber wir konnten dich noch nicht automatisch anmelden. Wir versuchen es weiter. Falls es so bleibt, melde dich mit deiner E-Mail-Adresse an.',
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
    rotationTrialIntro: 'Das ist eine Probegeschichte — sie sollte in ein paar Minuten fertig sein. Probegeschichten sind kurz. Eine vollständige Geschichte dauert etwas länger, hat dafür viel mehr Seiten und reichhaltigere Szenen.',
    storyReadyKicker: 'Deine Geschichte ist bereit zum Lesen',
    imagePending: 'Das Bild wird gerade gemalt...',
    gateTitle: 'Wie geht es weiter?',
    gateDesc: 'Gib deine E-Mail-Adresse an oder melde dich mit Google an und lies sofort weiter.',
    keepStoryNote: 'Prüfe deine E-Mails, um deine Geschichte zu behalten',
    rotationEmailHint: 'Gib am Ende deine E-Mail an, damit wir dir die Geschichte als PDF schicken können. Setze auch ein Passwort, dann bekommst du Gratis-Credits für eine richtige Geschichte in voller Länge.',
  },
  fr: {
    brand: 'Magical Story',
    creatingStory: 'Votre histoire est en cours de création…',
    storyComplete: 'Votre histoire est prête !',
    signInToSee: 'Connectez-vous pour lire votre histoire',
    signInDesc: 'Votre histoire sera prête dans quelques minutes. Créez un compte gratuit maintenant pour la lire dès qu\'elle est terminée !',
    googleButton: 'Continuer avec Google',
    orDivider: 'ou',
    emailLabel: 'Adresse e-mail',
    emailPlaceholder: 'vous@exemple.com',
    emailSubmit: 'Voir mon histoire',
    terms: 'En continuant, vous acceptez nos',
    termsLink: 'Conditions d\'utilisation',
    and: 'et',
    privacyLink: 'Politique de confidentialité',
    emailSent: 'Presque terminé — vérifiez vos e-mails !',
    emailSentDesc: 'Cliquez sur le lien dans votre e-mail pour finaliser votre compte et garder votre histoire.',
    emailSentNote: 'Pas reçu ? Vérifiez votre dossier spam.',
    claimFailed: 'Votre e-mail est confirmé, mais nous n\'avons pas encore pu vous connecter automatiquement. Nous réessayons. Si cela persiste, connectez-vous avec votre adresse e-mail.',
    emailSentWarning: 'Sans vérification, votre histoire sera perdue.',
    differentEmail: 'Utiliser une autre adresse',
    linkedSuccess: 'Compte lié avec succès !',
    redirecting: 'Redirection vers votre histoire…',
    error: 'Quelque chose s\'est mal passé. Veuillez réessayer.',
    failedTitle: 'Quelque chose s\'est mal passé',
    failedDesc: 'La création de l\'histoire a échoué. Veuillez réessayer.',
    tryAgain: 'Réessayer',
    accountReady: 'Compte prêt !',
    creditsReceived: `Vous avez reçu ${INITIAL_USER_CREDITS} crédits gratuits !`,
    waitingForStory: 'Votre histoire est presque terminée. Vous serez redirigé automatiquement.',
    verifiedWaiting: 'E-mail vérifié ! Votre histoire est encore en cours de création…',
    upsellTitle: 'Ceci est une histoire d\'essai. Avec un compte gratuit, vous pouvez créer des histoires complètes :',
    upsellDesc: 'Avec un compte complet, vous débloquez :',
    upsellFeatures: [
      'Plusieurs personnages dans une même histoire',
      'Des histoires plus longues',
      'Plusieurs styles de dessin',
      'Qualité d\'image supérieure et page de titre',
      'Commander en livre imprimé',
    ],
    rotationTrialIntro: 'Ceci est une histoire d\'essai — elle devrait être prête en quelques minutes. Les histoires d\'essai sont courtes. Une histoire complète prend un peu plus de temps mais offre beaucoup plus de pages et des scènes plus riches.',
    storyReadyKicker: 'Votre histoire est prête à être lue',
    imagePending: "L'illustration est en train d'être peinte…",
    gateTitle: 'Que se passe-t-il ensuite ?',
    gateDesc: 'Indiquez votre e-mail ou connectez-vous avec Google et lisez la suite tout de suite.',
    keepStoryNote: 'Vérifiez vos e-mails pour garder votre histoire',
    rotationEmailHint: 'Saisissez votre e-mail à la fin pour que nous puissions vous envoyer le PDF de l\'histoire. Définissez aussi un mot de passe et vous recevez des crédits gratuits pour une histoire complète.',
  },
  it: {
    brand: 'Magical Story',
    creatingStory: 'La tua storia sta per nascere...',
    storyComplete: 'La tua storia è pronta!',
    signInToSee: 'Accedi per leggere la tua storia',
    signInDesc: 'La tua storia sarà pronta tra pochi minuti. Crea ora un account gratuito per leggerla appena è finita!',
    googleButton: 'Continua con Google',
    orDivider: 'oppure',
    emailLabel: 'Indirizzo e-mail',
    emailPlaceholder: 'tu@esempio.com',
    emailSubmit: 'Vedi la mia storia',
    terms: 'Continuando accetti i nostri',
    termsLink: 'Termini di servizio',
    and: 'e',
    privacyLink: 'Informativa sulla privacy',
    emailSent: 'Ci siamo quasi — controlla la tua e-mail!',
    emailSentDesc: 'Clicca sul link nell\'e-mail per completare il tuo account e conservare la tua storia.',
    emailSentNote: 'Non l\'hai ricevuta? Controlla la cartella spam.',
    claimFailed: 'La tua e-mail è confermata, ma non siamo ancora riusciti ad accedere automaticamente. Continuiamo a riprovare. Se non cambia, accedi con il tuo indirizzo e-mail.',
    emailSentWarning: 'Senza conferma la tua storia andrà persa.',
    differentEmail: 'Usa un\'altra e-mail',
    linkedSuccess: 'Account collegato con successo!',
    redirecting: 'Reindirizzamento alla tua storia...',
    error: 'Qualcosa è andato storto. Riprova.',
    failedTitle: 'Qualcosa è andato storto',
    failedDesc: 'Non è stato possibile creare la storia. Riprova.',
    tryAgain: 'Riprova',
    accountReady: 'Account pronto!',
    creditsReceived: `Hai ricevuto ${INITIAL_USER_CREDITS} crediti gratuiti!`,
    waitingForStory: 'La tua storia è quasi pronta. Verrai reindirizzato automaticamente.',
    verifiedWaiting: 'E-mail confermata! La tua storia è ancora in creazione...',
    upsellTitle: 'Questa è una storia di prova. Con un account gratuito puoi creare storie complete:',
    upsellDesc: '',
    upsellFeatures: [
      'Più personaggi in una sola storia',
      'Storie più lunghe con più pagine',
      'Diversi stili di disegno',
      'Qualità delle immagini superiore e pagina del titolo',
      'Ordinala come libro stampato',
    ],
    rotationTrialIntro: 'Questa è una storia di prova — dovrebbe essere pronta in pochi minuti. Le storie di prova sono brevi. Una storia completa richiede un po\' più di tempo, ma offre molte più pagine e scene più ricche.',
    storyReadyKicker: 'La tua storia è pronta da leggere',
    imagePending: "Stiamo dipingendo l'immagine...",
    gateTitle: 'Come continua?',
    gateDesc: 'Inserisci la tua e-mail o accedi con Google e continua subito a leggere.',
    keepStoryNote: 'Controlla la tua e-mail per conservare la tua storia',
    rotationEmailHint: 'Inserisci la tua e-mail al termine, così possiamo inviarti la storia in PDF. Imposta anche una password e ricevi crediti gratuiti per una storia completa.',
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
  // Transient (5xx/429) job-status failures: bounded, with backoff (utils/trialPoll.ts)
  const pollErrorsRef = useRef(0);
  const pollNotBeforeRef = useRef(0);

  // Title page image — always arrives via polling from the story generation pipeline
  const [titlePageImage, setTitlePageImage] = useState<string | null>(null);


  // Story preview (title + pages) once the writer step has finished. The book
  // (BookViewer) replaces the avatar rotation as soon as the first picture exists
  // (title page, or any page image) — text alone keeps the rotation running.
  // See docs/decisions.md "trial shows the book in BookViewer once the first image exists".
  const [storyTitle, setStoryTitle] = useState<string | null>(null);
  const [pages, setPages] = useState<PreviewPage[]>([]);
  const storyReady = isTrialBookReady(storyTitle, pages, titlePageImage);
  // Funnel: `gate_seen` once per mount, the first time a locked page's sign-in
  // block is actually on screen (GateSlot observes it) — a visitor who never
  // reaches a locked page was not shown the gate. The server dedupes per visit.
  const gateSeenFiredRef = useRef(false);
  const onGateSeen = useCallback(() => {
    if (gateSeenFiredRef.current) return;
    gateSeenFiredRef.current = true;
    trackTrialStep('gate_seen');
  }, []);
  // `gate_unlocked` the first time job-status reports the pages unlocked.
  const gateUnlockedFiredRef = useRef(false);
  const [avatarSlides, setAvatarSlides] = useState<string[]>(state?.titlePageData?.avatarSlides || []);
  const [slideshowIndex, setSlideshowIndex] = useState(0);

  // Auth state
  const [email, setEmail] = useState('');
  const [authError, setAuthError] = useState('');
  const [isAuthLoading, setIsAuthLoading] = useState(false);
  const [emailSubmitted, setEmailSubmitted] = useState(false);
  // The server's own record (job-status `unlocked`): a contact was left, possibly
  // before a reload. `editingEmail` overrides it after "use a different email"
  // until the new address is submitted.
  const [serverUnlocked, setServerUnlocked] = useState(false);
  const [editingEmail, setEditingEmail] = useState(false);
  const [googleLinked, setGoogleLinked] = useState(false);
  const [isVerified, setIsVerified] = useState(false);
  const [claimFailed, setClaimFailed] = useState(false);

  const emailLinked = emailSubmitted || (serverUnlocked && !editingEmail && !googleLinked);
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
          // Exchange session token for a full JWT. Verified is only true once this succeeded;
          // a failed claim keeps polling (= retry) and tells the visitor.
          let claimed = false;
          try {
            const claimRes = await fetch(`${API_URL}/api/trial/claim-session`, {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${state.sessionToken}` },
            });
            if (claimRes.ok) {
              const { token } = await claimRes.json();
              storage.setItem('auth_token', token);
              storage.removeItem('trial_session_token');
              claimed = true;
            }
          } catch {
            // network error: treated like a failed claim, retried on the next tick
          }
          if (claimed) {
            clearInterval(interval);
            setClaimFailed(false);
            setIsVerified(true);
          } else {
            setClaimFailed(true);
          }
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
          if (data.code === 'TRIAL_USED' && data.jobId) {
            // The visitor already has a trial job (reload / return visit):
            // adopt it. Polling resolves the real state; never a bare form.
            setJobId(data.jobId);
            storage.setItem('trial_gen_job_id', data.jobId);
            setPageState(data.status === 'failed' ? 'failed' : data.status === 'completed' ? 'completed' : 'generating');
            if (data.status === 'completed') setProgress(100);
            return;
          }
          setPageState('failed');
          return;
        }

        setJobId(data.jobId);
        storage.setItem('trial_gen_job_id', data.jobId);
        trackTrialStep('generation_started');
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

      const outcome = classifyJobStatusHttp(response.status);
      if (outcome === 'retry') {
        pollErrorsRef.current++;
        if (pollErrorsRef.current >= MAX_TRANSIENT_POLL_ERRORS) {
          setPageState('failed');
          return true; // stop polling: the server has been failing for minutes
        }
        pollNotBeforeRef.current = Date.now() + pollBackoffMs(pollErrorsRef.current);
        return false; // keep polling, the story is still generating
      }
      if (outcome === 'failed') {
        setPageState('failed');
        return true; // definitive: session/job gone
      }
      pollErrorsRef.current = 0;
      pollNotBeforeRef.current = 0;

      const data = await response.json();

      if (data.progress !== undefined) setProgress(data.progress);

      // Avatar slides exist from job start; the title page only minutes later. They are read on
      // their own so the intro slideshow shows the turning avatars at once (until 2026-10-08 they
      // were only picked up together with the title page, so a visitor who clicked "create" before
      // prepare-title finished saw one static preview avatar for ~2.5 min).
      setAvatarSlides(prev => mergeAvatarSlides(prev, data.avatarSlides));

      if (data.titlePageImage) {
        setTitlePageImage(data.titlePageImage);
        needTitlePageRef.current = false;
      }

      setServerUnlocked(data.unlocked === true);
      if (data.unlocked === true && !gateUnlockedFiredRef.current) {
        gateUnlockedFiredRef.current = true;
        trackTrialStep('gate_unlocked');
      }

      // Story title + pages (text only where the server unlocked it)
      if (data.storyTitle && Array.isArray(data.pages) && data.pages.length > 0) {
        setStoryTitle(data.storyTitle);
        setPages(data.pages);
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
      if (Date.now() < pollNotBeforeRef.current) return; // backing off after a transient error
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
      trackEvent('trial_completed');
      trackTrialStep('generation_completed');
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
        setAuthError(localizedApiError({ code: data.code, status: response.status }, language, t.error));
        return;
      }

      setEmailSubmitted(true);
      setEditingEmail(false);
      // Unlock is decided server-side: fetch the pages again right away.
      if (jobId) void pollJobStatus(jobId, state.sessionToken, needTitlePageRef.current);
      trackEmailLead();
      trackEvent('trial_email_lead');
      // NOT account_created: POST /api/trial/link-email stores the address and a
      // verification token and leaves the user anonymous and unverified
      // (routes/trial.js). The terminal step is emitted when the verification
      // link is followed (EmailVerified.tsx); claiming it here counted every
      // address typed as a conversion.
      trackTrialStep('email_submitted');
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
      setAuthError(localizedApiError({ code: data.code, status: response.status }, language, t.error));
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
    if (jobId) void pollJobStatus(jobId, sessionToken, needTitlePageRef.current);

    // The terminal funnel step. Fired after the token swap above on purpose:
    // trackTrialStep falls back to `auth_token`, so the event is authenticated
    // either way and the server can attach the user id.
    trackTrialStep('account_created', { method: 'google' });
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
      // User closed the Google popup on purpose — not an error. Just unblock.
      if (!(err instanceof Error && err.message === 'GOOGLE_POPUP_CLOSED')) {
        console.error('Google sign-in failed:', err);
        setAuthError(t.error);
      }
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

  // Shuffled once per page view (and per pool: with or without the hero's name), see funnyDeck.
  const hasHeroName = !!state?.characterName;
  const funnyOrder = useMemo(() => funnyDeck(hasHeroName ? FUNNY_MESSAGES.length : NAMELESS_FUNNY_MESSAGES.length), [hasHeroName]);

  const slideshowItems = useMemo<Slide[]>(() => {
    const items: Slide[] = [];
    // The resume paths (the wizard's "View your story", storage recovery) carry
    // storyInput {} and no character name: the captions then follow the UI
    // language, and only the lines without a {name} slot are used — until
    // 2026-10-07 they defaulted to German and read "Your hero macht sich bereit".
    const lang = (state?.storyInput?.language || language).split('-')[0] as 'en' | 'de' | 'fr' | 'it';
    const characterName = state?.characterName || '';
    const funnyPool = characterName ? FUNNY_MESSAGES : NAMELESS_FUNNY_MESSAGES;

    // Intro phase — no story images yet. Rotate avatar + benefits/funny
    // captions while the pipeline warms up.
    const avatarPool: { src: string; label: string }[] = [];
    const heroLabel = characterName || t.brand;
    if (state?.previewAvatar) avatarPool.push({ src: state.previewAvatar, label: heroLabel });
    for (let i = 0; i < avatarSlides.length; i++) {
      avatarPool.push({ src: avatarSlides[i], label: `${heroLabel} - Style ${i + 1}` });
    }
    const pickAvatar = (i: number) => avatarPool.length > 0 ? avatarPool[i % avatarPool.length] : null;
    // The funny deck is drawn ONCE per page view (funnyOrder, a ref-backed memo): a rebuild of this list when
    // more avatar slides arrive must not reshuffle the captions already shown, or a line repeats.
    let funnySlot = 0;
    const nextFunny = () => funnyLine(funnyPool, funnyOrder, funnySlot++, lang, characterName);

    const trialIntro = (t as { rotationTrialIntro?: string }).rotationTrialIntro || '';
    const emailHint  = (t as { rotationEmailHint?: string  }).rotationEmailHint  || '';

    // One slot per funny line plus the two info captions, so the sequence runs through the WHOLE pool
    // before it can wrap (about 6 s a slot, 9 s for an info caption: 60+ lines cover a 6 minute wait).
    const slotCount = funnyPool.length + 2;
    for (let i = 0; i < slotCount; i++) {
      const a = pickAvatar(i);
      if (!a) break;
      const caption: SlideCaption =
        i === 0 ? { kind: 'message', text: trialIntro, tone: 'info' }
        : i === 3 ? { kind: 'message', text: emailHint, tone: 'info' }
        : { kind: 'funny', text: nextFunny() };
      items.push({ imageSrc: a.src, emphasis: 'avatar', label: a.label, caption });
    }
    return items;
  // funnyMessages is a module-scope const (declared above the component); safe to omit from deps
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.previewAvatar, state?.characterName, state?.storyInput?.language, language, avatarSlides, t, funnyOrder]);

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
  const prevHadStoryContent = useRef(false);
  useEffect(() => {
    if (storyReady && !prevHadStoryContent.current) {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
    prevHadStoryContent.current = storyReady;
  }, [storyReady]);

  // Don't render if no state (will redirect)
  if (!state?.sessionToken) return null;

  const signInBlock = (
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
                  <h2 className="text-lg font-bold text-gray-800 mb-1">{storyReady ? t.keepStoryNote : t.emailSent}</h2>
                  <p className="text-gray-600 text-sm mb-2">{t.emailSentDesc}</p>
                  <p className="text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-xs font-medium mb-3">{t.emailSentWarning}</p>
                  <p className="text-xs text-gray-400 mb-3">{t.emailSentNote}</p>
                  {claimFailed && (
                    <p className="text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-xs font-medium mb-3">{t.claimFailed}</p>
                  )}
                  <button
                    onClick={() => { setEmailSubmitted(false); setEditingEmail(true); setEmail(''); setAuthError(''); }}
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
                    <h2 className="text-xl font-bold text-gray-800 mb-2">{storyReady ? t.gateTitle : t.signInToSee}</h2>
                    <p className="text-gray-600 text-sm">{storyReady ? t.gateDesc : t.signInDesc}</p>
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
  );

  // Story preview: title, then the book. Text is shown by the book itself; a
  // locked page arrives with a teaser only, and the sign-in block sits under it
  // (see TrialBook). Once nothing is locked (unlocked / contact left) the same
  // block continues below the book as the success / check-your-email state.
  const hasLockedPage = pages.some(p => p.locked);
  const imagePlaceholder = (
    <div className="w-full aspect-square flex flex-col items-center justify-center gap-2 rounded-xl bg-indigo-50 text-indigo-400 text-sm">
      <Loader2 className="w-5 h-5 animate-spin" />
      {t.imagePending}
    </div>
  );
  const storyPreview = (
    <div className="mb-4">
      <div className="text-center mb-4">
        {pageState !== 'completed' && (
          <p className="text-sm text-indigo-600 font-medium mb-1">{t.storyReadyKicker}</p>
        )}
        <h1 className="text-2xl font-bold text-gray-800">{storyTitle}</h1>
      </div>
      <TrialGateProvider value={{ node: signInBlock, onSeen: hasLockedPage ? onGateSeen : undefined }}>
        <TrialBook
          storyTitle={storyTitle || ''}
          language={state?.storyInput?.language || language}
          titlePageImage={titlePageImage}
          pages={pages}
          pendingImageLabel={t.imagePending}
          titlePendingNode={imagePlaceholder}
        />
      </TrialGateProvider>
      {!hasLockedPage && isLinked && <div className="mt-4">{signInBlock}</div>}
    </div>
  );


  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-gray-50 overflow-x-clip">
      {/* Navigation bar — sticky during trial generation so the user can
          always see where they are even after scrolling down to read the
          benefits / funny messages further down the page. */}
      <Navigation minimal brandLink={false} />

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
          {storyReady && pageState !== 'failed' && storyPreview}
          {!storyReady && pageState !== 'failed' && (
            <div className="flex flex-col items-center mb-4">
              {slideshowItems.length > 0 ? (() => {
                const item = slideshowItems[slideshowIndex % slideshowItems.length];
                const isAvatarLike = item.emphasis === 'avatar';
                return (
                  <>
                    {/* Image area — a fixed frame keeps the slot stable while avatars, title and
                        pages of different aspect ratios rotate through. An avatar slide is ONE whole
                        sheet cell (a head or a body, about 1:2): a 3:4 frame shows it whole,
                        object-contain never crops it, and it is centred (the old top-aligned square
                        frame was for 1:4 strips and left a cell hugging the top-left). Title and page
                        images keep the square frame. */}
                    <div
                      className={`relative w-full ${isAvatarLike ? 'max-w-[15rem] aspect-[3/4] items-center' : 'max-w-sm aspect-square items-start'} flex justify-center rounded-xl overflow-hidden bg-indigo-50 ${isAvatarLike ? 'border-4 border-indigo-100' : 'shadow-lg'} transition-opacity duration-300`}
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
          {!storyReady && pageState !== 'failed' && <div className="h-px bg-gray-200 mb-6" />}

          {/* Sign-in section: phase 1 here; in the story preview it sits at the gate */}
          {!storyReady && pageState !== 'failed' && signInBlock}
        </div>
      </div>
    </div>
  );
}
