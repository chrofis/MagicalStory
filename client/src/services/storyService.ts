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

interface StoryDetails {
  id: string;
  title: string;
  story_type: string;
  art_style: string;
  language: Language;
  language_level: LanguageLevel;
  pages: number;
  dedication?: string;
  characters: Character[];
  main_characters: number[];
  relationships: RelationshipMap;
  relationship_texts: RelationshipTextMap;
  outline?: string;
  story?: string;
  scene_descriptions?: SceneDescription[];
  scene_images?: SceneImage[];
  cover_images?: CoverImages;
  thumbnail?: string;
  created_at: string;
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
    const response = await api.get<{ stories: StoryListItem[] }>('/api/stories');
    return response.stories || [];
  },

  async getStory(id: string): Promise<SavedStory | null> {
    try {
      const response = await api.get<{ story: StoryDetails }>(`/api/stories/${id}`);
      const s = response.story;
      return {
        id: s.id,
        title: s.title,
        storyType: s.story_type,
        artStyle: s.art_style,
        language: s.language,
        languageLevel: s.language_level,
        pages: s.pages,
        dedication: s.dedication,
        characters: s.characters,
        mainCharacters: s.main_characters,
        relationships: s.relationships,
        relationshipTexts: s.relationship_texts,
        outline: s.outline,
        story: s.story,
        sceneDescriptions: s.scene_descriptions,
        sceneImages: s.scene_images,
        coverImages: s.cover_images,
        thumbnail: s.thumbnail,
        createdAt: s.created_at,
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
      status: string;
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
    }>(`/api/jobs/${jobId}`);
    return {
      status: response.status as 'pending' | 'processing' | 'completed' | 'failed',
      progress: response.progress,
      result: response.result,
      error: response.error,
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
