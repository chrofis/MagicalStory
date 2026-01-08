import { useState, useEffect } from 'react';
import type { ModelSelections } from '@/components/generation';

// Generation mode: auto follows reading level, others force specific pipeline
export type GenerationMode = 'auto' | 'pictureBook' | 'outlineAndText';

interface DeveloperModeState {
  developerMode: boolean;
  setDeveloperMode: (enabled: boolean) => void;
  imageGenMode: 'parallel' | 'sequential' | null;
  setImageGenMode: (mode: 'parallel' | 'sequential' | null) => void;
  // Generation pipeline mode (dev override for reading level behavior)
  generationMode: GenerationMode;
  setGenerationMode: (mode: GenerationMode) => void;
  // Skip flags for faster testing
  devSkipOutline: boolean;
  setDevSkipOutline: (skip: boolean) => void;
  devSkipText: boolean;
  setDevSkipText: (skip: boolean) => void;
  devSkipSceneDescriptions: boolean;
  setDevSkipSceneDescriptions: (skip: boolean) => void;
  devSkipImages: boolean;
  setDevSkipImages: (skip: boolean) => void;
  devSkipCovers: boolean;
  setDevSkipCovers: (skip: boolean) => void;
  // Auto-repair: automatically fix detected issues in generated images (default: OFF)
  enableAutoRepair: boolean;
  setEnableAutoRepair: (enable: boolean) => void;
  // Model selections
  modelSelections: ModelSelections;
  setModelSelections: React.Dispatch<React.SetStateAction<ModelSelections>>;
}

// Default model selections for developers (cheap/fast models to save credits)
const DEV_MODEL_DEFAULTS: ModelSelections = {
  ideaModel: 'gemini-2.0-flash',
  outlineModel: 'gemini-2.0-flash',
  textModel: 'claude-haiku',
  sceneDescriptionModel: 'gemini-2.0-flash',
  imageModel: null,  // Server default
  coverImageModel: null,
  qualityModel: 'gemini-2.0-flash',
  imageBackend: 'runware',  // Cheapest image backend ($0.0006/image)
  avatarModel: 'ace-plus-plus',  // Cheap face-consistent avatar model (~$0.005/image)
};

// Default model selections for production (null = server defaults = best quality)
const PROD_MODEL_DEFAULTS: ModelSelections = {
  ideaModel: null,
  outlineModel: null,
  textModel: null,
  sceneDescriptionModel: null,
  imageModel: null,
  coverImageModel: null,
  qualityModel: null,
  imageBackend: null,
  avatarModel: null,
};

/**
 * Hook to manage developer mode state for story wizard
 * Persists developer mode setting in localStorage for admins
 *
 * When developer mode is enabled:
 * - Skip cover images by default (saves credits)
 * - Use cheapest models by default (haiku for text, runware for images)
 */
export function useDeveloperMode(): DeveloperModeState {
  // Check if dev mode was previously enabled
  const wasDevMode = localStorage.getItem('developer_mode') === 'true';

  const [developerMode, setDeveloperModeInternal] = useState(wasDevMode);
  const [imageGenMode, setImageGenMode] = useState<'parallel' | 'sequential' | null>(null);

  // Generation pipeline mode (override reading level behavior)
  const [generationMode, setGenerationMode] = useState<GenerationMode>('auto');

  // Developer skip options for faster testing
  const [devSkipOutline, setDevSkipOutline] = useState(false);
  const [devSkipText, setDevSkipText] = useState(false);
  const [devSkipSceneDescriptions, setDevSkipSceneDescriptions] = useState(false);
  const [devSkipImages, setDevSkipImages] = useState(false);
  // Skip covers by default in dev mode
  const [devSkipCovers, setDevSkipCovers] = useState(wasDevMode);

  // Auto-repair: automatically fix detected issues in generated images (default: OFF)
  const [enableAutoRepair, setEnableAutoRepair] = useState(false);

  // Developer model selection - initialize based on dev mode
  const [modelSelections, setModelSelections] = useState<ModelSelections>(
    wasDevMode ? { ...DEV_MODEL_DEFAULTS } : { ...PROD_MODEL_DEFAULTS }
  );

  // Custom setter that also updates defaults when toggling dev mode
  const setDeveloperMode = (enabled: boolean) => {
    setDeveloperModeInternal(enabled);

    if (enabled) {
      // Switching TO developer mode: set cheap defaults
      setDevSkipCovers(true);
      setModelSelections({ ...DEV_MODEL_DEFAULTS });
    } else {
      // Switching FROM developer mode: reset to production defaults
      setDevSkipCovers(false);
      setModelSelections({ ...PROD_MODEL_DEFAULTS });
    }
  };

  // Persist developer mode changes
  useEffect(() => {
    if (developerMode) {
      localStorage.setItem('developer_mode', 'true');
    } else {
      localStorage.removeItem('developer_mode');
    }
  }, [developerMode]);

  return {
    developerMode,
    setDeveloperMode,
    imageGenMode,
    setImageGenMode,
    generationMode,
    setGenerationMode,
    devSkipOutline,
    setDevSkipOutline,
    devSkipText,
    setDevSkipText,
    devSkipSceneDescriptions,
    setDevSkipSceneDescriptions,
    devSkipImages,
    setDevSkipImages,
    devSkipCovers,
    setDevSkipCovers,
    enableAutoRepair,
    setEnableAutoRepair,
    modelSelections,
    setModelSelections,
  };
}
