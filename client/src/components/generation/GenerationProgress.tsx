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
  pageCount?: number;  // Number of story pages (affects progress timing)
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
  pageCount = 20,
}: GenerationProgressProps) {
  const { language } = useLanguage();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin' || isImpersonating;
  const [isCancelling, setIsCancelling] = useState(false);
  const [rotationIndex, setRotationIndex] = useState(0);

  // 25 funny messages per character - uses {name} placeholder
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
    },
    {
      en: '{name} is looking for the perfect hiding spot...',
      de: '{name} sucht das perfekte Versteck...',
      fr: '{name} cherche la cachette parfaite...'
    },
    {
      en: '{name} is trying on different hats for the story...',
      de: '{name} probiert verschiedene Hüte für die Geschichte an...',
      fr: '{name} essaie différents chapeaux pour le récit...'
    },
    {
      en: '{name} just spotted a rainbow! Quick, follow it...',
      de: '{name} hat gerade einen Regenbogen entdeckt! Schnell, hinterher...',
      fr: '{name} vient de repérer un arc-en-ciel ! Vite, suivons-le...'
    },
    {
      en: '{name} is teaching the story characters a secret handshake...',
      de: '{name} bringt den Figuren einen geheimen Handschlag bei...',
      fr: '{name} apprend une poignée de main secrète aux personnages...'
    },
    {
      en: '{name} found a treasure map in their pocket!',
      de: '{name} hat eine Schatzkarte in der Tasche gefunden!',
      fr: '{name} a trouvé une carte au trésor dans sa poche !'
    },
    {
      en: '{name} is building a fort out of storybooks...',
      de: '{name} baut eine Burg aus Geschichtenbüchern...',
      fr: '{name} construit un fort avec des livres d\'histoires...'
    },
    {
      en: '{name} is chasing butterflies between chapters...',
      de: '{name} jagt Schmetterlinge zwischen den Kapiteln...',
      fr: '{name} court après les papillons entre les chapitres...'
    },
    {
      en: '{name} is counting shooting stars...',
      de: '{name} zählt Sternschnuppen...',
      fr: '{name} compte les étoiles filantes...'
    },
    {
      en: '{name} just learned a new magic spell!',
      de: '{name} hat gerade einen neuen Zauberspruch gelernt!',
      fr: '{name} vient d\'apprendre un nouveau sort magique !'
    },
    {
      en: '{name} is drawing pictures in the sand...',
      de: '{name} malt Bilder in den Sand...',
      fr: '{name} dessine des images dans le sable...'
    },
    {
      en: '{name} packed a picnic for the adventure...',
      de: '{name} hat ein Picknick für das Abenteuer eingepackt...',
      fr: '{name} a préparé un pique-nique pour l\'aventure...'
    },
    {
      en: '{name} is tiptoeing past a sleeping giant...',
      de: '{name} schleicht auf Zehenspitzen an einem schlafenden Riesen vorbei...',
      fr: '{name} passe sur la pointe des pieds devant un géant endormi...'
    },
    {
      en: '{name} made friends with a talking squirrel!',
      de: '{name} hat sich mit einem sprechenden Eichhörnchen angefreundet!',
      fr: '{name} s\'est lié d\'amitié avec un écureuil parlant !'
    },
    {
      en: '{name} discovered a secret door behind the bookshelf...',
      de: '{name} hat eine Geheimtür hinter dem Bücherregal entdeckt...',
      fr: '{name} a découvert une porte secrète derrière la bibliothèque...'
    },
    {
      en: '{name} is braiding flowers into a crown...',
      de: '{name} flicht Blumen zu einer Krone...',
      fr: '{name} tresse des fleurs en couronne...'
    }
  ];

  // Track which message was shown for each character to avoid repeats (useRef to avoid dependency issues)
  const messageIndicesRef = useRef<Record<number, number>>({});
  // Track which rotationIndex we last generated a message for (to avoid double-advancing on re-renders)
  const lastMessageRotationRef = useRef<number>(-1);

  // Get all available avatar URLs for a character (individual face + body crops, no 2x2 grids)
  const getAllAvatarUrls = (char: Character): string[] => {
    const avatars = char.avatars;
    const urls: string[] = [];
    if (avatars) {
      // Face thumbnails (individual face crops)
      if (avatars.faceThumbnails) {
        for (const url of Object.values(avatars.faceThumbnails)) {
          if (url && typeof url === 'string') urls.push(url);
        }
      }
      // Body thumbnails (individual full body front crops)
      if (avatars.bodyThumbnails) {
        for (const url of Object.values(avatars.bodyThumbnails)) {
          if (url && typeof url === 'string') urls.push(url);
        }
      }
      // Fallback: standard avatar (2x2 grid, but better than nothing)
      if (urls.length === 0 && avatars.standard && typeof avatars.standard === 'string') {
        urls.push(avatars.standard);
      }
    }
    // Fallback: uploaded photos
    if (urls.length === 0) {
      const photo = char.photos?.face || char.photos?.original;
      if (photo && typeof photo === 'string') urls.push(photo);
    }
    return urls;
  };

  // Stable key for characters — only recompute rotation when IDs or avatar URLs actually change
  const charactersKey = useMemo(() => {
    return characters.map(c => {
      const urls = getAllAvatarUrls(c);
      return `${c.id}:${urls.join(',')}`;
    }).join('|');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [characters]);

  // Build rotation items: always alternate tip, char, tip, char...
  // Each character × avatar pair is a separate entry for maximum variety
  const rotationItems = useMemo(() => {
    const messages = [
      { type: 'message' as const, key: 'timeInfo' },
      { type: 'message' as const, key: 'tipCharacters' },
      { type: 'message' as const, key: 'tipPrintedBook' },
      { type: 'message' as const, key: 'emailInfo' },
      { type: 'message' as const, key: 'tipStoryPlot' },
      { type: 'message' as const, key: 'tipLearning' },
      { type: 'message' as const, key: 'canClose' },
      { type: 'message' as const, key: 'tipLocations' },
      { type: 'message' as const, key: 'tipHistoric' },
      { type: 'message' as const, key: 'tipArtStyle' },
      { type: 'message' as const, key: 'tipSharing' },
      { type: 'message' as const, key: 'tipCredits' },
    ];

    // Build flat list of all (character, avatarUrl) pairs
    const charAvatarPairs: { char: Character; avatarUrl: string }[] = [];
    for (const char of characters) {
      const urls = getAllAvatarUrls(char);
      for (const url of urls) {
        charAvatarPairs.push({ char, avatarUrl: url });
      }
    }

    // If no avatar pairs, just use messages
    if (charAvatarPairs.length === 0) {
      return messages;
    }

    // Shuffle pairs so same character doesn't cluster (Fisher-Yates)
    const shuffled = [...charAvatarPairs];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }

    // Pre-seed each character's message index to a different offset
    // so they don't all start on the same template
    const uniqueCharIds = [...new Set(shuffled.map(p => p.char.id))];
    const spacing = Math.max(1, Math.floor(funnyMessageTemplates.length / uniqueCharIds.length));
    for (let i = 0; i < uniqueCharIds.length; i++) {
      messageIndicesRef.current[uniqueCharIds[i]] = i * spacing;
    }

    const items: Array<
      { type: 'message'; key: string } |
      { type: 'character'; char: Character; avatarUrl: string }
    > = [];

    // Always alternate: tip, char, tip, char...
    // Use the longer list to determine total pairs, cycling through the shorter one
    const numPairs = Math.max(messages.length, shuffled.length);
    for (let i = 0; i < numPairs; i++) {
      items.push(messages[i % messages.length]);
      items.push({ type: 'character', char: shuffled[i % shuffled.length].char, avatarUrl: shuffled[i % shuffled.length].avatarUrl });
    }

    return items;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [charactersKey]);

  // Rotate every 5 seconds
  useEffect(() => {
    if (rotationItems.length <= 1) return;

    const interval = setInterval(() => {
      setRotationIndex(prev => (prev + 1) % rotationItems.length);
    }, 5000);

    return () => clearInterval(interval);
  }, [rotationItems.length]);

  // Derive character display directly from rotation state (no useEffect delay = perfect sync)
  const currentCharDisplay = useMemo(() => {
    if (rotationItems.length === 0) return null;

    const currentItem = rotationItems[rotationIndex];
    if (currentItem.type !== 'character') return null;

    const char = currentItem.char;
    const avatarUrl = currentItem.avatarUrl;

    // Only advance message counter when rotationIndex actually changes (not on re-renders)
    if (lastMessageRotationRef.current !== rotationIndex) {
      lastMessageRotationRef.current = rotationIndex;
      const currentIndex = messageIndicesRef.current[char.id] ?? -1;
      messageIndicesRef.current[char.id] = (currentIndex + 1) % funnyMessageTemplates.length;
    }

    const idx = messageIndicesRef.current[char.id] ?? 0;
    const template = funnyMessageTemplates[idx];
    const msg = language === 'de' ? template.de : language === 'fr' ? template.fr : template.en;
    const message = msg.replace('{name}', char.name);

    return { avatarUrl, message };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rotationIndex, rotationItems, language]);

  if (!isGenerating || total === 0) {
    return null;
  }

  // Server progress (0-100)
  const serverProgress = total === 100 ? current : Math.round((current / total) * 100);

  // Map server checkpoints to user-perceived progress (proportional to wall-clock time)
  // Server: 5(start) → 6-15(streaming ~6min) → 18(text done) → 20(avatars) → 30(scenes) → 50-80(images ~3min) → 95(covers) → 100
  // User:   1        → 2-50(streaming)        → 55           → 60          → 65          → 70-90(images)       → 95          → 100
  const mapToUser = (sp: number): number => {
    if (sp <= 5) return 1;
    if (sp <= 15) return 2 + Math.round(((sp - 5) / 10) * 48);     // 5-15 → 2-50  (streaming = 50% of bar)
    if (sp <= 18) return 55;                                         // 18 = text done
    if (sp <= 20) return 60;                                         // 20 = avatars
    if (sp <= 30) return 60 + Math.round(((sp - 20) / 10) * 5);    // 20-30 → 60-65  (scene expansion)
    if (sp <= 50) return 65 + Math.round(((sp - 30) / 20) * 5);    // 30-50 → 65-70  (transition)
    if (sp <= 80) return 70 + Math.round(((sp - 50) / 30) * 20);   // 50-80 → 70-90  (images)
    if (sp < 100) return 90 + Math.round(((sp - 80) / 20) * 10);   // 80-100 → 90-100 (finalization)
    return 100;
  };
  const mappedProgress = mapToUser(serverProgress);

  // Smooth interpolation: during streaming the server stays at 5-8% for minutes.
  // Use elapsed time to smoothly fill between checkpoints so the bar never looks stuck.
  // Creep speed scales with page count: fewer pages = faster creep.
  const [startTime] = useState(() => Date.now());
  const [displayProgress, setDisplayProgress] = useState(1);

  // Scale creep interval: 5 pages = 8s, 10 pages = 12s, 25 pages = 20s, 50 pages = 30s
  const creepInterval = Math.max(8, Math.min(30, Math.round(8 + (pageCount - 5) * 0.5))) * 1000;
  // How often the tick runs (always 3s for smooth updates)
  const tickMs = 3000;

  useEffect(() => {
    // If mapped progress jumped ahead, sync immediately
    if (mappedProgress > displayProgress) {
      setDisplayProgress(mappedProgress);
      return;
    }
    // While waiting for next checkpoint, creep forward based on time
    const interval = setInterval(() => {
      setDisplayProgress(prev => {
        const elapsed = (Date.now() - startTime) / 1000;
        // Creep: +1% every creepInterval seconds, capped at 3 ahead of mapped
        const creepSeconds = creepInterval / 1000;
        const timeBump = Math.floor(elapsed / creepSeconds);
        const maxCreep = Math.min(mappedProgress + 3, 98);
        return Math.min(prev + 1, maxCreep, Math.max(prev, timeBump));
      });
    }, tickMs);
    return () => clearInterval(interval);
  }, [mappedProgress, displayProgress, startTime, creepInterval]);

  const progressPercent = Math.max(displayProgress, mappedProgress);

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
      timeInfo: 'Your story takes about 5–10 minutes depending on length. The first pages will appear soon!',
      emailInfo: 'You\'ll receive an email when your story is ready — feel free to do something else.',
      canClose: 'You can close the browser anytime — your story keeps generating in the background.',
      tipCharacters: 'Children learn best when they see themselves in the story. That\'s the magic of personalized books!',
      tipStoryPlot: 'You can edit any text and regenerate any image after the story is created — make it perfect!',
      tipLocations: 'We include real photos of your hometown landmarks in the illustrations — select your location for a personal touch.',
      tipArtStyle: 'Try different art styles! Watercolor for picture books, oil painting for older kids, comic for fun adventures.',
      tipPrintedBook: 'Love the story? Order it as a beautifully printed book — and get your credits back!',
      tipSharing: 'Stories are private by default. Enable sharing to let grandparents and friends read along.',
      tipHistoric: 'Explore history! Your child can experience the moon landing, meet dinosaurs, or discover local Swiss legends.',
      tipLearning: 'Personalized stories inspire children to read — much better than screen time arguments!',
      tipCredits: 'Each page costs 10 credits. A 20-page story uses 200 credits — you can create stories up to 50 pages with 25 illustrations!',
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
      timeInfo: 'Deine Geschichte braucht etwa 5–10 Minuten je nach Länge. Die ersten Seiten erscheinen bald!',
      emailInfo: 'Du erhältst eine E-Mail, wenn deine Geschichte bereit ist — mach ruhig etwas anderes.',
      canClose: 'Du kannst den Browser jederzeit schliessen — deine Geschichte wird im Hintergrund weiter erstellt.',
      tipCharacters: 'Kinder lernen am besten, wenn sie sich selbst in der Geschichte sehen. Das ist die Magie personalisierter Bücher!',
      tipStoryPlot: 'Du kannst jeden Text bearbeiten und jedes Bild neu generieren — mach die Geschichte perfekt!',
      tipLocations: 'Wir verwenden echte Fotos deiner Heimat-Sehenswürdigkeiten in den Illustrationen — wähle deinen Ort für eine persönliche Note.',
      tipArtStyle: 'Probiere verschiedene Kunststile! Aquarell für Bilderbücher, Ölgemälde für ältere Kinder, Comic für lustige Abenteuer.',
      tipPrintedBook: 'Gefällt dir die Geschichte? Bestelle sie als wunderschön gedrucktes Buch — und erhalte deine Credits zurück!',
      tipSharing: 'Geschichten sind standardmässig privat. Aktiviere das Teilen, damit Grosseltern und Freunde mitlesen können.',
      tipHistoric: 'Entdecke Geschichte! Dein Kind kann die Mondlandung erleben, Dinosaurier treffen oder lokale Schweizer Sagen entdecken.',
      tipLearning: 'Personalisierte Geschichten motivieren Kinder zum Lesen — viel besser als Diskussionen über Bildschirmzeit!',
      tipCredits: 'Jede Seite kostet 10 Credits. Eine 20-Seiten-Geschichte braucht 200 Credits — du kannst Geschichten bis zu 50 Seiten mit 25 Illustrationen erstellen!',
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
      timeInfo: 'Votre histoire prend environ 5 à 10 minutes selon la longueur. Les premières pages apparaîtront bientôt !',
      emailInfo: 'Vous recevrez un email quand votre histoire sera prête — n\'hésitez pas à faire autre chose.',
      canClose: 'Vous pouvez fermer le navigateur à tout moment — votre histoire continue d\'être créée en arrière-plan.',
      tipCharacters: 'Les enfants apprennent mieux quand ils se voient dans l\'histoire. C\'est la magie des livres personnalisés !',
      tipStoryPlot: 'Vous pouvez modifier chaque texte et regénérer chaque image après la création — rendez-la parfaite !',
      tipLocations: 'Nous incluons de vraies photos de vos monuments locaux dans les illustrations — choisissez votre lieu pour une touche personnelle.',
      tipArtStyle: 'Essayez différents styles ! Aquarelle pour les albums, peinture à l\'huile pour les plus grands, BD pour les aventures amusantes.',
      tipPrintedBook: 'Vous aimez l\'histoire ? Commandez-la en livre imprimé — et récupérez vos crédits !',
      tipSharing: 'Les histoires sont privées par défaut. Activez le partage pour que les grands-parents et amis puissent lire.',
      tipHistoric: 'Explorez l\'histoire ! Votre enfant peut vivre l\'alunissage, rencontrer des dinosaures ou découvrir des légendes locales.',
      tipLearning: 'Les histoires personnalisées inspirent les enfants à lire — bien mieux que les disputes sur le temps d\'écran !',
      tipCredits: 'Chaque page coûte 10 crédits. Une histoire de 20 pages utilise 200 crédits — vous pouvez créer des histoires jusqu\'à 50 pages avec 25 illustrations !',
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
          <img src={imageData} alt={label} className="w-full h-full object-cover object-top" />
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
                    <div className="w-32 md:w-40 h-44 md:h-56 rounded-xl overflow-hidden border-4 border-indigo-200 shadow-lg bg-gradient-to-b from-indigo-50 to-indigo-50">
                      <img
                        src={currentCharDisplay.avatarUrl}
                        alt={currentItem.char.name}
                        className="w-full h-full object-contain object-center"
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
                  <div className="flex items-start gap-3 bg-gradient-to-r from-indigo-50 to-indigo-50 rounded-xl p-4 max-w-sm animate-fade-in">
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
          <div className="mb-4 bg-gradient-to-r from-indigo-50 to-indigo-50 rounded-xl p-4">
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
