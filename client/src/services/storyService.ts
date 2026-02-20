import api from './api';
import type {
  Character,
  RelationshipMap,
  RelationshipTextMap,
  VisualBible
} from '@/types/character';
import type { SavedStory, StoryLanguageCode, LanguageLevel, SceneDescription, SceneImage, CoverImages, RetryAttempt, RepairAttempt, ImageVersion, ReferencePhoto, LandmarkPhoto, GenerationLogEntry, FinalChecksReport } from '@/types/story';

interface StoryDraft {
  storyType: string;
  artStyle: string;
  storyDetails: string;
  characters: Character[];
  relationships: RelationshipMap;
  relationshipTexts: RelationshipTextMap;
  pages: number;
  languageLevel: LanguageLevel;
  mainCharacters: number[];
  dedication: string;
  language: StoryLanguageCode;
}

interface StoryListItemServer {
  id: string;
  title: string;
  createdAt: string;
  updatedAt?: string;
  pages: number;
  language: StoryLanguageCode;
  characters?: { name: string; id: number }[];
  pageCount?: number;
  hasThumbnail?: boolean; // Changed from thumbnail to hasThumbnail
  isPartial?: boolean;
  generatedPages?: number;
  totalPages?: number;
}

interface PaginatedStoriesResponse {
  stories: StoryListItemServer[];
  pagination: {
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  };
}

export interface StoryListItem {
  id: string;
  title: string;
  story_type: string;
  art_style: string;
  language: StoryLanguageCode;
  pages: number;
  created_at: string;
  hasThumbnail?: boolean; // Changed from thumbnail
  thumbnail?: string; // Loaded lazily via getStoryCover
  isPartial?: boolean;
  generatedPages?: number;
  totalPages?: number;
}

interface StoryDetailsServer {
  id: string;
  title: string;
  storyType: string;
  storyTypeName?: string;  // Display name for story type
  storyCategory?: 'adventure' | 'life-challenge' | 'educational' | 'historical' | 'custom';  // Story category
  storyTopic?: string;  // Life challenge or educational topic
  storyTheme?: string;  // Adventure theme
  storyDetails?: string;  // User's custom story idea
  artStyle: string;
  language: StoryLanguageCode;
  languageLevel: LanguageLevel;
  pages: number;
  dedication?: string;
  season?: string;  // Season when story takes place
  userLocation?: { city: string | null; region: string | null; country: string | null } | null;
  characters: Character[];
  mainCharacters: number[];
  relationships: RelationshipMap;
  relationshipTexts: RelationshipTextMap;
  outline?: string;
  outlinePrompt?: string;
  outlineModelId?: string;  // Model used for outline generation
  outlineUsage?: { input_tokens: number; output_tokens: number };  // Token usage for outline
  storyText?: string; // New stories use this
  story?: string; // Old stories use this
  storyTextPrompts?: Array<{
    batch: number;
    startPage: number;
    endPage: number;
    prompt: string;
    modelId?: string;
    usage?: { input_tokens: number; output_tokens: number };
  }>;
  visualBible?: VisualBible;
  sceneDescriptions?: SceneDescription[];
  sceneImages?: SceneImage[];
  coverImages?: CoverImages;
  thumbnail?: string;
  createdAt: string;
  // Partial story fields
  isPartial?: boolean;
  failureReason?: string;
  generatedPages?: number;
  totalPages?: number;
}

export const storyService = {
  // Draft management
  async getDraft(): Promise<StoryDraft | null> {
    try {
      const response = await api.get<{ draft: StoryDraft | null }>('/api/story-draft');
      return response.draft;
    } catch {
      return null;
    }
  },

  async saveDraft(draft: StoryDraft): Promise<void> {
    await api.post('/api/story-draft', { draft });
  },

  async deleteDraft(): Promise<void> {
    await api.delete('/api/story-draft');
  },

  // Story CRUD
  async getStories(options?: { limit?: number; offset?: number }): Promise<{
    stories: StoryListItem[];
    pagination: { total: number; limit: number; offset: number; hasMore: boolean };
  }> {
    const params = new URLSearchParams();
    if (options?.limit) params.set('limit', String(options.limit));
    if (options?.offset) params.set('offset', String(options.offset));

    const queryString = params.toString();
    const url = `/api/stories${queryString ? `?${queryString}` : ''}`;

    const response = await api.get<PaginatedStoriesResponse>(url);

    // Map server format to client format
    const stories = (response.stories || []).map(s => ({
      id: s.id,
      title: s.title,
      story_type: '', // Not returned in list view
      art_style: '', // Not returned in list view
      language: s.language,
      pages: s.pageCount || s.pages || 0,
      created_at: s.createdAt,
      hasThumbnail: s.hasThumbnail,
      isPartial: s.isPartial,
      generatedPages: s.generatedPages,
      totalPages: s.totalPages,
    }));

    return {
      stories,
      pagination: response.pagination,
    };
  },

  // Get cover image for a story (lazy loading)
  async getStoryCover(storyId: string): Promise<string | null> {
    try {
      const response = await api.get<{ coverImage: string | null }>(`/api/stories/${storyId}/cover`);
      return response.coverImage;
    } catch {
      return null;
    }
  },

  // Ultra-fast metadata for instant initial render (< 100ms response time)
  // Returns only what's needed to show title + cover placeholder immediately
  // Note: dedication and artStyle come from full metadata load (not in quick-metadata)
  async getQuickMetadata(id: string): Promise<{
    id: string;
    title: string;
    language: StoryLanguageCode;
    languageLevel: LanguageLevel;
    pageCount: number;
    hasFrontCover: boolean;
  } | null> {
    try {
      const token = localStorage.getItem('auth_token');
      const response = await fetch(`/api/stories/${id}/quick-metadata`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!response.ok) return null;
      return await response.json();
    } catch {
      return null;
    }
  },

  async getStory(id: string): Promise<SavedStory | null> {
    try {
      // Server returns story directly, not wrapped in { story: ... }
      const s = await api.get<StoryDetailsServer>(`/api/stories/${id}`);
      // Handle both old format (story) and new format (storyText)
      const storyContent = s.storyText || s.story || '';
      return {
        id: s.id,
        title: s.title,
        storyType: s.storyType,
        artStyle: s.artStyle,
        language: s.language,
        languageLevel: s.languageLevel,
        pages: s.pages,
        dedication: s.dedication,
        characters: s.characters,
        mainCharacters: s.mainCharacters,
        relationships: s.relationships,
        relationshipTexts: s.relationshipTexts,
        outline: s.outline,
        outlinePrompt: s.outlinePrompt,
        outlineModelId: s.outlineModelId,
        outlineUsage: s.outlineUsage,
        story: storyContent,
        storyTextPrompts: s.storyTextPrompts,
        visualBible: s.visualBible,
        sceneDescriptions: s.sceneDescriptions,
        sceneImages: s.sceneImages,
        coverImages: s.coverImages,
        thumbnail: s.thumbnail,
        createdAt: s.createdAt,
        isPartial: s.isPartial,
        failureReason: s.failureReason,
        generatedPages: s.generatedPages,
        totalPages: s.totalPages,
      };
    } catch {
      return null;
    }
  },

  // Get story with download progress tracking
  async getStoryWithProgress(
    id: string,
    onProgress: (loaded: number, total: number | null) => void
  ): Promise<SavedStory | null> {
    try {
      const token = localStorage.getItem('auth_token');
      const response = await fetch(`/api/stories/${id}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      // Get total size from Content-Length header (may be null if not provided)
      const contentLength = response.headers.get('Content-Length');
      const total = contentLength ? parseInt(contentLength, 10) : null;

      // Read the response body with progress tracking
      const reader = response.body?.getReader();
      if (!reader) {
        // Fallback to regular fetch if streaming not supported
        const s = await response.json() as StoryDetailsServer;
        return this.mapServerStoryToClient(s);
      }

      const chunks: Uint8Array[] = [];
      let loaded = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        chunks.push(value);
        loaded += value.length;
        onProgress(loaded, total);
      }

      // Combine chunks and parse JSON
      const allChunks = new Uint8Array(loaded);
      let position = 0;
      for (const chunk of chunks) {
        allChunks.set(chunk, position);
        position += chunk.length;
      }

      const text = new TextDecoder().decode(allChunks);
      const s = JSON.parse(text) as StoryDetailsServer;
      return this.mapServerStoryToClient(s);
    } catch {
      return null;
    }
  },

  // Helper to map server response to client format
  mapServerStoryToClient(s: StoryDetailsServer): SavedStory {
    const storyContent = s.storyText || s.story || '';
    return {
      id: s.id,
      title: s.title,
      storyType: s.storyType,
      storyTypeName: s.storyTypeName,
      storyCategory: s.storyCategory,
      storyTopic: s.storyTopic,
      storyTheme: s.storyTheme,
      storyDetails: s.storyDetails,
      artStyle: s.artStyle,
      language: s.language,
      languageLevel: s.languageLevel,
      pages: s.pages,
      dedication: s.dedication,
      characters: s.characters,
      mainCharacters: s.mainCharacters,
      relationships: s.relationships,
      relationshipTexts: s.relationshipTexts,
      season: s.season,
      userLocation: s.userLocation,
      outline: s.outline,
      outlinePrompt: s.outlinePrompt,
      outlineModelId: s.outlineModelId,
      outlineUsage: s.outlineUsage,
      story: storyContent,
      storyTextPrompts: s.storyTextPrompts,
      visualBible: s.visualBible,
      sceneDescriptions: s.sceneDescriptions,
      sceneImages: s.sceneImages,
      coverImages: s.coverImages,
      thumbnail: s.thumbnail,
      createdAt: s.createdAt,
      isPartial: s.isPartial,
      failureReason: s.failureReason,
      generatedPages: s.generatedPages,
      totalPages: s.totalPages,
    };
  },

  // Get story metadata only (no images) for fast initial load
  // Pass devMode=true to include version metadata (description, prompt, modelId) from data blob
  async getStoryMetadata(id: string, devMode?: boolean): Promise<(SavedStory & { totalImages: number }) | null> {
    try {
      const token = localStorage.getItem('auth_token');
      const url = devMode ? `/api/stories/${id}/metadata?devMode=true` : `/api/stories/${id}/metadata`;
      const response = await fetch(url, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const s = await response.json();
      return {
        ...this.mapServerStoryToClient(s),
        totalImages: s.totalImages || 0
      };
    } catch {
      return null;
    }
  },

  // Get developer metadata (prompts, quality reasoning, retry history) - loaded separately for dev mode
  async getStoryDevMetadata(id: string): Promise<{
    sceneImages: Array<{
      pageNumber: number;
      prompt: string | null;
      qualityReasoning: string | null;
      retryHistory: RetryAttempt[];
      repairHistory: RepairAttempt[];
      wasRegenerated: boolean;
      originalImage: boolean;
      originalScore: number | null;
      originalReasoning: string | null;
      totalAttempts: number | null;
      faceEvaluation: unknown | null;
      referencePhotos: ReferencePhoto[] | null;
      landmarkPhotos?: LandmarkPhoto[] | null;
      consistencyRegen?: {
        originalImage: string;
        originalPrompt: string;
        originalDescription: string;
        fixedImage: string;
        fixedPrompt: string;
        fixedDescription: string;
        correctionNotes: string;
        issues: Array<{
          type: string;
          characterInvolved?: string;
          description: string;
          recommendation: string;
          severity: string;
        }>;
        score: number;
        timestamp: string;
        retryHistory?: RetryAttempt[];
        totalAttempts?: number;
        wasRegenerated?: boolean;
        clothing?: string;
        avatarsUsed?: Array<{
          name: string;
          hasPhoto: boolean;
          category?: string;
          photoType?: string;
        }>;
      } | null;
    }>;
    coverImages: {
      frontCover: { prompt: string | null; qualityReasoning: string | null; retryHistory: RetryAttempt[]; totalAttempts: number | null; referencePhotos: ReferencePhoto[] | null; landmarkPhotos?: LandmarkPhoto[] | null } | null;
      initialPage: { prompt: string | null; qualityReasoning: string | null; retryHistory: RetryAttempt[]; totalAttempts: number | null; referencePhotos: ReferencePhoto[] | null; landmarkPhotos?: LandmarkPhoto[] | null } | null;
      backCover: { prompt: string | null; qualityReasoning: string | null; retryHistory: RetryAttempt[]; totalAttempts: number | null; referencePhotos: ReferencePhoto[] | null; landmarkPhotos?: LandmarkPhoto[] | null } | null;
    } | null;
    generationLog?: GenerationLogEntry[];
    styledAvatarGeneration?: Array<{
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
    }>;
    costumedAvatarGeneration?: Array<{
      timestamp: string;
      characterName: string;
      costumeType: string;
      artStyle: string;
      costumeDescription: string;
      durationMs: number;
      success: boolean;
      error?: string;
      inputs: {
        facePhoto?: { identifier: string; sizeKB: number; imageData?: string } | null;
        standardAvatar?: { identifier: string; sizeKB: number; imageData?: string } | null;
        referenceAvatar?: { identifier: string; sizeKB: number; imageData?: string } | null;
      };
      prompt?: string;
      output?: { identifier: string; sizeKB: number; imageData?: string };
      costumeEvaluation?: {
        pass: boolean;
        confidence: 'high' | 'medium' | 'low';
        reason: string;
        details?: {
          bottomLeft?: { hasCostume: boolean; costumeMatch: string; description: string };
          bottomRight?: { hasCostume: boolean; costumeMatch: string; description: string };
          consistent?: boolean;
        };
      } | null;
    }>;
    finalChecksReport?: FinalChecksReport;
  } | null> {
    try {
      const token = localStorage.getItem('auth_token');
      const response = await fetch(`/api/stories/${id}/dev-metadata`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });

      if (!response.ok) {
        console.warn(`Failed to fetch dev metadata: HTTP ${response.status}`);
        return null;
      }

      return await response.json();
    } catch (err) {
      console.warn('Failed to fetch dev metadata:', err);
      return null;
    }
  },

  // Lazy load dev mode images on demand
  async getDevImage(
    storyId: string,
    pageNumber: number,
    type: 'original' | 'retry' | 'repair' | 'reference' | 'landmark' | 'consistency',
    options?: { index?: number; field?: string }
  ): Promise<{
    originalImage?: string | null;
    imageData?: string | null;
    bboxOverlayImage?: string | null;
    fixedImage?: string | null;
    referencePhotos?: Array<{
      name: string;
      photoType?: string;
      clothingCategory?: string;
      clothingDescription?: string;
      photoUrl?: string | null;
    }>;
    landmarkPhotos?: Array<{
      name: string;
      photoData?: string | null;
    }>;
  } | null> {
    try {
      const token = localStorage.getItem('auth_token');
      const params = new URLSearchParams({ page: String(pageNumber), type });
      if (options?.index !== undefined) params.append('index', String(options.index));
      if (options?.field) params.append('field', options.field);

      const response = await fetch(`/api/stories/${storyId}/dev-image?${params}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });

      if (!response.ok) {
        console.warn(`Failed to fetch dev image: HTTP ${response.status}`);
        return null;
      }

      return await response.json();
    } catch (err) {
      console.warn('Failed to fetch dev image:', err);
      return null;
    }
  },

  // Lazy load avatar generation images (styled/costumed avatar logs)
  async getAvatarGenerationImage(
    storyId: string,
    type: 'styled' | 'costumed',
    index: number,
    field?: 'facePhoto' | 'originalAvatar' | 'styleSample' | 'standardAvatar' | 'output'
  ): Promise<{
    facePhoto?: string | null;
    originalAvatar?: string | null;
    styleSample?: string | null;
    standardAvatar?: string | null;
    output?: string | null;
  } | null> {
    try {
      const token = localStorage.getItem('auth_token');
      const params = new URLSearchParams({ type, index: String(index) });
      if (field) params.append('field', field);

      const response = await fetch(`/api/stories/${storyId}/avatar-generation-image?${params}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });

      if (!response.ok) {
        console.warn(`Failed to fetch avatar generation image: HTTP ${response.status}`);
        return null;
      }

      return await response.json();
    } catch (err) {
      console.warn('Failed to fetch avatar generation image:', err);
      return null;
    }
  },

  // Lazy load entity grid image by index (dev mode)
  async getEntityGridImageByIndex(
    storyId: string,
    gridIndex: number
  ): Promise<{
    entityName: string;
    clothingCategory?: string;
    gridImage: string;
    manifest: {
      cellSize: number;
      cols: number;
      rows: number;
      cells: Array<{
        letter: string;
        pageNumber?: number;
        isReference?: boolean;
        clothing?: string;
      }>;
    };
  } | null> {
    try {
      const token = localStorage.getItem('auth_token');
      const params = new URLSearchParams({ gridIndex: gridIndex.toString() });
      const response = await fetch(`/api/stories/${storyId}/entity-grid-image?${params}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });

      if (!response.ok) {
        console.warn(`Failed to fetch entity grid image: HTTP ${response.status}`);
        return null;
      }

      return await response.json();
    } catch (err) {
      console.warn('Failed to fetch entity grid image:', err);
      return null;
    }
  },

  // Lazy load retry history images for a page (dev mode)
  async getRetryHistoryImages(
    storyId: string,
    pageNumber: number
  ): Promise<{
    images: Array<{
      imageData?: string | null;
      bboxOverlayImage?: string | null;
      originalImage?: string | null;
      annotatedOriginal?: string | null;
      grids?: Array<{
        imageData?: string | null;
        repairedImageData?: string | null;
      }>;
    }>;
  } | null> {
    try {
      const token = localStorage.getItem('auth_token');
      const response = await fetch(`/api/stories/${storyId}/retry-images/${pageNumber}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });

      if (!response.ok) {
        console.warn(`Failed to fetch retry history images: HTTP ${response.status}`);
        return null;
      }

      return await response.json();
    } catch (err) {
      console.warn('Failed to fetch retry history images:', err);
      return null;
    }
  },

  // Get individual page image
  async getPageImage(storyId: string, pageNumber: number): Promise<{ imageData: string; imageVersions?: unknown[] } | null> {
    try {
      const response = await api.get<{ pageNumber: number; imageData: string; imageVersions?: unknown[] }>(
        `/api/stories/${storyId}/image/${pageNumber}`
      );
      return response;
    } catch {
      return null;
    }
  },

  // Get individual cover image
  async getCoverImage(storyId: string, coverType: 'frontCover' | 'initialPage' | 'backCover'): Promise<{ imageData: string; description?: string; storyTitle?: string } | null> {
    try {
      const response = await api.get<{ coverType: string; imageData: string; description?: string; storyTitle?: string }>(
        `/api/stories/${storyId}/cover-image/${coverType}`
      );
      return response;
    } catch {
      return null;
    }
  },

  // Get images in one request
  // activeOnly=true (default): Fast load ~3MB - only active images, no versions (for initial display)
  // activeOnly=false: Full load ~53MB - all versions for dev mode / version switching
  async getAllImages(storyId: string, activeOnly = true): Promise<{
    images: Array<{
      pageNumber: number;
      imageData: string;
      qualityScore?: number;
      isActive?: boolean;
      versionCount?: number;
      activeVersion?: number;
      imageVersions?: Array<{
        imageData: string;
        qualityScore?: number;
        isActive?: boolean;
      }>;
    }>;
    covers: {
      frontCover?: { imageData: string; qualityScore?: number; versionCount?: number };
      initialPage?: { imageData: string; qualityScore?: number; versionCount?: number };
      backCover?: { imageData: string; qualityScore?: number; versionCount?: number };
    };
  } | null> {
    try {
      const url = activeOnly
        ? `/api/stories/${storyId}/images?activeOnly=true`
        : `/api/stories/${storyId}/images`;
      const response = await api.get<{
        images: Array<{
          pageNumber: number;
          imageData: string;
          qualityScore?: number;
          isActive?: boolean;
          versionCount?: number;
          activeVersion?: number;
          imageVersions?: Array<{
            imageData: string;
            qualityScore?: number;
            isActive?: boolean;
          }>;
        }>;
        covers: {
          frontCover?: { imageData: string; qualityScore?: number; versionCount?: number };
          initialPage?: { imageData: string; qualityScore?: number; versionCount?: number };
          backCover?: { imageData: string; qualityScore?: number; versionCount?: number };
        };
      }>(url);
      console.log(`[getAllImages] ${activeOnly ? 'FAST' : 'FULL'}: ${response.images?.length || 0} pages, ${Object.keys(response.covers || {}).length} covers`);
      return response;
    } catch (err) {
      console.error('[getAllImages] Failed to load batch images:', err);
      return null;
    }
  },

  // Progressive story loading: metadata first, then ALL images in one batch request
  async getStoryProgressively(
    id: string,
    onMetadataLoaded: (story: SavedStory, totalImages: number) => void,
    onImageLoaded: (pageNumber: number | string, imageData: string, imageVersions?: unknown[], loadedCount?: number) => void,
    onComplete: () => void
  ): Promise<void> {
    // Step 1: Load metadata (fast - no images)
    const metadata = await this.getStoryMetadata(id);
    if (!metadata) {
      throw new Error('Story not found');
    }

    // Notify that metadata is ready - UI can render immediately
    onMetadataLoaded(metadata, metadata.totalImages);

    // Step 2: Load ALL images in one batch request (15x faster than individual requests)
    const batchResult = await this.getAllImages(id);

    // Check if batch result has actual images (not just empty arrays)
    const images = batchResult?.images || [];
    const covers = batchResult?.covers || {};
    const hasImages = images.length > 0 || Object.keys(covers).length > 0;

    if (hasImages) {
      let loadedCount = 0;

      // Notify cover images
      const coverTypes: ('frontCover' | 'initialPage' | 'backCover')[] = ['frontCover', 'initialPage', 'backCover'];
      for (const coverType of coverTypes) {
        const cover = covers[coverType];
        if (cover?.imageData) {
          loadedCount++;
          onImageLoaded(coverType, cover.imageData, undefined, loadedCount);
        }
      }

      // Notify page images
      for (const img of images) {
        if (img.imageData) {
          loadedCount++;
          onImageLoaded(img.pageNumber, img.imageData, img.imageVersions, loadedCount);
        }
      }

      onComplete();
      return;
    }

    // Fallback to individual requests if batch fails (shouldn't happen normally)
    console.warn('[getStoryProgressively] Batch load failed, falling back to individual requests');

    const pageNumbers = metadata.sceneImages
      ?.filter(img => (img as { hasImage?: boolean }).hasImage !== false && img.pageNumber)
      .map(img => img.pageNumber) || [];

    const coverTypesToLoad: ('frontCover' | 'initialPage' | 'backCover')[] = [];
    const fc = metadata.coverImages?.frontCover;
    const ip = metadata.coverImages?.initialPage;
    const bc = metadata.coverImages?.backCover;
    if (fc && (typeof fc === 'string' || (fc as { hasImage?: boolean }).hasImage)) coverTypesToLoad.push('frontCover');
    if (ip && (typeof ip === 'string' || (ip as { hasImage?: boolean }).hasImage)) coverTypesToLoad.push('initialPage');
    if (bc && (typeof bc === 'string' || (bc as { hasImage?: boolean }).hasImage)) coverTypesToLoad.push('backCover');

    let loadedCount = 0;

    // Load cover images in parallel
    const coverResults = await Promise.all(
      coverTypesToLoad.map(async coverType => {
        const result = await this.getCoverImage(id, coverType);
        return { coverType, result };
      })
    );

    for (const { coverType, result } of coverResults) {
      if (result) {
        loadedCount++;
        onImageLoaded(coverType, result.imageData, undefined, loadedCount);
      }
    }

    // Load page images in parallel batches
    const BATCH_SIZE = 3;
    for (let i = 0; i < pageNumbers.length; i += BATCH_SIZE) {
      const batch = pageNumbers.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(
        batch.map(pageNum => this.getPageImage(id, pageNum))
      );

      results.forEach((result, idx) => {
        if (result) {
          loadedCount++;
          onImageLoaded(batch[idx], result.imageData, result.imageVersions, loadedCount);
        }
      });
    }

    onComplete();
  },

  async createStory(data: {
    title: string;
    storyType: string;
    artStyle: string;
    language: StoryLanguageCode;
    languageLevel: LanguageLevel;
    pages: number;
    dedication?: string;
    characters: Character[];
    mainCharacters: number[];
    relationships: RelationshipMap;
    relationshipTexts: RelationshipTextMap;
    outline?: string;
    story?: string;
    sceneDescriptions?: SceneDescription[];
    sceneImages?: SceneImage[];
    coverImages?: CoverImages;
  }): Promise<{ id: string }> {
    const response = await api.post<{ id: string; message: string }>('/api/stories', {
      title: data.title,
      story_type: data.storyType,
      art_style: data.artStyle,
      language: data.language,
      language_level: data.languageLevel,
      pages: data.pages,
      dedication: data.dedication,
      characters: data.characters,
      main_characters: data.mainCharacters,
      relationships: data.relationships,
      relationship_texts: data.relationshipTexts,
      outline: data.outline,
      story: data.story,
      scene_descriptions: data.sceneDescriptions,
      scene_images: data.sceneImages,
      cover_images: data.coverImages,
    });
    return { id: response.id };
  },

  async deleteStory(id: string): Promise<void> {
    await api.delete(`/api/stories/${id}`);
  },

  // Regeneration endpoints
  async regenerateSceneDescription(storyId: string, pageNum: number): Promise<{ description: string }> {
    const response = await api.post<{ description: string }>(
      `/api/stories/${storyId}/regenerate/scene-description/${pageNum}`
    );
    return response;
  },

  async regenerateImage(storyId: string, pageNum: number, editedScene?: string, characterIds?: number[]): Promise<{
    imageData: string;
    qualityScore?: number;
    qualityReasoning?: string;
    totalAttempts?: number;
    retryHistory?: RetryAttempt[];
    originalImage?: string;
    originalScore?: number;
    originalReasoning?: string;
    versionCount?: number;
    creditsUsed?: number;
    creditsRemaining?: number;
    imageVersions?: ImageVersion[];
    // Scene editing info for dev mode
    originalDescription?: string;
    newDescription?: string;
    originalPrompt?: string;
    newPrompt?: string;
    // Reference images used for this regeneration
    referencePhotos?: ReferencePhoto[];
    landmarkPhotos?: LandmarkPhoto[];
    visualBibleGrid?: string;
  }> {
    const response = await api.post<{
      imageData: string;
      qualityScore?: number;
      qualityReasoning?: string;
      totalAttempts?: number;
      retryHistory?: RetryAttempt[];
      originalImage?: string;
      originalScore?: number;
      originalReasoning?: string;
      versionCount?: number;
      creditsUsed?: number;
      creditsRemaining?: number;
      imageVersions?: ImageVersion[];
      originalDescription?: string;
      newDescription?: string;
      originalPrompt?: string;
      newPrompt?: string;
      referencePhotos?: ReferencePhoto[];
      landmarkPhotos?: LandmarkPhoto[];
      visualBibleGrid?: string;
    }>(
      `/api/stories/${storyId}/regenerate/image/${pageNum}`,
      { editedScene, characterIds }
    );
    return response;
  },

  async regenerateCover(storyId: string, coverType: 'front' | 'back' | 'initial', editedScene?: string, characterIds?: number[], editedTitle?: string, editedDedication?: string): Promise<{
    imageData: string;
    description?: string;
    prompt?: string;
    qualityScore?: number;
    qualityReasoning?: string;
    totalAttempts?: number;
    retryHistory?: RetryAttempt[];
    referencePhotos?: ReferencePhoto[];
    wasRegenerated?: boolean;
    regenerationCount?: number;
    previousImage?: string;
    previousScore?: number;
    originalImage?: string;
    originalScore?: number;
    modelId?: string;
    creditsUsed?: number;
    creditsRemaining?: number;
    // Version tracking (for cover version history)
    versionIndex?: number;
    imageVersions?: ImageVersion[];
  }> {
    const body: { editedScene?: string; characterIds?: number[]; editedTitle?: string; editedDedication?: string } = {};
    if (editedScene) body.editedScene = editedScene;
    if (characterIds && characterIds.length > 0) body.characterIds = characterIds;
    if (editedTitle !== undefined) body.editedTitle = editedTitle;
    if (editedDedication !== undefined) body.editedDedication = editedDedication;

    const response = await api.post<{
      imageData: string;
      description?: string;
      prompt?: string;
      qualityScore?: number;
      qualityReasoning?: string;
      totalAttempts?: number;
      retryHistory?: RetryAttempt[];
      referencePhotos?: ReferencePhoto[];
      wasRegenerated?: boolean;
      regenerationCount?: number;
      previousImage?: string;
      previousScore?: number;
      originalImage?: string;
      originalScore?: number;
      modelId?: string;
      creditsUsed?: number;
      creditsRemaining?: number;
      versionIndex?: number;
      imageVersions?: ImageVersion[];
    }>(
      `/api/stories/${storyId}/regenerate/cover/${coverType}`,
      Object.keys(body).length > 0 ? body : undefined
    );
    return response;
  },

  async updatePage(storyId: string, pageNum: number, data: {
    text?: string;
    sceneDescription?: string;
    imageData?: string;
  }): Promise<void> {
    await api.patch(`/api/stories/${storyId}/page/${pageNum}`, {
      text: data.text,
      scene_description: data.sceneDescription,
      image_data: data.imageData,
    });
  },

  // Update Visual Bible (developer mode)
  async updateVisualBible(storyId: string, visualBible: VisualBible): Promise<void> {
    await api.put(`/api/stories/${storyId}/visual-bible`, { visualBible });
  },

  // Edit image with user prompt
  async editImage(storyId: string, pageNumber: number, editPrompt: string): Promise<{
    imageData: string;
    qualityScore?: number;
    qualityReasoning?: string;
    originalImage?: string;
    originalScore?: number;
    originalReasoning?: string;
  }> {
    const response = await api.post<{
      imageData: string;
      qualityScore?: number;
      qualityReasoning?: string;
      originalImage?: string;
      originalScore?: number;
      originalReasoning?: string;
    }>(
      `/api/stories/${storyId}/edit/image/${pageNumber}`,
      { editPrompt }
    );
    return response;
  },

  // Edit cover with user prompt
  async editCover(storyId: string, coverType: 'front' | 'back' | 'initial', editPrompt: string): Promise<{
    imageData: string;
    qualityScore?: number;
    qualityReasoning?: string;
    originalImage?: string;
    originalScore?: number;
    originalReasoning?: string;
  }> {
    const response = await api.post<{
      imageData: string;
      qualityScore?: number;
      qualityReasoning?: string;
      originalImage?: string;
      originalScore?: number;
      originalReasoning?: string;
    }>(
      `/api/stories/${storyId}/edit/cover/${coverType}`,
      { editPrompt }
    );
    return response;
  },

  // Auto-repair image (detect and fix physics errors) - DEV ONLY
  async repairImage(storyId: string, pageNumber: number, fixTargets?: Array<{
    boundingBox: number[];
    issue: string;
    fixPrompt: string;
  }>): Promise<{
    success: boolean;
    repaired: boolean;
    noErrorsFound: boolean;
    imageData: string;
    repairHistory: Array<{
      attempt: number;
      errorType: string;
      description: string;
      boundingBox: number[];
      fixPrompt: string;
      fullPrompt?: string;
      maskImage: string;
      beforeImage: string;
      afterImage: string | null;
      success: boolean;
      timestamp: string;
    }>;
  }> {
    const response = await api.post<{
      success: boolean;
      repaired: boolean;
      noErrorsFound: boolean;
      imageData: string;
      repairHistory: Array<{
        attempt: number;
        errorType: string;
        description: string;
        boundingBox: number[];
        fixPrompt: string;
        fullPrompt?: string;
        maskImage: string;
        beforeImage: string;
        afterImage: string | null;
        success: boolean;
        timestamp: string;
      }>;
    }>(
      `/api/stories/${storyId}/repair/image/${pageNumber}`,
      { fixTargets }
    );
    return response;
  },

  // Iterate image using 17-check scene description prompt with actual image analysis (DEV MODE ONLY)
  async iteratePage(storyId: string, pageNumber: number, imageModel?: string, options?: { useOriginalAsReference?: boolean }): Promise<{
    success: boolean;
    pageNumber: number;
    // What the vision model saw
    composition: string;
    // Claude's analysis
    previewMismatches: string[];
    checksRun: Record<string, unknown>;
    // New content
    sceneDescription: string;
    imageData: string;
    imagePrompt?: string;
    qualityScore?: number;
    qualityReasoning?: string;
    modelId?: string;
    totalAttempts?: number;
    // Previous version
    previousImage?: string;
    previousScore?: number;
    // Image versions for history
    imageVersions?: Array<{
      description?: string;
      prompt?: string;
      modelId?: string;
      createdAt?: string;
      isActive?: boolean;
      type?: string;
      qualityScore?: number;
      imageData?: string;
    }>;
    // Credits
    creditsUsed?: number;
    creditsRemaining?: number;
    // Reference info
    referencePhotos?: ReferencePhoto[];
    landmarkPhotos?: LandmarkPhoto[];
    visualBibleGrid?: string;
    message: string;
  }> {
    const response = await api.post<{
      success: boolean;
      pageNumber: number;
      composition: string;
      previewMismatches: string[];
      checksRun: Record<string, unknown>;
      sceneDescription: string;
      imageData: string;
      imagePrompt?: string;
      qualityScore?: number;
      qualityReasoning?: string;
      modelId?: string;
      totalAttempts?: number;
      previousImage?: string;
      previousScore?: number;
      imageVersions?: Array<{
        description?: string;
        prompt?: string;
        modelId?: string;
        createdAt?: string;
        isActive?: boolean;
        type?: string;
        qualityScore?: number;
        imageData?: string;
      }>;
      creditsUsed?: number;
      creditsRemaining?: number;
      referencePhotos?: ReferencePhoto[];
      landmarkPhotos?: LandmarkPhoto[];
      visualBibleGrid?: string;
      message: string;
    }>(
      `/api/stories/${storyId}/iterate/${pageNumber}`,
      { imageModel, ...(options?.useOriginalAsReference && { useOriginalAsReference: true }) }
    );
    return response;
  },

  // Update scene image directly (admin only - for reverting repairs)
  async updateSceneImage(storyId: string, pageNumber: number, imageData: string): Promise<{
    success: boolean;
    pageNumber: number;
  }> {
    const response = await api.patch<{
      success: boolean;
      pageNumber: number;
    }>(
      `/api/stories/${storyId}/page/${pageNumber}`,
      { imageData }
    );
    return response;
  },

  // AI Generation
  async callClaude(prompt: string, maxTokens = 8192): Promise<string> {
    const response = await api.post<{ content: string }>('/api/claude', {
      prompt,
      max_tokens: maxTokens,
    });
    return response.content;
  },

  async callGemini(prompt: string, images?: string[]): Promise<string> {
    const response = await api.post<{ content: string }>('/api/gemini', {
      prompt,
      images,
    });
    return response.content;
  },

  // Generate story ideas using AI
  async generateStoryIdeas(data: {
    storyType: string;
    storyTypeName: string;
    storyCategory?: 'adventure' | 'life-challenge' | 'educational' | 'historical' | 'custom' | '';
    storyTopic?: string;
    storyTheme?: string;
    customThemeText?: string;
    language: StoryLanguageCode;
    languageLevel: LanguageLevel;
    characters: Array<{
      name: string;
      age: string;
      gender: string;
      traits?: { strengths?: string[]; flaws?: string[]; challenges?: string[]; specialDetails?: string };
      isMain: boolean;
    }>;
    relationships: Array<{
      character1: string;
      character2: string;
      relationship: string;
    }>;
    // Developer model override (admin only)
    ideaModel?: string | null;
    // User's location for personalized story settings
    userLocation?: { city: string | null; region: string | null; country: string | null };
    // Season for story setting
    season?: string;
  }): Promise<{ storyIdeas: string[]; storyIdea: string; prompt?: string; model?: string }> {
    const response = await api.post<{ storyIdeas: string[]; storyIdea: string; prompt?: string; model?: string }>('/api/generate-story-ideas', data);
    return response;
  },

  // Streaming version of generateStoryIdeas - streams stories as they're generated
  generateStoryIdeasStream(
    data: {
      storyType: string;
      storyTypeName: string;
      storyCategory?: 'adventure' | 'life-challenge' | 'educational' | 'historical' | 'custom' | '';
      storyTopic?: string;
      storyTheme?: string;
      customThemeText?: string;
      language: StoryLanguageCode;
      languageLevel: LanguageLevel;
      pages: number;
      characters: Array<{
        name: string;
        age: string;
        gender: string;
        traits?: { strengths?: string[]; flaws?: string[]; challenges?: string[]; specialDetails?: string };
        isMain: boolean;
      }>;
      relationships: Array<{
        character1: string;
        character2: string;
        relationship: string;
      }>;
      ideaModel?: string | null;
      // User's location for personalized story settings
      userLocation?: { city: string | null; region: string | null; country: string | null };
      // Season for story setting
      season?: string;
    },
    callbacks: {
      onStory1?: (story: string) => void;
      onStory2?: (story: string) => void;
      onStatus?: (status: string, prompt?: string, model?: string) => void;
      onError?: (error: string) => void;
      onDone?: (fullResponse?: string) => void;
    }
  ): { abort: () => void } {
    const controller = new AbortController();
    const token = localStorage.getItem('auth_token');

    // Timeout after 2 minutes of no response
    const STREAM_TIMEOUT_MS = 120000;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const resetTimeout = () => {
      if (timeoutId) clearTimeout(timeoutId);
      timeoutId = setTimeout(() => {
        console.warn('[generateStoryIdeasStream] Stream timeout - no activity for 2 minutes');
        controller.abort();
        callbacks.onError?.('Connection timeout. Please try again.');
      }, STREAM_TIMEOUT_MS);
    };

    const fetchStream = async () => {
      resetTimeout(); // Start initial timeout
      const streamStartTime = Date.now();
      try {
        const response = await fetch('/api/generate-story-ideas-stream', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
          },
          body: JSON.stringify(data),
          signal: controller.signal,
        });

        if (!response.ok) {
          const errorText = await response.text();
          callbacks.onError?.(errorText || 'Failed to generate story ideas');
          return;
        }

        const reader = response.body?.getReader();
        if (!reader) {
          callbacks.onError?.('No response body');
          return;
        }

        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          // Reset timeout on any activity
          resetTimeout();
          buffer += decoder.decode(value, { stream: true });

          // Parse SSE events
          const lines = buffer.split('\n');
          buffer = lines.pop() || ''; // Keep incomplete line in buffer

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try {
                const eventData = JSON.parse(line.slice(6));
                if (eventData.status) {
                  callbacks.onStatus?.(eventData.status, eventData.prompt, eventData.model);
                }
                if (eventData.story1) {
                  callbacks.onStory1?.(eventData.story1);
                }
                if (eventData.story2) {
                  callbacks.onStory2?.(eventData.story2);
                }
                if (eventData.error) {
                  callbacks.onError?.(eventData.error);
                }
                if (eventData.done) {
                  const duration = ((Date.now() - streamStartTime) / 1000).toFixed(1);
                  console.log(`[IDEAS] Complete in ${duration}s`);
                  callbacks.onDone?.(eventData.fullResponse);
                }
              } catch {
                // Ignore parse errors for incomplete data
              }
            }
          }
        }
      } catch (err) {
        if (timeoutId) clearTimeout(timeoutId);
        if ((err as Error).name !== 'AbortError') {
          callbacks.onError?.((err as Error).message || 'Stream error');
        }
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
      }
    };

    fetchStream();

    return {
      abort: () => {
        if (timeoutId) clearTimeout(timeoutId);
        controller.abort();
      },
    };
  },

  // Job-based story generation
  async createStoryJob(data: {
    storyType: string;
    storyTypeName: string;
    storyCategory?: 'adventure' | 'life-challenge' | 'educational' | 'historical' | 'custom' | '';
    storyTopic?: string;
    storyTheme?: string;
    customThemeText?: string;
    artStyle: string;
    language: StoryLanguageCode;
    languageLevel: LanguageLevel;
    pages: number;
    dedication?: string;
    storyDetails?: string;
    characters: Character[];
    mainCharacters: number[];
    relationships: RelationshipMap;
    relationshipTexts: RelationshipTextMap;
    skipImages?: boolean;
    imageGenMode?: 'parallel' | 'sequential' | null;
    // Developer generation mode override (pictureBook = single prompt, outlineAndText = outline+text)
    generationMode?: 'pictureBook' | 'outlineAndText';
    // Developer skip options
    skipOutline?: boolean;
    skipText?: boolean;
    skipSceneDescriptions?: boolean;
    skipCovers?: boolean;
    // Developer feature options
    enableAutoRepair?: boolean;
    useGridRepair?: boolean;  // Use grid-based repair instead of legacy inpainting
    forceRepairThreshold?: number | null;  // Force repair on pages with issues below this score (100 = always)
    enableFinalChecks?: boolean;
    checkOnlyMode?: boolean;  // Skip all regeneration, only run checks
    enableSceneValidation?: boolean;  // Cheap preview + geometry check
    separatedEvaluation?: boolean;  // Generate all images first, then batch evaluate
    // Incremental consistency check (check each image against previous images)
    incrementalConsistency?: {
      enabled: boolean;
      dryRun: boolean;
      lookbackCount: number;
    };
    // Developer model overrides (admin only)
    modelOverrides?: {
      outlineModel?: string | null;
      textModel?: string | null;
      sceneDescriptionModel?: string | null;
      imageModel?: string | null;
      coverImageModel?: string | null;
      qualityModel?: string | null;
      imageBackend?: string | null;  // 'gemini' or 'runware'
    };
    // User location for landmark discovery
    userLocation?: { city: string | null; region: string | null; country: string | null };
    // Season for story setting
    season?: string;
    // Idea generation data (for analysis)
    ideaGeneration?: {
      input: {
        storyType: string;
        storyCategory: string;
        storyTopic: string;
        storyTheme: string;
        characters: Array<{ id: number; name: string }>;
        language: string;
        languageLevel: string;
        pages: number;
        userLocation?: { city: string | null; region: string | null; country: string | null };
        season?: string;
      };
      output: string[];  // Both generated ideas (final only)
      rawResponse?: string;  // Full LLM response with [DRAFT], [REVIEW], [FINAL] stages
      prompt: string;
      model: string;
      selectedIndex: number | null;  // 0, 1, or null if custom/edited
    };
  }): Promise<{ jobId: string; creditsRemaining?: number }> {
    // Generate idempotency key to prevent duplicate job creation on retries
    const idempotencyKey = `idem_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    const response = await api.post<{ jobId: string; message: string; existing?: boolean; creditsRemaining?: number }>('/api/jobs/create-story', {
      idempotencyKey,
      storyType: data.storyType,
      storyTypeName: data.storyTypeName,
      storyCategory: data.storyCategory,
      storyTopic: data.storyTopic,
      storyTheme: data.storyTheme,
      artStyle: data.artStyle,
      language: data.language,
      languageLevel: data.languageLevel,
      pages: data.pages,
      dedication: data.dedication,
      storyDetails: data.storyDetails,
      characters: data.characters,
      mainCharacters: data.mainCharacters,
      relationships: data.relationships,
      relationshipTexts: data.relationshipTexts,
      skipImages: data.skipImages,
      imageGenMode: data.imageGenMode,
      generationMode: data.generationMode,
      // Developer skip options
      skipOutline: data.skipOutline,
      skipText: data.skipText,
      skipSceneDescriptions: data.skipSceneDescriptions,
      skipCovers: data.skipCovers,
      // Developer feature options
      enableAutoRepair: data.enableAutoRepair,
      useGridRepair: data.useGridRepair,
      forceRepairThreshold: data.forceRepairThreshold,
      enableFinalChecks: data.enableFinalChecks,
      checkOnlyMode: data.checkOnlyMode,  // Skip all regeneration, only run checks
      enableSceneValidation: data.enableSceneValidation,  // Cheap preview + geometry check
      separatedEvaluation: data.separatedEvaluation,  // Generate all images first, then batch evaluate
      // Incremental consistency check
      incrementalConsistency: data.incrementalConsistency,
      // Developer model overrides
      modelOverrides: data.modelOverrides,
      // User location for landmark discovery
      userLocation: data.userLocation,
      // Season for story setting
      season: data.season,
      // Idea generation data (for analysis)
      ideaGeneration: data.ideaGeneration,
    });
    return { jobId: response.jobId, creditsRemaining: response.creditsRemaining };
  },

  async getJobStatus(jobId: string): Promise<{
    status: 'pending' | 'processing' | 'completed' | 'failed';
    progress?: { current: number; total: number; message: string };
    result?: {
      storyId: string;
      title: string;
      outline: string;
      outlinePrompt?: string;
      outlineModelId?: string;
      outlineUsage?: { input_tokens: number; output_tokens: number };
      story: string;
      storyTextPrompts?: Array<{ batch: number; startPage: number; endPage: number; prompt: string; modelId?: string; usage?: { input_tokens: number; output_tokens: number } }>;
      visualBible?: VisualBible;
      clothingRequirements?: Record<string, {
        standard?: { used: boolean; signature?: string };
        winter?: { used: boolean; signature?: string };
        summer?: { used: boolean; signature?: string };
        costumed?: { used: boolean; costume?: string; description?: string };
      }>;
      styledAvatarGeneration?: Array<{
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
      }>;
      costumedAvatarGeneration?: Array<{
        timestamp: string;
        characterName: string;
        costumeType: string;
        artStyle: string;
        costumeDescription: string;
        durationMs: number;
        success: boolean;
        error?: string;
        inputs: {
          facePhoto?: { identifier: string; sizeKB: number } | null;
          standardAvatar?: { identifier: string; sizeKB: number } | null;
          referenceAvatar?: { identifier: string; sizeKB: number } | null;
        };
        prompt?: string;
        output?: { identifier: string; sizeKB: number };
        costumeEvaluation?: {
          pass: boolean;
          confidence: 'high' | 'medium' | 'low';
          reason: string;
          details?: {
            bottomLeft?: { hasCostume: boolean; costumeMatch: string; description: string };
            bottomRight?: { hasCostume: boolean; costumeMatch: string; description: string };
            consistent?: boolean;
          };
        } | null;
      }>;
      generationLog?: GenerationLogEntry[];
      finalChecksReport?: FinalChecksReport;
      sceneDescriptions: SceneDescription[];
      sceneImages: SceneImage[];
      coverImages?: CoverImages;
    };
    partialCovers?: CoverImages; // Cover images generated during streaming (before job completion)
    storyText?: {  // Story text for progressive display while images generate
      title: string;
      dedication?: string;
      pageTexts: Record<number, string>;
      sceneDescriptions: SceneDescription[];
      totalPages: number;
    };
    partialPages?: Array<{ pageNumber: number; imageData: string; text?: string }>;  // Completed page images
    currentCredits?: number | null;  // User's updated credits balance after job completion
    error?: string;
  }> {
    const response = await api.get<{
      jobId: string;
      status: string;
      progress: number;
      progressMessage: string;
      resultData?: {
        storyId?: string;
        title?: string;
        outline?: string;
        outlinePrompt?: string;
        outlineModelId?: string;
        outlineUsage?: { input_tokens: number; output_tokens: number };
        storyText?: string; // Legacy: Server uses storyText
        story?: string; // Unified: Server sends story directly
        storyTextPrompts?: Array<{ batch: number; startPage: number; endPage: number; prompt: string; modelId?: string; usage?: { input_tokens: number; output_tokens: number } }>;
        visualBible?: VisualBible;
        clothingRequirements?: Record<string, {
          standard?: { used: boolean; signature?: string };
          winter?: { used: boolean; signature?: string };
          summer?: { used: boolean; signature?: string };
          costumed?: { used: boolean; costume?: string; description?: string };
        }>;
        styledAvatarGeneration?: Array<{
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
        }>;
        costumedAvatarGeneration?: Array<{
          timestamp: string;
          characterName: string;
          costumeType: string;
          artStyle: string;
          costumeDescription: string;
          durationMs: number;
          success: boolean;
          error?: string;
          inputs: {
            facePhoto?: { identifier: string; sizeKB: number } | null;
            standardAvatar?: { identifier: string; sizeKB: number } | null;
            referenceAvatar?: { identifier: string; sizeKB: number } | null;
          };
          prompt?: string;
          output?: { identifier: string; sizeKB: number };
          costumeEvaluation?: {
            pass: boolean;
            confidence: 'high' | 'medium' | 'low';
            reason: string;
            details?: {
              bottomLeft?: { hasCostume: boolean; costumeMatch: string; description: string };
              bottomRight?: { hasCostume: boolean; costumeMatch: string; description: string };
              consistent?: boolean;
            };
          } | null;
        }>;
        generationLog?: GenerationLogEntry[];
        finalChecksReport?: FinalChecksReport;
        sceneDescriptions?: SceneDescription[];
        sceneImages?: SceneImage[];
        coverImages?: CoverImages;
      };
      errorMessage?: string;
      partialCovers?: CoverImages; // Cover images generated during streaming
      storyText?: {  // Story text checkpoint for progressive display
        title: string;
        dedication?: string;
        pageTexts: Record<number, string>;
        sceneDescriptions: SceneDescription[];
        totalPages: number;
      };
      partialPages?: Array<{ pageNumber: number; imageData: string; text?: string }>;  // Completed page images
      currentCredits?: number | null;  // User's updated credits after job completion
      result?: {  // Backend sends 'result' not 'resultData'
        storyId?: string;
        title?: string;
        outline?: string;
        outlinePrompt?: string;
        outlineModelId?: string;
        outlineUsage?: { input_tokens: number; output_tokens: number };
        storyText?: string;
        story?: string;
        storyTextPrompts?: Array<{ batch: number; startPage: number; endPage: number; prompt: string; modelId?: string; usage?: { input_tokens: number; output_tokens: number } }>;
        visualBible?: VisualBible;
        clothingRequirements?: Record<string, {
          standard?: { used: boolean; signature?: string };
          winter?: { used: boolean; signature?: string };
          summer?: { used: boolean; signature?: string };
          costumed?: { used: boolean; costume?: string; description?: string };
        }>;
        styledAvatarGeneration?: Array<{
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
        }>;
        costumedAvatarGeneration?: Array<{
          timestamp: string;
          characterName: string;
          costumeType: string;
          artStyle: string;
          costumeDescription: string;
          durationMs: number;
          success: boolean;
          error?: string;
          inputs: {
            facePhoto?: { identifier: string; sizeKB: number } | null;
            standardAvatar?: { identifier: string; sizeKB: number } | null;
            referenceAvatar?: { identifier: string; sizeKB: number } | null;
          };
          prompt?: string;
          output?: { identifier: string; sizeKB: number };
          costumeEvaluation?: {
            pass: boolean;
            confidence: 'high' | 'medium' | 'low';
            reason: string;
            details?: {
              bottomLeft?: { hasCostume: boolean; costumeMatch: string; description: string };
              bottomRight?: { hasCostume: boolean; costumeMatch: string; description: string };
              consistent?: boolean;
            };
          } | null;
        }>;
        generationLog?: GenerationLogEntry[];
        finalChecksReport?: FinalChecksReport;
        sceneDescriptions?: SceneDescription[];
        sceneImages?: SceneImage[];
        coverImages?: CoverImages;
      };
    }>(`/api/jobs/${jobId}/status`);

    // Map server response to client format
    // Backend sends 'result' (not 'resultData') - support both for backwards compatibility
    const resultData = response.result || response.resultData;
    return {
      status: response.status as 'pending' | 'processing' | 'completed' | 'failed',
      progress: {
        current: response.progress || 0,
        total: 100,
        message: response.progressMessage || '',
      },
      result: resultData ? {
        storyId: resultData.storyId || '',
        title: resultData.title || '',
        outline: resultData.outline || '',
        outlinePrompt: resultData.outlinePrompt,
        outlineModelId: resultData.outlineModelId,
        outlineUsage: resultData.outlineUsage,
        story: resultData.story || resultData.storyText || '', // Backend sends 'story' (unified) or 'storyText' (legacy)
        storyTextPrompts: resultData.storyTextPrompts,
        visualBible: resultData.visualBible,
        styledAvatarGeneration: resultData.styledAvatarGeneration,
        costumedAvatarGeneration: resultData.costumedAvatarGeneration,
        generationLog: resultData.generationLog,
        sceneDescriptions: resultData.sceneDescriptions || [],
        sceneImages: resultData.sceneImages || [],
        coverImages: resultData.coverImages,
      } : undefined,
      partialCovers: response.partialCovers, // Cover images generated during streaming
      storyText: response.storyText, // Story text for progressive display
      partialPages: response.partialPages, // Completed page images
      currentCredits: response.currentCredits, // User's updated credits after job completion
      error: response.errorMessage,
    };
  },

  async cancelJob(jobId: string): Promise<{ success: boolean; message: string }> {
    const response = await api.post<{ success: boolean; message: string; error?: string }>(`/api/jobs/${jobId}/cancel`);
    return response;
  },

  // Get user's active/pending jobs (for restoring generation state after impersonation)
  async getActiveJobs(): Promise<Array<{
    id: string;
    status: 'pending' | 'processing' | 'completed' | 'failed';
    progress: number;
    progress_message: string;
    created_at: string;
  }>> {
    const response = await api.get<{ jobs: Array<{
      id: string;
      status: string;
      progress: number;
      progress_message: string;
      created_at: string;
    }> }>('/api/jobs/my-jobs?limit=5');

    // Return only active jobs (pending or processing)
    return response.jobs
      .filter(job => job.status === 'pending' || job.status === 'processing')
      .map(job => ({
        ...job,
        status: job.status as 'pending' | 'processing' | 'completed' | 'failed',
      }));
  },

  // PDF generation
  async generatePdf(storyId: string, bookFormat: 'square' | 'A4' = 'square'): Promise<Blob> {
    const token = localStorage.getItem('auth_token');
    const response = await fetch(`/api/stories/${storyId}/pdf?format=${bookFormat}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!response.ok) {
      throw new Error('Failed to generate PDF');
    }
    return response.blob();
  },

  // Stripe checkout for book purchase (supports single story or multiple stories)
  async createCheckoutSession(storyIds: string | string[], coverType?: 'softcover' | 'hardcover', bookFormat?: 'square' | 'A4'): Promise<{ url: string }> {
    const ids = Array.isArray(storyIds) ? storyIds : [storyIds];
    const response = await api.post<{ url: string }>('/api/stripe/create-checkout-session', {
      storyIds: ids,
      coverType: coverType || 'softcover',
      bookFormat: bookFormat || 'square',
    });
    return response;
  },

  // Stripe checkout for credits purchase
  async createCreditsCheckout(credits: number = 100, amount: number = 500): Promise<{ url: string }> {
    const response = await api.post<{ url: string }>('/api/stripe/create-credits-checkout', {
      credits,
      amount,
    });
    return response;
  },

  // Get pricing tiers from server (single source of truth)
  async getPricing(): Promise<{
    tiers: Array<{ maxPages: number; label: string; softcover: number; hardcover: number }>;
    maxBookPages: number;
  }> {
    const response = await api.get<{
      tiers: Array<{ maxPages: number; label: string; softcover: number; hardcover: number }>;
      maxBookPages: number;
    }>('/api/pricing');
    return response;
  },

  // Direct print order (developer/admin mode - bypasses payment)
  async createPrintOrder(storyId: string, shippingAddress: {
    firstName: string;
    lastName: string;
    addressLine1: string;
    addressLine2?: string;
    city: string;
    postCode: string;
    country: string;
    email: string;
  }): Promise<{ orderId: string; message: string; dashboardUrl?: string; isDraft?: boolean }> {
    const response = await api.post<{ orderId: string; message: string; dashboardUrl?: string; isDraft?: boolean }>('/api/print-provider/order', {
      storyId,
      shippingAddress,
    });
    return response;
  },

  // Check order status after Stripe payment
  async getOrderStatus(sessionId: string): Promise<{
    status: string;
    order?: {
      customer_name: string;
      customer_email: string;
      shipping_name: string;
      shipping_address_line1: string;
      shipping_city: string;
      shipping_postal_code: string;
      shipping_country: string;
      amount_total: number;
      currency: string;
      tokens_credited?: number;
    };
    session?: {
      id: string;
      payment_status: string;
      amount_total: number;
      currency: string;
    };
  }> {
    const response = await api.get<{
      status: string;
      order?: {
        customer_name: string;
        customer_email: string;
        shipping_name: string;
        shipping_address_line1: string;
        shipping_city: string;
        shipping_postal_code: string;
        shipping_country: string;
        amount_total: number;
        currency: string;
        tokens_credited?: number;
      };
      session?: {
        id: string;
        payment_status: string;
        amount_total: number;
        currency: string;
      };
    }>(`/api/stripe/order-status/${sessionId}`);
    return response;
  },

  // Save edited story text (bulk update)
  async saveStoryText(storyId: string, storyText: string): Promise<{
    success: boolean;
    message: string;
    hasOriginal: boolean;
  }> {
    const response = await api.put<{
      success: boolean;
      message: string;
      hasOriginal: boolean;
    }>(`/api/stories/${storyId}/text`, { story: storyText });
    return response;
  },

  // Save story title
  async saveStoryTitle(storyId: string, title: string): Promise<{
    success: boolean;
    message: string;
    title: string;
  }> {
    const response = await api.put<{
      success: boolean;
      message: string;
      title: string;
    }>(`/api/stories/${storyId}/title`, { title });
    return response;
  },

  // Select which image version is active (for scene images)
  async setActiveImage(storyId: string, pageNumber: number, versionIndex: number): Promise<{
    success: boolean;
    activeVersion: number;
    pageNumber: number;
  }> {
    const response = await api.put<{
      success: boolean;
      activeVersion: number;
      pageNumber: number;
    }>(`/api/stories/${storyId}/pages/${pageNumber}/active-image`, { versionIndex });
    return response;
  },

  // Select which cover image version is active
  async setActiveCoverImage(
    storyId: string,
    coverType: 'frontCover' | 'initialPage' | 'backCover',
    versionIndex: number
  ): Promise<{
    success: boolean;
    activeVersion: number;
    coverType: string;
  }> {
    const response = await api.put<{
      success: boolean;
      activeVersion: number;
      coverType: string;
    }>(`/api/stories/${storyId}/covers/${coverType}/active-image`, { versionIndex });
    return response;
  },

  // Get user's location from IP for story personalization
  async getUserLocation(): Promise<{ city: string | null; region: string | null; country: string | null }> {
    try {
      const response = await api.get<{ city: string | null; region: string | null; country: string | null }>('/api/user/location');
      return response;
    } catch {
      return { city: null, region: null, country: null };
    }
  },

  // Trigger landmark discovery early (fire and forget)
  // Called as soon as user location is known to give discovery time to complete
  triggerLandmarkDiscovery(city: string | null, country: string | null): void {
    if (!city) return;
    // Fire and forget - don't await, just trigger
    api.post('/api/landmarks/discover', { city, country }).catch(() => {
      // Silently ignore errors - this is best-effort optimization
    });
  },

  // =============================================================================
  // Repair Workflow Methods
  // =============================================================================

  // Step 1: Collect feedback from existing evaluation data
  async collectRepairFeedback(storyId: string): Promise<{
    pages: Record<number, {
      pageNumber: number;
      qualityScore?: number;
      fixableIssues: Array<{ description: string; severity: string; type: string; fix: string }>;
      entityIssues: Array<{ character: string; issue: string; severity: string }>;
      manualNotes: string;
      needsFullRedo: boolean;
    }>;
    totalIssues: number;
  }> {
    const response = await api.post<{
      pages: Record<number, {
        pageNumber: number;
        qualityScore?: number;
        fixableIssues: Array<{ description: string; severity: string; type: string; fix: string }>;
        entityIssues: Array<{ character: string; issue: string; severity: string }>;
        manualNotes: string;
        needsFullRedo: boolean;
      }>;
      totalIssues: number;
    }>(`/api/stories/${storyId}/repair-workflow/collect-feedback`, {});
    return response;
  },

  // Step 3: Redo pages (complete regeneration)
  async redoPages(storyId: string, pageNumbers: number[], options?: { useOriginalAsReference?: boolean }): Promise<{
    pagesCompleted: number[];
    newVersions: Record<number, number>;
  }> {
    const response = await api.post<{
      pagesCompleted: number[];
      newVersions: Record<number, number>;
    }>(`/api/stories/${storyId}/repair-workflow/redo-pages`, {
      pageNumbers,
      ...(options?.useOriginalAsReference && { useOriginalAsReference: true }),
    });
    return response;
  },

  // Step 4: Re-evaluate pages
  async reEvaluatePages(storyId: string, pageNumbers: number[]): Promise<{
    pages: Record<number, { qualityScore: number; fixableIssues: Array<{ description: string; severity: string; type: string; fix: string }> | undefined }>;
  }> {
    const response = await api.post<{
      pages: Record<number, { qualityScore: number; fixableIssues: Array<{ description: string; severity: string; type: string; fix: string }> | undefined }>;
    }>(`/api/stories/${storyId}/repair-workflow/re-evaluate`, { pageNumbers });
    return response;
  },

  // Step 5: Run entity consistency check
  async runEntityConsistency(storyId: string): Promise<{
    report?: {
      timestamp: string;
      characters: Record<string, {
        gridImage?: string;
        consistent: boolean;
        score: number;
        issues: Array<{
          id: string;
          source: 'entity';
          pageNumber: number | null;
          type: string;
          subType: string;
          severity: string;
          description: string;
          fixInstruction: string;
          affectedCharacter: string;
          cells?: string[];
          pagesToFix?: number[];
        }>;
        summary?: string;
        error?: string;
      }>;
      objects: Record<string, unknown>;
      grids: Array<{
        entityName: string;
        entityType: 'character' | 'object';
        gridImage: string;
        manifest: {
          createdAt: string;
          title: string;
          dimensions: { width: number; height: number };
          cellSize: number;
          cols: number;
          rows: number;
          cellCount: number;
          cells: Array<{
            letter: string;
            pageNumber?: number;
            isReference?: boolean;
            clothing?: string;
            cropType?: string;
          }>;
        };
        cellCount: number;
      }>;
      totalIssues: number;
      overallConsistent: boolean;
      summary: string;
    };
  }> {
    const response = await api.post<{
      report?: {
        timestamp: string;
        characters: Record<string, {
          gridImage?: string;
          consistent: boolean;
          score: number;
          issues: Array<{
            id: string;
            source: 'entity';
            pageNumber: number | null;
            type: string;
            subType: string;
            severity: string;
            description: string;
            fixInstruction: string;
            affectedCharacter: string;
            cells?: string[];
            pagesToFix?: number[];
          }>;
          summary?: string;
          error?: string;
        }>;
        objects: Record<string, unknown>;
        grids: Array<{
          entityName: string;
          entityType: 'character' | 'object';
          gridImage: string;
          manifest: {
            createdAt: string;
            title: string;
            dimensions: { width: number; height: number };
            cellSize: number;
            cols: number;
            rows: number;
            cellCount: number;
            cells: Array<{
              letter: string;
              pageNumber?: number;
              isReference?: boolean;
              clothing?: string;
              cropType?: string;
            }>;
          };
          cellCount: number;
        }>;
        totalIssues: number;
        overallConsistent: boolean;
        summary: string;
      };
    }>(`/api/stories/${storyId}/repair-workflow/consistency-check`, {});
    return response;
  },

  // Step 6: Repair characters
  async repairCharacters(
    storyId: string,
    repairs: Array<{ character: string; pages: number[] }>,
    options?: { useMagicApiRepair?: boolean }
  ): Promise<{
    results: Array<{
      character: string;
      pagesRepaired: Array<{ pageNumber: number; imageData: string; versionIndex: number }>;
      pagesFailed?: Array<{ pageNumber: number; reason: string; rejected?: boolean; comparison?: { before: string; after: string; reference: string } | null }>;
      error?: string;
    }>;
  }> {
    const response = await api.post<{
      results: Array<{
        character: string;
        pagesRepaired: Array<{ pageNumber: number; imageData: string; versionIndex: number }>;
        pagesFailed?: Array<{ pageNumber: number; reason: string; rejected?: boolean; comparison?: { before: string; after: string; reference: string } | null }>;
        error?: string;
      }>;
    }>(`/api/stories/${storyId}/repair-workflow/character-repair`, {
      repairs,
      ...(options?.useMagicApiRepair !== undefined && { useMagicApiRepair: options.useMagicApiRepair })
    });
    return response;
  },

  // Step 7: Repair artifacts via grid repair
  async repairArtifacts(storyId: string, pageNumbers: number[]): Promise<{
    pagesProcessed: number[];
    issuesFixed: number;
  }> {
    const response = await api.post<{
      pagesProcessed: number[];
      issuesFixed: number;
    }>(`/api/stories/${storyId}/repair-workflow/artifact-repair`, { pageNumbers });
    return response;
  },

};

export default storyService;
