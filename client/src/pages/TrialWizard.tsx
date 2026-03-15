import { useState, useMemo, useCallback, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { BookOpen } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import { Navigation } from '@/components/common';
import TrialCharacterStep from './trial/TrialCharacterStep';
import TrialTopicStep from './trial/TrialTopicStep';
import TrialIdeasStep from './trial/TrialIdeasStep';

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
};

const trialUsedStrings: Record<string, { title: string; desc: string; signUp: string; checkInbox: string }> = {
  en: {
    title: 'You already created your free story!',
    desc: 'Sign up for a full account to create more stories with multiple characters, longer plots, and printed books.',
    signUp: 'Sign up now',
    checkInbox: 'Already signed up? Check your inbox for the verification link.',
  },
  de: {
    title: 'Du hast bereits deine kostenlose Geschichte erstellt!',
    desc: 'Erstelle ein Konto, um weitere Geschichten mit mehreren Figuren, längeren Handlungen und gedruckten Büchern zu erstellen.',
    signUp: 'Jetzt registrieren',
    checkInbox: 'Bereits registriert? Prüfe deinen Posteingang für den Bestätigungslink.',
  },
  fr: {
    title: 'Vous avez déjà créé votre histoire gratuite !',
    desc: 'Créez un compte pour créer plus d\'histoires avec plusieurs personnages, des intrigues plus longues et des livres imprimés.',
    signUp: 'S\'inscrire maintenant',
    checkInbox: 'Déjà inscrit ? Vérifiez votre boîte de réception pour le lien de vérification.',
  },
};


// ─── Component ───────────────────────────────────────────────────────────────

export default function TrialWizard() {
  const { language } = useLanguage();
  const navigate = useNavigate();

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

  // Map UI language to story language (de → de-ch for Swiss German)
  const storyLanguage = language === 'de' ? 'de-ch' : language === 'fr' ? 'fr' : 'en';

  // Story input state
  const [storyInput, setStoryInput] = useState<StoryInput>({
    storyCategory: '',
    storyTopic: '',
    storyTheme: '',
    storyDetails: '',
    language: storyLanguage,
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

  // Pre-generated title page (generated during step 3 in background)
  const [titlePageData, setTitlePageData] = useState<{
    titlePageImage: string | null;
    title: string | null;
    costumeType: string | null;
  } | null>(null);

  // User location (IP-based, for landmark personalization)
  const [userLocation, setUserLocation] = useState<{ city: string | null; region: string | null; country: string | null } | null>(null);

  useEffect(() => {
    const apiUrl = import.meta.env.VITE_API_URL || '';
    fetch(`${apiUrl}/api/user/location`).then(r => r.json()).then(setUserLocation).catch(() => {});
  }, []);

  // Anonymous session state
  const [sessionToken, setSessionToken] = useState<string | null>(() =>
    localStorage.getItem('trial_session_token')
  );
  const [characterId, setCharacterId] = useState<string | null>(null);
  const [trialUsed, setTrialUsed] = useState(false);

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
        if (data?.trialUsed) setTrialUsed(true);
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
    if (nextIndex < STEPS.length) {
      setCurrentStep(STEPS[nextIndex]);
    }
  };

  const goBack = () => {
    const prevIndex = currentStepIndex - 1;
    if (prevIndex >= 0) {
      setCurrentStep(STEPS[prevIndex]);
    }
  };

  const handleIdeasGenerated = useCallback((ideas: GeneratedIdea[]) => {
    setGeneratedIdeas(ideas);
    setSelectedIdeaIndex(null);
  }, []);

  const handleCreate = useCallback(() => {
    if (selectedIdeaIndex === null || !sessionToken) return;
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

  // ─── Trial already used ─────────────────────────────────────────────────────

  const tu = trialUsedStrings[language] || trialUsedStrings.en;

  if (trialUsed) {
    return (
      <div className="min-h-screen bg-gray-50">
        <nav className="bg-black text-white px-3 py-3">
          <div className="flex justify-between items-center">
            <Link to="/" className="text-sm md:text-base font-bold whitespace-nowrap hover:opacity-80 flex items-center gap-1.5">
              <img src="/images/logo-book.png" alt="" className="h-10 md:h-11 -my-2 w-auto" />
              Magical Story
            </Link>
          </div>
        </nav>
        <div className="px-3 md:px-8 py-4 md:py-8">
          <div className="max-w-md mx-auto bg-white rounded-2xl shadow-xl p-8 text-center">
            <div className="w-16 h-16 bg-indigo-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <BookOpen className="w-8 h-8 text-indigo-600" />
            </div>
            <h1 className="text-xl font-bold text-gray-800 mb-2">{tu.title}</h1>
            <p className="text-gray-600 text-sm mb-6">{tu.desc}</p>
            <Link
              to="/?signup=true"
              className="inline-block w-full bg-indigo-600 text-white py-3 rounded-lg font-semibold hover:bg-indigo-700 transition-colors"
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
