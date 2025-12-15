import { Loader2, Mail, Clock } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import { useAuth } from '@/context/AuthContext';
import { ProgressBar } from '@/components/common/ProgressBar';

interface GenerationProgressProps {
  current: number;
  total: number;
  message?: string;
  isGenerating?: boolean;
}

// Translate server messages to user language
function translateMessage(message: string, language: string): string {
  if (!message) return '';

  // Handle "Image X/Y..." pattern
  const imageMatch = message.match(/^Image (\d+)\/(\d+)\.\.\.$/);
  if (imageMatch) {
    const [, current, total] = imageMatch;
    if (language === 'de') return `Bild ${current}/${total}...`;
    if (language === 'fr') return `Image ${current}/${total}...`;
    return message;
  }

  const translations: Record<string, Record<string, string>> = {
    'Writing story...': {
      de: 'Geschichte wird geschrieben...',
      fr: 'Écriture de l\'histoire...',
    },
    'Creating covers...': {
      de: 'Cover werden erstellt...',
      fr: 'Création des couvertures...',
    },
    'Generating picture book story and scenes...': {
      de: 'Geschichte und Szenen werden erstellt...',
      fr: 'Création de l\'histoire et des scènes...',
    },
    'Picture book complete!': {
      de: 'Bilderbuch fertig!',
      fr: 'Livre d\'images terminé!',
    },
    'Complete!': {
      de: 'Fertig!',
      fr: 'Terminé!',
    },
  };

  if (language === 'en') return message;

  // Check for exact match first
  if (translations[message]?.[language]) {
    return translations[message][language];
  }

  return message;
}

export function GenerationProgress({
  current,
  total,
  message,
  isGenerating = true,
}: GenerationProgressProps) {
  const { language } = useLanguage();
  const { user } = useAuth();
  const hasEmail = !!user?.email;

  if (!isGenerating || total === 0) {
    return null;
  }

  // Use server progress directly (0-100 scale)
  const progressPercent = total === 100 ? current : Math.round((current / total) * 100);
  const translatedMessage = translateMessage(message || '', language);

  const translations = {
    en: {
      title: 'Creating Your Story!',
      timeInfo: 'This typically takes about 10 minutes.',
      emailInfo: 'You will receive an email when your story is ready.',
      canClose: 'You can wait here or close the browser - your story will keep generating.',
      noEmailInfo: 'You can close this page and come back later.',
    },
    de: {
      title: 'Geschichte wird erstellt!',
      timeInfo: 'Dies dauert normalerweise etwa 10 Minuten.',
      emailInfo: 'Du erhältst eine E-Mail, wenn deine Geschichte bereit ist.',
      canClose: 'Du kannst hier warten oder den Browser schließen - deine Geschichte wird weiter generiert.',
      noEmailInfo: 'Du kannst diese Seite schließen und später zurückkommen.',
    },
    fr: {
      title: 'Création de votre histoire!',
      timeInfo: 'Cela prend généralement environ 10 minutes.',
      emailInfo: 'Vous recevrez un email quand votre histoire sera prête.',
      canClose: 'Vous pouvez attendre ici ou fermer le navigateur - votre histoire continuera à être générée.',
      noEmailInfo: 'Vous pouvez fermer cette page et revenir plus tard.',
    },
  };

  const t = translations[language as keyof typeof translations] || translations.en;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-xl max-w-md w-full p-6 md:p-8">
        {/* Header with animation */}
        <div className="text-center mb-6">
          <div className="relative inline-block mb-3">
            <Loader2 size={48} className="animate-spin text-indigo-600" />
            <span className="absolute -top-1 -right-1 text-xl">✨</span>
          </div>
          <h2 className="text-xl md:text-2xl font-bold text-gray-800">{t.title}</h2>
        </div>

        {/* Progress bar */}
        <div className="mb-4">
          <ProgressBar
            value={progressPercent}
            max={100}
            showPercentage
            size="lg"
          />
        </div>

        {/* Current step message */}
        {translatedMessage && (
          <p className="text-indigo-600 text-sm text-center font-medium mb-4">{translatedMessage}</p>
        )}

        {/* Info section - single unified box */}
        <div className="bg-gray-50 rounded-lg p-4 space-y-2">
          <div className="flex items-center gap-2 text-gray-700">
            <Clock size={16} className="text-gray-500 shrink-0" />
            <p className="text-sm">{t.timeInfo}</p>
          </div>
          {hasEmail ? (
            <>
              <div className="flex items-center gap-2 text-gray-700">
                <Mail size={16} className="text-gray-500 shrink-0" />
                <p className="text-sm">
                  {t.emailInfo} <span className="text-gray-500">({user?.email})</span>
                </p>
              </div>
              <p className="text-sm text-gray-600 pl-6">{t.canClose}</p>
            </>
          ) : (
            <div className="flex items-center gap-2 text-gray-700">
              <Mail size={16} className="text-gray-500 shrink-0" />
              <p className="text-sm">{t.noEmailInfo}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default GenerationProgress;
