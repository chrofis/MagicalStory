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
import { characterService, storyService } from '@/services';
import { storyTypes } from '@/constants/storyTypes';
import { getNotKnownRelationship, isNotKnownRelationship, findInverseRelationship } from '@/constants/relationships';

export default function StoryWizard() {
  const navigate = useNavigate();
  const { t, language } = useLanguage();
  const { isAuthenticated } = useAuth();

  // Wizard state
  const [step, setStep] = useState(1);
  const [isLoading, setIsLoading] = useState(false);
  const [developerMode, setDeveloperMode] = useState(false);
  const [imageGenMode, setImageGenMode] = useState<'parallel' | 'sequential' | null>(null); // null = server default

  // Step 1: Story Type & Art Style
  const [storyType, setStoryType] = useState('');
  const [artStyle, setArtStyle] = useState('pixar');
  const [customStoryTypes, setCustomStoryTypes] = useState<Array<{ id: string; name: { en: string; de: string; fr: string }; emoji: string }>>([]);

  // Step 2: Characters
  const [characters, setCharacters] = useState<Character[]>([]);
  const [currentCharacter, setCurrentCharacter] = useState<Character | null>(null);
  const [showCharacterCreated, setShowCharacterCreated] = useState(false);
  const [characterStep, setCharacterStep] = useState<'photo' | 'name' | 'traits'>('photo');

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
  const [, setStoryOutline] = useState(''); // Outline stored for potential later use
  const [, setSceneDescriptions] = useState<SceneDescription[]>([]);
  const [sceneImages, setSceneImages] = useState<SceneImage[]>([]);
  const [storyId, setStoryId] = useState<string | null>(null);
  const [, setJobId] = useState<string | null>(null); // Job ID for tracking/cancellation

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
        const notKnown = getNotKnownRelationship(lang);
        console.log('Initializing relationships for step 3, charKey:', charKey, 'existing:', Object.keys(relationships).length);

        setRelationships(prev => {
          const updated = { ...prev };
          let hasChanges = false;

          // Initialize both directions for each pair
          characters.forEach((char1, i) => {
            characters.forEach((char2, j) => {
              if (i !== j) {
                const key = `${char1.id}-${char2.id}`;
                if (!updated[key]) {
                  updated[key] = notKnown;
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

  // Check if all relationships are defined (both directions)
  const areAllRelationshipsDefined = () => {
    if (characters.length < 2) return true;
    for (let i = 0; i < characters.length; i++) {
      for (let j = 0; j < characters.length; j++) {
        if (i !== j) {
          const key = `${characters[i].id}-${characters[j].id}`;
          const value = relationships[key];
          if (!value || isNotKnownRelationship(value)) {
            return false;
          }
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
      flaws: [],
      challenges: [],
    });
    setCharacterStep('photo');
    setShowCharacterCreated(false);
  };

  const handlePhotoSelect = async (file: File) => {
    const reader = new FileReader();
    reader.onload = async (e) => {
      const originalPhotoUrl = e.target?.result as string;

      // IMMEDIATELY show name entry with original photo - don't block on analysis
      setCurrentCharacter(prev => prev ? { ...prev, photoUrl: originalPhotoUrl } : null);
      setCharacterStep('name');

      // Run photo analysis in BACKGROUND (non-blocking)
      try {
        console.log('Starting background photo analysis...');
        const analysis = await characterService.analyzePhoto(originalPhotoUrl);

        if (analysis.success) {
          // Update character with analyzed data (user may have already entered name)
          const photoUrl = analysis.faceThumbnail || originalPhotoUrl;
          const bodyPhotoUrl = analysis.bodyCrop || originalPhotoUrl;
          const bodyNoBgUrl = analysis.bodyNoBg || undefined;

          console.log('Photo analysis complete:', {
            hasFaceThumbnail: !!analysis.faceThumbnail,
            hasBodyCrop: !!analysis.bodyCrop,
            hasBodyNoBg: !!analysis.bodyNoBg,
            attributes: analysis.attributes,
          });

          setCurrentCharacter(prev => prev ? {
            ...prev,
            photoUrl,
            bodyPhotoUrl,
            bodyNoBgUrl,
            faceBox: analysis.faceBox,
            bodyBox: analysis.bodyBox,
            // Only update attributes if they were detected and user hasn't changed defaults
            gender: analysis.attributes?.gender ? (analysis.attributes.gender as 'male' | 'female' | 'other') : prev.gender,
            age: analysis.attributes?.age ? String(analysis.attributes.age) : prev.age,
            height: analysis.attributes?.height ? String(analysis.attributes.height) : prev.height,
            build: analysis.attributes?.build || prev.build,
            hairColor: analysis.attributes?.hairColor || prev.hairColor,
            clothing: analysis.attributes?.clothing || prev.clothing,
          } : null);
        } else {
          console.warn('Photo analysis returned no data, keeping original photo');
        }
      } catch (error) {
        console.error('Background photo analysis error:', error);
        // Keep original photo - user can still proceed
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
    setCharacterStep('traits'); // Go directly to traits when editing
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

  // Relationship handlers - set both forward and inverse relationships
  const updateRelationship = (char1Id: number, char2Id: number, value: string) => {
    const lang = language as Language;
    const inverse = findInverseRelationship(value, lang);
    const forwardKey = `${char1Id}-${char2Id}`;
    const inverseKey = `${char2Id}-${char1Id}`;
    console.log('Updating relationship:', forwardKey, '=', value, ', inverse:', inverseKey, '=', inverse);
    setRelationships(prev => ({
      ...prev,
      [forwardKey]: value,
      [inverseKey]: inverse,
    }));
  };

  const addCustomRelationship = (relationship: string) => {
    setCustomRelationships(prev => [...prev, relationship]);
  };

  // Add custom story type
  const addCustomStoryType = () => {
    const promptMsg = language === 'de' ? 'Name des Story-Typs eingeben:' :
                     language === 'fr' ? 'Entrez le nom du type d\'histoire:' :
                     'Enter story type name:';
    const name = prompt(promptMsg);
    if (name) {
      const newType = {
        id: `custom-${Date.now()}`,
        name: { en: name, de: name, fr: name },
        emoji: '✨',
      };
      setCustomStoryTypes(prev => [...prev, newType]);
      setStoryType(newType.id);
      // Auto-scroll to art style selection
      setTimeout(() => {
        const artStyleSection = document.getElementById('art-style-section');
        if (artStyleSection) {
          artStyleSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      }, 100);
    }
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
  // Get story type name for display
  const getStoryTypeName = () => {
    // Check custom types first
    const customType = customStoryTypes.find(t => t.id === storyType);
    if (customType) return customType.name[language as keyof typeof customType.name];
    // Check built-in types
    const builtInType = storyTypes.find(t => t.id === storyType);
    if (builtInType) return builtInType.name[language as keyof typeof builtInType.name];
    return storyType;
  };

  const generateStory = async (skipImages = false) => {
    setIsGenerating(true);
    setStep(5);
    setGenerationProgress({
      current: 1,
      total: skipImages ? 3 : 5,
      message: language === 'de' ? 'Starte Generierung...' : language === 'fr' ? 'Démarrage de la génération...' : 'Starting generation...'
    });

    try {
      // Create the story generation job
      const { jobId: newJobId } = await storyService.createStoryJob({
        storyType,
        storyTypeName: getStoryTypeName(),
        artStyle,
        language: language as Language,
        languageLevel,
        pages,
        dedication,
        storyDetails,
        characters,
        mainCharacters,
        relationships,
        relationshipTexts,
        skipImages,
        imageGenMode,
      });

      setJobId(newJobId);
      console.log('Story job created:', newJobId);

      // Poll for job status
      let completed = false;
      while (!completed) {
        await new Promise(resolve => setTimeout(resolve, 2000)); // Poll every 2 seconds

        const status = await storyService.getJobStatus(newJobId);
        console.log('Job status:', status);

        if (status.progress) {
          setGenerationProgress(status.progress);
        }

        if (status.status === 'completed' && status.result) {
          // Job completed successfully
          setStoryId(status.result.storyId);
          setStoryTitle(status.result.title);
          setStoryOutline(status.result.outline);
          setGeneratedStory(status.result.story);
          setSceneDescriptions(status.result.sceneDescriptions || []);
          setSceneImages(status.result.sceneImages || []);
          completed = true;
          console.log('Story generation completed!');
        } else if (status.status === 'failed') {
          throw new Error(status.error || 'Story generation failed');
        }
      }

      setGenerationProgress({
        current: skipImages ? 3 : 5,
        total: skipImages ? 3 : 5,
        message: language === 'de' ? 'Fertig!' : language === 'fr' ? 'Terminé!' : 'Complete!'
      });
    } catch (error) {
      console.error('Generation failed:', error);
      alert(language === 'de'
        ? `Generierung fehlgeschlagen: ${error}`
        : language === 'fr'
        ? `Échec de la génération: ${error}`
        : `Generation failed: ${error}`);
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
              customTypes={customStoryTypes}
              onAddCustom={addCustomStoryType}
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
          // Step 2a: Photo upload
          if (characterStep === 'photo') {
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

          // Step 2b: Name entry only
          if (characterStep === 'name') {
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
                  onContinueToTraits={() => setCharacterStep('traits')}
                  isLoading={isLoading}
                  step="name"
                />
              </div>
            );
          }

          // Step 2c: Traits and characteristics
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
                step="traits"
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
            imageGenMode={imageGenMode}
            onImageGenModeChange={setImageGenMode}
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
              onDownloadPdf={storyId ? async () => {
                try {
                  const blob = await storyService.generatePdf(storyId);
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement('a');
                  a.href = url;
                  a.download = `${storyTitle}.pdf`;
                  a.click();
                  URL.revokeObjectURL(url);
                } catch (error) {
                  console.error('PDF download failed:', error);
                  alert(language === 'de'
                    ? 'PDF-Download fehlgeschlagen'
                    : language === 'fr'
                    ? 'Échec du téléchargement PDF'
                    : 'PDF download failed');
                }
              } : undefined}
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
            <Button onClick={() => generateStory(false)} size="lg" icon={Sparkles}>
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
            <div className="mt-6 pt-6 border-t border-gray-200">
              {/* Steps 1-3: Back and Next buttons side by side */}
              {step !== 4 && (
                <div className="flex justify-between">
                  <button
                    onClick={goBack}
                    className="bg-transparent text-gray-800 hover:bg-gray-100 px-6 py-3 rounded-lg font-semibold flex items-center gap-2"
                  >
                    <ArrowLeft size={20} /> {t.back}
                  </button>
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
                </div>
              )}

              {/* Step 4: Back button and Generate buttons stacked */}
              {step === 4 && (
                <div className="space-y-4">
                  <button
                    onClick={goBack}
                    className="bg-transparent text-gray-800 hover:bg-gray-100 px-6 py-3 rounded-lg font-semibold flex items-center gap-2"
                  >
                    <ArrowLeft size={20} /> {t.back}
                  </button>

                  <button
                    onClick={() => generateStory(false)}
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
                      onClick={() => generateStory(true)}
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
                </div>
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
