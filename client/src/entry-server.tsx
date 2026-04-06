/**
 * SSR entry — used by the prerender script to render React components to HTML
 * at build time. NOT shipped to the browser.
 *
 * The render function is synchronous (renderToString) — pre-rendered routes
 * must be statically importable, no top-level Suspense boundaries that depend
 * on async data. All data is passed in via the `data` parameter.
 */
import { StrictMode } from 'react';
import { renderToString } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom';
import SSRApp from './SSRApp';
import { LanguageProvider } from './context/LanguageContext';
import { StoryProvider } from './context/StoryContext';
import { ToastProvider } from './context/ToastContext';
import { SEODataProvider, type SEOData } from './context/SEODataContext';
import { AuthProvider } from './context/AuthContext';
import type { Language } from './types/story';

// Imports for route enumeration — must use the same constants the components use
// so the prerendered route list stays in sync with what the React app supports.
import { storyTypes, lifeChallenges, educationalTopics, historicalEvents } from './constants/storyTypes';
import { occasions } from './constants/occasionData';
import { giftPages } from './constants/giftData';
import { comparisons } from './constants/comparisonData';

export interface RenderResult {
  /** The rendered HTML for the React tree (goes inside <div id="root">) */
  html: string;
  /** The detected language to set on <html lang="..."> */
  language: Language;
}

export interface RenderOptions {
  /** Path to render — without query string (e.g. "/stadt/einsiedeln") */
  url: string;
  /** Language to render in */
  language: Language;
  /** Pre-loaded SEO data (cities, sagen, etc.) */
  seoData?: SEOData | null;
}

/**
 * Enumerate all SEO routes that should be pre-rendered.
 * Returns paths WITHOUT query string — language is applied at render time.
 *
 * The list is derived from the same data files the React components use, so
 * adding a new theme/city/occasion/gift to the data automatically adds the
 * corresponding route to the prerender pipeline. No duplicate route table.
 */
export function enumerateRoutes(swissCities: Array<{ id: string }> = []): string[] {
  const routes: string[] = [];

  // Static pages
  routes.push(
    '/',
    '/pricing',
    '/so-funktionierts',
    '/faq',
    '/about',
    '/contact',
    '/science',
    '/terms',
    '/privacy',
    '/impressum',
    '/themes',
    '/anlass',
    '/geschenk',
    '/vergleich',
    '/stadt'
  );

  // Theme category pages
  routes.push(
    '/themes/adventure',
    '/themes/life-challenges',
    '/themes/educational',
    '/themes/historical'
  );

  // Theme detail pages — adventure, life-challenges, educational, historical
  for (const t of storyTypes) routes.push(`/themes/adventure/${t.id}`);
  for (const t of lifeChallenges) routes.push(`/themes/life-challenges/${t.id}`);
  for (const t of educationalTopics) routes.push(`/themes/educational/${t.id}`);
  for (const t of historicalEvents) routes.push(`/themes/historical/${t.id}`);

  // Occasion pages — slug field is `id`
  for (const o of occasions) routes.push(`/anlass/${o.id}`);

  // Gift pages — slug field is `id`
  for (const g of giftPages) routes.push(`/geschenk/${g.id}`);

  // Comparison pages — slug field is `id`
  for (const c of comparisons) routes.push(`/vergleich/${c.id}`);

  // City pages — derived from data passed in (server-side json file)
  for (const c of swissCities) routes.push(`/stadt/${c.id}`);

  return routes;
}

export function render({ url, language, seoData }: RenderOptions): RenderResult {
  const html = renderToString(
    <StrictMode>
      <StaticRouter location={url}>
        <LanguageProvider initialLanguage={language}>
          <SEODataProvider initialData={seoData || null}>
            <AuthProvider>
              <StoryProvider>
                <ToastProvider>
                  <SSRApp />
                </ToastProvider>
              </StoryProvider>
            </AuthProvider>
          </SEODataProvider>
        </LanguageProvider>
      </StaticRouter>
    </StrictMode>
  );

  return { html, language };
}
