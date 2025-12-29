import { useState, useEffect } from 'react';
import type { ModelSelections } from '@/components/generation';

interface DeveloperModeState {
  developerMode: boolean;
  setDeveloperMode: (enabled: boolean) => void;
  imageGenMode: 'parallel' | 'sequential' | null;
  setImageGenMode: (mode: 'parallel' | 'sequential' | null) => void;
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
  // Model selections
  modelSelections: ModelSelections;
  setModelSelections: React.Dispatch<React.SetStateAction<ModelSelections>>;
}

/**
 * Hook to manage developer mode state for story wizard
 * Persists developer mode setting in localStorage for admins
 */
export function useDeveloperMode(): DeveloperModeState {
  const [developerMode, setDeveloperMode] = useState(() => {
    return localStorage.getItem('developer_mode') === 'true';
  });
  const [imageGenMode, setImageGenMode] = useState<'parallel' | 'sequential' | null>(null);

  // Developer skip options for faster testing
  const [devSkipOutline, setDevSkipOutline] = useState(false);
  const [devSkipText, setDevSkipText] = useState(false);
  const [devSkipSceneDescriptions, setDevSkipSceneDescriptions] = useState(false);
  const [devSkipImages, setDevSkipImages] = useState(false);
  const [devSkipCovers, setDevSkipCovers] = useState(false);

  // Developer model selection (admin only)
  const [modelSelections, setModelSelections] = useState<ModelSelections>({
    ideaModel: null,
    outlineModel: null,
    textModel: null,
    sceneDescriptionModel: null,
    imageModel: null,
    coverImageModel: null,
    qualityModel: null,
  });

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
    modelSelections,
    setModelSelections,
  };
}
