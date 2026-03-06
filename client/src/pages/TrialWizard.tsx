import { useState, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLanguage } from '@/context/LanguageContext';
import { BookOpen } from 'lucide-react';
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

const headerLabels: Record<string, { brand: string; login: string }> = {
  en: { brand: 'Magical Story', login: 'Log in' },
  de: { brand: 'Magical Story', login: 'Anmelden' },
  fr: { brand: 'Magical Story', login: 'Connexion' },
};

// ─── Component ───────────────────────────────────────────────────────────────

export default function TrialWizard() {
  const navigate = useNavigate();
  const { language } = useLanguage();

  // Wizard step
  const [currentStep, setCurrentStep] = useState<TrialStep>('character');

  // Character state
  const [characterData, setCharacterData] = useState<CharacterData>({
    name: '',
    age: '',
    gender: '',
    traits: [],
    photos: {},
  });

  // Story input state
  const [storyInput, setStoryInput] = useState<StoryInput>({
    storyCategory: '',
    storyTopic: '',
    storyTheme: '',
    storyDetails: '',
    language: language,
  });

  // Ideas state
  const [generatedIdeas, setGeneratedIdeas] = useState<GeneratedIdea[]>([]);
  const [selectedIdeaIndex, setSelectedIdeaIndex] = useState<number | null>(null);

  // Auth modal (triggered from ideas step)
  const [showEmailModal, setShowEmailModal] = useState(false);

  const labels = useMemo(() => stepLabels[language] || stepLabels.en, [language]);
  const header = useMemo(() => headerLabels[language] || headerLabels.en, [language]);

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
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 via-white to-purple-50">
      {/* Header */}
      <header className="bg-white/80 backdrop-blur-sm border-b border-gray-100 sticky top-0 z-30">
        <div className="max-w-4xl mx-auto px-4 py-3 flex items-center justify-between">
          <button
            onClick={() => navigate('/')}
            className="flex items-center gap-2 text-indigo-700 font-bold text-lg hover:opacity-80 transition-opacity"
          >
            <BookOpen className="w-5 h-5" />
            {header.brand}
          </button>
          <button
            onClick={() => navigate('/welcome')}
            className="text-sm text-indigo-600 hover:text-indigo-800 font-medium transition-colors"
          >
            {header.login}
          </button>
        </div>
      </header>

      {/* Progress indicator */}
      <div className="max-w-4xl mx-auto px-4 pt-6 pb-2">
        <div className="flex items-center justify-center gap-2">
          {STEPS.map((step, index) => {
            const isActive = index === currentStepIndex;
            const isCompleted = index < currentStepIndex;
            return (
              <div key={step} className="flex items-center gap-2">
                <div className="flex flex-col items-center">
                  <div
                    className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold transition-all ${
                      isActive
                        ? 'bg-indigo-600 text-white ring-2 ring-indigo-300 scale-110'
                        : isCompleted
                          ? 'bg-indigo-500 text-white'
                          : 'bg-gray-200 text-gray-400'
                    }`}
                  >
                    {isCompleted ? (
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                      </svg>
                    ) : (
                      index + 1
                    )}
                  </div>
                  <span
                    className={`text-xs mt-1 font-medium ${
                      isActive ? 'text-indigo-700' : isCompleted ? 'text-indigo-500' : 'text-gray-400'
                    }`}
                  >
                    {labels[step]}
                  </span>
                </div>
                {index < STEPS.length - 1 && (
                  <div
                    className={`w-12 h-0.5 mb-5 ${
                      index < currentStepIndex ? 'bg-indigo-500' : 'bg-gray-200'
                    }`}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Step content */}
      <div className="max-w-4xl mx-auto px-4 pb-12">
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
