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
  /** True once the COMPLETE dataset (all cities' ideas) has been fetched. The
   *  prerender injects only a partial set (current city only), so this stays
   *  false until the client fetches /api/swiss-stories. */
  full: boolean;
  loadSwissStories: () => Promise<void>;
}

const SEODataContext = createContext<SEODataContextValue>({
  data: null,
  loading: false,
  full: false,
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
  // The prerender-injected initialData is PARTIAL — only the current city keeps
  // its ideas[]; every other city is stripped to ideas:[] to keep the inlined
  // payload small. So `full` starts false even when swissStories is present, and
  // we fetch the COMPLETE set once on the client. Without this, navigating from
  // one prerendered city page to another shows no historical stories (the target
  // city's ideas were stripped). See useSwissStories below.
  const [full, setFull] = useState(false);

  const loadSwissStories = async () => {
    if (loading || full) return;
    setLoading(true);
    try {
      const res = await fetch('/api/swiss-stories');
      const swissStories = (await res.json()) as SwissStoriesData;
      setData((prev) => ({ ...(prev || { swissStories: null }), swissStories }));
      setFull(true);
    } catch {
      // Silent — UI keeps the partial (current-city) data
    } finally {
      setLoading(false);
    }
  };

  return (
    <SEODataContext.Provider value={{ data, loading, full, loadSwissStories }}>
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
    // Fetch the COMPLETE dataset whenever we don't have it yet — this covers
    // both the no-data SPA case and the partial prerender case (so client-side
    // navigation to another city still has that city's historical stories).
    if (!ctx.full && !ctx.loading) {
      ctx.loadSwissStories();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return {
    data: ctx.data?.swissStories || null,
    loading: ctx.loading,
  };
}
