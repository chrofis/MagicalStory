import { useCallback } from 'react';
import { useLanguage } from '@/context/LanguageContext';
import { withLang } from '@/utils/langPath';

/**
 * `const lp = useLangPath(); <Link to={lp('/stadt/bern')} />` - the current UI
 * language rides on every internal link (`?lang=fr`); German links stay bare.
 * See client/src/utils/langPath.ts for why.
 */
export function useLangPath(): (path: string) => string {
  const { language } = useLanguage();
  return useCallback((path: string) => withLang(path, language), [language]);
}
