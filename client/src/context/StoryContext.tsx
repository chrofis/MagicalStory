import { createContext, useContext, useReducer, type ReactNode } from 'react';
import type { Character, RelationshipMap, RelationshipTextMap } from '@/types/character';
import type { LanguageLevel, SceneDescription, SceneImage, CoverImages, StoryGenerationProgress } from '@/types/story';

interface StoryState {
  // Step 1: Story Type & Art Style
  storyType: string;
  artStyle: string;
  storyDetails: string;

  // Step 2: Characters
  characters: Character[];
  currentCharacterId: number | null;

  // Step 3: Relationships
  relationships: RelationshipMap;
  relationshipTexts: RelationshipTextMap;

  // Step 4: Settings
  pages: number;
  languageLevel: LanguageLevel;
  mainCharacters: number[];
  dedication: string;

  // Step 5: Generated Content
  storyOutline: string;
  generatedStory: string;
  storyTitle: string;
  sceneDescriptions: SceneDescription[];
  sceneImages: SceneImage[];
  coverImages: CoverImages;

  // Generation State
  isGenerating: boolean;
  generationProgress: StoryGenerationProgress | null;
  currentStoryId: string | null;

  // UI State
  currentStep: number;
}

type StoryAction =
  | { type: 'SET_STORY_TYPE'; payload: string }
  | { type: 'SET_ART_STYLE'; payload: string }
  | { type: 'SET_STORY_DETAILS'; payload: string }
  | { type: 'ADD_CHARACTER'; payload: Character }
  | { type: 'UPDATE_CHARACTER'; payload: Character }
  | { type: 'DELETE_CHARACTER'; payload: number }
  | { type: 'SET_CURRENT_CHARACTER'; payload: number | null }
  | { type: 'SET_CHARACTERS'; payload: Character[] }
  | { type: 'SET_RELATIONSHIP'; payload: { key: string; value: string } }
  | { type: 'SET_RELATIONSHIP_TEXT'; payload: { key: string; value: string } }
  | { type: 'SET_RELATIONSHIPS'; payload: RelationshipMap }
  | { type: 'SET_PAGES'; payload: number }
  | { type: 'SET_LANGUAGE_LEVEL'; payload: LanguageLevel }
  | { type: 'SET_MAIN_CHARACTERS'; payload: number[] }
  | { type: 'SET_DEDICATION'; payload: string }
  | { type: 'SET_OUTLINE'; payload: string }
  | { type: 'SET_GENERATED_STORY'; payload: { story: string; title: string } }
  | { type: 'SET_SCENE_DESCRIPTIONS'; payload: SceneDescription[] }
  | { type: 'SET_SCENE_IMAGE'; payload: { pageNumber: number; imageData: string; score?: number } }
  | { type: 'SET_COVER_IMAGES'; payload: Partial<CoverImages> }
  | { type: 'SET_GENERATING'; payload: boolean }
  | { type: 'SET_GENERATION_PROGRESS'; payload: StoryGenerationProgress | null }
  | { type: 'SET_CURRENT_STORY_ID'; payload: string | null }
  | { type: 'SET_STEP'; payload: number }
  | { type: 'LOAD_STORY'; payload: Partial<StoryState> }
  | { type: 'RESET_STORY' };

const initialState: StoryState = {
  storyType: '',
  artStyle: '',
  storyDetails: '',
  characters: [],
  currentCharacterId: null,
  relationships: {},
  relationshipTexts: {},
  pages: 30,
  languageLevel: 'standard',
  mainCharacters: [],
  dedication: '',
  storyOutline: '',
  generatedStory: '',
  storyTitle: '',
  sceneDescriptions: [],
  sceneImages: [],
  coverImages: {
    frontCover: null,
    initialPage: null,
    backCover: null,
  },
  isGenerating: false,
  generationProgress: null,
  currentStoryId: null,
  currentStep: 0,
};

function storyReducer(state: StoryState, action: StoryAction): StoryState {
  switch (action.type) {
    case 'SET_STORY_TYPE':
      return { ...state, storyType: action.payload };
    case 'SET_ART_STYLE':
      return { ...state, artStyle: action.payload };
    case 'SET_STORY_DETAILS':
      return { ...state, storyDetails: action.payload };
    case 'ADD_CHARACTER':
      return { ...state, characters: [...state.characters, action.payload] };
    case 'UPDATE_CHARACTER':
      return {
        ...state,
        characters: state.characters.map(c =>
          c.id === action.payload.id ? action.payload : c
        ),
      };
    case 'DELETE_CHARACTER':
      return {
        ...state,
        characters: state.characters.filter(c => c.id !== action.payload),
        mainCharacters: state.mainCharacters.filter(id => id !== action.payload),
      };
    case 'SET_CURRENT_CHARACTER':
      return { ...state, currentCharacterId: action.payload };
    case 'SET_CHARACTERS':
      return { ...state, characters: action.payload };
    case 'SET_RELATIONSHIP':
      return {
        ...state,
        relationships: { ...state.relationships, [action.payload.key]: action.payload.value },
      };
    case 'SET_RELATIONSHIP_TEXT':
      return {
        ...state,
        relationshipTexts: { ...state.relationshipTexts, [action.payload.key]: action.payload.value },
      };
    case 'SET_RELATIONSHIPS':
      return { ...state, relationships: action.payload };
    case 'SET_PAGES':
      return { ...state, pages: action.payload };
    case 'SET_LANGUAGE_LEVEL':
      return { ...state, languageLevel: action.payload };
    case 'SET_MAIN_CHARACTERS':
      return { ...state, mainCharacters: action.payload };
    case 'SET_DEDICATION':
      return { ...state, dedication: action.payload };
    case 'SET_OUTLINE':
      return { ...state, storyOutline: action.payload };
    case 'SET_GENERATED_STORY':
      return { ...state, generatedStory: action.payload.story, storyTitle: action.payload.title };
    case 'SET_SCENE_DESCRIPTIONS':
      return { ...state, sceneDescriptions: action.payload };
    case 'SET_SCENE_IMAGE':
      return {
        ...state,
        sceneImages: [
          ...state.sceneImages.filter(s => s.pageNumber !== action.payload.pageNumber),
          action.payload,
        ].sort((a, b) => a.pageNumber - b.pageNumber),
      };
    case 'SET_COVER_IMAGES':
      return { ...state, coverImages: { ...state.coverImages, ...action.payload } };
    case 'SET_GENERATING':
      return { ...state, isGenerating: action.payload };
    case 'SET_GENERATION_PROGRESS':
      return { ...state, generationProgress: action.payload };
    case 'SET_CURRENT_STORY_ID':
      return { ...state, currentStoryId: action.payload };
    case 'SET_STEP':
      return { ...state, currentStep: action.payload };
    case 'LOAD_STORY':
      return { ...state, ...action.payload };
    case 'RESET_STORY':
      return { ...initialState };
    default:
      return state;
  }
}

interface StoryContextType {
  state: StoryState;
  dispatch: React.Dispatch<StoryAction>;
}

const StoryContext = createContext<StoryContextType | null>(null);

export function StoryProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(storyReducer, initialState);

  return (
    <StoryContext.Provider value={{ state, dispatch }}>
      {children}
    </StoryContext.Provider>
  );
}

export function useStory() {
  const context = useContext(StoryContext);
  if (!context) {
    throw new Error('useStory must be used within a StoryProvider');
  }
  return context;
}
