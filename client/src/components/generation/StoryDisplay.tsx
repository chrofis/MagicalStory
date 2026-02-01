import { useState, useEffect } from 'react';
import { BookOpen, FileText, ShoppingCart, Plus, Download, RefreshCw, Edit3, Save, X, Images, RotateCcw, Wrench, Loader, Loader2, ChevronDown, Users } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import { DiagnosticImage } from '@/components/common';
import type { SceneImage, SceneDescription, CoverImages, CoverImageData, ImageVersion, RepairAttempt, StoryLanguageCode, GenerationLogEntry, FinalChecksReport } from '@/types/story';
import type { LanguageLevel } from '@/types/story';
import type { VisualBible } from '@/types/character';
import { RetryHistoryDisplay, ObjectDetectionDisplay, ReferencePhotosDisplay, SceneEditModal, ImageHistoryModal, EnlargedImageModal, RepairComparisonModal, GenerationSettingsPanel } from './story';
import type { GenerationSettings } from './story';
import { ShareButton } from '@/components/story/ShareButton';
import storyService from '@/services/storyService';

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
  clothingCategory?: string;
  durationMs: number;
  success: boolean;
  error?: string;
  inputs: {
    facePhoto: { identifier: string; sizeKB: number; imageData?: string } | null;
    originalAvatar: { identifier: string; sizeKB: number; imageData?: string };
    styleSample?: { identifier: string; sizeKB: number; imageData?: string } | null;
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

// Clothing requirements per character (from story outline)
interface ClothingVariant {
  used: boolean;
  signature?: string;
  costume?: string;
  description?: string;
}

interface CharacterClothingRequirements {
  standard?: ClothingVariant;
  winter?: ClothingVariant;
  summer?: ClothingVariant;
  costumed?: ClothingVariant;
}

type ClothingRequirements = Record<string, CharacterClothingRequirements>;

interface StoryDisplayProps {
  title: string;
  dedication?: string;
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
  regeneratingCovers?: Set<string>;  // Track which covers are being regenerated
  languageLevel?: LanguageLevel;
  storyLanguage?: StoryLanguageCode;  // Language of the story content (for correct labels)
  isGenerating?: boolean;
  onDownloadPdf?: (bookFormat: 'square' | 'A4') => void;
  onAddToBook?: () => void;
  onPrintBook?: () => void;
  onCreateAnother?: () => void;
  onDownloadTxt?: () => void;
  onRegenerateImage?: (pageNumber: number, editedScene?: string, characterIds?: number[]) => Promise<void>;
  onRegenerateCover?: (coverType: 'front' | 'back' | 'initial', editedScene?: string, characterIds?: number[], editedTitle?: string, editedDedication?: string) => Promise<void>;
  // Characters for scene edit modal
  characters?: Array<{ id: number; name: string; photoData?: string }>;
  onEditImage?: (pageNumber: number) => void;
  onEditCover?: (coverType: 'front' | 'back' | 'initial') => void;
  onRepairImage?: (pageNumber: number) => Promise<void>;
  onIteratePage?: (pageNumber: number) => Promise<void>;
  onRevertRepair?: (pageNumber: number, beforeImage: string) => Promise<void>;
  onVisualBibleChange?: (visualBible: VisualBible) => void;
  storyId?: string | null;
  developerMode?: boolean;
  styledAvatarGeneration?: StyledAvatarGenerationEntry[];
  costumedAvatarGeneration?: CostumedAvatarGenerationEntry[];
  generationLog?: GenerationLogEntry[];
  finalChecksReport?: FinalChecksReport | null;
  clothingRequirements?: ClothingRequirements;
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
  // Callback to refresh story data (after entity repair, etc.)
  onRefreshStory?: () => Promise<void>;
}

export function StoryDisplay({
  title,
  dedication,
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
  regeneratingCovers = new Set(),  // Track which covers are being regenerated
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
  onIteratePage,
  onRevertRepair,
  onVisualBibleChange,
  storyId,
  developerMode = false,
  styledAvatarGeneration = [],
  costumedAvatarGeneration = [],
  generationLog = [],
  finalChecksReport,
  clothingRequirements,
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
  onRefreshStory,
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
  const [, setIsRegenerating] = useState(false); // Only setter used - tracks global regen state
  const [regeneratingPages, setRegeneratingPages] = useState<Set<number>>(new Set()); // Track which pages are regenerating (supports parallel)

  // Cover edit modal state (for editing cover scene before regenerating)
  const [coverEditModal, setCoverEditModal] = useState<{ coverType: 'front' | 'back' | 'initial'; scene: string; selectedCharacterIds: number[]; title?: string; dedication?: string } | null>(null);

  // Auto-repair state (dev mode only)
  const [repairingPage, setRepairingPage] = useState<number | null>(null);
  const [repairingEntity, setRepairingEntity] = useState<string | null>(null);
  const [repairingIssuePage, setRepairingIssuePage] = useState<number | null>(null);
  const [repairingSingleEntityPage, setRepairingSingleEntityPage] = useState<{ entity: string; page: number } | null>(null);

  // Iterative improvement state (dev mode only)
  const [iteratingPage, setIteratingPage] = useState<number | null>(null);

  // Enlarged image modal for single image viewing
  const [enlargedImage, setEnlargedImage] = useState<{ src: string; title: string } | null>(null);

  // Repair comparison modal for before/after/diff viewing
  const [repairComparison, setRepairComparison] = useState<{
    beforeImage: string;
    afterImage: string;
    diffImage?: string;
    title: string;
  } | null>(null);

  // PDF format selection dropdown
  const [pdfFormat, setPdfFormat] = useState<'square' | 'A4'>('square');
  const [showPdfFormatDropdown, setShowPdfFormatDropdown] = useState(false);

  // Visual Bible reference images (lazy-loaded)
  const [loadedRefImages, setLoadedRefImages] = useState<Record<string, string>>({});
  const [loadingRefImages, setLoadingRefImages] = useState<Set<string>>(new Set());

  // Fetch a Visual Bible reference image on demand
  const fetchReferenceImage = async (elementId: string) => {
    if (!storyId || loadedRefImages[elementId] || loadingRefImages.has(elementId)) return;

    setLoadingRefImages(prev => new Set(prev).add(elementId));
    try {
      const token = localStorage.getItem('auth_token');
      const response = await fetch(`/api/stories/${storyId}/visual-bible-image/${elementId}`, {
        headers: token ? { 'Authorization': `Bearer ${token}` } : {}
      });
      if (response.ok) {
        const data = await response.json();
        setLoadedRefImages(prev => ({ ...prev, [elementId]: data.imageData }));
      }
    } catch (err) {
      console.error(`Failed to load reference image for ${elementId}:`, err);
    } finally {
      setLoadingRefImages(prev => {
        const next = new Set(prev);
        next.delete(elementId);
        return next;
      });
    }
  };

  // Render reference image thumbnail for a Visual Bible element
  const renderRefImageThumbnail = (elementId: string, hasReferenceImage?: boolean) => {
    if (!hasReferenceImage || !developerMode) return null;

    const imageData = loadedRefImages[elementId];
    const isLoading = loadingRefImages.has(elementId);

    if (imageData) {
      return (
        <img
          src={imageData}
          alt="Reference"
          className="w-16 h-16 object-cover rounded border border-rose-300 cursor-pointer hover:opacity-80"
          onClick={() => setEnlargedImage({ src: imageData, title: 'Reference Image' })}
        />
      );
    }

    return (
      <button
        onClick={() => fetchReferenceImage(elementId)}
        disabled={isLoading}
        className="w-16 h-16 flex items-center justify-center bg-rose-100 border border-rose-300 rounded text-rose-500 hover:bg-rose-200 disabled:opacity-50"
        title="Load reference image"
      >
        {isLoading ? <Loader2 size={16} className="animate-spin" /> : <Images size={16} />}
      </button>
    );
  };

  // Avatar generation images (lazy-loaded)
  // Key format: "styled-0" or "costumed-2"
  const [loadedAvatarGenImages, setLoadedAvatarGenImages] = useState<Record<string, {
    facePhoto?: string | null;
    originalAvatar?: string | null;
    styleSample?: string | null;
    standardAvatar?: string | null;
    output?: string | null;
  }>>({});
  const [loadingAvatarGenImages, setLoadingAvatarGenImages] = useState<Set<string>>(new Set());

  // Fetch avatar generation images on demand
  const fetchAvatarGenImages = async (type: 'styled' | 'costumed', index: number) => {
    const key = `${type}-${index}`;
    if (!storyId || loadedAvatarGenImages[key] || loadingAvatarGenImages.has(key)) return;

    setLoadingAvatarGenImages(prev => new Set(prev).add(key));
    try {
      const data = await storyService.getAvatarGenerationImage(storyId, type, index);
      if (data) {
        setLoadedAvatarGenImages(prev => ({ ...prev, [key]: data }));
      }
    } catch (err) {
      console.error(`Failed to load avatar generation images for ${key}:`, err);
    } finally {
      setLoadingAvatarGenImages(prev => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  };

  // Entity grid images (lazy-loaded)
  const [loadedEntityGridImages, setLoadedEntityGridImages] = useState<Record<string, string>>({});
  const [loadingEntityGridImages, setLoadingEntityGridImages] = useState<Set<string>>(new Set());

  // Fetch entity grid image on demand
  const fetchEntityGridImage = async (entityName: string) => {
    if (!storyId || loadedEntityGridImages[entityName] || loadingEntityGridImages.has(entityName)) return;

    setLoadingEntityGridImages(prev => new Set(prev).add(entityName));
    try {
      const data = await storyService.getEntityGridImage(storyId, entityName);
      if (data?.gridImage) {
        setLoadedEntityGridImages(prev => ({ ...prev, [entityName]: data.gridImage }));
      }
    } catch (err) {
      console.error(`Failed to load entity grid image for ${entityName}:`, err);
    } finally {
      setLoadingEntityGridImages(prev => {
        const next = new Set(prev);
        next.delete(entityName);
        return next;
      });
    }
  };

  // Helper to crop a cell from an entity consistency grid image
  const cropGridCell = async (
    gridImage: string,
    cellIndex: number,
    manifest: { cellSize: number; cols: number; rows: number }
  ): Promise<string> => {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error('Could not get canvas context'));
          return;
        }

        const { cellSize, cols } = manifest;
        const row = Math.floor(cellIndex / cols);
        const col = cellIndex % cols;
        const x = col * cellSize;
        const y = row * cellSize;

        canvas.width = cellSize;
        canvas.height = cellSize;
        ctx.drawImage(img, x, y, cellSize, cellSize, 0, 0, cellSize, cellSize);

        resolve(canvas.toDataURL('image/png'));
      };
      img.onerror = () => reject(new Error('Failed to load grid image'));
      img.src = gridImage;
    });
  };

  // Handle clicking on an individual grid cell to enlarge it
  const handleCellClick = async (
    grid: { gridImage: string; entityName: string; manifest: { cellSize: number; cols: number; rows: number; cells: Array<{ letter: string; pageNumber?: number; isReference?: boolean; clothing?: string }> } },
    cellIndex: number
  ) => {
    try {
      const cell = grid.manifest.cells[cellIndex];
      const croppedImage = await cropGridCell(grid.gridImage, cellIndex, grid.manifest);
      const cellLabel = cell.isReference ? 'Reference' : `Page ${cell.pageNumber}`;
      const clothingLabel = cell.clothing && cell.clothing !== 'standard' ? ` (${cell.clothing})` : '';
      setEnlargedImage({
        src: croppedImage,
        title: `${grid.entityName} - ${cellLabel}${clothingLabel}`
      });
    } catch (err) {
      console.error('Failed to crop cell:', err);
    }
  };

  // Helper to get avatar image - checks both entry and loaded state
  const getAvatarImage = (
    type: 'styled' | 'costumed',
    index: number,
    entry: StyledAvatarGenerationEntry | CostumedAvatarGenerationEntry,
    field: 'facePhoto' | 'originalAvatar' | 'styleSample' | 'standardAvatar' | 'output'
  ): string | null => {
    const key = `${type}-${index}`;
    const loaded = loadedAvatarGenImages[key];

    // Check loaded images first
    if (loaded && loaded[field]) {
      return loaded[field] as string;
    }

    // Check entry data
    if (field === 'output' && entry.output?.imageData) {
      return entry.output.imageData;
    }
    if (field === 'facePhoto' && entry.inputs.facePhoto?.imageData) {
      return entry.inputs.facePhoto.imageData;
    }
    if (field === 'originalAvatar' && 'originalAvatar' in entry.inputs && entry.inputs.originalAvatar?.imageData) {
      return entry.inputs.originalAvatar.imageData;
    }
    if (field === 'styleSample' && 'styleSample' in entry.inputs && entry.inputs.styleSample?.imageData) {
      return entry.inputs.styleSample.imageData;
    }
    if (field === 'standardAvatar' && 'standardAvatar' in entry.inputs && entry.inputs.standardAvatar?.imageData) {
      return (entry.inputs.standardAvatar as { imageData?: string }).imageData || null;
    }

    return null;
  };

  // Render avatar generation image - with lazy load button
  const renderAvatarGenImage = (
    type: 'styled' | 'costumed',
    index: number,
    entry: StyledAvatarGenerationEntry | CostumedAvatarGenerationEntry,
    field: 'facePhoto' | 'originalAvatar' | 'styleSample' | 'standardAvatar' | 'output',
    label: string,
    sizeKB?: number
  ) => {
    const imageData = getAvatarImage(type, index, entry, field);
    const key = `${type}-${index}`;
    const isLoading = loadingAvatarGenImages.has(key);
    const isLoaded = !!loadedAvatarGenImages[key];

    return (
      <div className="flex flex-col items-center">
        <span className="text-gray-600 text-[10px] mb-1">{label}</span>
        {imageData ? (
          <img
            src={imageData}
            alt={label}
            className="w-16 h-16 object-cover rounded border border-blue-300 cursor-pointer hover:opacity-80 transition-opacity"
            onClick={() => setEnlargedImage({ src: imageData, title: label })}
            title={sizeKB ? `${sizeKB} KB - Click to enlarge` : 'Click to enlarge'}
          />
        ) : sizeKB ? (
          <button
            onClick={() => fetchAvatarGenImages(type, index)}
            disabled={isLoading || isLoaded}
            className="w-16 h-16 flex flex-col items-center justify-center bg-blue-50 border border-blue-300 rounded text-blue-500 hover:bg-blue-100 disabled:opacity-50 text-[10px]"
            title="Click to load images"
          >
            {isLoading ? (
              <Loader2 size={16} className="animate-spin" />
            ) : (
              <>
                <Images size={14} />
                <span className="mt-0.5">{sizeKB} KB</span>
              </>
            )}
          </button>
        ) : (
          <span className="text-gray-400 italic text-[10px]">N/A</span>
        )}
      </div>
    );
  };

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

  // Handle iterate page (dev mode) - analyze current image, run 17 checks, regenerate
  const handleIteratePage = async (pageNumber: number) => {
    if (!onIteratePage || iteratingPage !== null) return;
    setIteratingPage(pageNumber);
    try {
      await onIteratePage(pageNumber);
    } catch (err) {
      console.error('Failed to iterate page:', err);
    } finally {
      setIteratingPage(null);
    }
  };

  // Handle entity consistency repair (dev mode)
  const handleRepairEntityConsistency = async (entityName: string) => {
    if (!storyId || repairingEntity !== null) return;
    setRepairingEntity(entityName);
    try {
      const response = await fetch(`/api/stories/${storyId}/repair-entity-consistency`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('auth_token')}`
        },
        body: JSON.stringify({ entityName, entityType: 'character' })
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Repair failed');
      }

      const result = await response.json();
      console.log('Entity repair result:', result);

      // Refresh story data to show updated images
      if (result.success && !result.noChanges) {
        if (onRefreshStory) {
          await onRefreshStory();
        } else {
          // Fallback to reload if no refresh callback
          window.location.reload();
        }
      }
    } catch (err) {
      console.error('Failed to repair entity consistency:', err);
      alert(`Failed to repair: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setRepairingEntity(null);
    }
  };

  // Handle single-page entity repair (dev mode) - repairs one specific page for a character
  const handleRepairSingleEntityPage = async (entityName: string, pageNumber: number) => {
    if (!storyId || repairingSingleEntityPage !== null) return;
    setRepairingSingleEntityPage({ entity: entityName, page: pageNumber });
    try {
      const response = await fetch(`/api/stories/${storyId}/repair-entity-consistency`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('auth_token')}`
        },
        body: JSON.stringify({ entityName, entityType: 'character', pageNumber })
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Repair failed');
      }

      const result = await response.json();
      console.log('Single-page entity repair result:', result);

      // Refresh story data to show updated image
      if (result.success) {
        if (onRefreshStory) {
          await onRefreshStory();
        } else {
          window.location.reload();
        }
      }
    } catch (err) {
      console.error('Failed to repair single page:', err);
      alert(`Failed to repair page ${pageNumber}: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setRepairingSingleEntityPage(null);
    }
  };

  // Handle image issue repair (dev mode) - repairs a specific page based on consistency issue
  const handleRepairImageIssue = async (pageNumber: number, issue: { type?: string; description?: string; canonicalVersion?: string; recommendation?: string }) => {
    if (!storyId || repairingIssuePage !== null) return;
    setRepairingIssuePage(pageNumber);
    try {
      const response = await fetch(`/api/stories/${storyId}/repair/image/${pageNumber}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('auth_token')}`
        },
        body: JSON.stringify({
          correctionNotes: `${issue.type || ''}: ${issue.description || ''}\nTarget: ${issue.canonicalVersion || ''}\nFix: ${issue.recommendation || ''}`
        })
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Repair failed');
      }

      const result = await response.json();
      console.log('Image issue repair result:', result);

      if (result.success) {
        if (onRefreshStory) {
          await onRefreshStory();
        } else {
          window.location.reload();
        }
      }
    } catch (err) {
      console.error('Failed to repair image issue:', err);
      alert(`Failed to repair: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setRepairingIssuePage(null);
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
  const extractImageSummary = (fullDescription: string | object): string => {
    if (!fullDescription) return '';

    // Handle case where description is an object (JSON response not converted to string)
    let desc: string;
    if (typeof fullDescription !== 'string') {
      const obj = fullDescription as {
        output?: string | { translatedSummary?: string; imageSummary?: string };
        thinking?: unknown
      };

      // Try to extract the translated image summary from nested output object
      if (obj.output) {
        if (typeof obj.output === 'string') {
          desc = obj.output;
        } else if (typeof obj.output === 'object') {
          // Extract translatedSummary (preferred) or imageSummary from output object
          const summary = obj.output.translatedSummary || obj.output.imageSummary || '';
          if (summary) {
            return summary; // Return directly - it's already the clean summary
          }
          // No summary found, stringify as fallback
          desc = JSON.stringify(fullDescription);
        } else {
          desc = JSON.stringify(fullDescription);
        }
      } else {
        // No output field, stringify as fallback
        desc = JSON.stringify(fullDescription);
      }
    } else {
      desc = fullDescription;
    }

    // Handle case where description is a JSON string (string containing JSON)
    if (desc.trim().startsWith('{')) {
      try {
        const parsed = JSON.parse(desc);
        if (parsed.output) {
          if (typeof parsed.output === 'string') {
            desc = parsed.output;
          } else if (typeof parsed.output === 'object') {
            // Extract translatedSummary (preferred) or imageSummary from nested object
            const summary = parsed.output.translatedSummary || parsed.output.imageSummary;
            if (summary) {
              return summary;
            }
          }
        }
      } catch {
        // Not valid JSON, continue with original string
      }
    }

    // PRIORITY 1: Section 6 "Image Summary (Language)" - the TRANSLATED version for user editing
    // Handles multiple formats from LLM:
    // Format 1: "6. **Image Summary (Deutsch)**\nSophie kniet..."
    // Format 2: "**6. Image Summary (Deutsch)**\nSophie kniet..."
    // Format 3: "## 6. Image Summary (Deutsch)\nSophie kniet..." (markdown headers)
    // Format 4: "6. **Bildzusammenfassung (Deutsch)**\nSophie kniet..." (fully translated header)
    // Format 5: "6. **Image Summary (German (Switzerland))**\n..." (nested parentheses)
    // NOTE: Uses (?:[^()]+|\([^()]*\))+ to handle nested parens like "German (Switzerland)"
    const section6Match = desc.match(
      /(?:#{1,3}\s*)?(?:\*\*)?6\.?\s*(?:\*\*)?\s*\*?\*?(Image Summary|Bildzusammenfassung|Résumé de l['']Image)\s*\((?:[^()]+|\([^()]*\))+\)\s*\*?\*?\s*:?\s*\n?([\s\S]*?)(?=\n\s*(?:#{1,3}\s*)?(?:\*\*)?\d+\.|\n---|\n```|$)/i
    );
    if (section6Match && section6Match[2] && section6Match[2].trim()) {
      return section6Match[2].trim();
    }

    // PRIORITY 2: Look for any "Image Summary (Language)" pattern anywhere (without section number)
    // This catches variations like "**Image Summary (Deutsch):**\nContent..." or "## Image Summary (Deutsch)"
    // NOTE: Uses (?:[^()]+|\([^()]*\))+ to handle nested parens like "German (Switzerland)"
    const localizedSummaryMatch = desc.match(
      /(?:#{1,3}\s*)?\*?\*?(Image Summary|Bildzusammenfassung|Résumé de l['']Image)\s*\((?:[^()]+|\([^()]*\))+\)\s*:?\s*\*?\*?\s*\n([\s\S]*?)(?=\n\s*(?:#{1,3}\s*)?(?:\*\*)?\d+\.|\n\*\*|\n#{1,3}\s|$)/i
    );
    if (localizedSummaryMatch && localizedSummaryMatch[2] && localizedSummaryMatch[2].trim()) {
      return localizedSummaryMatch[2].trim();
    }

    // PRIORITY 3: Fallback for simple descriptions (no markdown headers)
    // Just return as-is if short enough (e.g., user-edited simple text)
    if (!desc.includes('**') && desc.length < 1000) {
      return desc.trim();
    }

    // PRIORITY 4: If description has headers but no Section 6, try to extract first meaningful content
    // This handles edge cases where LLM didn't generate Section 6
    // Look for content after any "Image Summary" type header
    const anyImageSummaryMatch = desc.match(
      /\*?\*?(Image Summary|Bildzusammenfassung|Résumé de l['']Image)\*?\*?\s*\n([\s\S]*?)(?=\n\s*(?:\*\*)?\d+\.\s*\*\*|\n\s*\*\*\d+\.|$)/i
    );
    if (anyImageSummaryMatch && anyImageSummaryMatch[2] && anyImageSummaryMatch[2].trim()) {
      return anyImageSummaryMatch[2].trim();
    }

    // Last fallback: return truncated description
    return desc.substring(0, 500).trim() + '...';
  };

  // Detect which characters are mentioned in a scene description
  const detectCharactersInScene = (sceneText: string | object): number[] => {
    if (!sceneText || !characters.length) return characters.map(c => c.id); // Default to all

    // Convert to string first
    let text: string;
    if (typeof sceneText !== 'string') {
      const obj = sceneText as { output?: string };
      text = obj.output && typeof obj.output === 'string' ? obj.output : JSON.stringify(sceneText);
    } else {
      text = sceneText;
    }

    // Handle JSON strings (string containing JSON)
    if (text.trim().startsWith('{')) {
      try {
        const parsed = JSON.parse(text);
        if (parsed.output && typeof parsed.output === 'string') {
          text = parsed.output;
        }
      } catch {
        // Not valid JSON, continue with original string
      }
    }
    const lowerScene = text.toLowerCase();
    return characters
      .filter(c => lowerScene.includes(c.name.toLowerCase()))
      .map(c => c.id);
  };

  // Open scene edit modal for regeneration
  const openSceneEditModal = (pageNumber: number) => {
    const image = sceneImages.find(img => img.pageNumber === pageNumber);
    const sceneDesc = sceneDescriptions.find(s => s.pageNumber === pageNumber);
    const fullDescription = image?.description || sceneDesc?.description || '';
    // Use pre-extracted translated summary first, then try to extract from description
    // Note: imageSummary is always English, so we try extraction before falling back to it
    const summary = sceneDesc?.translatedSummary || extractImageSummary(fullDescription) || sceneDesc?.imageSummary || '';
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
    setRegeneratingPages(prev => new Set(prev).add(pageNumber));
    setIsRegenerating(true);

    try {
      await onRegenerateImage(pageNumber, scene, characterIds);
    } catch (err) {
      console.error('Failed to regenerate image:', err);
    } finally {
      setRegeneratingPages(prev => {
        const next = new Set(prev);
        next.delete(pageNumber);
        return next;
      });
      // Only set isRegenerating to false if no more pages are regenerating
      setRegeneratingPages(current => {
        if (current.size === 0) {
          setIsRegenerating(false);
        }
        return current;
      });
    }
  };

  // Open cover edit modal for regeneration (like openSceneEditModal but for covers)
  const openCoverEditModal = (coverType: 'front' | 'back' | 'initial') => {
    // Get the current cover's description and reference photos
    let coverDescription = '';
    let referencePhotos: Array<{ name: string }> = [];

    if (coverType === 'front' && coverImages?.frontCover) {
      const frontCover = coverImages.frontCover;
      if (typeof frontCover === 'object') {
        coverDescription = (frontCover as CoverImageData).description || '';
        referencePhotos = (frontCover as CoverImageData).referencePhotos || [];
      }
    } else if (coverType === 'initial' && coverImages?.initialPage) {
      const initialPage = coverImages.initialPage;
      if (typeof initialPage === 'object') {
        coverDescription = (initialPage as CoverImageData).description || '';
        referencePhotos = (initialPage as CoverImageData).referencePhotos || [];
      }
    } else if (coverType === 'back' && coverImages?.backCover) {
      const backCover = coverImages.backCover;
      if (typeof backCover === 'object') {
        coverDescription = (backCover as CoverImageData).description || '';
        referencePhotos = (backCover as CoverImageData).referencePhotos || [];
      }
    }

    // Determine initial character selection based on reference photos used
    let initialCharacterIds: number[] = [];
    if (referencePhotos.length > 0 && characters.length > 0) {
      // Match reference photo names to character IDs
      initialCharacterIds = characters
        .filter(c => referencePhotos.some(ref => ref.name === c.name))
        .map(c => c.id);
    }
    // If no reference photos found, default to all characters
    if (initialCharacterIds.length === 0) {
      initialCharacterIds = characters.map(c => c.id);
    }

    // Load title for front cover, dedication for initial page
    const modalTitle = coverType === 'front' ? title : undefined;
    const modalDedication = coverType === 'initial' ? dedication : undefined;

    setCoverEditModal({ coverType, scene: coverDescription, selectedCharacterIds: initialCharacterIds, title: modalTitle, dedication: modalDedication });
  };

  // Handle regenerate cover with edited scene
  const handleRegenerateCoverWithScene = async () => {
    if (!coverEditModal || !_onRegenerateCover) return;
    const { coverType, scene, selectedCharacterIds, title: editedTitle, dedication: editedDedication } = coverEditModal;

    // Close modal immediately
    setCoverEditModal(null);

    try {
      await _onRegenerateCover(coverType, scene, selectedCharacterIds, editedTitle, editedDedication);
    } catch (err) {
      console.error('Failed to regenerate cover:', err);
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
  // _totalScenes = number of images to expect (different from totalPages for 2:1 layouts)
  const _totalScenes = progressiveData?.totalScenes || sceneImages.length || Math.ceil(totalProgressivePages / (isPictureBook ? 1 : 2));
  void _totalScenes; // Preserved for future use

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

  // Helper to get scene description for a page (pretty-printed JSON)
  const getSceneDescription = (pageNumber: number): string | undefined => {
    // First check sceneDescriptions array
    const fromDescriptions = sceneDescriptions.find(s => s.pageNumber === pageNumber)?.description;
    const rawDesc = fromDescriptions || sceneImages.find(img => img.pageNumber === pageNumber)?.description;

    if (!rawDesc) return undefined;

    // Pretty-print JSON for readability
    if (typeof rawDesc === 'string') {
      try {
        const parsed = JSON.parse(rawDesc);
        return JSON.stringify(parsed, null, 2);
      } catch {
        return rawDesc;
      }
    }
    // If it's an object, format it nicely
    if (typeof rawDesc === 'object') {
      return JSON.stringify(rawDesc, null, 2);
    }
    return String(rawDesc);
  };

  // Helper to get outline extract for a page
  const getOutlineExtract = (pageNumber: number): string | undefined => {
    const scene = sceneDescriptions.find(s => s.pageNumber === pageNumber);
    if (pageNumber === 1 && scene) {
      console.log('[StoryDisplay] Page 1 scene keys:', Object.keys(scene));
      console.log('[StoryDisplay] Page 1 has outlineExtract:', !!scene.outlineExtract);
      console.log('[StoryDisplay] Page 1 has scenePrompt:', !!scene.scenePrompt);
    }
    return scene?.outlineExtract;
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

      {/* Action Buttons Grid - Order: Create Book, PDF, Share, Create Another */}
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

        {/* PDF Download with Format Selector */}
        {hasImages && onDownloadPdf && (
          <div className="relative">
            <button
              onClick={() => setShowPdfFormatDropdown(!showPdfFormatDropdown)}
              disabled={isGenerating}
              className={`bg-indigo-500 text-white px-3 py-2 rounded-lg text-sm font-semibold flex items-center justify-center gap-1.5 w-full ${
                isGenerating ? 'opacity-50 cursor-not-allowed' : 'hover:bg-indigo-600'
              }`}
            >
              <FileText size={16} />
              {language === 'de' ? 'PDF herunterladen' : language === 'fr' ? 'Télécharger PDF' : 'Download PDF'}
              <ChevronDown size={14} className={`transition-transform ${showPdfFormatDropdown ? 'rotate-180' : ''}`} />
            </button>
            {showPdfFormatDropdown && (
              <div className="absolute top-full left-0 right-0 mt-1 bg-white rounded-lg shadow-lg border border-gray-200 z-50 overflow-hidden">
                <div className="p-2 space-y-1">
                  <label className="flex items-center gap-2 p-2 hover:bg-gray-50 rounded cursor-pointer">
                    <input
                      type="radio"
                      name="pdfFormat"
                      checked={pdfFormat === 'square'}
                      onChange={() => setPdfFormat('square')}
                      className="text-indigo-600"
                    />
                    <span className="text-sm text-gray-700">Square (20×20cm)</span>
                  </label>
                  <label className="flex items-center gap-2 p-2 hover:bg-gray-50 rounded cursor-pointer">
                    <input
                      type="radio"
                      name="pdfFormat"
                      checked={pdfFormat === 'A4'}
                      onChange={() => setPdfFormat('A4')}
                      className="text-indigo-600"
                    />
                    <span className="text-sm text-gray-700">A4 (21×28cm)</span>
                  </label>
                </div>
                <button
                  onClick={() => {
                    onDownloadPdf(pdfFormat);
                    setShowPdfFormatDropdown(false);
                  }}
                  className="w-full py-2 bg-indigo-500 text-white text-sm font-semibold hover:bg-indigo-600"
                >
                  {language === 'de' ? 'Herunterladen' : language === 'fr' ? 'Télécharger' : 'Download'}
                </button>
              </div>
            )}
          </div>
        )}

        {/* Share Story - in grid */}
        {hasImages && storyId && !isGenerating && (
          <ShareButton storyId={storyId} variant="full" />
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
                                {char.physical?.skinTone || 'N/A'} | {char.physical?.hair || 'N/A'} | {char.physical?.build || 'N/A'}
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
                        <div key={entry.id} className="bg-rose-50 p-2 rounded text-sm flex gap-3">
                          {renderRefImageThumbnail(entry.id, entry.hasReferenceImage)}
                          <div className="flex-1 min-w-0">
                            <div className="font-semibold text-rose-800 flex items-center gap-2 flex-wrap">
                              {entry.name}
                              {entry.id && <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-200 text-gray-600 font-mono">{entry.id}</span>}
                              {entry.source && (
                                <span className={`text-[10px] px-1.5 py-0.5 rounded ${entry.source === 'outline' ? 'bg-blue-100 text-blue-700' : 'bg-green-100 text-green-700'}`}>
                                  {entry.source === 'outline' ? 'Outline' : 'Story'}
                                </span>
                              )}
                              {entry.hasReferenceImage && <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-100 text-purple-700">has ref</span>}
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
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Animals & Creatures */}
                {visualBible.animals?.length > 0 && (
                  <div className="bg-white border border-rose-200 rounded-lg p-3">
                    <h4 className="text-sm font-bold text-rose-700 mb-2">
                      {language === 'de' ? 'Tiere & Wesen' : language === 'fr' ? 'Animaux & Créatures' : 'Animals & Creatures'}
                    </h4>
                    <div className="space-y-2">
                      {visualBible.animals.map((entry) => (
                        <div key={entry.id} className="bg-rose-50 p-2 rounded text-sm flex gap-3">
                          {renderRefImageThumbnail(entry.id, entry.hasReferenceImage)}
                          <div className="flex-1 min-w-0">
                            <div className="font-semibold text-rose-800 flex items-center gap-2 flex-wrap">
                              {entry.name}
                              {entry.id && <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-200 text-gray-600 font-mono">{entry.id}</span>}
                              {entry.source && (
                                <span className={`text-[10px] px-1.5 py-0.5 rounded ${entry.source === 'outline' ? 'bg-blue-100 text-blue-700' : 'bg-green-100 text-green-700'}`}>
                                  {entry.source === 'outline' ? 'Outline' : 'Story'}
                                </span>
                              )}
                              {entry.hasReferenceImage && <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-100 text-purple-700">has ref</span>}
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
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Artifacts */}
                {visualBible.artifacts?.length > 0 && (
                  <div className="bg-white border border-rose-200 rounded-lg p-3">
                    <h4 className="text-sm font-bold text-rose-700 mb-2">
                      {language === 'de' ? 'Artefakte & Objekte' : language === 'fr' ? 'Artefacts & Objets' : 'Artifacts & Objects'}
                    </h4>
                    <div className="space-y-2">
                      {visualBible.artifacts.map((entry) => (
                        <div key={entry.id} className="bg-rose-50 p-2 rounded text-sm flex gap-3">
                          {renderRefImageThumbnail(entry.id, entry.hasReferenceImage)}
                          <div className="flex-1 min-w-0">
                            <div className="font-semibold text-rose-800 flex items-center gap-2 flex-wrap">
                              {entry.name}
                              {entry.id && <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-200 text-gray-600 font-mono">{entry.id}</span>}
                              {entry.source && (
                                <span className={`text-[10px] px-1.5 py-0.5 rounded ${entry.source === 'outline' ? 'bg-blue-100 text-blue-700' : 'bg-green-100 text-green-700'}`}>
                                  {entry.source === 'outline' ? 'Outline' : 'Story'}
                                </span>
                              )}
                              {entry.hasReferenceImage && <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-100 text-purple-700">has ref</span>}
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
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Locations */}
                {visualBible.locations?.length > 0 && (
                  <div className="bg-white border border-rose-200 rounded-lg p-3">
                    <h4 className="text-sm font-bold text-rose-700 mb-2">
                      {language === 'de' ? 'Wiederkehrende Orte' : language === 'fr' ? 'Lieux Récurrents' : 'Recurring Locations'}
                    </h4>
                    <div className="space-y-2">
                      {visualBible.locations.map((entry) => (
                        <div key={entry.id} className="bg-rose-50 p-2 rounded text-sm flex gap-3">
                          {!entry.isRealLandmark && renderRefImageThumbnail(entry.id, entry.hasReferenceImage)}
                          <div className="flex-1 min-w-0">
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
                              {!entry.isRealLandmark && entry.hasReferenceImage && <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-100 text-purple-700">has ref</span>}
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
                        <div key={entry.id} className="bg-rose-50 p-2 rounded text-sm flex gap-3">
                          {renderRefImageThumbnail(entry.id, entry.hasReferenceImage)}
                          <div className="flex-1 min-w-0">
                            <div className="font-semibold text-rose-800 flex items-center gap-2 flex-wrap">
                              {entry.name}
                              {entry.id && <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-200 text-gray-600 font-mono">{entry.id}</span>}
                              {entry.source && (
                                <span className={`text-[10px] px-1.5 py-0.5 rounded ${entry.source === 'outline' ? 'bg-blue-100 text-blue-700' : 'bg-green-100 text-green-700'}`}>
                                  {entry.source === 'outline' ? 'Outline' : 'Story'}
                                </span>
                              )}
                              {entry.hasReferenceImage && <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-100 text-purple-700">has ref</span>}
                              {entry.appearsInPages?.length > 0 && <span className="text-xs text-rose-600">(Pages: {entry.appearsInPages.join(', ')})</span>}
                            </div>
                            <div className="text-gray-700 text-xs mt-1">{entry.description}</div>
                            {entry.extractedDescription && (
                              <div className="text-green-700 text-xs mt-1 bg-green-50 p-1 rounded">
                                <span className="font-semibold">Extracted:</span> {entry.extractedDescription}
                              </div>
                            )}
                          </div>
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
                    <div className="mt-2 space-y-1 max-h-[500px] overflow-y-auto">
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

          {/* Clothing Requirements - Per-character outfit definitions */}
          {clothingRequirements && Object.keys(clothingRequirements).length > 0 && (
            <details className="bg-teal-50 border-2 border-teal-200 rounded-xl p-4">
              <summary className="cursor-pointer text-lg font-bold text-teal-800 hover:text-teal-900 flex items-center gap-2">
                <span className="text-xl">👔</span>
                {language === 'de'
                  ? `Kleidungsanforderungen (${Object.keys(clothingRequirements).length} Charaktere)`
                  : language === 'fr'
                    ? `Exigences vestimentaires (${Object.keys(clothingRequirements).length} personnages)`
                    : `Clothing Requirements (${Object.keys(clothingRequirements).length} characters)`}
              </summary>
              <div className="mt-4 space-y-3">
                {Object.entries(clothingRequirements).map(([charName, requirements]) => (
                  <div key={charName} className="bg-white border border-teal-200 rounded-lg p-3">
                    <h4 className="font-bold text-teal-700 mb-2">{charName}</h4>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                      {/* Standard */}
                      <div className={`p-2 rounded ${requirements.standard?.used ? 'bg-green-50 border border-green-200' : 'bg-gray-50 border border-gray-200 opacity-50'}`}>
                        <div className="font-semibold text-gray-700 flex items-center gap-1">
                          {requirements.standard?.used ? '✅' : '⬜'} Standard
                        </div>
                        {requirements.standard?.used && requirements.standard?.signature && (
                          <div className="text-gray-600 mt-1">{requirements.standard.signature}</div>
                        )}
                      </div>
                      {/* Winter */}
                      <div className={`p-2 rounded ${requirements.winter?.used ? 'bg-blue-50 border border-blue-200' : 'bg-gray-50 border border-gray-200 opacity-50'}`}>
                        <div className="font-semibold text-gray-700 flex items-center gap-1">
                          {requirements.winter?.used ? '❄️' : '⬜'} Winter
                        </div>
                        {requirements.winter?.used && requirements.winter?.signature && (
                          <div className="text-gray-600 mt-1">{requirements.winter.signature}</div>
                        )}
                      </div>
                      {/* Summer */}
                      <div className={`p-2 rounded ${requirements.summer?.used ? 'bg-yellow-50 border border-yellow-200' : 'bg-gray-50 border border-gray-200 opacity-50'}`}>
                        <div className="font-semibold text-gray-700 flex items-center gap-1">
                          {requirements.summer?.used ? '☀️' : '⬜'} Summer
                        </div>
                        {requirements.summer?.used && requirements.summer?.signature && (
                          <div className="text-gray-600 mt-1">{requirements.summer.signature}</div>
                        )}
                      </div>
                      {/* Costumed */}
                      <div className={`p-2 rounded ${requirements.costumed?.used ? 'bg-purple-50 border border-purple-200' : 'bg-gray-50 border border-gray-200 opacity-50'}`}>
                        <div className="font-semibold text-gray-700 flex items-center gap-1">
                          {requirements.costumed?.used ? '🎭' : '⬜'} Costumed
                        </div>
                        {requirements.costumed?.used && (
                          <div className="text-gray-600 mt-1">
                            {requirements.costumed.costume && <span className="font-medium">{requirements.costumed.costume}: </span>}
                            {requirements.costumed.description}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
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
                      {entry.characterName} - {entry.artStyle} ({entry.clothingCategory || 'standard'})
                      <span className="text-xs text-gray-500 ml-auto">
                        {(entry.durationMs / 1000).toFixed(1)}s
                      </span>
                    </summary>
                    <div className="mt-3 space-y-3">
                      {/* Inputs */}
                      <div className="bg-blue-50 p-2 rounded text-xs">
                        <span className="font-semibold text-blue-700">Inputs:</span>
                        <div className="mt-2 flex flex-wrap gap-3">
                          {renderAvatarGenImage('styled', index, entry, 'facePhoto', 'Face Photo', entry.inputs.facePhoto?.sizeKB)}
                          {renderAvatarGenImage('styled', index, entry, 'originalAvatar', 'Original Avatar', entry.inputs.originalAvatar?.sizeKB)}
                          {entry.inputs.styleSample && renderAvatarGenImage('styled', index, entry, 'styleSample', 'Style Sample', entry.inputs.styleSample.sizeKB)}
                        </div>
                      </div>

                      {/* Prompt */}
                      {entry.prompt && (
                        <details className="bg-purple-50 p-2 rounded text-xs">
                          <summary className="cursor-pointer font-semibold text-purple-700 hover:text-purple-800">
                            Prompt ({entry.prompt.length} chars)
                          </summary>
                          <pre className="mt-2 text-gray-700 whitespace-pre-wrap text-[10px] max-h-[500px] overflow-y-auto">
                            {entry.prompt}
                          </pre>
                        </details>
                      )}

                      {/* Output */}
                      {entry.success && entry.output && (
                        <div className="bg-green-50 p-2 rounded text-xs">
                          <span className="font-semibold text-green-700">Output:</span>
                          <div className="mt-2">
                            {renderAvatarGenImage('styled', index, entry, 'output', 'Styled Avatar Output', entry.output.sizeKB)}
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
                          {renderAvatarGenImage('costumed', index, entry, 'facePhoto', 'Face Photo', entry.inputs.facePhoto?.sizeKB)}
                          {renderAvatarGenImage('costumed', index, entry, 'standardAvatar', 'Standard Avatar', entry.inputs.standardAvatar?.sizeKB)}
                        </div>
                      </div>

                      {/* Prompt */}
                      {entry.prompt && (
                        <details className="bg-purple-50 p-2 rounded text-xs">
                          <summary className="cursor-pointer font-semibold text-purple-700 hover:text-purple-800">
                            Prompt ({entry.prompt.length} chars)
                          </summary>
                          <pre className="mt-2 text-gray-700 whitespace-pre-wrap text-[10px] max-h-[500px] overflow-y-auto">
                            {entry.prompt}
                          </pre>
                        </details>
                      )}

                      {/* Output */}
                      {entry.success && entry.output && (
                        <div className="bg-green-50 p-2 rounded text-xs">
                          <span className="font-semibold text-green-700">Output:</span>
                          <div className="mt-2">
                            {renderAvatarGenImage('costumed', index, entry, 'output', 'Costumed Avatar Output', entry.output.sizeKB)}
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

          {/* Generation Log */}
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

          {/* Final Checks Report (if available) */}
          {finalChecksReport && (
            <details className={`border-2 rounded-xl p-4 ${
              finalChecksReport.overallConsistent
                ? 'bg-green-50 border-green-200'
                : 'bg-amber-50 border-amber-200'
            }`}>
              <summary className={`cursor-pointer text-lg font-bold flex items-center gap-2 ${
                finalChecksReport.overallConsistent
                  ? 'text-green-800 hover:text-green-900'
                  : 'text-amber-800 hover:text-amber-900'
              }`}>
                {finalChecksReport.overallConsistent ? '✓' : '⚠️'}
                {language === 'de'
                  ? `Konsistenzprüfung (${finalChecksReport.totalIssues} Probleme)`
                  : language === 'fr'
                    ? `Vérification de cohérence (${finalChecksReport.totalIssues} problèmes)`
                    : `Final Checks (${finalChecksReport.totalIssues} issues)`}
              </summary>
              <div className="mt-4 space-y-4">
                {/* Summary */}
                <p className="text-sm text-gray-700">{finalChecksReport.summary}</p>

                {/* Image Checks */}
                {finalChecksReport.imageChecks && finalChecksReport.imageChecks.length > 0 && (
                  <div className="space-y-3">
                    <h4 className="font-semibold text-sm text-gray-800">
                      {language === 'de' ? 'Bildkonsistenz' : language === 'fr' ? 'Cohérence des images' : 'Image Consistency'}
                    </h4>
                    {finalChecksReport.imageChecks.map((check, checkIdx) => (
                      <div key={checkIdx} className="bg-white border border-gray-200 rounded-lg p-3">
                        <div className="flex items-center gap-2 mb-2">
                          <span className={`text-sm font-medium ${check.consistent ? 'text-green-600' : 'text-amber-600'}`}>
                            {check.consistent ? '✓' : '⚠️'}
                          </span>
                          <span className="text-sm font-semibold text-gray-700">
                            {check.type === 'full' ? 'Full Check' :
                             check.type === 'character' ? `Character: ${check.characterName}` :
                             check.type === 'sequence' ? 'Sequence Check' : check.type}
                          </span>
                          {check.overallScore !== undefined && (
                            <span className="ml-auto text-xs bg-gray-100 px-2 py-0.5 rounded">
                              Score: {check.overallScore}/10
                            </span>
                          )}
                        </div>
                        {check.issues && check.issues.length > 0 && (
                          <div className="space-y-2 mt-2">
                            {check.issues.map((issue, issueIdx) => (
                              <div key={issueIdx} className={`text-xs p-2 rounded ${
                                issue.severity === 'high' ? 'bg-red-50 border-l-4 border-red-400' :
                                issue.severity === 'medium' ? 'bg-amber-50 border-l-4 border-amber-400' :
                                'bg-gray-50 border-l-4 border-gray-300'
                              }`}>
                                <div className="flex items-start gap-2 flex-wrap">
                                  <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                                    issue.severity === 'high' ? 'bg-red-200 text-red-800' :
                                    issue.severity === 'medium' ? 'bg-amber-200 text-amber-800' :
                                    'bg-gray-200 text-gray-700'
                                  }`}>
                                    {issue.severity}
                                  </span>
                                  <span className="text-gray-500">Pages {issue.images?.join(', ')}</span>
                                  {issue.pagesToFix && issue.pagesToFix.length > 0 && (
                                    <span className="px-1.5 py-0.5 bg-orange-100 text-orange-700 rounded text-[10px]">
                                      Fix: {issue.pagesToFix.join(', ')}
                                    </span>
                                  )}
                                  <span className="px-1.5 py-0.5 bg-blue-100 text-blue-700 rounded text-[10px]">
                                    {issue.type?.replace(/_/g, ' ')}
                                  </span>
                                  {issue.characterInvolved && (
                                    <span className="px-1.5 py-0.5 bg-purple-100 text-purple-700 rounded text-[10px]">
                                      {issue.characterInvolved}
                                    </span>
                                  )}
                                </div>
                                <p className="text-gray-700 mt-1">{issue.description}</p>
                                {issue.details && Object.keys(issue.details).length > 0 && (
                                  <div className="mt-1 pl-2 border-l-2 border-gray-200">
                                    {Object.entries(issue.details).map(([imgKey, detail]) => (
                                      <p key={imgKey} className="text-gray-500 text-[10px]">
                                        <span className="font-medium">{imgKey}:</span> {detail}
                                      </p>
                                    ))}
                                  </div>
                                )}
                                {issue.canonicalVersion && (
                                  <p className="text-blue-700 mt-1">
                                    🎯 Target: {issue.canonicalVersion}
                                  </p>
                                )}
                                {issue.recommendation && (
                                  <p className="text-green-700 mt-1 font-medium">
                                    💡 {issue.recommendation}
                                  </p>
                                )}
                                {/* Repair button for each page in pagesToFix */}
                                {storyId && issue.pagesToFix && issue.pagesToFix.length > 0 && (
                                  <div className="mt-2 flex flex-wrap gap-1">
                                    {issue.pagesToFix.map((pageNum: number) => (
                                      <button
                                        key={pageNum}
                                        onClick={() => handleRepairImageIssue(pageNum, issue)}
                                        disabled={isGenerating || repairingIssuePage !== null}
                                        className={`flex items-center gap-1 px-2 py-1 text-[10px] font-medium rounded transition-colors ${
                                          repairingIssuePage === pageNum
                                            ? 'bg-amber-300 text-amber-800'
                                            : isGenerating || repairingIssuePage !== null
                                              ? 'bg-gray-200 text-gray-500 cursor-not-allowed'
                                              : 'bg-amber-500 text-white hover:bg-amber-600'
                                        }`}
                                      >
                                        {repairingIssuePage === pageNum ? (
                                          <>
                                            <Loader2 className="w-3 h-3 animate-spin" />
                                            <span>Repairing P{pageNum}...</span>
                                          </>
                                        ) : (
                                          <>
                                            <Wrench className="w-3 h-3" />
                                            <span>Repair P{pageNum}</span>
                                          </>
                                        )}
                                      </button>
                                    ))}
                                  </div>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                        {check.summary && (
                          <p className="text-xs text-gray-500 mt-2 italic">{check.summary}</p>
                        )}
                        {/* Evaluation prompts (collapsible) - for dev mode */}
                        {(check.evaluationPrompts || check.evaluationPrompt) && (
                          <details className="mt-3 bg-blue-50 border border-blue-200 rounded p-2">
                            <summary className="cursor-pointer text-xs font-medium text-blue-800">
                              🔍 View Evaluation Prompt{(check.evaluationPrompts?.length ?? 0) > 1 ? `s (${check.evaluationPrompts?.length} batches)` : ''}
                            </summary>
                            <div className="mt-2 space-y-3">
                              {(check.evaluationPrompts ?? (check.evaluationPrompt ? [check.evaluationPrompt] : [])).map((prompt, promptIdx) => (
                                <div key={promptIdx}>
                                  {(check.evaluationPrompts?.length ?? 0) > 1 && (
                                    <div className="text-xs font-semibold text-blue-700 mb-1">Batch {promptIdx + 1}:</div>
                                  )}
                                  <pre className="text-xs text-gray-700 whitespace-pre-wrap font-sans max-h-[500px] overflow-y-auto bg-white p-2 rounded border">
                                    {prompt}
                                  </pre>
                                </div>
                              ))}
                            </div>
                          </details>
                        )}
                        {/* Parsed result (collapsible) - shows full JSON structure */}
                        <details className="mt-3 bg-indigo-50 border border-indigo-200 rounded p-2">
                          <summary className="cursor-pointer text-xs font-medium text-indigo-800">
                            🔧 View Parsed Result (Full JSON)
                          </summary>
                          <pre className="mt-2 text-xs text-gray-700 whitespace-pre-wrap font-sans max-h-96 overflow-y-auto bg-white p-2 rounded border">
                            {JSON.stringify({
                              type: check.type,
                              characterName: check.characterName,
                              consistent: check.consistent,
                              overallScore: check.overallScore,
                              issues: check.issues,
                              summary: check.summary
                            }, null, 2)}
                          </pre>
                        </details>
                        {/* Raw responses (collapsible) - for debugging/fine-tuning */}
                        {check.rawResponses && check.rawResponses.length > 0 && (
                          <details className="mt-3 bg-purple-50 border border-purple-200 rounded p-2">
                            <summary className="cursor-pointer text-xs font-medium text-purple-800">
                              📝 View Raw Response{check.rawResponses.length > 1 ? `s (${check.rawResponses.length} batches)` : ''}
                            </summary>
                            <div className="mt-2 space-y-3">
                              {check.rawResponses.map((response, respIdx) => (
                                <div key={respIdx}>
                                  {(check.rawResponses?.length ?? 0) > 1 && (
                                    <div className="text-xs font-semibold text-purple-700 mb-1">Batch {respIdx + 1}:</div>
                                  )}
                                  <pre className="text-xs text-gray-700 whitespace-pre-wrap font-sans max-h-[500px] overflow-y-auto bg-white p-2 rounded border">
                                    {response}
                                  </pre>
                                </div>
                              ))}
                            </div>
                          </details>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {/* Entity Consistency Grids (NEW) */}
                {finalChecksReport.entity?.grids && finalChecksReport.entity.grids.length > 0 && (
                  <div className="space-y-3">
                    <h4 className="font-semibold text-sm text-gray-800">
                      {language === 'de' ? 'Entitäts-Konsistenz (Raster)' : language === 'fr' ? 'Cohérence des entités (grilles)' : 'Entity Consistency (Grids)'}
                    </h4>
                    <div className="space-y-2">
                      {finalChecksReport.entity.grids.map((grid, gridIdx) => {
                        const charResult = finalChecksReport.entity?.characters?.[grid.entityName];
                        const isConsistent = charResult?.consistent ?? true;
                        const score = charResult?.score ?? 0;
                        const issues = charResult?.issues ?? [];

                        return (
                          <details key={gridIdx} className={`bg-white border rounded-lg overflow-hidden ${
                            isConsistent ? 'border-green-200' : 'border-amber-200'
                          }`}>
                            <summary className="cursor-pointer p-3 flex items-center gap-2 hover:bg-gray-50">
                              <span className={`text-sm ${isConsistent ? 'text-green-600' : 'text-amber-600'}`}>
                                {isConsistent ? '✓' : '⚠️'}
                              </span>
                              <span className="font-medium text-sm text-gray-800">{grid.entityName}</span>
                              <span className="text-xs text-gray-500">
                                ({grid.cellCount} appearances)
                              </span>
                              <span className={`ml-auto text-xs px-2 py-0.5 rounded ${
                                score >= 8 ? 'bg-green-100 text-green-700' :
                                score >= 5 ? 'bg-amber-100 text-amber-700' :
                                'bg-red-100 text-red-700'
                              }`}>
                                Score: {score}/10
                              </span>
                            </summary>
                            <div className="p-3 border-t border-gray-100 space-y-3">
                              {/* Grid Image - clickable to enlarge, lazy loaded */}
                              {(() => {
                                // Use embedded gridImage if available, otherwise use lazy-loaded
                                const gridImage = grid.gridImage || loadedEntityGridImages[grid.entityName];
                                const isLoading = loadingEntityGridImages.has(grid.entityName);
                                const sizeKB = (grid as { gridImageSizeKB?: number }).gridImageSizeKB;

                                if (gridImage) {
                                  return (
                                    <div className="flex justify-center bg-gray-50 rounded p-2">
                                      <img
                                        src={gridImage}
                                        alt={`${grid.entityName} consistency grid`}
                                        className="max-w-full h-auto rounded shadow-sm cursor-pointer hover:opacity-90 transition-opacity"
                                        style={{ maxHeight: '400px' }}
                                        onClick={() => setEnlargedImage({
                                          src: gridImage,
                                          title: `${grid.entityName} - Entity Consistency Grid`
                                        })}
                                        title="Click to enlarge"
                                      />
                                    </div>
                                  );
                                }

                                return (
                                  <div className="flex justify-center bg-gray-50 rounded p-2">
                                    <button
                                      onClick={() => fetchEntityGridImage(grid.entityName)}
                                      disabled={isLoading}
                                      className="flex items-center gap-2 px-4 py-2 bg-gray-200 hover:bg-gray-300 rounded text-sm text-gray-700 disabled:opacity-50"
                                    >
                                      {isLoading ? (
                                        <>
                                          <Loader2 className="w-4 h-4 animate-spin" />
                                          <span>Loading grid...</span>
                                        </>
                                      ) : (
                                        <>
                                          <Images className="w-4 h-4" />
                                          <span>Load Grid Image{sizeKB ? ` (${sizeKB} KB)` : ''}</span>
                                        </>
                                      )}
                                    </button>
                                  </div>
                                );
                              })()}

                              {/* Cell Info with individual repair buttons - clickable to enlarge */}
                              {grid.manifest?.cells && (
                                <div className="text-xs text-gray-600">
                                  <span className="font-medium">Cells: </span>
                                  {grid.manifest.cells.map((cell, i) => {
                                    const gridImage = grid.gridImage || loadedEntityGridImages[grid.entityName];
                                    return (
                                    <span key={i} className="inline-flex items-center bg-gray-100 rounded px-1.5 py-0.5 mr-1 mb-1 gap-1">
                                      <button
                                        onClick={() => gridImage && handleCellClick({ ...grid, gridImage }, i)}
                                        className={`${gridImage ? 'hover:text-blue-600 hover:underline cursor-pointer' : 'text-gray-400 cursor-not-allowed'}`}
                                        title={gridImage ? "Click to enlarge this cell" : "Load grid image first"}
                                        disabled={!gridImage}
                                      >
                                        {cell.letter}: {cell.isReference ? 'Ref' : `P${cell.pageNumber}`}
                                        {cell.clothing && cell.clothing !== 'standard' && ` (${cell.clothing})`}
                                      </button>
                                      {/* Individual repair button for non-reference cells */}
                                      {!cell.isReference && storyId && typeof cell.pageNumber === 'number' && (
                                        <button
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            handleRepairSingleEntityPage(grid.entityName, cell.pageNumber as number);
                                          }}
                                          disabled={isGenerating || repairingSingleEntityPage !== null || repairingEntity !== null}
                                          className={`ml-0.5 px-1 py-0 text-[9px] rounded transition-colors ${
                                            repairingSingleEntityPage?.entity === grid.entityName && repairingSingleEntityPage?.page === cell.pageNumber
                                              ? 'bg-amber-300 text-amber-800'
                                              : isGenerating || repairingSingleEntityPage !== null || repairingEntity !== null
                                                ? 'bg-gray-200 text-gray-400 cursor-not-allowed'
                                                : 'bg-amber-500 text-white hover:bg-amber-600'
                                          }`}
                                          title={`Repair page ${cell.pageNumber} for ${grid.entityName}`}
                                        >
                                          {repairingSingleEntityPage?.entity === grid.entityName && repairingSingleEntityPage?.page === cell.pageNumber
                                            ? '...'
                                            : '⚡'}
                                        </button>
                                      )}
                                    </span>
                                  );})}
                                </div>
                              )}

                              {/* Issues */}
                              {issues.length > 0 && (
                                <div className="space-y-1">
                                  <span className="text-xs font-medium text-gray-700">Issues:</span>
                                  {issues.map((issue, issueIdx) => (
                                    <div key={issueIdx} className={`text-xs p-2 rounded ${
                                      issue.severity === 'critical' ? 'bg-red-50 border-l-4 border-red-400' :
                                      issue.severity === 'major' ? 'bg-amber-50 border-l-4 border-amber-400' :
                                      'bg-gray-50 border-l-4 border-gray-300'
                                    }`}>
                                      <div className="flex items-start gap-2">
                                        <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                                          issue.severity === 'critical' ? 'bg-red-200 text-red-800' :
                                          issue.severity === 'major' ? 'bg-amber-200 text-amber-800' :
                                          'bg-gray-200 text-gray-700'
                                        }`}>
                                          {issue.subType || issue.type}
                                        </span>
                                        {issue.pagesToFix && (
                                          <span className="text-[10px] text-gray-500">
                                            Fix page(s): {issue.pagesToFix.join(', ')}
                                          </span>
                                        )}
                                      </div>
                                      <p className="mt-1 text-gray-700">{issue.description}</p>
                                      {issue.fixInstruction && (
                                        <p className="mt-1 text-blue-600 italic">{issue.fixInstruction}</p>
                                      )}
                                    </div>
                                  ))}
                                </div>
                              )}

                              {/* Summary */}
                              {charResult?.summary && (
                                <p className="text-xs text-gray-500 italic">{charResult.summary}</p>
                              )}

                              {/* Repair Button - Only show if there are issues and score < 8 */}
                              {storyId && (!isConsistent || score < 8) && grid.entityType === 'character' && (
                                <div className="mt-3 pt-3 border-t border-gray-100">
                                  <button
                                    onClick={() => handleRepairEntityConsistency(grid.entityName)}
                                    disabled={isGenerating || repairingEntity !== null}
                                    className={`flex items-center gap-2 px-3 py-1.5 text-xs font-medium rounded transition-colors ${
                                      isGenerating || repairingEntity !== null
                                        ? 'bg-gray-200 text-gray-500 cursor-not-allowed'
                                        : 'bg-amber-500 text-white hover:bg-amber-600'
                                    }`}
                                  >
                                    {repairingEntity === grid.entityName ? (
                                      <>
                                        <Loader2 className="w-3 h-3 animate-spin" />
                                        <span>Repairing...</span>
                                      </>
                                    ) : (
                                      <>
                                        <Wrench className="w-3 h-3" />
                                        <span>Repair Consistency</span>
                                      </>
                                    )}
                                  </button>
                                  <p className="text-[10px] text-gray-400 mt-1">
                                    Regenerate appearances to match reference photo
                                  </p>
                                </div>
                              )}

                              {/* Repair Results - Show per-cell before/after/diff grouped by clothing */}
                              {finalChecksReport.entityRepairs?.[grid.entityName] && (
                                <div className="mt-3 pt-3 border-t border-gray-100 space-y-3">
                                  <div className="flex items-center gap-2">
                                    <span className="text-xs font-medium text-green-600">✓ Repaired</span>
                                    <span className="text-[10px] text-gray-400">
                                      {finalChecksReport.entityRepairs?.[grid.entityName]?.cellsRepaired
                                        ? `${finalChecksReport.entityRepairs[grid.entityName]?.cellsRepaired} pages updated`
                                        : finalChecksReport.entityRepairs?.[grid.entityName]?.pages
                                          ? `${Object.keys(finalChecksReport.entityRepairs[grid.entityName]?.pages || {}).length} page(s) repaired individually`
                                          : 'repair complete'}
                                      {(finalChecksReport.entityRepairs?.[grid.entityName]?.clothingGroupCount ?? 0) > 1 &&
                                        ` (${finalChecksReport.entityRepairs?.[grid.entityName]?.clothingGroupCount} clothing groups)`}
                                    </span>
                                  </div>

                                  {/* NEW: Grouped by clothing category */}
                                  {finalChecksReport.entityRepairs?.[grid.entityName]?.gridsByClothing?.length ? (
                                    <div className="space-y-4">
                                      {finalChecksReport.entityRepairs?.[grid.entityName]?.gridsByClothing?.map((clothingGroup) => (
                                        <div key={clothingGroup.clothingCategory} className="space-y-2">
                                          {/* Clothing category header */}
                                          <div className="flex items-center gap-2 border-b border-gray-100 pb-1">
                                            <span className="text-[10px] font-semibold text-gray-600 uppercase">
                                              {clothingGroup.clothingCategory}
                                            </span>
                                            <span className="text-[9px] text-gray-400">
                                              ({clothingGroup.cropCount} pages)
                                            </span>
                                            <span className="text-[9px] text-gray-400 ml-auto">
                                              ref: {clothingGroup.referenceUsed}
                                            </span>
                                          </div>

                                          {/* Per-cell comparisons within this clothing group */}
                                          {clothingGroup.cellComparisons?.length ? (
                                            <div className="space-y-1">
                                              <div className="grid grid-cols-4 gap-1 text-[9px] font-medium text-gray-500 px-1">
                                                <span>Cell</span>
                                                <span>Before</span>
                                                <span>After</span>
                                                <span>Diff</span>
                                              </div>
                                              {clothingGroup.cellComparisons.map((cell) => (
                                                <div key={`${clothingGroup.clothingCategory}-${cell.letter}`} className="grid grid-cols-4 gap-1 items-center bg-gray-50 rounded p-1">
                                                  <div className="text-center">
                                                    <span className="text-xs font-bold text-gray-700">{cell.letter}</span>
                                                    <div className="text-[9px] text-gray-400">P{cell.pageNumber}</div>
                                                  </div>
                                                  <img
                                                    src={cell.before}
                                                    alt={`${cell.letter} before`}
                                                    className="w-full h-auto rounded cursor-pointer hover:opacity-80"
                                                    onClick={() => cell.before && setEnlargedImage({ src: cell.before, title: `${grid.entityName} - Cell ${cell.letter} Page ${cell.pageNumber} Before (${clothingGroup.clothingCategory})` })}
                                                  />
                                                  <img
                                                    src={cell.after}
                                                    alt={`${cell.letter} after`}
                                                    className="w-full h-auto rounded cursor-pointer hover:opacity-80"
                                                    onClick={() => cell.after && setEnlargedImage({ src: cell.after, title: `${grid.entityName} - Cell ${cell.letter} Page ${cell.pageNumber} After (${clothingGroup.clothingCategory})` })}
                                                  />
                                                  <div className="bg-gray-900 rounded">
                                                    <img
                                                      src={cell.diff}
                                                      alt={`${cell.letter} diff`}
                                                      className="w-full h-auto rounded cursor-pointer hover:opacity-80"
                                                      onClick={() => cell.diff && setEnlargedImage({ src: cell.diff, title: `${grid.entityName} - Cell ${cell.letter} Page ${cell.pageNumber} Diff (${clothingGroup.clothingCategory})` })}
                                                    />
                                                  </div>
                                                </div>
                                              ))}
                                            </div>
                                          ) : (
                                            /* Fallback to grid comparison for this clothing group */
                                            <div className={`grid gap-2 ${clothingGroup.gridDiff ? 'grid-cols-3' : 'grid-cols-2'}`}>
                                              <div className="space-y-0.5">
                                                <span className="text-[9px] font-medium text-gray-500">Before</span>
                                                <div className="bg-gray-50 rounded p-0.5">
                                                  <img src={clothingGroup.gridBefore} alt="Before repair" className="w-full h-auto rounded" />
                                                </div>
                                              </div>
                                              <div className="space-y-0.5">
                                                <span className="text-[9px] font-medium text-gray-500">After</span>
                                                <div className="bg-gray-50 rounded p-0.5">
                                                  <img src={clothingGroup.gridAfter} alt="After repair" className="w-full h-auto rounded" />
                                                </div>
                                              </div>
                                              {clothingGroup.gridDiff && (
                                                <div className="space-y-0.5">
                                                  <span className="text-[9px] font-medium text-gray-500">Diff</span>
                                                  <div className="bg-gray-900 rounded p-0.5">
                                                    <img src={clothingGroup.gridDiff} alt="Difference" className="w-full h-auto rounded" />
                                                  </div>
                                                </div>
                                              )}
                                            </div>
                                          )}
                                        </div>
                                      ))}
                                    </div>
                                  ) : finalChecksReport.entityRepairs?.[grid.entityName]?.cellComparisons?.length ? (
                                    /* Backward compatible: flat cell comparisons (old format) */
                                    <div className="space-y-2">
                                      <div className="grid grid-cols-4 gap-1 text-[10px] font-medium text-gray-500 px-1">
                                        <span>Cell</span>
                                        <span>Before</span>
                                        <span>After</span>
                                        <span>Diff</span>
                                      </div>
                                      {finalChecksReport.entityRepairs?.[grid.entityName]?.cellComparisons?.map((cell) => (
                                        <div key={cell.letter} className="grid grid-cols-4 gap-1 items-center bg-gray-50 rounded p-1">
                                          <div className="text-center">
                                            <span className="text-xs font-bold text-gray-700">{cell.letter}</span>
                                            <div className="text-[9px] text-gray-400">P{cell.pageNumber}</div>
                                          </div>
                                          <img
                                            src={cell.before}
                                            alt={`${cell.letter} before`}
                                            className="w-full h-auto rounded cursor-pointer hover:opacity-80"
                                            onClick={() => cell.before && setEnlargedImage({ src: cell.before, title: `${grid.entityName} - Cell ${cell.letter} Page ${cell.pageNumber} Before` })}
                                          />
                                          <img
                                            src={cell.after}
                                            alt={`${cell.letter} after`}
                                            className="w-full h-auto rounded cursor-pointer hover:opacity-80"
                                            onClick={() => cell.after && setEnlargedImage({ src: cell.after, title: `${grid.entityName} - Cell ${cell.letter} Page ${cell.pageNumber} After` })}
                                          />
                                          <div className="bg-gray-900 rounded">
                                            <img
                                              src={cell.diff}
                                              alt={`${cell.letter} diff`}
                                              className="w-full h-auto rounded cursor-pointer hover:opacity-80"
                                              onClick={() => cell.diff && setEnlargedImage({ src: cell.diff, title: `${grid.entityName} - Cell ${cell.letter} Page ${cell.pageNumber} Diff` })}
                                            />
                                          </div>
                                        </div>
                                      ))}
                                    </div>
                                  ) : finalChecksReport.entityRepairs?.[grid.entityName]?.pages && Object.keys(finalChecksReport.entityRepairs[grid.entityName]?.pages || {}).length > 0 ? (
                                    /* Single-page repairs: show individual page comparisons */
                                    <div className="space-y-2">
                                      <div className="grid grid-cols-4 gap-1 text-[10px] font-medium text-gray-500 px-1">
                                        <span>Page</span>
                                        <span>Before</span>
                                        <span>After</span>
                                        <span>Diff</span>
                                      </div>
                                      {Object.entries(finalChecksReport.entityRepairs[grid.entityName]?.pages || {}).map(([pageNum, pageData]) => (
                                        <div key={pageNum} className="grid grid-cols-4 gap-1 items-center bg-gray-50 rounded p-1">
                                          <div className="text-center">
                                            <span className="text-xs font-bold text-gray-700">P{pageNum}</span>
                                            {pageData.clothingCategory && pageData.clothingCategory !== 'standard' && (
                                              <div className="text-[8px] text-gray-400">{pageData.clothingCategory}</div>
                                            )}
                                          </div>
                                          <img
                                            src={pageData.comparison?.before}
                                            alt={`P${pageNum} before`}
                                            className="w-full h-auto rounded cursor-pointer hover:opacity-80"
                                            onClick={() => pageData.comparison?.before && setEnlargedImage({ src: pageData.comparison.before, title: `${grid.entityName} - Page ${pageNum} Before${pageData.clothingCategory ? ` (${pageData.clothingCategory})` : ''}` })}
                                          />
                                          <img
                                            src={pageData.comparison?.after}
                                            alt={`P${pageNum} after`}
                                            className="w-full h-auto rounded cursor-pointer hover:opacity-80"
                                            onClick={() => pageData.comparison?.after && setEnlargedImage({ src: pageData.comparison.after, title: `${grid.entityName} - Page ${pageNum} After${pageData.clothingCategory ? ` (${pageData.clothingCategory})` : ''}` })}
                                          />
                                          <div className="bg-gray-900 rounded">
                                            <img
                                              src={pageData.comparison?.diff}
                                              alt={`P${pageNum} diff`}
                                              className="w-full h-auto rounded cursor-pointer hover:opacity-80"
                                              onClick={() => pageData.comparison?.diff && setEnlargedImage({ src: pageData.comparison.diff, title: `${grid.entityName} - Page ${pageNum} Diff${pageData.clothingCategory ? ` (${pageData.clothingCategory})` : ''}` })}
                                            />
                                          </div>
                                        </div>
                                      ))}
                                    </div>
                                  ) : finalChecksReport.entityRepairs?.[grid.entityName]?.gridBeforeRepair ? (
                                    /* Fallback to full grid comparison for oldest repairs */
                                    <div className={`grid gap-3 ${finalChecksReport.entityRepairs?.[grid.entityName]?.gridDiff ? 'grid-cols-3' : 'grid-cols-2'}`}>
                                      <div className="space-y-1">
                                        <span className="text-[10px] font-medium text-gray-500">Before Repair</span>
                                        <div className="bg-gray-50 rounded p-1">
                                          <img
                                            src={finalChecksReport.entityRepairs?.[grid.entityName]?.gridBeforeRepair}
                                            alt="Before repair"
                                            className="w-full h-auto rounded"
                                          />
                                        </div>
                                      </div>
                                      <div className="space-y-1">
                                        <span className="text-[10px] font-medium text-gray-500">After Repair</span>
                                        <div className="bg-gray-50 rounded p-1">
                                          <img
                                            src={finalChecksReport.entityRepairs?.[grid.entityName]?.gridAfterRepair}
                                            alt="After repair"
                                            className="w-full h-auto rounded"
                                          />
                                        </div>
                                      </div>
                                      {finalChecksReport.entityRepairs?.[grid.entityName]?.gridDiff && (
                                        <div className="space-y-1">
                                          <span className="text-[10px] font-medium text-gray-500">Difference</span>
                                          <div className="bg-gray-900 rounded p-1">
                                            <img
                                              src={finalChecksReport.entityRepairs?.[grid.entityName]?.gridDiff ?? undefined}
                                              alt="Difference"
                                              className="w-full h-auto rounded"
                                            />
                                          </div>
                                        </div>
                                      )}
                                    </div>
                                  ) : null}
                                </div>
                              )}
                            </div>
                          </details>
                        );
                      })}
                    </div>

                    {/* Entity check summary */}
                    <div className="text-xs text-gray-500 mt-2">
                      {finalChecksReport.entity.summary}
                    </div>
                  </div>
                )}

                {/* Text Check */}
                {finalChecksReport.textCheck && (
                  <div className="space-y-3">
                    <h4 className="font-semibold text-sm text-gray-800">
                      {language === 'de' ? 'Textqualität' : language === 'fr' ? 'Qualité du texte' : 'Text Quality'}
                    </h4>
                    <div className="bg-white border border-gray-200 rounded-lg p-3">
                      <div className="flex items-center gap-2 mb-2">
                        <span className={`text-sm font-medium ${
                          finalChecksReport.textCheck.quality === 'good' ? 'text-green-600' :
                          finalChecksReport.textCheck.quality === 'needs_review' ? 'text-amber-600' :
                          'text-red-600'
                        }`}>
                          {finalChecksReport.textCheck.quality === 'good' ? '✓' : '⚠️'}
                        </span>
                        <span className="text-sm font-semibold text-gray-700">
                          {finalChecksReport.textCheck.quality === 'good' ? 'Good' :
                           finalChecksReport.textCheck.quality === 'needs_review' ? 'Needs Review' :
                           'Has Issues'}
                        </span>
                        {finalChecksReport.textCheck.overallScore !== undefined && (
                          <span className="ml-auto text-xs bg-gray-100 px-2 py-0.5 rounded">
                            Score: {finalChecksReport.textCheck.overallScore}/10
                          </span>
                        )}
                      </div>
                      {finalChecksReport.textCheck.issues && finalChecksReport.textCheck.issues.length > 0 && (
                        <div className="space-y-2 mt-2">
                          {finalChecksReport.textCheck.issues.map((issue, issueIdx) => (
                            <div key={issueIdx} className={`text-xs p-2 rounded ${
                              issue.severity === 'high' ? 'bg-red-50 border-l-4 border-red-400' :
                              issue.severity === 'medium' ? 'bg-amber-50 border-l-4 border-amber-400' :
                              'bg-gray-50 border-l-4 border-gray-300'
                            }`}>
                              <div className="flex items-start gap-2 flex-wrap">
                                <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                                  issue.severity === 'high' ? 'bg-red-200 text-red-800' :
                                  issue.severity === 'medium' ? 'bg-amber-200 text-amber-800' :
                                  'bg-gray-200 text-gray-700'
                                }`}>
                                  {issue.severity}
                                </span>
                                {issue.page && (
                                  <span className="text-gray-500">Page {issue.page}</span>
                                )}
                                <span className="px-1.5 py-0.5 bg-blue-100 text-blue-700 rounded text-[10px]">
                                  {issue.type}
                                </span>
                              </div>
                              <p className="text-gray-700 mt-1">{issue.issue}</p>
                              {/* Show original text (new field or legacy field) */}
                              {(issue.originalText || issue.text) && (
                                <p className="text-red-600 mt-1 line-through">
                                  "{issue.originalText || issue.text}"
                                </p>
                              )}
                              {/* Show corrected text if available */}
                              {issue.correctedText && (
                                <p className="text-green-700 mt-1 font-medium">
                                  ✓ "{issue.correctedText}"
                                </p>
                              )}
                              {/* Fallback to suggestion if no correctedText */}
                              {!issue.correctedText && issue.suggestion && (
                                <p className="text-green-700 mt-1">→ {issue.suggestion}</p>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                      {finalChecksReport.textCheck.summary && (
                        <p className="text-xs text-gray-500 mt-2 italic">{finalChecksReport.textCheck.summary}</p>
                      )}
                      {/* Full original text (collapsible) */}
                      {finalChecksReport.textCheck.fullOriginalText && (
                        <details className="mt-3 bg-gray-50 border border-gray-200 rounded p-2">
                          <summary className="cursor-pointer text-xs font-medium text-gray-700">
                            📄 View Original Text
                          </summary>
                          <pre className="mt-2 text-xs text-gray-600 whitespace-pre-wrap font-sans max-h-[500px] overflow-y-auto">
                            {finalChecksReport.textCheck.fullOriginalText}
                          </pre>
                        </details>
                      )}
                      {/* Full corrected text (collapsible) */}
                      {finalChecksReport.textCheck.fullCorrectedText && (
                        <details className="mt-3 bg-green-50 border border-green-200 rounded p-2">
                          <summary className="cursor-pointer text-xs font-medium text-green-800">
                            📋 View Full Corrected Text
                          </summary>
                          <pre className="mt-2 text-xs text-gray-700 whitespace-pre-wrap font-sans max-h-[500px] overflow-y-auto">
                            {finalChecksReport.textCheck.fullCorrectedText}
                          </pre>
                        </details>
                      )}
                      {/* Raw API response (collapsible) - for debugging */}
                      {finalChecksReport.textCheck.rawResponse && (
                        <details className="mt-3 bg-purple-50 border border-purple-200 rounded p-2">
                          <summary className="cursor-pointer text-xs font-medium text-purple-800">
                            📝 View Raw Response
                          </summary>
                          <pre className="mt-2 text-xs text-gray-700 whitespace-pre-wrap font-sans max-h-[500px] overflow-y-auto">
                            {finalChecksReport.textCheck.rawResponse}
                          </pre>
                        </details>
                      )}
                      {/* Parsed JSON result (collapsible) - for debugging */}
                      {finalChecksReport.textCheck && (
                        <details className="mt-3 bg-indigo-50 border border-indigo-200 rounded p-2">
                          <summary className="cursor-pointer text-xs font-medium text-indigo-800">
                            🔧 View Parsed Result
                          </summary>
                          <pre className="mt-2 text-xs text-gray-700 whitespace-pre-wrap font-sans max-h-[500px] overflow-y-auto">
                            {JSON.stringify({
                              quality: finalChecksReport.textCheck.quality,
                              overallScore: finalChecksReport.textCheck.overallScore,
                              issues: finalChecksReport.textCheck.issues,
                              summary: finalChecksReport.textCheck.summary,
                              parseError: finalChecksReport.textCheck.parseError
                            }, null, 2)}
                          </pre>
                        </details>
                      )}
                      {/* Evaluation prompt (collapsible) - for debugging */}
                      {finalChecksReport.textCheck.evaluationPrompt && (
                        <details className="mt-3 bg-blue-50 border border-blue-200 rounded p-2">
                          <summary className="cursor-pointer text-xs font-medium text-blue-800">
                            🔍 View Evaluation Prompt
                          </summary>
                          <pre className="mt-2 text-xs text-gray-700 whitespace-pre-wrap font-sans max-h-[500px] overflow-y-auto">
                            {finalChecksReport.textCheck.evaluationPrompt}
                          </pre>
                        </details>
                      )}
                    </div>
                  </div>
                )}

                {/* Error message if checks failed */}
                {finalChecksReport.error && (
                  <div className="bg-red-50 border border-red-200 rounded p-2 text-xs text-red-700">
                    Error: {finalChecksReport.error}
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
                        <pre className="text-gray-700 mt-1 whitespace-pre-wrap font-mono text-xs overflow-x-auto">
                          {(() => {
                            // Pretty-print JSON for readability
                            if (typeof scene.description === 'string') {
                              // Try to parse and format if it's a JSON string
                              try {
                                const parsed = JSON.parse(scene.description);
                                return JSON.stringify(parsed, null, 2);
                              } catch {
                                return scene.description;
                              }
                            }
                            // If it's an object, format it nicely
                            if (typeof scene.description === 'object') {
                              const desc = scene.description as { text?: string };
                              if (desc?.text) {
                                try {
                                  const parsed = JSON.parse(desc.text);
                                  return JSON.stringify(parsed, null, 2);
                                } catch {
                                  return desc.text;
                                }
                              }
                              return JSON.stringify(scene.description, null, 2);
                            }
                            return String(scene.description);
                          })()}
                        </pre>
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
            <div className="relative">
              <DiagnosticImage
                src={getCoverImageData(coverImages.frontCover)!}
                alt="Front Cover"
                className="w-full rounded-lg shadow-lg"
                label="Front Cover"
              />
              {regeneratingCovers.has('frontCover') && (
                <div className="absolute inset-0 bg-white/50 flex items-center justify-center rounded-lg">
                  <Loader2 className="w-10 h-10 animate-spin text-indigo-600" />
                </div>
              )}
            </div>
            {/* Regenerate Cover - visible to all users */}
            {_onRegenerateCover && (
              <div className="mt-3">
                <button
                  onClick={() => openCoverEditModal('front')}
                  disabled={isGenerating || !hasEnoughCredits || regeneratingCovers.has('frontCover')}
                  className={`w-full bg-indigo-500 text-white px-3 py-2 rounded-lg flex items-center justify-center gap-2 text-sm font-semibold ${
                    isGenerating || !hasEnoughCredits || regeneratingCovers.has('frontCover') ? 'opacity-50 cursor-not-allowed' : 'hover:bg-indigo-600'
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
                      {(() => {
                        const desc = frontCoverObj.description;
                        if (typeof desc === 'string') {
                          try { return JSON.stringify(JSON.parse(desc), null, 2); } catch { return desc; }
                        }
                        if (typeof desc === 'object') {
                          const d = desc as { text?: string };
                          if (d?.text) {
                            try { return JSON.stringify(JSON.parse(d.text), null, 2); } catch { return d.text; }
                          }
                          return JSON.stringify(desc, null, 2);
                        }
                        return String(desc);
                      })()}
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
                    <pre className="mt-2 text-xs text-gray-700 whitespace-pre-wrap font-mono bg-white p-3 rounded border border-gray-200 overflow-x-auto max-h-[500px] overflow-y-auto">
                      {frontCoverObj.prompt}
                    </pre>
                  </details>
                )}

                {/* Reference Photos */}
                {((frontCoverObj.referencePhotos?.length ?? 0) > 0 || (frontCoverObj.landmarkPhotos?.length ?? 0) > 0 || frontCoverObj.visualBibleGrid) && (
                  <ReferencePhotosDisplay
                    referencePhotos={frontCoverObj.referencePhotos || []}
                    landmarkPhotos={frontCoverObj.landmarkPhotos}
                    visualBibleGrid={frontCoverObj.visualBibleGrid}
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

                {/* Object Detection for Cover */}
                <ObjectDetectionDisplay
                  retryHistory={frontCoverObj.retryHistory}
                  bboxDetection={frontCoverObj.bboxDetection}
                  bboxOverlayImage={frontCoverObj.bboxOverlayImage}
                  language={language}
                  storyId={storyId}
                  pageNumber={0}
                />

                {/* Retry History */}
                {frontCoverObj.retryHistory && frontCoverObj.retryHistory.length > 0 && (
                  <RetryHistoryDisplay
                    retryHistory={frontCoverObj.retryHistory}
                    totalAttempts={frontCoverObj.totalAttempts || frontCoverObj.retryHistory.length}
                    language={language}
                  />
                )}

                {/* Previous / Original Image */}
                {frontCoverObj.previousImage && (
                  <details className="bg-orange-50 border border-orange-300 rounded-lg p-3">
                    <summary className="cursor-pointer text-sm font-semibold text-orange-800 hover:text-orange-900">
                      {language === 'de' ? 'Vorherige Version' : language === 'fr' ? 'Version précédente' : 'Previous Version'}
                      {frontCoverObj.previousScore !== undefined && (
                        <span className="ml-2 text-xs font-normal text-orange-600">({Math.round(frontCoverObj.previousScore)}%)</span>
                      )}
                    </summary>
                    <div className="mt-2">
                      <img
                        src={frontCoverObj.previousImage}
                        alt="Previous version"
                        className="w-full rounded border-2 border-orange-200 opacity-75"
                      />
                    </div>
                  </details>
                )}
                {frontCoverObj.originalImage && frontCoverObj.originalImage !== frontCoverObj.previousImage && (
                  <details className="bg-amber-50 border border-amber-300 rounded-lg p-3">
                    <summary className="cursor-pointer text-sm font-semibold text-amber-800 hover:text-amber-900">
                      {language === 'de' ? 'Originalbild' : language === 'fr' ? 'Image originale' : 'Original Image'}
                      {frontCoverObj.originalScore !== undefined && (
                        <span className="ml-2 text-xs font-normal text-amber-600">({Math.round(frontCoverObj.originalScore)}%)</span>
                      )}
                    </summary>
                    <div className="mt-2">
                      <img
                        src={frontCoverObj.originalImage}
                        alt="Original version"
                        className="w-full rounded border-2 border-amber-200 opacity-75"
                      />
                    </div>
                  </details>
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
            <div className="relative">
              <DiagnosticImage
                src={getCoverImageData(coverImages.initialPage)!}
                alt="Dedication Page"
                className="w-full rounded-lg shadow-lg"
                label="Dedication Page"
              />
              {regeneratingCovers.has('initialPage') && (
                <div className="absolute inset-0 bg-white/50 flex items-center justify-center rounded-lg">
                  <Loader2 className="w-10 h-10 animate-spin text-indigo-600" />
                </div>
              )}
            </div>
            {/* Regenerate Cover - visible to all users */}
            {_onRegenerateCover && (
              <div className="mt-3">
                <button
                  onClick={() => openCoverEditModal('initial')}
                  disabled={isGenerating || !hasEnoughCredits || regeneratingCovers.has('initialPage')}
                  className={`w-full bg-indigo-500 text-white px-3 py-2 rounded-lg flex items-center justify-center gap-2 text-sm font-semibold ${
                    isGenerating || !hasEnoughCredits || regeneratingCovers.has('initialPage') ? 'opacity-50 cursor-not-allowed' : 'hover:bg-indigo-600'
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
                      {(() => {
                        const desc = initialPageObj.description;
                        if (typeof desc === 'string') {
                          try { return JSON.stringify(JSON.parse(desc), null, 2); } catch { return desc; }
                        }
                        if (typeof desc === 'object') {
                          const d = desc as { text?: string };
                          if (d?.text) {
                            try { return JSON.stringify(JSON.parse(d.text), null, 2); } catch { return d.text; }
                          }
                          return JSON.stringify(desc, null, 2);
                        }
                        return String(desc);
                      })()}
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
                    <pre className="mt-2 text-xs text-gray-700 whitespace-pre-wrap font-mono bg-white p-3 rounded border border-gray-200 overflow-x-auto max-h-[500px] overflow-y-auto">
                      {initialPageObj.prompt}
                    </pre>
                  </details>
                )}

                {/* Reference Photos */}
                {((initialPageObj.referencePhotos?.length ?? 0) > 0 || (initialPageObj.landmarkPhotos?.length ?? 0) > 0 || initialPageObj.visualBibleGrid) && (
                  <ReferencePhotosDisplay
                    referencePhotos={initialPageObj.referencePhotos || []}
                    landmarkPhotos={initialPageObj.landmarkPhotos}
                    visualBibleGrid={initialPageObj.visualBibleGrid}
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

                {/* Object Detection for Cover */}
                <ObjectDetectionDisplay
                  retryHistory={initialPageObj.retryHistory}
                  bboxDetection={initialPageObj.bboxDetection}
                  bboxOverlayImage={initialPageObj.bboxOverlayImage}
                  language={language}
                  storyId={storyId}
                  pageNumber={-1}
                />

                {/* Retry History */}
                {initialPageObj.retryHistory && initialPageObj.retryHistory.length > 0 && (
                  <RetryHistoryDisplay
                    retryHistory={initialPageObj.retryHistory}
                    totalAttempts={initialPageObj.totalAttempts || initialPageObj.retryHistory.length}
                    language={language}
                  />
                )}

                {/* Previous / Original Image */}
                {initialPageObj.previousImage && (
                  <details className="bg-orange-50 border border-orange-300 rounded-lg p-3">
                    <summary className="cursor-pointer text-sm font-semibold text-orange-800 hover:text-orange-900">
                      {language === 'de' ? 'Vorherige Version' : language === 'fr' ? 'Version précédente' : 'Previous Version'}
                      {initialPageObj.previousScore !== undefined && (
                        <span className="ml-2 text-xs font-normal text-orange-600">({Math.round(initialPageObj.previousScore)}%)</span>
                      )}
                    </summary>
                    <div className="mt-2">
                      <img
                        src={initialPageObj.previousImage}
                        alt="Previous version"
                        className="w-full rounded border-2 border-orange-200 opacity-75"
                      />
                    </div>
                  </details>
                )}
                {initialPageObj.originalImage && initialPageObj.originalImage !== initialPageObj.previousImage && (
                  <details className="bg-amber-50 border border-amber-300 rounded-lg p-3">
                    <summary className="cursor-pointer text-sm font-semibold text-amber-800 hover:text-amber-900">
                      {language === 'de' ? 'Originalbild' : language === 'fr' ? 'Image originale' : 'Original Image'}
                      {initialPageObj.originalScore !== undefined && (
                        <span className="ml-2 text-xs font-normal text-amber-600">({Math.round(initialPageObj.originalScore)}%)</span>
                      )}
                    </summary>
                    <div className="mt-2">
                      <img
                        src={initialPageObj.originalImage}
                        alt="Original version"
                        className="w-full rounded border-2 border-amber-200 opacity-75"
                      />
                    </div>
                  </details>
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
                          className={`w-full rounded-lg shadow-md object-cover ${regeneratingPages.has(pageNumber) ? 'opacity-50' : ''}`}
                          label={`Page ${pageNumber}`}
                        />
                        {/* Regenerating spinner overlay */}
                        {regeneratingPages.has(pageNumber) && (
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
                                disabled={isGenerating || regeneratingPages.has(pageNumber) || !hasEnoughCredits}
                                className={`flex-1 bg-indigo-500 text-white px-3 py-2 rounded-lg flex items-center justify-center gap-2 text-sm font-semibold ${
                                  isGenerating || regeneratingPages.has(pageNumber) || !hasEnoughCredits ? 'opacity-50 cursor-not-allowed' : 'hover:bg-indigo-600'
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

                            {/* Next Iteration button - dev only */}
                            {onIteratePage && (
                              <button
                                onClick={() => handleIteratePage(pageNumber)}
                                disabled={isGenerating || iteratingPage !== null || repairingPage !== null}
                                className={`w-full bg-purple-500 text-white px-3 py-2 rounded-lg flex items-center justify-center gap-2 text-sm font-semibold ${
                                  isGenerating || iteratingPage !== null || repairingPage !== null ? 'opacity-50 cursor-not-allowed' : 'hover:bg-purple-600'
                                }`}
                                title={language === 'de' ? 'Bild analysieren, 17 Checks durchführen, mit korrigierter Szene neu generieren' : language === 'fr' ? 'Analyser l\'image, exécuter 17 vérifications, régénérer avec scène corrigée' : 'Analyze image, run 17 checks, regenerate with corrected scene'}
                              >
                                {iteratingPage === pageNumber ? (
                                  <>
                                    <Loader size={14} className="animate-spin" />
                                    {language === 'de' ? 'Iteriere...' : language === 'fr' ? 'Itération...' : 'Iterating...'}
                                  </>
                                ) : (
                                  <>
                                    <RotateCcw size={14} />
                                    {language === 'de' ? 'Nächste Iteration' : language === 'fr' ? 'Prochaine Itération' : 'Next Iteration'}
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
                                            <div
                                              className="flex gap-4 cursor-pointer p-2 -m-2 rounded-lg hover:bg-amber-100 transition-colors"
                                              onClick={() => setRepairComparison({
                                                beforeImage: repair.beforeImage!,
                                                afterImage: repair.afterImage!,
                                                diffImage: repair.diffImage,
                                                title: language === 'de' ? `Reparatur ${repair.attempt}` : `Repair ${repair.attempt}`
                                              })}
                                              title={language === 'de' ? 'Klicken für Vergleichsansicht' : 'Click to compare'}
                                            >
                                              <div>
                                                <strong className="block mb-1 text-xs">{language === 'de' ? 'Vorher:' : 'Before:'}</strong>
                                                <img
                                                  src={repair.beforeImage}
                                                  alt="Before repair"
                                                  className="w-32 h-32 object-contain border rounded bg-gray-100"
                                                />
                                              </div>
                                              <div>
                                                <strong className="block mb-1 text-xs">{language === 'de' ? 'Nachher:' : 'After:'}</strong>
                                                <img
                                                  src={repair.afterImage}
                                                  alt="After repair"
                                                  className="w-32 h-32 object-contain border rounded bg-gray-100"
                                                />
                                              </div>
                                              {repair.diffImage && (
                                                <div>
                                                  <strong className="block mb-1 text-xs">Diff:</strong>
                                                  <img
                                                    src={repair.diffImage}
                                                    alt="Difference"
                                                    className="w-32 h-32 object-contain border rounded bg-gray-100"
                                                  />
                                                </div>
                                              )}
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
                                <pre className="mt-2 text-xs text-gray-700 whitespace-pre-wrap font-mono bg-white p-3 rounded border border-gray-200 overflow-x-auto max-h-[500px] overflow-y-auto">
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
                                <pre className="mt-2 text-xs text-gray-700 whitespace-pre-wrap font-mono bg-white p-3 rounded border border-gray-200 overflow-x-auto max-h-[500px] overflow-y-auto">
                                  {image?.prompt}
                                </pre>
                              </details>
                            )}

                            {/* Reference Photos */}
                            {((image?.referencePhotos?.length ?? 0) > 0 || (image?.landmarkPhotos?.length ?? 0) > 0 || image?.visualBibleGrid) && image && (
                              <ReferencePhotosDisplay
                                referencePhotos={image.referencePhotos || []}
                                landmarkPhotos={image.landmarkPhotos}
                                visualBibleGrid={image.visualBibleGrid}
                                language={language}
                                storyId={storyId || undefined}
                                pageNumber={pageNumber}
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

                            {/* Object Detection (separate from retry history for visibility) */}
                            <ObjectDetectionDisplay
                              retryHistory={image?.retryHistory}
                              language={language}
                              storyId={storyId}
                              pageNumber={image?.pageNumber}
                            />

                            {/* Retry History (shows all attempts with images) */}
                            {image?.retryHistory && image.retryHistory.length > 0 && (
                              <RetryHistoryDisplay
                                retryHistory={image.retryHistory}
                                totalAttempts={image?.totalAttempts || image.retryHistory.length}
                                language={language}
                                onRevertRepair={onRevertRepair ? (_idx, beforeImage) => onRevertRepair(image.pageNumber, beforeImage) : undefined}
                                storyId={storyId}
                                pageNumber={image.pageNumber}
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
                            className={`w-full rounded-lg shadow-md object-cover ${regeneratingPages.has(pageNumber) ? 'opacity-50' : ''}`}
                          />
                          {/* Regenerating spinner overlay */}
                          {regeneratingPages.has(pageNumber) && (
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
                                disabled={isGenerating || regeneratingPages.has(pageNumber) || !hasEnoughCredits}
                                className={`flex-1 bg-indigo-500 text-white px-3 py-2 rounded-lg flex items-center justify-center gap-2 text-sm font-semibold ${
                                  isGenerating || regeneratingPages.has(pageNumber) || !hasEnoughCredits ? 'opacity-50 cursor-not-allowed' : 'hover:bg-indigo-600'
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

                            {/* Next Iteration button - dev only */}
                            {onIteratePage && (
                              <button
                                onClick={() => handleIteratePage(pageNumber)}
                                disabled={isGenerating || iteratingPage !== null || repairingPage !== null}
                                className={`w-full bg-purple-500 text-white px-3 py-2 rounded-lg flex items-center justify-center gap-2 text-sm font-semibold ${
                                  isGenerating || iteratingPage !== null || repairingPage !== null ? 'opacity-50 cursor-not-allowed' : 'hover:bg-purple-600'
                                }`}
                                title={language === 'de' ? 'Bild analysieren, 17 Checks durchführen, mit korrigierter Szene neu generieren' : language === 'fr' ? 'Analyser l\'image, exécuter 17 vérifications, régénérer avec scène corrigée' : 'Analyze image, run 17 checks, regenerate with corrected scene'}
                              >
                                {iteratingPage === pageNumber ? (
                                  <>
                                    <Loader size={14} className="animate-spin" />
                                    {language === 'de' ? 'Iteriere...' : language === 'fr' ? 'Itération...' : 'Iterating...'}
                                  </>
                                ) : (
                                  <>
                                    <RotateCcw size={14} />
                                    {language === 'de' ? 'Nächste Iteration' : language === 'fr' ? 'Prochaine Itération' : 'Next Iteration'}
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
                                            <div
                                              className="flex gap-4 cursor-pointer p-2 -m-2 rounded-lg hover:bg-amber-100 transition-colors"
                                              onClick={() => setRepairComparison({
                                                beforeImage: repair.beforeImage!,
                                                afterImage: repair.afterImage!,
                                                diffImage: repair.diffImage,
                                                title: language === 'de' ? `Reparatur ${repair.attempt}` : `Repair ${repair.attempt}`
                                              })}
                                              title={language === 'de' ? 'Klicken für Vergleichsansicht' : 'Click to compare'}
                                            >
                                              <div>
                                                <strong className="block mb-1 text-xs">{language === 'de' ? 'Vorher:' : 'Before:'}</strong>
                                                <img
                                                  src={repair.beforeImage}
                                                  alt="Before repair"
                                                  className="w-32 h-32 object-contain border rounded bg-gray-100"
                                                />
                                              </div>
                                              <div>
                                                <strong className="block mb-1 text-xs">{language === 'de' ? 'Nachher:' : 'After:'}</strong>
                                                <img
                                                  src={repair.afterImage}
                                                  alt="After repair"
                                                  className="w-32 h-32 object-contain border rounded bg-gray-100"
                                                />
                                              </div>
                                              {repair.diffImage && (
                                                <div>
                                                  <strong className="block mb-1 text-xs">Diff:</strong>
                                                  <img
                                                    src={repair.diffImage}
                                                    alt="Difference"
                                                    className="w-32 h-32 object-contain border rounded bg-gray-100"
                                                  />
                                                </div>
                                              )}
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
                                <pre className="mt-2 text-xs text-gray-700 whitespace-pre-wrap font-mono bg-white p-3 rounded border border-gray-200 overflow-x-auto max-h-[500px] overflow-y-auto">
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
                                <pre className="mt-2 text-xs text-gray-700 whitespace-pre-wrap font-mono bg-white p-3 rounded border border-gray-200 overflow-x-auto max-h-[500px] overflow-y-auto">
                                  {image.prompt}
                                </pre>
                              </details>
                            )}

                            {/* Reference Photos */}
                            {((image.referencePhotos?.length ?? 0) > 0 || (image.landmarkPhotos?.length ?? 0) > 0 || image.visualBibleGrid) && (
                              <ReferencePhotosDisplay
                                referencePhotos={image.referencePhotos || []}
                                landmarkPhotos={image.landmarkPhotos}
                                visualBibleGrid={image.visualBibleGrid}
                                language={language}
                                storyId={storyId || undefined}
                                pageNumber={pageNumber}
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

                            {/* Object Detection (separate from retry history for visibility) */}
                            <ObjectDetectionDisplay
                              retryHistory={image.retryHistory}
                              language={language}
                              storyId={storyId}
                              pageNumber={image.pageNumber}
                            />

                            {/* Retry History (shows all attempts with images) */}
                            {image.retryHistory && image.retryHistory.length > 0 && (
                              <RetryHistoryDisplay
                                retryHistory={image.retryHistory}
                                totalAttempts={image.totalAttempts || image.retryHistory.length}
                                language={language}
                                onRevertRepair={onRevertRepair ? (_idx, beforeImage) => onRevertRepair(image.pageNumber, beforeImage) : undefined}
                                storyId={storyId}
                                pageNumber={image.pageNumber}
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

          {/* Progressive mode loading indicator removed - each image placeholder already shows its own loading state */}
        </div>
      )}

      {/* Removed "Weitere Seiten werden erstellt" - each page's image placeholder already shows loading state */}

      {/* Back Cover Display - show as soon as available */}
      {coverImages && getCoverImageData(coverImages.backCover) && (() => {
        const backCoverObj = getCoverObject(coverImages.backCover);
        return (
          <div className="mt-8 max-w-2xl mx-auto">
            <p className="text-sm text-gray-500 text-center mb-2">
              {storyLang === 'de' ? 'Rückseite' : storyLang === 'fr' ? 'Quatrième de couverture' : 'Back Cover'}
            </p>
            <div className="relative">
              <DiagnosticImage
                src={getCoverImageData(coverImages.backCover)!}
                alt="Back Cover"
                className="w-full rounded-lg shadow-lg"
                label="Back Cover"
              />
              {regeneratingCovers.has('backCover') && (
                <div className="absolute inset-0 bg-white/50 flex items-center justify-center rounded-lg">
                  <Loader2 className="w-10 h-10 animate-spin text-indigo-600" />
                </div>
              )}
            </div>
            {/* Regenerate Cover - visible to all users */}
            {_onRegenerateCover && (
              <div className="mt-3">
                <button
                  onClick={() => openCoverEditModal('back')}
                  disabled={isGenerating || !hasEnoughCredits || regeneratingCovers.has('backCover')}
                  className={`w-full bg-indigo-500 text-white px-3 py-2 rounded-lg flex items-center justify-center gap-2 text-sm font-semibold ${
                    isGenerating || !hasEnoughCredits || regeneratingCovers.has('backCover') ? 'opacity-50 cursor-not-allowed' : 'hover:bg-indigo-600'
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
                      {(() => {
                        const desc = backCoverObj.description;
                        if (typeof desc === 'string') {
                          try { return JSON.stringify(JSON.parse(desc), null, 2); } catch { return desc; }
                        }
                        if (typeof desc === 'object') {
                          const d = desc as { text?: string };
                          if (d?.text) {
                            try { return JSON.stringify(JSON.parse(d.text), null, 2); } catch { return d.text; }
                          }
                          return JSON.stringify(desc, null, 2);
                        }
                        return String(desc);
                      })()}
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
                    <pre className="mt-2 text-xs text-gray-700 whitespace-pre-wrap font-mono bg-white p-3 rounded border border-gray-200 overflow-x-auto max-h-[500px] overflow-y-auto">
                      {backCoverObj.prompt}
                    </pre>
                  </details>
                )}

                {/* Reference Photos */}
                {((backCoverObj.referencePhotos?.length ?? 0) > 0 || (backCoverObj.landmarkPhotos?.length ?? 0) > 0 || backCoverObj.visualBibleGrid) && (
                  <ReferencePhotosDisplay
                    referencePhotos={backCoverObj.referencePhotos || []}
                    landmarkPhotos={backCoverObj.landmarkPhotos}
                    visualBibleGrid={backCoverObj.visualBibleGrid}
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

                {/* Object Detection for Cover */}
                <ObjectDetectionDisplay
                  retryHistory={backCoverObj.retryHistory}
                  bboxDetection={backCoverObj.bboxDetection}
                  bboxOverlayImage={backCoverObj.bboxOverlayImage}
                  language={language}
                  storyId={storyId}
                  pageNumber={-2}
                />

                {/* Retry History */}
                {backCoverObj.retryHistory && backCoverObj.retryHistory.length > 0 && (
                  <RetryHistoryDisplay
                    retryHistory={backCoverObj.retryHistory}
                    totalAttempts={backCoverObj.totalAttempts || backCoverObj.retryHistory.length}
                    language={language}
                  />
                )}

                {/* Previous / Original Image */}
                {backCoverObj.previousImage && (
                  <details className="bg-orange-50 border border-orange-300 rounded-lg p-3">
                    <summary className="cursor-pointer text-sm font-semibold text-orange-800 hover:text-orange-900">
                      {language === 'de' ? 'Vorherige Version' : language === 'fr' ? 'Version précédente' : 'Previous Version'}
                      {backCoverObj.previousScore !== undefined && (
                        <span className="ml-2 text-xs font-normal text-orange-600">({Math.round(backCoverObj.previousScore)}%)</span>
                      )}
                    </summary>
                    <div className="mt-2">
                      <img
                        src={backCoverObj.previousImage}
                        alt="Previous version"
                        className="w-full rounded border-2 border-orange-200 opacity-75"
                      />
                    </div>
                  </details>
                )}
                {backCoverObj.originalImage && backCoverObj.originalImage !== backCoverObj.previousImage && (
                  <details className="bg-amber-50 border border-amber-300 rounded-lg p-3">
                    <summary className="cursor-pointer text-sm font-semibold text-amber-800 hover:text-amber-900">
                      {language === 'de' ? 'Originalbild' : language === 'fr' ? 'Image originale' : 'Original Image'}
                      {backCoverObj.originalScore !== undefined && (
                        <span className="ml-2 text-xs font-normal text-amber-600">({Math.round(backCoverObj.originalScore)}%)</span>
                      )}
                    </summary>
                    <div className="mt-2">
                      <img
                        src={backCoverObj.originalImage}
                        alt="Original version"
                        className="w-full rounded border-2 border-amber-200 opacity-75"
                      />
                    </div>
                  </details>
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

            {/* PDF Download with Format Selector */}
            {onDownloadPdf && (
              <div className="relative">
                <button
                  onClick={() => setShowPdfFormatDropdown(!showPdfFormatDropdown)}
                  disabled={isGenerating}
                  className={`bg-indigo-500 text-white px-3 py-2 rounded-lg text-sm font-semibold flex items-center justify-center gap-1.5 w-full ${
                    isGenerating ? 'opacity-50 cursor-not-allowed' : 'hover:bg-indigo-600'
                  }`}
                >
                  <FileText size={16} />
                  {language === 'de' ? 'PDF herunterladen' : language === 'fr' ? 'Télécharger PDF' : 'Download PDF'}
                  <ChevronDown size={14} className={`transition-transform ${showPdfFormatDropdown ? 'rotate-180' : ''}`} />
                </button>
                {showPdfFormatDropdown && (
                  <div className="absolute top-full left-0 right-0 mt-1 bg-white rounded-lg shadow-lg border border-gray-200 z-50 overflow-hidden">
                    <div className="p-2 space-y-1">
                      <label className="flex items-center gap-2 p-2 hover:bg-gray-50 rounded cursor-pointer">
                        <input
                          type="radio"
                          name="pdfFormat2"
                          checked={pdfFormat === 'square'}
                          onChange={() => setPdfFormat('square')}
                          className="text-indigo-600"
                        />
                        <span className="text-sm text-gray-700">Square (20×20cm)</span>
                      </label>
                      <label className="flex items-center gap-2 p-2 hover:bg-gray-50 rounded cursor-pointer">
                        <input
                          type="radio"
                          name="pdfFormat2"
                          checked={pdfFormat === 'A4'}
                          onChange={() => setPdfFormat('A4')}
                          className="text-indigo-600"
                        />
                        <span className="text-sm text-gray-700">A4 (21×28cm)</span>
                      </label>
                    </div>
                    <button
                      onClick={() => {
                        onDownloadPdf(pdfFormat);
                        setShowPdfFormatDropdown(false);
                      }}
                      className="w-full py-2 bg-indigo-500 text-white text-sm font-semibold hover:bg-indigo-600"
                    >
                      {language === 'de' ? 'Herunterladen' : language === 'fr' ? 'Télécharger' : 'Download'}
                    </button>
                  </div>
                )}
              </div>
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
          isRegenerating={regeneratingPages.has(sceneEditModal.pageNumber)}
          imageRegenerationCost={imageRegenerationCost}
          characters={characters.map(c => ({ id: c.id, name: c.name }))}
          selectedCharacterIds={sceneEditModal.selectedCharacterIds}
          onCharacterSelectionChange={(ids) => setSceneEditModal({ ...sceneEditModal, selectedCharacterIds: ids })}
          consistencyRegen={developerMode ? sceneImages.find(img => img.pageNumber === sceneEditModal.pageNumber)?.consistencyRegen : undefined}
        />
      )}

      {/* Cover Edit Modal - for editing cover scene before regenerating */}
      {coverEditModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl max-w-2xl w-full shadow-2xl max-h-[90vh] overflow-y-auto">
            <div className="p-4 border-b border-gray-200">
              <h3 className="text-lg font-bold text-gray-800 flex items-center gap-2">
                <RefreshCw size={20} />
                {language === 'de' ? 'Cover bearbeiten' :
                 language === 'fr' ? 'Modifier la couverture' :
                 'Edit Cover'}
                {' - '}
                {coverEditModal.coverType === 'front'
                  ? (language === 'de' ? 'Titelseite' : language === 'fr' ? 'Couverture' : 'Front Cover')
                  : coverEditModal.coverType === 'initial'
                  ? (language === 'de' ? 'Einleitungsseite' : language === 'fr' ? 'Page de dédicace' : 'Dedication Page')
                  : (language === 'de' ? 'Rückseite' : language === 'fr' ? 'Dos' : 'Back Cover')}
              </h3>
              <p className="text-sm text-gray-500 mt-1">
                {language === 'de'
                  ? 'Bearbeite die Szenenbeschreibung und wähle die Charaktere aus'
                  : language === 'fr'
                  ? 'Modifiez la description de la scène et sélectionnez les personnages'
                  : 'Edit the scene description and select the characters'}
              </p>
            </div>
            <div className="p-4 space-y-4">
              {/* Character Selection */}
              {characters.length > 0 && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2 flex items-center gap-2">
                    <Users size={16} />
                    {language === 'de' ? 'Charaktere auf dem Cover:' :
                     language === 'fr' ? 'Personnages sur la couverture:' :
                     'Characters on the cover:'}
                  </label>
                  <div className="flex flex-wrap gap-2">
                    {characters.map((char) => {
                      const isSelected = coverEditModal.selectedCharacterIds.includes(char.id);
                      return (
                        <button
                          key={char.id}
                          type="button"
                          onClick={() => {
                            const newIds = isSelected
                              ? coverEditModal.selectedCharacterIds.filter(id => id !== char.id)
                              : [...coverEditModal.selectedCharacterIds, char.id];
                            setCoverEditModal({ ...coverEditModal, selectedCharacterIds: newIds });
                          }}
                          className={`flex items-center gap-2 px-3 py-2 rounded-lg border-2 transition-all ${
                            isSelected
                              ? 'border-indigo-500 bg-indigo-50 text-indigo-700'
                              : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300'
                          }`}
                        >
                          <span className="font-medium">{char.name}</span>
                          {isSelected && (
                            <span className="text-indigo-500">✓</span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                  <p className="text-xs text-gray-400 mt-2">
                    {language === 'de' ? 'Wähle die Charaktere aus, die auf dem Cover erscheinen sollen.' :
                     language === 'fr' ? 'Sélectionnez les personnages qui doivent apparaître sur la couverture.' :
                     'Select the characters that should appear on the cover.'}
                  </p>
                </div>
              )}

              {/* Title Input (Front Cover only) */}
              {coverEditModal.coverType === 'front' && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    {language === 'de' ? 'Titel:' :
                     language === 'fr' ? 'Titre:' :
                     'Title:'}
                  </label>
                  <input
                    type="text"
                    value={coverEditModal.title || ''}
                    onChange={(e) => setCoverEditModal({ ...coverEditModal, title: e.target.value })}
                    placeholder={language === 'de'
                      ? 'Der Titel des Buches'
                      : language === 'fr'
                      ? 'Le titre du livre'
                      : 'The book title'}
                    className="w-full p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                  />
                </div>
              )}

              {/* Dedication Input (Initial Page only) */}
              {coverEditModal.coverType === 'initial' && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    {language === 'de' ? 'Widmung:' :
                     language === 'fr' ? 'Dédicace:' :
                     'Dedication:'}
                  </label>
                  <input
                    type="text"
                    value={coverEditModal.dedication || ''}
                    onChange={(e) => setCoverEditModal({ ...coverEditModal, dedication: e.target.value })}
                    placeholder={language === 'de'
                      ? 'z.B. "Für meine liebste Tochter Emma"'
                      : language === 'fr'
                      ? 'par ex. "Pour ma chère fille Emma"'
                      : 'e.g. "For my dear daughter Emma"'}
                    className="w-full p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                  />
                  <p className="text-xs text-gray-400 mt-1">
                    {language === 'de' ? 'Leer lassen für keine Widmung' :
                     language === 'fr' ? 'Laisser vide pour aucune dédicace' :
                     'Leave empty for no dedication'}
                  </p>
                </div>
              )}

              {/* Scene Description */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  {language === 'de' ? 'Szenenbeschreibung:' :
                   language === 'fr' ? 'Description de la scène:' :
                   'Scene description:'}
                </label>
                <textarea
                  value={coverEditModal.scene}
                  onChange={(e) => setCoverEditModal({ ...coverEditModal, scene: e.target.value })}
                  placeholder={language === 'de'
                    ? 'z.B. "Die Hauptfigur steht vor einem magischen Schloss bei Sonnenuntergang"'
                    : language === 'fr'
                    ? 'par ex. "Le personnage principal devant un château magique au coucher du soleil"'
                    : 'e.g. "The main character standing in front of a magical castle at sunset"'}
                  className="w-full h-32 p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 resize-y"
                />
                <p className="text-xs text-gray-400 mt-2">
                  {language === 'de' ? 'Tipp: Beschreibe die Aktionen und die Umgebung. Die ausgewählten Charaktere werden automatisch hinzugefügt.' :
                   language === 'fr' ? 'Conseil: Décrivez les actions et l\'environnement. Les personnages sélectionnés seront ajoutés automatiquement.' :
                   'Tip: Describe the actions and the environment. Selected characters will be added automatically.'}
                </p>
              </div>
            </div>
            <div className="p-4 border-t border-gray-200 flex flex-col sm:flex-row sm:justify-between sm:items-center gap-3">
              <div className="text-sm text-gray-500 text-center sm:text-left">
                {coverEditModal.selectedCharacterIds.length > 0 && (
                  <span>
                    {language === 'de' ? `${coverEditModal.selectedCharacterIds.length} Charakter(e) ausgewählt` :
                     language === 'fr' ? `${coverEditModal.selectedCharacterIds.length} personnage(s) sélectionné(s)` :
                     `${coverEditModal.selectedCharacterIds.length} character(s) selected`}
                  </span>
                )}
              </div>
              <div className="flex flex-col sm:flex-row gap-2 sm:gap-3">
                <button
                  onClick={() => setCoverEditModal(null)}
                  className="px-4 py-2 text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-lg font-medium order-2 sm:order-1"
                >
                  {language === 'de' ? 'Abbrechen' : language === 'fr' ? 'Annuler' : 'Cancel'}
                </button>
                <button
                  onClick={handleRegenerateCoverWithScene}
                  disabled={regeneratingCovers.has(coverEditModal.coverType === 'front' ? 'frontCover' : coverEditModal.coverType === 'initial' ? 'initialPage' : 'backCover') || coverEditModal.selectedCharacterIds.length === 0}
                  className={`px-4 py-2 bg-indigo-600 text-white rounded-lg font-medium flex items-center justify-center gap-2 order-1 sm:order-2 ${
                    regeneratingCovers.has(coverEditModal.coverType === 'front' ? 'frontCover' : coverEditModal.coverType === 'initial' ? 'initialPage' : 'backCover') || coverEditModal.selectedCharacterIds.length === 0
                      ? 'opacity-50 cursor-not-allowed'
                      : 'hover:bg-indigo-700'
                  }`}
                >
                  <RefreshCw size={16} />
                  {language === 'de' ? 'Neu generieren' : language === 'fr' ? 'Régénérer' : 'Regenerate'}
                  <span className="text-xs opacity-80">
                    ({imageRegenerationCost} {language === 'de' ? 'Credits' : 'credits'})
                  </span>
                </button>
              </div>
            </div>
          </div>
        </div>
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

      {/* Enlarged Image Modal for single image viewing */}
      {enlargedImage && (
        <EnlargedImageModal
          src={enlargedImage.src}
          title={enlargedImage.title}
          onClose={() => setEnlargedImage(null)}
        />
      )}

      {/* Repair Comparison Modal for before/after/diff viewing */}
      {repairComparison && (
        <RepairComparisonModal
          beforeImage={repairComparison.beforeImage}
          afterImage={repairComparison.afterImage}
          diffImage={repairComparison.diffImage}
          title={repairComparison.title}
          onClose={() => setRepairComparison(null)}
        />
      )}
    </div>
  );
}

export default StoryDisplay;
