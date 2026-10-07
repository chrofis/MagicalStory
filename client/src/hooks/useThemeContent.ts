import { useEffect, useState } from 'react';
import { useSEOData } from '@/context/SEODataContext';
import { loadThemeContent, type ThemeContent } from '@/constants/themeContent';

/**
 * Content of one theme page. Hydration reads the entry the prerender injected
 * (so the markup matches); client-side navigation loads the theme's own chunk.
 * Returns null while loading and for an unknown theme.
 *
 * Lives here, not in SEODataContext: the loader map (181 import() entries) is
 * part of whichever chunk imports it, and only ThemePage should pay for it.
 */
export function useThemeContent(themeId: string): ThemeContent | null {
  const preloaded = useSEOData()?.themeContent?.[themeId] || null;
  const [loaded, setLoaded] = useState<{ id: string; content: ThemeContent | null } | null>(null);
  useEffect(() => {
    if (preloaded || !themeId) return;
    let alive = true;
    loadThemeContent(themeId).then((content) => {
      if (alive) setLoaded({ id: themeId, content });
    });
    return () => { alive = false; };
  }, [themeId, preloaded]);
  if (preloaded) return preloaded;
  return loaded?.id === themeId ? loaded.content : null;
}
