// The complete theme catalogue, loaded eagerly. SSR / prerender ONLY — the
// prerender picks the one entry a theme route needs and injects it into
// window.__INITIAL_DATA__ (see scripts/prerender.mjs). Never import this from
// client code: it would put all 181 themes (1.6 MB) back into the browser bundle
// (tests/unit/theme-content-split.test.ts guards this).
import type { ThemeContent } from './themeContent';

const modules = import.meta.glob<ThemeContent>('./themeContent/*.json', { eager: true, import: 'default' });

export const allThemeContent: Record<string, ThemeContent> = Object.fromEntries(
  Object.entries(modules).map(([file, content]) => [file.replace(/^\.\/themeContent\/(.+)\.json$/, '$1'), content]),
);

/** The seoData.themeContent payload for a route: the one entry a theme page needs, else undefined. */
export function themeContentForRoute(route: string): Record<string, ThemeContent> | undefined {
  const match = /^\/themes\/[^/]+\/([^/]+)$/.exec(route);
  const content = match && allThemeContent[match[1]];
  return content ? { [match![1]]: content } : undefined;
}
