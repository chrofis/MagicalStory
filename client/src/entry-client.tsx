import { StrictMode } from 'react';
import { createRoot, hydrateRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { AuthProvider } from './context/AuthContext';
import { LanguageProvider } from './context/LanguageContext';
import { StoryProvider } from './context/StoryContext';
import { ToastProvider } from './context/ToastContext';
import { SEODataProvider } from './context/SEODataContext';
import './index.css';

// Stale-chunk recovery: when a deploy ships new chunks, old browsers may fail
// to load the now-missing files. Reload to fetch the new build.
const handleChunkError = (event: ErrorEvent | PromiseRejectionEvent) => {
  const error = 'reason' in event ? event.reason : event.error;
  const message = error?.message || error?.toString() || '';

  if (
    message.includes('Failed to fetch dynamically imported module') ||
    message.includes('Loading chunk') ||
    message.includes('Loading CSS chunk')
  ) {
    const reloadKey = 'chunk_error_reload';
    const lastReload = sessionStorage.getItem(reloadKey);
    const now = Date.now();
    if (!lastReload || now - parseInt(lastReload) > 10000) {
      sessionStorage.setItem(reloadKey, now.toString());
      console.warn('🔄 Detected stale chunks after deployment, reloading...');
      window.location.reload();
    }
  }
};

window.addEventListener('error', handleChunkError);
window.addEventListener('unhandledrejection', handleChunkError);

// iOS Safari kills JS context in background tabs after a while.
// When the user returns, the page may show a white screen because
// the frozen page is restored from bfcache with dead JS state.
window.addEventListener('pageshow', (event) => {
  if (event.persisted) {
    window.location.reload();
  }
});

// Initial data is injected by the prerender script as window.__INITIAL_DATA__.
// Pre-rendered routes hydrate; SPA routes (/create, /wizard, etc.) cold-start.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const initialData = (window as any).__INITIAL_DATA__ || null;
const initialLanguage = initialData?.language || undefined;

const tree = (
  <StrictMode>
    <BrowserRouter>
      <LanguageProvider initialLanguage={initialLanguage}>
        <SEODataProvider initialData={initialData?.seoData || null}>
          <AuthProvider>
            <StoryProvider>
              <ToastProvider>
                <App />
              </ToastProvider>
            </StoryProvider>
          </AuthProvider>
        </SEODataProvider>
      </LanguageProvider>
    </BrowserRouter>
  </StrictMode>
);

const rootEl = document.getElementById('root')!;

if (initialData) {
  // Pre-rendered HTML present — hydrate in place.
  hydrateRoot(rootEl, tree);
} else {
  // SPA route — fresh client render.
  createRoot(rootEl).render(tree);
}
