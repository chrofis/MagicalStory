import api from './api';
import type {
  Character,
  RelationshipMap,
  RelationshipTextMap,
  VisualBible
} from '@/types/character';
import type { SavedStory, Language, LanguageLevel, SceneDescription, SceneImage, CoverImages, RetryAttempt, ImageVersion } from '@/types/story';

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
  language: Language;
}

interface StoryListItemServer {
  id: string;
  title: string;
  createdAt: string;
  updatedAt?: string;
  pages: number;
  language: Language;
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
  language: Language;
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
  artStyle: string;
  language: Language;
  languageLevel: LanguageLevel;
  pages: number;
  dedication?: string;
  characters: Character[];
  mainCharacters: number[];
  relationships: RelationshipMap;
  relationshipTexts: RelationshipTextMap;
  outline?: string;
  outlinePrompt?: string;
  storyText?: string; // New stories use this
  story?: string; // Old stories use this
  storyTextPrompts?: Array<{ batch: number; startPage: number; endPage: number; prompt: string }>;
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

  async createStory(data: {
    title: string;
    storyType: string;
    artStyle: string;
    language: Language;
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

  async regenerateImage(storyId: string, pageNum: number): Promise<{
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
    }>(
      `/api/stories/${storyId}/regenerate/image/${pageNum}`
    );
    return response;
  },

  async regenerateCover(storyId: string, coverType: 'front' | 'back' | 'initial'): Promise<{
    imageData: string;
    description?: string;
    prompt?: string;
    qualityScore?: number;
    qualityReasoning?: string;
    totalAttempts?: number;
    retryHistory?: RetryAttempt[];
    creditsUsed?: number;
    creditsRemaining?: number;
  }> {
    const response = await api.post<{
      imageData: string;
      description?: string;
      prompt?: string;
      qualityScore?: number;
      qualityReasoning?: string;
      totalAttempts?: number;
      retryHistory?: RetryAttempt[];
      creditsUsed?: number;
      creditsRemaining?: number;
    }>(
      `/api/stories/${storyId}/regenerate/cover/${coverType}`
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
    language: 'en' | 'de' | 'fr';
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
  }): Promise<{ storyIdea: string }> {
    const response = await api.post<{ storyIdea: string }>('/api/generate-story-ideas', data);
    return response;
  },

  // Job-based story generation
  async createStoryJob(data: {
    storyType: string;
    storyTypeName: string;
    artStyle: string;
    language: Language;
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
    // Developer skip options
    skipOutline?: boolean;
    skipText?: boolean;
    skipSceneDescriptions?: boolean;
    skipCovers?: boolean;
    // Developer model overrides (admin only)
    modelOverrides?: {
      outlineModel?: string | null;
      textModel?: string | null;
      sceneDescriptionModel?: string | null;
      imageModel?: string | null;
      coverImageModel?: string | null;
      qualityModel?: string | null;
    };
  }): Promise<{ jobId: string }> {
    const response = await api.post<{ jobId: string; message: string }>('/api/jobs/create-story', {
      storyType: data.storyType,
      storyTypeName: data.storyTypeName,
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
      // Developer skip options
      skipOutline: data.skipOutline,
      skipText: data.skipText,
      skipSceneDescriptions: data.skipSceneDescriptions,
      skipCovers: data.skipCovers,
      // Developer model overrides
      modelOverrides: data.modelOverrides,
    });
    return { jobId: response.jobId };
  },

  async getJobStatus(jobId: string): Promise<{
    status: 'pending' | 'processing' | 'completed' | 'failed';
    progress?: { current: number; total: number; message: string };
    result?: {
      storyId: string;
      title: string;
      outline: string;
      outlinePrompt?: string;
      story: string;
      storyTextPrompts?: Array<{ batch: number; startPage: number; endPage: number; prompt: string }>;
      visualBible?: VisualBible;
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
        storyText?: string; // Server uses storyText
        storyTextPrompts?: Array<{ batch: number; startPage: number; endPage: number; prompt: string }>;
        visualBible?: VisualBible;
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
    }>(`/api/jobs/${jobId}/status`);

    // Map server response to client format
    const resultData = response.resultData;
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
        story: resultData.storyText || '', // Map storyText -> story
        storyTextPrompts: resultData.storyTextPrompts,
        visualBible: resultData.visualBible,
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

  // PDF generation
  async generatePdf(storyId: string): Promise<Blob> {
    const token = localStorage.getItem('auth_token');
    const response = await fetch(`/api/stories/${storyId}/pdf`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!response.ok) {
      throw new Error('Failed to generate PDF');
    }
    return response.blob();
  },

  // Stripe checkout for book purchase (supports single story or multiple stories)
  async createCheckoutSession(storyIds: string | string[], coverType?: 'softcover' | 'hardcover'): Promise<{ url: string }> {
    const ids = Array.isArray(storyIds) ? storyIds : [storyIds];
    const response = await api.post<{ url: string }>('/api/stripe/create-checkout-session', {
      storyIds: ids,
      coverType: coverType || 'softcover',
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

  // Select which image version is active
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

};

export default storyService;
