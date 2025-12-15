import api from './api';
import type { Character, RelationshipMap, RelationshipTextMap } from '@/types/character';
import type { SavedStory, Language, LanguageLevel, SceneDescription, SceneImage, CoverImages } from '@/types/story';

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
  thumbnail?: string;
}

interface StoryListItem {
  id: string;
  title: string;
  story_type: string;
  art_style: string;
  language: Language;
  pages: number;
  created_at: string;
  thumbnail?: string;
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
  sceneDescriptions?: SceneDescription[];
  sceneImages?: SceneImage[];
  coverImages?: CoverImages;
  thumbnail?: string;
  createdAt: string;
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
  async getStories(): Promise<StoryListItem[]> {
    // Server returns array directly, not { stories: [...] }
    const response = await api.get<StoryListItemServer[]>('/api/stories');
    // Map server format to client format
    return (response || []).map(s => ({
      id: s.id,
      title: s.title,
      story_type: '', // Not returned in list view
      art_style: '', // Not returned in list view
      language: s.language,
      pages: s.pageCount || s.pages || 0,
      created_at: s.createdAt,
      thumbnail: s.thumbnail,
    }));
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
        sceneDescriptions: s.sceneDescriptions,
        sceneImages: s.sceneImages,
        coverImages: s.coverImages,
        thumbnail: s.thumbnail,
        createdAt: s.createdAt,
      };
    } catch {
      return null;
    }
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

  async regenerateImage(storyId: string, pageNum: number): Promise<{ imageData: string }> {
    const response = await api.post<{ imageData: string }>(
      `/api/stories/${storyId}/regenerate/image/${pageNum}`
    );
    return { imageData: response.imageData };
  },

  async regenerateCover(storyId: string, coverType: 'front' | 'back' | 'initial'): Promise<{
    imageData: string;
    description?: string;
    prompt?: string;
    qualityScore?: number;
    qualityReasoning?: string;
  }> {
    const response = await api.post<{
      imageData: string;
      description?: string;
      prompt?: string;
      qualityScore?: number;
      qualityReasoning?: string;
    }>(
      `/api/stories/${storyId}/regenerate/cover/${coverType}`
    );
    return {
      imageData: response.imageData,
      description: response.description,
      prompt: response.prompt,
      qualityScore: response.qualityScore,
      qualityReasoning: response.qualityReasoning
    };
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

  // Edit image with user prompt
  async editImage(storyId: string, pageNumber: number, editPrompt: string): Promise<{ imageData: string }> {
    const response = await api.post<{ imageData: string }>(
      `/api/stories/${storyId}/edit/image/${pageNumber}`,
      { editPrompt }
    );
    return { imageData: response.imageData };
  },

  // Edit cover with user prompt
  async editCover(storyId: string, coverType: 'front' | 'back' | 'initial', editPrompt: string): Promise<{ imageData: string }> {
    const response = await api.post<{ imageData: string }>(
      `/api/stories/${storyId}/edit/cover/${coverType}`,
      { editPrompt }
    );
    return { imageData: response.imageData };
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
      visualBible?: {
        secondaryCharacters: Array<{ id: string; name: string; appearsInPages: number[]; description: string; extractedDescription: string | null; firstAppearanceAnalyzed: boolean }>;
        animals: Array<{ id: string; name: string; appearsInPages: number[]; description: string; extractedDescription: string | null; firstAppearanceAnalyzed: boolean }>;
        artifacts: Array<{ id: string; name: string; appearsInPages: number[]; description: string; extractedDescription: string | null; firstAppearanceAnalyzed: boolean }>;
        locations: Array<{ id: string; name: string; appearsInPages: number[]; description: string; extractedDescription: string | null; firstAppearanceAnalyzed: boolean }>;
      };
      sceneDescriptions: SceneDescription[];
      sceneImages: SceneImage[];
      coverImages?: CoverImages;
    };
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
        visualBible?: {
          secondaryCharacters: Array<{ id: string; name: string; appearsInPages: number[]; description: string; extractedDescription: string | null; firstAppearanceAnalyzed: boolean }>;
          animals: Array<{ id: string; name: string; appearsInPages: number[]; description: string; extractedDescription: string | null; firstAppearanceAnalyzed: boolean }>;
          artifacts: Array<{ id: string; name: string; appearsInPages: number[]; description: string; extractedDescription: string | null; firstAppearanceAnalyzed: boolean }>;
          locations: Array<{ id: string; name: string; appearsInPages: number[]; description: string; extractedDescription: string | null; firstAppearanceAnalyzed: boolean }>;
        };
        sceneDescriptions?: SceneDescription[];
        sceneImages?: SceneImage[];
        coverImages?: CoverImages;
      };
      errorMessage?: string;
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
      error: response.errorMessage,
    };
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

  // Stripe checkout for book purchase
  async createCheckoutSession(storyId: string): Promise<{ url: string }> {
    const response = await api.post<{ url: string }>('/api/stripe/create-checkout-session', {
      storyId,
    });
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
};

export default storyService;
