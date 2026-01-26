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
  // Final checks: run image and text consistency checks at end of generation (default: OFF)
  enableFinalChecks: boolean;
  setEnableFinalChecks: (enable: boolean) => void;
  // Incremental consistency: check each image against previous images as they're generated
  incrementalConsistency: boolean;
  setIncrementalConsistency: (enable: boolean) => void;
  incrementalConsistencyDryRun: boolean;
  setIncrementalConsistencyDryRun: (enable: boolean) => void;
  // Number of previous pages to compare for incremental consistency (1-5)
  lookbackCount: number;
  setLookbackCount: (count: number) => void;
  // Check-only mode: run all quality checks but skip all regeneration/repair
  // Useful for analyzing issues before deciding on fixes
  checkOnlyMode: boolean;
  setCheckOnlyMode: (enable: boolean) => void;
  // Grid-based repair: use grid extraction + Gemini repair instead of legacy inpainting
  useGridRepair: boolean;
  setUseGridRepair: (enable: boolean) => void;
  // Force repair threshold: when set, repair ANY page with fixable issues if score < this value
  // Set to 100 to always repair pages with issues (for testing), null to use standard logic
  forceRepairThreshold: number | null;
  setForceRepairThreshold: (threshold: number | null) => void;
  // Load all avatar variants upfront (heavy - for debugging)
  loadAllAvatars: boolean;
  setLoadAllAvatars: (load: boolean) => void;
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
  imageModel: null,
  coverImageModel: null,
  qualityModel: null,
  imageBackend: null,
  avatarModel: null,
};

// Feature flag defaults (must match server/config/models.js MODEL_DEFAULTS)
const FEATURE_DEFAULTS = {
  enableAutoRepair: false,    // Auto-repair: fix detected issues in generated images
  enableFinalChecks: true,    // Final checks: run consistency checks at end of generation
  incrementalConsistency: false,  // Incremental consistency: check each image against previous
  incrementalConsistencyDryRun: true, // Dry run: log what would be fixed without fixing
  lookbackCount: 3,             // Number of previous pages to compare (1-5)
  checkOnlyMode: false,       // Check-only mode: run checks but skip all regeneration
  useGridRepair: true,        // Grid-based repair: use grid extraction instead of legacy inpainting
  forceRepairThreshold: null as number | null, // Force repair: null = standard logic, 100 = always repair
};

/**
 * Hook to manage developer mode state for story wizard
 * Persists developer mode setting in localStorage for admins
 *
 * Model defaults are the same for dev and prod (null = server defaults from server/config/models.js)
 * Feature defaults (enableAutoRepair, enableFinalChecks) also match server/config/models.js
 *
 * When developer mode is enabled:
 * - Skip cover images by default (saves credits during testing)
 * - Shows additional debug info and controls in the UI
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

  // Auto-repair: automatically fix detected issues in generated images
  const [enableAutoRepair, setEnableAutoRepair] = useState(FEATURE_DEFAULTS.enableAutoRepair);

  // Final checks: run image and text consistency checks at end of generation
  const [enableFinalChecks, setEnableFinalChecks] = useState(FEATURE_DEFAULTS.enableFinalChecks);

  // Incremental consistency: check each image against previous images as they're generated
  const [incrementalConsistency, setIncrementalConsistency] = useState(FEATURE_DEFAULTS.incrementalConsistency);
  const [incrementalConsistencyDryRun, setIncrementalConsistencyDryRun] = useState(FEATURE_DEFAULTS.incrementalConsistencyDryRun);
  const [lookbackCount, setLookbackCount] = useState(FEATURE_DEFAULTS.lookbackCount);

  // Check-only mode: run all quality checks but skip all regeneration/repair
  const [checkOnlyMode, setCheckOnlyMode] = useState(FEATURE_DEFAULTS.checkOnlyMode);

  // Grid-based repair: use grid extraction + Gemini repair instead of legacy inpainting
  const [useGridRepair, setUseGridRepair] = useState(FEATURE_DEFAULTS.useGridRepair);

  // Force repair threshold: when set, repair ANY page with fixable issues if score < this value
  const [forceRepairThreshold, setForceRepairThreshold] = useState<number | null>(FEATURE_DEFAULTS.forceRepairThreshold);

  // Load all avatar variants upfront (heavy - for debugging avatar generation)
  const [loadAllAvatars, setLoadAllAvatars] = useState(false);

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
    enableFinalChecks,
    setEnableFinalChecks,
    incrementalConsistency,
    setIncrementalConsistency,
    incrementalConsistencyDryRun,
    setIncrementalConsistencyDryRun,
    lookbackCount,
    setLookbackCount,
    checkOnlyMode,
    setCheckOnlyMode,
    useGridRepair,
    setUseGridRepair,
    forceRepairThreshold,
    setForceRepairThreshold,
    loadAllAvatars,
    setLoadAllAvatars,
    modelSelections,
    setModelSelections,
  };
}
