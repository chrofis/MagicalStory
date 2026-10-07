// Rich SEO content for theme pages — description, longDescription, skills, FAQ.
// One JSON file per theme under ./themeContent/<themeId>.json; ThemePage.tsx is
// the only consumer (through useThemeContent in SEODataContext).
//
// Why one file per theme, loaded on demand: the content of all 181 themes was a
// single 1.6 MB module, so EVERY theme page shipped the whole catalogue as part
// of its chunk (ThemePage chunk 1,650 kB, 550 kB gzipped — the largest file of
// the build by 4x). A theme page needs exactly one entry. The prerender injects
// that entry into window.__INITIAL_DATA__ for hydration; client-side navigation
// loads the ~5 kB chunk for the theme instead.

export type LocalizedDesc = { en: string; de: string; fr: string; it: string };

export interface ThemeFAQ {
  q: { en: string; de: string; fr: string; it: string };
  a: { en: string; de: string; fr: string; it: string };
}

export interface ThemeContent {
  description: LocalizedDesc;
  longDescription: LocalizedDesc;
  skills: LocalizedDesc;
  ageRecommendation: string;
  faq: ThemeFAQ[];
}

// Lazy glob: Vite emits one chunk per JSON file and a map of `() => import(...)`.
// Nothing is loaded until loadThemeContent() asks for a theme.
const loaders = import.meta.glob<ThemeContent>('./themeContent/*.json', { import: 'default' });

/** Resolves the content of one theme, or null for an unknown theme id. */
export async function loadThemeContent(themeId: string): Promise<ThemeContent | null> {
  const load = loaders[`./themeContent/${themeId}.json`];
  return load ? load() : null;
}
