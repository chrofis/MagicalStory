import { useState, useEffect, useMemo, useRef } from 'react';
import { Loader2, Mail, Clock, CheckCircle, XCircle, AlertTriangle } from 'lucide-react';
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
  onMinimize?: () => void;  // Callback to minimize and continue in background
  characters?: Character[];  // Characters to show avatars from
  isStalled?: boolean;  // Whether progress appears stalled
  onDismissStalled?: () => void;  // Callback to dismiss stalled warning and continue waiting
  isImpersonating?: boolean;  // Whether admin is impersonating a user
}

export function GenerationProgress({
  current,
  total,
  message: _message,
  isGenerating = true,
  coverImages,
  jobId,
  onCancel,
  onMinimize,
  characters = [],
  isStalled = false,
  onDismissStalled,
  isImpersonating = false,
}: GenerationProgressProps) {
  const { language } = useLanguage();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin' || isImpersonating;
  const [isCancelling, setIsCancelling] = useState(false);
  const [rotationIndex, setRotationIndex] = useState(0);

  // 10 funny messages per character - uses {name} placeholder
  const funnyMessageTemplates = [
    {
      en: '{name} is getting ready for their big adventure...',
      de: '{name} macht sich bereit für das grosse Abenteuer...',
      fr: '{name} se prépare pour sa grande aventure...'
    },
    {
      en: '{name} is practicing their hero pose...',
      de: '{name} übt gerade die Heldenpose...',
      fr: '{name} s\'entraîne à prendre la pose du héros...'
    },
    {
      en: '{name} can\'t wait to see what happens next!',
      de: '{name} kann es kaum erwarten zu sehen, was als Nächstes passiert!',
      fr: '{name} a hâte de voir ce qui va se passer !'
    },
    {
      en: '{name} is warming up for the adventure ahead...',
      de: '{name} wärmt sich für das bevorstehende Abenteuer auf...',
      fr: '{name} s\'échauffe pour l\'aventure à venir...'
    },
    {
      en: '{name} just found a magic feather! Adding it to the story...',
      de: '{name} hat gerade eine Zauberfeder gefunden! Wir fügen sie der Geschichte hinzu...',
      fr: '{name} vient de trouver une plume magique ! On l\'ajoute au récit...'
    },
    {
      en: '{name} is whispering secrets to the story wizard...',
      de: '{name} flüstert dem Geschichtenzauberer Geheimnisse zu...',
      fr: '{name} chuchote des secrets au magicien des histoires...'
    },
    {
      en: '{name} is peeking around the corner to see what\'s coming...',
      de: '{name} schaut um die Ecke, um zu sehen, was kommt...',
      fr: '{name} jette un coup d\'œil au coin pour voir ce qui arrive...'
    },
    {
      en: '{name} is doing a little happy dance!',
      de: '{name} macht einen kleinen Freudentanz!',
      fr: '{name} fait une petite danse de joie !'
    },
    {
      en: '{name} is collecting stars for the story...',
      de: '{name} sammelt Sterne für die Geschichte...',
      fr: '{name} collectionne des étoiles pour le récit...'
    },
    {
      en: '{name} just met a friendly dragon! Making friends...',
      de: '{name} hat gerade einen freundlichen Drachen getroffen! Sie werden Freunde...',
      fr: '{name} vient de rencontrer un dragon amical ! Ils deviennent amis...'
    }
  ];

  // Track which message was shown for each character to avoid repeats (useRef to avoid dependency issues)
  const messageIndicesRef = useRef<Record<number, number>>({});

  // Current character display state (computed on rotation change)
  const [currentCharDisplay, setCurrentCharDisplay] = useState<{ avatarUrl: string; message: string } | null>(null);

  // Get characters with available avatars (one entry per character)
  const charactersWithAvatars = useMemo(() => {
    return characters.filter(char => {
      const avatars = char.avatars;
      // Use faceThumbnails for display (lightweight), or full avatars if available
      return avatars && (avatars.faceThumbnails?.standard || avatars.standard || avatars.summer || avatars.winter || avatars.formal || avatars.hasFullAvatars);
    });
  }, [characters]);

  // Get the best available avatar for a character (prefer lightweight faceThumbnails)
  const getRandomAvatar = (char: Character): string => {
    const avatars = char.avatars;
    if (!avatars) return '';

    // Prefer faceThumbnails.standard for display (lightweight ~50KB vs 1.5MB full avatar)
    if (avatars.faceThumbnails?.standard) return avatars.faceThumbnails.standard;

    // Fall back to full avatars if faceThumbnails not available
    const available: string[] = [];
    if (avatars.standard) available.push(avatars.standard);
    if (avatars.summer) available.push(avatars.summer);
    if (avatars.winter) available.push(avatars.winter);
    if (avatars.formal) available.push(avatars.formal);

    return available[Math.floor(Math.random() * available.length)] || '';
  };

  // Build rotation items: always alternate tip, char, tip, char...
  const rotationItems = useMemo(() => {
    const messages = [
      { type: 'message' as const, key: 'timeInfo' },
      { type: 'message' as const, key: 'tipCharacters' },
      { type: 'message' as const, key: 'emailInfo' },
      { type: 'message' as const, key: 'tipStoryPlot' },
      { type: 'message' as const, key: 'canClose' },
      { type: 'message' as const, key: 'tipLocations' },
      { type: 'message' as const, key: 'tipArtStyle' },
    ];

    // If no characters with avatars, just use messages
    if (charactersWithAvatars.length === 0) {
      return messages;
    }

    const items: Array<
      { type: 'message'; key: string } |
      { type: 'character'; char: Character }
    > = [];

    // Always alternate: tip, char, tip, char...
    // Use the longer list to determine total pairs, cycling through the shorter one
    const numPairs = Math.max(messages.length, charactersWithAvatars.length);
    for (let i = 0; i < numPairs; i++) {
      items.push(messages[i % messages.length]);
      items.push({ type: 'character', char: charactersWithAvatars[i % charactersWithAvatars.length] });
    }

    return items;
  }, [charactersWithAvatars]);

  // Rotate every 8 seconds
  useEffect(() => {
    if (rotationItems.length <= 1) return;

    const interval = setInterval(() => {
      setRotationIndex(prev => (prev + 1) % rotationItems.length);
    }, 8000);

    return () => clearInterval(interval);
  }, [rotationItems.length]);

  // Update character display when rotation changes to a character
  useEffect(() => {
    if (rotationItems.length === 0) return;

    const currentItem = rotationItems[rotationIndex];
    if (currentItem.type === 'character') {
      const char = currentItem.char;
      const avatarUrl = getRandomAvatar(char);

      // Get next message index for this character (using ref to avoid dependency issues)
      const currentIndex = messageIndicesRef.current[char.id] ?? -1;
      const nextIndex = (currentIndex + 1) % funnyMessageTemplates.length;

      // Update message index for next time
      messageIndicesRef.current[char.id] = nextIndex;

      // Get the message text
      const template = funnyMessageTemplates[nextIndex];
      const msg = language === 'de' ? template.de : language === 'fr' ? template.fr : template.en;
      const message = msg.replace('{name}', char.name);

      setCurrentCharDisplay({ avatarUrl, message });
    } else {
      setCurrentCharDisplay(null);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rotationIndex, rotationItems, language]);

  if (!isGenerating || total === 0) {
    return null;
  }

  // Use server progress directly (0-100 scale)
  const progressPercent = total === 100 ? current : Math.round((current / total) * 100);

  // Helper to extract imageData from cover
  const getImageData = (cover: { imageData?: string } | null | undefined): string | undefined => {
    return cover?.imageData;
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
      tipCharacters: 'The better you describe your characters, the more fun the story becomes!',
      tipStoryPlot: '"Story Plot / Story Details" lets you craft your own personal adventure.',
      tipLocations: 'Add your hometown and favorite places to "Story Plot / Story Details" for a personal touch.',
      tipArtStyle: 'What\'s your favorite art style? For picture books, watercolor works great!',
      coversPreview: 'Cover Preview',
      frontCover: 'Front',
      initialPage: 'Inside',
      backCover: 'Back',
      cancelJob: 'Cancel Generation',
      cancelling: 'Cancelling...',
      stalled: 'Generation seems stuck',
      stalledDesc: 'No progress for a while. This can happen due to high server load.',
      continueWaiting: 'Keep Waiting',
      continueInBackground: 'Continue in Background',
    },
    de: {
      title: 'Geschichte wird erstellt!',
      timeInfo: 'Deine Geschichte wird in etwa 1 Minute angezeigt. Die Erstellung der vollständigen Geschichte kann bis zu 10 Minuten dauern.',
      emailInfo: 'Du erhältst eine E-Mail, wenn deine Geschichte bereit ist.',
      canClose: 'Du kannst hier warten oder den Browser schliessen - deine Geschichte wird weiter generiert.',
      tipCharacters: 'Je besser du deine Charaktere beschreibst, desto lustiger wird die Geschichte!',
      tipStoryPlot: 'Mit "Handlung / Angaben zur Geschichte" kannst du dein ganz persönliches Abenteuer gestalten.',
      tipLocations: 'Füge deinen Heimatort und Lieblingsorte zu "Handlung / Angaben zur Geschichte" hinzu für eine persönliche Note.',
      tipArtStyle: 'Was ist dein Lieblings-Kunststil? Für Bilderbücher funktioniert Aquarell besonders gut!',
      coversPreview: 'Cover-Vorschau',
      frontCover: 'Vorne',
      initialPage: 'Innen',
      backCover: 'Hinten',
      cancelJob: 'Generierung abbrechen',
      cancelling: 'Wird abgebrochen...',
      stalled: 'Generierung scheint hängen zu bleiben',
      stalledDesc: 'Seit einer Weile kein Fortschritt. Dies kann bei hoher Serverlast passieren.',
      continueWaiting: 'Weiter warten',
      continueInBackground: 'Im Hintergrund fortsetzen',
    },
    fr: {
      title: 'Création de votre histoire!',
      timeInfo: 'Votre récit commencera à s\'afficher dans environ 1 minute. Le récit complet peut prendre jusqu\'à 10 minutes.',
      emailInfo: 'Vous recevrez un email quand votre récit sera prêt.',
      canClose: 'Vous pouvez attendre ici ou fermer le navigateur - votre récit continuera à être généré.',
      tipCharacters: 'Mieux vous décrivez vos personnages, plus le récit sera amusant !',
      tipStoryPlot: '"Intrigue / Contexte du récit" vous permet de créer votre propre aventure personnelle.',
      tipLocations: 'Ajoutez votre ville et vos endroits préférés à "Intrigue / Contexte du récit" pour une touche personnelle.',
      tipArtStyle: 'Quel est votre style artistique préféré ? Pour les livres d\'images, l\'aquarelle fonctionne très bien !',
      coversPreview: 'Aperçu des couvertures',
      frontCover: 'Avant',
      initialPage: 'Intérieur',
      backCover: 'Arrière',
      cancelJob: 'Annuler la génération',
      cancelling: 'Annulation...',
      stalled: 'La génération semble bloquée',
      stalledDesc: 'Aucun progrès depuis un moment. Cela peut arriver en cas de forte charge serveur.',
      continueWaiting: 'Continuer à attendre',
      continueInBackground: 'Continuer en arrière-plan',
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
          <div className="mb-6 min-h-[220px] flex items-center justify-center">
            {(() => {
              const currentItem = rotationItems[rotationIndex];
              if (currentItem.type === 'character' && currentCharDisplay) {
                return (
                  <div key={`char-${currentItem.char.id}-${rotationIndex}`} className="flex flex-col items-center gap-3 animate-fade-in">
                    <div className="w-32 h-44 md:w-40 md:h-52 rounded-xl overflow-hidden border-4 border-indigo-200 shadow-lg bg-gradient-to-b from-indigo-50 to-purple-50">
                      <img
                        src={currentCharDisplay.avatarUrl}
                        alt={currentItem.char.name}
                        className="w-full h-full object-contain"
                      />
                    </div>
                    <p className="text-sm text-center text-gray-600 max-w-xs italic">{currentCharDisplay.message}</p>
                  </div>
                );
              } else if (currentItem.type === 'message') {
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
              return null; // Fallback while character display is being computed
            })()}
          </div>
        )}

        {/* Cover preview section */}
        {hasAnyCovers && (
          <div className="mb-4 bg-gradient-to-r from-indigo-50 to-purple-50 rounded-xl p-4">
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

        {/* Status message when covers are showing - let user know pages are being generated */}
        {hasAnyCovers && (
          <div className="mb-4 text-center">
            <p className="text-sm text-gray-600 flex items-center justify-center gap-2">
              <Loader2 size={14} className="animate-spin text-indigo-500" />
              {language === 'de'
                ? 'Bilder für die Seiten werden jetzt erstellt...'
                : language === 'fr'
                ? 'Création des images pour les pages en cours...'
                : 'Now generating images for the pages...'}
            </p>
            <p className="text-xs text-gray-500 mt-1">
              {language === 'de'
                ? 'Dies kann einige Minuten dauern. Du kannst den Browser schliessen.'
                : language === 'fr'
                ? 'Cela peut prendre quelques minutes. Vous pouvez fermer le navigateur.'
                : 'This may take a few minutes. You can close the browser.'}
            </p>
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

        {/* Continue in background button */}
        {onMinimize && (
          <button
            onClick={onMinimize}
            className="w-full mb-4 px-4 py-2.5 bg-indigo-100 hover:bg-indigo-200 text-indigo-700 rounded-lg font-medium transition-colors text-sm"
          >
            {t.continueInBackground}
          </button>
        )}

        {/* Stalled warning */}
        {isStalled && (
          <div className="mb-4 bg-amber-50 border border-amber-200 rounded-xl p-4">
            <div className="flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-amber-500 shrink-0 mt-0.5" />
              <div className="flex-1">
                <h4 className="font-medium text-amber-800 mb-1">{t.stalled}</h4>
                <p className="text-sm text-amber-700 mb-3">{t.stalledDesc}</p>
                <div className="flex gap-2">
                  {onDismissStalled && (
                    <button
                      onClick={onDismissStalled}
                      className="px-3 py-1.5 bg-amber-100 hover:bg-amber-200 text-amber-800 rounded-lg text-sm font-medium transition-colors"
                    >
                      {t.continueWaiting}
                    </button>
                  )}
                  {onCancel && (
                    <button
                      onClick={() => {
                        if (isCancelling) return;
                        setIsCancelling(true);
                        try {
                          onCancel();
                        } finally {
                          setIsCancelling(false);
                        }
                      }}
                      disabled={isCancelling}
                      className="px-3 py-1.5 bg-red-100 hover:bg-red-200 text-red-700 rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
                    >
                      {isCancelling ? t.cancelling : t.cancelJob}
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
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
