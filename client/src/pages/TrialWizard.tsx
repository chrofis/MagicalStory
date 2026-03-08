import { useState, useMemo, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
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

  // Anonymous session state
  const [sessionToken, setSessionToken] = useState<string | null>(() =>
    localStorage.getItem('trial_session_token')
  );
  const [characterId, setCharacterId] = useState<string | null>(null);

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
    };
    navigate('/trial-generation', {
      state: {
        sessionToken,
        characterId,
        storyInput: finalStoryInput,
        characterName: characterData.name,
        previewAvatar,
      },
    });
  }, [selectedIdeaIndex, generatedIdeas, sessionToken, characterId, storyInput, characterData.name, previewAvatar, navigate]);

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
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
