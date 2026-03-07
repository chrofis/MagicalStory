import { useState, useMemo, useCallback } from 'react';
import { useLanguage } from '@/context/LanguageContext';
import { Navigation } from '@/components/common';
import TrialCharacterStep from './trial/TrialCharacterStep';
import TrialTopicStep from './trial/TrialTopicStep';
import TrialIdeasStep from './trial/TrialIdeasStep';
import TrialAuthModal from './trial/TrialAuthModal';

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
  fr: { character: 'Personnage', topic: 'Sujet', ideas: 'Idees' },
};


// ─── Component ───────────────────────────────────────────────────────────────

export default function TrialWizard() {
  const { language } = useLanguage();

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

  // Ideas state
  const [generatedIdeas, setGeneratedIdeas] = useState<GeneratedIdea[]>([]);
  const [selectedIdeaIndex, setSelectedIdeaIndex] = useState<number | null>(null);

  // Auth modal (triggered from ideas step)
  const [showEmailModal, setShowEmailModal] = useState(false);

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
    if (selectedIdeaIndex === null) return;
    // Store the selected idea in storyDetails for downstream use
    const selectedIdea = generatedIdeas[selectedIdeaIndex];
    if (selectedIdea) {
      setStoryInput(prev => ({
        ...prev,
        storyDetails: selectedIdea.title + '\n' + selectedIdea.summary,
      }));
    }
    setShowEmailModal(true);
  }, [selectedIdeaIndex, generatedIdeas]);

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

      {/* Auth modal */}
      {showEmailModal && (
        <TrialAuthModal
          characterData={characterData}
          storyInput={storyInput}
          onClose={() => setShowEmailModal(false)}
        />
      )}
    </div>
  );
}
