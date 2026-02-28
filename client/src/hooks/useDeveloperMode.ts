import { useState, useEffect } from 'react';
import type { ModelSelections } from '@/components/generation';

// Generation mode: auto follows reading level, others force specific pipeline
export type GenerationMode = 'auto' | 'pictureBook' | 'outlineAndText';

interface DeveloperModeState {
  developerMode: boolean;
  setDeveloperMode: (enabled: boolean) => void;
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
  // Full repair: generate all → evaluate → regen low-scoring → character fix (default: ON)
  enableFullRepair: boolean;
  setEnableFullRepair: (enable: boolean) => void;
  // Load all avatar variants upfront (heavy - for debugging)
  loadAllAvatars: boolean;
  setLoadAllAvatars: (load: boolean) => void;
  // MagicAPI repair: use face swap + hair fix pipeline instead of Gemini for character repair
  useMagicApiRepair: boolean;
  setUseMagicApiRepair: (use: boolean) => void;
  // Model selections
  modelSelections: ModelSelections;
  setModelSelections: React.Dispatch<React.SetStateAction<ModelSelections>>;
}

// Default model selections (null = server defaults from server/config/models.js)
// Same defaults for both dev and prod - server has the best quality models configured
const MODEL_DEFAULTS: ModelSelections = {
  ideaModel: null,
  outlineModel: null,
  textModel: null,
  sceneDescriptionModel: null,
  sceneIterationModel: null,
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
 * Model defaults are the same for dev and prod (null = server defaults from server/config/models.js)
 *
 * When developer mode is enabled:
 * - Skip cover images by default (saves credits during testing)
 * - Shows additional debug info and controls in the UI
 */
export function useDeveloperMode(): DeveloperModeState {
  // Check if dev mode was previously enabled
  const wasDevMode = localStorage.getItem('developer_mode') === 'true';

  const [developerMode, setDeveloperModeInternal] = useState(wasDevMode);

  // Generation pipeline mode (override reading level behavior)
  const [generationMode, setGenerationMode] = useState<GenerationMode>('auto');

  // Developer skip options for faster testing
  const [devSkipOutline, setDevSkipOutline] = useState(false);
  const [devSkipText, setDevSkipText] = useState(false);
  const [devSkipSceneDescriptions, setDevSkipSceneDescriptions] = useState(false);
  const [devSkipImages, setDevSkipImages] = useState(false);
  // Skip covers by default in dev mode
  const [devSkipCovers, setDevSkipCovers] = useState(wasDevMode);

  // Full repair after generation (default: ON)
  // When ON: generate all → evaluate all → regen low-scoring (up to 2 passes) → pick best → character fix
  // When OFF: generate all → evaluate only (scores visible but no regeneration)
  const [enableFullRepair, setEnableFullRepair] = useState(true);

  // Load all avatar variants upfront (heavy - for debugging avatar generation)
  const [loadAllAvatars, setLoadAllAvatars] = useState(false);

  // MagicAPI repair: use face swap + hair fix pipeline instead of Gemini for character repair
  const [useMagicApiRepair, setUseMagicApiRepair] = useState(false);

  // Model selection - same defaults for dev and prod (null = server defaults)
  const [modelSelections, setModelSelections] = useState<ModelSelections>({ ...MODEL_DEFAULTS });

  // Custom setter that also updates skip flags when toggling dev mode
  const setDeveloperMode = (enabled: boolean) => {
    setDeveloperModeInternal(enabled);

    if (enabled) {
      // Switching TO developer mode: skip covers by default (saves credits during testing)
      setDevSkipCovers(true);
    } else {
      // Switching FROM developer mode: enable covers
      setDevSkipCovers(false);
    }
    // Model selections stay the same (server defaults) regardless of dev mode
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
    enableFullRepair,
    setEnableFullRepair,
    loadAllAvatars,
    setLoadAllAvatars,
    useMagicApiRepair,
    setUseMagicApiRepair,
    modelSelections,
    setModelSelections,
  };
}
