import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLanguage } from '@/context/LanguageContext';
import { useAuth } from '@/context/AuthContext';
import { ArrowLeft, ArrowRight, Sparkles, Users } from 'lucide-react';

// Components
import { Button, LoadingSpinner, Navigation } from '@/components/common';
import { StoryTypeSelector, ArtStyleSelector, RelationshipEditor, StorySettings } from '@/components/story';
import { CharacterList, CharacterForm, PhotoUpload } from '@/components/character';
import { GenerationProgress, StoryDisplay } from '@/components/generation';

// Types
import type { Character, RelationshipMap, RelationshipTextMap } from '@/types/character';
import type { LanguageLevel, SceneDescription, SceneImage, Language } from '@/types/story';

// Services & Helpers
import { characterService } from '@/services';
import { getNotKnownRelationship, isNotKnownRelationship } from '@/constants/relationships';

export default function StoryWizard() {
  const navigate = useNavigate();
  const { t, language } = useLanguage();
  const { isAuthenticated } = useAuth();

  // Wizard state
  const [step, setStep] = useState(1);
  const [isLoading, setIsLoading] = useState(false);
  const [developerMode, setDeveloperMode] = useState(false);

  // Step 1: Story Type & Art Style
  const [storyType, setStoryType] = useState('');
  const [artStyle, setArtStyle] = useState('pixar');

  // Step 2: Characters
  const [characters, setCharacters] = useState<Character[]>([]);
  const [currentCharacter, setCurrentCharacter] = useState<Character | null>(null);
  const [showCharacterCreated, setShowCharacterCreated] = useState(false);

  // Step 3: Relationships - loaded from API with characters
  const [relationships, setRelationships] = useState<RelationshipMap>({});
  const [relationshipTexts, setRelationshipTexts] = useState<RelationshipTextMap>({});
  const [customRelationships, setCustomRelationships] = useState<string[]>([]);
  const relationshipsInitialized = useRef<string | null>(null);
  const dataLoadedFromApi = useRef(false);

  // Step 4: Story Settings - load from localStorage
  const [mainCharacters, setMainCharacters] = useState<number[]>(() => {
    try {
      const saved = localStorage.getItem('story_main_characters');
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });
  const [languageLevel, setLanguageLevel] = useState<LanguageLevel>(() => {
    try {
      const saved = localStorage.getItem('story_language_level');
      return (saved as LanguageLevel) || 'standard';
    } catch {
      return 'standard';
    }
  });
  const [pages, setPages] = useState(() => {
    try {
      const saved = localStorage.getItem('story_pages');
      return saved ? parseInt(saved) : 30;
    } catch {
      return 30;
    }
  });
  const [dedication, setDedication] = useState(() => {
    return localStorage.getItem('story_dedication') || '';
  });
  const [storyDetails, setStoryDetails] = useState(() => {
    return localStorage.getItem('story_details') || '';
  });

  // Step 5: Generation & Display
  const [isGenerating, setIsGenerating] = useState(false);
  const [generationProgress, setGenerationProgress] = useState({ current: 0, total: 0, message: '' });
  const [storyTitle, setStoryTitle] = useState('');
  const [generatedStory, setGeneratedStory] = useState('');
  const [, setSceneDescriptions] = useState<SceneDescription[]>([]);
  const [sceneImages] = useState<SceneImage[]>([]);

  // Redirect if not authenticated
  useEffect(() => {
    if (!isAuthenticated) {
      navigate('/');
    }
  }, [isAuthenticated, navigate]);

  // Auto-select main characters based on age
  const autoSelectMainCharacters = (charactersList: Character[]) => {
    if (charactersList.length === 0) return;

    // Find characters aged 1-10
    const youngCharacters = charactersList.filter(char => {
      const age = parseInt(char.age);
      return age >= 1 && age <= 10;
    });

    if (youngCharacters.length > 0) {
      // Select all characters aged 1-10 as main characters
      const mainCharIds = youngCharacters.map(char => char.id);
      setMainCharacters(mainCharIds);
      console.log(`Auto-selected ${youngCharacters.length} main character(s) aged 1-10`);
    } else {
      // No characters aged 1-10, select the youngest one
      const youngest = charactersList.reduce((min, char) => {
        const age = parseInt(char.age) || 999;
        const minAge = parseInt(min.age) || 999;
        return age < minAge ? char : min;
      });
      setMainCharacters([youngest.id]);
      console.log(`Auto-selected youngest character as main: ${youngest.name} (age ${youngest.age})`);
    }
  };

  // Load characters and relationships on mount
  useEffect(() => {
    const loadCharacterData = async () => {
      try {
        setIsLoading(true);
        const data = await characterService.getCharacterData();
        console.log('Loaded character data from API:', {
          characters: data.characters.length,
          relationships: Object.keys(data.relationships).length,
        });

        setCharacters(data.characters);

        // Load relationships from API if available
        if (Object.keys(data.relationships).length > 0) {
          setRelationships(data.relationships);
          dataLoadedFromApi.current = true;
        }
        if (Object.keys(data.relationshipTexts).length > 0) {
          setRelationshipTexts(data.relationshipTexts);
        }
        if (data.customRelationships.length > 0) {
          setCustomRelationships(data.customRelationships);
        }

        // Auto-select main characters after loading
        if (data.characters.length > 0) {
          autoSelectMainCharacters(data.characters);
        }
      } catch (error) {
        console.error('Failed to load character data:', error);
      } finally {
        setIsLoading(false);
      }
    };

    if (isAuthenticated) {
      loadCharacterData();
    }
  }, [isAuthenticated]);

  // Auto-start character creation when entering step 2 with no characters
  useEffect(() => {
    if (step === 2 && characters.length === 0 && !currentCharacter && !isLoading) {
      startNewCharacter();
    }
  }, [step, characters.length, currentCharacter, isLoading]);

  // Note: Relationships are now saved with characters to the API, not localStorage

  // Persist Step 4 settings to localStorage
  useEffect(() => {
    localStorage.setItem('story_main_characters', JSON.stringify(mainCharacters));
  }, [mainCharacters]);

  useEffect(() => {
    localStorage.setItem('story_language_level', languageLevel);
  }, [languageLevel]);

  useEffect(() => {
    localStorage.setItem('story_pages', pages.toString());
  }, [pages]);

  useEffect(() => {
    localStorage.setItem('story_dedication', dedication);
  }, [dedication]);

  useEffect(() => {
    localStorage.setItem('story_details', storyDetails);
  }, [storyDetails]);

  // Initialize relationships when moving to step 3 (only once per character set)
  // Wait until not loading to ensure API data is loaded first
  useEffect(() => {
    if (step === 3 && characters.length >= 2 && !isLoading) {
      // Create a key based on character IDs to detect if characters changed
      const charKey = characters.map(c => c.id).sort().join('-');

      if (!relationshipsInitialized.current || relationshipsInitialized.current !== charKey) {
        const lang = language as Language;
        console.log('Initializing relationships for step 3, charKey:', charKey, 'existing:', Object.keys(relationships).length);

        setRelationships(prev => {
          const updated = { ...prev };
          let hasChanges = false;

          characters.forEach((char1, i) => {
            characters.forEach((char2, j) => {
              if (i < j) {
                const key = `${char1.id}-${char2.id}`;
                if (!updated[key]) {
                  updated[key] = getNotKnownRelationship(lang);
                  hasChanges = true;
                  console.log('Initializing missing relationship:', key);
                }
              }
            });
          });

          return hasChanges ? updated : prev;
        });

        relationshipsInitialized.current = charKey;
      }
    }
  }, [step, characters, language, isLoading]);

  // Check if all relationships are defined
  const areAllRelationshipsDefined = () => {
    if (characters.length < 2) return true;
    for (let i = 0; i < characters.length; i++) {
      for (let j = i + 1; j < characters.length; j++) {
        const key = `${characters[i].id}-${characters[j].id}`;
        const value = relationships[key];
        if (!value || isNotKnownRelationship(value)) {
          return false;
        }
      }
    }
    return true;
  };

  // Character handlers
  const startNewCharacter = () => {
    setCurrentCharacter({
      id: Date.now(),
      name: '',
      gender: 'other',
      age: '8',
      strengths: [],
      weaknesses: [],
      fears: [],
    });
    setShowCharacterCreated(false);
  };

  const handlePhotoSelect = async (file: File) => {
    const reader = new FileReader();
    reader.onload = async (e) => {
      const originalPhotoUrl = e.target?.result as string;

      try {
        setIsLoading(true);

        // Analyze photo with Python MediaPipe API
        const analysis = await characterService.analyzePhoto(originalPhotoUrl);

        if (analysis.success) {
          // Use cropped images from Python API
          const photoUrl = analysis.faceThumbnail || originalPhotoUrl;
          const bodyPhotoUrl = analysis.bodyCrop || originalPhotoUrl;
          const bodyNoBgUrl = analysis.bodyNoBg || undefined;

          console.log('Photo analysis successful:', {
            hasFaceThumbnail: !!analysis.faceThumbnail,
            hasBodyCrop: !!analysis.bodyCrop,
            hasBodyNoBg: !!analysis.bodyNoBg,
          });

          setCurrentCharacter(prev => prev ? {
            ...prev,
            photoUrl,
            bodyPhotoUrl,
            bodyNoBgUrl,
            faceBox: analysis.faceBox,
            bodyBox: analysis.bodyBox,
            gender: (analysis.attributes?.gender as 'male' | 'female' | 'other') || prev.gender,
            age: analysis.attributes?.age || prev.age,
            height: analysis.attributes?.height || prev.height,
            build: analysis.attributes?.build || prev.build,
            hairColor: analysis.attributes?.hairColor || prev.hairColor,
            clothing: analysis.attributes?.clothing || prev.clothing,
          } : null);
        } else {
          // Fallback: use original photo without cropping
          console.warn('Photo analysis failed, using original photo');
          setCurrentCharacter(prev => prev ? { ...prev, photoUrl: originalPhotoUrl } : null);
        }
      } catch (error) {
        console.error('Photo analysis error:', error);
        setCurrentCharacter(prev => prev ? { ...prev, photoUrl: originalPhotoUrl } : null);
      } finally {
        setIsLoading(false);
      }
    };
    reader.readAsDataURL(file);
  };

  const saveCharacter = async () => {
    if (!currentCharacter) return;

    setIsLoading(true);
    try {
      // Check if this is an edit (existing character) or new character
      const isEdit = currentCharacter.id && characters.find(c => c.id === currentCharacter.id);
      const updatedCharacters = isEdit
        ? characters.map(c => c.id === currentCharacter.id ? currentCharacter : c)
        : [...characters, currentCharacter];

      console.log('Saving characters with relationships:', updatedCharacters.length);
      // Save characters along with relationships
      await characterService.saveCharacterData({
        characters: updatedCharacters,
        relationships,
        relationshipTexts,
        customRelationships,
        customStrengths: [],
        customWeaknesses: [],
        customFears: [],
      });
      console.log('Character data saved successfully');

      setCharacters(updatedCharacters);

      // Auto-select main characters after save
      autoSelectMainCharacters(updatedCharacters);

      setCurrentCharacter(null);
      setShowCharacterCreated(true);
    } catch (error) {
      console.error('Failed to save character:', error);
      alert('Failed to save character. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  const editCharacter = (char: Character) => {
    setCurrentCharacter({ ...char });
    setShowCharacterCreated(false);
  };

  const deleteCharacter = async (id: number) => {
    const updatedCharacters = characters.filter(c => c.id !== id);

    // Also clean up relationships involving this character
    const updatedRelationships = { ...relationships };
    const updatedRelationshipTexts = { ...relationshipTexts };
    Object.keys(updatedRelationships).forEach(key => {
      if (key.includes(`${id}-`) || key.includes(`-${id}`)) {
        delete updatedRelationships[key];
        delete updatedRelationshipTexts[key];
      }
    });

    try {
      await characterService.saveCharacterData({
        characters: updatedCharacters,
        relationships: updatedRelationships,
        relationshipTexts: updatedRelationshipTexts,
        customRelationships,
        customStrengths: [],
        customWeaknesses: [],
        customFears: [],
      });
      setCharacters(updatedCharacters);
      setRelationships(updatedRelationships);
      setRelationshipTexts(updatedRelationshipTexts);
      setMainCharacters(prev => prev.filter(cid => cid !== id));
    } catch (error) {
      console.error('Failed to delete character:', error);
    }
  };

  // Relationship handlers
  const updateRelationship = (char1Id: number, char2Id: number, value: string) => {
    const key = `${char1Id}-${char2Id}`;
    console.log('Updating relationship:', key, '=', value);
    setRelationships(prev => {
      const updated = { ...prev, [key]: value };
      console.log('New relationships state:', updated);
      return updated;
    });
  };

  const addCustomRelationship = (relationship: string) => {
    setCustomRelationships(prev => [...prev, relationship]);
  };

  // Main character toggle
  const toggleMainCharacter = (charId: number) => {
    setMainCharacters(prev => {
      if (prev.includes(charId)) {
        return prev.filter(id => id !== charId);
      }
      return [...prev, charId];
    });
  };

  // Navigation
  const safeSetStep = (newStep: number) => {
    if (newStep >= 0 && newStep <= 5) {
      setStep(newStep);
    }
  };

  const canAccessStep = (s: number): boolean => {
    if (s === 1) return true;
    if (s === 2) return storyType !== '';
    if (s === 3) return storyType !== '' && characters.length > 0;
    if (s === 4) return storyType !== '' && characters.length > 0 && areAllRelationshipsDefined();
    if (s === 5) return generatedStory !== '';
    return false;
  };

  const canGoNext = (): boolean => {
    if (step === 1) return storyType !== '';
    if (step === 2) return characters.length > 0;
    if (step === 3) return areAllRelationshipsDefined();
    if (step === 4) return mainCharacters.length > 0;
    return false;
  };

  // Save all character data including relationships
  const saveAllCharacterData = async () => {
    if (characters.length === 0) return;
    try {
      await characterService.saveCharacterData({
        characters,
        relationships,
        relationshipTexts,
        customRelationships,
        customStrengths: [],
        customWeaknesses: [],
        customFears: [],
      });
      console.log('Character data auto-saved');
    } catch (error) {
      console.error('Failed to auto-save character data:', error);
    }
  };

  const goNext = async () => {
    if (step < 4 && canGoNext()) {
      // Save relationships when leaving step 3
      if (step === 3) {
        await saveAllCharacterData();
      }
      safeSetStep(step + 1);
    }
  };

  const goBack = async () => {
    if (step > 0) {
      // Save relationships when leaving step 3
      if (step === 3) {
        await saveAllCharacterData();
      }
      safeSetStep(step - 1);
    }
  };

  // Generate story
  const generateStory = async () => {
    setIsGenerating(true);
    setStep(5);
    setGenerationProgress({ current: 1, total: 4, message: language === 'de' ? 'Erstelle Gliederung...' : language === 'fr' ? 'Creation du plan...' : 'Generating outline...' });

    try {
      await new Promise(resolve => setTimeout(resolve, 1500));
      setGenerationProgress({ current: 2, total: 4, message: language === 'de' ? 'Schreibe Geschichte...' : language === 'fr' ? 'Ecriture de l\'histoire...' : 'Writing story...' });

      await new Promise(resolve => setTimeout(resolve, 1500));
      setGenerationProgress({ current: 3, total: 4, message: language === 'de' ? 'Erstelle Szenen...' : language === 'fr' ? 'Creation des scenes...' : 'Creating scenes...' });

      await new Promise(resolve => setTimeout(resolve, 1500));

      const mainChar = characters.find(c => mainCharacters.includes(c.id));
      setStoryTitle(mainChar ? `${mainChar.name}'s Adventure` : 'My Magical Story');
      setGeneratedStory(`--- Page 1 ---
Once upon a time, ${mainChar?.name || 'our hero'} set off on a magical adventure.

--- Page 2 ---
The journey was full of wonder and excitement.

--- Page 3 ---
And they all lived happily ever after.`);

      setSceneDescriptions([
        { pageNumber: 1, description: 'A magical forest at dawn with golden sunlight filtering through the trees' },
        { pageNumber: 2, description: 'The hero discovering a hidden treasure in a mysterious cave' },
        { pageNumber: 3, description: 'A joyful celebration with friends under a rainbow' },
      ]);

      setGenerationProgress({ current: 4, total: 4, message: language === 'de' ? 'Fertig!' : language === 'fr' ? 'Termine!' : 'Complete!' });
    } catch (error) {
      console.error('Generation failed:', error);
    } finally {
      setTimeout(() => setIsGenerating(false), 500);
    }
  };

  // Render current step content
  const renderStep = () => {
    switch (step) {
      case 1:
        return (
          <div className="space-y-6">
            <StoryTypeSelector
              selectedType={storyType}
              onSelect={(id) => {
                setStoryType(id);
                // Auto-scroll to art style selection
                setTimeout(() => {
                  const artStyleSection = document.getElementById('art-style-section');
                  if (artStyleSection) {
                    artStyleSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
                  }
                }, 100);
              }}
            />
            {storyType && (
              <ArtStyleSelector
                selectedStyle={artStyle}
                onSelect={setArtStyle}
              />
            )}
          </div>
        );

      case 2:
        if (currentCharacter) {
          if (!currentCharacter.photoUrl) {
            return (
              <div className="space-y-6">
                <h2 className="text-3xl font-bold text-gray-800 flex items-center gap-2">
                  <Users size={24} /> {t.createCharacters}
                </h2>
                <PhotoUpload onPhotoSelect={handlePhotoSelect} />
                <button
                  onClick={() => setCurrentCharacter(null)}
                  className="w-full bg-gray-200 text-gray-700 px-4 py-2 rounded-lg font-semibold hover:bg-gray-300 transition-colors"
                >
                  {t.cancel}
                </button>
              </div>
            );
          }
          return (
            <div className="space-y-6">
              <h2 className="text-3xl font-bold text-gray-800 flex items-center gap-2">
                <Users size={24} /> {t.createCharacters}
              </h2>
              <CharacterForm
                character={currentCharacter}
                onChange={setCurrentCharacter}
                onSave={saveCharacter}
                onCancel={() => setCurrentCharacter(null)}
                onPhotoChange={handlePhotoSelect}
                isLoading={isLoading}
              />
            </div>
          );
        }

        if (characters.length > 0) {
          return (
            <div className="space-y-6">
              <h2 className="text-3xl font-bold text-gray-800 flex items-center gap-2">
                <Users size={24} /> {t.createCharacters}
              </h2>
              <CharacterList
                characters={characters}
                showSuccessMessage={showCharacterCreated}
                onEdit={editCharacter}
                onDelete={deleteCharacter}
                onCreateAnother={startNewCharacter}
                onContinue={goNext}
              />
            </div>
          );
        }

        return (
          <div className="space-y-6">
            <h2 className="text-3xl font-bold text-gray-800 flex items-center gap-2">
              <Users size={24} /> {t.createCharacters}
            </h2>
            <div className="text-center py-12">
              <Users className="w-16 h-16 text-gray-300 mx-auto mb-4" />
              <p className="text-gray-600 mb-6">{t.startCreating}</p>
              <Button onClick={startNewCharacter} icon={Sparkles}>
                {language === 'de' ? 'Ersten Charakter erstellen' : language === 'fr' ? 'Creer le premier personnage' : 'Create First Character'}
              </Button>
            </div>
          </div>
        );

      case 3:
        return (
          <RelationshipEditor
            characters={characters}
            relationships={relationships}
            relationshipTexts={relationshipTexts}
            onRelationshipChange={updateRelationship}
            onRelationshipTextChange={(key, text) => setRelationshipTexts(prev => ({ ...prev, [key]: text }))}
            customRelationships={customRelationships}
            onAddCustomRelationship={addCustomRelationship}
          />
        );

      case 4:
        return (
          <StorySettings
            characters={characters}
            mainCharacters={mainCharacters}
            onToggleMainCharacter={toggleMainCharacter}
            languageLevel={languageLevel}
            onLanguageLevelChange={setLanguageLevel}
            pages={pages}
            onPagesChange={setPages}
            dedication={dedication}
            onDedicationChange={setDedication}
            storyDetails={storyDetails}
            onStoryDetailsChange={setStoryDetails}
            developerMode={developerMode}
          />
        );

      case 5:
        if (generatedStory) {
          return (
            <StoryDisplay
              title={storyTitle}
              story={generatedStory}
              sceneImages={sceneImages}
              languageLevel={languageLevel}
              isGenerating={isGenerating}
              developerMode={developerMode}
              onDownloadTxt={() => {
                const blob = new Blob([generatedStory], { type: 'text/plain' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `${storyTitle}.txt`;
                a.click();
                URL.revokeObjectURL(url);
              }}
              onCreateAnother={() => {
                // Reset story state but keep characters
                setGeneratedStory('');
                setStoryTitle('');
                setSceneDescriptions([]);
                setStep(1);
              }}
            />
          );
        }
        return (
          <div className="text-center py-12">
            <Sparkles className="w-16 h-16 text-gray-300 mx-auto mb-4" />
            <h2 className="text-2xl font-bold text-gray-800 mb-4">{t.generateStory}</h2>
            <p className="text-gray-600 mb-6">
              {language === 'de' ? 'Bereit, deine Geschichte zu erstellen!' : language === 'fr' ? 'Prêt à créer votre histoire!' : 'Ready to create your story!'}
            </p>
            <Button onClick={generateStory} size="lg" icon={Sparkles}>
              {t.generateStory}
            </Button>
          </div>
        );

      default:
        return null;
    }
  };

  if (!isAuthenticated) {
    return <LoadingSpinner fullScreen />;
  }

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      {/* Navigation with step indicators */}
      <Navigation
        currentStep={step}
        onStepClick={safeSetStep}
        canAccessStep={canAccessStep}
        developerMode={developerMode}
        onDeveloperModeChange={setDeveloperMode}
      />

      {/* Main content */}
      <div className="max-w-7xl mx-auto px-3 md:px-8 mt-2 md:mt-8 flex-1">
        <div className="md:bg-white md:rounded-2xl md:shadow-xl md:p-8">
          {isLoading && !isGenerating ? (
            <div className="py-12">
              <LoadingSpinner message={language === 'de' ? 'Laden...' : language === 'fr' ? 'Chargement...' : 'Loading...'} />
            </div>
          ) : (
            renderStep()
          )}

          {/* Navigation buttons - inside the container */}
          {step < 5 && !currentCharacter && (
            <div className={`mt-6 pt-6 border-t border-gray-200 ${step === 4 ? "space-y-4" : "flex justify-between"}`}>
              <button
                onClick={goBack}
                className="bg-transparent text-gray-800 hover:bg-gray-100 px-6 py-3 rounded-lg font-semibold flex items-center gap-2"
              >
                <ArrowLeft size={20} /> {t.back}
              </button>

              {step !== 4 && (
                <button
                  onClick={goNext}
                  disabled={!canGoNext()}
                  className={`px-6 py-3 rounded-lg font-semibold flex items-center gap-2 ${
                    !canGoNext()
                      ? 'bg-gray-300 text-gray-500 cursor-not-allowed'
                      : 'bg-indigo-600 text-white hover:bg-indigo-700'
                  }`}
                >
                  {t.next} <ArrowRight size={20} />
                </button>
              )}

              {step === 4 && (
                <>
                  <button
                    onClick={generateStory}
                    disabled={!canGoNext()}
                    className={`w-full py-3 rounded-lg font-bold text-base flex items-center justify-center gap-2 ${
                      !canGoNext()
                        ? 'bg-gray-400 text-white cursor-not-allowed'
                        : 'bg-indigo-600 text-white hover:bg-indigo-700'
                    }`}
                  >
                    <Sparkles size={20} /> {t.generateStory}
                  </button>

                  {/* Developer Mode: Generate Text Only (no images) */}
                  {developerMode && (
                    <button
                      onClick={generateStory}
                      disabled={!canGoNext()}
                      className={`w-full py-3 rounded-lg font-bold text-base flex items-center justify-center gap-2 ${
                        !canGoNext()
                          ? 'bg-gray-400 text-white cursor-not-allowed'
                          : 'bg-yellow-500 text-white hover:bg-yellow-600'
                      }`}
                    >
                      <Sparkles size={20} />
                      {language === 'de' ? 'Nur Text generieren (ohne Bilder)' : language === 'fr' ? 'Générer le texte uniquement (sans images)' : 'Generate Text Only (no images)'}
                    </button>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Generation Progress Modal */}
      {isGenerating && (
        <GenerationProgress
          current={generationProgress.current}
          total={generationProgress.total}
          message={generationProgress.message}
        />
      )}
    </div>
  );
}
