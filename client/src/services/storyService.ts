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
  storyText?: string;
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
    console.log('[storyService] getStories: fetching...');
    // Server returns array directly, not { stories: [...] }
    const response = await api.get<StoryListItemServer[]>('/api/stories');
    console.log('[storyService] getStories: raw response:', response);
    // Map server format to client format
    const mapped = (response || []).map(s => ({
      id: s.id,
      title: s.title,
      story_type: '', // Not returned in list view
      art_style: '', // Not returned in list view
      language: s.language,
      pages: s.pageCount || s.pages || 0,
      created_at: s.createdAt,
      thumbnail: s.thumbnail,
    }));
    console.log('[storyService] getStories: mapped:', mapped);
    return mapped;
  },

  async getStory(id: string): Promise<SavedStory | null> {
    try {
      // Server returns story directly, not wrapped in { story: ... }
      const s = await api.get<StoryDetailsServer>(`/api/stories/${id}`);
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
        story: s.storyText,
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
    const response = await api.post<{ image_data: string }>(
      `/api/stories/${storyId}/regenerate/image/${pageNum}`
    );
    return { imageData: response.image_data };
  },

  async regenerateCover(storyId: string, coverType: 'front' | 'back' | 'initial'): Promise<{ imageData: string }> {
    const response = await api.post<{ image_data: string }>(
      `/api/stories/${storyId}/regenerate/cover/${coverType}`
    );
    return { imageData: response.image_data };
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
      story: string;
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
        storyText?: string; // Server uses storyText
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
        story: resultData.storyText || '', // Map storyText -> story
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
};

export default storyService;
