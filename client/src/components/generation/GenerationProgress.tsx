import { Loader2, Mail, Clock, CheckCircle } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import { useAuth } from '@/context/AuthContext';
import { ProgressBar } from '@/components/common/ProgressBar';
import type { CoverImages } from '@/types/story';

interface GenerationProgressProps {
  current: number;
  total: number;
  message?: string;
  isGenerating?: boolean;
  coverImages?: CoverImages;  // Optional partial cover images to display
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
  coverImages,
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

  // Helper to extract imageData from cover (can be string or object with imageData)
  const getImageData = (cover: string | { imageData?: string } | null | undefined): string | undefined => {
    if (!cover) return undefined;
    if (typeof cover === 'string') return cover;
    return cover.imageData;
  };

  // Check which covers are available
  const frontCoverData = getImageData(coverImages?.frontCover);
  const initialPageData = getImageData(coverImages?.initialPage);
  const backCoverData = getImageData(coverImages?.backCover);
  const hasFrontCover = !!frontCoverData;
  const hasInitialPage = !!initialPageData;
  const hasBackCover = !!backCoverData;
  const hasAnyCovers = hasFrontCover || hasInitialPage || hasBackCover;

  const translations = {
    en: {
      title: 'Creating Your Story!',
      timeInfo: 'This typically takes about 10 minutes.',
      emailInfo: 'You will receive an email when your story is ready.',
      canClose: 'You can wait here or close the browser - your story will keep generating.',
      noEmailInfo: 'You can close this page and come back later.',
      coversPreview: 'Cover Preview',
      frontCover: 'Front',
      initialPage: 'Inside',
      backCover: 'Back',
      pending: 'Generating...',
    },
    de: {
      title: 'Geschichte wird erstellt!',
      timeInfo: 'Dies dauert normalerweise etwa 10 Minuten.',
      emailInfo: 'Du erhältst eine E-Mail, wenn deine Geschichte bereit ist.',
      canClose: 'Du kannst hier warten oder den Browser schließen - deine Geschichte wird weiter generiert.',
      noEmailInfo: 'Du kannst diese Seite schließen und später zurückkommen.',
      coversPreview: 'Cover-Vorschau',
      frontCover: 'Vorne',
      initialPage: 'Innen',
      backCover: 'Hinten',
      pending: 'Wird erstellt...',
    },
    fr: {
      title: 'Création de votre histoire!',
      timeInfo: 'Cela prend généralement environ 10 minutes.',
      emailInfo: 'Vous recevrez un email quand votre histoire sera prête.',
      canClose: 'Vous pouvez attendre ici ou fermer le navigateur - votre histoire continuera à être générée.',
      noEmailInfo: 'Vous pouvez fermer cette page et revenir plus tard.',
      coversPreview: 'Aperçu des couvertures',
      frontCover: 'Avant',
      initialPage: 'Intérieur',
      backCover: 'Arrière',
      pending: 'En cours...',
    },
  };

  const t = translations[language as keyof typeof translations] || translations.en;

  // Helper to render a cover thumbnail
  const CoverThumbnail = ({ imageData, label, isReady }: { imageData?: string; label: string; isReady: boolean }) => (
    <div className="flex flex-col items-center gap-1">
      <div className={`w-16 h-16 md:w-20 md:h-20 rounded-lg overflow-hidden border-2 ${isReady ? 'border-green-400' : 'border-gray-200'} bg-gray-100 flex items-center justify-center`}>
        {isReady && imageData ? (
          <img src={imageData} alt={label} className="w-full h-full object-cover" />
        ) : (
          <Loader2 size={20} className="animate-spin text-gray-400" />
        )}
      </div>
      <div className="flex items-center gap-1">
        {isReady && <CheckCircle size={12} className="text-green-500" />}
        <span className={`text-xs ${isReady ? 'text-green-600 font-medium' : 'text-gray-400'}`}>{label}</span>
      </div>
    </div>
  );

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className={`bg-white rounded-2xl shadow-xl w-full p-6 md:p-8 ${hasAnyCovers ? 'max-w-lg' : 'max-w-md'}`}>
        {/* Header with animation */}
        <div className="text-center mb-6">
          <div className="relative inline-block mb-3">
            <Loader2 size={48} className="animate-spin text-indigo-600" />
            <span className="absolute -top-1 -right-1 text-xl">✨</span>
          </div>
          <h2 className="text-xl md:text-2xl font-bold text-gray-800">{t.title}</h2>
        </div>

        {/* Cover preview section */}
        {hasAnyCovers && (
          <div className="mb-6 bg-gradient-to-r from-indigo-50 to-purple-50 rounded-xl p-4">
            <h3 className="text-sm font-medium text-indigo-700 text-center mb-3">{t.coversPreview}</h3>
            <div className="flex justify-center gap-4">
              <CoverThumbnail
                imageData={frontCoverData}
                label={t.frontCover}
                isReady={hasFrontCover}
              />
              <CoverThumbnail
                imageData={initialPageData}
                label={t.initialPage}
                isReady={hasInitialPage}
              />
              <CoverThumbnail
                imageData={backCoverData}
                label={t.backCover}
                isReady={hasBackCover}
              />
            </div>
          </div>
        )}

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
