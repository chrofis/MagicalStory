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
import { GenerationProgress, StoryDisplay, ModelSelector } from '@/components/generation';
import type { ModelSelections } from '@/components/generation';
import { EmailVerificationModal } from '@/components/auth/EmailVerificationModal';

// Types
import type { Character, RelationshipMap, RelationshipTextMap, VisualBible } from '@/types/character';
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
  const { isAuthenticated, user, updateCredits, refreshUser, isLoading: isAuthLoading } = useAuth();
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

  // Developer skip options for faster testing
  const [devSkipOutline, setDevSkipOutline] = useState(false);
  const [devSkipText, setDevSkipText] = useState(false);
  const [devSkipSceneDescriptions, setDevSkipSceneDescriptions] = useState(false);
  const [devSkipImages, setDevSkipImages] = useState(false);
  const [devSkipCovers, setDevSkipCovers] = useState(false);

  // Developer model selection (admin only)
  const [modelSelections, setModelSelections] = useState<ModelSelections>({
    outlineModel: null,
    textModel: null,
    sceneDescriptionModel: null,
    imageModel: null,
    coverImageModel: null,
    qualityModel: null,
  });

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
  const [isRegeneratingAvatars, setIsRegeneratingAvatars] = useState(false);

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
  const [excludedCharacters, setExcludedCharacters] = useState<number[]>(() => {
    try {
      const saved = localStorage.getItem('story_excluded_characters');
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
  const [showEmailVerificationModal, setShowEmailVerificationModal] = useState(false);
  const [generationProgress, setGenerationProgress] = useState({ current: 0, total: 0, message: '' });
  const [storyTitle, setStoryTitle] = useState('');
  const [generatedStory, setGeneratedStory] = useState('');
  const [storyOutline, setStoryOutline] = useState(''); // Outline for dev mode display
  const [outlinePrompt, setOutlinePrompt] = useState(''); // API prompt for outline (dev mode)
  const [storyTextPrompts, setStoryTextPrompts] = useState<Array<{ batch: number; startPage: number; endPage: number; prompt: string }>>([]); // API prompts for story text (dev mode)
  const [visualBible, setVisualBible] = useState<VisualBible | null>(null); // Visual Bible for dev mode
  const [sceneDescriptions, setSceneDescriptions] = useState<SceneDescription[]>([]);
  const [sceneImages, setSceneImages] = useState<SceneImage[]>([]);
  const [coverImages, setCoverImages] = useState<CoverImages>({ frontCover: null, initialPage: null, backCover: null });
  const [storyId, setStoryId] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null); // Job ID for tracking/cancellation

  // Partial story state (for stories that failed during generation)
  const [isPartialStory, setIsPartialStory] = useState(false);
  const [failureReason, setFailureReason] = useState<string | undefined>();
  const [generatedPages, setGeneratedPages] = useState<number | undefined>();
  const [totalPages, setTotalPages] = useState<number | undefined>();

  // Progressive story display state (show story while images are generating)
  const [progressiveStoryData, setProgressiveStoryData] = useState<{
    title: string;
    dedication?: string;
    pageTexts: Record<number, string>;
    sceneDescriptions: SceneDescription[];
    totalPages: number;
  } | null>(null);
  const [completedPageImages, setCompletedPageImages] = useState<Record<number, string>>({}); // pageNumber -> imageData

  // Edit modal state
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<{ type: 'image' | 'cover'; pageNumber?: number; coverType?: 'front' | 'back' | 'initial' } | null>(null);
  const [editPromptText, setEditPromptText] = useState('');

  // Redirect if not authenticated, preserving the current URL for after login
  // Wait for auth loading to complete before checking authentication
  // Also check localStorage as backup - state might not have propagated yet after login
  useEffect(() => {
    if (!isAuthLoading && !isAuthenticated) {
      // Check if there's a token in localStorage - auth state might just be slow to update
      const hasToken = !!localStorage.getItem('auth_token');
      if (hasToken) {
        // Token exists but isAuthenticated is false - wait for state to sync
        log.debug('Token found but not authenticated yet, waiting for state sync...');
        return;
      }
      const currentUrl = window.location.pathname + window.location.search;
      const redirectParam = encodeURIComponent(currentUrl);
      navigate(`/?login=true&redirect=${redirectParam}`);
    }
  }, [isAuthenticated, isAuthLoading, navigate]);

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
          log.info('Loaded story:', story.title, story.isPartial ? '(PARTIAL)' : '');
          // Populate story data - set generatedStory BEFORE step to avoid flash
          setStoryId(story.id);
          setStoryTitle(story.title || '');
          setStoryType(story.storyType || '');
          setArtStyle(story.artStyle || 'pixar');
          setStoryOutline(story.outline || '');
          setOutlinePrompt(story.outlinePrompt || '');
          setStoryTextPrompts(story.storyTextPrompts || []);
          // Ensure visualBible has required fields (backward compatibility)
          if (story.visualBible) {
            setVisualBible({
              mainCharacters: story.visualBible.mainCharacters || [],
              secondaryCharacters: story.visualBible.secondaryCharacters || [],
              animals: story.visualBible.animals || [],
              artifacts: story.visualBible.artifacts || [],
              locations: story.visualBible.locations || [],
              changeLog: story.visualBible.changeLog || []
            });
          } else {
            setVisualBible(null);
          }
          setSceneImages(story.sceneImages || []);
          setSceneDescriptions(story.sceneDescriptions || []);
          setCoverImages(story.coverImages || { frontCover: null, initialPage: null, backCover: null });
          setLanguageLevel(story.languageLevel || 'standard');
          setIsGenerating(false);
          // Set partial story fields
          setIsPartialStory(story.isPartial || false);
          setFailureReason(story.failureReason);
          setGeneratedPages(story.generatedPages);
          setTotalPages(story.totalPages);
          // Set generatedStory last, then step, then isLoading - ensures story is ready before showing
          setGeneratedStory(story.story || '');
          setStep(5);
          // Small delay to ensure React has processed all state updates
          setTimeout(() => {
            setIsLoading(false);
            setLoadingProgress(null);
          }, 50);
        } else {
          log.error('Story not found:', urlStoryId);
          setIsLoading(false);
          setLoadingProgress(null);
        }
      } catch (error) {
        log.error('Failed to load story:', error);
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

      // Handle credits payment callback
      const creditsPaymentStatus = searchParams.get('credits_payment');
      if (creditsPaymentStatus === 'success') {
        log.info('Credits payment successful!');
        // Refresh user to get updated credits balance
        await refreshUser();
        const titles = {
          en: 'Credits Added!',
          de: 'Credits hinzugefuegt!',
          fr: 'Credits ajoutes!',
        };
        const messages = {
          en: '100 credits have been added to your account.',
          de: '100 Credits wurden Ihrem Konto gutgeschrieben.',
          fr: '100 credits ont ete ajoutes a votre compte.',
        };
        showSuccess(
          messages[language as keyof typeof messages] || messages.en,
          titles[language as keyof typeof titles] || titles.en
        );

        // Clean up URL parameters
        const newParams = new URLSearchParams(searchParams);
        newParams.delete('credits_payment');
        newParams.delete('session_id');
        setSearchParams(newParams, { replace: true });
      } else if (creditsPaymentStatus === 'cancelled') {
        log.info('Credits payment cancelled by user');
        const messages = {
          en: 'Credits purchase was cancelled.',
          de: 'Kreditkauf wurde abgebrochen.',
          fr: 'L\'achat de credits a ete annule.',
        };
        showInfo(
          messages[language as keyof typeof messages] || messages.en,
          language === 'de' ? 'Abgebrochen' : language === 'fr' ? 'Annule' : 'Cancelled'
        );

        // Clean up URL parameters
        const newParams = new URLSearchParams(searchParams);
        newParams.delete('credits_payment');
        setSearchParams(newParams, { replace: true });
      }
    };

    checkPaymentStatus();
  }, [searchParams, setSearchParams, language, showSuccess, showInfo, refreshUser]);

  // Handle auto-generate after email verification - store as ref to be checked when generateStory is ready
  const pendingAutoGenerate = useRef(false);
  useEffect(() => {
    const autoGenerate = searchParams.get('autoGenerate');
    if (autoGenerate === 'true' && !pendingAutoGenerate.current) {
      pendingAutoGenerate.current = true;

      // Restore story state from localStorage
      const savedStoryType = localStorage.getItem('pending_story_type');
      const savedArtStyle = localStorage.getItem('pending_art_style');
      if (savedStoryType) {
        setStoryType(savedStoryType);
        localStorage.removeItem('pending_story_type');
      }
      if (savedArtStyle) {
        setArtStyle(savedArtStyle);
        localStorage.removeItem('pending_art_style');
      }

      // Navigate to step 4 (will trigger auto-generate once characters are loaded)
      setStep(4);

      // Clear the URL param
      const newParams = new URLSearchParams(searchParams);
      newParams.delete('autoGenerate');
      setSearchParams(newParams, { replace: true });
    }
  }, [searchParams, setSearchParams]);

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
    localStorage.setItem('story_excluded_characters', JSON.stringify(excludedCharacters));
  }, [excludedCharacters]);

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
      traits: {
        strengths: [],
        flaws: [],
        challenges: [],
      },
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
          log.info('Photo analysis complete:', {
            hasPhotos: !!analysis.photos,
            hasPhysical: !!analysis.physical,
            hasClothing: !!analysis.clothing,
            age: analysis.age,
            gender: analysis.gender,
          });

          setCurrentCharacter(prev => {
            if (!prev) return null;

            // Physical traits: always overwrite with new values (except height)
            const newPhysical = analysis.physical ? {
              // Keep height only if already set, otherwise use analysis
              height: prev.physical?.height || analysis.physical.height,
              // Always overwrite other physical traits from photo analysis
              build: analysis.physical.build || prev.physical?.build,
              face: analysis.physical.face || prev.physical?.face,
              hair: analysis.physical.hair || prev.physical?.hair,
              other: analysis.physical.other || prev.physical?.other,
            } : prev.physical;

            return {
              ...prev,
              // Gender: only update if not already set
              gender: prev.gender || (analysis.gender as 'male' | 'female' | 'other') || prev.gender,
              // Age: only update if not already set
              age: prev.age || analysis.age || prev.age,
              // Photos
              photos: {
                original: analysis.photos?.face || originalPhotoUrl,
                face: analysis.photos?.face,
                body: analysis.photos?.body || originalPhotoUrl,
                bodyNoBg: analysis.photos?.bodyNoBg,
                faceBox: analysis.photos?.faceBox,
                bodyBox: analysis.photos?.bodyBox,
              },
              // Physical traits (merged above)
              physical: newPhysical,
              // Clothing from analysis
              clothing: analysis.clothing || prev.clothing,
              // Keep avatars but mark as stale when photo changes (from previous photo)
              avatars: prev.avatars ? { ...prev.avatars, stale: true } : undefined,
            };
          });
        } else {
          log.warn('Photo analysis returned no data, using original photo');
          // Fallback to original photo - mark avatars as stale
          setCurrentCharacter(prev => prev ? {
            ...prev,
            photos: { original: originalPhotoUrl },
            avatars: prev.avatars ? { ...prev.avatars, stale: true } : undefined,
          } : null);
        }
      } catch (error) {
        log.error('Photo analysis error:', error);
        // Fallback to original photo on error - mark avatars as stale
        setCurrentCharacter(prev => prev ? {
          ...prev,
          photos: { original: originalPhotoUrl },
          avatars: prev.avatars ? { ...prev.avatars, stale: true } : undefined,
        } : null);
      } finally {
        setIsAnalyzingPhoto(false);
      }
    };
    reader.readAsDataURL(file);
  };

  // Handler for regenerating avatars from developer mode
  // Uses the robust service function that handles generation + persistence
  const handleRegenerateAvatars = async () => {
    if (!currentCharacter) return;

    // Clear existing avatars in UI
    setCurrentCharacter(prev => prev ? { ...prev, avatars: undefined } : prev);
    setIsRegeneratingAvatars(true);

    try {
      log.info(`🔄 Regenerating avatars for ${currentCharacter.name}...`);

      // Use the robust service function that handles generation + saving
      const result = await characterService.regenerateAvatarsForCharacter(
        currentCharacter.id,
        (status, message) => log.info(`[${status}] ${message}`)
      );

      if (result.success && result.avatars) {
        // Update local state with new avatars (explicitly clear stale flag)
        const freshAvatars = { ...result.avatars, stale: false };
        setCurrentCharacter(prev => prev ? { ...prev, avatars: freshAvatars } : prev);
        setCharacters(prev => prev.map(c =>
          c.id === currentCharacter.id ? { ...c, avatars: freshAvatars } : c
        ));
        log.success(`✅ Avatars regenerated for ${currentCharacter.name}`);
      } else {
        log.error(`❌ Failed to regenerate avatars: ${result.error}`);
        alert(`Failed to regenerate avatars: ${result.error || 'Unknown error'}`);
      }
    } catch (error) {
      log.error(`❌ Failed to regenerate avatars for ${currentCharacter.name}:`, error);
      alert(`Failed to regenerate avatars: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setIsRegeneratingAvatars(false);
    }
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

      // Generate clothing avatars in the background (non-blocking)
      // Only if character has a photo and doesn't already have avatars
      const savedChar = updatedCharacters.find(c => c.id === currentCharacter.id);
      if (savedChar && characterService.needsAvatars(savedChar)) {
        // Fire and forget - the service handles generation + saving
        log.info(`🎨 Starting background avatar generation for ${savedChar.name}...`);
        characterService.generateAndSaveAvatarForCharacter(savedChar).then(result => {
          if (result.success && result.avatars) {
            // Update local state with new avatars
            setCharacters(prev => prev.map(c =>
              c.id === savedChar.id ? { ...c, avatars: result.avatars } : c
            ));
            log.success(`✅ Avatars saved for ${savedChar.name}`);
          } else if (!result.skipped) {
            log.warn(`Avatar generation failed for ${savedChar.name}: ${result.error}`);
          }
        });
      }

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

  // Character role change handler (out/in/main)
  const handleCharacterRoleChange = (charId: number, role: 'out' | 'in' | 'main') => {
    if (role === 'out') {
      // Add to excluded, remove from main
      setExcludedCharacters(prev => prev.includes(charId) ? prev : [...prev, charId]);
      setMainCharacters(prev => prev.filter(id => id !== charId));
    } else if (role === 'in') {
      // Remove from excluded and main
      setExcludedCharacters(prev => prev.filter(id => id !== charId));
      setMainCharacters(prev => prev.filter(id => id !== charId));
    } else if (role === 'main') {
      // Remove from excluded, add to main
      setExcludedCharacters(prev => prev.filter(id => id !== charId));
      setMainCharacters(prev => prev.includes(charId) ? prev : [...prev, charId]);
    }
  };

  // Navigation
  const safeSetStep = async (newStep: number) => {
    if (newStep >= 0 && newStep <= 5) {
      // Auto-save character if leaving step 2 while editing
      if (step === 2 && currentCharacter && newStep !== 2) {
        await saveCharacter();
      }
      // Save relationships when leaving step 3
      if (step === 3 && newStep !== 3) {
        await saveAllCharacterData();
      }
      setStep(newStep);
      // Scroll to top when changing steps
      window.scrollTo(0, 0);
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
    // Step 4: At least one character must be in the story (not excluded) and at least one main character
    if (step === 4) {
      const charactersInStory = characters.filter(c => !excludedCharacters.includes(c.id));
      return charactersInStory.length > 0 && mainCharacters.length > 0;
    }
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
      await safeSetStep(step + 1);
    }
  };

  const goBack = async () => {
    if (step > 0) {
      await safeSetStep(step - 1);
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

  const generateStory = async (overrides?: { skipImages?: boolean }) => {
    // Check email verification before generating (emailVerified could be false or undefined)
    if (user && user.emailVerified !== true) {
      // Store all story state so we can auto-generate after email verification
      localStorage.setItem('pendingStoryGeneration', 'true');
      localStorage.setItem('pending_story_type', storyType);
      localStorage.setItem('pending_art_style', artStyle);
      setShowEmailVerificationModal(true);
      return;
    }

    setIsGenerating(true);
    setStep(5);
    // Reset ALL story state for new generation - must clear old story to show popup
    setGeneratedStory('');
    setStoryTitle('');
    setSceneImages([]);
    setSceneDescriptions([]);
    setProgressiveStoryData(null);
    setCompletedPageImages({});
    setCoverImages({ frontCover: null, initialPage: null, backCover: null });
    // Use 0-100 scale to match server progress
    setGenerationProgress({
      current: 5,
      total: 100,
      message: language === 'de' ? 'Starte Generierung...' : language === 'fr' ? 'Démarrage de la génération...' : 'Starting generation...'
    });

    try {
      // Create the story generation job with developer skip options
      // Filter out excluded characters - only send characters that are in the story
      const charactersForStory = characters.filter(c => !excludedCharacters.includes(c.id));
      const { jobId: newJobId } = await storyService.createStoryJob({
        storyType,
        storyTypeName: getStoryTypeName(),
        artStyle,
        language: language as Language,
        languageLevel,
        pages,
        dedication,
        storyDetails,
        characters: charactersForStory,
        mainCharacters,
        relationships,
        relationshipTexts,
        skipImages: overrides?.skipImages ?? devSkipImages,
        imageGenMode,
        // Developer skip options
        skipOutline: devSkipOutline,
        skipText: devSkipText,
        skipSceneDescriptions: devSkipSceneDescriptions,
        skipCovers: devSkipCovers,
        // Developer model overrides (admin only)
        modelOverrides: user?.role === 'admin' ? {
          outlineModel: modelSelections.outlineModel,
          textModel: modelSelections.textModel,
          sceneDescriptionModel: modelSelections.sceneDescriptionModel,
          imageModel: modelSelections.imageModel,
          coverImageModel: modelSelections.coverImageModel,
          qualityModel: modelSelections.qualityModel,
        } : undefined,
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

        // Update cover images progressively as they become available during streaming
        if (status.partialCovers) {
          let shouldTransitionToDisplay = false;
          setCoverImages(prev => {
            // Merge partial covers with existing, keeping newer data
            const updated = { ...prev };
            if (status.partialCovers?.frontCover && !prev.frontCover) {
              updated.frontCover = status.partialCovers.frontCover;
              log.debug('Front cover received during streaming');
              // Extract and set story title if available
              const frontCover = status.partialCovers.frontCover;
              if (typeof frontCover === 'object' && frontCover?.storyTitle) {
                setStoryTitle(frontCover.storyTitle);
                log.debug(`Story title from front cover: ${frontCover.storyTitle}`);
              }
              // Transition to story display when front cover arrives
              shouldTransitionToDisplay = true;
            }
            if (status.partialCovers?.initialPage && !prev.initialPage) {
              updated.initialPage = status.partialCovers.initialPage;
              log.debug('Initial page cover received during streaming');
            }
            if (status.partialCovers?.backCover && !prev.backCover) {
              updated.backCover = status.partialCovers.backCover;
              log.debug('Back cover received during streaming');
            }
            return updated;
          });
          // Transition to step 5 (StoryDisplay) when front cover is ready
          if (shouldTransitionToDisplay) {
            log.debug('Transitioning to StoryDisplay - front cover ready');
            setStep(5);
          }
        }

        // Update story text for progressive display (text available before images)
        if (status.storyText && !progressiveStoryData) {
          setProgressiveStoryData(status.storyText);
          setStoryTitle(status.storyText.title);
          log.debug(`Story text received: ${status.storyText.totalPages} pages ready for display`);
        }

        // Update completed page images as they become available
        if (status.partialPages && status.partialPages.length > 0) {
          setCompletedPageImages(prev => {
            const updated = { ...prev };
            let newCount = 0;
            status.partialPages?.forEach(page => {
              if (page.imageData && !prev[page.pageNumber]) {
                updated[page.pageNumber] = page.imageData;
                newCount++;
              }
            });
            if (newCount > 0) {
              log.debug(`${newCount} new page images received (total: ${Object.keys(updated).length})`);
            }
            return updated;
          });
        }

        if (status.status === 'completed' && status.result) {
          // Job completed successfully
          setStoryId(status.result.storyId);
          setStoryTitle(status.result.title);
          setStoryOutline(status.result.outline);
          setOutlinePrompt(status.result.outlinePrompt || '');
          setStoryTextPrompts(status.result.storyTextPrompts || []);
          // Ensure visualBible has required fields (backward compatibility)
          if (status.result.visualBible) {
            setVisualBible({
              mainCharacters: status.result.visualBible.mainCharacters || [],
              secondaryCharacters: status.result.visualBible.secondaryCharacters || [],
              animals: status.result.visualBible.animals || [],
              artifacts: status.result.visualBible.artifacts || [],
              locations: status.result.visualBible.locations || [],
              changeLog: status.result.visualBible.changeLog || []
            });
          } else {
            setVisualBible(null);
          }
          setGeneratedStory(status.result.story);
          setSceneDescriptions(status.result.sceneDescriptions || []);
          setSceneImages(status.result.sceneImages || []);
          setCoverImages(status.result.coverImages || { frontCover: null, initialPage: null, backCover: null });
          // Clear progressive state now that we have final data
          setProgressiveStoryData(null);
          setCompletedPageImages({});
          completed = true;

          // Update user's credits in the UI with the new balance
          if (status.currentCredits !== null && status.currentCredits !== undefined) {
            updateCredits(status.currentCredits);
          }

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
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Check for "already in progress" error (409)
      if (errorMessage.includes('already in progress')) {
        // Extract the active job ID if present (format: job_<timestamp>_<random>)
        const jobIdMatch = errorMessage.match(/\|ACTIVE_JOB:(job_[a-z0-9_]+)/i);
        const activeJobId = jobIdMatch ? jobIdMatch[1] : null;

        const cancelMessage = language === 'de'
          ? 'Eine Geschichte wird bereits erstellt. Möchtest du diese abbrechen und eine neue starten?'
          : language === 'fr'
          ? 'Une histoire est déjà en cours de création. Voulez-vous l\'annuler et en commencer une nouvelle?'
          : 'A story is already being generated. Would you like to cancel it and start a new one?';

        if (activeJobId && window.confirm(cancelMessage)) {
          try {
            await storyService.cancelJob(activeJobId);
            log.info('Cancelled existing job:', activeJobId);
            // Retry the generation - await to prevent finally from resetting state
            await generateStory(overrides);
            return;
          } catch (cancelError) {
            log.error('Failed to cancel existing job:', cancelError);
            alert(language === 'de'
              ? 'Abbrechen fehlgeschlagen. Bitte versuche es später erneut.'
              : language === 'fr'
              ? 'Échec de l\'annulation. Veuillez réessayer plus tard.'
              : 'Failed to cancel. Please try again later.');
          }
        }
        // User chose not to cancel - reset generating state
        setIsGenerating(false);
        return;
      } else {
        alert(language === 'de'
          ? `Generierung fehlgeschlagen: ${errorMessage}`
          : language === 'fr'
          ? `Échec de la génération: ${errorMessage}`
          : `Generation failed: ${errorMessage}`);
      }
    } finally {
      setTimeout(() => setIsGenerating(false), 500);
    }
  };

  // Trigger auto-generate if pending (from email verification redirect)
  useEffect(() => {
    if (pendingAutoGenerate.current && isAuthenticated && characters.length > 0 && step === 4 && !isGenerating) {
      pendingAutoGenerate.current = false;
      // Small delay to ensure UI is ready
      setTimeout(() => {
        generateStory();
      }, 500);
    }
  }, [isAuthenticated, characters, step, isGenerating]);

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
                  onRegenerateAvatars={handleRegenerateAvatars}
                  isLoading={isLoading}
                  isAnalyzingPhoto={isAnalyzingPhoto}
                  isRegeneratingAvatars={isRegeneratingAvatars}
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
                onRegenerateAvatars={handleRegenerateAvatars}
                isLoading={isLoading}
                isAnalyzingPhoto={isAnalyzingPhoto}
                isRegeneratingAvatars={isRegeneratingAvatars}
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
            excludedCharacters={excludedCharacters}
            onCharacterRoleChange={handleCharacterRoleChange}
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
        // Show StoryDisplay if we have final story OR progressive data OR front cover during generation
        // This allows transitioning to StoryDisplay as soon as front cover is ready
        if (generatedStory || progressiveStoryData || (isGenerating && coverImages.frontCover)) {
          // Build scene images from progressive data if still generating
          const displaySceneImages = generatedStory
            ? sceneImages
            : Object.entries(completedPageImages).map(([pageNum, imageData]) => ({
                pageNumber: parseInt(pageNum),
                imageData,
                description: progressiveStoryData?.sceneDescriptions.find(s => s.pageNumber === parseInt(pageNum))?.description || ''
              }));

          // Build story text from progressive data if still generating
          const displayStory = generatedStory || Object.entries(progressiveStoryData?.pageTexts || {})
            .sort(([a], [b]) => parseInt(a) - parseInt(b))
            .map(([pageNum, text]) => `--- Page ${pageNum} ---\n${text}`)
            .join('\n\n');

          return (
            <StoryDisplay
              title={storyTitle}
              story={displayStory}
              outline={storyOutline}
              outlinePrompt={outlinePrompt}
              storyTextPrompts={storyTextPrompts}
              visualBible={visualBible || undefined}
              sceneImages={displaySceneImages}
              sceneDescriptions={progressiveStoryData?.sceneDescriptions || sceneDescriptions}
              // Progressive mode props - active when generating (even before story text arrives)
              progressiveMode={isGenerating}
              progressiveData={progressiveStoryData || undefined}
              completedPageImages={completedPageImages}
              coverImages={coverImages}
              languageLevel={languageLevel}
              isGenerating={isGenerating}
              developerMode={developerMode}
              storyId={storyId}
              onVisualBibleChange={storyId ? async (updatedBible) => {
                try {
                  log.info('Updating Visual Bible for story:', storyId);
                  await storyService.updateVisualBible(storyId, updatedBible);
                  setVisualBible(updatedBible);
                  log.success('Visual Bible updated successfully');
                } catch (error) {
                  log.error('Failed to update Visual Bible:', error);
                  alert(language === 'de'
                    ? 'Visual Bible konnte nicht aktualisiert werden'
                    : language === 'fr'
                    ? 'Échec de la mise à jour de la Bible Visuelle'
                    : 'Failed to update Visual Bible');
                }
              } : undefined}
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
                  // Update the scene images array with all returned data (including quality evaluation and previous image)
                  setSceneImages(prev => prev.map(img =>
                    img.pageNumber === pageNumber ? {
                      ...img,
                      imageData: result.imageData,
                      qualityScore: result.qualityScore,
                      qualityReasoning: result.qualityReasoning,
                      totalAttempts: result.totalAttempts,
                      retryHistory: result.retryHistory,
                      wasRegenerated: true,
                      originalImage: result.originalImage,
                      originalScore: result.originalScore,
                      originalReasoning: result.originalReasoning
                    } : img
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
              onAddToBook={storyId ? () => {
                // Add story to selection in sessionStorage
                try {
                  const saved = sessionStorage.getItem('mystories_selected');
                  const selectedIds: string[] = saved ? JSON.parse(saved) : [];
                  if (!selectedIds.includes(storyId)) {
                    selectedIds.push(storyId);
                    sessionStorage.setItem('mystories_selected', JSON.stringify(selectedIds));
                  }
                  log.info('Added story to book selection:', storyId);
                  showSuccess(
                    language === 'de'
                      ? 'Geschichte zum Buch hinzugefügt. Du kannst weitere hinzufügen oder das Buch bestellen.'
                      : language === 'fr'
                      ? 'Histoire ajoutée au livre. Vous pouvez en ajouter d\'autres ou commander le livre.'
                      : 'Story added to book. You can add more or order the book.',
                    language === 'de' ? 'Zum Buch hinzugefügt' : language === 'fr' ? 'Ajouté au livre' : 'Added to Book'
                  );
                  // Navigate to My Stories
                  navigate('/stories');
                } catch (error) {
                  log.error('Failed to add story to selection:', error);
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

                // Reset partial story fields
                setIsPartialStory(false);
                setFailureReason(undefined);
                setGeneratedPages(undefined);
                setTotalPages(undefined);

                // Reset story settings to defaults
                setStoryType('');
                setArtStyle('pixar');
                setLanguageLevel('standard');
                setPages(30);
                setDedication('');
                setStoryDetails('');
                setExcludedCharacters([]);

                // Clear localStorage for story settings
                localStorage.removeItem('story_language_level');
                localStorage.removeItem('story_pages');
                localStorage.removeItem('story_dedication');
                localStorage.removeItem('story_details');
                localStorage.removeItem('story_main_characters');
                localStorage.removeItem('story_excluded_characters');

                // Go back to step 1
                setStep(1);
              }}
              onRegenerateCover={storyId ? async (coverType: 'front' | 'back' | 'initial') => {
                try {
                  log.info('Regenerating cover:', coverType);
                  setIsRegenerating(true);
                  const result = await storyService.regenerateCover(storyId, coverType);
                  // Update the cover images with all metadata (including quality evaluation)
                  setCoverImages(prev => {
                    if (!prev) return prev;
                    const key = coverType === 'front' ? 'frontCover' : coverType === 'back' ? 'backCover' : 'initialPage';
                    return { ...prev, [key]: {
                      imageData: result.imageData,
                      description: result.description,
                      prompt: result.prompt,
                      qualityScore: result.qualityScore,
                      qualityReasoning: result.qualityReasoning,
                      totalAttempts: result.totalAttempts,
                      retryHistory: result.retryHistory
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
              isPartial={isPartialStory}
              failureReason={failureReason}
              generatedPages={generatedPages}
              totalPages={totalPages}
            />
          );
        }
        // If we have a storyId in URL but no story content yet, show loading (story is being fetched)
        const urlStoryId = searchParams.get('storyId');
        if (urlStoryId) {
          return (
            <div className="py-12 flex flex-col items-center justify-center">
              <Loader2 className="w-12 h-12 text-indigo-600 animate-spin mb-4" />
              <p className="text-gray-600 font-medium">
                {language === 'de' ? 'Geschichte wird geladen...' : language === 'fr' ? 'Chargement de l\'histoire...' : 'Loading story...'}
              </p>
            </div>
          );
        }
        // If generating but no content yet, show nothing (popup overlay handles this)
        if (isGenerating) {
          return null;
        }
        return (
          <div className="text-center py-12">
            <Sparkles className="w-16 h-16 text-gray-300 mx-auto mb-4" />
            <h2 className="text-2xl font-bold text-gray-800 mb-4">{t.generateStory}</h2>
            <p className="text-gray-600 mb-6">
              {language === 'de' ? 'Bereit, deine Geschichte zu erstellen!' : language === 'fr' ? 'Prêt à créer votre histoire!' : 'Ready to create your story!'}
            </p>

            <Button onClick={() => generateStory()} size="lg" icon={Sparkles}>
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

                  {/* Developer Skip Options */}
                  {developerMode && (
                    <div className="p-4 bg-orange-50 border border-orange-200 rounded-lg text-left">
                      <h3 className="text-sm font-semibold text-orange-700 mb-3">
                        🛠️ {language === 'de' ? 'Entwickler-Optionen - Schritte überspringen' : language === 'fr' ? 'Options développeur - Sauter des étapes' : 'Developer Options - Skip Steps'}
                      </h3>
                      <div className="space-y-2 text-sm">
                        <label className="flex items-center gap-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={devSkipOutline}
                            onChange={(e) => setDevSkipOutline(e.target.checked)}
                            className="rounded border-orange-300 text-orange-600 focus:ring-orange-500"
                          />
                          <span className="text-gray-700">{language === 'de' ? 'Gliederung überspringen' : language === 'fr' ? 'Sauter le plan' : 'Skip outline generation'}</span>
                        </label>
                        <label className="flex items-center gap-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={devSkipText}
                            onChange={(e) => setDevSkipText(e.target.checked)}
                            className="rounded border-orange-300 text-orange-600 focus:ring-orange-500"
                          />
                          <span className="text-gray-700">{language === 'de' ? 'Text überspringen' : language === 'fr' ? 'Sauter le texte' : 'Skip text generation'}</span>
                        </label>
                        <label className="flex items-center gap-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={devSkipSceneDescriptions}
                            onChange={(e) => setDevSkipSceneDescriptions(e.target.checked)}
                            className="rounded border-orange-300 text-orange-600 focus:ring-orange-500"
                          />
                          <span className="text-gray-700">{language === 'de' ? 'Szenenbeschreibungen überspringen' : language === 'fr' ? 'Sauter les descriptions de scènes' : 'Skip scene descriptions'}</span>
                        </label>
                        <label className="flex items-center gap-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={devSkipImages}
                            onChange={(e) => setDevSkipImages(e.target.checked)}
                            className="rounded border-orange-300 text-orange-600 focus:ring-orange-500"
                          />
                          <span className="text-gray-700">{language === 'de' ? 'Bilder überspringen' : language === 'fr' ? 'Sauter les images' : 'Skip image generation'}</span>
                        </label>
                        <label className="flex items-center gap-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={devSkipCovers}
                            onChange={(e) => setDevSkipCovers(e.target.checked)}
                            className="rounded border-orange-300 text-orange-600 focus:ring-orange-500"
                          />
                          <span className="text-gray-700">{language === 'de' ? 'Cover überspringen' : language === 'fr' ? 'Sauter les couvertures' : 'Skip cover images'}</span>
                        </label>
                      </div>
                      <p className="text-xs text-orange-600 mt-2">
                        {language === 'de' ? 'Hinweis: Übersprungene Schritte verwenden Platzhalter/leere Daten' : language === 'fr' ? 'Note: Les étapes sautées utiliseront des données vides/provisoires' : 'Note: Skipped steps will use placeholder/empty data'}
                      </p>
                    </div>
                  )}

                  {/* Developer Model Selection - Admin only */}
                  {developerMode && user?.role === 'admin' && (
                    <ModelSelector
                      selections={modelSelections}
                      onChange={setModelSelections}
                    />
                  )}

                  <button
                    onClick={() => generateStory()}
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
                      onClick={() => generateStory({ skipImages: true })}
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
      {/* Show until we have content to display (front cover, story data, or final story) */}
      {isGenerating && !generatedStory && !progressiveStoryData && !coverImages.frontCover && (
        <GenerationProgress
          current={generationProgress.current}
          total={generationProgress.total}
          message={generationProgress.message}
          coverImages={coverImages}
          characters={characters}
          jobId={jobId || undefined}
          onCancel={jobId ? async () => {
            try {
              await storyService.cancelJob(jobId);
              log.info('Job cancelled by user');
              setIsGenerating(false);
              setJobId(null);
              setGenerationProgress({ current: 0, total: 0, message: '' });
              alert(language === 'de'
                ? 'Generierung abgebrochen'
                : language === 'fr'
                ? 'Génération annulée'
                : 'Generation cancelled');
            } catch (error) {
              log.error('Failed to cancel job:', error);
              alert(language === 'de'
                ? 'Abbruch fehlgeschlagen'
                : language === 'fr'
                ? 'Échec de l\'annulation'
                : 'Failed to cancel');
            }
          } : undefined}
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
                      log.info('Edit result:', { hasImageData: !!result?.imageData, score: result?.qualityScore });
                      if (!result?.imageData) {
                        log.error('No imageData in edit response!', result);
                        throw new Error('No image data returned from server');
                      }
                      setSceneImages(prev => prev.map(img =>
                        img.pageNumber === editTarget.pageNumber
                          ? {
                              ...img,
                              imageData: result.imageData,
                              qualityScore: result.qualityScore,
                              qualityReasoning: result.qualityReasoning,
                              wasEdited: true,
                              originalImage: result.originalImage,
                              originalScore: result.originalScore,
                              originalReasoning: result.originalReasoning
                            }
                          : img
                      ));
                      log.info('Image edited successfully, updated state with quality info');
                    } else if (editTarget.type === 'cover' && editTarget.coverType) {
                      const result = await storyService.editCover(storyId, editTarget.coverType, editPromptText);
                      setCoverImages(prev => {
                        if (!prev) return prev;
                        const key = editTarget.coverType === 'front' ? 'frontCover'
                          : editTarget.coverType === 'back' ? 'backCover' : 'initialPage';
                        const current = prev[key];
                        const updatedCover = {
                          ...(typeof current === 'object' ? current : {}),
                          imageData: result.imageData,
                          qualityScore: result.qualityScore,
                          qualityReasoning: result.qualityReasoning,
                          wasEdited: true,
                          originalImage: result.originalImage,
                          originalScore: result.originalScore,
                          originalReasoning: result.originalReasoning
                        };
                        return { ...prev, [key]: updatedCover };
                      });
                      log.info('Cover edited successfully with quality info');
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

      {/* Email Verification Modal */}
      <EmailVerificationModal
        isOpen={showEmailVerificationModal}
        onClose={() => setShowEmailVerificationModal(false)}
      />
    </div>
  );
}
