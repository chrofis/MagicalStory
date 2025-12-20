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

  // Generate funny message based on character traits
  const generateFunnyMessage = (char: Character, lang: string): string => {
    const name = char.name;
    const strengths = char.traits?.strengths || [];
    const flaws = char.traits?.flaws || [];
    const challenges = char.traits?.challenges || [];

    // Build funny messages based on traits
    const funnyMessages: { en: string; de: string; fr: string }[] = [];

    // Strength-based messages
    if (strengths.some(s => s.toLowerCase().includes('fast') || s.toLowerCase().includes('schnell') || s.toLowerCase().includes('rapide'))) {
      funnyMessages.push({
        en: `${name} ran away too fast! Catching them and bringing them back to the story...`,
        de: `${name} ist zu schnell weggerannt! Wir fangen sie ein und bringen sie zurück in die Geschichte...`,
        fr: `${name} s'est enfui trop vite ! On le rattrape et on le ramène dans le récit...`
      });
    }
    if (strengths.some(s => s.toLowerCase().includes('curious') || s.toLowerCase().includes('neugierig') || s.toLowerCase().includes('curieux'))) {
      funnyMessages.push({
        en: `${name} wandered off to explore something shiny. Luring them back with an even shinier adventure...`,
        de: `${name} ist losgewandert, um etwas Glänzendes zu erkunden. Wir locken sie mit einem noch glänzenderen Abenteuer zurück...`,
        fr: `${name} s'est égaré pour explorer quelque chose de brillant. On l'attire avec une aventure encore plus brillante...`
      });
    }
    if (strengths.some(s => s.toLowerCase().includes('brave') || s.toLowerCase().includes('mutig') || s.toLowerCase().includes('courageux'))) {
      funnyMessages.push({
        en: `${name} bravely charged ahead! Waiting for them to scout the path...`,
        de: `${name} ist mutig vorgestürmt! Wir warten, bis sie den Weg erkundet haben...`,
        fr: `${name} a courageusement foncé en avant ! On attend qu'il explore le chemin...`
      });
    }

    // Flaw/challenge-based messages
    if (flaws.some(f => f.toLowerCase().includes('shy') || f.toLowerCase().includes('schüchtern') || f.toLowerCase().includes('timide')) ||
        challenges.some(c => c.toLowerCase().includes('shy'))) {
      funnyMessages.push({
        en: `${name} is hiding behind a tree. Coaxing them out with cookies...`,
        de: `${name} versteckt sich hinter einem Baum. Wir locken sie mit Keksen hervor...`,
        fr: `${name} se cache derrière un arbre. On l'attire avec des biscuits...`
      });
    }
    if (challenges.some(c => c.toLowerCase().includes('monster') || c.toLowerCase().includes('dark') || c.toLowerCase().includes('dunkel') || c.toLowerCase().includes('peur'))) {
      funnyMessages.push({
        en: `${name} got scared by a shadow! Turning on the nightlight and bringing them back...`,
        de: `${name} hat sich vor einem Schatten erschreckt! Wir machen das Nachtlicht an und holen sie zurück...`,
        fr: `${name} a eu peur d'une ombre ! On allume la veilleuse et on le ramène...`
      });
    }
    if (flaws.some(f => f.toLowerCase().includes('stubborn') || f.toLowerCase().includes('stur') || f.toLowerCase().includes('têtu'))) {
      funnyMessages.push({
        en: `${name} refuses to move! Convincing them with promises of adventure...`,
        de: `${name} weigert sich, sich zu bewegen! Wir überzeugen sie mit Abenteuerversprechungen...`,
        fr: `${name} refuse de bouger ! On le convainc avec des promesses d'aventure...`
      });
    }

    // Default messages if no traits match
    if (funnyMessages.length === 0) {
      funnyMessages.push(
        {
          en: `${name} is getting ready for their big adventure...`,
          de: `${name} macht sich bereit für das grosse Abenteuer...`,
          fr: `${name} se prépare pour sa grande aventure...`
        },
        {
          en: `${name} is practicing their hero pose...`,
          de: `${name} übt gerade die Heldenpose...`,
          fr: `${name} s'entraîne à prendre la pose du héros...`
        },
        {
          en: `${name} can't wait to see what happens next!`,
          de: `${name} kann es kaum erwarten zu sehen, was als Nächstes passiert!`,
          fr: `${name} a hâte de voir ce qui va se passer !`
        }
      );
    }

    // Pick a random message
    const msg = funnyMessages[Math.floor(Math.random() * funnyMessages.length)];
    return lang === 'de' ? msg.de : lang === 'fr' ? msg.fr : msg.en;
  };

  // Get all avatars from each character (all styles: standard, winter, summer, formal)
  const characterAvatars = useMemo(() => {
    const avatarList: { name: string; avatar: string; style: string; funnyMessage: string }[] = [];
    const styles = ['standard', 'summer', 'winter', 'formal'] as const;

    characters.forEach(char => {
      const avatars = char.avatars;
      if (!avatars) return;

      styles.forEach(style => {
        const avatarUrl = avatars[style];
        if (avatarUrl) {
          avatarList.push({
            name: char.name,
            avatar: avatarUrl,
            style,
            funnyMessage: generateFunnyMessage(char, language)
          });
        }
      });
    });

    return avatarList;
  }, [characters, language]);

  // Build rotation items: interleave messages and avatars
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

    const items: Array<
      { type: 'message'; key: string } |
      { type: 'avatar'; name: string; avatar: string; style: string; funnyMessage: string }
    > = [];

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
              if (currentItem.type === 'avatar') {
                return (
                  <div className="flex flex-col items-center gap-3 animate-fade-in">
                    <div className="w-32 h-44 md:w-40 md:h-52 rounded-xl overflow-hidden border-4 border-indigo-200 shadow-lg bg-gradient-to-b from-indigo-50 to-purple-50">
                      <img
                        src={currentItem.avatar}
                        alt={currentItem.name}
                        className="w-full h-full object-contain"
                      />
                    </div>
                    <p className="text-sm text-center text-gray-600 max-w-xs italic">{currentItem.funnyMessage}</p>
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
