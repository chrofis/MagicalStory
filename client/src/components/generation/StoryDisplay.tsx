import { useState, useEffect } from 'react';
import { BookOpen, FileText, ShoppingCart, Plus, Download, RefreshCw, Edit3, Save, X, Images, RotateCcw, Wrench, Loader } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import { DiagnosticImage } from '@/components/common';
import type { SceneImage, SceneDescription, CoverImages, CoverImageData, ImageVersion, RepairAttempt, StoryLanguageCode, GenerationLogEntry } from '@/types/story';
import type { LanguageLevel } from '@/types/story';
import type { VisualBible } from '@/types/character';
import { RetryHistoryDisplay, ReferencePhotosDisplay, SceneEditModal, ImageHistoryModal, EnlargedImageModal, GenerationSettingsPanel } from './story';
import type { GenerationSettings } from './story';

interface StoryTextPrompt {
  batch: number;
  startPage: number;
  endPage: number;
  prompt: string;
  rawResponse?: string;  // Unfiltered API response for dev mode
  modelId?: string;
  usage?: { input_tokens: number; output_tokens: number };
}

interface StyledAvatarGenerationEntry {
  timestamp: string;
  characterName: string;
  artStyle: string;
  durationMs: number;
  success: boolean;
  error?: string;
  inputs: {
    facePhoto: { identifier: string; sizeKB: number; imageData?: string } | null;
    originalAvatar: { identifier: string; sizeKB: number; imageData?: string };
  };
  prompt?: string;
  output?: { identifier: string; sizeKB: number; imageData?: string };
}

interface CostumedAvatarGenerationEntry {
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
}

interface StoryDisplayProps {
  title: string;
  story: string;
  outline?: string;
  outlinePrompt?: string;
  outlineModelId?: string;
  outlineUsage?: { input_tokens: number; output_tokens: number };
  storyTextPrompts?: StoryTextPrompt[];
  visualBible?: VisualBible;
  sceneImages: SceneImage[];
  sceneDescriptions?: SceneDescription[];
  coverImages?: CoverImages;
  languageLevel?: LanguageLevel;
  storyLanguage?: StoryLanguageCode;  // Language of the story content (for correct labels)
  isGenerating?: boolean;
  onDownloadPdf?: () => void;
  onAddToBook?: () => void;
  onPrintBook?: () => void;
  onCreateAnother?: () => void;
  onDownloadTxt?: () => void;
  onRegenerateImage?: (pageNumber: number, editedScene?: string, characterIds?: number[]) => Promise<void>;
  onRegenerateCover?: (coverType: 'front' | 'back' | 'initial') => Promise<void>;
  // Characters for scene edit modal
  characters?: Array<{ id: number; name: string; photoData?: string }>;
  onEditImage?: (pageNumber: number) => void;
  onEditCover?: (coverType: 'front' | 'back' | 'initial') => void;
  onRepairImage?: (pageNumber: number) => Promise<void>;
  onVisualBibleChange?: (visualBible: VisualBible) => void;
  storyId?: string | null;
  developerMode?: boolean;
  styledAvatarGeneration?: StyledAvatarGenerationEntry[];
  costumedAvatarGeneration?: CostumedAvatarGenerationEntry[];
  generationLog?: GenerationLogEntry[];
  // Partial story fields
  isPartial?: boolean;
  failureReason?: string;
  generatedPages?: number;
  totalPages?: number;
  // Progressive mode (show story while images generate)
  progressiveMode?: boolean;
  progressiveData?: {
    title: string;
    dedication?: string;
    pageTexts: Record<number, string>;
    sceneDescriptions: SceneDescription[];
    totalPages: number;
    totalScenes?: number;  // Number of images to expect (may differ from totalPages for 2:1 layouts)
  };
  completedPageImages?: Record<number, string>;
  // Story text editing
  originalStory?: string;
  onSaveStoryText?: (text: string) => Promise<void>;
  // Title editing
  onSaveTitleChange?: (title: string) => Promise<void>;
  // Image regeneration with credits
  userCredits?: number;
  imageRegenerationCost?: number;
  isImpersonating?: boolean;
  onSelectImageVersion?: (pageNumber: number, versionIndex: number) => Promise<void>;
  // Generation settings for dev mode
  generationSettings?: GenerationSettings;
}

export function StoryDisplay({
  title,
  story,
  outline,
  outlinePrompt,
  outlineModelId,
  outlineUsage,
  storyTextPrompts = [],
  visualBible,
  sceneImages,
  sceneDescriptions = [],
  coverImages,
  languageLevel = 'standard', // Used to determine layout: '1st-grade' = picture book, others = standard
  storyLanguage,
  isGenerating = false,
  onDownloadPdf,
  onAddToBook,
  onPrintBook,
  onCreateAnother,
  onDownloadTxt,
  onRegenerateImage,
  onRegenerateCover: _onRegenerateCover,
  characters = [],
  onEditImage,
  onEditCover: _onEditCover,
  onRepairImage,
  onVisualBibleChange,
  storyId,
  developerMode = false,
  styledAvatarGeneration = [],
  costumedAvatarGeneration = [],
  generationLog = [],
  isPartial = false,
  failureReason,
  generatedPages,
  totalPages,
  progressiveMode = false,
  progressiveData,
  completedPageImages = {},
  // Story text editing
  originalStory,
  onSaveStoryText,
  // Title editing
  onSaveTitleChange,
  // Image regeneration with credits
  userCredits = 0,
  imageRegenerationCost = 5,
  isImpersonating = false,
  onSelectImageVersion,
  generationSettings,
}: StoryDisplayProps) {
  const { t, language } = useLanguage();

  // Use story language for in-story labels (Page/Seite), fallback to UI language
  // Normalize de-ch/de-de to 'de' for label matching
  const storyLang = storyLanguage
    ? (storyLanguage.startsWith('de') ? 'de' : storyLanguage as 'en' | 'fr')
    : language;

  // Check if user has enough credits (-1 means infinite/unlimited, impersonating admins also bypass)
  const hasEnoughCredits = isImpersonating || userCredits === -1 || userCredits >= imageRegenerationCost;

  // Visual Bible editing state (only used in developer mode)
  const [editingEntry, setEditingEntry] = useState<{ type: string; id: string; field: string } | null>(null);
  const [editValue, setEditValue] = useState('');

  // Story text editing state
  const [isEditMode, setIsEditMode] = useState(false);
  const [editedStory, setEditedStory] = useState(story);
  const [isSaving, setIsSaving] = useState(false);

  // Title editing state
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [editedTitle, setEditedTitle] = useState(title || '');
  const [isSavingTitle, setIsSavingTitle] = useState(false);

  // Image history modal state
  const [imageHistoryModal, setImageHistoryModal] = useState<{ pageNumber: number; versions: ImageVersion[] } | null>(null);

  // Scene edit modal state (for editing scene before regenerating)
  const [sceneEditModal, setSceneEditModal] = useState<{ pageNumber: number; scene: string; selectedCharacterIds: number[] } | null>(null);
  const [isRegenerating, setIsRegenerating] = useState(false);
  const [regeneratingPage, setRegeneratingPage] = useState<number | null>(null); // Track which page is regenerating

  // Auto-repair state (dev mode only)
  const [repairingPage, setRepairingPage] = useState<number | null>(null);

  // Enlarged image modal for repair before/after comparison
  const [enlargedImage, setEnlargedImage] = useState<{ src: string; title: string } | null>(null);

  // Update edited story when story prop changes (e.g., after save)
  useEffect(() => {
    if (!isEditMode) {
      setEditedStory(story);
    }
  }, [story, isEditMode]);

  // Update edited title when title prop changes
  useEffect(() => {
    if (!isEditingTitle) {
      setEditedTitle(title || '');
    }
  }, [title, isEditingTitle]);

  // Handle save story text
  const handleSaveStory = async () => {
    if (!onSaveStoryText) return;
    setIsSaving(true);
    try {
      await onSaveStoryText(editedStory);
      setIsEditMode(false);
    } catch (err) {
      console.error('Failed to save story text:', err);
    } finally {
      setIsSaving(false);
    }
  };

  // Handle save title
  const handleSaveTitle = async () => {
    if (!onSaveTitleChange || !editedTitle.trim()) return;
    setIsSavingTitle(true);
    try {
      await onSaveTitleChange(editedTitle.trim());
      setIsEditingTitle(false);
    } catch (err) {
      console.error('Failed to save title:', err);
    } finally {
      setIsSavingTitle(false);
    }
  };

  // Handle cancel edit
  const handleCancelEdit = () => {
    setEditedStory(story);
    setIsEditMode(false);
  };

  // Handle auto-repair image (dev mode)
  const handleRepairImage = async (pageNumber: number) => {
    if (!onRepairImage || repairingPage !== null) return;
    setRepairingPage(pageNumber);
    try {
      await onRepairImage(pageNumber);
    } catch (err) {
      console.error('Failed to repair image:', err);
    } finally {
      setRepairingPage(null);
    }
  };

  // Handle page text change - updates the specific page in editedStory
  const handlePageTextChange = (pageIndex: number, newText: string) => {
    // Split story into sections (keeps the separators)
    const sections = editedStory.split(/(?=---\s*(?:Page|Seite)\s+\d+\s*---|(?=##\s*(?:Page|Seite)\s+\d+))/i);

    // First section might be empty or contain header info
    // Page sections start from index 1 (or 0 if no header)
    let pageStartIndex = 0;
    for (let i = 0; i < sections.length; i++) {
      if (/^(?:---\s*(?:Page|Seite)\s+\d+\s*---|##\s*(?:Page|Seite)\s+\d+)/i.test(sections[i].trim())) {
        pageStartIndex = i;
        break;
      }
    }

    const targetSectionIndex = pageStartIndex + pageIndex;
    if (targetSectionIndex < sections.length) {
      // Extract the page separator (e.g., "--- Page 1 ---" or "## Page 1")
      const separatorMatch = sections[targetSectionIndex].match(/^(---\s*(?:Page|Seite)\s+\d+\s*---|##\s*(?:Page|Seite)\s+\d+)/i);
      const separator = separatorMatch ? separatorMatch[0] : '';
      // Replace the section content, keeping the separator
      sections[targetSectionIndex] = separator + '\n' + newText.trim() + '\n';
    }

    setEditedStory(sections.join(''));
  };

  // Get image versions for a page
  const getImageVersions = (pageNumber: number): ImageVersion[] => {
    const image = sceneImages.find(img => img.pageNumber === pageNumber);
    return image?.imageVersions || [];
  };

  // Handle selecting a different image version
  const handleSelectVersion = async (pageNumber: number, versionIndex: number) => {
    if (!onSelectImageVersion) return;
    try {
      await onSelectImageVersion(pageNumber, versionIndex);
      setImageHistoryModal(null);
    } catch (err) {
      console.error('Failed to select image version:', err);
    }
  };

  // Extract just the Image Summary from a full scene description
  // IMPORTANT: Always extract Section 6 (translated/localized) for user editing, NOT Section 1 (English)
  const extractImageSummary = (fullDescription: string): string => {
    if (!fullDescription) return '';

    // PRIORITY 1: Section 6 "Image Summary (Language)" - the TRANSLATED version for user editing
    // Handles multiple formats from LLM:
    // Format 1: "6. **Image Summary (Deutsch)**\nSophie kniet..."
    // Format 2: "**6. Image Summary (Deutsch)**\nSophie kniet..."
    // Format 3: "6. **Bildzusammenfassung (Deutsch)**\nSophie kniet..." (fully translated header)
    const section6Match = fullDescription.match(
      /(?:\*\*)?6\.?\s*(?:\*\*)?\s*\*?\*?(Image Summary|Bildzusammenfassung|Résumé de l['']Image)\s*\([^)]+\)\s*\*?\*?\s*([\s\S]*?)(?=\n\s*(?:\*\*)?\d+\.|\n---|\n```|$)/i
    );
    if (section6Match && section6Match[2] && section6Match[2].trim()) {
      return section6Match[2].trim();
    }

    // PRIORITY 2: Look for any "Image Summary (Language)" pattern anywhere (without section number)
    // This catches variations like "**Image Summary (Deutsch):**\nContent..."
    const localizedSummaryMatch = fullDescription.match(
      /\*?\*?(Image Summary|Bildzusammenfassung|Résumé de l['']Image)\s*\([^)]+\)\s*:?\s*\*?\*?\s*\n([\s\S]*?)(?=\n\s*(?:\*\*)?\d+\.|\n\*\*|$)/i
    );
    if (localizedSummaryMatch && localizedSummaryMatch[2] && localizedSummaryMatch[2].trim()) {
      return localizedSummaryMatch[2].trim();
    }

    // PRIORITY 3: Fallback for simple descriptions (no markdown headers)
    // Just return as-is if short enough (e.g., user-edited simple text)
    if (!fullDescription.includes('**') && fullDescription.length < 1000) {
      return fullDescription.trim();
    }

    // PRIORITY 4: If description has headers but no Section 6, try to extract first meaningful content
    // This handles edge cases where LLM didn't generate Section 6
    // Look for content after any "Image Summary" type header
    const anyImageSummaryMatch = fullDescription.match(
      /\*?\*?(Image Summary|Bildzusammenfassung|Résumé de l['']Image)\*?\*?\s*\n([\s\S]*?)(?=\n\s*(?:\*\*)?\d+\.\s*\*\*|\n\s*\*\*\d+\.|$)/i
    );
    if (anyImageSummaryMatch && anyImageSummaryMatch[2] && anyImageSummaryMatch[2].trim()) {
      return anyImageSummaryMatch[2].trim();
    }

    // Last fallback: return truncated description
    return fullDescription.substring(0, 500).trim() + '...';
  };

  // Detect which characters are mentioned in a scene description
  const detectCharactersInScene = (sceneText: string): number[] => {
    if (!sceneText || !characters.length) return characters.map(c => c.id); // Default to all
    const lowerScene = sceneText.toLowerCase();
    return characters
      .filter(c => lowerScene.includes(c.name.toLowerCase()))
      .map(c => c.id);
  };

  // Open scene edit modal for regeneration
  const openSceneEditModal = (pageNumber: number) => {
    const image = sceneImages.find(img => img.pageNumber === pageNumber);
    const sceneDesc = sceneDescriptions.find(s => s.pageNumber === pageNumber);
    const fullDescription = image?.description || sceneDesc?.description || '';
    // Extract just the summary for editing
    const summary = extractImageSummary(fullDescription);
    // Detect characters mentioned in the scene
    const detectedCharacterIds = detectCharactersInScene(fullDescription);
    setSceneEditModal({ pageNumber, scene: summary, selectedCharacterIds: detectedCharacterIds });
  };

  // Handle regenerate with edited scene
  const handleRegenerateWithScene = async () => {
    if (!sceneEditModal || !onRegenerateImage) return;
    const pageNumber = sceneEditModal.pageNumber;
    const scene = sceneEditModal.scene;
    const characterIds = sceneEditModal.selectedCharacterIds;

    // Close modal immediately and show spinner on the image
    setSceneEditModal(null);
    setRegeneratingPage(pageNumber);
    setIsRegenerating(true);

    try {
      await onRegenerateImage(pageNumber, scene, characterIds);
    } catch (err) {
      console.error('Failed to regenerate image:', err);
    } finally {
      setIsRegenerating(false);
      setRegeneratingPage(null);
    }
  };

  // Helper to start editing a Visual Bible entry
  const startEditing = (type: string, id: string, field: string, currentValue: string) => {
    setEditingEntry({ type, id, field });
    setEditValue(currentValue || '');
  };

  // Helper to save Visual Bible edit
  const saveEdit = () => {
    if (!editingEntry || !visualBible || !onVisualBibleChange) return;

    const { type, id, field } = editingEntry;
    const updatedBible = { ...visualBible };

    // Find and update the entry based on type
    if (type === 'secondaryCharacter') {
      updatedBible.secondaryCharacters = (updatedBible.secondaryCharacters || []).map(entry =>
        entry.id === id ? { ...entry, [field]: editValue } : entry
      );
    } else if (type === 'animal') {
      updatedBible.animals = (updatedBible.animals || []).map(entry =>
        entry.id === id ? { ...entry, [field]: editValue } : entry
      );
    } else if (type === 'artifact') {
      updatedBible.artifacts = (updatedBible.artifacts || []).map(entry =>
        entry.id === id ? { ...entry, [field]: editValue } : entry
      );
    } else if (type === 'location') {
      updatedBible.locations = (updatedBible.locations || []).map(entry =>
        entry.id === id ? { ...entry, [field]: editValue } : entry
      );
    } else if (type === 'mainCharacter') {
      // Handle main character physical edits
      const charId = parseInt(id);
      updatedBible.mainCharacters = (updatedBible.mainCharacters || []).map(char => {
        if (char.id !== charId) return char;

        if (field === 'physical.face') {
          return { ...char, physical: { ...char.physical, face: editValue } };
        } else if (field === 'physical.hair') {
          return { ...char, physical: { ...char.physical, hair: editValue } };
        } else if (field === 'physical.build') {
          return { ...char, physical: { ...char.physical, build: editValue } };
        }
        return char;
      });
    }

    onVisualBibleChange(updatedBible);
    setEditingEntry(null);
    setEditValue('');
  };

  const cancelEdit = () => {
    setEditingEntry(null);
    setEditValue('');
  };

  // Parse story into pages - handle both markdown (## Seite/Page 1) and old format (--- Page 1 ---)
  const parseStoryPages = (storyText: string) => {
    if (!storyText) return [];
    const pageMatches = storyText.split(/(?:---\s*(?:Page|Seite)\s+\d+\s*---|##\s*(?:Page|Seite)\s+\d+)/i);
    return pageMatches.slice(1).filter(p => p.trim().length > 0);
  };

  // Use edited story in edit mode, otherwise use original
  const displayStory = isEditMode ? editedStory : story;
  const storyPages = parseStoryPages(displayStory);
  const hasImages = sceneImages.length > 0;

  // Determine layout from languageLevel:
  // - Picture Book (1st-grade): 1 image + text combined on each page
  // - Standard/Advanced: text page on left, image page on right (separate pages)
  const isPictureBook = languageLevel === '1st-grade';

  // Debug layout detection
  console.log('[StoryDisplay] Layout detection:', {
    languageLevel,
    isPictureBook,
    sceneImagesLength: sceneImages.length,
    storyPagesLength: storyPages.length
  });

  // Progressive mode: Calculate max viewable page
  // For picture book: User can see page N if page N-1 has an image (1:1 text:image)
  // For normal story: User can see page N if scene ceil(N/2) has an image (2:1 text:image)
  const getMaxViewablePage = (): number => {
    if (!progressiveMode) return storyPages.length;
    if (storyPages.length === 0) return 0;

    // Page 1 is always viewable if we have story text
    let maxPage = 1;

    // Check each subsequent page
    for (let i = 2; i <= storyPages.length; i++) {
      // All layouts now use 1:1 mapping - each text page needs its corresponding image
      const imagePageNum = i - 1;

      // Check if the required image exists (from sceneImages or completedPageImages)
      const hasRequiredImage = sceneImages.some(img => img.pageNumber === imagePageNum && img.imageData) ||
                               !!completedPageImages[imagePageNum];
      if (hasRequiredImage) {
        maxPage = i;
      } else {
        break;
      }
    }
    return maxPage;
  };

  const maxViewablePage = getMaxViewablePage();
  const totalProgressivePages = progressiveData?.totalPages || storyPages.length;
  // totalScenes = number of images to expect (different from totalPages for 2:1 layouts)
  const totalScenes = progressiveData?.totalScenes || sceneImages.length || Math.ceil(totalProgressivePages / (isPictureBook ? 1 : 2));

  // Debug: Log progressive state (only when values change significantly, to avoid spam)
  // Removed excessive logging - use browser DevTools if needed

  // Helper to get cover image data (handles both string and object formats)
  const getCoverImageData = (img: string | CoverImageData | null | undefined): string | null => {
    if (!img) return null;
    if (typeof img === 'string') return img;
    return img.imageData || null;
  };

  // Helper to get full cover object (for accessing prompt, quality, etc.)
  const getCoverObject = (img: string | CoverImageData | null | undefined): CoverImageData | null => {
    if (!img) return null;
    if (typeof img === 'string') return { imageData: img };
    return img;
  };

  // Helper to get scene description for a page
  const getSceneDescription = (pageNumber: number): string | undefined => {
    // First check sceneDescriptions array
    const fromDescriptions = sceneDescriptions.find(s => s.pageNumber === pageNumber)?.description;
    if (fromDescriptions) return fromDescriptions;
    // Fall back to image.description if available
    const image = sceneImages.find(img => img.pageNumber === pageNumber);
    return image?.description;
  };

  // Helper to get outline extract for a page
  const getOutlineExtract = (pageNumber: number): string | undefined => {
    return sceneDescriptions.find(s => s.pageNumber === pageNumber)?.outlineExtract;
  };

  // Helper to get scene prompt (Art Director prompt) for a page
  const getScenePrompt = (pageNumber: number): string | undefined => {
    return sceneDescriptions.find(s => s.pageNumber === pageNumber)?.scenePrompt;
  };

  // Helper to get text model ID used for scene description
  const getSceneTextModelId = (pageNumber: number): string | undefined => {
    return sceneDescriptions.find(s => s.pageNumber === pageNumber)?.textModelId;
  };

  return (
    <div className="space-y-6">
      {/* Story Title */}
      <div className="flex items-center justify-center gap-2">
        {isEditingTitle ? (
          <div className="flex items-center gap-2 w-full max-w-2xl">
            <input
              type="text"
              value={editedTitle}
              onChange={(e) => setEditedTitle(e.target.value)}
              className="flex-1 text-2xl md:text-3xl font-bold text-gray-800 text-center border-2 border-indigo-300 rounded-lg px-4 py-2 focus:outline-none focus:border-indigo-500"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSaveTitle();
                if (e.key === 'Escape') {
                  setEditedTitle(title || '');
                  setIsEditingTitle(false);
                }
              }}
            />
            <button
              onClick={handleSaveTitle}
              disabled={isSavingTitle || !editedTitle.trim()}
              className="p-2 bg-green-500 text-white rounded-lg hover:bg-green-600 disabled:opacity-50"
              title={language === 'de' ? 'Speichern' : language === 'fr' ? 'Sauvegarder' : 'Save'}
            >
              {isSavingTitle ? <Loader className="animate-spin" size={20} /> : <Save size={20} />}
            </button>
            <button
              onClick={() => {
                setEditedTitle(title || '');
                setIsEditingTitle(false);
              }}
              disabled={isSavingTitle}
              className="p-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300"
              title={language === 'de' ? 'Abbrechen' : language === 'fr' ? 'Annuler' : 'Cancel'}
            >
              <X size={20} />
            </button>
          </div>
        ) : (
          <>
            <h1 className="text-3xl md:text-4xl font-bold text-gray-800 text-center">
              {title || t.yourStory}
            </h1>
            {onSaveTitleChange && !isGenerating && (
              <button
                onClick={() => setIsEditingTitle(true)}
                className="p-1.5 text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg transition-colors"
                title={language === 'de' ? 'Titel bearbeiten' : language === 'fr' ? 'Modifier le titre' : 'Edit title'}
              >
                <Edit3 size={18} />
              </button>
            )}
          </>
        )}
      </div>

      {/* Partial Story Warning Banner */}
      {isPartial && (
        <div className="bg-amber-50 border-2 border-amber-400 rounded-lg p-4">
          <div className="flex items-start gap-3">
            <div className="text-amber-500 text-2xl">⚠️</div>
            <div>
              <h3 className="font-bold text-amber-800">
                {language === 'de' ? 'Unvollständige Geschichte' : language === 'fr' ? 'Histoire incomplète' : 'Incomplete Story'}
              </h3>
              <p className="text-amber-700 text-sm mt-1">
                {language === 'de'
                  ? `Diese Geschichte konnte nicht vollständig generiert werden. ${generatedPages || sceneImages.length} von ${totalPages || 'unbekannt'} Seiten wurden erstellt.`
                  : language === 'fr'
                  ? `Cette histoire n'a pas pu être générée complètement. ${generatedPages || sceneImages.length} sur ${totalPages || 'inconnu'} pages ont été créées.`
                  : `This story could not be fully generated. ${generatedPages || sceneImages.length} of ${totalPages || 'unknown'} pages were created.`}
              </p>
              {failureReason && developerMode && (
                <details className="mt-2 text-sm">
                  <summary className="cursor-pointer text-amber-600 hover:text-amber-700">
                    {language === 'de' ? 'Fehlerdetails' : language === 'fr' ? 'Détails de l\'erreur' : 'Error details'}
                  </summary>
                  <p className="mt-1 bg-amber-100 p-2 rounded text-amber-800 font-mono text-xs">
                    {failureReason}
                  </p>
                </details>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Action Buttons Grid - Order: Create Book, PDF, Edit, Create Another */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
        {/* Create Book */}
        {hasImages && storyId && onAddToBook && (
          <button
            onClick={onAddToBook}
            disabled={isGenerating}
            className={`bg-indigo-500 text-white px-3 py-2 rounded-lg text-sm font-semibold flex items-center justify-center gap-1.5 ${
              isGenerating ? 'opacity-50 cursor-not-allowed' : 'hover:bg-indigo-600'
            }`}
          >
            <ShoppingCart size={16} /> {language === 'de' ? 'Buch erstellen' : language === 'fr' ? 'Créer le livre' : 'Create Book'}
          </button>
        )}

        {/* PDF Download */}
        {hasImages && onDownloadPdf && (
          <button
            onClick={onDownloadPdf}
            disabled={isGenerating}
            className={`bg-indigo-500 text-white px-3 py-2 rounded-lg text-sm font-semibold flex items-center justify-center gap-1.5 ${
              isGenerating ? 'opacity-50 cursor-not-allowed' : 'hover:bg-indigo-600'
            }`}
          >
            <FileText size={16} /> {language === 'de' ? 'PDF herunterladen' : language === 'fr' ? 'Télécharger PDF' : 'Download PDF'}
          </button>
        )}

        {/* Edit Story */}
        {onSaveStoryText && !isEditMode && (
          <button
            onClick={() => setIsEditMode(true)}
            disabled={isGenerating}
            className={`bg-indigo-500 text-white px-3 py-2 rounded-lg text-sm font-semibold flex items-center justify-center gap-1.5 ${
              isGenerating ? 'opacity-50 cursor-not-allowed' : 'hover:bg-indigo-600'
            }`}
          >
            <Edit3 size={16} /> {language === 'de' ? 'Text bearbeiten' : language === 'fr' ? 'Modifier le texte' : 'Edit Text'}
          </button>
        )}

        {/* Create Another Story */}
        {onCreateAnother && (
          <button
            onClick={onCreateAnother}
            disabled={isGenerating}
            className={`bg-indigo-500 text-white px-3 py-2 rounded-lg text-sm font-semibold flex items-center justify-center gap-1.5 ${
              isGenerating ? 'opacity-50 cursor-not-allowed' : 'hover:bg-indigo-600'
            }`}
          >
            <Plus size={16} /> {language === 'de' ? 'Neue Geschichte' : language === 'fr' ? 'Nouvelle histoire' : 'New Story'}
          </button>
        )}
      </div>

      {/* Developer Mode Buttons */}
      {developerMode && (
        <div className="flex gap-2 mt-2">
          {onDownloadTxt && (
            <button
              onClick={onDownloadTxt}
              className="bg-gray-500 text-white px-3 py-1.5 rounded text-xs font-medium flex items-center gap-1 hover:bg-gray-600"
            >
              <Download size={14} /> TXT
            </button>
          )}
          {hasImages && storyId && onPrintBook && (
            <button
              onClick={onPrintBook}
              disabled={isGenerating}
              className={`bg-yellow-500 text-black px-3 py-1.5 rounded text-xs font-medium flex items-center gap-1 ${
                isGenerating ? 'opacity-50 cursor-not-allowed' : 'hover:bg-yellow-600'
              }`}
            >
              <BookOpen size={14} /> Print (DEV)
            </button>
          )}
        </div>
      )}

      {/* Developer Mode: Generation Settings Panel */}
      {developerMode && generationSettings && (
        <div className="mt-4">
          <GenerationSettingsPanel settings={generationSettings} language={language} />
        </div>
      )}

      {/* Developer Mode: Story Overview and Full Text */}
      {developerMode && (
        <div className="space-y-4 mt-6">
          {/* Full Outline/Combined Generation Output */}
          {outline && (
            <details className="bg-purple-50 border-2 border-purple-200 rounded-xl p-4">
              <summary className="cursor-pointer text-lg font-bold text-purple-800 hover:text-purple-900 flex items-center gap-2">
                <FileText size={20} />
                {isPictureBook
                  ? (language === 'de' ? 'Vollständige API-Ausgabe (Kombiniert)' : language === 'fr' ? 'Sortie API complète (Combinée)' : 'Full API Output (Combined)')
                  : (language === 'de' ? 'Vollständige API-Ausgabe (Outline)' : language === 'fr' ? 'Sortie API complète (Plan)' : 'Full API Output (Outline)')}
                {outlineModelId && (
                  <span className="ml-2 text-sm font-normal text-purple-600">({outlineModelId})</span>
                )}
                {outlineUsage && (
                  <span className="ml-2 text-xs font-normal text-purple-500">
                    [{outlineUsage.input_tokens.toLocaleString()} in / {outlineUsage.output_tokens.toLocaleString()} out]
                  </span>
                )}
              </summary>
              <div className="mt-4 space-y-4">
                {/* Input: The prompt sent to the API */}
                {outlinePrompt && (
                  <div>
                    <h4 className="text-sm font-bold text-purple-700 mb-2">
                      {language === 'de' ? '📤 Prompt (Eingabe)' : language === 'fr' ? '📤 Prompt (Entrée)' : '📤 Prompt (Input)'}
                    </h4>
                    <pre className="text-xs text-gray-700 whitespace-pre-wrap font-mono bg-white p-4 rounded-lg border border-purple-200 overflow-x-auto max-h-[400px] overflow-y-auto">
                      {outlinePrompt}
                    </pre>
                  </div>
                )}
                {/* Output: The outline/combined response */}
                <div>
                  <h4 className="text-sm font-bold text-purple-700 mb-2">
                    {isPictureBook
                      ? (language === 'de' ? '📥 API-Antwort (Kombiniert)' : language === 'fr' ? '📥 Réponse API (Combinée)' : '📥 API Response (Combined)')
                      : (language === 'de' ? '📥 API-Antwort (Outline)' : language === 'fr' ? '📥 Réponse API (Plan)' : '📥 API Response (Outline)')}
                  </h4>
                  <pre className="text-xs text-gray-700 whitespace-pre-wrap font-mono bg-white p-4 rounded-lg border border-purple-200 overflow-x-auto max-h-[400px] overflow-y-auto">
                    {outline}
                  </pre>
                </div>
              </div>
            </details>
          )}

          {/* Full Story Text Generation Output */}
          {story && storyTextPrompts.length > 0 && (
            <details className="bg-amber-50 border-2 border-amber-200 rounded-xl p-4">
              <summary className="cursor-pointer text-lg font-bold text-amber-800 hover:text-amber-900 flex items-center gap-2">
                <BookOpen size={20} />
                {language === 'de' ? 'Vollständige API-Ausgabe (Story-Text)' : language === 'fr' ? 'Sortie API complète (Texte)' : 'Full API Output (Story Text)'}
                {storyTextPrompts[0]?.modelId && (
                  <span className="ml-2 text-sm font-normal text-amber-600">({storyTextPrompts[0].modelId})</span>
                )}
                {storyTextPrompts[0]?.usage && (
                  <span className="ml-2 text-xs font-normal text-amber-500">
                    [{storyTextPrompts[0].usage.input_tokens.toLocaleString()} in / {storyTextPrompts[0].usage.output_tokens.toLocaleString()} out]
                  </span>
                )}
              </summary>
              <div className="mt-4 space-y-4">
                {/* Input: The prompt sent to the API */}
                <div>
                  <h4 className="text-sm font-bold text-amber-700 mb-2">
                    {language === 'de' ? '📤 Prompt (Eingabe)' : language === 'fr' ? '📤 Prompt (Entrée)' : '📤 Prompt (Input)'}
                  </h4>
                  <pre className="text-xs text-gray-700 whitespace-pre-wrap font-mono bg-white p-4 rounded-lg border border-amber-200 overflow-x-auto max-h-[400px] overflow-y-auto">
                    {storyTextPrompts[0]?.prompt || 'No prompt available'}
                  </pre>
                </div>
                {/* Output: The raw unfiltered API response */}
                <div>
                  <h4 className="text-sm font-bold text-amber-700 mb-2">
                    {language === 'de' ? '📥 Rohe API-Antwort (ungefiltert)' : language === 'fr' ? '📥 Réponse API brute (non filtrée)' : '📥 Raw API Response (unfiltered)'}
                  </h4>
                  <pre className="text-xs text-gray-700 whitespace-pre-wrap font-mono bg-white p-4 rounded-lg border border-amber-200 overflow-x-auto max-h-[400px] overflow-y-auto">
                    {storyTextPrompts[0]?.rawResponse || story}
                  </pre>
                </div>
              </div>
            </details>
          )}

          {/* Visual Bible - Recurring Elements for Consistency */}
          {visualBible && (
            <details className="bg-rose-50 border-2 border-rose-200 rounded-xl p-4">
              <summary className="cursor-pointer text-lg font-bold text-rose-800 hover:text-rose-900 flex items-center gap-2">
                <BookOpen size={20} />
                {language === 'de' ? 'Visual Bible (Wiederkehrende Elemente)' : language === 'fr' ? 'Bible Visuelle (Éléments Récurrents)' : 'Visual Bible (Recurring Elements)'}
                {visualBible.changeLog && visualBible.changeLog.length > 0 && (
                  <span className="ml-2 px-2 py-0.5 bg-rose-200 text-rose-800 rounded-full text-xs font-medium">
                    {visualBible.changeLog.length} {language === 'de' ? 'Änderungen' : language === 'fr' ? 'changements' : 'changes'}
                  </span>
                )}
              </summary>
              <div className="mt-4 space-y-4">
                {/* Main Characters - Style Analysis */}
                {visualBible.mainCharacters && visualBible.mainCharacters.length > 0 && (
                  <div className="bg-white border border-purple-300 rounded-lg p-3">
                    <h4 className="text-sm font-bold text-purple-700 mb-2 flex items-center gap-2">
                      <span className="text-lg">👗</span>
                      {language === 'de' ? 'Hauptcharaktere (Style Profile)' : language === 'fr' ? 'Personnages Principaux (Profil Style)' : 'Main Characters (Style Profile)'}
                    </h4>
                    <div className="space-y-3">
                      {visualBible.mainCharacters.map((char) => (
                        <details key={char.id} className="bg-purple-50 p-2 rounded text-sm">
                          <summary className="cursor-pointer font-semibold text-purple-800 hover:text-purple-900">
                            {char.name}
                            {Object.keys(char.generatedOutfits || {}).length > 0 && (
                              <span className="ml-2 px-1.5 py-0.5 bg-green-100 text-green-700 rounded text-xs">
                                {Object.keys(char.generatedOutfits).length} {language === 'de' ? 'Outfits' : language === 'fr' ? 'tenues' : 'outfits'}
                              </span>
                            )}
                          </summary>
                          <div className="mt-2 space-y-2">
                            {/* Physical Features */}
                            <div className="text-xs">
                              <span className="font-medium text-gray-600">Physical:</span>
                              <span className="text-gray-700 ml-1">
                                {char.physical?.face || 'Not analyzed'} | {char.physical?.hair || 'N/A'} | {char.physical?.build || 'N/A'}
                                {char.physical?.other && ` | ${char.physical.other}`}
                              </span>
                            </div>
                            {/* Generated Outfits */}
                            {char.generatedOutfits && Object.keys(char.generatedOutfits).length > 0 && (
                              <div className="mt-2 pt-2 border-t border-purple-200">
                                <span className="font-medium text-gray-600 text-xs">Generated Outfits:</span>
                                <div className="mt-1 space-y-1">
                                  {Object.entries(char.generatedOutfits).map(([pageNum, outfit]) => (
                                    <div key={pageNum} className="bg-white p-1.5 rounded text-xs">
                                      <span className="font-medium text-purple-600">Page {pageNum}:</span>
                                      <span className="text-gray-700 ml-1">{outfit.outfit?.substring(0, 80)}...</span>
                                      <span className={`ml-1 px-1 py-0.5 rounded text-[10px] ${
                                        outfit.setting === 'outdoor-cold' ? 'bg-blue-100 text-blue-700' :
                                        outfit.setting === 'outdoor-warm' ? 'bg-yellow-100 text-yellow-700' :
                                        'bg-gray-100 text-gray-600'
                                      }`}>
                                        {outfit.setting}
                                      </span>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
                        </details>
                      ))}
                    </div>
                  </div>
                )}

                {/* Secondary Characters */}
                {visualBible.secondaryCharacters && visualBible.secondaryCharacters.length > 0 && (
                  <div className="bg-white border border-rose-200 rounded-lg p-3">
                    <h4 className="text-sm font-bold text-rose-700 mb-2">
                      {language === 'de' ? 'Nebencharaktere' : language === 'fr' ? 'Personnages Secondaires' : 'Secondary Characters'}
                    </h4>
                    <div className="space-y-2">
                      {visualBible.secondaryCharacters.map((entry) => (
                        <div key={entry.id} className="bg-rose-50 p-2 rounded text-sm">
                          <div className="font-semibold text-rose-800 flex items-center gap-2">
                            {entry.name}
                            {entry.id && <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-200 text-gray-600 font-mono">{entry.id}</span>}
                            {entry.source && (
                              <span className={`text-[10px] px-1.5 py-0.5 rounded ${entry.source === 'outline' ? 'bg-blue-100 text-blue-700' : 'bg-green-100 text-green-700'}`}>
                                {entry.source === 'outline' ? 'Outline' : 'Story'}
                              </span>
                            )}
                            {entry.appearsInPages?.length > 0 && <span className="text-xs text-rose-600">(Pages: {entry.appearsInPages.join(', ')})</span>}
                          </div>
                          {editingEntry?.type === 'secondaryCharacter' && editingEntry?.id === entry.id && editingEntry?.field === 'description' ? (
                            <div className="mt-1">
                              <textarea
                                value={editValue}
                                onChange={(e) => setEditValue(e.target.value)}
                                className="w-full p-2 text-xs border border-rose-300 rounded resize-y min-h-[60px]"
                                autoFocus
                              />
                              <div className="flex gap-2 mt-1">
                                <button onClick={saveEdit} className="px-2 py-1 bg-green-500 text-white text-xs rounded hover:bg-green-600 flex items-center gap-1">
                                  <Save size={12} /> Save
                                </button>
                                <button onClick={cancelEdit} className="px-2 py-1 bg-gray-400 text-white text-xs rounded hover:bg-gray-500 flex items-center gap-1">
                                  <X size={12} /> Cancel
                                </button>
                              </div>
                            </div>
                          ) : (
                            <div className="text-gray-700 text-xs mt-1 flex items-start gap-1">
                              <span className="flex-1">{entry.description}</span>
                              {developerMode && onVisualBibleChange && (
                                <button
                                  onClick={() => startEditing('secondaryCharacter', entry.id, 'description', entry.description)}
                                  className="p-1 text-rose-500 hover:text-rose-700 hover:bg-rose-100 rounded"
                                  title="Edit description"
                                >
                                  <Edit3 size={12} />
                                </button>
                              )}
                            </div>
                          )}
                          {entry.extractedDescription && (
                            <div className="text-green-700 text-xs mt-1 bg-green-50 p-1 rounded">
                              <span className="font-semibold">Extracted:</span> {entry.extractedDescription}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Animals & Creatures */}
                {visualBible.animals.length > 0 && (
                  <div className="bg-white border border-rose-200 rounded-lg p-3">
                    <h4 className="text-sm font-bold text-rose-700 mb-2">
                      {language === 'de' ? 'Tiere & Wesen' : language === 'fr' ? 'Animaux & Créatures' : 'Animals & Creatures'}
                    </h4>
                    <div className="space-y-2">
                      {visualBible.animals.map((entry) => (
                        <div key={entry.id} className="bg-rose-50 p-2 rounded text-sm">
                          <div className="font-semibold text-rose-800 flex items-center gap-2">
                            {entry.name}
                            {entry.id && <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-200 text-gray-600 font-mono">{entry.id}</span>}
                            {entry.source && (
                              <span className={`text-[10px] px-1.5 py-0.5 rounded ${entry.source === 'outline' ? 'bg-blue-100 text-blue-700' : 'bg-green-100 text-green-700'}`}>
                                {entry.source === 'outline' ? 'Outline' : 'Story'}
                              </span>
                            )}
                            {entry.appearsInPages?.length > 0 && <span className="text-xs text-rose-600">(Pages: {entry.appearsInPages.join(', ')})</span>}
                          </div>
                          {editingEntry?.type === 'animal' && editingEntry?.id === entry.id && editingEntry?.field === 'description' ? (
                            <div className="mt-1">
                              <textarea
                                value={editValue}
                                onChange={(e) => setEditValue(e.target.value)}
                                className="w-full p-2 text-xs border border-rose-300 rounded resize-y min-h-[60px]"
                                autoFocus
                              />
                              <div className="flex gap-2 mt-1">
                                <button onClick={saveEdit} className="px-2 py-1 bg-green-500 text-white text-xs rounded hover:bg-green-600 flex items-center gap-1">
                                  <Save size={12} /> Save
                                </button>
                                <button onClick={cancelEdit} className="px-2 py-1 bg-gray-400 text-white text-xs rounded hover:bg-gray-500 flex items-center gap-1">
                                  <X size={12} /> Cancel
                                </button>
                              </div>
                            </div>
                          ) : (
                            <div className="text-gray-700 text-xs mt-1 flex items-start gap-1">
                              <span className="flex-1">{entry.description}</span>
                              {developerMode && onVisualBibleChange && (
                                <button
                                  onClick={() => startEditing('animal', entry.id, 'description', entry.description)}
                                  className="p-1 text-rose-500 hover:text-rose-700 hover:bg-rose-100 rounded"
                                  title="Edit description"
                                >
                                  <Edit3 size={12} />
                                </button>
                              )}
                            </div>
                          )}
                          {entry.extractedDescription && (
                            <div className="text-green-700 text-xs mt-1 bg-green-50 p-1 rounded">
                              <span className="font-semibold">Extracted:</span> {entry.extractedDescription}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Artifacts */}
                {visualBible.artifacts.length > 0 && (
                  <div className="bg-white border border-rose-200 rounded-lg p-3">
                    <h4 className="text-sm font-bold text-rose-700 mb-2">
                      {language === 'de' ? 'Artefakte & Objekte' : language === 'fr' ? 'Artefacts & Objets' : 'Artifacts & Objects'}
                    </h4>
                    <div className="space-y-2">
                      {visualBible.artifacts.map((entry) => (
                        <div key={entry.id} className="bg-rose-50 p-2 rounded text-sm">
                          <div className="font-semibold text-rose-800 flex items-center gap-2">
                            {entry.name}
                            {entry.id && <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-200 text-gray-600 font-mono">{entry.id}</span>}
                            {entry.source && (
                              <span className={`text-[10px] px-1.5 py-0.5 rounded ${entry.source === 'outline' ? 'bg-blue-100 text-blue-700' : 'bg-green-100 text-green-700'}`}>
                                {entry.source === 'outline' ? 'Outline' : 'Story'}
                              </span>
                            )}
                            {entry.appearsInPages?.length > 0 && <span className="text-xs text-rose-600">(Pages: {entry.appearsInPages.join(', ')})</span>}
                          </div>
                          {editingEntry?.type === 'artifact' && editingEntry?.id === entry.id && editingEntry?.field === 'description' ? (
                            <div className="mt-1">
                              <textarea
                                value={editValue}
                                onChange={(e) => setEditValue(e.target.value)}
                                className="w-full p-2 text-xs border border-rose-300 rounded resize-y min-h-[60px]"
                                autoFocus
                              />
                              <div className="flex gap-2 mt-1">
                                <button onClick={saveEdit} className="px-2 py-1 bg-green-500 text-white text-xs rounded hover:bg-green-600 flex items-center gap-1">
                                  <Save size={12} /> Save
                                </button>
                                <button onClick={cancelEdit} className="px-2 py-1 bg-gray-400 text-white text-xs rounded hover:bg-gray-500 flex items-center gap-1">
                                  <X size={12} /> Cancel
                                </button>
                              </div>
                            </div>
                          ) : (
                            <div className="text-gray-700 text-xs mt-1 flex items-start gap-1">
                              <span className="flex-1">{entry.description}</span>
                              {developerMode && onVisualBibleChange && (
                                <button
                                  onClick={() => startEditing('artifact', entry.id, 'description', entry.description)}
                                  className="p-1 text-rose-500 hover:text-rose-700 hover:bg-rose-100 rounded"
                                  title="Edit description"
                                >
                                  <Edit3 size={12} />
                                </button>
                              )}
                            </div>
                          )}
                          {entry.extractedDescription && (
                            <div className="text-green-700 text-xs mt-1 bg-green-50 p-1 rounded">
                              <span className="font-semibold">Extracted:</span> {entry.extractedDescription}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Locations */}
                {visualBible.locations.length > 0 && (
                  <div className="bg-white border border-rose-200 rounded-lg p-3">
                    <h4 className="text-sm font-bold text-rose-700 mb-2">
                      {language === 'de' ? 'Wiederkehrende Orte' : language === 'fr' ? 'Lieux Récurrents' : 'Recurring Locations'}
                    </h4>
                    <div className="space-y-2">
                      {visualBible.locations.map((entry) => (
                        <div key={entry.id} className="bg-rose-50 p-2 rounded text-sm">
                          <div className="font-semibold text-rose-800 flex items-center gap-2 flex-wrap">
                            {entry.name}
                            {entry.id && <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-200 text-gray-600 font-mono">{entry.id}</span>}
                            {entry.source && (
                              <span className={`text-[10px] px-1.5 py-0.5 rounded ${entry.source === 'outline' ? 'bg-blue-100 text-blue-700' : 'bg-green-100 text-green-700'}`}>
                                {entry.source === 'outline' ? 'Outline' : 'Story'}
                              </span>
                            )}
                            {entry.isRealLandmark && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 font-semibold">
                                📍 LANDMARK
                              </span>
                            )}
                            {entry.photoFetchStatus === 'success' && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-100 text-green-700">
                                📷 Photo
                              </span>
                            )}
                            {entry.appearsInPages?.length > 0 && <span className="text-xs text-rose-600">(Pages: {entry.appearsInPages.join(', ')})</span>}
                          </div>
                          {entry.isRealLandmark && entry.landmarkQuery && (
                            <div className="text-amber-700 text-xs mt-1">
                              Landmark: <span className="font-mono bg-amber-50 px-1 rounded">{entry.landmarkQuery}</span>
                            </div>
                          )}
                          {editingEntry?.type === 'location' && editingEntry?.id === entry.id && editingEntry?.field === 'description' ? (
                            <div className="mt-1">
                              <textarea
                                value={editValue}
                                onChange={(e) => setEditValue(e.target.value)}
                                className="w-full p-2 text-xs border border-rose-300 rounded resize-y min-h-[60px]"
                                autoFocus
                              />
                              <div className="flex gap-2 mt-1">
                                <button onClick={saveEdit} className="px-2 py-1 bg-green-500 text-white text-xs rounded hover:bg-green-600 flex items-center gap-1">
                                  <Save size={12} /> Save
                                </button>
                                <button onClick={cancelEdit} className="px-2 py-1 bg-gray-400 text-white text-xs rounded hover:bg-gray-500 flex items-center gap-1">
                                  <X size={12} /> Cancel
                                </button>
                              </div>
                            </div>
                          ) : (
                            <div className="text-gray-700 text-xs mt-1 flex items-start gap-1">
                              <span className="flex-1">{entry.description}</span>
                              {developerMode && onVisualBibleChange && (
                                <button
                                  onClick={() => startEditing('location', entry.id, 'description', entry.description)}
                                  className="p-1 text-rose-500 hover:text-rose-700 hover:bg-rose-100 rounded"
                                  title="Edit description"
                                >
                                  <Edit3 size={12} />
                                </button>
                              )}
                            </div>
                          )}
                          {entry.extractedDescription && (
                            <div className="text-green-700 text-xs mt-1 bg-green-50 p-1 rounded">
                              <span className="font-semibold">Extracted:</span> {entry.extractedDescription}
                            </div>
                          )}
                          {/* Landmark reference photo */}
                          {entry.referencePhotoData && (
                            <div className="mt-2 border border-amber-200 rounded overflow-hidden">
                              <img
                                src={entry.referencePhotoData}
                                alt={`${entry.name} reference`}
                                className="w-full max-h-32 object-contain bg-gray-50"
                              />
                              {entry.photoAttribution && (
                                <div className="text-[9px] text-gray-500 bg-gray-100 px-1 py-0.5 truncate">
                                  📷 {entry.photoAttribution}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Vehicles */}
                {visualBible.vehicles && visualBible.vehicles.length > 0 && (
                  <div className="bg-white border border-rose-200 rounded-lg p-3">
                    <h4 className="text-sm font-bold text-rose-700 mb-2">
                      {language === 'de' ? 'Fahrzeuge' : language === 'fr' ? 'Véhicules' : 'Vehicles'}
                    </h4>
                    <div className="space-y-2">
                      {visualBible.vehicles.map((entry) => (
                        <div key={entry.id} className="bg-rose-50 p-2 rounded text-sm">
                          <div className="font-semibold text-rose-800 flex items-center gap-2">
                            {entry.name}
                            {entry.id && <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-200 text-gray-600 font-mono">{entry.id}</span>}
                            {entry.source && (
                              <span className={`text-[10px] px-1.5 py-0.5 rounded ${entry.source === 'outline' ? 'bg-blue-100 text-blue-700' : 'bg-green-100 text-green-700'}`}>
                                {entry.source === 'outline' ? 'Outline' : 'Story'}
                              </span>
                            )}
                            {entry.appearsInPages?.length > 0 && <span className="text-xs text-rose-600">(Pages: {entry.appearsInPages.join(', ')})</span>}
                          </div>
                          <div className="text-gray-700 text-xs mt-1">{entry.description}</div>
                          {entry.extractedDescription && (
                            <div className="text-green-700 text-xs mt-1 bg-green-50 p-1 rounded">
                              <span className="font-semibold">Extracted:</span> {entry.extractedDescription}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Clothing & Costumes */}
                {visualBible.clothing && visualBible.clothing.length > 0 && (
                  <div className="bg-white border border-rose-200 rounded-lg p-3">
                    <h4 className="text-sm font-bold text-rose-700 mb-2">
                      {language === 'de' ? 'Kleidung & Kostüme' : language === 'fr' ? 'Vêtements & Costumes' : 'Clothing & Costumes'}
                    </h4>
                    <div className="space-y-2">
                      {visualBible.clothing.map((entry) => (
                        <div key={entry.id} className="bg-rose-50 p-2 rounded text-sm">
                          <div className="font-semibold text-rose-800 flex items-center gap-2">
                            {entry.name}
                            {entry.id && <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-200 text-gray-600 font-mono">{entry.id}</span>}
                            {entry.wornBy && <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-100 text-purple-700">worn by {entry.wornBy}</span>}
                            {entry.source && (
                              <span className={`text-[10px] px-1.5 py-0.5 rounded ${entry.source === 'outline' ? 'bg-blue-100 text-blue-700' : 'bg-green-100 text-green-700'}`}>
                                {entry.source === 'outline' ? 'Outline' : 'Story'}
                              </span>
                            )}
                            {entry.appearsInPages?.length > 0 && <span className="text-xs text-rose-600">(Pages: {entry.appearsInPages.join(', ')})</span>}
                          </div>
                          <div className="text-gray-700 text-xs mt-1">{entry.description}</div>
                          {entry.extractedDescription && (
                            <div className="text-green-700 text-xs mt-1 bg-green-50 p-1 rounded">
                              <span className="font-semibold">Extracted:</span> {entry.extractedDescription}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Change Log */}
                {visualBible.changeLog && visualBible.changeLog.length > 0 && (
                  <details className="bg-white border border-amber-300 rounded-lg p-3">
                    <summary className="cursor-pointer text-sm font-bold text-amber-700 hover:text-amber-800 flex items-center gap-2">
                      <span className="text-lg">📝</span>
                      {language === 'de' ? 'Änderungsprotokoll' : language === 'fr' ? 'Journal des Modifications' : 'Change Log'}
                      <span className="ml-1 px-1.5 py-0.5 bg-amber-100 text-amber-700 rounded text-xs">
                        {visualBible.changeLog.length}
                      </span>
                    </summary>
                    <div className="mt-2 space-y-1 max-h-64 overflow-y-auto">
                      {visualBible.changeLog.slice().reverse().map((entry, idx) => (
                        <div key={idx} className="bg-amber-50 p-2 rounded text-xs border-l-2 border-amber-400">
                          <div className="flex items-center gap-2">
                            <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                              entry.type === 'mainCharacter' ? 'bg-purple-100 text-purple-700' :
                              entry.type === 'secondaryCharacter' ? 'bg-rose-100 text-rose-700' :
                              entry.type === 'generatedOutfit' ? 'bg-green-100 text-green-700' :
                              entry.type === 'animal' ? 'bg-orange-100 text-orange-700' :
                              entry.type === 'artifact' ? 'bg-blue-100 text-blue-700' :
                              'bg-gray-100 text-gray-700'
                            }`}>
                              {entry.type}
                            </span>
                            <span className="font-semibold text-amber-800">{entry.element}</span>
                            <span className="text-gray-500">
                              {storyLang === 'de' ? 'Seite' : storyLang === 'fr' ? 'Page' : 'Page'} {entry.page}
                            </span>
                          </div>
                          <div className="mt-1 text-gray-600">
                            <span className="font-medium">{entry.change}:</span>
                            <span className="ml-1 text-gray-700">{entry.after?.substring(0, 100)}{entry.after && entry.after.length > 100 ? '...' : ''}</span>
                          </div>
                          {entry.before && (
                            <div className="text-gray-400 line-through text-[10px] mt-0.5">
                              {language === 'de' ? 'Vorher' : language === 'fr' ? 'Avant' : 'Before'}: {entry.before.substring(0, 50)}...
                            </div>
                          )}
                          <div className="text-gray-400 text-[10px] mt-0.5">
                            {new Date(entry.timestamp).toLocaleTimeString()}
                          </div>
                        </div>
                      ))}
                    </div>
                  </details>
                )}

                {/* Empty state message */}
                {(!visualBible.mainCharacters || visualBible.mainCharacters.length === 0) &&
                 (!visualBible.secondaryCharacters || visualBible.secondaryCharacters.length === 0) &&
                 (!visualBible.animals || visualBible.animals.length === 0) &&
                 (!visualBible.artifacts || visualBible.artifacts.length === 0) &&
                 (!visualBible.locations || visualBible.locations.length === 0) &&
                 (!visualBible.vehicles || visualBible.vehicles.length === 0) &&
                 (!visualBible.clothing || visualBible.clothing.length === 0) && (
                  <div className="text-gray-500 text-sm italic">
                    {language === 'de' ? 'Keine wiederkehrenden Elemente gefunden' : language === 'fr' ? 'Aucun élément récurrent trouvé' : 'No recurring elements found in this story'}
                  </div>
                )}
              </div>
            </details>
          )}

          {/* Styled Avatar Generation Log */}
          {styledAvatarGeneration && styledAvatarGeneration.length > 0 && (
            <details className="bg-pink-50 border-2 border-pink-200 rounded-xl p-4">
              <summary className="cursor-pointer text-lg font-bold text-pink-800 hover:text-pink-900 flex items-center gap-2">
                <Images size={20} />
                {language === 'de'
                  ? `Stilisierte Avatare (${styledAvatarGeneration.length})`
                  : language === 'fr'
                    ? `Avatars stylisés (${styledAvatarGeneration.length})`
                    : `Styled Avatars (${styledAvatarGeneration.length})`}
              </summary>
              <div className="mt-4 space-y-4">
                {styledAvatarGeneration.map((entry, index) => (
                  <details key={index} className={`border rounded-lg p-3 ${entry.success ? 'bg-white border-pink-200' : 'bg-red-50 border-red-300'}`}>
                    <summary className="cursor-pointer text-sm font-semibold text-pink-700 hover:text-pink-800 flex items-center gap-2">
                      <span className={`w-2 h-2 rounded-full ${entry.success ? 'bg-green-500' : 'bg-red-500'}`}></span>
                      {entry.characterName} - {entry.artStyle}
                      <span className="text-xs text-gray-500 ml-auto">
                        {(entry.durationMs / 1000).toFixed(1)}s
                      </span>
                    </summary>
                    <div className="mt-3 space-y-3">
                      {/* Inputs */}
                      <div className="bg-blue-50 p-2 rounded text-xs">
                        <span className="font-semibold text-blue-700">Inputs:</span>
                        <div className="mt-2 flex flex-wrap gap-3">
                          <div className="flex flex-col items-center">
                            <span className="text-gray-600 text-[10px] mb-1">Face Photo</span>
                            {entry.inputs.facePhoto?.imageData ? (
                              <img
                                src={entry.inputs.facePhoto.imageData}
                                alt="Face"
                                className="w-16 h-16 object-cover rounded border border-blue-300 cursor-pointer hover:opacity-80 transition-opacity"
                                onClick={() => setEnlargedImage({ src: entry.inputs.facePhoto!.imageData!, title: 'Face Photo' })}
                                title={`${entry.inputs.facePhoto.sizeKB} KB - Click to enlarge`}
                              />
                            ) : entry.inputs.facePhoto ? (
                              <span className="text-blue-600 text-[10px]">{entry.inputs.facePhoto.sizeKB} KB</span>
                            ) : (
                              <span className="text-gray-400 italic text-[10px]">N/A</span>
                            )}
                          </div>
                          <div className="flex flex-col items-center">
                            <span className="text-gray-600 text-[10px] mb-1">Original Avatar</span>
                            {entry.inputs.originalAvatar?.imageData ? (
                              <img
                                src={entry.inputs.originalAvatar.imageData}
                                alt="Avatar"
                                className="w-16 h-16 object-cover rounded border border-blue-300 cursor-pointer hover:opacity-80 transition-opacity"
                                onClick={() => setEnlargedImage({ src: entry.inputs.originalAvatar.imageData!, title: 'Original Avatar' })}
                                title={`${entry.inputs.originalAvatar.sizeKB} KB - Click to enlarge`}
                              />
                            ) : (
                              <span className="text-blue-600 text-[10px]">{entry.inputs.originalAvatar.sizeKB} KB</span>
                            )}
                          </div>
                        </div>
                      </div>

                      {/* Prompt */}
                      {entry.prompt && (
                        <details className="bg-purple-50 p-2 rounded text-xs">
                          <summary className="cursor-pointer font-semibold text-purple-700 hover:text-purple-800">
                            Prompt ({entry.prompt.length} chars)
                          </summary>
                          <pre className="mt-2 text-gray-700 whitespace-pre-wrap text-[10px] max-h-48 overflow-y-auto">
                            {entry.prompt}
                          </pre>
                        </details>
                      )}

                      {/* Output */}
                      {entry.success && entry.output && (
                        <div className="bg-green-50 p-2 rounded text-xs">
                          <span className="font-semibold text-green-700">Output:</span>
                          <div className="mt-2 flex flex-col items-start">
                            {entry.output.imageData ? (
                              <img
                                src={entry.output.imageData}
                                alt="Output"
                                className="w-24 h-24 object-cover rounded border border-green-300 cursor-pointer hover:opacity-80 transition-opacity"
                                onClick={() => setEnlargedImage({ src: entry.output!.imageData!, title: 'Styled Avatar Output' })}
                                title={`${entry.output.sizeKB} KB - Click to enlarge`}
                              />
                            ) : (
                              <span className="text-green-600">{entry.output.sizeKB} KB</span>
                            )}
                          </div>
                        </div>
                      )}

                      {/* Error */}
                      {!entry.success && entry.error && (
                        <div className="bg-red-50 p-2 rounded text-xs">
                          <span className="font-semibold text-red-700">Error:</span>
                          <p className="mt-1 text-red-600">{entry.error}</p>
                        </div>
                      )}

                      {/* Timestamp */}
                      <div className="text-[10px] text-gray-400">
                        Generated: {new Date(entry.timestamp).toLocaleString()}
                      </div>
                    </div>
                  </details>
                ))}
              </div>
            </details>
          )}

          {/* Costumed Avatar Generation Log */}
          {costumedAvatarGeneration && costumedAvatarGeneration.length > 0 && (
            <details className="bg-orange-50 border-2 border-orange-200 rounded-xl p-4">
              <summary className="cursor-pointer text-lg font-bold text-orange-800 hover:text-orange-900 flex items-center gap-2">
                <Images size={20} />
                {language === 'de'
                  ? `Kostüm-Avatare (${costumedAvatarGeneration.length})`
                  : language === 'fr'
                    ? `Avatars costumés (${costumedAvatarGeneration.length})`
                    : `Costumed Avatars (${costumedAvatarGeneration.length})`}
              </summary>
              <div className="mt-4 space-y-4">
                {costumedAvatarGeneration.map((entry, index) => (
                  <details key={index} className={`border rounded-lg p-3 ${entry.success ? 'bg-white border-orange-200' : 'bg-red-50 border-red-300'}`}>
                    <summary className="cursor-pointer text-sm font-semibold text-orange-700 hover:text-orange-800 flex items-center gap-2">
                      <span className={`w-2 h-2 rounded-full ${entry.success ? 'bg-green-500' : 'bg-red-500'}`}></span>
                      {entry.characterName} - {entry.costumeType} ({entry.artStyle})
                      <span className="text-xs text-gray-500 ml-auto">
                        {(entry.durationMs / 1000).toFixed(1)}s
                      </span>
                    </summary>
                    <div className="mt-3 space-y-3">
                      {/* Costume Description */}
                      {entry.costumeDescription && (
                        <div className="bg-yellow-50 p-2 rounded text-xs">
                          <span className="font-semibold text-yellow-700">Costume:</span>
                          <p className="mt-1 text-gray-700">{entry.costumeDescription}</p>
                        </div>
                      )}

                      {/* Inputs */}
                      <div className="bg-blue-50 p-2 rounded text-xs">
                        <span className="font-semibold text-blue-700">Inputs:</span>
                        <div className="mt-2 flex flex-wrap gap-3">
                          <div className="flex flex-col items-center">
                            <span className="text-gray-600 text-[10px] mb-1">Face Photo</span>
                            {entry.inputs.facePhoto?.imageData ? (
                              <img
                                src={entry.inputs.facePhoto.imageData}
                                alt="Face"
                                className="w-16 h-16 object-cover rounded border border-blue-300 cursor-pointer hover:opacity-80 transition-opacity"
                                onClick={() => setEnlargedImage({ src: entry.inputs.facePhoto!.imageData!, title: 'Face Photo' })}
                                title={`${entry.inputs.facePhoto.sizeKB} KB - Click to enlarge`}
                              />
                            ) : (
                              <span className="text-blue-600 text-[10px]">{entry.inputs.facePhoto?.sizeKB || 0} KB</span>
                            )}
                          </div>
                          <div className="flex flex-col items-center">
                            <span className="text-gray-600 text-[10px] mb-1">Standard Avatar</span>
                            {entry.inputs.standardAvatar?.imageData ? (
                              <img
                                src={entry.inputs.standardAvatar.imageData}
                                alt="Avatar"
                                className="w-16 h-16 object-cover rounded border border-blue-300 cursor-pointer hover:opacity-80 transition-opacity"
                                onClick={() => setEnlargedImage({ src: entry.inputs.standardAvatar!.imageData!, title: 'Standard Avatar' })}
                                title={`${entry.inputs.standardAvatar.sizeKB} KB - Click to enlarge`}
                              />
                            ) : (
                              <span className="text-gray-400 italic text-[10px]">N/A</span>
                            )}
                          </div>
                        </div>
                      </div>

                      {/* Prompt */}
                      {entry.prompt && (
                        <details className="bg-purple-50 p-2 rounded text-xs">
                          <summary className="cursor-pointer font-semibold text-purple-700 hover:text-purple-800">
                            Prompt ({entry.prompt.length} chars)
                          </summary>
                          <pre className="mt-2 text-gray-700 whitespace-pre-wrap text-[10px] max-h-48 overflow-y-auto">
                            {entry.prompt}
                          </pre>
                        </details>
                      )}

                      {/* Output */}
                      {entry.success && entry.output && (
                        <div className="bg-green-50 p-2 rounded text-xs">
                          <span className="font-semibold text-green-700">Output:</span>
                          <div className="mt-2 flex flex-col items-start">
                            {entry.output.imageData ? (
                              <img
                                src={entry.output.imageData}
                                alt="Output"
                                className="w-24 h-24 object-cover rounded border border-green-300 cursor-pointer hover:opacity-80 transition-opacity"
                                onClick={() => setEnlargedImage({ src: entry.output!.imageData!, title: 'Costumed Avatar Output' })}
                                title={`${entry.output.sizeKB} KB - Click to enlarge`}
                              />
                            ) : (
                              <span className="text-green-600">{entry.output.sizeKB} KB</span>
                            )}
                          </div>
                        </div>
                      )}

                      {/* Error */}
                      {!entry.success && entry.error && (
                        <div className="bg-red-50 p-2 rounded text-xs">
                          <span className="font-semibold text-red-700">Error:</span>
                          <p className="mt-1 text-red-600">{entry.error}</p>
                        </div>
                      )}

                      {/* Timestamp */}
                      <div className="text-[10px] text-gray-400">
                        Generated: {new Date(entry.timestamp).toLocaleString()}
                      </div>
                    </div>
                  </details>
                ))}
              </div>
            </details>
          )}

          {/* Generation Log - Debug: check console for generationLog count */}
          {(() => { console.log('[StoryDisplay] generationLog:', generationLog?.length, 'entries, developerMode:', developerMode); return null; })()}
          {generationLog && generationLog.length > 0 && (
            <details className="bg-slate-50 border-2 border-slate-200 rounded-xl p-4">
              <summary className="cursor-pointer text-lg font-bold text-slate-800 hover:text-slate-900 flex items-center gap-2">
                <FileText size={20} />
                {language === 'de'
                  ? `Generierungslog (${generationLog.length})`
                  : language === 'fr'
                    ? `Journal de génération (${generationLog.length})`
                    : `Generation Log (${generationLog.length})`}
                {/* Show warning/error counts */}
                {generationLog.filter(e => e.level === 'warn').length > 0 && (
                  <span className="ml-2 px-2 py-0.5 bg-yellow-200 text-yellow-800 text-xs rounded-full">
                    {generationLog.filter(e => e.level === 'warn').length} warnings
                  </span>
                )}
                {generationLog.filter(e => e.level === 'error').length > 0 && (
                  <span className="ml-1 px-2 py-0.5 bg-red-200 text-red-800 text-xs rounded-full">
                    {generationLog.filter(e => e.level === 'error').length} errors
                  </span>
                )}
              </summary>
              <div className="mt-4 space-y-1 max-h-96 overflow-y-auto">
                {generationLog.map((entry, index) => (
                  <div
                    key={index}
                    className={`text-xs p-2 rounded flex items-start gap-2 ${
                      entry.level === 'error' ? 'bg-red-50 text-red-800' :
                      entry.level === 'warn' ? 'bg-yellow-50 text-yellow-800' :
                      entry.level === 'debug' ? 'bg-gray-50 text-gray-600' :
                      'bg-white text-slate-700'
                    }`}
                  >
                    {/* Timestamp */}
                    <span className="text-gray-400 font-mono text-[10px] whitespace-nowrap">
                      {new Date(entry.timestamp).toLocaleTimeString()}
                    </span>
                    {/* Stage badge */}
                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium whitespace-nowrap ${
                      entry.stage === 'outline' ? 'bg-blue-100 text-blue-700' :
                      entry.stage === 'avatars' ? 'bg-purple-100 text-purple-700' :
                      entry.stage === 'scenes' ? 'bg-green-100 text-green-700' :
                      entry.stage === 'images' ? 'bg-orange-100 text-orange-700' :
                      entry.stage === 'covers' ? 'bg-pink-100 text-pink-700' :
                      'bg-gray-100 text-gray-700'
                    }`}>
                      {entry.stage}
                    </span>
                    {/* Character name if present */}
                    {entry.character && (
                      <span className="font-medium text-slate-600">[{entry.character}]</span>
                    )}
                    {/* Message */}
                    <span className="flex-1">{entry.message}</span>
                    {/* Event type */}
                    <span className="text-gray-400 text-[10px]">{entry.event}</span>
                  </div>
                ))}
              </div>
            </details>
          )}

          {/* All Scene Descriptions */}
          {sceneDescriptions.length > 0 && (
            <details className="bg-green-50 border-2 border-green-200 rounded-xl p-4">
              <summary className="cursor-pointer text-lg font-bold text-green-800 hover:text-green-900 flex items-center gap-2">
                <FileText size={20} />
                {language === 'de' ? `Alle Szenenbeschreibungen (${sceneDescriptions.length})` : language === 'fr' ? `Toutes les descriptions de scènes (${sceneDescriptions.length})` : `All Scene Descriptions (${sceneDescriptions.length})`}
              </summary>
              <div className="mt-4 space-y-4">
                {sceneDescriptions.map((scene) => (
                  <details key={scene.pageNumber} className="bg-white border border-green-200 rounded-lg p-3">
                    <summary className="cursor-pointer text-sm font-semibold text-green-700 hover:text-green-800">
                      {storyLang === 'de' ? `Seite ${scene.pageNumber}` : storyLang === 'fr' ? `Page ${scene.pageNumber}` : `Page ${scene.pageNumber}`}
                    </summary>
                    <div className="mt-2 space-y-2">
                      {/* Outline Extract */}
                      {scene.outlineExtract && (
                        <div className="bg-amber-50 p-2 rounded text-xs">
                          <span className="font-semibold text-amber-700">Outline Extract:</span>
                          <p className="text-gray-700 mt-1 whitespace-pre-wrap">{scene.outlineExtract}</p>
                        </div>
                      )}
                      {/* Scene Prompt (Art Director) */}
                      {scene.scenePrompt && (
                        <div className="bg-purple-50 p-2 rounded text-xs">
                          <span className="font-semibold text-purple-700">Scene Prompt:</span>
                          <p className="text-gray-700 mt-1 whitespace-pre-wrap">{scene.scenePrompt}</p>
                        </div>
                      )}
                      {/* Scene Description */}
                      <div className="bg-green-50 p-2 rounded text-xs">
                        <span className="font-semibold text-green-700">Scene Description:</span>
                        {scene.textModelId && <span className="ml-2 text-green-600">({scene.textModelId})</span>}
                        <p className="text-gray-700 mt-1 whitespace-pre-wrap">{scene.description}</p>
                      </div>
                    </div>
                  </details>
                ))}
              </div>
            </details>
          )}
        </div>
      )}

      {/* Front Cover Display */}
      {coverImages && getCoverImageData(coverImages.frontCover) && (() => {
        const frontCoverObj = getCoverObject(coverImages.frontCover);
        return (
          <div className="mt-6 max-w-2xl mx-auto">
            <p className="text-sm text-gray-500 text-center mb-2">
              {storyLang === 'de' ? 'Titelseite' : storyLang === 'fr' ? 'Couverture' : 'Front Cover'}
            </p>
            <DiagnosticImage
              src={getCoverImageData(coverImages.frontCover)!}
              alt="Front Cover"
              className="w-full rounded-lg shadow-lg"
              label="Front Cover"
            />
            {/* Regenerate Cover - visible to all users */}
            {_onRegenerateCover && (
              <div className="mt-3">
                <button
                  onClick={() => _onRegenerateCover('front')}
                  disabled={isGenerating || !hasEnoughCredits}
                  className={`w-full bg-indigo-500 text-white px-3 py-2 rounded-lg flex items-center justify-center gap-2 text-sm font-semibold ${
                    isGenerating || !hasEnoughCredits ? 'opacity-50 cursor-not-allowed' : 'hover:bg-indigo-600'
                  }`}
                  title={!hasEnoughCredits
                    ? (language === 'de' ? 'Nicht genug Credits' : language === 'fr' ? 'Pas assez de crédits' : 'Not enough credits')
                    : ''
                  }
                >
                  <RefreshCw size={14} />
                  {language === 'de' ? 'Bild neu generieren' : language === 'fr' ? 'Régénérer l\'image' : 'Regenerate Image'}
                  <span className="text-xs opacity-80">
                    ({imageRegenerationCost} {language === 'de' ? 'Credits' : 'credits'})
                  </span>
                </button>
              </div>
            )}
            {/* Developer Mode Features for Front Cover */}
            {developerMode && frontCoverObj && (
              <div className="mt-3 space-y-2">
                {/* Edit Button - dev only */}
                {_onEditCover && (
                  <button
                    onClick={() => _onEditCover('front')}
                    disabled={isGenerating}
                    className={`w-full bg-indigo-500 text-white px-3 py-2 rounded-lg flex items-center justify-center gap-2 text-sm font-semibold ${
                      isGenerating ? 'opacity-50 cursor-not-allowed' : 'hover:bg-indigo-600'
                    }`}
                  >
                    <Edit3 size={14} /> {language === 'de' ? 'Bearbeiten' : 'Edit'}
                  </button>
                )}

                {/* Scene Description */}
                {frontCoverObj.description && (
                  <details className="bg-green-50 border border-green-300 rounded-lg p-3">
                    <summary className="cursor-pointer text-sm font-semibold text-green-800 hover:text-green-900">
                      {language === 'de' ? 'Szenenbeschreibung' : language === 'fr' ? 'Description de scène' : 'Scene Description'}
                    </summary>
                    <pre className="mt-2 text-xs text-gray-700 whitespace-pre-wrap font-mono bg-white p-3 rounded border border-gray-200 overflow-x-auto">
                      {frontCoverObj.description}
                    </pre>
                  </details>
                )}

                {/* API Prompt */}
                {frontCoverObj.prompt && (
                  <details className="bg-blue-50 border border-blue-300 rounded-lg p-3">
                    <summary className="cursor-pointer text-sm font-semibold text-blue-800 hover:text-blue-900">
                      {language === 'de' ? 'API-Prompt' : language === 'fr' ? 'Prompt API' : 'API Prompt'}
                      {frontCoverObj.modelId && <span className="ml-2 text-xs font-normal text-blue-600">({frontCoverObj.modelId})</span>}
                    </summary>
                    <pre className="mt-2 text-xs text-gray-700 whitespace-pre-wrap font-mono bg-white p-3 rounded border border-gray-200 overflow-x-auto max-h-48 overflow-y-auto">
                      {frontCoverObj.prompt}
                    </pre>
                  </details>
                )}

                {/* Reference Photos */}
                {((frontCoverObj.referencePhotos?.length ?? 0) > 0 || (frontCoverObj.landmarkPhotos?.length ?? 0) > 0) && (
                  <ReferencePhotosDisplay
                    referencePhotos={frontCoverObj.referencePhotos || []}
                    landmarkPhotos={frontCoverObj.landmarkPhotos}
                    language={language}
                  />
                )}

                {/* Quality Score */}
                {frontCoverObj.qualityScore !== undefined && (
                  <details className="bg-indigo-50 border border-indigo-300 rounded-lg p-3">
                    <summary className="cursor-pointer text-sm font-semibold text-indigo-700 hover:text-indigo-900 flex items-center justify-between">
                      <span className="flex items-center gap-2">
                        {language === 'de' ? 'Qualitätsbewertung' : language === 'fr' ? 'Score de qualité' : 'Quality Score'}
                        {frontCoverObj.qualityModelId && <span className="text-xs font-normal text-indigo-500">({frontCoverObj.qualityModelId})</span>}
                      </span>
                      <span className={`text-lg font-bold ${
                        frontCoverObj.qualityScore >= 70 ? 'text-green-600' :
                        frontCoverObj.qualityScore >= 50 ? 'text-yellow-600' :
                        'text-red-600'
                      }`}>
                        {Math.round(frontCoverObj.qualityScore)}%
                      </span>
                    </summary>
                    {frontCoverObj.qualityReasoning && (
                      <div className="mt-2 text-xs text-gray-800 bg-white p-3 rounded border border-gray-200">
                        <div className="font-semibold mb-1">{language === 'de' ? 'Feedback:' : language === 'fr' ? 'Retour:' : 'Feedback:'}</div>
                        <p className="whitespace-pre-wrap">{frontCoverObj.qualityReasoning}</p>
                      </div>
                    )}
                  </details>
                )}

                {/* Retry History */}
                {frontCoverObj.retryHistory && frontCoverObj.retryHistory.length > 0 && (
                  <RetryHistoryDisplay
                    retryHistory={frontCoverObj.retryHistory}
                    totalAttempts={frontCoverObj.totalAttempts || frontCoverObj.retryHistory.length}
                    language={language}
                  />
                )}
              </div>
            )}
          </div>
        );
      })()}

      {/* Initial Page (Dedication Page) Display */}
      {coverImages && getCoverImageData(coverImages.initialPage) && (() => {
        const initialPageObj = getCoverObject(coverImages.initialPage);
        return (
          <div className="mt-6 max-w-2xl mx-auto">
            <p className="text-sm text-gray-500 text-center mb-2">
              {storyLang === 'de' ? 'Widmungsseite' : storyLang === 'fr' ? 'Page de dédicace' : 'Dedication Page'}
            </p>
            <DiagnosticImage
              src={getCoverImageData(coverImages.initialPage)!}
              alt="Dedication Page"
              className="w-full rounded-lg shadow-lg"
              label="Dedication Page"
            />
            {/* Regenerate Cover - visible to all users */}
            {_onRegenerateCover && (
              <div className="mt-3">
                <button
                  onClick={() => _onRegenerateCover('initial')}
                  disabled={isGenerating || !hasEnoughCredits}
                  className={`w-full bg-indigo-500 text-white px-3 py-2 rounded-lg flex items-center justify-center gap-2 text-sm font-semibold ${
                    isGenerating || !hasEnoughCredits ? 'opacity-50 cursor-not-allowed' : 'hover:bg-indigo-600'
                  }`}
                  title={!hasEnoughCredits
                    ? (language === 'de' ? 'Nicht genug Credits' : language === 'fr' ? 'Pas assez de crédits' : 'Not enough credits')
                    : ''
                  }
                >
                  <RefreshCw size={14} />
                  {language === 'de' ? 'Bild neu generieren' : language === 'fr' ? 'Régénérer l\'image' : 'Regenerate Image'}
                  <span className="text-xs opacity-80">
                    ({imageRegenerationCost} {language === 'de' ? 'Credits' : 'credits'})
                  </span>
                </button>
              </div>
            )}
            {/* Developer Mode Features for Initial Page */}
            {developerMode && initialPageObj && (
              <div className="mt-3 space-y-2">
                {/* Edit Button - dev only */}
                {_onEditCover && (
                  <button
                    onClick={() => _onEditCover('initial')}
                    disabled={isGenerating}
                    className={`w-full bg-indigo-500 text-white px-3 py-2 rounded-lg flex items-center justify-center gap-2 text-sm font-semibold ${
                      isGenerating ? 'opacity-50 cursor-not-allowed' : 'hover:bg-indigo-600'
                    }`}
                  >
                    <Edit3 size={14} /> {language === 'de' ? 'Bearbeiten' : 'Edit'}
                  </button>
                )}

                {/* Scene Description */}
                {initialPageObj.description && (
                  <details className="bg-green-50 border border-green-300 rounded-lg p-3">
                    <summary className="cursor-pointer text-sm font-semibold text-green-800 hover:text-green-900">
                      {language === 'de' ? 'Szenenbeschreibung' : language === 'fr' ? 'Description de scène' : 'Scene Description'}
                    </summary>
                    <pre className="mt-2 text-xs text-gray-700 whitespace-pre-wrap font-mono bg-white p-3 rounded border border-gray-200 overflow-x-auto">
                      {initialPageObj.description}
                    </pre>
                  </details>
                )}

                {/* API Prompt */}
                {initialPageObj.prompt && (
                  <details className="bg-blue-50 border border-blue-300 rounded-lg p-3">
                    <summary className="cursor-pointer text-sm font-semibold text-blue-800 hover:text-blue-900">
                      {language === 'de' ? 'API-Prompt' : language === 'fr' ? 'Prompt API' : 'API Prompt'}
                      {initialPageObj.modelId && <span className="ml-2 text-xs font-normal text-blue-600">({initialPageObj.modelId})</span>}
                    </summary>
                    <pre className="mt-2 text-xs text-gray-700 whitespace-pre-wrap font-mono bg-white p-3 rounded border border-gray-200 overflow-x-auto max-h-48 overflow-y-auto">
                      {initialPageObj.prompt}
                    </pre>
                  </details>
                )}

                {/* Reference Photos */}
                {((initialPageObj.referencePhotos?.length ?? 0) > 0 || (initialPageObj.landmarkPhotos?.length ?? 0) > 0) && (
                  <ReferencePhotosDisplay
                    referencePhotos={initialPageObj.referencePhotos || []}
                    landmarkPhotos={initialPageObj.landmarkPhotos}
                    language={language}
                  />
                )}

                {/* Quality Score */}
                {initialPageObj.qualityScore !== undefined && (
                  <details className="bg-indigo-50 border border-indigo-300 rounded-lg p-3">
                    <summary className="cursor-pointer text-sm font-semibold text-indigo-700 hover:text-indigo-900 flex items-center justify-between">
                      <span className="flex items-center gap-2">
                        {language === 'de' ? 'Qualitätsbewertung' : language === 'fr' ? 'Score de qualité' : 'Quality Score'}
                        {initialPageObj.qualityModelId && <span className="text-xs font-normal text-indigo-500">({initialPageObj.qualityModelId})</span>}
                      </span>
                      <span className={`text-lg font-bold ${
                        initialPageObj.qualityScore >= 70 ? 'text-green-600' :
                        initialPageObj.qualityScore >= 50 ? 'text-yellow-600' :
                        'text-red-600'
                      }`}>
                        {Math.round(initialPageObj.qualityScore)}%
                      </span>
                    </summary>
                    {initialPageObj.qualityReasoning && (
                      <div className="mt-2 text-xs text-gray-800 bg-white p-3 rounded border border-gray-200">
                        <div className="font-semibold mb-1">{language === 'de' ? 'Feedback:' : language === 'fr' ? 'Retour:' : 'Feedback:'}</div>
                        <p className="whitespace-pre-wrap">{initialPageObj.qualityReasoning}</p>
                      </div>
                    )}
                  </details>
                )}

                {/* Retry History */}
                {initialPageObj.retryHistory && initialPageObj.retryHistory.length > 0 && (
                  <RetryHistoryDisplay
                    retryHistory={initialPageObj.retryHistory}
                    totalAttempts={initialPageObj.totalAttempts || initialPageObj.retryHistory.length}
                    language={language}
                  />
                )}
              </div>
            )}
          </div>
        );
      })()}

      {/* Progressive Mode: Waiting for story text after cover */}
      {progressiveMode && !story && coverImages?.frontCover && (
        <div className="bg-gradient-to-r from-indigo-50 to-purple-50 border-2 border-indigo-200 rounded-xl p-8 mt-6">
          <div className="flex flex-col items-center text-center">
            <div className="animate-spin rounded-full h-12 w-12 border-4 border-indigo-300 border-t-indigo-600 mb-4"></div>
            <h3 className="text-xl font-semibold text-indigo-700">
              {storyLang === 'de'
                ? 'Geschichte wird erstellt...'
                : storyLang === 'fr'
                ? 'Création de l\'histoire...'
                : 'Creating your story...'}
            </h3>
            <p className="text-indigo-500 mt-2">
              {storyLang === 'de'
                ? 'Die Seiten werden gleich angezeigt'
                : storyLang === 'fr'
                ? 'Les pages seront bientôt affichées'
                : 'Pages will appear shortly'}
            </p>
          </div>
        </div>
      )}

      {/* Story Pages with Images */}
      {hasImages && story && (
        <div className="space-y-8 mt-8">
          <h3 className="text-2xl font-bold text-gray-800 text-center mb-6">
            {title || (storyLang === 'de' ? 'Ihre Geschichte' : storyLang === 'fr' ? 'Votre histoire' : 'Your Story')}
          </h3>

          {storyPages.slice(0, progressiveMode ? maxViewablePage : storyPages.length).map((pageText, index) => {
            const pageNumber = index + 1;
            // All layouts now use 1:1 mapping (text page = image page)
            // The difference is only in DISPLAY: Bilderbuch = combined, Kinderbuch = side-by-side
            const sceneNumber = pageNumber;
            const image = sceneImages.find(img => img.pageNumber === sceneNumber);
            // In progressive mode, also check completedPageImages for the image
            const progressiveImageData = progressiveMode ? completedPageImages[sceneNumber] : undefined;
            const hasPageImage = !!(image?.imageData || progressiveImageData);
            const isWaitingForImage = progressiveMode && pageNumber === maxViewablePage && !hasPageImage;

            return (
              <div key={pageNumber} className="p-4 md:p-6">
                <h4 className="text-xl font-bold text-gray-800 mb-4 text-center">
                  {storyLang === 'de' ? `Seite ${pageNumber}` : storyLang === 'fr' ? `Page ${pageNumber}` : `Page ${pageNumber}`}
                </h4>

                {/* Picture Book Layout: Image on top, text below */}
                {isPictureBook ? (
                  <div className="flex flex-col items-center max-w-2xl mx-auto">
                    {/* Image on top - show placeholder if waiting for image */}
                    {isWaitingForImage ? (
                      <div className="w-full mb-4 aspect-[4/3] bg-gradient-to-br from-indigo-100 to-purple-100 rounded-lg shadow-md flex flex-col items-center justify-center">
                        <div className="animate-spin rounded-full h-12 w-12 border-4 border-indigo-300 border-t-indigo-600 mb-4"></div>
                        <p className="text-indigo-600 font-medium">
                          {storyLang === 'de' ? 'Bild wird erstellt...' : storyLang === 'fr' ? 'Création de l\'image...' : 'Creating image...'}
                        </p>
                        <p className="text-indigo-400 text-sm mt-1">
                          {storyLang === 'de' ? 'Die nächste Seite erscheint bald' : storyLang === 'fr' ? 'La page suivante arrive bientôt' : 'Next page coming soon'}
                        </p>
                      </div>
                    ) : (image?.imageData || progressiveImageData) ? (
                      <div className="w-full mb-4 relative">
                        <DiagnosticImage
                          src={(image?.imageData || progressiveImageData) ?? ''}
                          alt={`Scene for page ${pageNumber}`}
                          className={`w-full rounded-lg shadow-md object-cover ${regeneratingPage === pageNumber ? 'opacity-50' : ''}`}
                          label={`Page ${pageNumber}`}
                        />
                        {/* Regenerating spinner overlay */}
                        {regeneratingPage === pageNumber && (
                          <div className="absolute inset-0 flex flex-col items-center justify-center bg-white/60 rounded-lg">
                            <Loader size={40} className="animate-spin text-indigo-600 mb-2" />
                            <p className="text-indigo-700 font-medium text-sm">
                              {language === 'de' ? 'Neues Bild wird erstellt...' : language === 'fr' ? 'Nouvelle image en cours...' : 'Generating new image...'}
                            </p>
                          </div>
                        )}
                        {/* Image action buttons - shown to all users */}
                        {onRegenerateImage && (
                          <div className="mt-3 space-y-2">
                            {/* Regenerate Image and Edit Text buttons */}
                            <div className="flex gap-2 items-center">
                              <button
                                onClick={() => openSceneEditModal(pageNumber)}
                                disabled={isGenerating || isRegenerating || !hasEnoughCredits}
                                className={`flex-1 bg-indigo-500 text-white px-3 py-2 rounded-lg flex items-center justify-center gap-2 text-sm font-semibold ${
                                  isGenerating || isRegenerating || !hasEnoughCredits ? 'opacity-50 cursor-not-allowed' : 'hover:bg-indigo-600'
                                }`}
                                title={!hasEnoughCredits
                                  ? (language === 'de' ? 'Nicht genug Credits' : language === 'fr' ? 'Pas assez de crédits' : 'Not enough credits')
                                  : ''
                                }
                              >
                                <RefreshCw size={14} />
                                {language === 'de' ? 'Bild neu generieren' : language === 'fr' ? 'Régénérer l\'image' : 'Regenerate Image'}
                                <span className="text-xs opacity-80">
                                  ({imageRegenerationCost} {language === 'de' ? 'Credits' : 'credits'})
                                </span>
                              </button>
                              {/* Edit Text button */}
                              {onSaveStoryText && (
                                <button
                                  onClick={() => setIsEditMode(true)}
                                  disabled={isGenerating}
                                  className={`flex-1 bg-indigo-500 text-white px-3 py-2 rounded-lg flex items-center justify-center gap-2 text-sm font-semibold ${
                                    isGenerating ? 'opacity-50 cursor-not-allowed' : 'hover:bg-indigo-600'
                                  }`}
                                >
                                  <Edit3 size={14} />
                                  {language === 'de' ? 'Text bearbeiten' : language === 'fr' ? 'Modifier le texte' : 'Edit Text'}
                                </button>
                              )}
                              {getImageVersions(pageNumber).length > 1 && (
                                <button
                                  onClick={() => setImageHistoryModal({ pageNumber, versions: getImageVersions(pageNumber) })}
                                  className="px-3 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 text-sm text-gray-600 flex items-center gap-1"
                                >
                                  <Images size={14} />
                                  {getImageVersions(pageNumber).length}
                                </button>
                              )}
                            </div>
                          </div>
                        )}

                        {/* Developer Mode Features */}
                        {developerMode && (
                          <div className="mt-3 space-y-2">
                            {/* Edit button - dev only */}
                            {onEditImage && (
                              <button
                                onClick={() => onEditImage(pageNumber)}
                                disabled={isGenerating}
                                className={`w-full bg-indigo-500 text-white px-3 py-2 rounded-lg flex items-center justify-center gap-2 text-sm font-semibold ${
                                  isGenerating ? 'opacity-50 cursor-not-allowed' : 'hover:bg-indigo-600'
                                }`}
                              >
                                <Edit3 size={14} /> {language === 'de' ? 'Bearbeiten' : 'Edit'}
                              </button>
                            )}

                            {/* Auto-Repair button - dev only */}
                            {onRepairImage && (
                              <button
                                onClick={() => handleRepairImage(pageNumber)}
                                disabled={isGenerating || repairingPage !== null}
                                className={`w-full bg-amber-500 text-white px-3 py-2 rounded-lg flex items-center justify-center gap-2 text-sm font-semibold ${
                                  isGenerating || repairingPage !== null ? 'opacity-50 cursor-not-allowed' : 'hover:bg-amber-600'
                                }`}
                                title={language === 'de' ? 'Physik-Fehler automatisch erkennen und reparieren' : language === 'fr' ? 'Détecter et réparer automatiquement les erreurs physiques' : 'Automatically detect and fix physics errors'}
                              >
                                {repairingPage === pageNumber ? (
                                  <>
                                    <Loader size={14} className="animate-spin" />
                                    {language === 'de' ? 'Repariere...' : language === 'fr' ? 'Réparation...' : 'Repairing...'}
                                  </>
                                ) : (
                                  <>
                                    <Wrench size={14} />
                                    {language === 'de' ? 'Auto-Reparatur' : language === 'fr' ? 'Auto-Réparation' : 'Auto-Repair'}
                                  </>
                                )}
                              </button>
                            )}

                            {/* Repair History - show if image was auto-repaired */}
                            {image?.repairHistory && image.repairHistory.length > 0 && (
                              <details className="bg-amber-50 border border-amber-300 rounded-lg p-3">
                                <summary className="cursor-pointer text-sm font-semibold text-amber-800 hover:text-amber-900 flex items-center gap-2">
                                  <Wrench size={14} />
                                  {language === 'de' ? 'Reparatur-Historie' : language === 'fr' ? 'Historique de réparation' : 'Repair History'}
                                  <span className="text-amber-600 font-normal">({image.repairHistory.length} {language === 'de' ? 'Reparaturen' : 'repairs'})</span>
                                </summary>
                                <div className="mt-3 space-y-3">
                                  {image.repairHistory.map((repair: RepairAttempt, idx: number) => (
                                    <div key={idx} className={`border rounded-lg p-3 ${repair.success ? 'bg-green-50 border-green-300' : 'bg-red-50 border-red-300'}`}>
                                      <div className="flex items-center justify-between mb-2">
                                        <span className="font-semibold text-sm">
                                          {language === 'de' ? `Reparatur ${repair.attempt}` : `Repair ${repair.attempt}`}
                                          <span className={`ml-2 text-xs ${repair.success ? 'text-green-600' : 'text-red-600'}`}>
                                            ({repair.success ? '✓' : '✗'} {repair.errorType})
                                          </span>
                                        </span>
                                      </div>
                                      <p className="text-xs text-gray-600 mb-2">{repair.description}</p>
                                      <details className="text-xs">
                                        <summary className="cursor-pointer text-amber-700">
                                          {language === 'de' ? 'Details anzeigen' : 'Show details'}
                                        </summary>
                                        <div className="mt-2 space-y-2">
                                          <div className="bg-white p-2 rounded border">
                                            <strong>{language === 'de' ? 'Fix-Anweisung:' : 'Fix instruction:'}</strong> {repair.fixPrompt}
                                          </div>
                                          {repair.maskImage && (
                                            <div>
                                              <strong className="block mb-1">{language === 'de' ? 'Maske:' : 'Mask:'}</strong>
                                              <img src={repair.maskImage} alt="Repair mask" className="w-32 h-32 object-contain border rounded" />
                                            </div>
                                          )}
                                          {repair.beforeImage && repair.afterImage && (
                                            <div className="flex gap-4">
                                              <div>
                                                <strong className="block mb-1 text-xs">{language === 'de' ? 'Vorher:' : 'Before:'}</strong>
                                                <img
                                                  src={repair.beforeImage}
                                                  alt="Before repair"
                                                  className="w-48 h-48 object-contain border rounded bg-gray-100 cursor-pointer hover:opacity-80 hover:ring-2 hover:ring-amber-400"
                                                  onClick={() => setEnlargedImage({ src: repair.beforeImage!, title: language === 'de' ? 'Vorher' : 'Before' })}
                                                  title={language === 'de' ? 'Klicken zum Vergrößern' : 'Click to enlarge'}
                                                />
                                              </div>
                                              <div>
                                                <strong className="block mb-1 text-xs">{language === 'de' ? 'Nachher:' : 'After:'}</strong>
                                                <img
                                                  src={repair.afterImage}
                                                  alt="After repair"
                                                  className="w-48 h-48 object-contain border rounded bg-gray-100 cursor-pointer hover:opacity-80 hover:ring-2 hover:ring-amber-400"
                                                  onClick={() => setEnlargedImage({ src: repair.afterImage!, title: language === 'de' ? 'Nachher' : 'After' })}
                                                  title={language === 'de' ? 'Klicken zum Vergrößern' : 'Click to enlarge'}
                                                />
                                              </div>
                                            </div>
                                          )}
                                        </div>
                                      </details>
                                      <div className="text-xs text-gray-400 mt-1">
                                        {new Date(repair.timestamp).toLocaleTimeString()}
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              </details>
                            )}

                            {/* 1. Outline Extract */}
                            {getOutlineExtract(pageNumber) && (
                              <details className="bg-amber-50 border border-amber-300 rounded-lg p-3">
                                <summary className="cursor-pointer text-sm font-semibold text-amber-800 hover:text-amber-900">
                                  {language === 'de' ? 'Auszug aus Gliederung' : language === 'fr' ? 'Extrait du plan' : 'Outline Extract'}
                                </summary>
                                <pre className="mt-2 text-xs text-gray-700 whitespace-pre-wrap font-mono bg-white p-3 rounded border border-gray-200 overflow-x-auto">
                                  {getOutlineExtract(pageNumber)}
                                </pre>
                              </details>
                            )}

                            {/* 2. Scene Prompt (Art Director) */}
                            {getScenePrompt(pageNumber) && (
                              <details className="bg-purple-50 border border-purple-300 rounded-lg p-3">
                                <summary className="cursor-pointer text-sm font-semibold text-purple-800 hover:text-purple-900">
                                  {language === 'de' ? 'Szenen-Prompt' : language === 'fr' ? 'Prompt de scène' : 'Scene Prompt'}
                                </summary>
                                <pre className="mt-2 text-xs text-gray-700 whitespace-pre-wrap font-mono bg-white p-3 rounded border border-gray-200 overflow-x-auto max-h-64 overflow-y-auto">
                                  {getScenePrompt(pageNumber)}
                                </pre>
                              </details>
                            )}

                            {/* 3. Scene Description */}
                            {getSceneDescription(pageNumber) && (
                              <details className="bg-green-50 border border-green-300 rounded-lg p-3">
                                <summary className="cursor-pointer text-sm font-semibold text-green-800 hover:text-green-900">
                                  {language === 'de' ? 'Szenenbeschreibung' : language === 'fr' ? 'Description de scène' : 'Scene Description'}
                                  {getSceneTextModelId(pageNumber) && <span className="ml-2 text-xs font-normal text-green-600">({getSceneTextModelId(pageNumber)})</span>}
                                </summary>
                                <pre className="mt-2 text-xs text-gray-700 whitespace-pre-wrap font-mono bg-white p-3 rounded border border-gray-200 overflow-x-auto">
                                  {getSceneDescription(pageNumber)}
                                </pre>
                              </details>
                            )}

                            {/* 4. API Prompt (Image Generation) */}
                            {image?.prompt && (
                              <details className="bg-blue-50 border border-blue-300 rounded-lg p-3">
                                <summary className="cursor-pointer text-sm font-semibold text-blue-800 hover:text-blue-900">
                                  {language === 'de' ? 'API-Prompt' : language === 'fr' ? 'Prompt API' : 'API Prompt'}
                                  {image?.modelId && <span className="ml-2 text-xs font-normal text-blue-600">({image.modelId})</span>}
                                </summary>
                                <pre className="mt-2 text-xs text-gray-700 whitespace-pre-wrap font-mono bg-white p-3 rounded border border-gray-200 overflow-x-auto max-h-48 overflow-y-auto">
                                  {image?.prompt}
                                </pre>
                              </details>
                            )}

                            {/* Reference Photos */}
                            {((image?.referencePhotos?.length ?? 0) > 0 || (image?.landmarkPhotos?.length ?? 0) > 0) && image && (
                              <ReferencePhotosDisplay
                                referencePhotos={image.referencePhotos || []}
                                landmarkPhotos={image.landmarkPhotos}
                                language={language}
                              />
                            )}

                            {/* Quality Score with Reasoning */}
                            {image?.qualityScore !== undefined && (
                              <details className="bg-indigo-50 border border-indigo-300 rounded-lg p-3">
                                <summary className="cursor-pointer text-sm font-semibold text-indigo-700 hover:text-indigo-900 flex items-center justify-between">
                                  <span className="flex items-center gap-2">
                                    {language === 'de' ? 'Qualitätsbewertung' : language === 'fr' ? 'Score de qualité' : 'Quality Score'}
                                    {image?.qualityModelId && <span className="text-xs font-normal text-indigo-500">({image.qualityModelId})</span>}
                                  </span>
                                  <span className={`text-lg font-bold ${
                                    (image?.qualityScore ?? 0) >= 70 ? 'text-green-600' :
                                    (image?.qualityScore ?? 0) >= 50 ? 'text-yellow-600' :
                                    'text-red-600'
                                  }`}>
                                    {Math.round(image?.qualityScore ?? 0)}%
                                  </span>
                                </summary>
                                {image?.qualityReasoning && (
                                  <div className="mt-2 text-xs text-gray-800 bg-white p-3 rounded border border-gray-200">
                                    <div className="font-semibold mb-1">{language === 'de' ? 'Feedback:' : language === 'fr' ? 'Retour:' : 'Feedback:'}</div>
                                    <p className="whitespace-pre-wrap">{image.qualityReasoning}</p>
                                  </div>
                                )}
                              </details>
                            )}

                            {/* Retry History (shows all attempts with images) */}
                            {image?.retryHistory && image.retryHistory.length > 0 && (
                              <RetryHistoryDisplay
                                retryHistory={image.retryHistory}
                                totalAttempts={image?.totalAttempts || image.retryHistory.length}
                                language={language}
                              />
                            )}

                            {/* Regeneration Info (fallback for older data without retryHistory) */}
                            {image?.wasRegenerated && (!image?.retryHistory || image.retryHistory.length === 0) && (
                              <details className="bg-orange-50 border border-orange-300 rounded-lg p-3">
                                <summary className="cursor-pointer text-sm font-semibold text-orange-700 flex items-center justify-between">
                                  <span>🔄 {language === 'de' ? 'Bild regeneriert' : language === 'fr' ? 'Image régénérée' : 'Image Regenerated'}</span>
                                  {image?.originalScore !== undefined && (
                                    <span className="text-red-600">Original: {Math.round(image.originalScore)}%</span>
                                  )}
                                </summary>
                                <div className="mt-2">
                                  <p className="text-xs text-gray-600 mb-2">
                                    {language === 'de' ? 'Das Bild wurde automatisch regeneriert, da die erste Version eine niedrige Qualität hatte.' :
                                     language === 'fr' ? "L'image a été automatiquement régénérée car la première version avait une qualité faible." :
                                     'Image was automatically regenerated because the first version had low quality.'}
                                  </p>
                                  {image?.originalImage && (
                                    <div className="mt-2">
                                      <p className="text-xs font-semibold text-gray-700 mb-1">
                                        {language === 'de' ? 'Originalbild:' : language === 'fr' ? 'Image originale:' : 'Original Image:'}
                                      </p>
                                      <img
                                        src={image.originalImage}
                                        alt="Original (lower quality)"
                                        className="w-full rounded border-2 border-orange-200 opacity-75"
                                      />
                                      {image?.originalReasoning && (
                                        <div className="mt-2 text-xs text-gray-600 bg-white p-2 rounded border">
                                          <div className="font-semibold mb-1">{language === 'de' ? 'Original Feedback:' : language === 'fr' ? 'Retour original:' : 'Original Feedback:'}</div>
                                          <p className="whitespace-pre-wrap">{image.originalReasoning}</p>
                                        </div>
                                      )}
                                    </div>
                                  )}
                                </div>
                              </details>
                            )}
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className={`w-full flex flex-col items-center justify-center rounded-lg p-8 mb-4 ${isGenerating ? 'bg-gradient-to-br from-indigo-100 to-purple-100' : 'bg-gray-100'}`}>
                        {isGenerating ? (
                          <>
                            <div className="animate-spin rounded-full h-10 w-10 border-4 border-indigo-300 border-t-indigo-600 mb-3"></div>
                            <p className="text-indigo-600 font-medium text-center">
                              {storyLang === 'de' ? 'Bild wird noch erstellt...' : storyLang === 'fr' ? 'Image en cours de création...' : 'Image is being created...'}
                            </p>
                          </>
                        ) : (
                          <p className="text-gray-500 text-center">
                            {storyLang === 'de' ? 'Kein Bild für diese Seite' : storyLang === 'fr' ? 'Pas d\'image pour cette page' : 'No image for this page'}
                          </p>
                        )}
                      </div>
                    )}

                    {/* Text below */}
                    <div className="w-full bg-indigo-50 rounded-lg p-6 border-2 border-indigo-200">
                      {isEditMode ? (
                        <textarea
                          value={pageText.trim()}
                          onChange={(e) => handlePageTextChange(index, e.target.value)}
                          className="w-full min-h-[400px] p-3 text-gray-800 leading-snug font-serif text-xl text-center bg-white border-2 border-amber-300 rounded-lg focus:border-amber-500 focus:ring-2 focus:ring-amber-200 outline-none resize-y"
                          placeholder={language === 'de' ? 'Text eingeben...' : language === 'fr' ? 'Entrez le texte...' : 'Enter text...'}
                        />
                      ) : (
                        <p className="text-gray-800 leading-snug whitespace-pre-wrap font-serif text-xl text-center">
                          {pageText.trim()}
                        </p>
                      )}
                    </div>
                  </div>
                ) : (
                  /* Standard Layout: Image on left, text on right (side-by-side) */
                  <div className="grid md:grid-cols-2 gap-6 items-stretch">
                    {/* Image on the left */}
                    {image && image.imageData ? (
                      <div className="flex flex-col">
                        <div className="relative">
                          <img
                            src={image.imageData}
                            alt={`Scene for page ${pageNumber}`}
                            className={`w-full rounded-lg shadow-md object-cover ${regeneratingPage === pageNumber ? 'opacity-50' : ''}`}
                          />
                          {/* Regenerating spinner overlay */}
                          {regeneratingPage === pageNumber && (
                            <div className="absolute inset-0 flex flex-col items-center justify-center bg-white/60 rounded-lg">
                              <Loader size={40} className="animate-spin text-indigo-600 mb-2" />
                              <p className="text-indigo-700 font-medium text-sm">
                                {language === 'de' ? 'Neues Bild wird erstellt...' : language === 'fr' ? 'Nouvelle image en cours...' : 'Generating new image...'}
                              </p>
                            </div>
                          )}
                        </div>
                        {/* Image action buttons - shown to all users */}
                        {onRegenerateImage && (
                          <div className="mt-3 space-y-2">
                            {/* Regenerate Image and Edit Text buttons */}
                            <div className="flex gap-2 items-center">
                              <button
                                onClick={() => openSceneEditModal(pageNumber)}
                                disabled={isGenerating || isRegenerating || !hasEnoughCredits}
                                className={`flex-1 bg-indigo-500 text-white px-3 py-2 rounded-lg flex items-center justify-center gap-2 text-sm font-semibold ${
                                  isGenerating || isRegenerating || !hasEnoughCredits ? 'opacity-50 cursor-not-allowed' : 'hover:bg-indigo-600'
                                }`}
                                title={!hasEnoughCredits
                                  ? (language === 'de' ? 'Nicht genug Credits' : language === 'fr' ? 'Pas assez de crédits' : 'Not enough credits')
                                  : ''
                                }
                              >
                                <RefreshCw size={14} />
                                {language === 'de' ? 'Bild neu generieren' : language === 'fr' ? 'Régénérer l\'image' : 'Regenerate Image'}
                                <span className="text-xs opacity-80">
                                  ({imageRegenerationCost} {language === 'de' ? 'Credits' : 'credits'})
                                </span>
                              </button>
                              {/* Edit Text button */}
                              {onSaveStoryText && (
                                <button
                                  onClick={() => setIsEditMode(true)}
                                  disabled={isGenerating}
                                  className={`flex-1 bg-indigo-500 text-white px-3 py-2 rounded-lg flex items-center justify-center gap-2 text-sm font-semibold ${
                                    isGenerating ? 'opacity-50 cursor-not-allowed' : 'hover:bg-indigo-600'
                                  }`}
                                >
                                  <Edit3 size={14} />
                                  {language === 'de' ? 'Text bearbeiten' : language === 'fr' ? 'Modifier le texte' : 'Edit Text'}
                                </button>
                              )}
                              {getImageVersions(pageNumber).length > 1 && (
                                <button
                                  onClick={() => setImageHistoryModal({ pageNumber, versions: getImageVersions(pageNumber) })}
                                  className="px-3 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 text-sm text-gray-600 flex items-center gap-1"
                                >
                                  <Images size={14} />
                                  {getImageVersions(pageNumber).length}
                                </button>
                              )}
                            </div>
                          </div>
                        )}

                        {/* Developer Mode Features */}
                        {developerMode && (
                          <div className="mt-3 space-y-2">
                            {/* Edit button - dev only */}
                            {onEditImage && (
                              <button
                                onClick={() => onEditImage(pageNumber)}
                                disabled={isGenerating}
                                className={`w-full bg-indigo-500 text-white px-3 py-2 rounded-lg flex items-center justify-center gap-2 text-sm font-semibold ${
                                  isGenerating ? 'opacity-50 cursor-not-allowed' : 'hover:bg-indigo-600'
                                }`}
                              >
                                <Edit3 size={14} /> {language === 'de' ? 'Bearbeiten' : 'Edit'}
                              </button>
                            )}

                            {/* Auto-Repair button - dev only */}
                            {onRepairImage && (
                              <button
                                onClick={() => handleRepairImage(pageNumber)}
                                disabled={isGenerating || repairingPage !== null}
                                className={`w-full bg-amber-500 text-white px-3 py-2 rounded-lg flex items-center justify-center gap-2 text-sm font-semibold ${
                                  isGenerating || repairingPage !== null ? 'opacity-50 cursor-not-allowed' : 'hover:bg-amber-600'
                                }`}
                                title={language === 'de' ? 'Physik-Fehler automatisch erkennen und reparieren' : language === 'fr' ? 'Détecter et réparer automatiquement les erreurs physiques' : 'Automatically detect and fix physics errors'}
                              >
                                {repairingPage === pageNumber ? (
                                  <>
                                    <Loader size={14} className="animate-spin" />
                                    {language === 'de' ? 'Repariere...' : language === 'fr' ? 'Réparation...' : 'Repairing...'}
                                  </>
                                ) : (
                                  <>
                                    <Wrench size={14} />
                                    {language === 'de' ? 'Auto-Reparatur' : language === 'fr' ? 'Auto-Réparation' : 'Auto-Repair'}
                                  </>
                                )}
                              </button>
                            )}

                            {/* Repair History - show if image was auto-repaired */}
                            {image?.repairHistory && image.repairHistory.length > 0 && (
                              <details className="bg-amber-50 border border-amber-300 rounded-lg p-3">
                                <summary className="cursor-pointer text-sm font-semibold text-amber-800 hover:text-amber-900 flex items-center gap-2">
                                  <Wrench size={14} />
                                  {language === 'de' ? 'Reparatur-Historie' : language === 'fr' ? 'Historique de réparation' : 'Repair History'}
                                  <span className="text-amber-600 font-normal">({image.repairHistory.length} {language === 'de' ? 'Reparaturen' : 'repairs'})</span>
                                </summary>
                                <div className="mt-3 space-y-3">
                                  {image.repairHistory.map((repair: RepairAttempt, idx: number) => (
                                    <div key={idx} className={`border rounded-lg p-3 ${repair.success ? 'bg-green-50 border-green-300' : 'bg-red-50 border-red-300'}`}>
                                      <div className="flex items-center justify-between mb-2">
                                        <span className="font-semibold text-sm">
                                          {language === 'de' ? `Reparatur ${repair.attempt}` : `Repair ${repair.attempt}`}
                                          <span className={`ml-2 text-xs ${repair.success ? 'text-green-600' : 'text-red-600'}`}>
                                            ({repair.success ? '✓' : '✗'} {repair.errorType})
                                          </span>
                                        </span>
                                      </div>
                                      <p className="text-xs text-gray-600 mb-2">{repair.description}</p>
                                      <details className="text-xs">
                                        <summary className="cursor-pointer text-amber-700">
                                          {language === 'de' ? 'Details anzeigen' : 'Show details'}
                                        </summary>
                                        <div className="mt-2 space-y-2">
                                          <div className="bg-white p-2 rounded border">
                                            <strong>{language === 'de' ? 'Fix-Anweisung:' : 'Fix instruction:'}</strong> {repair.fixPrompt}
                                          </div>
                                          {repair.maskImage && (
                                            <div>
                                              <strong className="block mb-1">{language === 'de' ? 'Maske:' : 'Mask:'}</strong>
                                              <img src={repair.maskImage} alt="Repair mask" className="w-32 h-32 object-contain border rounded" />
                                            </div>
                                          )}
                                          {repair.beforeImage && repair.afterImage && (
                                            <div className="flex gap-4">
                                              <div>
                                                <strong className="block mb-1 text-xs">{language === 'de' ? 'Vorher:' : 'Before:'}</strong>
                                                <img
                                                  src={repair.beforeImage}
                                                  alt="Before repair"
                                                  className="w-48 h-48 object-contain border rounded bg-gray-100 cursor-pointer hover:opacity-80 hover:ring-2 hover:ring-amber-400"
                                                  onClick={() => setEnlargedImage({ src: repair.beforeImage!, title: language === 'de' ? 'Vorher' : 'Before' })}
                                                  title={language === 'de' ? 'Klicken zum Vergrößern' : 'Click to enlarge'}
                                                />
                                              </div>
                                              <div>
                                                <strong className="block mb-1 text-xs">{language === 'de' ? 'Nachher:' : 'After:'}</strong>
                                                <img
                                                  src={repair.afterImage}
                                                  alt="After repair"
                                                  className="w-48 h-48 object-contain border rounded bg-gray-100 cursor-pointer hover:opacity-80 hover:ring-2 hover:ring-amber-400"
                                                  onClick={() => setEnlargedImage({ src: repair.afterImage!, title: language === 'de' ? 'Nachher' : 'After' })}
                                                  title={language === 'de' ? 'Klicken zum Vergrößern' : 'Click to enlarge'}
                                                />
                                              </div>
                                            </div>
                                          )}
                                        </div>
                                      </details>
                                      <div className="text-xs text-gray-400 mt-1">
                                        {new Date(repair.timestamp).toLocaleTimeString()}
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              </details>
                            )}

                            {/* 1. Outline Extract */}
                            {getOutlineExtract(pageNumber) && (
                              <details className="bg-amber-50 border border-amber-300 rounded-lg p-3">
                                <summary className="cursor-pointer text-sm font-semibold text-amber-800 hover:text-amber-900">
                                  {language === 'de' ? 'Auszug aus Gliederung' : language === 'fr' ? 'Extrait du plan' : 'Outline Extract'}
                                </summary>
                                <pre className="mt-2 text-xs text-gray-700 whitespace-pre-wrap font-mono bg-white p-3 rounded border border-gray-200 overflow-x-auto">
                                  {getOutlineExtract(pageNumber)}
                                </pre>
                              </details>
                            )}

                            {/* 2. Scene Prompt (Art Director) */}
                            {getScenePrompt(pageNumber) && (
                              <details className="bg-purple-50 border border-purple-300 rounded-lg p-3">
                                <summary className="cursor-pointer text-sm font-semibold text-purple-800 hover:text-purple-900">
                                  {language === 'de' ? 'Szenen-Prompt' : language === 'fr' ? 'Prompt de scène' : 'Scene Prompt'}
                                </summary>
                                <pre className="mt-2 text-xs text-gray-700 whitespace-pre-wrap font-mono bg-white p-3 rounded border border-gray-200 overflow-x-auto max-h-64 overflow-y-auto">
                                  {getScenePrompt(pageNumber)}
                                </pre>
                              </details>
                            )}

                            {/* 3. Scene Description */}
                            {getSceneDescription(pageNumber) && (
                              <details className="bg-green-50 border border-green-300 rounded-lg p-3">
                                <summary className="cursor-pointer text-sm font-semibold text-green-800 hover:text-green-900">
                                  {language === 'de' ? 'Szenenbeschreibung' : language === 'fr' ? 'Description de scène' : 'Scene Description'}
                                  {getSceneTextModelId(pageNumber) && <span className="ml-2 text-xs font-normal text-green-600">({getSceneTextModelId(pageNumber)})</span>}
                                </summary>
                                <pre className="mt-2 text-xs text-gray-700 whitespace-pre-wrap font-mono bg-white p-3 rounded border border-gray-200 overflow-x-auto">
                                  {getSceneDescription(pageNumber)}
                                </pre>
                              </details>
                            )}

                            {/* 4. API Prompt (Image Generation) */}
                            {image.prompt && (
                              <details className="bg-blue-50 border border-blue-300 rounded-lg p-3">
                                <summary className="cursor-pointer text-sm font-semibold text-blue-800 hover:text-blue-900">
                                  {language === 'de' ? 'API-Prompt' : language === 'fr' ? 'Prompt API' : 'API Prompt'}
                                  {image.modelId && <span className="ml-2 text-xs font-normal text-blue-600">({image.modelId})</span>}
                                </summary>
                                <pre className="mt-2 text-xs text-gray-700 whitespace-pre-wrap font-mono bg-white p-3 rounded border border-gray-200 overflow-x-auto max-h-48 overflow-y-auto">
                                  {image.prompt}
                                </pre>
                              </details>
                            )}

                            {/* Reference Photos */}
                            {((image.referencePhotos?.length ?? 0) > 0 || (image.landmarkPhotos?.length ?? 0) > 0) && (
                              <ReferencePhotosDisplay
                                referencePhotos={image.referencePhotos || []}
                                landmarkPhotos={image.landmarkPhotos}
                                language={language}
                              />
                            )}

                            {/* Quality Score with Reasoning */}
                            {image.qualityScore !== undefined && (
                              <details className="bg-indigo-50 border border-indigo-300 rounded-lg p-3">
                                <summary className="cursor-pointer text-sm font-semibold text-indigo-700 hover:text-indigo-900 flex items-center justify-between">
                                  <span className="flex items-center gap-2">
                                    {language === 'de' ? 'Qualitätsbewertung' : language === 'fr' ? 'Score de qualité' : 'Quality Score'}
                                    {image.qualityModelId && <span className="text-xs font-normal text-indigo-500">({image.qualityModelId})</span>}
                                  </span>
                                  <span className={`text-lg font-bold ${
                                    image.qualityScore >= 70 ? 'text-green-600' :
                                    image.qualityScore >= 50 ? 'text-yellow-600' :
                                    'text-red-600'
                                  }`}>
                                    {Math.round(image.qualityScore)}%
                                  </span>
                                </summary>
                                {image.qualityReasoning && (
                                  <div className="mt-2 text-xs text-gray-800 bg-white p-3 rounded border border-gray-200">
                                    <div className="font-semibold mb-1">{language === 'de' ? 'Feedback:' : language === 'fr' ? 'Retour:' : 'Feedback:'}</div>
                                    <p className="whitespace-pre-wrap">{image.qualityReasoning}</p>
                                  </div>
                                )}
                              </details>
                            )}

                            {/* Retry History (shows all attempts with images) */}
                            {image.retryHistory && image.retryHistory.length > 0 && (
                              <RetryHistoryDisplay
                                retryHistory={image.retryHistory}
                                totalAttempts={image.totalAttempts || image.retryHistory.length}
                                language={language}
                              />
                            )}

                            {/* Regeneration Info (fallback for older data without retryHistory) */}
                            {image.wasRegenerated && (!image.retryHistory || image.retryHistory.length === 0) && (
                              <details className="bg-orange-50 border border-orange-300 rounded-lg p-3">
                                <summary className="cursor-pointer text-sm font-semibold text-orange-700 flex items-center justify-between">
                                  <span>🔄 {language === 'de' ? 'Bild regeneriert' : language === 'fr' ? 'Image régénérée' : 'Image Regenerated'}</span>
                                  {image.originalScore !== undefined && (
                                    <span className="text-red-600">Original: {Math.round(image.originalScore)}%</span>
                                  )}
                                </summary>
                                <div className="mt-2">
                                  <p className="text-xs text-gray-600 mb-2">
                                    {language === 'de' ? 'Das Bild wurde automatisch regeneriert, da die erste Version eine niedrige Qualität hatte.' :
                                     language === 'fr' ? "L'image a été automatiquement régénérée car la première version avait une qualité faible." :
                                     'Image was automatically regenerated because the first version had low quality.'}
                                  </p>
                                  {image.originalImage && (
                                    <div className="mt-2">
                                      <p className="text-xs font-semibold text-gray-700 mb-1">
                                        {language === 'de' ? 'Originalbild:' : language === 'fr' ? 'Image originale:' : 'Original Image:'}
                                      </p>
                                      <img
                                        src={image.originalImage}
                                        alt="Original (lower quality)"
                                        className="w-full rounded border-2 border-orange-200 opacity-75"
                                      />
                                      {image.originalReasoning && (
                                        <div className="mt-2 text-xs text-gray-600 bg-white p-2 rounded border">
                                          <div className="font-semibold mb-1">{language === 'de' ? 'Original Feedback:' : language === 'fr' ? 'Retour original:' : 'Original Feedback:'}</div>
                                          <p className="whitespace-pre-wrap">{image.originalReasoning}</p>
                                        </div>
                                      )}
                                    </div>
                                  )}
                                </div>
                              </details>
                            )}
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className={`flex flex-col items-center justify-center rounded-lg p-8 ${isGenerating ? 'bg-gradient-to-br from-indigo-100 to-purple-100' : 'bg-gray-100'}`}>
                        {isGenerating ? (
                          <>
                            <div className="animate-spin rounded-full h-10 w-10 border-4 border-indigo-300 border-t-indigo-600 mb-3"></div>
                            <p className="text-indigo-600 font-medium text-center">
                              {storyLang === 'de' ? 'Bild wird noch erstellt...' : storyLang === 'fr' ? 'Image en cours de création...' : 'Image is being created...'}
                            </p>
                          </>
                        ) : (
                          <p className="text-gray-500 text-center">
                            {storyLang === 'de' ? 'Kein Bild für diese Seite' : storyLang === 'fr' ? 'Pas d\'image pour cette page' : 'No image for this page'}
                          </p>
                        )}
                      </div>
                    )}

                    {/* Text on the right */}
                    <div className="flex flex-col w-full h-full">
                      {isEditMode ? (
                        <textarea
                          value={pageText.trim()}
                          onChange={(e) => handlePageTextChange(index, e.target.value)}
                          className="w-full flex-1 min-h-[300px] p-4 text-gray-800 leading-snug font-serif text-xl bg-white border-2 border-amber-300 rounded-lg focus:border-amber-500 focus:ring-2 focus:ring-amber-200 outline-none resize-y"
                          placeholder={language === 'de' ? 'Text eingeben...' : language === 'fr' ? 'Entrez le texte...' : 'Enter text...'}
                        />
                      ) : (
                        <div className="prose max-w-none">
                          <p className="text-gray-800 leading-snug whitespace-pre-wrap font-serif text-xl">
                            {pageText.trim()}
                          </p>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}

          {/* Progressive mode: Show loading indicator for remaining scenes */}
          {/* Hide when all expected images are received, even if job isn't complete yet */}
          {/* Use totalScenes (image count) not totalPages (print pages) for comparison */}
          {progressiveMode && Object.keys(completedPageImages).length < totalScenes && (
            <div className="p-6 text-center">
              <div className="inline-flex flex-col items-center bg-gradient-to-r from-indigo-50 to-purple-50 rounded-xl p-6 shadow-sm">
                <div className="animate-spin rounded-full h-10 w-10 border-4 border-indigo-300 border-t-indigo-600 mb-3"></div>
                <p className="text-indigo-700 font-semibold">
                  {storyLang === 'de'
                    ? `Bild ${Object.keys(completedPageImages).length} von ${totalScenes}`
                    : storyLang === 'fr'
                    ? `Image ${Object.keys(completedPageImages).length} sur ${totalScenes}`
                    : `Image ${Object.keys(completedPageImages).length} of ${totalScenes}`}
                </p>
                <p className="text-indigo-500 text-sm mt-1">
                  {storyLang === 'de'
                    ? 'Weitere Bilder werden geladen...'
                    : storyLang === 'fr'
                    ? 'Chargement des images suivantes...'
                    : 'Loading more images...'}
                </p>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Placeholder for remaining pages during generation - only show if not all images are complete */}
      {isGenerating && story && sceneImages.filter(img => img.imageData).length < storyPages.length && (
        <div className="mt-8 max-w-2xl mx-auto">
          <div className="bg-gradient-to-r from-indigo-50 to-purple-50 border-2 border-indigo-200 border-dashed rounded-xl p-8">
            <div className="flex flex-col items-center text-center">
              <div className="animate-spin rounded-full h-10 w-10 border-4 border-indigo-300 border-t-indigo-600 mb-4"></div>
              <p className="text-indigo-700 font-semibold">
                {storyLang === 'de'
                  ? 'Weitere Seiten werden erstellt...'
                  : storyLang === 'fr'
                  ? 'Création des pages suivantes...'
                  : 'Creating more pages...'}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Back Cover Display - show as soon as available */}
      {coverImages && getCoverImageData(coverImages.backCover) && (() => {
        const backCoverObj = getCoverObject(coverImages.backCover);
        return (
          <div className="mt-8 max-w-2xl mx-auto">
            <p className="text-sm text-gray-500 text-center mb-2">
              {storyLang === 'de' ? 'Rückseite' : storyLang === 'fr' ? 'Quatrième de couverture' : 'Back Cover'}
            </p>
            <DiagnosticImage
              src={getCoverImageData(coverImages.backCover)!}
              alt="Back Cover"
              className="w-full rounded-lg shadow-lg"
              label="Back Cover"
            />
            {/* Regenerate Cover - visible to all users */}
            {_onRegenerateCover && (
              <div className="mt-3">
                <button
                  onClick={() => _onRegenerateCover('back')}
                  disabled={isGenerating || !hasEnoughCredits}
                  className={`w-full bg-indigo-500 text-white px-3 py-2 rounded-lg flex items-center justify-center gap-2 text-sm font-semibold ${
                    isGenerating || !hasEnoughCredits ? 'opacity-50 cursor-not-allowed' : 'hover:bg-indigo-600'
                  }`}
                  title={!hasEnoughCredits
                    ? (language === 'de' ? 'Nicht genug Credits' : language === 'fr' ? 'Pas assez de crédits' : 'Not enough credits')
                    : ''
                  }
                >
                  <RefreshCw size={14} />
                  {language === 'de' ? 'Bild neu generieren' : language === 'fr' ? 'Régénérer l\'image' : 'Regenerate Image'}
                  <span className="text-xs opacity-80">
                    ({imageRegenerationCost} {language === 'de' ? 'Credits' : 'credits'})
                  </span>
                </button>
              </div>
            )}
            {/* Developer Mode Features for Back Cover */}
            {developerMode && backCoverObj && (
              <div className="mt-3 space-y-2">
                {/* Edit Button - dev only */}
                {_onEditCover && (
                  <button
                    onClick={() => _onEditCover('back')}
                    disabled={isGenerating}
                    className={`w-full bg-indigo-500 text-white px-3 py-2 rounded-lg flex items-center justify-center gap-2 text-sm font-semibold ${
                      isGenerating ? 'opacity-50 cursor-not-allowed' : 'hover:bg-indigo-600'
                    }`}
                  >
                    <Edit3 size={14} /> {language === 'de' ? 'Bearbeiten' : 'Edit'}
                  </button>
                )}

                {/* Scene Description */}
                {backCoverObj.description && (
                  <details className="bg-green-50 border border-green-300 rounded-lg p-3">
                    <summary className="cursor-pointer text-sm font-semibold text-green-800 hover:text-green-900">
                      {language === 'de' ? 'Szenenbeschreibung' : language === 'fr' ? 'Description de scène' : 'Scene Description'}
                    </summary>
                    <pre className="mt-2 text-xs text-gray-700 whitespace-pre-wrap font-mono bg-white p-3 rounded border border-gray-200 overflow-x-auto">
                      {backCoverObj.description}
                    </pre>
                  </details>
                )}

                {/* API Prompt */}
                {backCoverObj.prompt && (
                  <details className="bg-blue-50 border border-blue-300 rounded-lg p-3">
                    <summary className="cursor-pointer text-sm font-semibold text-blue-800 hover:text-blue-900">
                      {language === 'de' ? 'API-Prompt' : language === 'fr' ? 'Prompt API' : 'API Prompt'}
                      {backCoverObj.modelId && <span className="ml-2 text-xs font-normal text-blue-600">({backCoverObj.modelId})</span>}
                    </summary>
                    <pre className="mt-2 text-xs text-gray-700 whitespace-pre-wrap font-mono bg-white p-3 rounded border border-gray-200 overflow-x-auto max-h-48 overflow-y-auto">
                      {backCoverObj.prompt}
                    </pre>
                  </details>
                )}

                {/* Reference Photos */}
                {((backCoverObj.referencePhotos?.length ?? 0) > 0 || (backCoverObj.landmarkPhotos?.length ?? 0) > 0) && (
                  <ReferencePhotosDisplay
                    referencePhotos={backCoverObj.referencePhotos || []}
                    landmarkPhotos={backCoverObj.landmarkPhotos}
                    language={language}
                  />
                )}

                {/* Quality Score */}
                {backCoverObj.qualityScore !== undefined && (
                  <details className="bg-indigo-50 border border-indigo-300 rounded-lg p-3">
                    <summary className="cursor-pointer text-sm font-semibold text-indigo-700 hover:text-indigo-900 flex items-center justify-between">
                      <span className="flex items-center gap-2">
                        {language === 'de' ? 'Qualitätsbewertung' : language === 'fr' ? 'Score de qualité' : 'Quality Score'}
                        {backCoverObj.qualityModelId && <span className="text-xs font-normal text-indigo-500">({backCoverObj.qualityModelId})</span>}
                      </span>
                      <span className={`text-lg font-bold ${
                        backCoverObj.qualityScore >= 70 ? 'text-green-600' :
                        backCoverObj.qualityScore >= 50 ? 'text-yellow-600' :
                        'text-red-600'
                      }`}>
                        {Math.round(backCoverObj.qualityScore)}%
                      </span>
                    </summary>
                    {backCoverObj.qualityReasoning && (
                      <div className="mt-2 text-xs text-gray-800 bg-white p-3 rounded border border-gray-200">
                        <div className="font-semibold mb-1">{language === 'de' ? 'Feedback:' : language === 'fr' ? 'Retour:' : 'Feedback:'}</div>
                        <p className="whitespace-pre-wrap">{backCoverObj.qualityReasoning}</p>
                      </div>
                    )}
                  </details>
                )}

                {/* Retry History */}
                {backCoverObj.retryHistory && backCoverObj.retryHistory.length > 0 && (
                  <RetryHistoryDisplay
                    retryHistory={backCoverObj.retryHistory}
                    totalAttempts={backCoverObj.totalAttempts || backCoverObj.retryHistory.length}
                    language={language}
                  />
                )}
              </div>
            )}
          </div>
        );
      })()}

      {/* Bottom Action Buttons - for users who scrolled to the end */}
      {hasImages && story && (
        <div className="bg-gradient-to-r from-indigo-50 to-purple-50 border-2 border-indigo-200 rounded-xl p-4 mt-6">
          <h3 className="text-base font-bold text-gray-800 mb-3 text-center">
            {language === 'de' ? 'Was möchten Sie als Nächstes tun?' : language === 'fr' ? 'Que souhaitez-vous faire ensuite ?' : 'What would you like to do next?'}
          </h3>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
            {/* Create Book */}
            {storyId && onAddToBook && (
              <button
                onClick={onAddToBook}
                disabled={isGenerating}
                className={`bg-indigo-500 text-white px-3 py-2 rounded-lg text-sm font-semibold flex items-center justify-center gap-1.5 ${
                  isGenerating ? 'opacity-50 cursor-not-allowed' : 'hover:bg-indigo-600'
                }`}
              >
                <ShoppingCart size={16} /> {language === 'de' ? 'Buch erstellen' : language === 'fr' ? 'Créer le livre' : 'Create Book'}
              </button>
            )}

            {/* PDF Download */}
            {onDownloadPdf && (
              <button
                onClick={onDownloadPdf}
                disabled={isGenerating}
                className={`bg-indigo-500 text-white px-3 py-2 rounded-lg text-sm font-semibold flex items-center justify-center gap-1.5 ${
                  isGenerating ? 'opacity-50 cursor-not-allowed' : 'hover:bg-indigo-600'
                }`}
              >
                <FileText size={16} /> {language === 'de' ? 'PDF herunterladen' : language === 'fr' ? 'Télécharger PDF' : 'Download PDF'}
              </button>
            )}

            {/* Edit Story */}
            {onSaveStoryText && !isEditMode && (
              <button
                onClick={() => setIsEditMode(true)}
                disabled={isGenerating}
                className={`bg-indigo-500 text-white px-3 py-2 rounded-lg text-sm font-semibold flex items-center justify-center gap-1.5 ${
                  isGenerating ? 'opacity-50 cursor-not-allowed' : 'hover:bg-indigo-600'
                }`}
              >
                <Edit3 size={16} /> {language === 'de' ? 'Text bearbeiten' : language === 'fr' ? 'Modifier le texte' : 'Edit Text'}
              </button>
            )}

            {/* Create Another Story */}
            {onCreateAnother && (
              <button
                onClick={onCreateAnother}
                disabled={isGenerating}
                className={`bg-indigo-500 text-white px-3 py-2 rounded-lg text-sm font-semibold flex items-center justify-center gap-1.5 ${
                  isGenerating ? 'opacity-50 cursor-not-allowed' : 'hover:bg-indigo-600'
                }`}
              >
                <Plus size={16} /> {language === 'de' ? 'Neue Geschichte' : language === 'fr' ? 'Nouvelle histoire' : 'New Story'}
              </button>
            )}
          </div>
        </div>
      )}

      {/* Floating Save/Cancel overlay when in edit mode */}
      {isEditMode && (
        <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-300 shadow-lg p-3 md:p-4 z-50">
          <div className="max-w-4xl mx-auto flex flex-col md:flex-row items-center justify-between gap-2 md:gap-4">
            <div className="flex items-center gap-2 text-amber-600">
              <Edit3 size={18} className="flex-shrink-0" />
              <span className="font-semibold text-sm md:text-base">
                {language === 'de' ? 'Bearbeitungsmodus' : language === 'fr' ? 'Mode édition' : 'Edit Mode'}
              </span>
              {originalStory && (
                <span className="text-xs text-gray-500 hidden sm:inline">
                  ({language === 'de' ? 'Original gespeichert' : language === 'fr' ? 'Original sauvegardé' : 'Original saved'})
                </span>
              )}
            </div>
            <div className="flex gap-2 w-full md:w-auto justify-center md:justify-end">
              <button
                onClick={handleCancelEdit}
                disabled={isSaving}
                className="px-3 md:px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 text-sm font-semibold flex items-center gap-1.5"
              >
                <X size={16} />
                <span className="hidden sm:inline">{language === 'de' ? 'Abbrechen' : language === 'fr' ? 'Annuler' : 'Cancel'}</span>
              </button>
              {originalStory && editedStory !== originalStory && (
                <button
                  onClick={() => setEditedStory(originalStory)}
                  disabled={isSaving}
                  className="px-3 md:px-4 py-2 border border-amber-400 text-amber-700 rounded-lg hover:bg-amber-50 text-sm font-semibold flex items-center gap-1.5"
                >
                  <RotateCcw size={16} />
                  <span className="hidden sm:inline">{language === 'de' ? 'Zurücksetzen' : language === 'fr' ? 'Restaurer' : 'Restore'}</span>
                </button>
              )}
              <button
                onClick={handleSaveStory}
                disabled={isSaving}
                className={`px-3 md:px-4 py-2 bg-green-500 text-white rounded-lg text-sm font-semibold flex items-center gap-1.5 ${
                  isSaving ? 'opacity-50 cursor-not-allowed' : 'hover:bg-green-600'
                }`}
              >
                <Save size={16} />
                {isSaving
                  ? (language === 'de' ? 'Speichern...' : language === 'fr' ? 'Sauvegarde...' : 'Saving...')
                  : (language === 'de' ? 'Speichern' : language === 'fr' ? 'Sauvegarder' : 'Save')
                }
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Scene Edit Modal - for editing scene before regenerating */}
      {sceneEditModal && (
        <SceneEditModal
          pageNumber={sceneEditModal.pageNumber}
          scene={sceneEditModal.scene}
          onSceneChange={(scene) => setSceneEditModal({ ...sceneEditModal, scene })}
          onClose={() => setSceneEditModal(null)}
          onRegenerate={handleRegenerateWithScene}
          isRegenerating={isRegenerating}
          imageRegenerationCost={imageRegenerationCost}
          characters={characters.map(c => ({ id: c.id, name: c.name, photoUrl: c.photoData }))}
          selectedCharacterIds={sceneEditModal.selectedCharacterIds}
          onCharacterSelectionChange={(ids) => setSceneEditModal({ ...sceneEditModal, selectedCharacterIds: ids })}
        />
      )}

      {/* Image History Modal */}
      {imageHistoryModal && (
        <ImageHistoryModal
          pageNumber={imageHistoryModal.pageNumber}
          versions={imageHistoryModal.versions}
          onClose={() => setImageHistoryModal(null)}
          onSelectVersion={handleSelectVersion}
          developerMode={developerMode}
        />
      )}

      {/* Enlarged Image Modal for repair before/after comparison */}
      {enlargedImage && (
        <EnlargedImageModal
          src={enlargedImage.src}
          title={enlargedImage.title}
          onClose={() => setEnlargedImage(null)}
        />
      )}
    </div>
  );
}

export default StoryDisplay;
