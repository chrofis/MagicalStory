import { useState, useEffect } from 'react';
import { BookOpen, FileText, ShoppingCart, Plus, Download, RefreshCw, Edit3, History, Save, X, Images, RotateCcw, Wrench, Loader } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import type { SceneImage, SceneDescription, CoverImages, CoverImageData, RetryAttempt, ReferencePhoto, ImageVersion, RepairAttempt } from '@/types/story';
import type { LanguageLevel } from '@/types/story';
import type { VisualBible } from '@/types/character';

// Helper component to display retry history
function RetryHistoryDisplay({
  retryHistory,
  totalAttempts,
  language
}: {
  retryHistory: RetryAttempt[];
  totalAttempts: number;
  language: string;
}) {
  if (!retryHistory || retryHistory.length === 0) return null;

  return (
    <details className="bg-purple-50 border border-purple-300 rounded-lg p-3">
      <summary className="cursor-pointer text-sm font-semibold text-purple-700 flex items-center justify-between">
        <span className="flex items-center gap-2">
          <History size={14} />
          {language === 'de' ? 'Generierungshistorie' : language === 'fr' ? 'Historique de génération' : 'Generation History'}
        </span>
        <span className="text-purple-600">
          {totalAttempts} {language === 'de' ? 'Versuche' : language === 'fr' ? 'tentatives' : 'attempts'}
        </span>
      </summary>
      <div className="mt-3 space-y-3">
        {retryHistory.map((attempt, idx) => (
          <div key={idx} className={`border rounded-lg p-3 ${
            idx === retryHistory.length - 1
              ? 'bg-green-50 border-green-300'
              : 'bg-white border-gray-200'
          }`}>
            <div className="flex items-center justify-between mb-2">
              <span className="font-semibold text-sm">
                {language === 'de' ? `Versuch ${attempt.attempt}` : language === 'fr' ? `Tentative ${attempt.attempt}` : `Attempt ${attempt.attempt}`}
                {attempt.type === 'text_edit' && (
                  <span className="text-xs ml-2 text-blue-600">(text edit)</span>
                )}
                {attempt.type === 'text_edit_failed' && (
                  <span className="text-xs ml-2 text-red-600">(text edit failed)</span>
                )}
                {idx === retryHistory.length - 1 && (
                  <span className="text-xs ml-2 text-green-600 font-bold">✓ USED</span>
                )}
              </span>
              {attempt.score !== undefined && (
                <span className={`font-bold ${
                  attempt.score >= 70 ? 'text-green-600' :
                  attempt.score >= 50 ? 'text-yellow-600' :
                  'text-red-600'
                }`}>
                  {Math.round(attempt.score)}%
                </span>
              )}
            </div>

            {attempt.error && (
              <div className="text-xs text-red-600 mb-2">Error: {attempt.error}</div>
            )}

            {attempt.textIssue && attempt.textIssue !== 'NONE' && (
              <div className="text-xs text-orange-600 mb-2">
                Text issue: {attempt.textIssue}
                {attempt.expectedText && <span className="block">Expected: "{attempt.expectedText}"</span>}
                {attempt.actualText && <span className="block">Actual: "{attempt.actualText}"</span>}
              </div>
            )}

            {attempt.reasoning ? (
              <details className="text-xs text-gray-600 mb-2">
                <summary className="cursor-pointer">{language === 'de' ? 'Feedback' : 'Feedback'}</summary>
                <p className="mt-1 whitespace-pre-wrap bg-gray-50 p-2 rounded">{attempt.reasoning}</p>
              </details>
            ) : attempt.score === 0 && (
              <div className="text-xs text-gray-500 italic mb-2">
                {language === 'de' ? 'Qualitätsbewertung fehlgeschlagen' : language === 'fr' ? 'Évaluation de qualité échouée' : 'Quality evaluation failed'}
              </div>
            )}

            {attempt.imageData && (
              <details>
                <summary className="cursor-pointer text-xs text-blue-600">
                  {language === 'de' ? 'Bild anzeigen' : language === 'fr' ? 'Voir image' : 'View image'}
                </summary>
                <img
                  src={attempt.imageData}
                  alt={`Attempt ${attempt.attempt}`}
                  className={`mt-2 w-full rounded border ${idx === retryHistory.length - 1 ? 'border-green-300' : 'border-gray-200 opacity-75'}`}
                />
              </details>
            )}

            <div className="text-xs text-gray-400 mt-1">
              {new Date(attempt.timestamp).toLocaleTimeString()}
            </div>
          </div>
        ))}
      </div>
    </details>
  );
}

// Helper component to display reference photos used for image generation
function ReferencePhotosDisplay({
  referencePhotos,
  language
}: {
  referencePhotos: ReferencePhoto[];
  language: string;
}) {
  if (!referencePhotos || referencePhotos.length === 0) return null;

  const getPhotoTypeLabel = (photoType: string) => {
    switch (photoType) {
      case 'bodyNoBg':
      case 'body-no-bg': return language === 'de' ? 'Ganzkörper (freigestellt)' : language === 'fr' ? 'Corps entier (détouré)' : 'Full body (no bg)';
      case 'body': return language === 'de' ? 'Ganzkörper' : language === 'fr' ? 'Corps entier' : 'Full body';
      case 'face': return language === 'de' ? 'Gesicht' : language === 'fr' ? 'Visage' : 'Face only';
      case 'clothing-winter': return language === 'de' ? 'Winter-Avatar' : language === 'fr' ? 'Avatar hiver' : 'Winter avatar';
      case 'clothing-summer': return language === 'de' ? 'Sommer-Avatar' : language === 'fr' ? 'Avatar été' : 'Summer avatar';
      case 'clothing-formal': return language === 'de' ? 'Formell-Avatar' : language === 'fr' ? 'Avatar formel' : 'Formal avatar';
      case 'clothing-standard': return language === 'de' ? 'Standard-Avatar' : language === 'fr' ? 'Avatar standard' : 'Standard avatar';
      case 'none': return language === 'de' ? 'Kein Foto' : language === 'fr' ? 'Pas de photo' : 'No photo';
      default: return photoType;
    }
  };

  const getPhotoTypeColor = (photoType: string) => {
    switch (photoType) {
      case 'bodyNoBg':
      case 'body-no-bg': return 'bg-green-100 text-green-700 border-green-300';
      case 'body': return 'bg-blue-100 text-blue-700 border-blue-300';
      case 'face': return 'bg-yellow-100 text-yellow-700 border-yellow-300';
      case 'clothing-winter': return 'bg-cyan-100 text-cyan-700 border-cyan-300';
      case 'clothing-summer': return 'bg-orange-100 text-orange-700 border-orange-300';
      case 'clothing-formal': return 'bg-purple-100 text-purple-700 border-purple-300';
      case 'clothing-standard': return 'bg-teal-100 text-teal-700 border-teal-300';
      case 'none': return 'bg-red-100 text-red-700 border-red-300';
      default: return 'bg-gray-100 text-gray-700 border-gray-300';
    }
  };

  // Get clothing category from first photo that has it
  const clothingCategory = referencePhotos.find(p => p.clothingCategory)?.clothingCategory;

  const getClothingLabel = (category: string | undefined) => {
    if (!category) return '';
    switch (category) {
      case 'winter': return language === 'de' ? 'Winter' : language === 'fr' ? 'Hiver' : 'Winter';
      case 'summer': return language === 'de' ? 'Sommer' : language === 'fr' ? 'Été' : 'Summer';
      case 'formal': return language === 'de' ? 'Formell' : language === 'fr' ? 'Formel' : 'Formal';
      case 'standard': return language === 'de' ? 'Standard' : 'Standard';
      default: return category;
    }
  };

  return (
    <details className="bg-pink-50 border border-pink-300 rounded-lg p-3">
      <summary className="cursor-pointer text-sm font-semibold text-pink-700 hover:text-pink-900 flex items-center gap-2">
        <span>📸</span>
        {language === 'de' ? 'Referenzfotos' : language === 'fr' ? 'Photos de référence' : 'Reference Photos'}
        <span className="text-xs text-pink-600">({referencePhotos.length})</span>
        {clothingCategory && (
          <span className="ml-2 px-2 py-0.5 bg-pink-200 text-pink-800 text-xs rounded">
            👕 {getClothingLabel(clothingCategory)}
          </span>
        )}
      </summary>
      <div className="mt-3 grid grid-cols-2 sm:grid-cols-3 gap-2">
        {referencePhotos.map((photo, idx) => (
          <div key={idx} className="bg-white rounded-lg p-2 border border-pink-200">
            <div className="flex items-center justify-between mb-2">
              <span className="font-semibold text-xs text-gray-800 truncate">{photo.name}</span>
              <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium border whitespace-nowrap ${getPhotoTypeColor(photo.photoType)}`}>
                {getPhotoTypeLabel(photo.photoType)}
              </span>
            </div>
            {photo.photoUrl && (
              <>
                <img
                  src={photo.photoUrl}
                  alt={`${photo.name} - ${getPhotoTypeLabel(photo.photoType)}`}
                  className="w-full max-h-32 object-contain rounded border border-gray-200 bg-gray-50"
                />
                {photo.photoHash && (
                  <div className="mt-1 text-[9px] font-mono text-gray-500 bg-gray-100 px-1 py-0.5 rounded text-center">
                    🔐 {photo.photoHash}
                  </div>
                )}
              </>
            )}
          </div>
        ))}
      </div>
    </details>
  );
}

interface StoryTextPrompt {
  batch: number;
  startPage: number;
  endPage: number;
  prompt: string;
  modelId?: string;
  usage?: { input_tokens: number; output_tokens: number };
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
  isGenerating?: boolean;
  onDownloadPdf?: () => void;
  onAddToBook?: () => void;
  onPrintBook?: () => void;
  onCreateAnother?: () => void;
  onDownloadTxt?: () => void;
  onRegenerateImage?: (pageNumber: number, editedScene?: string) => Promise<void>;
  onRegenerateCover?: (coverType: 'front' | 'back' | 'initial') => Promise<void>;
  onEditImage?: (pageNumber: number) => void;
  onEditCover?: (coverType: 'front' | 'back' | 'initial') => void;
  onRepairImage?: (pageNumber: number) => Promise<void>;
  onVisualBibleChange?: (visualBible: VisualBible) => void;
  storyId?: string | null;
  developerMode?: boolean;
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
  };
  completedPageImages?: Record<number, string>;
  // Story text editing
  originalStory?: string;
  onSaveStoryText?: (text: string) => Promise<void>;
  // Image regeneration with credits
  userCredits?: number;
  imageRegenerationCost?: number;
  onSelectImageVersion?: (pageNumber: number, versionIndex: number) => Promise<void>;
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
  languageLevel = 'standard',
  isGenerating = false,
  onDownloadPdf,
  onAddToBook,
  onPrintBook,
  onCreateAnother,
  onDownloadTxt,
  onRegenerateImage,
  onRegenerateCover: _onRegenerateCover,
  onEditImage,
  onEditCover: _onEditCover,
  onRepairImage,
  onVisualBibleChange,
  storyId,
  developerMode = false,
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
  // Image regeneration with credits
  userCredits = 0,
  imageRegenerationCost = 5,
  onSelectImageVersion,
}: StoryDisplayProps) {
  const { t, language } = useLanguage();
  const isPictureBook = languageLevel === '1st-grade';

  // Check if user has enough credits (-1 means infinite/unlimited)
  const hasEnoughCredits = userCredits === -1 || userCredits >= imageRegenerationCost;

  // Visual Bible editing state (only used in developer mode)
  const [editingEntry, setEditingEntry] = useState<{ type: string; id: string; field: string } | null>(null);
  const [editValue, setEditValue] = useState('');

  // Story text editing state
  const [isEditMode, setIsEditMode] = useState(false);
  const [editedStory, setEditedStory] = useState(story);
  const [isSaving, setIsSaving] = useState(false);

  // Image history modal state
  const [imageHistoryModal, setImageHistoryModal] = useState<{ pageNumber: number; versions: ImageVersion[] } | null>(null);

  // Scene edit modal state (for editing scene before regenerating)
  const [sceneEditModal, setSceneEditModal] = useState<{ pageNumber: number; scene: string } | null>(null);
  const [isRegenerating, setIsRegenerating] = useState(false);

  // Auto-repair state (dev mode only)
  const [repairingPage, setRepairingPage] = useState<number | null>(null);

  // Update edited story when story prop changes (e.g., after save)
  useEffect(() => {
    if (!isEditMode) {
      setEditedStory(story);
    }
  }, [story, isEditMode]);

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
  const extractImageSummary = (fullDescription: string): string => {
    if (!fullDescription) return '';

    // Try to extract just the Image Summary section
    // Format: "1.  **Image Summary**\n    [summary text]\n\n2.  **Setting"
    const summaryMatch = fullDescription.match(/\*\*Image Summary\*\*\s*\n\s*([\s\S]*?)(?=\n\s*\d+\.\s*\*\*|$)/i);
    if (summaryMatch && summaryMatch[1]) {
      return summaryMatch[1].trim();
    }

    // Fallback: if no Image Summary header, take first paragraph or first 500 chars
    const firstParagraph = fullDescription.split(/\n\n/)[0];
    if (firstParagraph && firstParagraph.length < 1000) {
      return firstParagraph.trim();
    }

    return fullDescription.substring(0, 500).trim() + '...';
  };

  // Open scene edit modal for regeneration
  const openSceneEditModal = (pageNumber: number) => {
    const image = sceneImages.find(img => img.pageNumber === pageNumber);
    const sceneDesc = sceneDescriptions.find(s => s.pageNumber === pageNumber);
    const fullDescription = image?.description || sceneDesc?.description || '';
    // Extract just the summary for editing
    const summary = extractImageSummary(fullDescription);
    setSceneEditModal({ pageNumber, scene: summary });
  };

  // Handle regenerate with edited scene
  const handleRegenerateWithScene = async () => {
    if (!sceneEditModal || !onRegenerateImage) return;
    setIsRegenerating(true);
    try {
      await onRegenerateImage(sceneEditModal.pageNumber, sceneEditModal.scene);
      setSceneEditModal(null);
    } catch (err) {
      console.error('Failed to regenerate image:', err);
    } finally {
      setIsRegenerating(false);
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

  // Progressive mode: Calculate max viewable page
  // User can see page N if page N-1 has an image (or if N is page 1)
  const getMaxViewablePage = (): number => {
    if (!progressiveMode) return storyPages.length;
    if (storyPages.length === 0) return 0;

    // Page 1 is always viewable if we have story text
    let maxPage = 1;

    // Check each subsequent page
    for (let i = 2; i <= storyPages.length; i++) {
      const prevPageNum = i - 1;
      // Check if previous page has an image (from sceneImages or completedPageImages)
      const prevHasImage = sceneImages.some(img => img.pageNumber === prevPageNum && img.imageData) ||
                          !!completedPageImages[prevPageNum];
      if (prevHasImage) {
        maxPage = i;
      } else {
        break;
      }
    }
    return maxPage;
  };

  const maxViewablePage = getMaxViewablePage();
  const totalProgressivePages = progressiveData?.totalPages || storyPages.length;

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
      <h1 className="text-3xl md:text-4xl font-bold text-gray-800 text-center">
        {title || t.yourStory}
      </h1>

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

      {/* Action Buttons Grid - Order: Add to Book, PDF, Edit, Create Another */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
        {/* Add to Book */}
        {hasImages && storyId && onAddToBook && (
          <button
            onClick={onAddToBook}
            disabled={isGenerating}
            className={`bg-indigo-500 text-white px-3 py-2 rounded-lg text-sm font-semibold flex items-center justify-center gap-1.5 ${
              isGenerating ? 'opacity-50 cursor-not-allowed' : 'hover:bg-indigo-600'
            }`}
          >
            <ShoppingCart size={16} /> {language === 'de' ? 'Zum Buch hinzufügen' : language === 'fr' ? 'Ajouter au livre' : 'Add to Book'}
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

      {/* Developer Mode: Story Overview and Full Text */}
      {developerMode && (
        <div className="space-y-4 mt-6">
          {/* Story Outline/Overview */}
          {outline && (
            <details className="bg-purple-50 border-2 border-purple-200 rounded-xl p-4">
              <summary className="cursor-pointer text-lg font-bold text-purple-800 hover:text-purple-900 flex items-center gap-2">
                <FileText size={20} />
                {language === 'de' ? 'Story-Übersicht (Outline)' : language === 'fr' ? 'Aperçu de l\'histoire' : 'Story Overview (Outline)'}
              </summary>
              <pre className="mt-4 text-sm text-gray-700 whitespace-pre-wrap font-mono bg-white p-4 rounded-lg border border-purple-200 overflow-x-auto max-h-96 overflow-y-auto">
                {outline}
              </pre>
            </details>
          )}

          {/* Full API Output */}
          {story && (
            <details className="bg-amber-50 border-2 border-amber-200 rounded-xl p-4">
              <summary className="cursor-pointer text-lg font-bold text-amber-800 hover:text-amber-900 flex items-center gap-2">
                <BookOpen size={20} />
                {language === 'de' ? 'Vollständige API-Ausgabe' : language === 'fr' ? 'Sortie API complète' : 'Full API Output'}
              </summary>
              <pre className="mt-4 text-sm text-gray-700 whitespace-pre-wrap font-mono bg-white p-4 rounded-lg border border-amber-200 overflow-x-auto max-h-[600px] overflow-y-auto">
                {JSON.stringify({
                  title,
                  story,
                  outline,
                  sceneDescriptions,
                  sceneImages: sceneImages.map(img => ({
                    pageNumber: img.pageNumber,
                    description: img.description,
                    prompt: img.prompt,
                    qualityScore: img.qualityScore,
                    qualityReasoning: img.qualityReasoning,
                    wasRegenerated: img.wasRegenerated,
                    totalAttempts: img.totalAttempts,
                    hasImage: !!img.imageData
                  })),
                  coverImages: coverImages ? {
                    frontCover: coverImages.frontCover ? { hasImage: true, ...(typeof coverImages.frontCover === 'object' ? { description: coverImages.frontCover.description, storyTitle: coverImages.frontCover.storyTitle } : {}) } : null,
                    initialPage: coverImages.initialPage ? { hasImage: true, ...(typeof coverImages.initialPage === 'object' ? { description: coverImages.initialPage.description } : {}) } : null,
                    backCover: coverImages.backCover ? { hasImage: true, ...(typeof coverImages.backCover === 'object' ? { description: coverImages.backCover.description } : {}) } : null
                  } : null,
                  visualBible,
                  languageLevel,
                  isPartial,
                  failureReason,
                  generatedPages,
                  totalPages
                }, null, 2)}
              </pre>
            </details>
          )}

          {/* Outline API Prompt */}
          {outlinePrompt && (
            <details className="bg-cyan-50 border-2 border-cyan-200 rounded-xl p-4">
              <summary className="cursor-pointer text-lg font-bold text-cyan-800 hover:text-cyan-900 flex items-center gap-2">
                <FileText size={20} />
                {language === 'de' ? 'API-Prompt: Outline' : language === 'fr' ? 'Prompt API: Plan' : 'API Prompt: Outline'}
                {outlineModelId && <span className="ml-2 text-sm font-normal text-cyan-600">({outlineModelId})</span>}
                {outlineUsage && (
                  <span className="ml-2 text-xs font-normal text-cyan-500">
                    [{outlineUsage.input_tokens.toLocaleString()} in / {outlineUsage.output_tokens.toLocaleString()} out]
                  </span>
                )}
              </summary>
              <pre className="mt-4 text-sm text-gray-700 whitespace-pre-wrap font-mono bg-white p-4 rounded-lg border border-cyan-200 overflow-x-auto max-h-96 overflow-y-auto">
                {outlinePrompt}
              </pre>
            </details>
          )}

          {/* Story Text API Prompts */}
          {storyTextPrompts.length > 0 && (
            <details className="bg-teal-50 border-2 border-teal-200 rounded-xl p-4">
              <summary className="cursor-pointer text-lg font-bold text-teal-800 hover:text-teal-900 flex items-center gap-2">
                <FileText size={20} />
                {language === 'de' ? `API-Prompts: Story-Text (${storyTextPrompts.length} Batches)` : language === 'fr' ? `Prompts API: Texte (${storyTextPrompts.length} lots)` : `API Prompts: Story Text (${storyTextPrompts.length} batches)`}
              </summary>
              <div className="mt-4 space-y-4">
                {storyTextPrompts.map((batch) => (
                  <details key={batch.batch} className="bg-white border border-teal-200 rounded-lg p-3">
                    <summary className="cursor-pointer text-sm font-semibold text-teal-700 flex items-center gap-2 flex-wrap">
                      <span>
                        {language === 'de' ? `Batch ${batch.batch}: Seiten ${batch.startPage}-${batch.endPage}` : language === 'fr' ? `Lot ${batch.batch}: Pages ${batch.startPage}-${batch.endPage}` : `Batch ${batch.batch}: Pages ${batch.startPage}-${batch.endPage}`}
                      </span>
                      {batch.modelId && <span className="text-xs font-normal text-teal-500">({batch.modelId})</span>}
                      {batch.usage && (
                        <span className="text-xs font-normal text-teal-400">
                          [{batch.usage.input_tokens.toLocaleString()} in / {batch.usage.output_tokens.toLocaleString()} out]
                        </span>
                      )}
                    </summary>
                    <pre className="mt-2 text-xs text-gray-700 whitespace-pre-wrap font-mono bg-gray-50 p-3 rounded border overflow-x-auto max-h-64 overflow-y-auto">
                      {batch.prompt}
                    </pre>
                  </details>
                ))}
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
                          <div className="font-semibold text-rose-800">{entry.name} <span className="text-xs text-rose-600">(Pages: {entry.appearsInPages.join(', ')})</span></div>
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
                          <div className="font-semibold text-rose-800">{entry.name} <span className="text-xs text-rose-600">(Pages: {entry.appearsInPages.join(', ')})</span></div>
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
                          <div className="font-semibold text-rose-800">{entry.name} <span className="text-xs text-rose-600">(Pages: {entry.appearsInPages.join(', ')})</span></div>
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
                          <div className="font-semibold text-rose-800">{entry.name} <span className="text-xs text-rose-600">(Pages: {entry.appearsInPages.join(', ')})</span></div>
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
                              {language === 'de' ? 'Seite' : language === 'fr' ? 'Page' : 'Page'} {entry.page}
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
                 (!visualBible.locations || visualBible.locations.length === 0) && (
                  <div className="text-gray-500 text-sm italic">
                    {language === 'de' ? 'Keine wiederkehrenden Elemente gefunden' : language === 'fr' ? 'Aucun élément récurrent trouvé' : 'No recurring elements found in this story'}
                  </div>
                )}
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
                      {language === 'de' ? `Seite ${scene.pageNumber}` : language === 'fr' ? `Page ${scene.pageNumber}` : `Page ${scene.pageNumber}`}
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
              {language === 'de' ? 'Titelseite' : language === 'fr' ? 'Couverture' : 'Front Cover'}
            </p>
            <img
              src={getCoverImageData(coverImages.frontCover)!}
              alt="Front Cover"
              className="w-full rounded-lg shadow-lg"
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
                  {language === 'de' ? 'Neu generieren' : language === 'fr' ? 'Régénérer' : 'Regenerate'}
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
                {frontCoverObj.referencePhotos && frontCoverObj.referencePhotos.length > 0 && (
                  <ReferencePhotosDisplay
                    referencePhotos={frontCoverObj.referencePhotos}
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
              {language === 'de' ? 'Widmungsseite' : language === 'fr' ? 'Page de dédicace' : 'Dedication Page'}
            </p>
            <img
              src={getCoverImageData(coverImages.initialPage)!}
              alt="Dedication Page"
              className="w-full rounded-lg shadow-lg"
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
                  {language === 'de' ? 'Neu generieren' : language === 'fr' ? 'Régénérer' : 'Regenerate'}
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
                {initialPageObj.referencePhotos && initialPageObj.referencePhotos.length > 0 && (
                  <ReferencePhotosDisplay
                    referencePhotos={initialPageObj.referencePhotos}
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
              {language === 'de'
                ? 'Geschichte wird erstellt...'
                : language === 'fr'
                ? 'Création de l\'histoire...'
                : 'Creating your story...'}
            </h3>
            <p className="text-indigo-500 mt-2">
              {language === 'de'
                ? 'Die Seiten werden gleich angezeigt'
                : language === 'fr'
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
            {title || (language === 'de' ? 'Ihre Geschichte' : language === 'fr' ? 'Votre histoire' : 'Your Story')}
          </h3>

          {storyPages.slice(0, progressiveMode ? maxViewablePage : storyPages.length).map((pageText, index) => {
            const pageNumber = index + 1;
            const image = sceneImages.find(img => img.pageNumber === pageNumber);
            // In progressive mode, also check completedPageImages for the image
            const progressiveImageData = progressiveMode ? completedPageImages[pageNumber] : undefined;
            const hasPageImage = !!(image?.imageData || progressiveImageData);
            const isWaitingForImage = progressiveMode && pageNumber === maxViewablePage && !hasPageImage;

            return (
              <div key={pageNumber} className="p-4 md:p-6">
                <h4 className="text-xl font-bold text-gray-800 mb-4 text-center">
                  {language === 'de' ? `Seite ${pageNumber}` : language === 'fr' ? `Page ${pageNumber}` : `Page ${pageNumber}`}
                </h4>

                {/* Picture Book Layout: Image on top, text below */}
                {isPictureBook ? (
                  <div className="flex flex-col items-center max-w-2xl mx-auto">
                    {/* Image on top - show placeholder if waiting for image */}
                    {isWaitingForImage ? (
                      <div className="w-full mb-4 aspect-[4/3] bg-gradient-to-br from-indigo-100 to-purple-100 rounded-lg shadow-md flex flex-col items-center justify-center">
                        <div className="animate-spin rounded-full h-12 w-12 border-4 border-indigo-300 border-t-indigo-600 mb-4"></div>
                        <p className="text-indigo-600 font-medium">
                          {language === 'de' ? 'Bild wird erstellt...' : language === 'fr' ? 'Création de l\'image...' : 'Creating image...'}
                        </p>
                        <p className="text-indigo-400 text-sm mt-1">
                          {language === 'de' ? 'Die nächste Seite erscheint bald' : language === 'fr' ? 'La page suivante arrive bientôt' : 'Next page coming soon'}
                        </p>
                      </div>
                    ) : (image?.imageData || progressiveImageData) ? (
                      <div className="w-full mb-4">
                        <img
                          src={image?.imageData || progressiveImageData}
                          alt={`Scene for page ${pageNumber}`}
                          className="w-full rounded-lg shadow-md object-cover"
                        />
                        {/* Image action buttons - shown to all users */}
                        {onRegenerateImage && (
                          <div className="mt-3 space-y-2">
                            {/* Regenerate and Version buttons */}
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
                                {language === 'de' ? 'Neu generieren' : language === 'fr' ? 'Régénérer' : 'Regenerate'}
                                <span className="text-xs opacity-80">
                                  ({imageRegenerationCost} {language === 'de' ? 'Credits' : 'credits'})
                                </span>
                              </button>
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
                                            <div className="flex gap-2">
                                              <div>
                                                <strong className="block mb-1 text-xs">{language === 'de' ? 'Vorher:' : 'Before:'}</strong>
                                                <img src={repair.beforeImage} alt="Before repair" className="w-24 h-24 object-cover border rounded" />
                                              </div>
                                              <div>
                                                <strong className="block mb-1 text-xs">{language === 'de' ? 'Nachher:' : 'After:'}</strong>
                                                <img src={repair.afterImage} alt="After repair" className="w-24 h-24 object-cover border rounded" />
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
                            {image?.referencePhotos && image.referencePhotos.length > 0 && (
                              <ReferencePhotosDisplay
                                referencePhotos={image.referencePhotos}
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
                      <div className="w-full flex items-center justify-center bg-gray-100 rounded-lg p-8 mb-4">
                        <p className="text-gray-500 text-center">
                          {language === 'de' ? 'Kein Bild für diese Seite' : language === 'fr' ? 'Pas d\'image pour cette page' : 'No image for this page'}
                        </p>
                      </div>
                    )}

                    {/* Text below */}
                    <div className="w-full bg-indigo-50 rounded-lg p-6 border-2 border-indigo-200">
                      {isEditMode ? (
                        <textarea
                          value={pageText.trim()}
                          onChange={(e) => handlePageTextChange(index, e.target.value)}
                          className="w-full min-h-[150px] p-3 text-gray-800 leading-snug font-serif text-xl text-center bg-white border-2 border-amber-300 rounded-lg focus:border-amber-500 focus:ring-2 focus:ring-amber-200 outline-none resize-y"
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
                  <div className="grid md:grid-cols-2 gap-6">
                    {/* Image on the left */}
                    {image && image.imageData ? (
                      <div className="flex flex-col">
                        <img
                          src={image.imageData}
                          alt={`Scene for page ${pageNumber}`}
                          className="w-full rounded-lg shadow-md object-cover"
                        />
                        {/* Image action buttons - shown to all users */}
                        {onRegenerateImage && (
                          <div className="mt-3 space-y-2">
                            {/* Regenerate and Version buttons */}
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
                                {language === 'de' ? 'Neu generieren' : language === 'fr' ? 'Régénérer' : 'Regenerate'}
                                <span className="text-xs opacity-80">
                                  ({imageRegenerationCost} {language === 'de' ? 'Credits' : 'credits'})
                                </span>
                              </button>
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
                                            <div className="flex gap-2">
                                              <div>
                                                <strong className="block mb-1 text-xs">{language === 'de' ? 'Vorher:' : 'Before:'}</strong>
                                                <img src={repair.beforeImage} alt="Before repair" className="w-24 h-24 object-cover border rounded" />
                                              </div>
                                              <div>
                                                <strong className="block mb-1 text-xs">{language === 'de' ? 'Nachher:' : 'After:'}</strong>
                                                <img src={repair.afterImage} alt="After repair" className="w-24 h-24 object-cover border rounded" />
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
                            {image.referencePhotos && image.referencePhotos.length > 0 && (
                              <ReferencePhotosDisplay
                                referencePhotos={image.referencePhotos}
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
                      <div className="flex items-center justify-center bg-gray-100 rounded-lg p-8">
                        <p className="text-gray-500 text-center">
                          {language === 'de' ? 'Kein Bild für diese Seite' : language === 'fr' ? 'Pas d\'image pour cette page' : 'No image for this page'}
                        </p>
                      </div>
                    )}

                    {/* Text on the right */}
                    <div className="flex items-start w-full">
                      {isEditMode ? (
                        <textarea
                          value={pageText.trim()}
                          onChange={(e) => handlePageTextChange(index, e.target.value)}
                          className="w-full min-h-[200px] p-4 text-gray-800 leading-snug font-serif text-xl bg-white border-2 border-amber-300 rounded-lg focus:border-amber-500 focus:ring-2 focus:ring-amber-200 outline-none resize-y"
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

          {/* Progressive mode: Show loading indicator for remaining pages */}
          {progressiveMode && maxViewablePage < totalProgressivePages && (
            <div className="p-6 text-center">
              <div className="inline-flex flex-col items-center bg-gradient-to-r from-indigo-50 to-purple-50 rounded-xl p-6 shadow-sm">
                <div className="animate-spin rounded-full h-10 w-10 border-4 border-indigo-300 border-t-indigo-600 mb-3"></div>
                <p className="text-indigo-700 font-semibold">
                  {language === 'de'
                    ? `Seite ${maxViewablePage} von ${totalProgressivePages}`
                    : language === 'fr'
                    ? `Page ${maxViewablePage} sur ${totalProgressivePages}`
                    : `Page ${maxViewablePage} of ${totalProgressivePages}`}
                </p>
                <p className="text-indigo-500 text-sm mt-1">
                  {language === 'de'
                    ? 'Weitere Seiten werden geladen...'
                    : language === 'fr'
                    ? 'Chargement des pages suivantes...'
                    : 'Loading more pages...'}
                </p>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Placeholder for remaining pages during generation */}
      {isGenerating && story && (
        <div className="mt-8 max-w-2xl mx-auto">
          <div className="bg-gradient-to-r from-indigo-50 to-purple-50 border-2 border-indigo-200 border-dashed rounded-xl p-8">
            <div className="flex flex-col items-center text-center">
              <div className="animate-spin rounded-full h-10 w-10 border-4 border-indigo-300 border-t-indigo-600 mb-4"></div>
              <p className="text-indigo-700 font-semibold">
                {language === 'de'
                  ? 'Weitere Seiten werden erstellt...'
                  : language === 'fr'
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
              {language === 'de' ? 'Rückseite' : language === 'fr' ? 'Quatrième de couverture' : 'Back Cover'}
            </p>
            <img
              src={getCoverImageData(coverImages.backCover)!}
              alt="Back Cover"
              className="w-full rounded-lg shadow-lg"
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
                  {language === 'de' ? 'Neu generieren' : language === 'fr' ? 'Régénérer' : 'Regenerate'}
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
                {backCoverObj.referencePhotos && backCoverObj.referencePhotos.length > 0 && (
                  <ReferencePhotosDisplay
                    referencePhotos={backCoverObj.referencePhotos}
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
            {/* Add to Book */}
            {storyId && onAddToBook && (
              <button
                onClick={onAddToBook}
                disabled={isGenerating}
                className={`bg-indigo-500 text-white px-3 py-2 rounded-lg text-sm font-semibold flex items-center justify-center gap-1.5 ${
                  isGenerating ? 'opacity-50 cursor-not-allowed' : 'hover:bg-indigo-600'
                }`}
              >
                <ShoppingCart size={16} /> {language === 'de' ? 'Zum Buch hinzufügen' : language === 'fr' ? 'Ajouter au livre' : 'Add to Book'}
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
        <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-300 shadow-lg p-4 z-50">
          <div className="max-w-4xl mx-auto flex items-center justify-between gap-4">
            <div className="flex items-center gap-2 text-amber-600">
              <Edit3 size={20} />
              <span className="font-semibold">
                {language === 'de' ? 'Bearbeitungsmodus' : language === 'fr' ? 'Mode édition' : 'Edit Mode'}
              </span>
              {originalStory && (
                <span className="text-xs text-gray-500 ml-2">
                  ({language === 'de' ? 'Original gespeichert' : language === 'fr' ? 'Original sauvegardé' : 'Original saved'})
                </span>
              )}
            </div>
            <div className="flex gap-2">
              <button
                onClick={handleCancelEdit}
                disabled={isSaving}
                className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 text-sm font-semibold flex items-center gap-1.5"
              >
                <X size={16} />
                {language === 'de' ? 'Abbrechen' : language === 'fr' ? 'Annuler' : 'Cancel'}
              </button>
              {originalStory && editedStory !== originalStory && (
                <button
                  onClick={() => setEditedStory(originalStory)}
                  disabled={isSaving}
                  className="px-4 py-2 border border-amber-400 text-amber-700 rounded-lg hover:bg-amber-50 text-sm font-semibold flex items-center gap-1.5"
                >
                  <RotateCcw size={16} />
                  {language === 'de' ? 'Zurücksetzen' : language === 'fr' ? 'Restaurer' : 'Restore'}
                </button>
              )}
              <button
                onClick={handleSaveStory}
                disabled={isSaving}
                className={`px-4 py-2 bg-green-500 text-white rounded-lg text-sm font-semibold flex items-center gap-1.5 ${
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
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl max-w-2xl w-full shadow-2xl">
            <div className="p-4 border-b border-gray-200">
              <h3 className="text-lg font-bold text-gray-800 flex items-center gap-2">
                <Edit3 size={20} />
                {language === 'de' ? `Szene bearbeiten - Seite ${sceneEditModal.pageNumber}` :
                 language === 'fr' ? `Modifier la scène - Page ${sceneEditModal.pageNumber}` :
                 `Edit Scene - Page ${sceneEditModal.pageNumber}`}
              </h3>
              <p className="text-sm text-gray-500 mt-1">
                {language === 'de' ? 'Bearbeiten Sie die Szenenbeschreibung und generieren Sie das Bild neu.' :
                 language === 'fr' ? 'Modifiez la description de la scène et régénérez l\'image.' :
                 'Edit the scene description and regenerate the image.'}
              </p>
            </div>
            <div className="p-4">
              <label className="block text-sm font-medium text-gray-700 mb-2">
                {language === 'de' ? 'Szenenbeschreibung:' :
                 language === 'fr' ? 'Description de la scène:' :
                 'Scene description:'}
              </label>
              <textarea
                value={sceneEditModal.scene}
                onChange={(e) => setSceneEditModal({ ...sceneEditModal, scene: e.target.value })}
                className="w-full h-40 p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 resize-y"
                placeholder={language === 'de' ? 'Beschreiben Sie die Szene...' :
                            language === 'fr' ? 'Décrivez la scène...' :
                            'Describe the scene...'}
              />
              <p className="text-xs text-gray-400 mt-2">
                {language === 'de' ? 'Tipp: Beschreiben Sie die Charaktere, ihre Aktionen und die Umgebung.' :
                 language === 'fr' ? 'Conseil: Décrivez les personnages, leurs actions et l\'environnement.' :
                 'Tip: Describe the characters, their actions, and the environment.'}
              </p>
            </div>
            <div className="p-4 border-t border-gray-200 flex justify-end gap-3">
              <button
                onClick={() => setSceneEditModal(null)}
                disabled={isRegenerating}
                className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 text-gray-700 font-medium disabled:opacity-50"
              >
                {language === 'de' ? 'Abbrechen' : language === 'fr' ? 'Annuler' : 'Cancel'}
              </button>
              <button
                onClick={handleRegenerateWithScene}
                disabled={isRegenerating || !sceneEditModal.scene.trim()}
                className={`px-4 py-2 bg-indigo-600 text-white rounded-lg font-medium flex items-center gap-2 ${
                  isRegenerating || !sceneEditModal.scene.trim() ? 'opacity-50 cursor-not-allowed' : 'hover:bg-indigo-700'
                }`}
              >
                {isRegenerating ? (
                  <>
                    <RefreshCw size={16} className="animate-spin" />
                    {language === 'de' ? 'Generiere...' : language === 'fr' ? 'Génération...' : 'Generating...'}
                  </>
                ) : (
                  <>
                    <RefreshCw size={16} />
                    {language === 'de' ? 'Neu generieren' : language === 'fr' ? 'Régénérer' : 'Regenerate'}
                    <span className="text-xs opacity-80">({imageRegenerationCost} credits)</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Image History Modal */}
      {imageHistoryModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl max-w-3xl w-full max-h-[80vh] overflow-hidden shadow-2xl">
            <div className="p-4 border-b border-gray-200 flex items-center justify-between">
              <h3 className="text-lg font-bold text-gray-800 flex items-center gap-2">
                <Images size={20} />
                {language === 'de' ? `Bildversionen - Seite ${imageHistoryModal.pageNumber}` :
                 language === 'fr' ? `Versions d'image - Page ${imageHistoryModal.pageNumber}` :
                 `Image Versions - Page ${imageHistoryModal.pageNumber}`}
              </h3>
              <button
                onClick={() => setImageHistoryModal(null)}
                className="p-1 hover:bg-gray-100 rounded"
              >
                <X size={20} />
              </button>
            </div>
            <div className="p-4 overflow-y-auto max-h-[60vh]">
              <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                {imageHistoryModal.versions.map((version, idx) => (
                  <div
                    key={idx}
                    className={`relative cursor-pointer rounded-lg overflow-hidden border-2 transition-all ${
                      version.isActive
                        ? 'border-green-500 ring-2 ring-green-200'
                        : 'border-gray-200 hover:border-indigo-300'
                    }`}
                    onClick={() => handleSelectVersion(imageHistoryModal.pageNumber, idx)}
                  >
                    <img
                      src={version.imageData}
                      alt={`Version ${idx + 1}`}
                      className="w-full aspect-square object-cover"
                    />
                    <div className="absolute bottom-0 left-0 right-0 bg-black bg-opacity-60 text-white text-xs p-2">
                      <div className="flex items-center justify-between">
                        <span>
                          {idx === 0
                            ? (language === 'de' ? 'Original' : language === 'fr' ? 'Original' : 'Original')
                            : `V${idx + 1}`
                          }
                        </span>
                        {version.isActive && (
                          <span className="bg-green-500 px-2 py-0.5 rounded text-[10px] font-bold">
                            {language === 'de' ? 'Aktiv' : language === 'fr' ? 'Actif' : 'Active'}
                          </span>
                        )}
                      </div>
                      <div className="text-[10px] text-gray-300 mt-1">
                        {new Date(version.createdAt).toLocaleDateString()}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
              {/* Dev mode: Show scene and prompt comparison */}
              {developerMode && imageHistoryModal.versions.length > 1 && (
                <div className="mt-4 space-y-3">
                  <h4 className="font-semibold text-gray-700">
                    {language === 'de' ? 'Szenen- und Prompt-Vergleich' : language === 'fr' ? 'Comparaison de scènes et prompts' : 'Scene & Prompt Comparison'}
                  </h4>
                  {imageHistoryModal.versions.map((version, idx) => (
                    <details key={idx} className={`rounded-lg p-3 ${version.isActive ? 'bg-green-50 border border-green-200' : 'bg-gray-50 border border-gray-200'}`}>
                      <summary className="cursor-pointer text-sm font-medium text-gray-700">
                        {idx === 0 ? 'Original' : `V${idx + 1}`}
                        {version.isActive && <span className="ml-2 text-green-600 text-xs">(Active)</span>}
                      </summary>
                      <div className="mt-2 space-y-2">
                        {version.description && (
                          <div>
                            <div className="text-xs font-semibold text-amber-700">
                              {language === 'de' ? 'Szene:' : language === 'fr' ? 'Scène:' : 'Scene:'}
                            </div>
                            <pre className="text-xs text-gray-600 whitespace-pre-wrap bg-white p-2 rounded border border-gray-200 max-h-24 overflow-y-auto">
                              {version.description}
                            </pre>
                          </div>
                        )}
                        {version.prompt && (
                          <div>
                            <div className="text-xs font-semibold text-blue-700">
                              {language === 'de' ? 'API-Prompt:' : language === 'fr' ? 'Prompt API:' : 'API Prompt:'}
                            </div>
                            <pre className="text-xs text-gray-600 whitespace-pre-wrap bg-white p-2 rounded border border-gray-200 max-h-32 overflow-y-auto">
                              {version.prompt}
                            </pre>
                          </div>
                        )}
                        {version.modelId && (
                          <div className="text-xs text-gray-500">Model: {version.modelId}</div>
                        )}
                      </div>
                    </details>
                  ))}
                </div>
              )}
            </div>
            <div className="p-4 border-t border-gray-200 text-sm text-gray-500">
              {language === 'de' ? 'Klicken Sie auf ein Bild, um es auszuwählen' :
               language === 'fr' ? 'Cliquez sur une image pour la sélectionner' :
               'Click an image to select it'}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default StoryDisplay;
