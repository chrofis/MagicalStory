import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

/**
 * Pre-loaded data that SEO pages need to render in initial HTML.
 * Populated at build time by the prerender script and serialized into
 * `window.__INITIAL_DATA__.seoData`. On the client, the SEODataProvider
 * picks this up and exposes it via context — so SEO components never
 * need a runtime fetch.
 *
 * For SPA routes (where no pre-render exists), the data lazy-loads
 * from `/api/swiss-stories` on first use.
 */
export interface LocalizedString {
  en: string;
  de: string;
  fr: string;
}

export interface CityIdea {
  id: string;
  title: LocalizedString;
  description: LocalizedString;
  context: LocalizedString;
}

export interface City {
  id: string;
  name: LocalizedString;
  canton: string;
  lat: number;
  lon: number;
  ideas: CityIdea[];
}

export interface Sage {
  id: string;
  title: LocalizedString;
  description: LocalizedString;
  context: LocalizedString;
  emoji: string;
  age: string;
}

export interface SwissStoriesData {
  cantons: Record<string, LocalizedString>;
  cities: City[];
  sagen: Sage[];
}

export interface SEOData {
  swissStories: SwissStoriesData | null;
}

interface SEODataContextValue {
  data: SEOData | null;
  loading: boolean;
  loadSwissStories: () => Promise<void>;
}

const SEODataContext = createContext<SEODataContextValue>({
  data: null,
  loading: false,
  loadSwissStories: async () => {},
});

interface SEODataProviderProps {
  children: ReactNode;
  /** Initial data injected by the prerender script (server-side) */
  initialData?: SEOData | null;
}

export function SEODataProvider({ children, initialData }: SEODataProviderProps) {
  const [data, setData] = useState<SEOData | null>(initialData || null);
  const [loading, setLoading] = useState(false);

  const loadSwissStories = async () => {
    if (data?.swissStories || loading) return;
    setLoading(true);
    try {
      const res = await fetch('/api/swiss-stories');
      const swissStories = (await res.json()) as SwissStoriesData;
      setData((prev) => ({ ...(prev || { swissStories: null }), swissStories }));
    } catch {
      // Silent — UI will show loading/empty state
    } finally {
      setLoading(false);
    }
  };

  return (
    <SEODataContext.Provider value={{ data, loading, loadSwissStories }}>
      {children}
    </SEODataContext.Provider>
  );
}

/**
 * Hook for SEO pages to read pre-loaded data.
 * Auto-loads Swiss stories on first call if not pre-rendered.
 */
export function useSwissStories(): {
  data: SwissStoriesData | null;
  loading: boolean;
} {
  const ctx = useContext(SEODataContext);
  useEffect(() => {
    if (!ctx.data?.swissStories && !ctx.loading) {
      ctx.loadSwissStories();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return {
    data: ctx.data?.swissStories || null,
    loading: ctx.loading,
  };
}
