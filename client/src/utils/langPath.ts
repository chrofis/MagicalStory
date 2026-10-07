/**
 * Language-carrying internal links.
 *
 * Language variants of a page are query URLs: `/stadt/bern?lang=fr`. German is
 * the default and is written WITHOUT a lang parameter - the canonical and
 * hreflang table in server/lib/seoMeta.js (buildHreflang) emit `/stadt/bern`
 * for de and `?lang=fr|it|en` for the others, and the prerender writes the
 * same set. An internal link that drops the parameter sends a French reader
 * to the German page, and a crawler following the fr page's links finds only
 * the German graph, so every internal content link goes through withLang().
 *
 * Pure functions, no window access: they run in SSR/prerender as well.
 */
export const DEFAULT_LANGUAGE = 'de';

/** `?lang=fr` for a non-default language, '' for German/empty/unknown input. */
export function langSuffix(language: string | null | undefined): string {
  if (!language || language === DEFAULT_LANGUAGE) return '';
  return `?lang=${language}`;
}

/**
 * Append the language to an internal path. Paths that already carry a query
 * (`/try?category=x`) get `&lang=fr`; a hash stays last; German paths are
 * returned unchanged.
 */
export function withLang(path: string, language: string | null | undefined): string {
  const suffix = langSuffix(language);
  if (!suffix) return path;
  const hashAt = path.indexOf('#');
  const base = hashAt === -1 ? path : path.slice(0, hashAt);
  const hash = hashAt === -1 ? '' : path.slice(hashAt);
  const joiner = base.includes('?') ? '&' : '?';
  return `${base}${joiner}${suffix.slice(1)}${hash}`;
}
