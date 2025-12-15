import { useState, useEffect, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useLanguage } from '@/context/LanguageContext';
import { useAuth } from '@/context/AuthContext';
import { useToast } from '@/context/ToastContext';
import { ArrowLeft, ArrowRight, Loader2, Sparkles, Users } from 'lucide-react';

// Components
import { Button, LoadingSpinner, Navigation } from '@/components/common';
import { StoryTypeSelector, ArtStyleSelector, RelationshipEditor, StorySettings } from '@/components/story';
import { CharacterList, CharacterForm, PhotoUpload } from '@/components/character';
import { GenerationProgress, StoryDisplay } from '@/components/generation';

// Types
import type { Character, RelationshipMap, RelationshipTextMap } from '@/types/character';
import type { LanguageLevel, SceneDescription, SceneImage, Language, CoverImages } from '@/types/story';

// Services & Helpers
import { characterService, storyService, authService } from '@/services';
import { storyTypes } from '@/constants/storyTypes';
import { getNotKnownRelationship, isNotKnownRelationship, findInverseRelationship } from '@/constants/relationships';
import { createLogger } from '@/services/logger';

// Create namespaced logger
const log = createLogger('StoryWizard');

export default function StoryWizard() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { t, language } = useLanguage();
  const { isAuthenticated } = useAuth();
  const { showSuccess, showInfo } = useToast();

  // Wizard state - start at step 5 with loading if we have a storyId in URL
  const [step, setStep] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get('storyId') ? 5 : 1;
  });
  const [isLoading, setIsLoading] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    return !!params.get('storyId');
  });
  const [loadingProgress, setLoadingProgress] = useState<{ loaded: number; total: number | null } | null>(null);
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
  const [isAnalyzingPhoto, setIsAnalyzingPhoto] = useState(false);

  // Step 3: Relationships - loaded from API with characters
  const [relationships, setRelationships] = useState<RelationshipMap>({});
  const [relationshipTexts, setRelationshipTexts] = useState<RelationshipTextMap>({});
  const [customRelationships, setCustomRelationships] = useState<string[]>([]);
  const relationshipsInitialized = useRef<string | null>(null);
  const dataLoadedFromApi = useRef(false);
  const relationshipsDirty = useRef(false); // Track if relationships were modified

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
  const [isGenerating, setIsGenerating] = useState(false); // Full story generation
  const [isRegenerating, setIsRegenerating] = useState(false); // Single image/cover regeneration
  const [generationProgress, setGenerationProgress] = useState({ current: 0, total: 0, message: '' });
  const [storyTitle, setStoryTitle] = useState('');
  const [generatedStory, setGeneratedStory] = useState('');
  const [storyOutline, setStoryOutline] = useState(''); // Outline for dev mode display
  const [outlinePrompt, setOutlinePrompt] = useState(''); // API prompt for outline (dev mode)
  const [storyTextPrompts, setStoryTextPrompts] = useState<Array<{ batch: number; startPage: number; endPage: number; prompt: string }>>([]); // API prompts for story text (dev mode)
  const [visualBible, setVisualBible] = useState<{ secondaryCharacters: any[]; animals: any[]; artifacts: any[]; locations: any[] } | null>(null); // Visual Bible for dev mode
  const [sceneDescriptions, setSceneDescriptions] = useState<SceneDescription[]>([]);
  const [sceneImages, setSceneImages] = useState<SceneImage[]>([]);
  const [coverImages, setCoverImages] = useState<CoverImages>({ frontCover: null, initialPage: null, backCover: null });
  const [storyId, setStoryId] = useState<string | null>(null);
  const [, setJobId] = useState<string | null>(null); // Job ID for tracking/cancellation

  // Edit modal state
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<{ type: 'image' | 'cover'; pageNumber?: number; coverType?: 'front' | 'back' | 'initial' } | null>(null);
  const [editPromptText, setEditPromptText] = useState('');

  // Redirect if not authenticated
  useEffect(() => {
    if (!isAuthenticated) {
      navigate('/');
    }
  }, [isAuthenticated, navigate]);

  // Load saved story from URL parameter
  useEffect(() => {
    const loadSavedStory = async () => {
      const urlStoryId = searchParams.get('storyId');
      if (!urlStoryId || !isAuthenticated) return;

      log.info('Loading saved story:', urlStoryId);
      setIsLoading(true);
      setLoadingProgress({ loaded: 0, total: null });

      try {
        const story = await storyService.getStoryWithProgress(urlStoryId, (loaded, total) => {
          setLoadingProgress({ loaded, total });
        });
        if (story) {
          log.info('Loaded story:', story.title);
          // Populate story data
          setStoryId(story.id);
          setStoryTitle(story.title || '');
          setStoryType(story.storyType || '');
          setArtStyle(story.artStyle || 'pixar');
          setGeneratedStory(story.story || '');
          setStoryOutline(story.outline || '');
          setOutlinePrompt(story.outlinePrompt || '');
          setStoryTextPrompts(story.storyTextPrompts || []);
          setVisualBible(story.visualBible || null);
          setSceneImages(story.sceneImages || []);
          setSceneDescriptions(story.sceneDescriptions || []);
          setCoverImages(story.coverImages || { frontCover: null, initialPage: null, backCover: null });
          setLanguageLevel(story.languageLevel || 'standard');
          // Set to step 5 to show the story
          setStep(5);
          setIsGenerating(false);
        } else {
          log.error('Story not found:', urlStoryId);
        }
      } catch (error) {
        log.error('Failed to load story:', error);
      } finally {
        setIsLoading(false);
        setLoadingProgress(null);
      }
    };

    loadSavedStory();
  }, [searchParams, isAuthenticated]);

  // Check for Stripe payment callback on page load
  useEffect(() => {
    const checkPaymentStatus = async () => {
      const paymentStatus = searchParams.get('payment');
      const sessionId = searchParams.get('session_id');

      if (paymentStatus === 'success' && sessionId) {
        log.info('Payment successful! Checking order status...');
        log.info('Session ID:', sessionId);

        try {
          const data = await storyService.getOrderStatus(sessionId);
          log.info('Order Status:', data);

          if (data.order) {
            const amount = `CHF ${(data.order.amount_total / 100).toFixed(2)}`;
            const titles = {
              en: 'Payment Successful!',
              de: 'Zahlung erfolgreich!',
              fr: 'Paiement réussi!',
            };
            const messages = {
              en: 'Your book order has been received and will be printed soon.',
              de: 'Ihre Buchbestellung wurde entgegengenommen und wird bald gedruckt.',
              fr: 'Votre commande de livre a été reçue et sera bientôt imprimée.',
            };
            const details = [
              `${language === 'de' ? 'Kunde' : language === 'fr' ? 'Client' : 'Customer'}: ${data.order.customer_name}`,
              `Email: ${data.order.customer_email}`,
              `${language === 'de' ? 'Betrag' : language === 'fr' ? 'Montant' : 'Amount'}: ${amount}`,
              `${language === 'de' ? 'Versand an' : language === 'fr' ? 'Expédié à' : 'Shipping to'}: ${data.order.shipping_name}`,
              `${data.order.shipping_address_line1}`,
              `${data.order.shipping_postal_code} ${data.order.shipping_city}`,
              `${data.order.shipping_country}`,
            ];
            showSuccess(
              messages[language as keyof typeof messages] || messages.en,
              titles[language as keyof typeof titles] || titles.en,
              details
            );
          }
        } catch (error) {
          log.error('Error checking order status:', error);
        }

        // Clean up URL parameters
        const newParams = new URLSearchParams(searchParams);
        newParams.delete('payment');
        newParams.delete('session_id');
        setSearchParams(newParams, { replace: true });
      } else if (paymentStatus === 'cancelled') {
        log.info('Payment cancelled by user');
        const messages = {
          en: 'Payment was cancelled. You can try again when ready.',
          de: 'Zahlung wurde abgebrochen. Sie können es erneut versuchen.',
          fr: 'Paiement annulé. Vous pouvez réessayer quand vous êtes prêt.',
        };
        showInfo(
          messages[language as keyof typeof messages] || messages.en,
          language === 'de' ? 'Abgebrochen' : language === 'fr' ? 'Annulé' : 'Cancelled'
        );

        // Clean up URL parameters
        const newParams = new URLSearchParams(searchParams);
        newParams.delete('payment');
        setSearchParams(newParams, { replace: true });
      }
    };

    checkPaymentStatus();
  }, [searchParams, setSearchParams, language, showSuccess, showInfo]);

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
      log.info(`Auto-selected ${youngCharacters.length} main character(s) aged 1-10`);
    } else {
      // No characters aged 1-10, select the youngest one
      const youngest = charactersList.reduce((min, char) => {
        const age = parseInt(char.age) || 999;
        const minAge = parseInt(min.age) || 999;
        return age < minAge ? char : min;
      });
      setMainCharacters([youngest.id]);
      log.info(`Auto-selected youngest character as main: ${youngest.name} (age ${youngest.age})`);
    }
  };

  // Load characters and relationships on mount
  useEffect(() => {
    const loadCharacterData = async () => {
      try {
        setIsLoading(true);
        const data = await characterService.getCharacterData();
        log.info('Loaded character data from API:', {
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
        log.error('Failed to load character data:', error);
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
        log.debug('Initializing relationships for step 3', { charKey, existingCount: Object.keys(relationships).length });

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
                  log.debug('Initializing missing relationship:', key);
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

  // Resize image to reduce upload size (max 1500px on longest side)
  const resizeImage = (dataUrl: string, maxSize: number = 1500): Promise<string> => {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        let { width, height } = img;

        // Only resize if larger than maxSize
        if (width > maxSize || height > maxSize) {
          if (width > height) {
            height = Math.round((height * maxSize) / width);
            width = maxSize;
          } else {
            width = Math.round((width * maxSize) / height);
            height = maxSize;
          }
        }

        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx?.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', 0.85)); // JPEG at 85% quality
      };
      img.onerror = () => resolve(dataUrl); // Fallback to original if error
      img.src = dataUrl;
    });
  };

  const handlePhotoSelect = async (file: File) => {
    const reader = new FileReader();
    reader.onload = async (e) => {
      const originalPhotoUrl = e.target?.result as string;

      // Start analyzing - don't show photo yet
      setIsAnalyzingPhoto(true);
      // Only go to name step if not already in traits step (editing existing character)
      if (characterStep !== 'traits') {
        setCharacterStep('name');
      }

      // Run photo analysis
      try {
        // Resize image before sending to server (reduces upload time significantly)
        const resizedPhoto = await resizeImage(originalPhotoUrl);
        const originalSize = Math.round(originalPhotoUrl.length / 1024);
        const resizedSize = Math.round(resizedPhoto.length / 1024);
        log.info(`Starting photo analysis... (${originalSize}KB -> ${resizedSize}KB)`);
        const analysis = await characterService.analyzePhoto(resizedPhoto);

        if (analysis.success) {
          // Update character with analyzed data
          const photoUrl = analysis.faceThumbnail || originalPhotoUrl;
          const bodyPhotoUrl = analysis.bodyCrop || originalPhotoUrl;
          const bodyNoBgUrl = analysis.bodyNoBg || undefined;

          log.info('Photo analysis complete:', {
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
            // Only update attributes if user hasn't already filled them in
            gender: (!prev.gender || prev.gender === 'other') && analysis.attributes?.gender
              ? (analysis.attributes.gender as 'male' | 'female' | 'other')
              : prev.gender,
            age: (!prev.age || prev.age === '8') && analysis.attributes?.age
              ? String(analysis.attributes.age)
              : prev.age,
            height: !prev.height && analysis.attributes?.height
              ? String(analysis.attributes.height)
              : prev.height,
            build: !prev.build && analysis.attributes?.build
              ? analysis.attributes.build
              : prev.build,
            hairColor: !prev.hairColor && analysis.attributes?.hairColor
              ? analysis.attributes.hairColor
              : prev.hairColor,
            clothing: !prev.clothing && analysis.attributes?.clothing
              ? analysis.attributes.clothing
              : prev.clothing,
            otherFeatures: !prev.otherFeatures && analysis.attributes?.otherFeatures
              ? analysis.attributes.otherFeatures
              : prev.otherFeatures,
          } : null);
        } else {
          log.warn('Photo analysis returned no data, using original photo');
          // Fallback to original photo
          setCurrentCharacter(prev => prev ? { ...prev, photoUrl: originalPhotoUrl } : null);
        }
      } catch (error) {
        log.error('Photo analysis error:', error);
        // Fallback to original photo on error
        setCurrentCharacter(prev => prev ? { ...prev, photoUrl: originalPhotoUrl } : null);
      } finally {
        setIsAnalyzingPhoto(false);
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

      log.info('Saving characters with relationships:', updatedCharacters.length);
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
      log.success('Character data saved successfully');

      setCharacters(updatedCharacters);

      // Auto-select main characters after save
      autoSelectMainCharacters(updatedCharacters);

      setCurrentCharacter(null);
      setShowCharacterCreated(true);
    } catch (error) {
      log.error('Failed to save character:', error);
      alert(language === 'de'
        ? 'Charakter konnte nicht gespeichert werden. Bitte versuche es erneut.'
        : language === 'fr'
        ? 'Échec de l\'enregistrement du personnage. Veuillez réessayer.'
        : 'Failed to save character. Please try again.');
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
      log.error('Failed to delete character:', error);
    }
  };

  // Relationship handlers - set both forward and inverse relationships
  const updateRelationship = (char1Id: number, char2Id: number, value: string) => {
    const lang = language as Language;
    const inverse = findInverseRelationship(value, lang);
    const forwardKey = `${char1Id}-${char2Id}`;
    const inverseKey = `${char2Id}-${char1Id}`;
    log.debug('Updating relationship:', forwardKey, '=', value, ', inverse:', inverseKey, '=', inverse);
    relationshipsDirty.current = true; // Mark as modified
    setRelationships(prev => ({
      ...prev,
      [forwardKey]: value,
      [inverseKey]: inverse,
    }));
  };

  const addCustomRelationship = (relationship: string) => {
    relationshipsDirty.current = true; // Mark as modified
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

  // Save all character data including relationships (only if modified)
  const saveAllCharacterData = async () => {
    if (characters.length === 0) return;
    if (!relationshipsDirty.current) {
      log.debug('Relationships not modified, skipping save');
      return;
    }
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
      relationshipsDirty.current = false; // Reset dirty flag after save
      log.debug('Character data auto-saved');
    } catch (error) {
      log.error('Failed to auto-save character data:', error);
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
    // Use 0-100 scale to match server progress
    setGenerationProgress({
      current: 5,
      total: 100,
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
      log.info('Story job created:', newJobId);

      // Poll for job status
      let completed = false;
      let lastProgress = 0;
      while (!completed) {
        await new Promise(resolve => setTimeout(resolve, 2000)); // Poll every 2 seconds

        const status = await storyService.getJobStatus(newJobId);

        if (status.progress) {
          // Only log when progress changes
          if (status.progress.current !== lastProgress) {
            log.debug(`Progress: ${status.progress.current}% - ${status.progress.message || ''}`);
            lastProgress = status.progress.current;
          }
          // Server progress is already in { current, total, message } format
          setGenerationProgress(status.progress);
        }

        if (status.status === 'completed' && status.result) {
          // Job completed successfully
          setStoryId(status.result.storyId);
          setStoryTitle(status.result.title);
          setStoryOutline(status.result.outline);
          setOutlinePrompt(status.result.outlinePrompt || '');
          setStoryTextPrompts(status.result.storyTextPrompts || []);
          setVisualBible(status.result.visualBible || null);
          setGeneratedStory(status.result.story);
          setSceneDescriptions(status.result.sceneDescriptions || []);
          setSceneImages(status.result.sceneImages || []);
          setCoverImages(status.result.coverImages || { frontCover: null, initialPage: null, backCover: null });
          completed = true;
          log.success('Story generation completed!');
        } else if (status.status === 'failed') {
          throw new Error(status.error || 'Story generation failed');
        }
      }

      setGenerationProgress({
        current: 100,
        total: 100,
        message: language === 'de' ? 'Fertig!' : language === 'fr' ? 'Terminé!' : 'Complete!'
      });
    } catch (error) {
      log.error('Generation failed:', error);
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
                  isAnalyzingPhoto={isAnalyzingPhoto}
                  step="name"
                  developerMode={developerMode}
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
                isAnalyzingPhoto={isAnalyzingPhoto}
                step="traits"
                developerMode={developerMode}
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
            onRelationshipTextChange={(key, text) => { relationshipsDirty.current = true; setRelationshipTexts(prev => ({ ...prev, [key]: text })); }}
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
              outline={storyOutline}
              outlinePrompt={outlinePrompt}
              storyTextPrompts={storyTextPrompts}
              visualBible={visualBible || undefined}
              sceneImages={sceneImages}
              sceneDescriptions={sceneDescriptions}
              coverImages={coverImages}
              languageLevel={languageLevel}
              isGenerating={isGenerating}
              developerMode={developerMode}
              storyId={storyId}
              onRegenerateImage={storyId ? async (pageNumber: number) => {
                try {
                  log.info('Regenerating image for page:', pageNumber);
                  setIsGenerating(true);
                  const result = await storyService.regenerateImage(storyId, pageNumber);
                  log.info('Regenerate result:', { hasImageData: !!result?.imageData, length: result?.imageData?.length });
                  if (!result?.imageData) {
                    log.error('No imageData in response!', result);
                    throw new Error('No image data returned from server');
                  }
                  // Update the scene images array
                  setSceneImages(prev => prev.map(img =>
                    img.pageNumber === pageNumber ? { ...img, imageData: result.imageData } : img
                  ));
                  log.info('Image regenerated successfully, updated state');
                } catch (error) {
                  log.error('Image regeneration failed:', error);
                  alert(language === 'de'
                    ? 'Bildgenerierung fehlgeschlagen'
                    : language === 'fr'
                    ? 'Échec de la régénération de l\'image'
                    : 'Image regeneration failed');
                } finally {
                  setIsGenerating(false);
                }
              } : undefined}
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
                  log.error('PDF download failed:', error);
                  alert(language === 'de'
                    ? 'PDF-Download fehlgeschlagen'
                    : language === 'fr'
                    ? 'Échec du téléchargement PDF'
                    : 'PDF download failed');
                }
              } : undefined}
              onBuyBook={storyId ? async () => {
                try {
                  log.info('Creating checkout session for story:', storyId);
                  const { url } = await storyService.createCheckoutSession(storyId);
                  if (url) {
                    window.location.href = url;
                  }
                } catch (error) {
                  log.error('Checkout failed:', error);
                  alert(language === 'de'
                    ? 'Checkout fehlgeschlagen. Bitte versuche es erneut.'
                    : language === 'fr'
                    ? 'Échec du paiement. Veuillez réessayer.'
                    : 'Checkout failed. Please try again.');
                }
              } : undefined}
              onPrintBook={storyId ? async () => {
                // Developer mode: direct print without payment
                // First try to load shipping address from database
                let shippingAddress = await authService.getShippingAddress();

                if (!shippingAddress) {
                  // No saved address, ask user to enter one
                  const address = prompt(
                    language === 'de'
                      ? 'Keine Adresse gespeichert. Bitte eingeben (Format: Vorname, Nachname, Strasse, PLZ, Ort, Land, Email):'
                      : language === 'fr'
                      ? 'Aucune adresse enregistrée. Veuillez entrer (Format: Prénom, Nom, Rue, CP, Ville, Pays, Email):'
                      : 'No saved address. Please enter (Format: FirstName, LastName, Street, PostCode, City, Country, Email):'
                  );
                  if (!address) return;

                  const parts = address.split(',').map(p => p.trim());
                  if (parts.length < 7) {
                    alert(language === 'de'
                      ? 'Ungültiges Adressformat'
                      : language === 'fr'
                      ? 'Format d\'adresse invalide'
                      : 'Invalid address format');
                    return;
                  }

                  shippingAddress = {
                    firstName: parts[0],
                    lastName: parts[1],
                    addressLine1: parts[2],
                    postCode: parts[3],
                    city: parts[4],
                    country: parts[5],
                    email: parts[6],
                  };
                }

                // Confirm the address
                const addressSummary = `${shippingAddress.firstName} ${shippingAddress.lastName}\n${shippingAddress.addressLine1}\n${shippingAddress.postCode} ${shippingAddress.city}\n${shippingAddress.country}`;
                const confirmMsg = language === 'de'
                  ? `Druckauftrag an folgende Adresse senden?\n\n${addressSummary}`
                  : language === 'fr'
                  ? `Envoyer la commande à cette adresse?\n\n${addressSummary}`
                  : `Send print order to this address?\n\n${addressSummary}`;

                if (!confirm(confirmMsg)) return;

                try {
                  log.info('Creating print order for story:', storyId);
                  const result = await storyService.createPrintOrder(storyId, {
                    firstName: shippingAddress.firstName,
                    lastName: shippingAddress.lastName,
                    addressLine1: shippingAddress.addressLine1,
                    city: shippingAddress.city,
                    postCode: shippingAddress.postCode,
                    country: shippingAddress.country,
                    email: shippingAddress.email || '',
                  });
                  // Show success message with option to open Gelato dashboard
                  const successMsg = language === 'de'
                    ? `✅ Druckauftrag erfolgreich erstellt!\n\nOrder ID: ${result.orderId}\n${result.isDraft ? '(Entwurf - muss in Gelato bestätigt werden)' : ''}\n\nMöchten Sie das Gelato Dashboard öffnen, um den Auftrag zu verfolgen?`
                    : language === 'fr'
                    ? `✅ Commande d'impression créée avec succès!\n\nID de commande: ${result.orderId}\n${result.isDraft ? '(Brouillon - doit être confirmé dans Gelato)' : ''}\n\nVoulez-vous ouvrir le tableau de bord Gelato pour suivre la commande?`
                    : `✅ Print order created successfully!\n\nOrder ID: ${result.orderId}\n${result.isDraft ? '(Draft - must be confirmed in Gelato)' : ''}\n\nWould you like to open the Gelato dashboard to track your order?`;

                  if (result.dashboardUrl && confirm(successMsg)) {
                    window.open(result.dashboardUrl, '_blank');
                  } else if (!result.dashboardUrl) {
                    alert(language === 'de'
                      ? `✅ Druckauftrag erstellt!\n\nOrder ID: ${result.orderId}`
                      : language === 'fr'
                      ? `✅ Commande créée!\n\nID: ${result.orderId}`
                      : `✅ Print order created!\n\nOrder ID: ${result.orderId}`);
                  }
                } catch (error) {
                  log.error('Print order failed:', error);
                  const errorMsg = error instanceof Error ? error.message : String(error);
                  alert(language === 'de'
                    ? `Druckauftrag fehlgeschlagen:\n${errorMsg}`
                    : language === 'fr'
                    ? `Échec de la commande d'impression:\n${errorMsg}`
                    : `Print order failed:\n${errorMsg}`);
                }
              } : undefined}
              onCreateAnother={() => {
                // Reset story state but keep characters and relationships
                log.info('Creating new story - resetting settings');

                // Clear story ID and URL parameter
                setStoryId(null);
                setJobId(null);
                const newParams = new URLSearchParams(searchParams);
                newParams.delete('storyId');
                setSearchParams(newParams, { replace: true });

                // Reset generated content
                setGeneratedStory('');
                setStoryTitle('');
                setSceneDescriptions([]);
                setSceneImages([]);
                setCoverImages({ frontCover: null, initialPage: null, backCover: null });

                // Reset story settings to defaults
                setStoryType('');
                setArtStyle('pixar');
                setLanguageLevel('standard');
                setPages(30);
                setDedication('');
                setStoryDetails('');

                // Clear localStorage for story settings
                localStorage.removeItem('story_language_level');
                localStorage.removeItem('story_pages');
                localStorage.removeItem('story_dedication');
                localStorage.removeItem('story_details');
                localStorage.removeItem('story_main_characters');

                // Go back to step 1
                setStep(1);
              }}
              onRegenerateCover={storyId ? async (coverType: 'front' | 'back' | 'initial') => {
                try {
                  log.info('Regenerating cover:', coverType);
                  setIsRegenerating(true);
                  const result = await storyService.regenerateCover(storyId, coverType);
                  // Update the cover images with all metadata
                  setCoverImages(prev => {
                    if (!prev) return prev;
                    const key = coverType === 'front' ? 'frontCover' : coverType === 'back' ? 'backCover' : 'initialPage';
                    return { ...prev, [key]: {
                      imageData: result.imageData,
                      description: result.description,
                      prompt: result.prompt,
                      qualityScore: result.qualityScore,
                      qualityReasoning: result.qualityReasoning
                    } };
                  });
                  log.info('Cover regenerated successfully');
                } catch (error) {
                  log.error('Cover regeneration failed:', error);
                  alert(language === 'de'
                    ? 'Cover-Generierung fehlgeschlagen'
                    : language === 'fr'
                    ? 'Échec de la régénération de la couverture'
                    : 'Cover regeneration failed');
                } finally {
                  setIsRegenerating(false);
                }
              } : undefined}
              onEditImage={(pageNumber: number) => {
                setEditTarget({ type: 'image', pageNumber });
                setEditPromptText('');
                setEditModalOpen(true);
              }}
              onEditCover={(coverType: 'front' | 'back' | 'initial') => {
                setEditTarget({ type: 'cover', coverType });
                setEditPromptText('');
                setEditModalOpen(true);
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

      {/* Main content - full width */}
      <div className="px-3 md:px-8 mt-2 md:mt-8 flex-1">
        <div className="md:bg-white md:rounded-2xl md:shadow-xl md:p-8">
          {isLoading && !isGenerating ? (
            <div className="py-12 flex flex-col items-center justify-center">
              <Loader2 className="w-12 h-12 text-indigo-600 animate-spin mb-4" />
              <p className="text-gray-600 font-medium mb-2">
                {language === 'de' ? 'Geschichte wird geladen...' : language === 'fr' ? 'Chargement de l\'histoire...' : 'Loading story...'}
              </p>
              {loadingProgress && (
                <div className="w-64 mt-2">
                  {/* Progress bar */}
                  <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-indigo-600 transition-all duration-300 ease-out"
                      style={{
                        width: loadingProgress.total
                          ? `${Math.min(100, (loadingProgress.loaded / loadingProgress.total) * 100)}%`
                          : '100%'
                      }}
                    />
                  </div>
                  {/* Progress text */}
                  <p className="text-sm text-gray-500 mt-2 text-center">
                    {(loadingProgress.loaded / (1024 * 1024)).toFixed(1)} MB
                    {loadingProgress.total && (
                      <span> ({Math.round((loadingProgress.loaded / loadingProgress.total) * 100)}%)</span>
                    )}
                  </p>
                </div>
              )}
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

      {/* Generation Progress Modal - Full story generation */}
      {isGenerating && (
        <GenerationProgress
          current={generationProgress.current}
          total={generationProgress.total}
          message={generationProgress.message}
        />
      )}

      {/* Simple Regeneration Overlay - Single image/cover */}
      {isRegenerating && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-xl max-w-sm w-full p-6 text-center">
            <div className="relative inline-block mb-4">
              <Loader2 size={40} className="animate-spin text-indigo-600" />
            </div>
            <h3 className="text-lg font-semibold text-gray-800">
              {language === 'de' ? 'Bild wird erstellt...' : language === 'fr' ? 'Création de l\'image...' : 'Generating image...'}
            </h3>
            <p className="text-sm text-gray-500 mt-2">
              {language === 'de' ? 'Dies dauert etwa 30 Sekunden' : language === 'fr' ? 'Cela prend environ 30 secondes' : 'This takes about 30 seconds'}
            </p>
          </div>
        </div>
      )}

      {/* Edit Image Modal */}
      {editModalOpen && editTarget && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-xl max-w-md w-full p-6">
            <h3 className="text-xl font-bold text-gray-800 mb-2">
              {language === 'de' ? 'Bild bearbeiten' : language === 'fr' ? 'Modifier l\'image' : 'Edit Image'}
            </h3>
            <p className="text-sm text-gray-600 mb-4">
              {editTarget.type === 'image'
                ? (language === 'de' ? `Seite ${editTarget.pageNumber}` : language === 'fr' ? `Page ${editTarget.pageNumber}` : `Page ${editTarget.pageNumber}`)
                : (language === 'de'
                    ? (editTarget.coverType === 'front' ? 'Titelseite' : editTarget.coverType === 'back' ? 'Rückseite' : 'Einleitungsseite')
                    : language === 'fr'
                    ? (editTarget.coverType === 'front' ? 'Couverture' : editTarget.coverType === 'back' ? 'Dos' : 'Page de dédicace')
                    : (editTarget.coverType === 'front' ? 'Front Cover' : editTarget.coverType === 'back' ? 'Back Cover' : 'Dedication Page')
                  )
              }
            </p>
            <textarea
              value={editPromptText}
              onChange={(e) => setEditPromptText(e.target.value)}
              placeholder={language === 'de'
                ? 'Beschreibe die gewünschte Änderung...\nz.B. "Mach den Himmel blauer" oder "Füge einen Schmetterling hinzu"'
                : language === 'fr'
                ? 'Décrivez le changement souhaité...\npar ex. "Rendre le ciel plus bleu" ou "Ajouter un papillon"'
                : 'Describe what you want to change...\ne.g. "Make the sky bluer" or "Add a butterfly"'}
              className="w-full h-32 p-3 border-2 border-gray-200 rounded-lg focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 resize-none"
            />
            <div className="flex gap-3 mt-4">
              <button
                onClick={() => {
                  setEditModalOpen(false);
                  setEditTarget(null);
                  setEditPromptText('');
                }}
                className="flex-1 px-4 py-2 border-2 border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 font-medium"
              >
                {language === 'de' ? 'Abbrechen' : language === 'fr' ? 'Annuler' : 'Cancel'}
              </button>
              <button
                onClick={async () => {
                  if (!editPromptText.trim() || !storyId) return;
                  setEditModalOpen(false);
                  setIsRegenerating(true);
                  try {
                    if (editTarget.type === 'image' && editTarget.pageNumber) {
                      const result = await storyService.editImage(storyId, editTarget.pageNumber, editPromptText);
                      log.info('Edit result:', { hasImageData: !!result?.imageData, length: result?.imageData?.length });
                      if (!result?.imageData) {
                        log.error('No imageData in edit response!', result);
                        throw new Error('No image data returned from server');
                      }
                      setSceneImages(prev => prev.map(img =>
                        img.pageNumber === editTarget.pageNumber
                          ? { ...img, imageData: result.imageData }
                          : img
                      ));
                      log.info('Image edited successfully, updated state');
                    } else if (editTarget.type === 'cover' && editTarget.coverType) {
                      const result = await storyService.editCover(storyId, editTarget.coverType, editPromptText);
                      setCoverImages(prev => {
                        if (!prev) return prev;
                        const key = editTarget.coverType === 'front' ? 'frontCover'
                          : editTarget.coverType === 'back' ? 'backCover' : 'initialPage';
                        const current = prev[key];
                        if (typeof current === 'string' || !current) {
                          return { ...prev, [key]: { imageData: result.imageData } };
                        }
                        return { ...prev, [key]: { ...current, imageData: result.imageData } };
                      });
                      log.info('Cover edited successfully');
                    }
                  } catch (error) {
                    log.error('Edit failed:', error);
                    alert(language === 'de'
                      ? 'Bearbeitung fehlgeschlagen. Bitte versuche es erneut.'
                      : language === 'fr'
                      ? 'Échec de la modification. Veuillez réessayer.'
                      : 'Edit failed. Please try again.');
                  } finally {
                    setIsRegenerating(false);
                    setEditTarget(null);
                    setEditPromptText('');
                  }
                }}
                disabled={!editPromptText.trim()}
                className="flex-1 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 font-medium disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {language === 'de' ? 'Bearbeiten' : language === 'fr' ? 'Modifier' : 'Edit'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
