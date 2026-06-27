import { useState, useMemo, useCallback, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { BookOpen, ArrowRight } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import { useAuth } from '@/context/AuthContext';
import { Navigation } from '@/components/common';
import TrialCharacterStep from './trial/TrialCharacterStep';
import TrialTopicStep from './trial/TrialTopicStep';
import TrialIdeasStep from './trial/TrialIdeasStep';
import { trackTrialPageVisit } from '@/utils/gtagConversion';
import { trackEvent } from '@/utils/analytics';

// ─── Types ───────────────────────────────────────────────────────────────────

type TrialStep = 'character' | 'topic' | 'ideas';

export interface CharacterData {
  name: string;
  age: string;
  gender: string;
  traits: string[];
  customTraits: string;
  consentGiven?: boolean;
  photos: {
    original?: string;
    face?: string;
    body?: string;
    bodyNoBg?: string;
    faceBox?: any;
  };
}

export interface StoryInput {
  storyCategory: string;
  storyTopic: string;
  storyTheme: string;
  storyDetails: string;
  language: string;
}

export interface GeneratedIdea {
  title: string;
  summary: string;
  themes: string[];
}

// ─── Step progress config ────────────────────────────────────────────────────

const STEPS: TrialStep[] = ['character', 'topic', 'ideas'];

const stepLabels: Record<string, Record<TrialStep, string>> = {
  en: { character: 'Character', topic: 'Topic', ideas: 'Ideas' },
  de: { character: 'Figur', topic: 'Thema', ideas: 'Ideen' },
  fr: { character: 'Personnage', topic: 'Sujet', ideas: 'Idées' },
  it: { character: 'Personaggio', topic: 'Argomento', ideas: 'Idee' },
};

const trialUsedStrings: Record<string, { title: string; desc: string; signUp: string; checkInbox: string; viewStory: string }> = {
  en: {
    title: 'You already created your free story!',
    desc: 'Sign up for a full account to create more stories with multiple characters, longer plots, and printed books.',
    signUp: 'Sign up now',
    checkInbox: 'Already signed up? Check your inbox for the verification link.',
    viewStory: 'View your story',
  },
  de: {
    title: 'Du hast bereits deine kostenlose Geschichte erstellt!',
    desc: 'Erstelle ein Konto, um weitere Geschichten mit mehreren Figuren, längeren Handlungen und gedruckten Büchern zu erstellen.',
    signUp: 'Jetzt registrieren',
    checkInbox: 'Bereits registriert? Prüfe deinen Posteingang für den Bestätigungslink.',
    viewStory: 'Deine Geschichte ansehen',
  },
  fr: {
    title: 'Vous avez déjà créé votre histoire gratuite !',
    desc: 'Créez un compte pour créer plus d\'histoires avec plusieurs personnages, des intrigues plus longues et des livres imprimés.',
    signUp: 'S\'inscrire maintenant',
    checkInbox: 'Déjà inscrit ? Vérifiez votre boîte de réception pour le lien de vérification.',
    viewStory: 'Voir votre histoire',
  },
  it: {
    title: 'Hai già creato la tua storia gratuita!',
    desc: 'Registrati per un account completo e crea altre storie con più personaggi, trame più lunghe e libri stampati.',
    signUp: 'Registrati ora',
    checkInbox: 'Già registrato? Controlla la tua casella di posta per il link di verifica.',
    viewStory: 'Vedi la tua storia',
  },
};

// One-off intro screen shown to fresh visitors of /try. After they click
// "Let's start" the wizard takes over (Character → Topic → Ideas).
// No progress bar here — it's pre-wizard. State lives in TrialWizard
// (showIntro) and is not persisted; reloading the page shows it again.
const introStrings: Record<string, {
  title: string;
  subtitle: string;
  step1Title: string; step1Desc: string;
  step2Title: string; step2Desc: string;
  step3Title: string; step3Desc: string;
  freeNote: string;
  cta: string;
}> = {
  en: {
    title: 'Create your free story',
    subtitle: 'A personalized children\'s book with your child as the main character — ready in 3 minutes.',
    step1Title: 'Upload a photo',
    step1Desc: 'One photo of your child — and their name.',
    step2Title: 'Pick a topic',
    step2Desc: 'A fun adventure, or a story that gently teaches something.',
    step3Title: 'Sit back',
    step3Desc: 'Ready in ~3 minutes. You\'ll receive it as a PDF by email.',
    freeNote: 'This first story is a quick free trial — ready in ~3 minutes. Sign up for full, high-quality stories (a bit slower to create) — your first one is free.',
    cta: 'Let\'s start',
  },
  de: {
    title: 'Erstelle deine Gratis-Geschichte',
    subtitle: 'Eine personalisierte Kinderbuch-Geschichte mit deinem Kind als Hauptfigur — in 3 Minuten.',
    step1Title: 'Foto hochladen',
    step1Desc: 'Ein Foto deines Kindes — und seinen Namen.',
    step2Title: 'Geschichte wählen',
    step2Desc: 'Ein Abenteuer oder eine Geschichte, die spielerisch etwas vermittelt.',
    step3Title: 'Lehn dich zurück',
    step3Desc: 'In ~3 Minuten fertig. Du erhältst sie als PDF per E-Mail.',
    freeNote: 'Diese erste Geschichte ist eine schnelle Gratis-Probe — in ~3 Minuten fertig. Melde dich an für vollständige Geschichten in hoher Qualität (etwas langsamer) — die erste ist gratis.',
    cta: 'Los geht\'s',
  },
  fr: {
    title: 'Créez votre histoire gratuite',
    subtitle: 'Un livre pour enfants personnalisé avec votre enfant comme héros — prêt en 3 minutes.',
    step1Title: 'Téléchargez une photo',
    step1Desc: 'Une photo de votre enfant — et son prénom.',
    step2Title: 'Choisir un thème',
    step2Desc: 'Une aventure, ou une histoire qui transmet un message en douceur.',
    step3Title: 'Détendez-vous',
    step3Desc: 'Prête en ~3 minutes. Vous la recevrez en PDF par e-mail.',
    freeNote: 'Cette première histoire est un essai gratuit rapide — prête en ~3 minutes. Inscrivez-vous pour des histoires complètes de haute qualité (un peu plus longues à créer) — la première est offerte.',
    cta: 'C\'est parti',
  },
  it: {
    title: 'Crea la tua storia gratuita',
    subtitle: 'Un libro per bambini personalizzato con tuo figlio come protagonista — pronto in 3 minuti.',
    step1Title: 'Carica una foto',
    step1Desc: 'Una foto di tuo figlio — e il suo nome.',
    step2Title: 'Scegli un tema',
    step2Desc: 'Un\'avventura, o una storia che insegna qualcosa con dolcezza.',
    step3Title: 'Rilassati',
    step3Desc: 'Pronta in ~3 minuti. La riceverai in PDF via e-mail.',
    freeNote: 'Questa prima storia è una prova gratuita veloce — pronta in ~3 minuti. Registrati per storie complete di alta qualità (un po\' più lente) — la prima è gratis.',
    cta: 'Iniziamo',
  },
};

const loggedInStrings: Record<string, { title: string; desc: string; goToCreate: string }> = {
  en: {
    title: 'You already have an account!',
    desc: 'You\'re logged in. Create stories directly from your account — with more characters, longer stories, and printed books.',
    goToCreate: 'Create a story',
  },
  de: {
    title: 'Du hast bereits ein Konto!',
    desc: 'Du bist angemeldet. Erstelle Geschichten direkt von deinem Konto — mit mehr Figuren, längeren Geschichten und gedruckten Büchern.',
    goToCreate: 'Geschichte erstellen',
  },
  fr: {
    title: 'Vous avez déjà un compte !',
    desc: 'Vous êtes connecté. Créez des histoires directement depuis votre compte — avec plus de personnages, des histoires plus longues et des livres imprimés.',
    goToCreate: 'Créer une histoire',
  },
  it: {
    title: 'Hai già un account!',
    desc: 'Sei connesso. Crea storie direttamente dal tuo account — con più personaggi, storie più lunghe e libri stampati.',
    goToCreate: 'Crea una storia',
  },
};


// ─── Component ───────────────────────────────────────────────────────────────

export default function TrialWizard() {
  const { language } = useLanguage();
  const { user, isLoading: authLoading } = useAuth();
  const navigate = useNavigate();

  // One-off intro screen. Fresh visitors land here before the wizard
  // starts so they know what to expect (photo, topic, ~3 min wait, PDF
  // by email). Not persisted — reload shows it again. Intentional: it's
  // a tiny screen, and re-seeing it costs nothing vs the risk of
  // skipping it for a returning bouncer who never actually started.
  const [showIntro, setShowIntro] = useState(true);

  // Wizard step
  const [currentStep, setCurrentStep] = useState<TrialStep>('character');

  // Character state
  const [characterData, setCharacterData] = useState<CharacterData>({
    name: '',
    age: '',
    gender: '',
    traits: [],
    customTraits: '',
    photos: {},
  });

  // Map UI language to story language. Both de and fr upgrade to the Swiss
  // variant — that's the primary market and the Swiss typography rules in
  // server/lib/languages.js (tight «» guillemets, no space before !?:;) are
  // attached to the -ch language codes.
  const storyLanguage = language === 'de' ? 'de-ch' : language === 'fr' ? 'fr-ch' : language === 'it' ? 'it-ch' : 'en';

  // Story input state — pre-fill from URL params (from theme pages)
  const [storyInput, setStoryInput] = useState<StoryInput>(() => {
    const params = new URLSearchParams(window.location.search);
    return {
      storyCategory: params.get('category') || '',
      storyTopic: params.get('topic') || '',
      storyTheme: '',
      storyDetails: '',
      language: storyLanguage,
    };
  });

  // Sync language when UI language changes
  useEffect(() => {
    setStoryInput(prev => ({ ...prev, language: storyLanguage }));
  }, [storyLanguage]);

  // Ideas state
  const [generatedIdeas, setGeneratedIdeas] = useState<GeneratedIdea[]>([]);
  const [selectedIdeaIndex, setSelectedIdeaIndex] = useState<number | null>(null);

  // Preview avatar (generated before topic selection, used by future "Meet [Name]!" screen)
  const [previewAvatar, setPreviewAvatar] = useState<string | null>(null);

  // Title preparation data (costume type + avatar slides from prepare-title)
  const [titlePageData, setTitlePageData] = useState<{
    costumeType: string | null;
    avatarSlides?: string[];
  } | null>(null);

  // User location (IP-based, for landmark personalization)
  const [userLocation, setUserLocation] = useState<{ city: string | null; region: string | null; country: string | null; latitude?: number | null; longitude?: number | null } | null>(null);

  useEffect(() => { trackTrialPageVisit(); trackEvent('trial_landing'); }, []);

  useEffect(() => {
    const apiUrl = import.meta.env.VITE_API_URL || '';
    fetch(`${apiUrl}/api/user/location`).then(r => r.json()).then(loc => {
      setUserLocation(loc);
      // Fire-and-forget landmark discovery so the location's landmarks are indexed
      // by the time this user (or another from the same area) generates next time.
      // Doesn't block trial generation — trial uses whatever's already indexed and
      // the proximity fallback.
      if (loc?.city) {
        fetch(`${apiUrl}/api/landmarks/discover`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ city: loc.city, country: loc.country })
        }).catch(() => {});
      }
    }).catch(() => {});
  }, []);

  const isAdmin = user?.role === 'admin';

  // Anonymous session state — admins always start fresh (clear stale tokens)
  const [sessionToken, setSessionToken] = useState<string | null>(() =>
    isAdmin ? null : localStorage.getItem('trial_session_token')
  );
  const [characterId, setCharacterId] = useState<string | null>(null);
  const [trialUsed, setTrialUsed] = useState(false);
  const [trialStoryId, setTrialStoryId] = useState<string | null>(null);
  const [adminBypassToken, setAdminBypassToken] = useState<string | null>(null);

  // Fetch a short-lived bypass token for admin trial testing (not the full JWT)
  useEffect(() => {
    if (!isAdmin) return;
    const authToken = localStorage.getItem('auth_token');
    if (!authToken) return;
    fetch(`${import.meta.env.VITE_API_URL || ''}/api/trial/admin-bypass-token`, {
      headers: { Authorization: `Bearer ${authToken}` },
    }).then(r => r.json()).then(d => setAdminBypassToken(d.token)).catch(() => {});
  }, [isAdmin]);

  // Check if trial is already used on mount
  useEffect(() => {
    if (!sessionToken) return;
    const API_URL = import.meta.env.VITE_API_URL || '';
    fetch(`${API_URL}/api/trial/check-status`, {
      headers: { 'Authorization': `Bearer ${sessionToken}` },
    })
      .then(r => {
        if (!r.ok) {
          // Token expired/invalid — clear stale session so fresh account gets created
          setSessionToken(null);
          localStorage.removeItem('trial_session_token');
          return null;
        }
        return r.json();
      })
      .then(data => {
        if (data?.trialUsed) {
          setTrialUsed(true);
          if (data.storyId) setTrialStoryId(data.storyId);
        }
        // Restore characterId for returning users (session token in localStorage but no characterId in state)
        if (data?.characterId && !characterId) {
          setCharacterId(data.characterId);
        }
      })
      .catch(() => {
        // Network error — clear stale token to be safe
        setSessionToken(null);
        localStorage.removeItem('trial_session_token');
      });
  }, [sessionToken]);

  const handleAccountCreated = useCallback((token: string, charId: string) => {
    setSessionToken(token);
    setCharacterId(charId);
    localStorage.setItem('trial_session_token', token);
  }, []);

  const labels = useMemo(() => stepLabels[language] || stepLabels.en, [language]);

  const currentStepIndex = STEPS.indexOf(currentStep);

  const goNext = () => {
    const nextIndex = currentStepIndex + 1;
    // Always show topic step — user should be able to change topic and select art style
    // even when coming from theme page with pre-selected category/topic
    if (nextIndex < STEPS.length) {
      setCurrentStep(STEPS[nextIndex]);
      window.scrollTo(0, 0);
    }
  };

  const goBack = () => {
    const prevIndex = currentStepIndex - 1;
    if (prevIndex >= 0) {
      setCurrentStep(STEPS[prevIndex]);
      window.scrollTo(0, 0);
    }
  };

  const handleIdeasGenerated = useCallback((ideas: GeneratedIdea[]) => {
    setGeneratedIdeas(ideas);
    setSelectedIdeaIndex(null);
  }, []);

  const handleCreate = useCallback(() => {
    if (selectedIdeaIndex === null || !sessionToken || !characterId) return;
    const selectedIdea = generatedIdeas[selectedIdeaIndex];
    const finalStoryInput = {
      ...storyInput,
      storyDetails: selectedIdea
        ? selectedIdea.title + '\n' + selectedIdea.summary
        : storyInput.storyDetails,
      ...(userLocation?.city ? { userLocation } : {}),
    };
    navigate('/trial-generation', {
      state: {
        sessionToken,
        characterId,
        storyInput: finalStoryInput,
        characterName: characterData.name,
        previewAvatar,
        titlePageData,
      },
    });
  }, [selectedIdeaIndex, generatedIdeas, sessionToken, characterId, storyInput, characterData.name, previewAvatar, titlePageData, navigate]);

  // ─── Logged-in user redirect ────────────────────────────────────────────────

  const li = loggedInStrings[language] || loggedInStrings.en;

  if (!authLoading && user && user.role !== 'admin') {
    return (
      <div className="min-h-screen bg-gray-50">
        <nav className="bg-black text-white px-3 py-3">
          <div className="flex justify-between items-center">
            <Link to="/" className="text-sm md:text-base font-bold whitespace-nowrap hover:opacity-80 flex items-center gap-1.5">
              <img src="/images/logo-book.webp" alt="" width="88" height="88" fetchPriority="high" className="h-10 md:h-11 -my-2 w-auto" />
              Magical Story
            </Link>
          </div>
        </nav>
        <div className="px-3 md:px-8 py-4 md:py-8">
          <div className="max-w-md mx-auto bg-white rounded-2xl shadow-xl p-8 text-center">
            <div className="w-16 h-16 bg-indigo-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <BookOpen className="w-8 h-8 text-indigo-500" />
            </div>
            <h1 className="text-xl font-bold text-gray-800 mb-2">{li.title}</h1>
            <p className="text-gray-600 text-sm mb-6">{li.desc}</p>
            <button
              onClick={() => {
                const params = new URLSearchParams(window.location.search);
                const category = params.get('category');
                const topic = params.get('topic');
                const qs = category && topic ? `?category=${category}&topic=${topic}` : '';
                navigate(`/create${qs}`);
              }}
              className="w-full bg-indigo-500 text-white py-3 rounded-lg font-semibold hover:bg-indigo-600 transition-colors"
            >
              {li.goToCreate}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ─── Trial already used ─────────────────────────────────────────────────────

  const tu = trialUsedStrings[language] || trialUsedStrings.en;

  if (trialUsed && !isAdmin) {
    return (
      <div className="min-h-screen bg-gray-50">
        <nav className="bg-black text-white px-3 py-3">
          <div className="flex justify-between items-center">
            <Link to="/" className="text-sm md:text-base font-bold whitespace-nowrap hover:opacity-80 flex items-center gap-1.5">
              <img src="/images/logo-book.webp" alt="" width="88" height="88" fetchPriority="high" className="h-10 md:h-11 -my-2 w-auto" />
              Magical Story
            </Link>
          </div>
        </nav>
        <div className="px-3 md:px-8 py-4 md:py-8">
          <div className="max-w-md mx-auto bg-white rounded-2xl shadow-xl p-8 text-center">
            <div className="w-16 h-16 bg-indigo-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <BookOpen className="w-8 h-8 text-indigo-500" />
            </div>
            <h1 className="text-xl font-bold text-gray-800 mb-2">{tu.title}</h1>
            <p className="text-gray-600 text-sm mb-6">{tu.desc}</p>
            {trialStoryId && (
              <button
                onClick={() => navigate('/trial-generation', {
                  state: { sessionToken, characterId: '', storyInput: {}, characterName: '' }
                })}
                className="w-full bg-indigo-500 text-white py-3 rounded-lg font-semibold hover:bg-indigo-600 transition-colors mb-3"
              >
                {tu.viewStory}
              </button>
            )}
            <Link
              to="/?signup=true"
              className={`inline-block w-full ${trialStoryId ? 'bg-white text-indigo-500 border border-indigo-200 hover:bg-indigo-50' : 'bg-indigo-500 text-white hover:bg-indigo-600'} py-3 rounded-lg font-semibold transition-colors`}
            >
              {tu.signUp}
            </Link>
            <p className="text-xs text-gray-400 mt-4">{tu.checkInbox}</p>
          </div>
        </div>
      </div>
    );
  }

  // ─── Render ──────────────────────────────────────────────────────────────────

  // Intro screen — pre-wizard. Single CTA flips showIntro=false and the
  // wizard takes over. No progress bar shown (the wizard hasn't started).
  const intro = introStrings[language] || introStrings.en;
  if (showIntro) {
    return (
      <div className="min-h-screen bg-gray-50">
        <nav className="bg-black text-white px-3 py-3">
          <div className="flex justify-between items-center">
            <Link to="/" className="text-sm md:text-base font-bold whitespace-nowrap hover:opacity-80 flex items-center gap-1.5">
              <img src="/images/logo-book.webp" alt="" width="88" height="88" fetchPriority="high" className="h-10 md:h-11 -my-2 w-auto" />
              Magical Story
            </Link>
          </div>
        </nav>
        <div className="px-4 md:px-8 py-6 max-w-7xl mx-auto">
          {/* Hero */}
          <div className="text-center mb-6">
            <h1 className="text-3xl md:text-4xl font-bold text-gray-800 mb-2">{intro.title}</h1>
            <p className="text-lg text-gray-600">{intro.subtitle}</p>
          </div>

          {/* MOBILE — each step stacked: image then its caption (1, 2). The
              desktop bookend below doesn't stack cleanly, so phones get this
              simple vertical version instead. */}
          <div className="md:hidden space-y-8 mb-8">
            {([
              { n: 1, img: '/images/try/step1-photo.webp', title: intro.step1Title, desc: intro.step1Desc },
              { n: 2, img: '/images/try/step2-topics.webp', title: intro.step2Title, desc: intro.step2Desc },
            ] as const).map((s) => (
              <div key={s.n} className="text-center">
                <img src={s.img} alt="" loading="lazy" decoding="async"
                  className="max-h-72 w-auto mx-auto object-contain rounded-2xl shadow-sm mb-3" />
                <h2 className="text-2xl font-bold text-gray-800 mb-1"><span className="text-indigo-500">{s.n}.</span> {s.title}</h2>
                <p className="text-gray-600 text-base max-w-xs mx-auto">{s.desc}</p>
              </div>
            ))}
          </div>

          {/* DESKTOP — the two tall images at the SAME height, bookending the
              row; numbered captions stacked in the centre between them. */}
          <div className="hidden md:flex md:items-stretch justify-between gap-10 mb-12">
            <img
              src="/images/try/step1-photo.webp"
              alt=""
              loading="lazy"
              decoding="async"
              className="w-full md:w-auto max-h-72 md:max-h-none md:h-96 object-contain rounded-2xl shadow-sm flex-shrink-0"
            />
            <div className="flex-1 flex flex-col justify-between gap-8 py-2">
              <div className="self-start max-w-[14rem] text-left">
                <h2 className="text-2xl md:text-3xl font-bold text-gray-800 mb-1"><span className="text-indigo-500">1.</span> {intro.step1Title}</h2>
                <p className="text-gray-600 text-base md:text-lg">{intro.step1Desc}</p>
              </div>
              <div className="self-end max-w-[14rem] text-right">
                <h2 className="text-2xl md:text-3xl font-bold text-gray-800 mb-1"><span className="text-indigo-500">2.</span> {intro.step2Title}</h2>
                <p className="text-gray-600 text-base md:text-lg">{intro.step2Desc}</p>
              </div>
            </div>
            <img
              src="/images/try/step2-topics.webp"
              alt=""
              loading="lazy"
              decoding="async"
              className="w-full md:w-auto max-h-72 md:max-h-none md:h-96 object-contain rounded-2xl shadow-sm flex-shrink-0"
            />
          </div>

          {/* Closing — the finished spread on the left; on the right the
              "sit back" message plus the free-trial note and the Start button.
              No step number here: this is the payoff + call to action. */}
          <div className="flex flex-col md:flex-row items-center gap-6 md:gap-12">
            <img
              src="/images/try/step3-spread.webp"
              alt=""
              loading="lazy"
              decoding="async"
              className="w-full md:w-auto md:max-w-[55%] max-h-96 object-contain rounded-2xl shadow-sm flex-shrink-0"
            />
            <div className="md:flex-1 text-center md:text-left">
              <h2 className="text-2xl md:text-3xl font-bold text-gray-800 mb-2">{intro.step3Title}</h2>
              <p className="text-gray-600 text-base md:text-lg mb-4">{intro.step3Desc}</p>
              <button
                onClick={() => setShowIntro(false)}
                className="inline-flex items-center gap-2 px-8 py-3 bg-indigo-500 text-white rounded-lg font-semibold text-lg hover:bg-indigo-600 transition-colors mb-4"
              >
                {intro.cta}
                <ArrowRight size={20} />
              </button>
              <p className="text-sm text-gray-500 max-w-md">{intro.freeNote}</p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Navigation bar with step indicators matching the main wizard */}
      <Navigation
        currentStep={currentStepIndex + 1}
        onStepClick={(s) => setCurrentStep(STEPS[s - 1])}
        customSteps={STEPS.map(step => ({ key: step, label: labels[step] }))}
      />

      {/* Main content */}
      <div className="px-3 md:px-8 py-4 md:py-8">
        <div className="md:bg-white md:rounded-2xl md:shadow-xl md:p-8">
          {/* Step content */}
          <div className="max-w-4xl mx-auto pb-12">
            {currentStep === 'character' && (
              <TrialCharacterStep
                characterData={characterData}
                onChange={setCharacterData}
                onNext={goNext}
                previewAvatar={previewAvatar}
                onAvatarGenerated={setPreviewAvatar}
                onAccountCreated={handleAccountCreated}
                sessionToken={sessionToken}
                language={language}
                adminToken={isAdmin ? adminBypassToken : null}
              />
            )}
            {currentStep === 'topic' && (
              <TrialTopicStep
                storyInput={storyInput}
                onChange={setStoryInput}
                onBack={goBack}
                onNext={goNext}
                previewAvatar={previewAvatar}
                characterName={characterData.name}
                characterGender={characterData.gender}
              />
            )}
            {currentStep === 'ideas' && (
              <TrialIdeasStep
                characterData={characterData}
                storyInput={storyInput}
                generatedIdeas={generatedIdeas}
                onIdeasGenerated={handleIdeasGenerated}
                selectedIdeaIndex={selectedIdeaIndex}
                onSelectIdea={setSelectedIdeaIndex}
                onBack={goBack}
                onCreate={handleCreate}
                sessionToken={sessionToken}
                onTitlePageReady={setTitlePageData}
                userLocation={userLocation}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
