import { useAuth } from '@/context/AuthContext';
import { useLanguage } from '@/context/LanguageContext';
import { X, Eye } from 'lucide-react';

const translations = {
  en: {
    viewingAs: 'Viewing as',
    stopViewing: 'Stop viewing',
  },
  de: {
    viewingAs: 'Ansicht als',
    stopViewing: 'Ansicht beenden',
  },
  fr: {
    viewingAs: 'Vue en tant que',
    stopViewing: 'Arreter la vue',
  },
};

export function ImpersonationBanner() {
  const { isImpersonating, user, originalAdmin, stopImpersonating } = useAuth();
  const { language } = useLanguage();

  const t = translations[language as keyof typeof translations] || translations.en;

  if (!isImpersonating || !user || !originalAdmin) {
    return null;
  }

  const handleStopImpersonating = async () => {
    try {
      await stopImpersonating();
    } catch (error) {
      console.error('Failed to stop impersonating:', error);
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
      <button
        onClick={handleStopImpersonating}
        className="flex items-center gap-1 bg-black/20 hover:bg-black/30 px-3 py-1 rounded-full transition-colors"
      >
        <X size={14} />
        <span>{t.stopViewing}</span>
      </button>
    </div>
  );
}
