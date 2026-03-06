import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { AuthProvider } from './context/AuthContext';
import { LanguageProvider } from './context/LanguageContext';
import { StoryProvider } from './context/StoryContext';
import { ToastProvider } from './context/ToastContext';
import './index.css';

// Handle stale chunk errors after deployments
// When a new build is deployed, old chunk files may no longer exist.
// This detects dynamic import failures and auto-reloads to get fresh chunks.
const handleChunkError = (event: ErrorEvent | PromiseRejectionEvent) => {
  const error = 'reason' in event ? event.reason : event.error;
  const message = error?.message || error?.toString() || '';

  if (
    message.includes('Failed to fetch dynamically imported module') ||
    message.includes('Loading chunk') ||
    message.includes('Loading CSS chunk')
  ) {
    // Prevent infinite reload loops - only reload once per session
    const reloadKey = 'chunk_error_reload';
    const lastReload = sessionStorage.getItem(reloadKey);
    const now = Date.now();

    // Only reload if we haven't reloaded in the last 10 seconds
    if (!lastReload || now - parseInt(lastReload) > 10000) {
      sessionStorage.setItem(reloadKey, now.toString());
      console.warn('🔄 Detected stale chunks after deployment, reloading...');
      window.location.reload();
    }
  }
};

window.addEventListener('error', handleChunkError);
window.addEventListener('unhandledrejection', handleChunkError);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <LanguageProvider>
        <AuthProvider>
          <StoryProvider>
            <ToastProvider>
              <App />
            </ToastProvider>
          </StoryProvider>
        </AuthProvider>
      </LanguageProvider>
    </BrowserRouter>
  </StrictMode>
);
