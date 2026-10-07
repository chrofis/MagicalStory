import { useLanguage } from '../../context/LanguageContext';
import { uiLabel } from '../../utils/uiLabels';

// First focusable element on every page: visually hidden until focused, jumps past the nav
// to the single main landmark (id="main-content") (App.tsx / SSRApp.tsx).
export function SkipLink() {
  const { language } = useLanguage();
  return (
    <a
      href="#main-content"
      className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[100] focus:bg-white focus:text-indigo-700 focus:px-4 focus:py-2 focus:rounded-lg focus:shadow-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
    >
      {uiLabel('skipToContent', language)}
    </a>
  );
}
