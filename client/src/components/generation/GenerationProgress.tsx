import { useState, useEffect, useMemo } from 'react';
import { Loader2, Mail, Clock, CheckCircle, XCircle } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import { useAuth } from '@/context/AuthContext';
import { ProgressBar } from '@/components/common/ProgressBar';
import type { CoverImages } from '@/types/story';
import type { Character } from '@/types/character';

interface GenerationProgressProps {
  current: number;
  total: number;
  message?: string;
  isGenerating?: boolean;
  coverImages?: CoverImages;  // Optional partial cover images to display
  jobId?: string;  // Job ID for cancellation
  onCancel?: () => void;  // Callback when job is cancelled
  characters?: Character[];  // Characters to show avatars from
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
  jobId,
  onCancel,
  characters = [],
}: GenerationProgressProps) {
  const { language } = useLanguage();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const [isCancelling, setIsCancelling] = useState(false);
  const [rotationIndex, setRotationIndex] = useState(0);

  // Get one avatar from each character (prefer standard, then any available)
  const characterAvatars = useMemo(() => {
    return characters
      .map(char => {
        const avatars = char.avatars;
        const avatarUrl = avatars?.standard || avatars?.summer || avatars?.winter || avatars?.formal;
        if (avatarUrl) {
          return { name: char.name, avatar: avatarUrl };
        }
        return null;
      })
      .filter((a): a is { name: string; avatar: string } => a !== null);
  }, [characters]);

  // Build rotation items: interleave messages and avatars
  const rotationItems = useMemo(() => {
    const messages = [
      { type: 'message' as const, key: 'timeInfo' },
      { type: 'message' as const, key: 'emailInfo' },
      { type: 'message' as const, key: 'canClose' },
    ];

    const items: Array<{ type: 'message'; key: string } | { type: 'avatar'; name: string; avatar: string }> = [];

    // Interleave messages and avatars
    const maxLen = Math.max(messages.length, characterAvatars.length);
    for (let i = 0; i < maxLen; i++) {
      if (i < messages.length) {
        items.push(messages[i]);
      }
      if (i < characterAvatars.length) {
        items.push({ type: 'avatar', ...characterAvatars[i] });
      }
    }

    // If no avatars, just use messages
    if (characterAvatars.length === 0) {
      return messages;
    }

    return items;
  }, [characterAvatars]);

  // Rotate every 5 seconds
  useEffect(() => {
    if (rotationItems.length <= 1) return;

    const interval = setInterval(() => {
      setRotationIndex(prev => (prev + 1) % rotationItems.length);
    }, 5000);

    return () => clearInterval(interval);
  }, [rotationItems.length]);

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
      timeInfo: 'Your story will start to display in about 1 minute. The full story can take up to 10 minutes.',
      emailInfo: 'You will receive an email when your story is ready.',
      canClose: 'You can wait here or close the browser - your story will keep generating.',
      coversPreview: 'Cover Preview',
      frontCover: 'Front',
      initialPage: 'Inside',
      backCover: 'Back',
      cancelJob: 'Cancel Generation',
      cancelling: 'Cancelling...',
    },
    de: {
      title: 'Geschichte wird erstellt!',
      timeInfo: 'Deine Geschichte wird in etwa 1 Minute angezeigt. Die vollständige Geschichte kann bis zu 10 Minuten dauern.',
      emailInfo: 'Du erhältst eine E-Mail, wenn deine Geschichte bereit ist.',
      canClose: 'Du kannst hier warten oder den Browser schließen - deine Geschichte wird weiter generiert.',
      coversPreview: 'Cover-Vorschau',
      frontCover: 'Vorne',
      initialPage: 'Innen',
      backCover: 'Hinten',
      cancelJob: 'Generierung abbrechen',
      cancelling: 'Wird abgebrochen...',
    },
    fr: {
      title: 'Création de votre histoire!',
      timeInfo: 'Votre histoire commencera à s\'afficher dans environ 1 minute. L\'histoire complète peut prendre jusqu\'à 10 minutes.',
      emailInfo: 'Vous recevrez un email quand votre histoire sera prête.',
      canClose: 'Vous pouvez attendre ici ou fermer le navigateur - votre histoire continuera à être générée.',
      coversPreview: 'Aperçu des couvertures',
      frontCover: 'Avant',
      initialPage: 'Intérieur',
      backCover: 'Arrière',
      cancelJob: 'Annuler la génération',
      cancelling: 'Annulation...',
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

        {/* Rotating display section - before covers appear */}
        {!hasAnyCovers && rotationItems.length > 0 && (
          <div className="mb-6 min-h-[120px] flex items-center justify-center">
            {(() => {
              const currentItem = rotationItems[rotationIndex];
              if (currentItem.type === 'avatar') {
                return (
                  <div className="flex flex-col items-center gap-2 animate-fade-in">
                    <div className="w-24 h-24 md:w-28 md:h-28 rounded-full overflow-hidden border-4 border-indigo-200 shadow-lg">
                      <img
                        src={currentItem.avatar}
                        alt={currentItem.name}
                        className="w-full h-full object-cover"
                      />
                    </div>
                    <span className="text-sm font-medium text-indigo-700">{currentItem.name}</span>
                  </div>
                );
              } else {
                const messageKey = currentItem.key as keyof typeof t;
                const messageText = t[messageKey] || '';
                const icon = messageKey === 'timeInfo' ? <Clock size={20} className="text-indigo-500 shrink-0" /> :
                             messageKey === 'emailInfo' ? <Mail size={20} className="text-indigo-500 shrink-0" /> :
                             <CheckCircle size={20} className="text-indigo-500 shrink-0" />;
                return (
                  <div className="flex items-start gap-3 bg-gradient-to-r from-indigo-50 to-purple-50 rounded-xl p-4 max-w-sm animate-fade-in">
                    {icon}
                    <p className="text-sm text-gray-700">{messageText}</p>
                  </div>
                );
              }
            })()}
          </div>
        )}

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

        {/* Cancel button - admin only */}
        {isAdmin && jobId && onCancel && (
          <button
            onClick={async () => {
              if (isCancelling) return;
              setIsCancelling(true);
              try {
                onCancel();
              } finally {
                setIsCancelling(false);
              }
            }}
            disabled={isCancelling}
            className="mt-4 w-full flex items-center justify-center gap-2 px-4 py-2 bg-red-100 hover:bg-red-200 text-red-700 rounded-lg font-medium transition-colors disabled:opacity-50"
          >
            {isCancelling ? (
              <Loader2 size={16} className="animate-spin" />
            ) : (
              <XCircle size={16} />
            )}
            {isCancelling ? t.cancelling : t.cancelJob}
          </button>
        )}
      </div>
    </div>
  );
}

export default GenerationProgress;
