import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import { useLanguage } from '@/context/LanguageContext';
import { X, Eye, Loader2 } from 'lucide-react';

const translations = {
  en: {
    viewingAs: 'Viewing as',
    stopViewing: 'Stop viewing',
    stopping: 'Stopping...',
  },
  de: {
    viewingAs: 'Ansicht als',
    stopViewing: 'Ansicht beenden',
    stopping: 'Beenden...',
  },
  fr: {
    viewingAs: 'Vue en tant que',
    stopViewing: 'Arreter la vue',
    stopping: 'Arrêt...',
  },
};

export function ImpersonationBanner() {
  const navigate = useNavigate();
  const { isImpersonating, user, originalAdmin, stopImpersonating } = useAuth();
  const { language } = useLanguage();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const t = translations[language as keyof typeof translations] || translations.en;

  if (!isImpersonating || !user || !originalAdmin) {
    return null;
  }

  const handleStopImpersonating = async () => {
    setIsLoading(true);
    setError(null);
    try {
      await stopImpersonating();
      // Navigate to admin dashboard after stopping
      navigate('/admin');
    } catch (err) {
      console.error('Failed to stop impersonating:', err);
      setError(err instanceof Error ? err.message : 'Failed to stop');
      setIsLoading(false);
    }
  };

  return (
    <div className="bg-amber-500 text-black py-2 px-4 flex items-center justify-center gap-4 text-sm font-medium sticky top-0 z-50">
      <div className="flex items-center gap-2">
        <Eye size={16} />
        <span>
          {t.viewingAs}: <strong>{user.username}</strong> ({user.email})
        </span>
      </div>
      {error && (
        <span className="text-red-800 bg-red-200 px-2 py-0.5 rounded text-xs">{error}</span>
      )}
      <button
        onClick={handleStopImpersonating}
        disabled={isLoading}
        className="flex items-center gap-1 bg-black/20 hover:bg-black/30 disabled:opacity-50 px-3 py-1 rounded-full transition-colors"
      >
        {isLoading ? <Loader2 size={14} className="animate-spin" /> : <X size={14} />}
        <span>{isLoading ? t.stopping : t.stopViewing}</span>
      </button>
    </div>
  );
}
