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

  const translations: Record<string, Record<string, string>> = {
    'Generating picture book story and scenes...': {
      de: 'Geschichte und Szenen werden erstellt...',
      fr: 'Création de l\'histoire et des scènes...',
    },
    'Story text complete.': {
      de: 'Geschichte fertig.',
      fr: 'Texte terminé.',
    },
    'images already generating...': {
      de: 'Bilder werden bereits generiert...',
      fr: 'images en cours de génération...',
    },
    'Generated image': {
      de: 'Bild erstellt',
      fr: 'Image générée',
    },
    'Generating cover images...': {
      de: 'Cover-Bilder werden erstellt...',
      fr: 'Création des images de couverture...',
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

  // Check for partial matches and translate parts
  let translated = message;
  for (const [eng, trans] of Object.entries(translations)) {
    if (message.includes(eng) && trans[language]) {
      translated = translated.replace(eng, trans[language]);
    }
  }

  return translated;
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
      emailInfo: 'You will receive an email when ready.',
      noEmailInfo: 'You can close this page and come back later.',
    },
    de: {
      title: 'Geschichte wird erstellt!',
      timeInfo: 'Dies dauert normalerweise etwa 10 Minuten.',
      emailInfo: 'Du erhältst eine E-Mail wenn fertig.',
      noEmailInfo: 'Du kannst diese Seite schließen und später zurückkommen.',
    },
    fr: {
      title: 'Création de votre histoire!',
      timeInfo: 'Cela prend généralement environ 10 minutes.',
      emailInfo: 'Vous recevrez un email quand ce sera prêt.',
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
          <div className="flex items-center gap-2 text-gray-700">
            <Mail size={16} className="text-gray-500 shrink-0" />
            <p className="text-sm">
              {hasEmail ? (
                <>{t.emailInfo} <span className="text-gray-500">({user?.email})</span></>
              ) : (
                t.noEmailInfo
              )}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

export default GenerationProgress;
