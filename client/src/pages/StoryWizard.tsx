import { useState, useEffect, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useLanguage } from '@/context/LanguageContext';
import { useAuth } from '@/context/AuthContext';
import { useToast } from '@/context/ToastContext';
import { useGeneration } from '@/context/GenerationContext';
import { ArrowLeft, ArrowRight, Loader2, Sparkles } from 'lucide-react';

// Components
import { Button, LoadingSpinner, Navigation, WizardHelperText } from '@/components/common';
import { GenerationProgress, StoryDisplay, ModelSelector } from '@/components/generation';
import type { GenerationSettings } from '@/components/generation/story';
import {
  WizardStep2Characters,
  WizardStep3BookSettings,
  WizardStep4StoryType,
  WizardStep5ArtStyle,
  WizardStep6Summary,
} from './wizard';
import { getCurrentSeason } from './wizard/WizardStep3BookSettings';
import { EmailVerificationModal } from '@/components/auth/EmailVerificationModal';
import { FaceSelectionModal } from '@/components/character';

// Types
import type { Character, RelationshipMap, RelationshipTextMap, VisualBible, ChangedTraits, DetectedFace } from '@/types/character';
import type { LanguageLevel, SceneDescription, SceneImage, StoryLanguageCode, UILanguage, CoverImages, GenerationLogEntry } from '@/types/story';

// Services & Helpers
import { characterService, storyService, authService } from '@/services';
import { storyTypes } from '@/constants/storyTypes';
import { getNotKnownRelationship, isNotKnownRelationship, findInverseRelationship, type CustomRelationshipPair } from '@/constants/relationships';
import { createLogger } from '@/services/logger';
import { useDeveloperMode } from '@/hooks/useDeveloperMode';
import { getAvatarCooldown, recordAvatarRegeneration } from '@/hooks/useAvatarCooldown';

// Create namespaced logger
const log = createLogger('StoryWizard');

// Helper text for each wizard step
const wizardHelperTexts: Record<string, Record<number, string>> = {
  en: {
    1: "Add photos of your characters - they'll appear consistently throughout your story!",
    2: "Set the book length and reading level for your audience",
    3: "Choose an adventure theme or describe your own story idea",
    4: "Pick an illustration style for your book",
    5: "Review your choices, add plot details, then generate your story!",
  },
  de: {
    1: "Füge Fotos deiner Charaktere hinzu - sie erscheinen einheitlich in der gesamten Geschichte!",
    2: "Lege die Buchlänge und das Leseniveau für dein Publikum fest",
    3: "Wähle ein Abenteuer-Thema oder beschreibe deine eigene Story-Idee",
    4: "Wähle einen Illustrationsstil für dein Buch",
    5: "Überprüfe deine Auswahl, füge Handlungsdetails hinzu und generiere deine Geschichte!",
  },
  fr: {
    1: "Ajoutez des photos de vos personnages - ils apparaîtront de manière cohérente dans toute votre histoire!",
    2: "Définissez la longueur du livre et le niveau de lecture pour votre public",
    3: "Choisissez un thème d'aventure ou décrivez votre propre idée d'histoire",
    4: "Choisissez un style d'illustration pour votre livre",
    5: "Vérifiez vos choix, ajoutez des détails de l'intrigue, puis générez votre histoire!",
  },
};

export default function StoryWizard() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { t, language } = useLanguage();
  const { isAuthenticated, user, updateCredits, refreshUser, isLoading: isAuthLoading, isImpersonating } = useAuth();
  const { showSuccess, showInfo, showError } = useToast();
  const { startTracking, stopTracking, activeJob, isComplete: generationComplete, completedStoryId, markCompletionViewed, hasUnviewedCompletion } = useGeneration();

  // Wizard state - start at step 6 with loading if we have a storyId in URL
  // Start at step 1 if ?new=true (creating new story)
  // Otherwise restore from localStorage to preserve step when navigating away and back
  const [step, setStep] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('storyId')) return 6;
    if (params.get('new') === 'true') return 1;  // New story starts at step 1
    const savedStep = localStorage.getItem('wizard_step');
    return savedStep ? parseInt(savedStep, 10) : 1;
  });
  const [isLoading, setIsLoading] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    return !!params.get('storyId');
  });
  const [loadingProgress, setLoadingProgress] = useState<{ loaded: number; total: number | null } | null>(null);
  // Developer mode settings (extracted to hook)
  const {
    developerMode, setDeveloperMode,
    imageGenMode, setImageGenMode,
    generationMode, setGenerationMode,
    devSkipOutline, setDevSkipOutline,
    devSkipText, setDevSkipText,
    devSkipSceneDescriptions, setDevSkipSceneDescriptions,
    devSkipImages, setDevSkipImages,
    devSkipCovers, setDevSkipCovers,
    enableAutoRepair, setEnableAutoRepair,
    modelSelections, setModelSelections,
  } = useDeveloperMode();

  // Story Type & Art Style settings - load from localStorage (used in step 4)
  const [storyType, setStoryType] = useState(() => {
    return localStorage.getItem('story_type') || '';
  });
  // New story category system
  const [storyCategory, setStoryCategory] = useState<'adventure' | 'life-challenge' | 'educational' | 'historical' | 'custom' | ''>(() => {
    return (localStorage.getItem('story_category') || '') as 'adventure' | 'life-challenge' | 'educational' | 'historical' | 'custom' | '';
  });
  const [storyTopic, setStoryTopic] = useState(() => {
    return localStorage.getItem('story_topic') || '';
  });
  const [storyTheme, setStoryTheme] = useState(() => {
    return localStorage.getItem('story_theme') || '';
  });
  const [customThemeText, setCustomThemeText] = useState(() => {
    return localStorage.getItem('story_custom_theme_text') || '';
  });
  const [artStyle, setArtStyle] = useState(() => {
    return localStorage.getItem('story_art_style') || 'watercolor';
  });

  // Characters state (step 1)
  const [characters, setCharacters] = useState<Character[]>([]);
  // Characters saved with the story (for regeneration when viewing saved stories)
  const [storyCharacters, setStoryCharacters] = useState<Array<{ id: number; name: string; photoData?: string }> | null>(null);
  const [currentCharacter, setCurrentCharacter] = useState<Character | null>(null);
  const [showCharacterCreated, setShowCharacterCreated] = useState(false);
  const [characterStep, setCharacterStep] = useState<'photo' | 'name' | 'traits' | 'characteristics' | 'relationships' | 'avatar'>('photo');
  const [isAnalyzingPhoto, setIsAnalyzingPhoto] = useState(false);
  const [isGeneratingAvatar, setIsGeneratingAvatar] = useState(false);  // Background avatar generation
  const [isRegeneratingAvatars, setIsRegeneratingAvatars] = useState(false);
  const [isRegeneratingAvatarsWithTraits, setIsRegeneratingAvatarsWithTraits] = useState(false);
  const [changedTraits, setChangedTraits] = useState<ChangedTraits | undefined>(undefined);
  const [photoAnalysisDebug, setPhotoAnalysisDebug] = useState<{ rawResponse?: string; error?: string } | undefined>(undefined);
  const previousTraitsRef = useRef<{ physical?: Character['physical']; gender?: string; age?: string } | null>(null);

  // Multi-face selection state (when photo has multiple people)
  const [showFaceSelectionModal, setShowFaceSelectionModal] = useState(false);
  const [detectedFaces, setDetectedFaces] = useState<DetectedFace[]>([]);
  const [pendingPhotoData, setPendingPhotoData] = useState<string | null>(null);
  const [pendingClothingToKeep, setPendingClothingToKeep] = useState<Character['clothing'] | null>(null);

  // Relationships state (step 2) - loaded from API with characters
  const [relationships, setRelationships] = useState<RelationshipMap>({});
  const [relationshipTexts, setRelationshipTexts] = useState<RelationshipTextMap>({});
  const [customRelationships, setCustomRelationships] = useState<CustomRelationshipPair[]>([]);
  const relationshipsInitialized = useRef<string | null>(null);
  const dataLoadedFromApi = useRef(false);
  const relationshipsDirty = useRef(false); // Track if relationships were modified
  const [initialCharacterLoadDone, setInitialCharacterLoadDone] = useState(false); // Track if initial API load completed

  // Story Settings state (step 4) - load from localStorage
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
  // Story language (de-ch is default, de-de only selectable here)
  const [storyLanguage, setStoryLanguage] = useState<StoryLanguageCode>(() => {
    try {
      const saved = localStorage.getItem('story_language');
      if (saved && ['de-ch', 'de-de', 'fr', 'en'].includes(saved)) {
        return saved as StoryLanguageCode;
      }
      return 'de-ch'; // Default to Swiss German
    } catch {
      return 'de-ch';
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
  const [isGeneratingIdeas, setIsGeneratingIdeas] = useState(false);
  const [isGeneratingIdea1, setIsGeneratingIdea1] = useState(false);
  const [isGeneratingIdea2, setIsGeneratingIdea2] = useState(false);
  const [lastIdeaPrompt, setLastIdeaPrompt] = useState<{ prompt: string; model: string } | null>(null);
  const [lastIdeaFullResponse, setLastIdeaFullResponse] = useState<string>('');
  const [generatedIdeas, setGeneratedIdeas] = useState<string[]>([]);
  const streamAbortRef = useRef<{ abort: () => void } | null>(null);
  // User's location from IP (for story setting personalization)
  const [userLocation, setUserLocation] = useState<{ city: string | null; region: string | null; country: string | null } | null>(null);
  // Season for story setting (auto-calculated from current date, user can override)
  const [season, setSeason] = useState<string>(() => getCurrentSeason());

  // Step 7: Generation & Display
  const [isGenerating, setIsGenerating] = useState(false); // Full story generation
  const [isRegenerating, setIsRegenerating] = useState(false); // Single image/cover regeneration
  const [isProgressMinimized, setIsProgressMinimized] = useState(false); // Track if progress modal is minimized
  const [showMinimizeDialog, setShowMinimizeDialog] = useState(false); // Show dialog when user clicks minimize
  const [showSingleCharacterDialog, setShowSingleCharacterDialog] = useState(false); // Show dialog when only 1 character
  const [userHasStories, setUserHasStories] = useState(false); // Track if user has existing stories
  const [showEmailVerificationModal, setShowEmailVerificationModal] = useState(false);
  const [generationProgress, setGenerationProgress] = useState({ current: 0, total: 0, message: '' });
  const [imageLoadProgress, setImageLoadProgress] = useState<{ loaded: number; total: number } | null>(null); // Progressive image loading
  const [isProgressStalled, setIsProgressStalled] = useState(false); // Track if generation seems stuck
  const [storyTitle, setStoryTitle] = useState('');
  const [generatedStory, setGeneratedStory] = useState('');
  const [originalStory, setOriginalStory] = useState(''); // Original AI-generated story for restore functionality
  const [storyOutline, setStoryOutline] = useState(''); // Outline for dev mode display
  const [outlinePrompt, setOutlinePrompt] = useState(''); // API prompt for outline (dev mode)
  const [outlineModelId, setOutlineModelId] = useState<string | undefined>(); // Model used for outline (dev mode)
  const [outlineUsage, setOutlineUsage] = useState<{ input_tokens: number; output_tokens: number } | undefined>(); // Token usage for outline (dev mode)
  const [storyTextPrompts, setStoryTextPrompts] = useState<Array<{ batch: number; startPage: number; endPage: number; prompt: string; modelId?: string; usage?: { input_tokens: number; output_tokens: number } }>>([]); // API prompts for story text (dev mode)
  const [visualBible, setVisualBible] = useState<VisualBible | null>(null); // Visual Bible for dev mode
  const [styledAvatarGeneration, setStyledAvatarGeneration] = useState<Array<{
    timestamp: string;
    characterName: string;
    artStyle: string;
    durationMs: number;
    success: boolean;
    error?: string;
    inputs: {
      facePhoto: { identifier: string; sizeKB: number } | null;
      originalAvatar: { identifier: string; sizeKB: number };
    };
    prompt?: string;
    output?: { identifier: string; sizeKB: number };
  }>>([]); // Styled avatar generation log (dev mode)
  const [costumedAvatarGeneration, setCostumedAvatarGeneration] = useState<Array<{
    timestamp: string;
    characterName: string;
    costumeType: string;
    artStyle: string;
    costumeDescription: string;
    durationMs: number;
    success: boolean;
    error?: string;
    inputs: {
      facePhoto: { identifier: string; sizeKB: number; imageData?: string };
      standardAvatar: { identifier: string; sizeKB: number; imageData?: string } | null;
    };
    prompt?: string;
    output?: { identifier: string; sizeKB: number; imageData?: string };
  }>>([]); // Costumed avatar generation log (dev mode)
  const [generationLog, setGenerationLog] = useState<GenerationLogEntry[]>([]); // Generation log (dev mode)
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

  // Saved generation settings (for dev mode - shows what settings were used to generate the story)
  const [savedGenerationSettings, setSavedGenerationSettings] = useState<GenerationSettings | null>(null);
  // Flag to skip server reload when we just finished generating (data is already in state)
  const justFinishedGenerating = useRef(false);

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

  // Fetch user's location from IP for story personalization
  // Also trigger early landmark discovery so landmarks are ready when needed
  useEffect(() => {
    storyService.getUserLocation().then(location => {
      setUserLocation(location);
      // Trigger landmark discovery in background as soon as we have location
      if (location?.city) {
        storyService.triggerLandmarkDiscovery(location.city, location.country);
      }
    });
  }, []);

  // Check if user has existing stories (for minimize dialog options)
  useEffect(() => {
    if (isAuthenticated) {
      storyService.getStories({ limit: 1 }).then(({ pagination }) => {
        setUserHasStories(pagination.total > 0);
      }).catch(() => setUserHasStories(false));
    }
  }, [isAuthenticated]);

  // Track if we've already restored this job to avoid re-fetching
  const restoredJobIdRef = useRef<string | null>(null);

  // Handle returning during active generation or after completion
  useEffect(() => {
    const urlStoryId = searchParams.get('storyId');
    const isNewStory = searchParams.get('new') === 'true';

    // If user explicitly wants a new story, don't redirect them to completed/active story
    if (isNewStory) {
      return;
    }

    // Reset restored job ref when viewing a specific story (allows re-restoration when clicking spinner)
    if (urlStoryId) {
      restoredJobIdRef.current = null;
    }

    // If there's an active job and we haven't restored it yet, restore progressive view
    if (activeJob && !urlStoryId && restoredJobIdRef.current !== activeJob.jobId) {
      log.info('Returning during active generation, restoring progress for job:', activeJob.jobId);
      restoredJobIdRef.current = activeJob.jobId;
      setStep(6);
      setIsGenerating(true);
      setStoryTitle(activeJob.storyTitle);
      setJobId(activeJob.jobId);

      // Fetch current job status to restore partial results
      storyService.getJobStatus(activeJob.jobId).then((status) => {
        log.info('Restored job status:', {
          progress: status.progress,
          hasStoryText: !!status.storyText,
          storyTextKeys: status.storyText ? Object.keys(status.storyText) : [],
          pageTextsCount: status.storyText?.pageTexts ? Object.keys(status.storyText.pageTexts).length : 0,
          partialPages: status.partialPages?.length || 0
        });

        // Update progress
        if (status.progress) {
          setGenerationProgress(status.progress);
        }

        // Restore story text for progressive display
        if (status.storyText) {
          const pageTexts = status.storyText.pageTexts || {};
          log.info('Setting progressiveStoryData with', Object.keys(pageTexts).length, 'pages');
          setProgressiveStoryData({
            title: status.storyText.title || activeJob.storyTitle,
            dedication: status.storyText.dedication,
            pageTexts: pageTexts,
            sceneDescriptions: status.storyText.sceneDescriptions || [],
            totalPages: status.storyText.totalPages || pages,
          });
        } else {
          log.warn('No storyText in job status response');
        }

        // Restore completed page images
        if (status.partialPages && status.partialPages.length > 0) {
          const pageImages: Record<number, string> = {};
          status.partialPages.forEach((page: { pageNumber: number; imageData: string }) => {
            if (page.pageNumber && page.imageData) {
              pageImages[page.pageNumber] = page.imageData;
            }
          });
          log.info('Restored', Object.keys(pageImages).length, 'page images');
          setCompletedPageImages(pageImages);
        }

        // Restore cover images
        if (status.partialCovers) {
          setCoverImages(prev => ({
            frontCover: status.partialCovers?.frontCover || prev.frontCover,
            initialPage: status.partialCovers?.initialPage || prev.initialPage,
            backCover: status.partialCovers?.backCover || prev.backCover,
          }));
        }
      }).catch((err) => {
        log.error('Failed to restore job status:', err);
      });
    }
    // If generation completed and we have a story ID, navigate to it
    if (generationComplete && completedStoryId && !urlStoryId) {
      log.info('Generation completed, navigating to story:', completedStoryId);
      setSearchParams({ storyId: completedStoryId }, { replace: true });
    }
  }, [activeJob, generationComplete, completedStoryId, searchParams, setSearchParams, pages]);

  // Reset story settings when ?new=true is present (from "Create New Story" button)
  useEffect(() => {
    const isNewStory = searchParams.get('new') === 'true';
    if (isNewStory) {
      log.info('New story requested - resetting all story settings');

      // Reset story settings state
      setStoryType('');
      setStoryCategory('' as 'adventure' | 'life-challenge' | 'educational' | 'historical' | 'custom' | '');
      setStoryTopic('');
      setStoryTheme('');
      setCustomThemeText('');
      setArtStyle('watercolor');
      setLanguageLevel('standard');
      setPages(30);
      setDedication('');
      setStoryDetails('');
      setMainCharacters([]);
      setExcludedCharacters([]);
      setStoryCharacters(null);

      // Clear localStorage for story settings
      localStorage.removeItem('story_type');
      localStorage.removeItem('story_category');
      localStorage.removeItem('story_topic');
      localStorage.removeItem('story_theme');
      localStorage.removeItem('story_custom_theme_text');
      localStorage.removeItem('story_art_style');
      localStorage.removeItem('story_language_level');
      localStorage.removeItem('story_pages');
      localStorage.removeItem('story_dedication');
      localStorage.removeItem('story_details');
      localStorage.removeItem('story_main_characters');
      localStorage.removeItem('story_excluded_characters');
      localStorage.removeItem('wizard_step');

      // Remove the 'new' param from URL to avoid resetting on refresh
      const newParams = new URLSearchParams(searchParams);
      newParams.delete('new');
      setSearchParams(newParams, { replace: true });

      // Clear any character being edited and reset to character list
      setCurrentCharacter(null);
      setCharacterStep('photo');

      // Ensure we're on step 1
      setStep(1);
    }
  }, [searchParams, setSearchParams]);

  // Load saved story from URL parameter - uses progressive loading for better UX
  useEffect(() => {
    const urlStoryId = searchParams.get('storyId');
    // Ensure step is 6 when viewing a saved story (even if localStorage has a different step)
    if (urlStoryId && step !== 6) {
      setStep(6);
    }

    const loadSavedStory = async () => {
      if (!urlStoryId || !isAuthenticated) return;

      // Skip server reload if we just finished generating - data is already in state
      if (justFinishedGenerating.current) {
        justFinishedGenerating.current = false;
        log.info('Skipping story reload - just finished generating');
        return;
      }

      log.info('Loading saved story progressively:', urlStoryId);
      setIsLoading(true);
      setLoadingProgress(null);
      setImageLoadProgress(null);

      try {
        await storyService.getStoryProgressively(
          urlStoryId,
          // Step 1: Metadata loaded - show story immediately (no images yet)
          (story, totalImages) => {
            log.info('Metadata loaded:', story.title, `(${totalImages} images to load)`);

            // Populate story data
            setStoryId(story.id);
            setStoryTitle(story.title || '');
            setStoryType(story.storyType || '');
            setArtStyle(story.artStyle || 'pixar');
            setStoryOutline(story.outline || '');
            setOutlinePrompt(story.outlinePrompt || '');
            setOutlineModelId(story.outlineModelId);
            setOutlineUsage(story.outlineUsage);
            setStoryTextPrompts(story.storyTextPrompts || []);
            setStyledAvatarGeneration(story.styledAvatarGeneration || []);
            setCostumedAvatarGeneration(story.costumedAvatarGeneration || []);
            // Note: generationLog is loaded from devMetadata, not from story metadata
            // Don't overwrite here - it would clear entries set from job result
            if (story.generationLog?.length) {
              console.log('[StoryWizard] Loading story metadata, generationLog:', story.generationLog.length, 'entries');
              setGenerationLog(story.generationLog);
            }

            // Visual Bible
            if (story.visualBible) {
              setVisualBible({
                mainCharacters: story.visualBible.mainCharacters || [],
                secondaryCharacters: story.visualBible.secondaryCharacters || [],
                animals: story.visualBible.animals || [],
                artifacts: story.visualBible.artifacts || [],
                locations: story.visualBible.locations || [],
                vehicles: story.visualBible.vehicles || [],
                clothing: story.visualBible.clothing || [],
                changeLog: story.visualBible.changeLog || []
              });
            } else {
              setVisualBible(null);
            }

            // Scene images (without imageData - will be loaded progressively)
            setSceneImages(story.sceneImages || []);
            setSceneDescriptions(story.sceneDescriptions || []);
            setCoverImages(story.coverImages || { frontCover: null, initialPage: null, backCover: null });
            setLanguageLevel(story.languageLevel || 'standard');
            // Set story language for correct display labels (Page/Seite/etc)
            if (story.language) {
              setStoryLanguage(story.language);
            }
            setIsGenerating(false);

            // Partial story fields
            setIsPartialStory(story.isPartial || false);
            setFailureReason(story.failureReason);
            setGeneratedPages(story.generatedPages);
            setTotalPages(story.totalPages);

            // Story text
            setGeneratedStory(story.story || '');
            setOriginalStory(story.originalStory || story.story || '');

            // Save generation settings for dev mode display
            setSavedGenerationSettings({
              storyCategory: story.storyCategory,
              storyTopic: story.storyTopic,
              storyTheme: story.storyTheme,
              storyTypeName: story.storyTypeName,
              storyDetails: story.storyDetails,
              artStyle: story.artStyle,
              language: story.language,
              languageLevel: story.languageLevel,
              pages: story.pages,
              dedication: story.dedication,
              characters: story.characters?.map(c => ({
                id: c.id,
                name: c.name,
                isMain: story.mainCharacters?.includes(c.id)
              })),
              mainCharacters: story.mainCharacters,
              relationships: story.relationships,
              relationshipTexts: story.relationshipTexts,
              season: story.season,
              userLocation: story.userLocation,
            });

            // Store story's characters for regeneration (these are the characters used when the story was created)
            if (story.characters?.length) {
              setStoryCharacters(story.characters.map((c: any) => ({
                id: c.id,
                name: c.name,
                photoData: c.photoData || c.photos?.face || c.photos?.original
              })));
            }

            // Show the story view immediately - images will load progressively
            setStep(6);
            setIsLoading(false);
            setLoadingProgress(null);

            // Start image progress tracking
            if (totalImages > 0) {
              setImageLoadProgress({ loaded: 0, total: totalImages });
            }

            // In developer mode or when impersonating, fetch additional dev metadata (prompts, quality reasoning, etc.)
            if (developerMode || isImpersonating) {
              storyService.getStoryDevMetadata(urlStoryId).then(devMetadata => {
                if (devMetadata) {
                  // Merge dev metadata into sceneImages
                  if (devMetadata.sceneImages?.length) {
                    setSceneImages(prev => prev.map(img => {
                      const devData = devMetadata.sceneImages.find(d => d.pageNumber === img.pageNumber);
                      if (devData) {
                        return {
                          ...img,
                          prompt: devData.prompt ?? img.prompt,
                          qualityReasoning: devData.qualityReasoning ?? img.qualityReasoning,
                          retryHistory: devData.retryHistory ?? img.retryHistory,
                          repairHistory: devData.repairHistory ?? img.repairHistory,
                          wasRegenerated: devData.wasRegenerated ?? img.wasRegenerated,
                          originalScore: devData.originalScore ?? img.originalScore,
                          originalReasoning: devData.originalReasoning ?? img.originalReasoning,
                          totalAttempts: devData.totalAttempts ?? img.totalAttempts,
                          faceEvaluation: devData.faceEvaluation ?? img.faceEvaluation,
                          referencePhotos: devData.referencePhotos ?? img.referencePhotos,
                        };
                      }
                      return img;
                    }));
                  }
                  // Merge dev metadata into coverImages
                  if (devMetadata.coverImages) {
                    setCoverImages(prev => {
                      const updated = { ...prev };
                      const coverTypes = ['frontCover', 'initialPage', 'backCover'] as const;
                      for (const coverType of coverTypes) {
                        const devCover = devMetadata.coverImages?.[coverType];
                        const currentCover = prev[coverType];
                        if (devCover && typeof currentCover === 'object' && currentCover !== null) {
                          updated[coverType] = {
                            ...currentCover,
                            prompt: devCover.prompt ?? currentCover.prompt,
                            qualityReasoning: devCover.qualityReasoning ?? currentCover.qualityReasoning,
                            retryHistory: devCover.retryHistory ?? currentCover.retryHistory,
                            referencePhotos: devCover.referencePhotos ?? currentCover.referencePhotos,
                          };
                        }
                      }
                      return updated;
                    });
                  }
                  // Load generation log from dev metadata
                  console.log('[StoryWizard] Dev metadata generationLog:', devMetadata.generationLog?.length || 0, 'entries');
                  if (devMetadata.generationLog?.length) {
                    setGenerationLog(devMetadata.generationLog);
                  }
                  // Load styled avatar generation log from dev metadata
                  if (devMetadata.styledAvatarGeneration?.length) {
                    console.log('[StoryWizard] Dev metadata styledAvatarGeneration:', devMetadata.styledAvatarGeneration.length, 'entries');
                    setStyledAvatarGeneration(devMetadata.styledAvatarGeneration);
                  }
                  // Load costumed avatar generation log from dev metadata
                  if (devMetadata.costumedAvatarGeneration?.length) {
                    console.log('[StoryWizard] Dev metadata costumedAvatarGeneration:', devMetadata.costumedAvatarGeneration.length, 'entries');
                    setCostumedAvatarGeneration(devMetadata.costumedAvatarGeneration);
                  }
                  log.debug('Dev metadata merged into story');
                }
              }).catch(err => {
                log.warn('Failed to load dev metadata:', err);
              });
            }
          },
          // Step 2: Each image loaded - update state progressively
          (pageNumber, imageData, imageVersions, loadedCount) => {
            if (typeof pageNumber === 'number') {
              // Page image
              setSceneImages(prev => prev.map(img =>
                img.pageNumber === pageNumber
                  ? { ...img, imageData, imageVersions: imageVersions as typeof img.imageVersions }
                  : img
              ));
            } else {
              // Cover image
              const coverType = pageNumber as 'frontCover' | 'initialPage' | 'backCover';
              setCoverImages(prev => {
                const current = prev[coverType];
                if (typeof current === 'object' && current !== null) {
                  return { ...prev, [coverType]: { ...current, imageData } };
                }
                return { ...prev, [coverType]: imageData };
              });
            }

            // Update progress
            if (loadedCount !== undefined) {
              setImageLoadProgress(prev => prev ? { ...prev, loaded: loadedCount } : null);
            }
          },
          // Step 3: All images loaded
          () => {
            log.info('All images loaded');
            setImageLoadProgress(null);
          }
        );
      } catch (error) {
        log.error('Failed to load story:', error);
        setIsLoading(false);
        setLoadingProgress(null);
        setImageLoadProgress(null);
      }
    };

    loadSavedStory();
  }, [searchParams, isAuthenticated]);

  // Clear "Fertig!" notification when viewing story (step 6)
  // This stops the blinking badge in navigation when user is already viewing the story
  useEffect(() => {
    if (step === 6 && hasUnviewedCompletion) {
      log.info('Clearing unviewed completion - user is viewing story');
      markCompletionViewed();
    }
  }, [step, hasUnviewedCompletion, markCompletionViewed]);

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

      // Navigate to step 6 (summary) to continue after email verification
      setStep(6);

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
        // Always load lightweight data initially (only standard avatar)
        // Full avatar variants are loaded on-demand when needed
        const data = await characterService.getCharacterData(false);
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
        setInitialCharacterLoadDone(true); // Mark that we've attempted to load characters
      }
    };

    // Always load characters even when viewing a saved story (storyId in URL)
    // This ensures user can navigate back to step 1 and see their saved characters
    // instead of being prompted to create new ones with terms acceptance
    if (isAuthenticated) {
      loadCharacterData();
    } else if (!isAuthLoading) {
      // Not authenticated and auth is done loading - mark as done (no characters to load)
      setInitialCharacterLoadDone(true);
    }
    // Note: developerMode removed from deps to avoid reload on toggle
    // A separate effect below handles reloading when dev mode is enabled
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated, isAuthLoading]);

  // NOTE: Removed auto-reload of full avatar data for dev mode and impersonation
  // Full avatar variants (winter, summer, formal, styledAvatars) are now loaded on-demand
  // to avoid 30+ MB payload on initial page load. Standard avatar is always available.

  // Auto-start character creation when entering step 1 with no characters
  // Wait for initial load to complete to avoid creating blank characters on refresh
  useEffect(() => {
    if (step === 1 && characters.length === 0 && !currentCharacter && !isLoading && initialCharacterLoadDone) {
      startNewCharacter();
    }
  }, [step, characters.length, currentCharacter, isLoading, initialCharacterLoadDone]);

  // Note: Relationships are now saved with characters to the API, not localStorage

  // Persist Story Settings (step 4) to localStorage
  useEffect(() => {
    localStorage.setItem('story_main_characters', JSON.stringify(mainCharacters));
  }, [mainCharacters]);

  useEffect(() => {
    localStorage.setItem('story_excluded_characters', JSON.stringify(excludedCharacters));
  }, [excludedCharacters]);

  // Clear generated ideas when character roles change (excluded/main)
  // Ideas may reference characters that are no longer in the story
  const prevExcludedRef = useRef<number[]>(excludedCharacters);
  useEffect(() => {
    // Only clear if excludedCharacters actually changed (not on initial mount)
    if (prevExcludedRef.current !== excludedCharacters &&
        JSON.stringify(prevExcludedRef.current) !== JSON.stringify(excludedCharacters)) {
      setGeneratedIdeas([]);
      setStoryDetails('');
      prevExcludedRef.current = excludedCharacters;
    }
  }, [excludedCharacters]);

  useEffect(() => {
    localStorage.setItem('story_language_level', languageLevel);
  }, [languageLevel]);

  useEffect(() => {
    localStorage.setItem('story_language', storyLanguage);
  }, [storyLanguage]);

  useEffect(() => {
    localStorage.setItem('story_pages', pages.toString());
  }, [pages]);

  useEffect(() => {
    localStorage.setItem('story_dedication', dedication);
  }, [dedication]);

  useEffect(() => {
    localStorage.setItem('story_details', storyDetails);
  }, [storyDetails]);

  // Persist Story Type settings (step 4) to localStorage
  useEffect(() => {
    localStorage.setItem('story_type', storyType);
  }, [storyType]);

  useEffect(() => {
    if (storyCategory) {
      localStorage.setItem('story_category', storyCategory);
    } else {
      localStorage.removeItem('story_category');
    }
  }, [storyCategory]);

  useEffect(() => {
    if (storyTopic) {
      localStorage.setItem('story_topic', storyTopic);
    } else {
      localStorage.removeItem('story_topic');
    }
  }, [storyTopic]);

  useEffect(() => {
    if (storyTheme) {
      localStorage.setItem('story_theme', storyTheme);
    } else {
      localStorage.removeItem('story_theme');
    }
  }, [storyTheme]);

  useEffect(() => {
    if (customThemeText) {
      localStorage.setItem('story_custom_theme_text', customThemeText);
    } else {
      localStorage.removeItem('story_custom_theme_text');
    }
  }, [customThemeText]);

  // Clear story details (plot) when story category, topic, or theme changes
  // This prevents stale plot from being used with a new category/topic selection
  const prevCategoryRef = useRef(storyCategory);
  const prevTopicRef = useRef(storyTopic);
  const prevThemeRef = useRef(storyTheme);
  const isInitialMountRef = useRef(true);
  useEffect(() => {
    // Skip on initial mount to avoid clearing restored localStorage data
    if (isInitialMountRef.current) {
      isInitialMountRef.current = false;
      return;
    }

    // Clear if any of these changed (including when going back to empty for re-selection)
    const categoryChanged = prevCategoryRef.current !== storyCategory;
    const topicChanged = prevTopicRef.current !== storyTopic;
    const themeChanged = prevThemeRef.current !== storyTheme;

    if (categoryChanged || topicChanged || themeChanged) {
      setStoryDetails('');
      localStorage.removeItem('story_details');
      // Clear generated story ideas when topic/theme changes to avoid confusion
      setGeneratedIdeas([]);
    }

    // Update refs
    prevCategoryRef.current = storyCategory;
    prevTopicRef.current = storyTopic;
    prevThemeRef.current = storyTheme;
  }, [storyCategory, storyTopic, storyTheme]);

  useEffect(() => {
    localStorage.setItem('story_art_style', artStyle);
  }, [artStyle]);

  // Pre-generate story ideas when user reaches step 4 (art style) if we have enough info
  // This way ideas are ready by the time they reach step 5 (summary)
  const preGenerateIdeasRef = useRef(false);
  useEffect(() => {
    // Only trigger once per session when conditions are met
    if (step === 4 && !preGenerateIdeasRef.current && !isGeneratingIdeas && generatedIdeas.length === 0) {
      // Check if we have enough data to generate ideas
      const hasCategory = !!storyCategory;
      const hasThemeOrTopic = !!storyTheme || !!storyTopic;
      const hasCharacters = characters.length > 0;

      if (hasCategory && hasThemeOrTopic && hasCharacters) {
        preGenerateIdeasRef.current = true;
        log.info('[StoryWizard] Pre-generating story ideas while user selects art style');
        generateIdeas();
      }
    }
    // Reset the ref when category/topic/theme changes
    if (preGenerateIdeasRef.current && generatedIdeas.length === 0) {
      preGenerateIdeasRef.current = false;
    }
  }, [step, storyCategory, storyTheme, storyTopic, characters.length, isGeneratingIdeas, generatedIdeas.length]);

  // Safety timeout: reset isGeneratingIdeas if stuck for too long (e.g., server deploy)
  useEffect(() => {
    if (!isGeneratingIdeas) return;

    const SAFETY_TIMEOUT_MS = 150000; // 2.5 minutes (slightly longer than stream timeout)
    const timeoutId = setTimeout(() => {
      log.warn('[StoryWizard] Safety timeout - resetting isGeneratingIdeas after 2.5 minutes');
      setIsGeneratingIdeas(false);
      setIsGeneratingIdea1(false);
      setIsGeneratingIdea2(false);
      showError(language === 'de'
        ? 'Zeitüberschreitung bei der Ideengenerierung. Bitte versuchen Sie es erneut.'
        : language === 'fr'
        ? 'Délai d\'attente de génération d\'idées. Veuillez réessayer.'
        : 'Idea generation timed out. Please try again.');
    }, SAFETY_TIMEOUT_MS);

    return () => clearTimeout(timeoutId);
  }, [isGeneratingIdeas, language]);

  // Persist wizard step to localStorage (so navigating away and back preserves position)
  useEffect(() => {
    // Only persist steps 1-5, not step 6 (which is story viewing/generation)
    if (step >= 1 && step <= 5) {
      localStorage.setItem('wizard_step', step.toString());
    }
  }, [step]);

  // Handler for story category change - doesn't auto-advance, user must select theme/topic
  const handleCategoryChange = (category: 'adventure' | 'life-challenge' | 'educational' | 'historical' | 'custom' | '') => {
    setStoryCategory(category);
    // Don't auto-advance - user needs to select theme/topic next
  };

  // Handler for story theme change - auto-advances only at final step
  const handleThemeChange = (theme: string) => {
    setStoryTheme(theme);
    // Adventure: advance when theme is selected (this IS the final step)
    if (storyCategory === 'adventure' && theme !== '') {
      safeSetStep(4);
    }
    // Life-challenge/Educational: advance when a non-realistic setting is selected
    // Only advance if topic is already set AND theme is not 'realistic'
    // 'realistic' means user wants to go back to theme selection, not advance
    else if ((storyCategory === 'life-challenge' || storyCategory === 'educational') && storyTopic !== '' && theme !== '' && theme !== 'realistic') {
      safeSetStep(4);
    }
  };

  // Handler for story topic change - doesn't auto-advance, user still needs to select setting
  const handleTopicChange = (topic: string) => {
    setStoryTopic(topic);
    // Don't auto-advance - user still needs to select a setting next
  };

  // Handler for art style selection - sets style and auto-advances
  const handleArtStyleSelect = (style: string) => {
    setArtStyle(style);
    // Always advance to step 5 (Summary) when user clicks any art style
    safeSetStep(5);
  };

  // Initialize relationships when moving to step 2 (only once per character set)
  // Wait until not loading to ensure API data is loaded first
  useEffect(() => {
    if (step === 2 && characters.length >= 2 && !isLoading) {
      // Create a key based on character IDs to detect if characters changed
      const charKey = characters.map(c => c.id).sort().join('-');

      if (!relationshipsInitialized.current || relationshipsInitialized.current !== charKey) {
        const lang = language as UILanguage;
        const notKnown = getNotKnownRelationship(lang);
        log.debug('Initializing relationships for step 2', { charKey, existingCount: Object.keys(relationships).length });

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

  // Get character with the most undefined relationships (for warning message)
  const getCharacterWithMostUndefinedRelationships = (): Character | null => {
    if (characters.length < 2) return null;

    let maxUndefined = 0;
    let charWithMostUndefined: Character | null = null;

    for (const char of characters) {
      let undefinedCount = 0;
      for (const otherChar of characters) {
        if (char.id !== otherChar.id) {
          const key = `${char.id}-${otherChar.id}`;
          const value = relationships[key];
          if (!value || isNotKnownRelationship(value)) {
            undefinedCount++;
          }
        }
      }
      if (undefinedCount > maxUndefined) {
        maxUndefined = undefinedCount;
        charWithMostUndefined = char;
      }
    }

    return charWithMostUndefined;
  };

  // Character handlers
  const startNewCharacter = () => {
    setCurrentCharacter({
      id: Date.now(),
      name: '',
      gender: undefined as unknown as 'male' | 'female' | 'other',  // Blank - let photo analysis fill
      age: '',  // Blank - let photo analysis fill
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

  const handlePhotoSelect = async (file: File, keepOldClothing?: boolean) => {
    log.info(`📸 handlePhotoSelect called: file=${file?.name}, character=${currentCharacter?.name}, developerMode=${developerMode}`);

    // Check cooldown for existing characters with avatars (developers exempt)
    if (currentCharacter && !developerMode) {
      const hasAvatars = !!(currentCharacter.avatars?.winter || currentCharacter.avatars?.standard || currentCharacter.avatars?.summer || currentCharacter.avatars?.hasFullAvatars);
      log.info(`📸 hasAvatars=${hasAvatars}`);
      if (hasAvatars) {
        const cooldown = getAvatarCooldown(currentCharacter.id);
        log.info(`📸 cooldown check: canRegenerate=${cooldown.canRegenerate}, waitSeconds=${cooldown.waitSeconds}`);
        if (!cooldown.canRegenerate) {
          const waitMsg = language === 'de'
            ? `Bitte warten Sie ${cooldown.waitSeconds} Sekunden, bevor Sie ein neues Foto hochladen.`
            : `Please wait ${cooldown.waitSeconds} seconds before uploading a new photo.`;
          showError(waitMsg);
          return;
        }
        // Record this attempt (will trigger cooldown for next upload)
        recordAvatarRegeneration(currentCharacter.id);
      }
    }

    // Store clothing preference for use after photo analysis
    const clothingToKeep = keepOldClothing && currentCharacter?.clothing?.structured
      ? { ...currentCharacter.clothing.structured }
      : null;

    const reader = new FileReader();
    reader.onload = async (e) => {
      const originalPhotoUrl = e.target?.result as string;

      // Store previous traits for comparison (before analysis overwrites them)
      if (currentCharacter) {
        previousTraitsRef.current = {
          physical: currentCharacter.physical,
          gender: currentCharacter.gender,
          age: currentCharacter.age,
        };
      }
      // Clear changed traits indicator when starting new analysis
      setChangedTraits(undefined);

      // Start analyzing - don't show photo yet
      setIsAnalyzingPhoto(true);
      // Navigation after photo analysis depends on whether this is first photo or re-upload:
      // - First photo (no name): go to 'name' step
      // - Re-upload (has name): go to 'traits' step so user sees avatar regenerating
      if (!currentCharacter?.name || currentCharacter.name.trim().length < 2) {
        setCharacterStep('name');
      } else {
        // Character already has a name - this is a re-upload, go to traits to show avatar
        setCharacterStep('traits');
        log.info(`📸 Character has name, going to traits step to show avatar regeneration`);
      }

      // Run photo analysis
      try {
        // Resize image before sending to server (reduces upload time significantly)
        const resizedPhoto = await resizeImage(originalPhotoUrl);
        const originalSize = Math.round(originalPhotoUrl.length / 1024);
        const resizedSize = Math.round(resizedPhoto.length / 1024);
        log.info(`Starting photo analysis... (${originalSize}KB -> ${resizedSize}KB)`);
        const analysis = await characterService.analyzePhoto(resizedPhoto, language);

        if (analysis.success) {
          // Check if multiple faces were detected - show selection modal
          if (analysis.multipleFacesDetected && analysis.faces && analysis.faces.length > 1) {
            log.info(`Multiple faces detected (${analysis.faces.length}), showing selection modal`);
            setPendingPhotoData(resizedPhoto);
            setPendingClothingToKeep(clothingToKeep ? { structured: clothingToKeep } : null);
            setDetectedFaces(analysis.faces);
            setShowFaceSelectionModal(true);
            setIsAnalyzingPhoto(false);
            return; // Wait for user to select a face
          }

          log.info('Photo analysis complete:', {
            hasPhotos: !!analysis.photos,
            hasPhysical: !!analysis.physical,
            hasClothing: !!analysis.clothing,
            age: analysis.age,
            gender: analysis.gender,
          });

          // Store debug info for UI display (dev mode)
          if (analysis._debug) {
            setPhotoAnalysisDebug(analysis._debug);
            if (analysis._debug.rawResponse && import.meta.env.DEV) {
              console.log('📸 [DEBUG] Raw Gemini response:', analysis._debug.rawResponse);
            }
            if (analysis._debug.error) {
              console.warn('📸 [DEBUG] Gemini error:', analysis._debug.error);
            }
          }

          // Photo analysis now only returns face/body crops
          // Physical traits and clothing are extracted during avatar evaluation

          // Build the updated photos object ONCE so we can use it for both state and avatar generation
          const updatedPhotos = {
            original: analysis.photos?.face || originalPhotoUrl,
            face: analysis.photos?.face,
            body: analysis.photos?.body || originalPhotoUrl,
            bodyNoBg: analysis.photos?.bodyNoBg,
            faceBox: analysis.photos?.faceBox,
            bodyBox: analysis.photos?.bodyBox,
          };

          // DEBUG: Log photo sizes to verify correct image is used
          const bodyNoBgSize = analysis.photos?.bodyNoBg ? Math.round(analysis.photos.bodyNoBg.length / 1024) : 0;
          const bodySize = analysis.photos?.body ? Math.round(analysis.photos.body.length / 1024) : 0;
          const faceSize = analysis.photos?.face ? Math.round(analysis.photos.face.length / 1024) : 0;
          log.info(`📸 [PHOTO CHANGE] Analysis returned: bodyNoBg=${bodyNoBgSize}KB, body=${bodySize}KB, face=${faceSize}KB`);
          if (analysis.photos?.bodyNoBg) {
            const fp = analysis.photos.bodyNoBg.substring(analysis.photos.bodyNoBg.indexOf('base64,') + 7, analysis.photos.bodyNoBg.indexOf('base64,') + 27);
            log.info(`📸 [PHOTO CHANGE] bodyNoBg fingerprint: ${fp}...`);
          }

          // Build clothing updates
          let updatedClothing: Character['clothing'] = undefined;
          let updatedClothingSource: Character['clothingSource'] = undefined;

          if (clothingToKeep) {
            // User chose to keep old clothing - mark as user-edited so it gets sent to API
            updatedClothing = { structured: clothingToKeep };
            updatedClothingSource = {
              upperBody: clothingToKeep.upperBody ? 'user' : undefined,
              lowerBody: clothingToKeep.lowerBody ? 'user' : undefined,
              shoes: clothingToKeep.shoes ? 'user' : undefined,
              fullBody: clothingToKeep.fullBody ? 'user' : undefined,
            };
            log.info(`👕 Keeping old clothing (marked as user-edited): ${JSON.stringify(clothingToKeep)}`);
          } else {
            // User chose new photo's clothing - clear existing so it gets extracted from new photo
            log.info(`👕 Using new photo's clothing (cleared existing)`);
          }

          // Build character for avatar generation BEFORE state update
          // (React state updates are async, so we build the object we need now)
          const charForGeneration: Character | null = currentCharacter ? {
            ...currentCharacter,
            photos: updatedPhotos,
            avatars: { status: 'generating' as const },
            clothing: updatedClothing,
            clothingSource: updatedClothingSource,
          } : null;

          // DEBUG: Verify charForGeneration has correct photos
          if (charForGeneration) {
            const cgBodyNoBg = charForGeneration.photos?.bodyNoBg;
            const cgSize = cgBodyNoBg ? Math.round(cgBodyNoBg.length / 1024) : 0;
            log.info(`📸 [CHAR FOR GEN] bodyNoBg=${cgSize}KB, has photos: ${!!charForGeneration.photos}`);
            if (cgBodyNoBg) {
              const fp = cgBodyNoBg.substring(cgBodyNoBg.indexOf('base64,') + 7, cgBodyNoBg.indexOf('base64,') + 27);
              log.info(`📸 [CHAR FOR GEN] fingerprint: ${fp}...`);
            }
          }

          setCurrentCharacter(prev => {
            if (!prev) return null;
            return {
              ...prev,
              // Photos from face/body detection
              photos: updatedPhotos,
              // Clear avatars - will regenerate with new face
              avatars: { status: 'generating' as const },
              // Update clothing based on user's choice
              clothing: updatedClothing,
              clothingSource: updatedClothingSource,
            };
          });

          // Auto-start avatar generation in BACKGROUND after face detection
          // Don't await - let user continue while avatar generates
          log.info(`🎨 Auto-starting avatar generation in background...`);
          log.info(`📸 Photo for avatar: bodyNoBg=${!!updatedPhotos.bodyNoBg}, body=${!!updatedPhotos.body}, face=${!!updatedPhotos.face}`);
          setIsGeneratingAvatar(true);

          // Auto-start avatar generation immediately after photo analysis
          // Character has an ID from creation, name is optional (handled in service)
          if (charForGeneration && charForGeneration.id) {
            // Run avatar generation in background (don't await)
            const charId = charForGeneration.id;
            characterService.generateAndSaveAvatarForCharacter(charForGeneration, undefined, { avatarModel: modelSelections.avatarModel || undefined })
              .then(result => {
                if (result.success && result.character) {
                  // Update currentCharacter ONLY if user is still editing this character
                  setCurrentCharacter(prev => {
                    if (!prev || prev.id !== charId) return prev; // Don't update if user moved on
                    return {
                      ...prev,
                      avatars: result.character!.avatars,
                      physical: result.character!.physical,
                      clothing: result.character!.clothing,
                    };
                  });
                  // Always update the characters array
                  setCharacters(prev => prev.map(c =>
                    c.id === charId ? { ...c, ...result.character!, id: c.id } : c
                  ));
                  log.success(`✅ Avatar generated and traits extracted for ${charForGeneration!.name}`);
                } else {
                  log.error(`❌ Avatar generation failed: ${result.error}`);
                  // Update both currentCharacter AND characters array on failure
                  setCurrentCharacter(prev => prev && prev.id === charId ? { ...prev, avatars: { status: 'failed' } } : prev);
                  setCharacters(prev => prev.map(c =>
                    c.id === charId ? { ...c, avatars: { status: 'failed' } } : c
                  ));
                }
              })
              .catch(error => {
                log.error(`❌ Avatar generation error:`, error);
                // Update both currentCharacter AND characters array on error
                setCurrentCharacter(prev => prev && prev.id === charId ? { ...prev, avatars: { status: 'failed' } } : prev);
                setCharacters(prev => prev.map(c =>
                  c.id === charId ? { ...c, avatars: { status: 'failed' } } : c
                ));
              })
              .finally(() => {
                setIsGeneratingAvatar(false);
              });
          } else {
            // No character data - should not happen
            log.warn(`⏭️ Skipping auto-generation: no character data available`);
            setIsGeneratingAvatar(false);
          }
        } else {
          // Check for specific errors
          if (analysis.error === 'no_face_detected') {
            log.warn('No face detected in photo');
            showError(t.noFaceDetected);
            // Don't set the photo - user needs to upload a different one
          } else {
            log.warn('Photo analysis returned no data, using original photo');
            // Fallback to original photo - clear avatars (new photo means new face)
            setCurrentCharacter(prev => prev ? {
              ...prev,
              photos: { original: originalPhotoUrl },
              avatars: undefined,
            } : null);
          }
        }
      } catch (error) {
        log.error('Photo analysis error:', error);
        // Fallback to original photo on error - clear avatars (new photo means new face)
        setCurrentCharacter(prev => prev ? {
          ...prev,
          photos: { original: originalPhotoUrl },
          avatars: undefined,
        } : null);
      } finally {
        setIsAnalyzingPhoto(false);
      }
    };
    reader.readAsDataURL(file);
  };

  // Handler for when user selects a face from the multi-face modal
  const handleFaceSelection = async (faceId: number) => {
    if (!pendingPhotoData) {
      log.error('No pending photo data for face selection');
      return;
    }

    setShowFaceSelectionModal(false);
    setIsAnalyzingPhoto(true);

    try {
      log.info(`Re-analyzing photo with selected face ID: ${faceId}`);
      // Pass cached faces to avoid re-detection (face IDs are unstable between calls)
      const cachedFaces = detectedFaces.map(f => ({
        id: f.id,
        x: f.faceBox.x,
        y: f.faceBox.y,
        width: f.faceBox.width,
        height: f.faceBox.height,
        confidence: f.confidence,
      }));
      const analysis = await characterService.analyzePhoto(pendingPhotoData, language, faceId, cachedFaces);

      if (analysis.success) {
        log.info('Photo analysis complete with selected face:', {
          hasPhotos: !!analysis.photos,
          hasPhysical: !!analysis.physical,
          hasClothing: !!analysis.clothing,
          age: analysis.age,
          gender: analysis.gender,
        });

        // Store debug info for UI display (dev mode)
        if (analysis._debug) {
          setPhotoAnalysisDebug(analysis._debug);
        }

        // Handle clothing based on user's choice
        const clothingToKeep = pendingClothingToKeep?.structured;

        // Build the updated photos object ONCE so we can use it for both state and avatar generation
        const updatedPhotos = {
          original: analysis.photos?.face || pendingPhotoData,
          face: analysis.photos?.face,
          body: analysis.photos?.body || pendingPhotoData,
          bodyNoBg: analysis.photos?.bodyNoBg,
          faceBox: analysis.photos?.faceBox,
          bodyBox: analysis.photos?.bodyBox,
        };

        // DEBUG: Log photo sizes after face selection
        const bodyNoBgSize = analysis.photos?.bodyNoBg ? Math.round(analysis.photos.bodyNoBg.length / 1024) : 0;
        log.info(`📸 [FACE SELECT] Analysis returned: bodyNoBg=${bodyNoBgSize}KB`);
        if (analysis.photos?.bodyNoBg) {
          const fp = analysis.photos.bodyNoBg.substring(analysis.photos.bodyNoBg.indexOf('base64,') + 7, analysis.photos.bodyNoBg.indexOf('base64,') + 27);
          log.info(`📸 [FACE SELECT] bodyNoBg fingerprint: ${fp}...`);
        }

        // Build clothing updates
        let updatedClothing: Character['clothing'] = undefined;
        let updatedClothingSource: Character['clothingSource'] = undefined;

        if (clothingToKeep) {
          // User chose to keep old clothing
          updatedClothing = { structured: clothingToKeep };
          updatedClothingSource = {
            upperBody: clothingToKeep.upperBody ? 'user' : undefined,
            lowerBody: clothingToKeep.lowerBody ? 'user' : undefined,
            shoes: clothingToKeep.shoes ? 'user' : undefined,
            fullBody: clothingToKeep.fullBody ? 'user' : undefined,
          };
        }

        // Build character for avatar generation BEFORE state update
        // (React state updates are async, so we build the object we need now)
        const charForGeneration: Character | null = currentCharacter ? {
          ...currentCharacter,
          photos: updatedPhotos,
          avatars: { status: 'generating' as const },
          clothing: updatedClothing,
          clothingSource: updatedClothingSource,
        } : null;

        // Update character with analysis results
        setCurrentCharacter(prev => {
          if (!prev) return null;
          return {
            ...prev,
            photos: updatedPhotos,
            avatars: { status: 'generating' as const },
            clothing: updatedClothing,
            clothingSource: updatedClothingSource,
          };
        });

        // Navigate based on whether character has a name:
        // - Has name: go to traits step to see avatar regenerating
        // - No name: go to name step
        if (currentCharacter?.name && currentCharacter.name.trim().length >= 2) {
          setCharacterStep('traits');
          log.info(`📸 Face selected, character has name, going to traits step`);
        } else {
          setCharacterStep('name');
        }

        // Auto-start avatar generation in background
        log.info(`🎨 Auto-starting avatar generation in background after face selection...`);
        log.info(`📸 Photo for avatar: bodyNoBg=${!!updatedPhotos.bodyNoBg}, body=${!!updatedPhotos.body}, face=${!!updatedPhotos.face}`);
        setIsGeneratingAvatar(true);

        if (charForGeneration && charForGeneration.name && charForGeneration.name.trim()) {
          const charId = charForGeneration.id;
          characterService.generateAndSaveAvatarForCharacter(charForGeneration, undefined, { avatarModel: modelSelections.avatarModel || undefined })
            .then(result => {
              if (result.success && result.character) {
                // Update currentCharacter ONLY if user is still editing this character
                setCurrentCharacter(prev => {
                  if (!prev || prev.id !== charId) return prev;
                  return {
                    ...prev,
                    avatars: result.character!.avatars,
                    physical: result.character!.physical,
                    clothing: result.character!.clothing,
                  };
                });
                // Always update the characters array
                setCharacters(prev => prev.map(c =>
                  c.id === charId ? { ...c, ...result.character!, id: c.id } : c
                ));
                log.success(`✅ Avatar generated for ${charForGeneration!.name} (face selection)`);
              } else {
                log.error(`❌ Avatar generation failed: ${result.error}`);
                setCurrentCharacter(prev => prev && prev.id === charId ? { ...prev, avatars: { status: 'failed' } } : prev);
                setCharacters(prev => prev.map(c =>
                  c.id === charId ? { ...c, avatars: { status: 'failed' } } : c
                ));
              }
            })
            .catch(error => {
              log.error(`❌ Avatar generation error:`, error);
              setCurrentCharacter(prev => prev && prev.id === charId ? { ...prev, avatars: { status: 'failed' } } : prev);
              setCharacters(prev => prev.map(c =>
                c.id === charId ? { ...c, avatars: { status: 'failed' } } : c
              ));
            })
            .finally(() => {
              setIsGeneratingAvatar(false);
            });
        } else {
          log.info(`⏭️ Skipping auto-generation: character has no name yet`);
          setIsGeneratingAvatar(false);
          setCurrentCharacter(prev => prev ? { ...prev, avatars: { status: 'pending' } } : prev);
        }
      } else {
        log.warn('Photo analysis failed after face selection');
        showError(t.noFaceDetected);
      }
    } catch (error) {
      log.error('Photo analysis error after face selection:', error);
      showError('Failed to analyze photo. Please try again.');
    } finally {
      setIsAnalyzingPhoto(false);
      // Clear pending data
      setPendingPhotoData(null);
      setPendingClothingToKeep(null);
      setDetectedFaces([]);
    }
  };

  // Handler for when user wants to upload a different photo from face selection modal
  const handleFaceSelectionUploadNew = () => {
    setShowFaceSelectionModal(false);
    setPendingPhotoData(null);
    setPendingClothingToKeep(null);
    setDetectedFaces([]);
    // Stay on photo step so user can upload a new photo
    setCharacterStep('photo');
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
        (status, message) => log.info(`[${status}] ${message}`),
        { avatarModel: modelSelections.avatarModel || undefined }
      );

      if (result.success && result.character) {
        // Update local state with new avatars AND extracted traits (explicitly clear stale flag)
        const freshAvatars = { ...result.character.avatars, stale: false };
        setCurrentCharacter(prev => prev ? {
          ...prev,
          avatars: freshAvatars,
          physical: result.character!.physical,
          clothing: result.character!.clothing,
        } : prev);
        setCharacters(prev => prev.map(c =>
          c.id === currentCharacter.id ? {
            ...c,
            avatars: freshAvatars,
            physical: result.character!.physical,
            clothing: result.character!.clothing,
          } : c
        ));
        log.success(`✅ Avatars and traits regenerated for ${currentCharacter.name}`);
      } else {
        log.error(`❌ Failed to regenerate avatars: ${result.error}`);
        showError(`Failed to regenerate avatars: ${result.error || 'Unknown error'}`);
      }
    } catch (error) {
      log.error(`❌ Failed to regenerate avatars for ${currentCharacter.name}:`, error);
      showError(`Failed to regenerate avatars: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setIsRegeneratingAvatars(false);
    }
  };

  // Handler for regenerating avatars WITH physical traits (glasses, hair color, etc.)
  // Uses the new service function that passes all traits to the prompt
  const handleRegenerateAvatarsWithTraits = async () => {
    if (!currentCharacter) return;

    // Clear existing avatars in UI
    setCurrentCharacter(prev => prev ? { ...prev, avatars: undefined } : prev);
    setIsRegeneratingAvatarsWithTraits(true);

    try {
      log.info(`🔄 Regenerating avatars WITH TRAITS for ${currentCharacter.name}...`);
      log.info(`Physical traits: ${JSON.stringify(currentCharacter.physical)}`);

      // Use the new service function that includes physical traits
      const result = await characterService.generateClothingAvatarsWithTraits(currentCharacter);

      if (result.success && result.avatars) {
        // Update local state with new avatars (explicitly clear stale flag)
        const freshAvatars = { ...result.avatars, stale: false, generatedAt: new Date().toISOString() };

        // MERGE physical traits - preserve USER edits, use extracted for non-user traits
        // This allows multiple trait modifications to accumulate across regenerations
        const currentSource = currentCharacter.physicalTraitsSource || {};
        const updatedPhysical = result.extractedTraits ? {
          height: currentCharacter.physical?.height, // Preserve height (not extracted from avatar)
          // Preserve user-edited values, use extracted for non-user traits
          eyeColor: currentSource.eyeColor === 'user' ? currentCharacter.physical?.eyeColor : result.extractedTraits.eyeColor,
          hairColor: currentSource.hairColor === 'user' ? currentCharacter.physical?.hairColor : result.extractedTraits.hairColor,
          hairLength: currentSource.hairLength === 'user' ? currentCharacter.physical?.hairLength : result.extractedTraits.hairLength,
          hairStyle: currentSource.hairStyle === 'user' ? currentCharacter.physical?.hairStyle : result.extractedTraits.hairStyle,
          build: currentSource.build === 'user' ? currentCharacter.physical?.build : result.extractedTraits.build,
          face: currentSource.face === 'user' ? currentCharacter.physical?.face : result.extractedTraits.face,
          facialHair: currentSource.facialHair === 'user' ? currentCharacter.physical?.facialHair : result.extractedTraits.facialHair,
          other: currentSource.other === 'user' ? currentCharacter.physical?.other : result.extractedTraits.other,
          // Detailed hair analysis from avatar evaluation (always use latest)
          detailedHairAnalysis: result.extractedTraits.detailedHairAnalysis || currentCharacter.physical?.detailedHairAnalysis,
        } : currentCharacter.physical;

        // PRESERVE 'user' source - only set 'extracted' for non-user traits
        // This allows subsequent edits to accumulate without losing previous user edits
        const updatedTraitsSource = result.extractedTraits ? {
          eyeColor: currentSource.eyeColor === 'user' ? 'user' as const : (result.extractedTraits.eyeColor ? 'extracted' as const : undefined),
          hairColor: currentSource.hairColor === 'user' ? 'user' as const : (result.extractedTraits.hairColor ? 'extracted' as const : undefined),
          hairLength: currentSource.hairLength === 'user' ? 'user' as const : (result.extractedTraits.hairLength ? 'extracted' as const : undefined),
          hairStyle: currentSource.hairStyle === 'user' ? 'user' as const : (result.extractedTraits.hairStyle ? 'extracted' as const : undefined),
          build: currentSource.build === 'user' ? 'user' as const : (result.extractedTraits.build ? 'extracted' as const : undefined),
          face: currentSource.face === 'user' ? 'user' as const : (result.extractedTraits.face ? 'extracted' as const : undefined),
          facialHair: currentSource.facialHair === 'user' ? 'user' as const : undefined,
          other: currentSource.other === 'user' ? 'user' as const : undefined,
        } : currentCharacter.physicalTraitsSource;

        // OVERWRITE clothing with extracted values from new avatar
        const updatedClothing = result.extractedClothing ? {
          ...currentCharacter.clothing,
          structured: {
            // Overwrite all structured clothing from extraction
            upperBody: result.extractedClothing.upperBody || undefined,
            lowerBody: result.extractedClothing.lowerBody || undefined,
            shoes: result.extractedClothing.shoes || undefined,
            fullBody: result.extractedClothing.fullBody || undefined,
          }
        } : currentCharacter.clothing;

        // Update state only - DO NOT save here
        // The user will click Save which triggers saveCharacter() with the updated state
        setCurrentCharacter(prev => prev ? {
          ...prev,
          avatars: freshAvatars,
          physical: updatedPhysical,
          physicalTraitsSource: updatedTraitsSource,
          clothing: updatedClothing,
        } : prev);
        setCharacters(prev => prev.map(c =>
          c.id === currentCharacter.id ? {
            ...c,
            avatars: freshAvatars,
            physical: updatedPhysical,
            physicalTraitsSource: updatedTraitsSource,
            clothing: updatedClothing,
          } : c
        ));

        log.success(`✅ Avatars WITH TRAITS regenerated for ${currentCharacter.name}`);
        if (result.extractedTraits) {
          log.info(`📋 Extracted traits saved: ${JSON.stringify(result.extractedTraits)}`);
        }
        if (result.extractedClothing) {
          log.info(`👕 Extracted clothing saved: ${JSON.stringify(result.extractedClothing)}`);
        }
      } else {
        log.error(`❌ Failed to regenerate avatars with traits: ${result.error}`);
        showError(`Failed to regenerate avatars: ${result.error || 'Unknown error'}`);
      }
    } catch (error) {
      log.error(`❌ Failed to regenerate avatars with traits for ${currentCharacter.name}:`, error);
      showError(`Failed to regenerate avatars: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setIsRegeneratingAvatarsWithTraits(false);
    }
  };

  // Handler for "Save & Regenerate" button - combines save and avatar regeneration
  const handleSaveAndRegenerateWithTraits = async () => {
    if (!currentCharacter) return;

    // Capture the character BEFORE saving (saveCharacter clears currentCharacter)
    const charToRegenerate = { ...currentCharacter };
    const charId = currentCharacter.id;

    setIsRegeneratingAvatarsWithTraits(true);
    try {
      log.info(`💾 Saving character and regenerating avatars for ${charToRegenerate.name}...`);

      // First, save the character with current state
      await saveCharacter();

      // Then regenerate avatars with the new traits
      log.info(`🔄 Regenerating avatars WITH TRAITS for ${charToRegenerate.name}...`);

      // Get the saved character from the characters array (currentCharacter is cleared after save)
      const latestCharacters = await new Promise<Character[]>(resolve => {
        setCharacters(prev => {
          resolve(prev);
          return prev;
        });
      });
      const latestChar = latestCharacters.find(c => c.id === charId);

      if (!latestChar) {
        log.warn('Character not found in characters array after save');
        return;
      }

      // Use the service function that includes physical traits
      const result = await characterService.generateClothingAvatarsWithTraits(latestChar);

      if (result.success && result.avatars) {
        // Update local state with new avatars
        const freshAvatars = { ...result.avatars, stale: false, generatedAt: new Date().toISOString() };

        // MERGE physical traits - preserve USER edits, use extracted for non-user traits
        // This allows multiple trait modifications to accumulate across regenerations
        const currentSource2 = latestChar.physicalTraitsSource || {};
        const updatedPhysical2 = result.extractedTraits ? {
          height: latestChar.physical?.height, // Preserve height (not extracted from avatar)
          // Preserve user-edited values, use extracted for non-user traits
          eyeColor: currentSource2.eyeColor === 'user' ? latestChar.physical?.eyeColor : result.extractedTraits.eyeColor,
          hairColor: currentSource2.hairColor === 'user' ? latestChar.physical?.hairColor : result.extractedTraits.hairColor,
          hairLength: currentSource2.hairLength === 'user' ? latestChar.physical?.hairLength : result.extractedTraits.hairLength,
          hairStyle: currentSource2.hairStyle === 'user' ? latestChar.physical?.hairStyle : result.extractedTraits.hairStyle,
          build: currentSource2.build === 'user' ? latestChar.physical?.build : result.extractedTraits.build,
          face: currentSource2.face === 'user' ? latestChar.physical?.face : result.extractedTraits.face,
          facialHair: currentSource2.facialHair === 'user' ? latestChar.physical?.facialHair : result.extractedTraits.facialHair,
          other: currentSource2.other === 'user' ? latestChar.physical?.other : result.extractedTraits.other,
          // Detailed hair analysis from avatar evaluation (always use latest)
          detailedHairAnalysis: result.extractedTraits.detailedHairAnalysis || latestChar.physical?.detailedHairAnalysis,
        } : latestChar.physical;

        // PRESERVE 'user' source - only set 'extracted' for non-user traits
        // This allows subsequent edits to accumulate without losing previous user edits
        const updatedTraitsSource2 = result.extractedTraits ? {
          eyeColor: currentSource2.eyeColor === 'user' ? 'user' as const : (result.extractedTraits.eyeColor ? 'extracted' as const : undefined),
          hairColor: currentSource2.hairColor === 'user' ? 'user' as const : (result.extractedTraits.hairColor ? 'extracted' as const : undefined),
          hairLength: currentSource2.hairLength === 'user' ? 'user' as const : (result.extractedTraits.hairLength ? 'extracted' as const : undefined),
          hairStyle: currentSource2.hairStyle === 'user' ? 'user' as const : (result.extractedTraits.hairStyle ? 'extracted' as const : undefined),
          build: currentSource2.build === 'user' ? 'user' as const : (result.extractedTraits.build ? 'extracted' as const : undefined),
          face: currentSource2.face === 'user' ? 'user' as const : (result.extractedTraits.face ? 'extracted' as const : undefined),
          facialHair: currentSource2.facialHair === 'user' ? 'user' as const : undefined,
          other: currentSource2.other === 'user' ? 'user' as const : undefined,
        } : latestChar.physicalTraitsSource;

        // OVERWRITE clothing with extracted values from new avatar
        const updatedClothing2 = result.extractedClothing ? {
          ...latestChar.clothing,
          structured: {
            // Overwrite all structured clothing from extraction
            upperBody: result.extractedClothing.upperBody || undefined,
            lowerBody: result.extractedClothing.lowerBody || undefined,
            shoes: result.extractedClothing.shoes || undefined,
            fullBody: result.extractedClothing.fullBody || undefined,
          }
        } : latestChar.clothing;

        // Only update currentCharacter if it's still the same character (user might have switched)
        setCurrentCharacter(prev => prev && prev.id === charId ? {
          ...prev,
          avatars: freshAvatars,
          physical: updatedPhysical2,
          physicalTraitsSource: updatedTraitsSource2,
          clothing: updatedClothing2,
        } : prev);
        setCharacters(prev => prev.map(c =>
          c.id === charId ? {
            ...c,
            avatars: freshAvatars,
            physical: updatedPhysical2,
            physicalTraitsSource: updatedTraitsSource2,
            clothing: updatedClothing2,
          } : c
        ));

        log.success(`✅ Avatars regenerated for ${latestChar.name}`);

        // Save again with the new avatars, traits, and clothing
        const updatedChar = {
          ...latestChar,
          avatars: freshAvatars,
          physical: updatedPhysical2,
          physicalTraitsSource: updatedTraitsSource2,
          clothing: updatedClothing2,
        };
        const latestCharacters2 = await new Promise<Character[]>(resolve => {
          setCharacters(prev => {
            resolve(prev);
            return prev;
          });
        });
        const finalCharacters = latestCharacters2.map(c =>
          c.id === charId ? updatedChar : c
        );

        await characterService.saveCharacterData({
          characters: finalCharacters,
          relationships,
          relationshipTexts,
          customRelationships,
          customStrengths: [],
          customWeaknesses: [],
          customFears: [],
        });

        log.success(`💾 Character saved with new avatars, traits, and clothing`);
        showSuccess(language === 'de' ? 'Charakter gespeichert und Avatar regeneriert' : 'Character saved and avatar regenerated');
      } else {
        log.error(`❌ Failed to regenerate avatars: ${result.error}`);
        showError(`Failed to regenerate avatars: ${result.error || 'Unknown error'}`);
      }
    } catch (error) {
      log.error(`❌ Failed to save and regenerate:`, error);
      showError(`Failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setIsRegeneratingAvatarsWithTraits(false);
    }
  };

  // Handler for "Save & Generate Avatar" button
  // Moves to traits step and triggers avatar generation in background
  const handleSaveAndGenerateAvatar = async () => {
    if (!currentCharacter) return;

    // Capture character ID for closure - user may navigate to different character during generation
    const charId = currentCharacter.id;

    // Clear changed traits indicator after saving
    setChangedTraits(undefined);

    // Move to traits step immediately so user can continue editing
    setCharacterStep('traits');

    // Skip avatar generation if already generating or complete
    const avatarStatus = currentCharacter.avatars?.status;
    const hasAvatar = !!(currentCharacter.avatars?.standard || currentCharacter.avatars?.winter || currentCharacter.avatars?.summer || currentCharacter.avatars?.hasFullAvatars);
    if (avatarStatus === 'generating' || (avatarStatus === 'complete' && hasAvatar)) {
      log.info(`⏭️ Skipping avatar generation - already ${avatarStatus}${hasAvatar ? ' with avatars' : ''}`);
      return;
    }

    // Start background avatar generation
    setIsGeneratingAvatar(true);
    // Only set generating status if still on same character
    setCurrentCharacter(prev => prev && prev.id === charId ? { ...prev, avatars: { status: 'generating' } } : prev);

    log.info(`🎨 Starting avatar generation for ${currentCharacter.name || 'unnamed'} (id: ${charId})...`);

    try {
      // Generate avatars with physical traits
      const result = await characterService.generateClothingAvatarsWithTraits(currentCharacter);

      if (result.success && result.avatars) {
        const freshAvatars = { ...result.avatars, stale: false, generatedAt: new Date().toISOString() };

        // Update ALL physical traits from extraction (not just detailedHairAnalysis)
        const updatedPhysical = result.extractedTraits ? {
          ...currentCharacter.physical,
          build: result.extractedTraits.build || currentCharacter.physical?.build,
          eyeColor: result.extractedTraits.eyeColor || currentCharacter.physical?.eyeColor,
          eyeColorHex: result.extractedTraits.eyeColorHex || currentCharacter.physical?.eyeColorHex,
          hairColor: result.extractedTraits.hairColor || currentCharacter.physical?.hairColor,
          hairColorHex: result.extractedTraits.hairColorHex || currentCharacter.physical?.hairColorHex,
          hairLength: result.extractedTraits.hairLength || currentCharacter.physical?.hairLength,
          hairStyle: result.extractedTraits.hairStyle || currentCharacter.physical?.hairStyle,
          facialHair: result.extractedTraits.facialHair || currentCharacter.physical?.facialHair,
          skinTone: result.extractedTraits.skinTone || currentCharacter.physical?.skinTone,
          skinToneHex: result.extractedTraits.skinToneHex || currentCharacter.physical?.skinToneHex,
          face: result.extractedTraits.face || currentCharacter.physical?.face,
          other: result.extractedTraits.other || currentCharacter.physical?.other,
          detailedHairAnalysis: result.extractedTraits.detailedHairAnalysis || currentCharacter.physical?.detailedHairAnalysis,
        } : currentCharacter.physical;

        // Update extracted clothing too
        const updatedClothing = result.extractedClothing ? {
          ...currentCharacter.clothing,
          structured: {
            upperBody: result.extractedClothing.upperBody || undefined,
            lowerBody: result.extractedClothing.lowerBody || undefined,
            shoes: result.extractedClothing.shoes || undefined,
            fullBody: result.extractedClothing.fullBody || undefined,
          },
        } : currentCharacter.clothing;

        // Update characters array first (always - using captured charId)
        setCharacters(prev => prev.map(c =>
          c.id === charId ? { ...c, avatars: freshAvatars, physical: updatedPhysical, clothing: updatedClothing } : c
        ));
        // Only update currentCharacter if user is still on the same character
        setCurrentCharacter(prev =>
          prev && prev.id === charId
            ? { ...prev, avatars: freshAvatars, physical: updatedPhysical, clothing: updatedClothing }
            : prev
        );

        log.success(`✅ Avatar generated for ${currentCharacter.name} (id: ${charId})`);
      } else {
        log.error(`❌ Failed to generate avatar: ${result.error}`);
        showError(`Failed to generate avatar: ${result.error || 'Unknown error'}`);
        // Mark as failed in characters array
        setCharacters(prev => prev.map(c =>
          c.id === charId ? { ...c, avatars: { status: 'failed' } } : c
        ));
        // Only update currentCharacter if still on same character
        setCurrentCharacter(prev => prev && prev.id === charId ? { ...prev, avatars: { status: 'failed' } } : prev);
      }
    } catch (error) {
      log.error(`❌ Avatar generation failed:`, error);
      showError(`Avatar generation failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      // Mark as failed in characters array
      setCharacters(prev => prev.map(c =>
        c.id === charId ? { ...c, avatars: { status: 'failed' } } : c
      ));
      setCurrentCharacter(prev => prev && prev.id === charId ? { ...prev, avatars: { status: 'failed' } } : prev);
    } finally {
      setIsGeneratingAvatar(false);
    }
  };

  const saveCharacter = async () => {
    if (!currentCharacter) return;

    setIsLoading(true);
    try {
      // Get the LATEST currentCharacter from state to avoid stale closure issues
      const latestCurrentChar = await new Promise<Character | null>(resolve => {
        setCurrentCharacter(prev => {
          resolve(prev);
          return prev; // Don't modify, just read
        });
      });

      if (!latestCurrentChar) {
        log.warn('No current character to save');
        return;
      }

      // Get the LATEST characters array from state
      const latestCharacters = await new Promise<Character[]>(resolve => {
        setCharacters(prev => {
          resolve(prev);
          return prev; // Don't modify, just read
        });
      });

      // Check if this is an edit (existing character) or new character
      const isEdit = latestCurrentChar.id && latestCharacters.find(c => c.id === latestCurrentChar.id);
      const updatedCharacters = isEdit
        ? latestCharacters.map(c => c.id === latestCurrentChar.id ? latestCurrentChar : c)
        : [...latestCharacters, latestCurrentChar];

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
      relationshipsDirty.current = false; // Reset - relationships were just saved
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
        characterService.generateAndSaveAvatarForCharacter(savedChar, undefined, { avatarModel: modelSelections.avatarModel || undefined }).then(result => {
          if (result.success && result.character) {
            // Update local state with avatars AND extracted traits/clothing
            setCharacters(prev => prev.map(c =>
              c.id === savedChar.id ? {
                ...c,
                avatars: result.character!.avatars,
                physical: result.character!.physical,
                clothing: result.character!.clothing,
              } : c
            ));
            log.success(`✅ Avatars and traits saved for ${savedChar.name}`);
          } else if (!result.skipped) {
            log.warn(`Avatar generation failed for ${savedChar.name}: ${result.error}`);
          }
        });
      }

      setCurrentCharacter(null);
      setShowCharacterCreated(true);
    } catch (error) {
      log.error('Failed to save character:', error);
      showError(language === 'de'
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
    try {
      // Use dedicated DELETE endpoint (much faster than re-uploading all characters)
      const result = await characterService.deleteCharacter(id);

      if (result.success) {
        // Update local state - server already handled relationship cleanup in database
        setCharacters(prev => prev.filter(c => c.id !== id));

        // Clean up relationships in local state
        setRelationships(prev => {
          const updated = { ...prev };
          Object.keys(updated).forEach(key => {
            if (key.includes(`${id}-`) || key.includes(`-${id}`)) {
              delete updated[key];
            }
          });
          return updated;
        });
        setRelationshipTexts(prev => {
          const updated = { ...prev };
          Object.keys(updated).forEach(key => {
            if (key.includes(`${id}-`) || key.includes(`-${id}`)) {
              delete updated[key];
            }
          });
          return updated;
        });

        setMainCharacters(prev => prev.filter(cid => cid !== id));
        log.success(`Character ${id} deleted`);
      } else {
        log.error('Failed to delete character:', result.error);
        showError(language === 'de'
          ? 'Charakter konnte nicht gelöscht werden'
          : 'Failed to delete character');
      }
    } catch (error) {
      log.error('Failed to delete character:', error);
      showError(language === 'de'
        ? 'Charakter konnte nicht gelöscht werden'
        : 'Failed to delete character');
    }
  };

  // Relationship handlers - set both forward and inverse relationships
  const updateRelationship = (char1Id: number, char2Id: number, value: string) => {
    const lang = language as UILanguage;
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

  // Update relationship text (comment) - store on both keys for bidirectional access
  const updateRelationshipText = (key: string, text: string) => {
    relationshipsDirty.current = true;
    const [id1, id2] = key.split('-').map(Number);
    const inverseKey = `${id2}-${id1}`;
    setRelationshipTexts(prev => ({
      ...prev,
      [key]: text,
      [inverseKey]: text, // Same comment on both sides
    }));
  };

  const addCustomRelationship = (forward: string, inverse: string) => {
    relationshipsDirty.current = true; // Mark as modified
    setCustomRelationships(prev => [...prev, { forward, inverse }]);
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
  // NEW ORDER: 1=Characters, 2=Relationships, 3=BookSettings, 4=StoryType, 5=ArtStyle, 6=Summary, 7=StoryDisplay
  const safeSetStep = async (newStep: number) => {
    if (newStep >= 0 && newStep <= 7) {
      // Auto-save character if leaving step 1 while editing
      if (step === 1 && currentCharacter && newStep !== 1) {
        await saveCharacter();
      }
      // Save relationships when leaving step 1 (fire and forget)
      if (step === 1 && newStep !== 1) {
        saveAllCharacterData(); // No await - runs in background
      }
      // Clear currentCharacter when entering step 1 to show character list
      if (newStep === 1 && step !== 1) {
        setCurrentCharacter(null);
      }
      setStep(newStep);
      // Scroll to top when changing steps
      window.scrollTo(0, 0);
    }
  };

  const canAccessStep = (s: number): boolean => {
    // NEW ORDER: 1=Characters, 2=BookSettings, 3=StoryType, 4=ArtStyle, 5=Summary, 6=StoryDisplay
    // Relationships default to "not known to" which is acceptable
    if (s === 1) return true;
    if (s === 2) return characters.length > 0;
    if (s === 3) return characters.length > 0;
    if (s === 4) return characters.length > 0 && storyCategory !== '';
    if (s === 5) return characters.length > 0 && storyCategory !== '' && artStyle !== '';
    if (s === 6) return generatedStory !== '';
    return false;
  };

  const canGoNext = (): boolean => {
    // NEW ORDER: 1=Characters, 2=BookSettings, 3=StoryType, 4=ArtStyle, 5=Summary
    if (step === 1) {
      // Step 1: Characters - must have at least one character and one main character
      // Relationships default to "not known to" which is acceptable (warning shown)
      return characters.length > 0 && mainCharacters.length > 0;
    }
    if (step === 2) {
      // Step 2: Book Settings - always can proceed (languageLevel has default)
      return true;
    }
    if (step === 3) {
      // Step 3: Story Type - must have story category and topic/theme selected
      if (!storyCategory) return false;
      if (storyCategory === 'adventure' && !storyTheme) return false;
      if ((storyCategory === 'life-challenge' || storyCategory === 'educational') && !storyTopic) return false;
      return true;
    }
    if (step === 4) {
      // Step 4: Art Style - must have art style selected
      return artStyle !== '';
    }
    if (step === 5) {
      // Step 5: Summary - must have main character and story details
      const charactersInStory = characters.filter(c => !excludedCharacters.includes(c.id));
      return charactersInStory.length > 0 && mainCharacters.length > 0 && storyDetails.trim().length > 0;
    }
    return false;
  };

  // Save all character data including relationships (only if modified)
  const saveAllCharacterData = async () => {
    // Get LATEST characters from state to avoid stale closure issues
    const latestCharacters = await new Promise<Character[]>(resolve => {
      setCharacters(prev => {
        resolve(prev);
        return prev;
      });
    });

    if (latestCharacters.length === 0) return;
    if (!relationshipsDirty.current) {
      log.debug('Relationships not modified, skipping save');
      return;
    }
    try {
      log.debug('Auto-saving character data with latest state...');
      await characterService.saveCharacterData({
        characters: latestCharacters,
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
    if (step < 5 && canGoNext()) {
      // Show dialog if user has only 1 character and is moving from step 1 to step 2
      if (step === 1 && characters.length === 1) {
        setShowSingleCharacterDialog(true);
        return;
      }
      await safeSetStep(step + 1);
    }
  };

  const goBack = async () => {
    if (step > 0) {
      await safeSetStep(step - 1);
    }
  };

  // Generate story ideas using AI
  // Handler when user selects one of the generated ideas
  const handleSelectIdea = (idea: string) => {
    setStoryDetails(idea);
    // Don't clear generatedIdeas - let user switch between options
  };

  const generateIdeas = async () => {
    // Abort any existing stream
    if (streamAbortRef.current) {
      streamAbortRef.current.abort();
    }

    // Reset state for new generation
    setIsGeneratingIdeas(true);
    setIsGeneratingIdea1(true);
    setIsGeneratingIdea2(true);
    setGeneratedIdeas([]);
    setLastIdeaPrompt(null);
    setLastIdeaFullResponse('');

    // Get characters in story (not excluded)
    const charactersInStory = characters.filter(c => !excludedCharacters.includes(c.id));

    // Use streaming API
    streamAbortRef.current = storyService.generateStoryIdeasStream(
      {
        storyType,
        storyTypeName: getStoryTypeName(),
        storyCategory: storyCategory || undefined,
        storyTopic: storyTopic || undefined,
        storyTheme: storyTheme || undefined,
        customThemeText: storyTheme === 'custom' ? customThemeText : undefined,
        language: storyLanguage,
        languageLevel,
        pages,
        characters: charactersInStory.map(c => ({
          name: c.name,
          age: c.age,
          gender: c.gender,
          traits: c.traits,
          isMain: mainCharacters.includes(c.id),
        })),
        relationships: Object.entries(relationships).map(([key, rel]) => {
          const [id1, id2] = key.split('-').map(Number);
          const char1 = charactersInStory.find(c => c.id === id1);
          const char2 = charactersInStory.find(c => c.id === id2);
          return {
            character1: char1?.name || '',
            character2: char2?.name || '',
            relationship: rel,
          };
        }).filter(r => r.character1 && r.character2),
        ideaModel: (user?.role === 'admin' || isImpersonating) ? modelSelections.ideaModel : undefined,
        userLocation: userLocation || undefined,
        season,
      },
      {
        onStatus: (_status, prompt, model) => {
          if (prompt && model) {
            setLastIdeaPrompt({ prompt, model });
          }
        },
        onStory1: (story1) => {
          setGeneratedIdeas(prev => {
            const newIdeas = [...prev];
            newIdeas[0] = story1;
            return newIdeas;
          });
          setIsGeneratingIdea1(false);
        },
        onStory2: (story2) => {
          setGeneratedIdeas(prev => {
            const newIdeas = [...prev];
            newIdeas[1] = story2;
            return newIdeas;
          });
          setIsGeneratingIdea2(false);
        },
        onError: (error) => {
          log.error('Failed to generate story ideas:', error);
          showError(language === 'de'
            ? 'Fehler beim Generieren von Ideen. Bitte versuchen Sie es erneut.'
            : language === 'fr'
            ? 'Erreur lors de la génération d\'idées. Veuillez réessayer.'
            : 'Failed to generate ideas. Please try again.');
          setIsGeneratingIdeas(false);
          setIsGeneratingIdea1(false);
          setIsGeneratingIdea2(false);
        },
        onDone: (fullResponse) => {
          setIsGeneratingIdeas(false);
          setIsGeneratingIdea1(false);
          setIsGeneratingIdea2(false);
          if (fullResponse) {
            setLastIdeaFullResponse(fullResponse);
          }
          streamAbortRef.current = null;
        },
      }
    );
  };

  // Get story type name for display
  const getStoryTypeName = () => {
    // Check built-in types
    const builtInType = storyTypes.find(t => t.id === storyType);
    if (builtInType) return builtInType.name[language as keyof typeof builtInType.name];
    return storyType;
  };

  const generateStory = async (overrides?: { skipImages?: boolean; skipEmailCheck?: boolean }) => {
    console.log('[generateStory] Called with overrides:', overrides);
    console.log('[generateStory] user:', user?.email, 'emailVerified:', user?.emailVerified, 'isImpersonating:', isImpersonating);

    // Check email verification before generating (emailVerified could be false or undefined)
    // Skip this check if we just verified (skipEmailCheck=true) since React state may not have updated yet
    // Also skip if admin is impersonating - they should be able to generate without the user's email being verified
    if (!overrides?.skipEmailCheck && !isImpersonating && user && user.emailVerified !== true) {
      console.log('[generateStory] Email not verified, showing modal');
      // Store all story state so we can auto-generate after email verification
      localStorage.setItem('pendingStoryGeneration', 'true');
      localStorage.setItem('pending_story_type', storyType);
      localStorage.setItem('pending_art_style', artStyle);
      setShowEmailVerificationModal(true);
      return;
    }

    console.log('[generateStory] Starting generation, setting step to 6');
    setIsGenerating(true);
    setIsProgressMinimized(false); // Reset minimized state for new generation
    setStep(6);

    // Save generation settings for dev mode display IMMEDIATELY (before generation starts)
    setSavedGenerationSettings({
      storyCategory: storyCategory || undefined,
      storyTopic: storyTopic || undefined,
      storyTheme: storyTheme || undefined,
      storyTypeName: getStoryTypeName(),
      storyDetails: storyDetails || undefined,
      artStyle: artStyle || undefined,
      language: storyLanguage || undefined,
      languageLevel: languageLevel || undefined,
      pages: pages || undefined,
      dedication: dedication || undefined,
      characters: characters.filter(c => !excludedCharacters.includes(c.id)).map(c => ({ id: c.id, name: c.name })),
      mainCharacters: mainCharacters,
      relationships: relationships,
      relationshipTexts: relationshipTexts,
      season: season || undefined,
      userLocation: userLocation || undefined,
    });

    // Reset ALL story state for new generation - must clear old story to show popup
    setGeneratedStory('');
    setStoryTitle('');
    setSceneImages([]);
    setSceneDescriptions([]);
    setProgressiveStoryData(null);
    setCompletedPageImages({});
    setCoverImages({ frontCover: null, initialPage: null, backCover: null });

    // Check for characters with stale or missing avatars
    const charactersNeedingAvatars = characters
      .filter(c => !excludedCharacters.includes(c.id))
      .filter(c => !c.avatars || c.avatars.stale || c.avatars.status !== 'complete');

    if (charactersNeedingAvatars.length > 0) {
      console.log('[generateStory] Characters needing avatar regeneration:', charactersNeedingAvatars.map(c => c.name));
      setGenerationProgress({
        current: 1,
        total: 100,
        message: language === 'de'
          ? `Aktualisiere Avatare für ${charactersNeedingAvatars.length} Charakter(e)...`
          : language === 'fr'
          ? `Mise à jour des avatars pour ${charactersNeedingAvatars.length} personnage(s)...`
          : `Updating avatars for ${charactersNeedingAvatars.length} character(s)...`
      });

      // Regenerate avatars for each character that needs it
      for (let i = 0; i < charactersNeedingAvatars.length; i++) {
        const char = charactersNeedingAvatars[i];
        try {
          console.log(`[generateStory] Regenerating avatars for ${char.name} (${i + 1}/${charactersNeedingAvatars.length})`);
          setGenerationProgress({
            current: 2,
            total: 100,
            message: language === 'de'
              ? `Generiere Avatare für ${char.name}...`
              : language === 'fr'
              ? `Génération des avatars pour ${char.name}...`
              : `Generating avatars for ${char.name}...`
          });

          const result = await characterService.generateClothingAvatarsWithTraits(char);

          if (result.success && result.avatars) {
            const freshAvatars = { ...result.avatars, stale: false, generatedAt: new Date().toISOString() };

            // MERGE physical traits - preserve USER edits, use extracted for non-user traits
            const charSource = char.physicalTraitsSource || {};
            const updatedPhysical = result.extractedTraits ? {
              ...char.physical,
              height: char.physical?.height, // Preserve height (not extracted from avatar)
              // Preserve user-edited values, use extracted for non-user traits
              build: charSource.build === 'user' ? char.physical?.build : result.extractedTraits.build,
              eyeColor: charSource.eyeColor === 'user' ? char.physical?.eyeColor : result.extractedTraits.eyeColor,
              eyeColorHex: charSource.eyeColor === 'user' ? char.physical?.eyeColorHex : result.extractedTraits.eyeColorHex,
              hairColor: charSource.hairColor === 'user' ? char.physical?.hairColor : result.extractedTraits.hairColor,
              hairColorHex: charSource.hairColor === 'user' ? char.physical?.hairColorHex : result.extractedTraits.hairColorHex,
              hairLength: charSource.hairLength === 'user' ? char.physical?.hairLength : result.extractedTraits.hairLength,
              hairStyle: charSource.hairStyle === 'user' ? char.physical?.hairStyle : result.extractedTraits.hairStyle,
              facialHair: charSource.facialHair === 'user' ? char.physical?.facialHair : result.extractedTraits.facialHair,
              skinTone: charSource.skinTone === 'user' ? char.physical?.skinTone : result.extractedTraits.skinTone,
              skinToneHex: charSource.skinTone === 'user' ? char.physical?.skinToneHex : result.extractedTraits.skinToneHex,
              face: charSource.face === 'user' ? char.physical?.face : result.extractedTraits.face,
              other: charSource.other === 'user' ? char.physical?.other : result.extractedTraits.other,
              // Detailed hair analysis from avatar evaluation (always use latest)
              detailedHairAnalysis: result.extractedTraits.detailedHairAnalysis || char.physical?.detailedHairAnalysis,
            } : char.physical;

            // PRESERVE 'user' source - only set 'extracted' for non-user traits
            const updatedTraitsSource = result.extractedTraits ? {
              ...charSource,
              build: charSource.build === 'user' ? 'user' as const : (result.extractedTraits.build ? 'extracted' as const : undefined),
              eyeColor: charSource.eyeColor === 'user' ? 'user' as const : (result.extractedTraits.eyeColor ? 'extracted' as const : undefined),
              hairColor: charSource.hairColor === 'user' ? 'user' as const : (result.extractedTraits.hairColor ? 'extracted' as const : undefined),
              hairLength: charSource.hairLength === 'user' ? 'user' as const : (result.extractedTraits.hairLength ? 'extracted' as const : undefined),
              hairStyle: charSource.hairStyle === 'user' ? 'user' as const : (result.extractedTraits.hairStyle ? 'extracted' as const : undefined),
              face: charSource.face === 'user' ? 'user' as const : (result.extractedTraits.face ? 'extracted' as const : undefined),
              facialHair: charSource.facialHair === 'user' ? 'user' as const : undefined,
              other: charSource.other === 'user' ? 'user' as const : undefined,
              skinTone: charSource.skinTone === 'user' ? 'user' as const : (result.extractedTraits.skinTone ? 'extracted' as const : undefined),
            } : char.physicalTraitsSource;

            // Update extracted clothing too
            const updatedClothing = result.extractedClothing ? {
              ...char.clothing,
              structured: {
                upperBody: result.extractedClothing.upperBody || undefined,
                lowerBody: result.extractedClothing.lowerBody || undefined,
                shoes: result.extractedClothing.shoes || undefined,
                fullBody: result.extractedClothing.fullBody || undefined,
              },
            } : char.clothing;
            // Update characters state (include physicalTraitsSource)
            setCharacters(prev => prev.map(c =>
              c.id === char.id ? { ...c, avatars: freshAvatars, physical: updatedPhysical, physicalTraitsSource: updatedTraitsSource, clothing: updatedClothing } : c
            ));
            // Also update currentCharacter if it matches
            setCurrentCharacter(prev => prev && prev.id === char.id ? { ...prev, avatars: freshAvatars, physical: updatedPhysical, physicalTraitsSource: updatedTraitsSource, clothing: updatedClothing } : prev);
            // Save to storage using local state to preserve any unsaved changes
            // Use functional update to get latest characters state
            setCharacters(prevChars => {
              const updatedCharsForSave = prevChars.map(c =>
                c.id === char.id ? { ...c, avatars: freshAvatars, physical: updatedPhysical, physicalTraitsSource: updatedTraitsSource, clothing: updatedClothing } : c
              );
              // Fire save in background (don't await to avoid blocking)
              characterService.saveCharacterData({
                characters: updatedCharsForSave,
                relationships,
                relationshipTexts,
                customRelationships,
                customStrengths: [],
                customWeaknesses: [],
                customFears: [],
              }).catch(err => console.error('Failed to save avatar update:', err));
              return updatedCharsForSave;
            });
            console.log(`[generateStory] ✅ Avatars regenerated for ${char.name}`);
          } else {
            console.warn(`[generateStory] ⚠️ Failed to regenerate avatars for ${char.name}: ${result.error}`);
          }
        } catch (error) {
          console.error(`[generateStory] ❌ Error regenerating avatars for ${char.name}:`, error);
        }
      }
    }

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
      const { jobId: newJobId, creditsRemaining } = await storyService.createStoryJob({
        storyType,
        storyTypeName: getStoryTypeName(),
        storyCategory: storyCategory || undefined,
        storyTopic: storyTopic || undefined,
        storyTheme: storyTheme || undefined,
        customThemeText: storyTheme === 'custom' ? customThemeText : undefined,
        artStyle,
        language: storyLanguage,
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
        // Developer generation mode override (auto = use reading level default)
        generationMode: generationMode !== 'auto' ? generationMode : undefined,
        // Developer skip options
        skipOutline: devSkipOutline,
        skipText: devSkipText,
        skipSceneDescriptions: devSkipSceneDescriptions,
        skipCovers: devSkipCovers,
        // Developer feature options
        enableAutoRepair: enableAutoRepair,
        // Developer model overrides (admin only)
        modelOverrides: (user?.role === 'admin' || isImpersonating) ? {
          outlineModel: modelSelections.outlineModel,
          textModel: modelSelections.textModel,
          sceneDescriptionModel: modelSelections.sceneDescriptionModel,
          imageModel: modelSelections.imageModel,
          coverImageModel: modelSelections.coverImageModel,
          qualityModel: modelSelections.qualityModel,
        } : undefined,
        // User location for landmark discovery
        userLocation: userLocation || undefined,
      });

      setJobId(newJobId);
      log.info('Story job created:', newJobId);

      // Start tracking in global context for background progress visibility
      startTracking(newJobId, getStoryTypeName() || 'New Story');

      // Update credits immediately when job starts (credits are reserved/deducted at job creation)
      if (creditsRemaining !== undefined && creditsRemaining !== null) {
        updateCredits(creditsRemaining);
      }

      // Poll for job status
      let completed = false;
      let lastProgress = 0;
      let lastProgressTime = Date.now();
      const STALL_THRESHOLD_MS = 3 * 60 * 1000; // 3 minutes without progress change
      setIsProgressStalled(false); // Reset stalled state
      while (!completed) {
        await new Promise(resolve => setTimeout(resolve, 2000)); // Poll every 2 seconds

        const status = await storyService.getJobStatus(newJobId);

        if (status.progress) {
          // Only log when progress changes
          if (status.progress.current !== lastProgress) {
            log.debug(`Progress: ${status.progress.current}% - ${status.progress.message || ''}`);
            lastProgress = status.progress.current;
            lastProgressTime = Date.now(); // Reset stall timer on progress
            setIsProgressStalled(false); // Clear stalled state on progress
          } else {
            // Check if stalled (no progress for threshold period)
            const timeSinceProgress = Date.now() - lastProgressTime;
            if (timeSinceProgress >= STALL_THRESHOLD_MS) {
              setIsProgressStalled(true);
            }
          }
          // Only update progress if new value >= current (never go backwards)
          setGenerationProgress(prev => {
            if (status.progress!.current >= prev.current) {
              return status.progress!;
            }
            // Keep current progress but update message if provided
            return status.progress!.message ? { ...prev, message: status.progress!.message } : prev;
          });
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
          // Transition to step 6 (StoryDisplay) when front cover is ready
          if (shouldTransitionToDisplay) {
            log.debug('Transitioning to StoryDisplay - front cover ready');
            setStep(6);
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

        // Debug: Log job status to understand completion detection
        console.log('[StoryWizard] Job status check:', {
          status: status.status,
          hasResult: !!status.result,
          resultKeys: status.result ? Object.keys(status.result) : [],
          progress: status.progress
        });

        if (status.status === 'completed' && status.result) {
          // Job completed successfully
          setStoryId(status.result.storyId);
          setStoryTitle(status.result.title);
          setStoryOutline(status.result.outline);
          setOutlinePrompt(status.result.outlinePrompt || '');
          setOutlineModelId(status.result.outlineModelId);
          setOutlineUsage(status.result.outlineUsage);
          setStoryTextPrompts(status.result.storyTextPrompts || []);
          setStyledAvatarGeneration(status.result.styledAvatarGeneration || []);
          setCostumedAvatarGeneration(status.result.costumedAvatarGeneration || []);
          setGenerationLog(status.result.generationLog || []);
          // Ensure visualBible has required fields (backward compatibility)
          if (status.result.visualBible) {
            setVisualBible({
              mainCharacters: status.result.visualBible.mainCharacters || [],
              secondaryCharacters: status.result.visualBible.secondaryCharacters || [],
              animals: status.result.visualBible.animals || [],
              artifacts: status.result.visualBible.artifacts || [],
              locations: status.result.visualBible.locations || [],
              vehicles: status.result.visualBible.vehicles || [],
              clothing: status.result.visualBible.clothing || [],
              changeLog: status.result.visualBible.changeLog || []
            });
          } else {
            setVisualBible(null);
          }
          setGeneratedStory(status.result.story);
          setOriginalStory(status.result.story); // Store original for restore functionality
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

          // Ensure we're on step 6 (StoryDisplay) when generation completes
          setStep(6);

          log.success('Story generation completed!');

          // Save generation settings for dev mode display (use current wizard state)
          setSavedGenerationSettings({
            storyCategory: storyCategory || undefined,
            storyTopic: storyTopic || undefined,
            storyTheme: storyTheme || undefined,
            storyTypeName: getStoryTypeName(),
            storyDetails: storyDetails || undefined,
            artStyle: artStyle || undefined,
            language: storyLanguage || undefined,
            languageLevel: languageLevel || undefined,
            pages: pages || undefined,
            dedication: dedication || undefined,
            characters: characters.map(c => ({ id: c.id, name: c.name })),
            mainCharacters: mainCharacters,
            relationships: relationships,
            relationshipTexts: relationshipTexts,
            season: season || undefined,
            userLocation: userLocation || undefined,
          });

          // Mark that we just finished generating (skip server reload since data is in state)
          justFinishedGenerating.current = true;

          // Stop tracking in global context
          stopTracking();
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
            showError(language === 'de'
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
        showError(language === 'de'
          ? `Generierung fehlgeschlagen: ${errorMessage}`
          : language === 'fr'
          ? `Échec de la génération: ${errorMessage}`
          : `Generation failed: ${errorMessage}`);
      }
    } finally {
      setIsProgressStalled(false); // Reset stalled state
      stopTracking(); // Ensure global tracking is stopped
      setTimeout(() => setIsGenerating(false), 500);
    }
  };

  // Trigger auto-generate if pending (from email verification redirect)
  useEffect(() => {
    if (pendingAutoGenerate.current && isAuthenticated && characters.length > 0 && step === 5 && !isGenerating) {
      pendingAutoGenerate.current = false;

      // Check if another window already started generation (within last 2 minutes)
      const generationStarted = localStorage.getItem('verificationGenerationStarted');
      if (generationStarted) {
        const startedTime = parseInt(generationStarted, 10);
        const twoMinutesAgo = Date.now() - 2 * 60 * 1000;
        if (startedTime > twoMinutesAgo) {
          // Another window recently started - don't duplicate
          console.log('Another window already started generation, skipping auto-generate');
          return;
        }
        // Flag is stale, clear it and proceed
        localStorage.removeItem('verificationGenerationStarted');
      }

      // Mark that we're starting generation (prevents other window from also starting)
      localStorage.setItem('verificationGenerationStarted', Date.now().toString());

      // Refresh user to get updated emailVerified status, then generate
      const autoGen = async () => {
        await refreshUser(); // Ensure we have fresh email verification status
        // Small delay to ensure UI is ready, skip email check since we just verified
        setTimeout(() => {
          generateStory({ skipEmailCheck: true });
        }, 500);
      };
      autoGen();
    }
  }, [isAuthenticated, characters, step, isGenerating, refreshUser]);

  // Render current step content
  // NEW ORDER: 1=Characters, 2=Relationships, 3=BookSettings, 4=StoryType+Settings
  const renderStep = () => {
    switch (step) {
      case 1:
        // Step 1: Characters (was step 2)
        return (
          <WizardStep2Characters
            characters={characters}
            currentCharacter={currentCharacter}
            characterStep={characterStep}
            showCharacterCreated={showCharacterCreated}
            isLoading={isLoading}
            isAnalyzingPhoto={isAnalyzingPhoto}
            isGeneratingAvatar={isGeneratingAvatar}
            isRegeneratingAvatars={isRegeneratingAvatars}
            isRegeneratingAvatarsWithTraits={isRegeneratingAvatarsWithTraits}
            developerMode={developerMode}
            isImpersonating={isImpersonating}
            changedTraits={changedTraits}
            photoAnalysisDebug={photoAnalysisDebug}
            mainCharacters={mainCharacters}
            excludedCharacters={excludedCharacters}
            onCharacterRoleChange={handleCharacterRoleChange}
            onCharacterChange={setCurrentCharacter}
            onCharacterStepChange={setCharacterStep}
            onContinueToAvatar={() => setCharacterStep('avatar')}
            onPhotoSelect={handlePhotoSelect}
            onSaveAndGenerateAvatar={handleSaveAndGenerateAvatar}
            onSaveCharacter={saveCharacter}
            onEditCharacter={editCharacter}
            onDeleteCharacter={deleteCharacter}
            onStartNewCharacter={startNewCharacter}
            onRegenerateAvatars={handleRegenerateAvatars}
            onRegenerateAvatarsWithTraits={handleRegenerateAvatarsWithTraits}
            onSaveAndRegenerateWithTraits={handleSaveAndRegenerateWithTraits}
            onSaveAndTryNewPhoto={async () => {
              // Save the character but keep it selected, then go to photo step
              log.info(`📸 onSaveAndTryNewPhoto called, currentCharacter: ${currentCharacter?.name}`);
              if (!currentCharacter) {
                log.warn('📸 No currentCharacter, returning early');
                return;
              }

              setIsLoading(true);
              try {
                // Check if this is an edit (existing character) or new character
                const isEdit = currentCharacter.id && characters.find(c => c.id === currentCharacter.id);
                const updatedCharacters = isEdit
                  ? characters.map(c => c.id === currentCharacter.id ? currentCharacter : c)
                  : [...characters, currentCharacter];

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

                setCharacters(updatedCharacters);
                autoSelectMainCharacters(updatedCharacters);

                // Keep current character selected and go to photo step
                log.info(`📸 Setting characterStep to 'photo', currentCharacter still: ${currentCharacter?.name}`);
                setCharacterStep('photo');
              } catch (error) {
                log.error('📸 Error saving character:', error);
              } finally {
                setIsLoading(false);
                log.info(`📸 onSaveAndTryNewPhoto complete, characterStep should now be 'photo'`);
              }
            }}
            relationships={relationships}
            relationshipTexts={relationshipTexts}
            onRelationshipChange={updateRelationship}
            onRelationshipTextChange={updateRelationshipText}
            customRelationships={customRelationships}
            onAddCustomRelationship={addCustomRelationship}
          />
        );

      case 2:
        // Step 2: Book Settings (reading level + pages + location + season)
        return (
          <WizardStep3BookSettings
            languageLevel={languageLevel}
            onLanguageLevelChange={setLanguageLevel}
            pages={pages}
            onPagesChange={setPages}
            storyLanguage={storyLanguage}
            onStoryLanguageChange={setStoryLanguage}
            developerMode={developerMode}
            userLocation={userLocation}
            onLocationChange={setUserLocation}
            season={season}
            onSeasonChange={setSeason}
            userCredits={isImpersonating ? -1 : (user?.credits ?? 0)}
          />
        );

      case 3:
        // Step 3: Story Type Only
        return (
          <WizardStep4StoryType
            storyCategory={storyCategory}
            storyTopic={storyTopic}
            storyTheme={storyTheme}
            customThemeText={customThemeText}
            onCategoryChange={handleCategoryChange}
            onTopicChange={handleTopicChange}
            onThemeChange={handleThemeChange}
            onCustomThemeTextChange={setCustomThemeText}
            onLegacyStoryTypeChange={setStoryType}
          />
        );

      case 4:
        // Step 4: Art Style Selection
        return (
          <WizardStep5ArtStyle
            artStyle={artStyle}
            onArtStyleChange={handleArtStyleSelect}
          />
        );

      case 5:
        // Step 5: Summary & Story Details
        return (
          <WizardStep6Summary
            characters={characters}
            mainCharacters={mainCharacters}
            excludedCharacters={excludedCharacters}
            storyCategory={storyCategory}
            storyTopic={storyTopic}
            storyTheme={storyTheme}
            customThemeText={customThemeText}
            onCustomThemeTextChange={setCustomThemeText}
            artStyle={artStyle}
            storyLanguage={storyLanguage}
            languageLevel={languageLevel}
            pages={pages}
            userLocation={userLocation}
            season={season}
            storyDetails={storyDetails}
            onStoryDetailsChange={setStoryDetails}
            dedication={dedication}
            onDedicationChange={setDedication}
            onGenerateIdeas={generateIdeas}
            isGeneratingIdeas={isGeneratingIdeas}
            isGeneratingIdea1={isGeneratingIdea1}
            isGeneratingIdea2={isGeneratingIdea2}
            ideaPrompt={lastIdeaPrompt}
            ideaFullResponse={lastIdeaFullResponse}
            generatedIdeas={generatedIdeas}
            onSelectIdea={handleSelectIdea}
            onEditStep={safeSetStep}
            developerMode={developerMode}
            imageGenMode={imageGenMode}
            onImageGenModeChange={setImageGenMode}
            generationMode={generationMode}
            onGenerationModeChange={setGenerationMode}
          />
        );

      case 6:
        // Step 6: Show StoryDisplay when we have any content to display
        // During generation: show as soon as we have story text OR any cover image
        // After generation: show if we have the final story
        if (generatedStory || progressiveStoryData ||
            (isGenerating && (coverImages.frontCover || coverImages.initialPage || coverImages.backCover))) {
          // Build scene images from progressive data if still generating
          const displaySceneImages = generatedStory
            ? sceneImages
            : Object.entries(completedPageImages).map(([pageNum, imageData]) => ({
                pageNumber: parseInt(pageNum),
                imageData,
                description: progressiveStoryData?.sceneDescriptions.find(s => s.pageNumber === parseInt(pageNum))?.description || ''
              }));

          // Debug scene images
          console.log('[StoryWizard] Scene images debug:', {
            generatedStory: !!generatedStory,
            sceneImagesCount: sceneImages.length,
            completedPageImagesCount: Object.keys(completedPageImages).length,
            displaySceneImagesCount: displaySceneImages.length,
            displaySceneImages: displaySceneImages.map(img => ({ pageNumber: img.pageNumber, hasImage: !!img.imageData }))
          });

          // Build story text from progressive data if still generating
          const displayStory = generatedStory || Object.entries(progressiveStoryData?.pageTexts || {})
            .sort(([a], [b]) => parseInt(a) - parseInt(b))
            .map(([pageNum, text]) => `--- Page ${pageNum} ---\n${text}`)
            .join('\n\n');

          return (
            <>
              {/* Floating image loading progress indicator */}
              {imageLoadProgress && imageLoadProgress.total > 0 && (
                <div className="fixed top-20 left-1/2 transform -translate-x-1/2 z-50 bg-white/95 backdrop-blur-sm rounded-full shadow-lg px-4 py-2 flex items-center gap-3 border border-indigo-100">
                  <div className="w-24 h-2 bg-gray-200 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-indigo-500 transition-all duration-300 ease-out"
                      style={{ width: `${(imageLoadProgress.loaded / imageLoadProgress.total) * 100}%` }}
                    />
                  </div>
                  <span className="text-sm text-gray-600 whitespace-nowrap">
                    {language === 'de'
                      ? `Bilder: ${imageLoadProgress.loaded}/${imageLoadProgress.total}`
                      : language === 'fr'
                      ? `Images: ${imageLoadProgress.loaded}/${imageLoadProgress.total}`
                      : `Images: ${imageLoadProgress.loaded}/${imageLoadProgress.total}`
                    }
                  </span>
                </div>
              )}
              <StoryDisplay
              title={storyTitle}
              story={displayStory}
              originalStory={originalStory}
              outline={storyOutline}
              outlinePrompt={outlinePrompt}
              outlineModelId={outlineModelId}
              outlineUsage={outlineUsage}
              storyTextPrompts={storyTextPrompts}
              visualBible={visualBible || undefined}
              sceneImages={displaySceneImages}
              sceneDescriptions={progressiveStoryData?.sceneDescriptions || sceneDescriptions}
              characters={storyCharacters || characters.filter(c => !excludedCharacters.includes(c.id))}
              // Progressive mode props - active when generating (even before story text arrives)
              progressiveMode={isGenerating}
              progressiveData={progressiveStoryData || undefined}
              completedPageImages={completedPageImages}
              coverImages={coverImages}
              languageLevel={languageLevel}
              storyLanguage={storyLanguage}
              isGenerating={isGenerating}
              developerMode={developerMode}
              styledAvatarGeneration={styledAvatarGeneration}
              costumedAvatarGeneration={costumedAvatarGeneration}
              generationLog={generationLog}
              storyId={storyId}
              onVisualBibleChange={storyId ? async (updatedBible) => {
                try {
                  log.info('Updating Visual Bible for story:', storyId);
                  await storyService.updateVisualBible(storyId, updatedBible);
                  setVisualBible(updatedBible);
                  log.success('Visual Bible updated successfully');
                } catch (error) {
                  log.error('Failed to update Visual Bible:', error);
                  showError(language === 'de'
                    ? 'Visual Bible konnte nicht aktualisiert werden'
                    : language === 'fr'
                    ? 'Échec de la mise à jour de la Bible Visuelle'
                    : 'Failed to update Visual Bible');
                }
              } : undefined}
              onRegenerateImage={storyId ? async (pageNumber: number, editedScene?: string, characterIds?: number[]) => {
                try {
                  log.info('Regenerating image for page:', pageNumber, editedScene ? '(scene edited)' : '', characterIds ? `(${characterIds.length} characters)` : '');
                  setIsGenerating(true);
                  const result = await storyService.regenerateImage(storyId, pageNumber, editedScene, characterIds);
                  log.info('Regenerate result:', { hasImageData: !!result?.imageData, length: result?.imageData?.length, versionCount: result?.versionCount, creditsRemaining: result?.creditsRemaining });
                  if (!result?.imageData) {
                    log.error('No imageData in response!', result);
                    throw new Error('No image data returned from server');
                  }
                  // Update the scene images array with all returned data (including quality evaluation and imageVersions)
                  setSceneImages(prev => prev.map(img =>
                    img.pageNumber === pageNumber ? {
                      ...img,
                      imageData: result.imageData,
                      description: result.newDescription || img.description,  // Update description if scene was edited
                      prompt: result.newPrompt,  // Store the prompt for dev mode
                      qualityScore: result.qualityScore,
                      qualityReasoning: result.qualityReasoning,
                      totalAttempts: result.totalAttempts,
                      retryHistory: result.retryHistory,
                      wasRegenerated: true,
                      originalImage: result.originalImage,
                      originalScore: result.originalScore,
                      originalReasoning: result.originalReasoning,
                      imageVersions: result.imageVersions
                    } : img
                  ));
                  // Update user credits if we got the new balance
                  if (result.creditsRemaining !== undefined && updateCredits) {
                    updateCredits(result.creditsRemaining);
                  }
                  log.info('Image regenerated successfully, updated state');
                } catch (error) {
                  log.error('Image regeneration failed:', error);
                  const errorMsg = error instanceof Error ? error.message : String(error);
                  showError(language === 'de'
                    ? `Bildgenerierung fehlgeschlagen: ${errorMsg}`
                    : language === 'fr'
                    ? `Échec de la régénération: ${errorMsg}`
                    : `Image regeneration failed: ${errorMsg}`);
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
                  showError(language === 'de'
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
                    showError(language === 'de'
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
                    showSuccess(language === 'de'
                      ? `Druckauftrag erstellt! Order ID: ${result.orderId}`
                      : language === 'fr'
                      ? `Commande créée! ID: ${result.orderId}`
                      : `Print order created! Order ID: ${result.orderId}`);
                  }
                } catch (error) {
                  log.error('Print order failed:', error);
                  const errorMsg = error instanceof Error ? error.message : String(error);
                  showError(language === 'de'
                    ? `Druckauftrag fehlgeschlagen: ${errorMsg}`
                    : language === 'fr'
                    ? `Échec de la commande d'impression: ${errorMsg}`
                    : `Print order failed: ${errorMsg}`);
                }
              } : undefined}
              onCreateAnother={() => {
                // Reset story state but keep characters and relationships
                log.info('Creating new story - resetting settings');

                // Clear story ID and URL parameter
                setStoryId(null);
                setJobId(null);
                setStoryCharacters(null);
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
                setStoryCategory('' as any);
                setStoryTopic('');
                setStoryTheme('');
                setArtStyle('watercolor');
                setLanguageLevel('standard');
                setPages(30);
                setDedication('');
                setStoryDetails('');
                setExcludedCharacters([]);

                // Clear localStorage for story settings
                localStorage.removeItem('story_type');
                localStorage.removeItem('story_category');
                localStorage.removeItem('story_topic');
                localStorage.removeItem('story_theme');
                localStorage.removeItem('story_art_style');
                localStorage.removeItem('story_language_level');
                localStorage.removeItem('story_pages');
                localStorage.removeItem('story_dedication');
                localStorage.removeItem('story_details');
                localStorage.removeItem('story_main_characters');
                localStorage.removeItem('story_excluded_characters');
                localStorage.removeItem('wizard_step');
                localStorage.removeItem('verificationGenerationStarted');

                // Clear any character being edited and reset to character list
                setCurrentCharacter(null);
                setCharacterStep('photo');

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
                  // Update user credits if we got the new balance
                  if (result.creditsRemaining !== undefined && updateCredits) {
                    updateCredits(result.creditsRemaining);
                  }
                  log.info('Cover regenerated successfully');
                } catch (error) {
                  log.error('Cover regeneration failed:', error);
                  const errorMsg = error instanceof Error ? error.message : String(error);
                  showError(language === 'de'
                    ? `Cover-Generierung fehlgeschlagen: ${errorMsg}`
                    : language === 'fr'
                    ? `Échec de la régénération: ${errorMsg}`
                    : `Cover regeneration failed: ${errorMsg}`);
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
              // Auto-repair image (dev mode only)
              onRepairImage={storyId && (user?.role === 'admin' || isImpersonating) ? async (pageNumber: number) => {
                try {
                  log.info('Starting auto-repair for page:', pageNumber);
                  const result = await storyService.repairImage(storyId, pageNumber);

                  if (result.repaired) {
                    // Update the scene image with the repaired version
                    setSceneImages(prev => prev.map(img => {
                      if (img.pageNumber === pageNumber) {
                        return {
                          ...img,
                          imageData: result.imageData,
                          wasAutoRepaired: true,
                          repairHistory: result.repairHistory,
                          repairedAt: new Date().toISOString()
                        };
                      }
                      return img;
                    }));
                    log.info('Auto-repair completed successfully:', { repaired: result.repaired, repairs: result.repairHistory.length });
                  } else if (result.noErrorsFound) {
                    log.info('No physics errors detected in the image');
                    // Could show a toast/notification here
                  }
                } catch (error) {
                  log.error('Auto-repair failed:', error);
                  throw error;
                }
              } : undefined}
              // Story text editing
              onSaveStoryText={storyId ? async (text: string) => {
                try {
                  log.info('Saving story text for story:', storyId);
                  await storyService.saveStoryText(storyId, text);
                  setGeneratedStory(text);
                  log.info('Story text saved successfully');
                } catch (error) {
                  log.error('Failed to save story text:', error);
                  throw error; // Re-throw so StoryDisplay can show error
                }
              } : undefined}
              // Title editing
              onSaveTitleChange={storyId ? async (newTitle: string) => {
                try {
                  log.info('Saving title for story:', storyId, newTitle);
                  await storyService.saveStoryTitle(storyId, newTitle);
                  setStoryTitle(newTitle);
                  log.info('Title saved successfully');
                } catch (error) {
                  log.error('Failed to save title:', error);
                  throw error;
                }
              } : undefined}
              // Image regeneration with credits
              userCredits={isImpersonating ? -1 : (user?.credits || 0)}
              imageRegenerationCost={5}
              isImpersonating={isImpersonating}
              onSelectImageVersion={storyId ? async (pageNumber: number, versionIndex: number) => {
                try {
                  log.info('Selecting image version:', { pageNumber, versionIndex });
                  const result = await storyService.setActiveImage(storyId, pageNumber, versionIndex);
                  // Update local state with the active version's image data
                  setSceneImages(prev => prev.map(img => {
                    if (img.pageNumber === pageNumber && img.imageVersions) {
                      const activeVersion = img.imageVersions[versionIndex];
                      return {
                        ...img,
                        imageData: activeVersion?.imageData || img.imageData,
                        imageVersions: img.imageVersions.map((v, i) => ({
                          ...v,
                          isActive: i === versionIndex
                        }))
                      };
                    }
                    return img;
                  }));
                  log.info('Image version selected:', result);
                } catch (error) {
                  log.error('Failed to select image version:', error);
                  throw error;
                }
              } : undefined}
              isPartial={isPartialStory}
              failureReason={failureReason}
              generatedPages={generatedPages}
              totalPages={totalPages}
              generationSettings={savedGenerationSettings || undefined}
            />
            </>
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
        // If generating but no content yet, show a loading indicator
        // (This can happen if we transition to step 6 before data arrives)
        if (isGenerating) {
          return (
            <div className="flex flex-col items-center justify-center py-12">
              <div className="animate-spin rounded-full h-12 w-12 border-4 border-indigo-300 border-t-indigo-600 mb-4"></div>
              <p className="text-xl font-semibold text-indigo-700">
                {language === 'de' ? 'Geschichte wird erstellt...' : language === 'fr' ? 'Création de l\'histoire...' : 'Creating your story...'}
              </p>
              <p className="text-indigo-500 mt-2">
                {language === 'de' ? 'Einen Moment Geduld bitte' : language === 'fr' ? 'Veuillez patienter' : 'Please wait a moment'}
              </p>
            </div>
          );
        }
        return (
          <div className="text-center py-12">
            <Sparkles className="w-16 h-16 text-gray-300 mx-auto mb-4" />
            <h2 className="text-2xl font-bold text-gray-800 mb-4">{t.generateStory}</h2>
            <p className="text-gray-600 mb-6">
              {language === 'de' ? 'Bereit, deine Geschichte zu erstellen!' : language === 'fr' ? 'Prêt à créer votre histoire!' : 'Ready to create your story!'}
            </p>

            <Button onClick={() => generateStory()} size="lg" icon={Sparkles}>
              {t.generateStory} ({pages * 10} Credits)
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
      {/* Navigation with step indicators (hidden when viewing a saved story) */}
      <Navigation
        currentStep={step}
        onStepClick={safeSetStep}
        canAccessStep={canAccessStep}
        developerMode={developerMode}
        onDeveloperModeChange={setDeveloperMode}
        hideSteps={step === 6 && !!storyId}
        onShowGenerationProgress={() => {
          // Show the generation progress modal when clicking nav progress indicator
          setIsProgressMinimized(false);
          setStep(6);
        }}
      />

      {/* Main content - full width */}
      <div className="px-3 md:px-8 mt-2 md:mt-8 flex-1">
        <div className="md:bg-white md:rounded-2xl md:shadow-xl md:p-8">
          {isLoading && !isGenerating ? (
            <div className="py-12 flex flex-col items-center justify-center">
              <Loader2 className="w-12 h-12 text-indigo-600 animate-spin mb-4" />
              <p className="text-gray-600 font-medium mb-2">
                {loadingProgress
                  ? (language === 'de' ? 'Geschichte wird geladen...' : language === 'fr' ? 'Chargement de l\'histoire...' : 'Loading story...')
                  : (language === 'de' ? 'Wird geladen...' : language === 'fr' ? 'Chargement...' : 'Loading...')
                }
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
            <>
              {/* Helper text for steps 1-5, hidden when editing character */}
              {step >= 1 && step <= 5 && !currentCharacter && (
                <WizardHelperText
                  step={step}
                  text={(wizardHelperTexts[language] || wizardHelperTexts.en)[step]}
                />
              )}
              {renderStep()}
            </>
          )}

          {/* Navigation buttons - inside the container */}
          {step < 6 && !currentCharacter && (
            <div className="mt-6 pt-6 border-t border-gray-200">
              {/* Warning for undefined relationships in step 1 */}
              {step === 1 && characters.length >= 2 && !areAllRelationshipsDefined() && (() => {
                const charWithUndefined = getCharacterWithMostUndefinedRelationships();
                if (!charWithUndefined) return null;
                const warningText = language === 'de'
                  ? `${charWithUndefined.name} hat Beziehungen, die nicht definiert sind ("nicht bekannt")`
                  : language === 'fr'
                  ? `${charWithUndefined.name} a des relations non définies ("ne connaît pas")`
                  : `${charWithUndefined.name} has undefined relationships ("not known to")`;
                return (
                  <div className="mb-4 p-3 bg-amber-50 border border-amber-200 rounded-lg flex items-start gap-2">
                    <span className="text-amber-600 text-lg">⚠️</span>
                    <p className="text-amber-700 text-sm">{warningText}</p>
                  </div>
                );
              })()}
              {/* Steps 1-4: Back and Next buttons side by side */}
              {step !== 5 && (
                <div className={`flex ${step === 1 ? 'justify-end' : 'justify-between'}`}>
                  {/* Hide back button on step 1 */}
                  {step > 1 && (
                    <button
                      onClick={goBack}
                      className="bg-transparent text-gray-800 hover:bg-gray-100 px-6 py-3 rounded-lg font-semibold flex items-center gap-2"
                    >
                      <ArrowLeft size={20} /> {t.back}
                    </button>
                  )}
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

              {/* Step 5: Generate button first, then back button */}
              {step === 5 && (
                <div className="space-y-4">
                  {/* Generate Story button - primary action at top */}
                  <button
                    onClick={() => generateStory()}
                    disabled={!canGoNext()}
                    className={`w-full py-3 rounded-lg font-bold text-base flex items-center justify-center gap-2 ${
                      !canGoNext()
                        ? 'bg-gray-400 text-white cursor-not-allowed'
                        : 'bg-indigo-600 text-white hover:bg-indigo-700'
                    }`}
                  >
                    <Sparkles size={20} /> {t.generateStory} ({pages * 10} Credits)
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

                      {/* Feature Toggles */}
                      <h3 className="text-sm font-semibold text-orange-700 mt-4 mb-2">
                        🔧 {language === 'de' ? 'Feature-Optionen' : language === 'fr' ? 'Options de fonctionnalités' : 'Feature Options'}
                      </h3>
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={enableAutoRepair}
                          onChange={(e) => setEnableAutoRepair(e.target.checked)}
                          className="rounded border-orange-300 text-orange-600 focus:ring-orange-500"
                        />
                        <span className="text-gray-700">{language === 'de' ? 'Auto-Reparatur aktivieren' : language === 'fr' ? 'Activer la réparation auto' : 'Enable auto-repair'}</span>
                      </label>
                      <p className="text-xs text-gray-500 ml-6">
                        {language === 'de' ? 'Versucht erkannte Bildfehler automatisch zu korrigieren (z.B. fehlende Finger)' : language === 'fr' ? 'Essaie de corriger automatiquement les erreurs d\'image détectées' : 'Attempts to automatically fix detected image issues (e.g., missing fingers)'}
                      </p>
                    </div>
                  )}

                  {/* Developer Model Selection - Admin only (or admin impersonating) */}
                  {developerMode && (user?.role === 'admin' || isImpersonating) && (
                    <ModelSelector
                      selections={modelSelections}
                      onChange={setModelSelections}
                    />
                  )}

                  {/* Back button at the bottom */}
                  <button
                    onClick={goBack}
                    className="bg-transparent text-gray-800 hover:bg-gray-100 px-6 py-3 rounded-lg font-semibold flex items-center gap-2"
                  >
                    <ArrowLeft size={20} /> {t.back}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Generation Progress Modal - Full story generation */}
      {/* Show until we have content to display (front cover, story data, or final story), or user minimizes */}
      {isGenerating && !generatedStory && !progressiveStoryData && !coverImages.frontCover && !isProgressMinimized && (
        <GenerationProgress
          current={generationProgress.current}
          total={generationProgress.total}
          message={generationProgress.message}
          coverImages={coverImages}
          characters={characters}
          jobId={jobId || undefined}
          isStalled={isProgressStalled}
          onDismissStalled={() => setIsProgressStalled(false)}
          isImpersonating={isImpersonating}
          onMinimize={() => setShowMinimizeDialog(true)}
          onCancel={jobId ? async () => {
            try {
              await storyService.cancelJob(jobId);
              log.info('Job cancelled by user');
              setIsGenerating(false);
              setJobId(null);
              setIsProgressStalled(false);
              setGenerationProgress({ current: 0, total: 0, message: '' });
              showInfo(language === 'de'
                ? 'Generierung abgebrochen'
                : language === 'fr'
                ? 'Génération annulée'
                : 'Generation cancelled');
            } catch (error) {
              log.error('Failed to cancel job:', error);
              showError(language === 'de'
                ? 'Abbruch fehlgeschlagen'
                : language === 'fr'
                ? 'Échec de l\'annulation'
                : 'Failed to cancel');
            }
          } : undefined}
        />
      )}

      {/* Minimize Choice Dialog - shown when user clicks "Continue in Background" */}
      {showMinimizeDialog && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-2xl p-6 max-w-sm mx-4 shadow-xl">
            <h3 className="text-lg font-semibold mb-2">
              {language === 'de' ? 'Geschichte wird im Hintergrund generiert' : language === 'fr' ? 'Histoire en cours de génération' : 'Story generating in background'}
            </h3>
            <p className="text-gray-600 mb-6">
              {language === 'de' ? 'Was möchtest du tun?' : language === 'fr' ? 'Que voulez-vous faire?' : 'What would you like to do?'}
            </p>
            <div className="space-y-3">
              <button
                onClick={() => {
                  setIsProgressMinimized(true);
                  setShowMinimizeDialog(false);
                  navigate('/create?new=true');
                }}
                className="w-full py-3 px-4 bg-indigo-600 text-white rounded-xl hover:bg-indigo-700 transition-colors font-medium"
              >
                {language === 'de' ? 'Neue Geschichte erstellen' : language === 'fr' ? 'Créer une autre histoire' : 'Create another story'}
              </button>

              {userHasStories && (
                <button
                  onClick={() => {
                    setIsProgressMinimized(true);
                    setShowMinimizeDialog(false);
                    navigate('/stories');
                  }}
                  className="w-full py-3 px-4 bg-gray-100 text-gray-800 rounded-xl hover:bg-gray-200 transition-colors font-medium"
                >
                  {language === 'de' ? 'Meine Geschichten lesen' : language === 'fr' ? 'Lire mes histoires' : 'Read my stories'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Single Character Dialog - shown when user has only 1 character */}
      {showSingleCharacterDialog && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-2xl p-6 max-w-sm mx-4 shadow-xl">
            <h3 className="text-lg font-semibold mb-2">
              {language === 'de' ? 'Nur ein Charakter' : language === 'fr' ? 'Un seul personnage' : 'Only One Character'}
            </h3>
            <p className="text-gray-600 mb-6">
              {language === 'de'
                ? 'Geschichten werden interessanter mit mehreren Charakteren. Du hast nur einen Charakter erstellt.'
                : language === 'fr'
                ? 'Les histoires sont plus intéressantes avec plusieurs personnages. Vous n\'avez créé qu\'un seul personnage.'
                : 'Stories are more interesting with multiple characters. You have only created one character.'}
            </p>
            <div className="space-y-3">
              <button
                onClick={() => {
                  setShowSingleCharacterDialog(false);
                  startNewCharacter();
                }}
                className="w-full py-3 px-4 bg-indigo-600 text-white rounded-xl hover:bg-indigo-700 transition-colors font-medium"
              >
                {language === 'de' ? 'Weiteren Charakter erstellen' : language === 'fr' ? 'Créer un autre personnage' : 'Create another character'}
              </button>

              <button
                onClick={async () => {
                  setShowSingleCharacterDialog(false);
                  await safeSetStep(step + 1);
                }}
                className="w-full py-3 px-4 bg-gray-100 text-gray-800 rounded-xl hover:bg-gray-200 transition-colors font-medium"
              >
                {language === 'de' ? 'Trotzdem weiter' : language === 'fr' ? 'Continuer quand même' : 'Continue anyway'}
              </button>
            </div>
          </div>
        </div>
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
                    showError(language === 'de'
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

      {/* Face Selection Modal - When photo has multiple people */}
      <FaceSelectionModal
        isOpen={showFaceSelectionModal}
        faces={detectedFaces}
        onSelect={handleFaceSelection}
        onUploadNew={handleFaceSelectionUploadNew}
        developerMode={developerMode}
      />

      {/* Email Verification Modal */}
      <EmailVerificationModal
        isOpen={showEmailVerificationModal}
        onClose={() => setShowEmailVerificationModal(false)}
        onVerified={() => {
          console.log('[EmailVerification] onVerified callback triggered');

          // Email verified! Check if another window already started generation
          const generationStarted = localStorage.getItem('verificationGenerationStarted');
          if (generationStarted) {
            // Check if the flag is recent (within last 2 minutes) - old flags should be ignored
            const startedTime = parseInt(generationStarted, 10);
            const twoMinutesAgo = Date.now() - 2 * 60 * 1000;
            if (startedTime > twoMinutesAgo) {
              // Another window recently started - just close modal
              console.log('[EmailVerification] Another window started recently, skipping');
              setShowEmailVerificationModal(false);
              return;
            }
            // Flag is stale, clear it and proceed
            console.log('[EmailVerification] Clearing stale flag');
            localStorage.removeItem('verificationGenerationStarted');
          }

          // Mark that we're starting generation (prevents other window from also starting)
          localStorage.setItem('verificationGenerationStarted', Date.now().toString());
          // Clear pending flags
          localStorage.removeItem('pendingStoryGeneration');
          localStorage.removeItem('pending_story_type');
          localStorage.removeItem('pending_art_style');

          console.log('[EmailVerification] Calling generateStory with skipEmailCheck: true');
          // Skip email check since we just verified (React state may not have updated yet)
          // Call generateStory BEFORE closing modal to ensure it runs
          generateStory({ skipEmailCheck: true });

          // Close modal after starting generation
          setShowEmailVerificationModal(false);
        }}
      />
    </div>
  );
}
