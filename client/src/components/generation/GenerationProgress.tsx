import { useState, useEffect, useMemo, useRef } from 'react';
import { Loader2, Mail, Clock, CheckCircle, XCircle } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import { useAuth } from '@/context/AuthContext';
import { ProgressBar } from '@/components/common/ProgressBar';
import type { Character } from '@/types/character';
import { getFaceThumb, getBodyThumb, getStandardAvatar } from '@/utils/characterPhotos';
import {
  CREDITS_PER_PAGE,
  EXAMPLE_STORY_PAGES,
  EXAMPLE_STORY_CREDITS,
} from '@/constants/credits';

// Server progress → display %. The server already reports a TIME-PROPORTIONAL
// percent (story_jobs.progress): the beats text stages carry measured budgets
// (1-57, eased between checkpoints by the text-phase heartbeat), avatars and
// scenes 58-59, page images 60-64, the automatic repair 64-96, covers 97,
// finalize 98, done 100. Measured on production 2026-09 (52-83 min, median
// ~57): writing ~28-39 min, images ~2 min, repair 20-40 min, i.e. roughly
// 57 / 4 / 35 % of the wall clock, which is what those numbers encode. The
// old client table re-mapped an obsolete 1-73 checkpoint numbering on top of
// that, so the bar sat at 3-12 % through the arc and at 90-98 % for the last
// 40 minutes. The only job left here is clamping (docs/decisions.md,
// 2026-09-24 "Progress bar shows the server percent").
export function checkpointToPercent(cp: number): number {
  if (!Number.isFinite(cp) || cp <= 1) return 1;
  if (cp >= 100) return 100;
  return Math.min(99, Math.round(cp));
}

interface GenerationProgressProps {
  current: number;
  total: number;
  message?: string;
  isGenerating?: boolean;
  jobId?: string;  // Job ID for cancellation
  onCancel?: () => void;  // Callback when job is cancelled
  onMinimize?: () => void;  // Callback to minimize and continue in background
  characters?: Character[];  // Characters to show avatars from
  pageCount?: number;  // Number of story pages (affects progress timing)
  isImpersonating?: boolean;  // Whether admin is impersonating a user
}

export function GenerationProgress({
  current,
  total,
  message: _message,
  isGenerating = true,
  jobId,
  onCancel,
  onMinimize,
  characters = [],
  isImpersonating = false,
  pageCount: _pageCount = 20,  // kept in props for caller compat; no longer used by progress timing
}: GenerationProgressProps) {
  const { language } = useLanguage();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin' || isImpersonating;
  const [isCancelling, setIsCancelling] = useState(false);
  const [rotationIndex, setRotationIndex] = useState(0);

  // THE HOUR MESSAGE (owner spec 2026-09-24). A story takes about an hour
  // (production 2026-09: 52, 54, 57, 58, 83 min). The reader must learn that
  // FIRST, together with "you can leave, we email you", so it opens as the
  // prominent panel and after a few seconds settles into a small standing note
  // under the spinner. It replaced a 20 s delayed email panel plus a rotating
  // "30-60 minutes" tip, which said the same thing twice and the timing wrongly.
  const [hourNoteSettled, setHourNoteSettled] = useState(false);
  useEffect(() => {
    if (!isGenerating) {
      setHourNoteSettled(false);
      return;
    }
    const timer = setTimeout(() => setHourNoteSettled(true), 7_000);
    return () => clearTimeout(timer);
  }, [isGenerating]);

  // 25 funny messages per character - uses {name} placeholder
  const funnyMessageTemplates = [
    {
      en: '{name} is getting ready for their big adventure...',
      de: '{name} macht sich bereit für das grosse Abenteuer...',
      fr: '{name} se prépare pour sa grande aventure...',
      it: '{name} si sta preparando per la grande avventura...'
    },
    {
      en: '{name} is practicing their hero pose...',
      de: '{name} übt gerade die Heldenpose...',
      fr: '{name} s\'entraîne à prendre la pose du héros...',
      it: '{name} sta provando la posa da eroe...'
    },
    {
      en: '{name} can\'t wait to see what happens next!',
      de: '{name} kann es kaum erwarten zu sehen, was als Nächstes passiert!',
      fr: '{name} a hâte de voir ce qui va se passer !',
      it: '{name} non vede l\'ora di sapere come va a finire!'
    },
    {
      en: '{name} is warming up for the adventure ahead...',
      de: '{name} wärmt sich für das bevorstehende Abenteuer auf...',
      fr: '{name} s\'échauffe pour l\'aventure à venir...',
      it: '{name} si sta scaldando per l\'avventura che arriva...'
    },
    {
      en: '{name} just found a magic feather! Adding it to the story...',
      de: '{name} hat gerade eine Zauberfeder gefunden! Wir fügen sie der Geschichte hinzu...',
      fr: '{name} vient de trouver une plume magique ! On l\'ajoute au récit...',
      it: '{name} ha appena trovato una piuma magica! La mettiamo nella storia...'
    },
    {
      en: '{name} is whispering secrets to the story wizard...',
      de: '{name} flüstert dem Geschichtenzauberer Geheimnisse zu...',
      fr: '{name} chuchote des secrets au magicien des histoires...',
      it: '{name} sussurra segreti al mago delle storie...'
    },
    {
      en: '{name} is peeking around the corner to see what\'s coming...',
      de: '{name} schaut um die Ecke, um zu sehen, was kommt...',
      fr: '{name} jette un coup d\'œil au coin pour voir ce qui arrive...',
      it: '{name} sbircia dietro l\'angolo per vedere cosa arriva...'
    },
    {
      en: '{name} is doing a little happy dance!',
      de: '{name} macht einen kleinen Freudentanz!',
      fr: '{name} fait une petite danse de joie !',
      it: '{name} si sta facendo un balletto di gioia!'
    },
    {
      en: '{name} is collecting stars for the story...',
      de: '{name} sammelt Sterne für die Geschichte...',
      fr: '{name} collectionne des étoiles pour le récit...',
      it: '{name} sta raccogliendo stelle per la storia...'
    },
    {
      en: '{name} just met a friendly dragon! Making friends...',
      de: '{name} hat gerade einen freundlichen Drachen getroffen! Sie werden Freunde...',
      fr: '{name} vient de rencontrer un dragon amical ! Ils deviennent amis...',
      it: '{name} ha appena incontrato un drago gentile! Stanno diventando amici...'
    },
    {
      en: '{name} is looking for the perfect hiding spot...',
      de: '{name} sucht das perfekte Versteck...',
      fr: '{name} cherche la cachette parfaite...',
      it: '{name} cerca il nascondiglio perfetto...'
    },
    {
      en: '{name} is trying on different hats for the story...',
      de: '{name} probiert verschiedene Hüte für die Geschichte an...',
      fr: '{name} essaie différents chapeaux pour le récit...',
      it: '{name} sta provando cappelli diversi per la storia...'
    },
    {
      en: '{name} just spotted a rainbow! Quick, follow it...',
      de: '{name} hat gerade einen Regenbogen entdeckt! Schnell, hinterher...',
      fr: '{name} vient de repérer un arc-en-ciel ! Vite, suivons-le...',
      it: '{name} ha appena avvistato un arcobaleno! Presto, seguiamolo...'
    },
    {
      en: '{name} is teaching the story characters a secret handshake...',
      de: '{name} bringt den Figuren einen geheimen Handschlag bei...',
      fr: '{name} apprend une poignée de main secrète aux personnages...',
      it: '{name} insegna ai personaggi una stretta di mano segreta...'
    },
    {
      en: '{name} found a treasure map in their pocket!',
      de: '{name} hat eine Schatzkarte in der Tasche gefunden!',
      fr: '{name} a trouvé une carte au trésor dans sa poche !',
      it: '{name} ha trovato una mappa del tesoro in tasca!'
    },
    {
      en: '{name} is building a fort out of storybooks...',
      de: '{name} baut eine Burg aus Geschichtenbüchern...',
      fr: '{name} construit un fort avec des livres d\'histoires...',
      it: '{name} sta costruendo un castello con i libri di fiabe...'
    },
    {
      en: '{name} is chasing butterflies between chapters...',
      de: '{name} jagt Schmetterlinge zwischen den Kapiteln...',
      fr: '{name} court après les papillons entre les chapitres...',
      it: '{name} rincorre le farfalle fra un capitolo e l\'altro...'
    },
    {
      en: '{name} is counting shooting stars...',
      de: '{name} zählt Sternschnuppen...',
      fr: '{name} compte les étoiles filantes...',
      it: '{name} sta contando le stelle cadenti...'
    },
    {
      en: '{name} just learned a new magic spell!',
      de: '{name} hat gerade einen neuen Zauberspruch gelernt!',
      fr: '{name} vient d\'apprendre un nouveau sort magique !',
      it: '{name} ha appena imparato un nuovo incantesimo!'
    },
    {
      en: '{name} is drawing pictures in the sand...',
      de: '{name} malt Bilder in den Sand...',
      fr: '{name} dessine des images dans le sable...',
      it: '{name} disegna sulla sabbia...'
    },
    {
      en: '{name} packed a picnic for the adventure...',
      de: '{name} hat ein Picknick für das Abenteuer eingepackt...',
      fr: '{name} a préparé un pique-nique pour l\'aventure...',
      it: '{name} ha preparato un picnic per l\'avventura...'
    },
    {
      en: '{name} is tiptoeing past a sleeping giant...',
      de: '{name} schleicht auf Zehenspitzen an einem schlafenden Riesen vorbei...',
      fr: '{name} passe sur la pointe des pieds devant un géant endormi...',
      it: '{name} passa in punta di piedi davanti a un gigante addormentato...'
    },
    {
      en: '{name} made friends with a talking squirrel!',
      de: '{name} hat sich mit einem sprechenden Eichhörnchen angefreundet!',
      fr: '{name} s\'est lié d\'amitié avec un écureuil parlant !',
      it: '{name} ha fatto amicizia con uno scoiattolo parlante!'
    },
    {
      en: '{name} discovered a secret door behind the bookshelf...',
      de: '{name} hat eine Geheimtür hinter dem Bücherregal entdeckt...',
      fr: '{name} a découvert une porte secrète derrière la bibliothèque...',
      it: '{name} ha scoperto una porta segreta dietro la libreria...'
    },
    {
      en: '{name} is braiding flowers into a crown...',
      de: '{name} flicht Blumen zu einer Krone...',
      fr: '{name} tresse des fleurs en couronne...',
      it: '{name} sta intrecciando fiori per farne una corona...'
    }
  ];

  // Track which message was shown for each character to avoid repeats (useRef to avoid dependency issues)
  const messageIndicesRef = useRef<Record<number, number>>({});
  // Track which rotationIndex we last generated a message for (to avoid double-advancing on re-renders)
  const lastMessageRotationRef = useRef<number>(-1);

  // Get all available avatar URLs for a character (individual face + body crops, no 2x2 grids).
  //
  // Dual-shape (Phase 1 migration): we read every variant via getFaceThumb /
  // getBodyThumb / getStandardAvatar, which handle NEW (`faceThumb` / `bodyThumb`
  // / `standard` as URL string) and OLD (`faceThumbnailsUrl` / `bodyThumbnailsUrl`
  // / inline objects, `standardUrl`) shapes uniformly. No more direct
  // `avatars.faceThumbnails` reads — one helper, one source of truth.
  const getAllAvatarUrls = (char: Character): string[] => {
    const urls: string[] = [];
    const variants: Array<'standard' | 'winter' | 'summer'> = ['standard', 'winter', 'summer'];
    for (const v of variants) {
      const face = getFaceThumb(char, v);
      if (face) urls.push(face);
    }
    for (const v of variants) {
      const body = getBodyThumb(char, v);
      if (body) urls.push(body);
    }
    // Fallback: base standard avatar (2x2 grid, but better than nothing)
    if (urls.length === 0) {
      const standard = getStandardAvatar(char, 'standard');
      if (standard) urls.push(standard);
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
      { type: 'message' as const, key: 'tipCharacters' },
      { type: 'message' as const, key: 'tipPrintedBook' },
      { type: 'message' as const, key: 'tipStoryPlot' },
      { type: 'message' as const, key: 'tipLearning' },
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
    const msg = language === 'de' ? template.de : language === 'fr' ? template.fr : language === 'it' ? template.it : template.en;
    const message = msg.replace('{name}', char.name);

    return { avatarUrl, message };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rotationIndex, rotationItems, language]);

  // Server sends a time-proportional percent (1-98, then 100 for done).
  // We map these to target percentages and smoothly animate toward them —
  // the bar should always be increasing, just at different speeds.
  // NOTE: All hooks below MUST run before the `if (!isGenerating || total === 0)`
  // early return — calling them conditionally violates the Rules of Hooks
  // (React error #310) when isGenerating/total flips between renders.
  const serverCheckpoint = total === 100 ? current : (total > 0 ? Math.round((current / total) * 100) : 0);
  const isDone = serverCheckpoint >= 100;

  const targetPercent = checkpointToPercent(serverCheckpoint);

  // Progress strategy: snap on large checkpoint jumps so the modal bar always
  // matches the nav-bar percentage (both share checkpointToPercent). Smooth
  // animation only for small refinements between sub-checkpoints (1-12 gap).
  // Earlier 1%/sec linear creep let the modal trail the nav bar by tens of
  // seconds when checkpoint jumped (e.g. 8 → 32 → 75% — modal stayed at 8).

  const [displayProgress, setDisplayProgress] = useState(1);
  const targetRef = useRef(1);
  // The NEXT checkpoint's mapped percent — the bar creeps toward it (minus a
  // small margin) while it waits, so it is never frozen during a long phase.
  // Read from a ref so the interval (deps [isDone]) always sees the fresh value
  // without being recreated. Both are monotonic (checkpoints only advance).
  const nextTargetRef = useRef(3);

  // Update targets when checkpoint changes
  if (targetPercent > targetRef.current) {
    targetRef.current = targetPercent;
  }
  nextTargetRef.current = Math.max(nextTargetRef.current, Math.min(checkpointToPercent(serverCheckpoint + 1), 99));

  useEffect(() => {
    if (isDone) { setDisplayProgress(100); return; }

    // Tick every 500ms for smooth animation toward the target.
    //
    // Single rule: never exceed `target`. The bar advances toward the latest
    // checkpoint percentage (held in targetRef, monotonic) and stops there
    // until the next checkpoint arrives. No creep above target — that's
    // what produced the see-saw (Phase 1 climbed blindly to 35%, then
    // Phase 2's creep cap snapped the bar back to target+3, then Phase 1
    // climbed again). When target=8 the bar will sit at 8 — same as the
    // header indicator and the Stories card.
    const interval = setInterval(() => {
      setDisplayProgress(prev => {
        const target = targetRef.current;
        const gap = target - prev;

        // Below the confirmed checkpoint: catch up to it.
        if (gap > 0) {
          // Large checkpoint leaps (text done → quality-eval start = +25,
          // scenes → covers done = +18) used to crawl at 0.5%/tick which made
          // the bar visibly trail. Snap when the gap is wide enough that the
          // lag is the message itself; stay smooth for small refinements.
          const SNAP_GAP = 12;
          if (gap >= SNAP_GAP) return target;
          const step = gap < 3 ? 0.3 : gap < 6 ? 0.6 : 1.0;
          return Math.min(prev + step, target);
        }

        // At/above the confirmed checkpoint: the next checkpoint can be tens of
        // seconds away (plot streaming sits on checkpoint 5 = 20% for 60s+
        // before jumping to 48%). Instead of freezing, creep toward the NEXT
        // checkpoint's percent — decelerating as it approaches, never reaching
        // it (leaves headroom so the real checkpoint lands smoothly above). The
        // bar is therefore never stuck, and because display only ever increases
        // toward a monotonic ceiling there is no see-saw.
        const ceiling = nextTargetRef.current - 0.5;
        if (prev >= ceiling) return prev; // asymptote reached near a milestone — rare
        const creep = Math.max((ceiling - prev) * 0.04, 0.08);
        return Math.min(prev + creep, ceiling);
      });
    }, 500);
    return () => clearInterval(interval);
  }, [isDone]);

  // Early return AFTER all hooks above — never before.
  if (!isGenerating || total === 0) {
    return null;
  }

  const translations = {
    en: {
      title: 'Creating Your Story!',
      hourTitle: "Your story takes about an hour.",
      hourBody: "You can leave this page. We'll email you as soon as it's ready.",
      tipCharacters: 'Children learn best when they see themselves in the story. That\'s the magic of personalized books!',
      tipStoryPlot: 'You can edit any text and regenerate any image after the story is created — make it perfect!',
      tipLocations: 'We include real photos of your hometown landmarks in the illustrations — select your location for a personal touch.',
      tipArtStyle: 'Try different art styles! Watercolor for picture books, oil painting for older kids, comic for fun adventures.',
      tipPrintedBook: 'Love the story? Order it as a beautifully printed book — and get your credits back!',
      tipSharing: 'Stories are private by default. Enable sharing to let grandparents and friends read along.',
      tipHistoric: 'Explore history! Your child can experience the moon landing, meet dinosaurs, or discover local Swiss legends.',
      tipLearning: 'Personalized stories inspire children to read — much better than screen time arguments!',
      tipCredits: `Each page costs ${CREDITS_PER_PAGE} credits. A ${EXAMPLE_STORY_PAGES}-page story uses ${EXAMPLE_STORY_CREDITS} credits — you can create stories up to 25 pages, each with its own illustration!`,
      cancelJob: 'Cancel Generation',
      cancelling: 'Cancelling...',
      continueInBackground: 'Continue in Background',
    },
    de: {
      title: 'Geschichte wird erstellt!',
      hourTitle: "Deine Geschichte braucht etwa eine Stunde.",
      hourBody: "Du kannst diese Seite verlassen. Wir schicken dir eine E-Mail, sobald sie fertig ist.",
      tipCharacters: 'Kinder lernen am besten, wenn sie sich selbst in der Geschichte sehen. Das ist die Magie personalisierter Bücher!',
      tipStoryPlot: 'Du kannst jeden Text bearbeiten und jedes Bild neu generieren — mach die Geschichte perfekt!',
      tipLocations: 'Wir verwenden echte Fotos deiner Heimat-Sehenswürdigkeiten in den Illustrationen — wähle deinen Ort für eine persönliche Note.',
      tipArtStyle: 'Probiere verschiedene Kunststile! Aquarell für Bilderbücher, Ölgemälde für ältere Kinder, Comic für lustige Abenteuer.',
      tipPrintedBook: 'Gefällt dir die Geschichte? Bestelle sie als wunderschön gedrucktes Buch — und erhalte deine Credits zurück!',
      tipSharing: 'Geschichten sind standardmässig privat. Aktiviere das Teilen, damit Grosseltern und Freunde mitlesen können.',
      tipHistoric: 'Entdecke Geschichte! Dein Kind kann die Mondlandung erleben, Dinosaurier treffen oder lokale Schweizer Sagen entdecken.',
      tipLearning: 'Personalisierte Geschichten motivieren Kinder zum Lesen — viel besser als Diskussionen über Bildschirmzeit!',
      tipCredits: `Jede Seite kostet ${CREDITS_PER_PAGE} Credits. Eine ${EXAMPLE_STORY_PAGES}-Seiten-Geschichte braucht ${EXAMPLE_STORY_CREDITS} Credits — du kannst Geschichten bis zu 25 Seiten erstellen, jede mit eigener Illustration!`,
      cancelJob: 'Generierung abbrechen',
      cancelling: 'Wird abgebrochen...',
      continueInBackground: 'Im Hintergrund fortsetzen',
    },
    fr: {
      title: 'Création de votre histoire!',
      hourTitle: "Votre histoire prend environ une heure.",
      hourBody: "Vous pouvez quitter cette page. Nous vous enverrons un e-mail dès qu'elle sera prête.",
      tipCharacters: 'Les enfants apprennent mieux quand ils se voient dans l\'histoire. C\'est la magie des livres personnalisés !',
      tipStoryPlot: 'Vous pouvez modifier chaque texte et regénérer chaque image après la création — rendez-la parfaite !',
      tipLocations: 'Nous incluons de vraies photos de vos monuments locaux dans les illustrations — choisissez votre lieu pour une touche personnelle.',
      tipArtStyle: 'Essayez différents styles ! Aquarelle pour les albums, peinture à l\'huile pour les plus grands, BD pour les aventures amusantes.',
      tipPrintedBook: 'Vous aimez l\'histoire ? Commandez-la en livre imprimé — et récupérez vos crédits !',
      tipSharing: 'Les histoires sont privées par défaut. Activez le partage pour que les grands-parents et amis puissent lire.',
      tipHistoric: 'Explorez l\'histoire ! Votre enfant peut vivre l\'alunissage, rencontrer des dinosaures ou découvrir des légendes locales.',
      tipLearning: 'Les histoires personnalisées inspirent les enfants à lire — bien mieux que les disputes sur le temps d\'écran !',
      tipCredits: `Chaque page coûte ${CREDITS_PER_PAGE} crédits. Une histoire de ${EXAMPLE_STORY_PAGES} pages utilise ${EXAMPLE_STORY_CREDITS} crédits — vous pouvez créer des histoires jusqu'à 25 pages, chacune avec sa propre illustration !`,
      cancelJob: 'Annuler la génération',
      cancelling: 'Annulation...',
      continueInBackground: 'Continuer en arrière-plan',
    },
    it: {
      title: 'Stiamo creando la tua storia!',
      hourTitle: "La tua storia richiede circa un'ora.",
      hourBody: "Puoi lasciare questa pagina. Ti mandiamo un'e-mail appena è pronta.",
      tipCharacters: 'I bambini imparano meglio quando si vedono nella storia. È la magia dei libri personalizzati!',
      tipStoryPlot: 'Puoi modificare ogni testo e rigenerare ogni immagine — rendi la storia perfetta!',
      tipLocations: 'Usiamo foto reali dei monumenti della tua zona nelle illustrazioni — scegli il tuo luogo per un tocco personale.',
      tipArtStyle: 'Prova stili diversi! Acquerello per i libri illustrati, pittura a olio per i più grandi, fumetto per le avventure divertenti.',
      tipPrintedBook: 'Ti piace la storia? Ordinala come libro stampato — e riavrai i tuoi crediti!',
      tipSharing: 'Le storie sono private di default. Attiva la condivisione perché nonni e amici possano leggerla.',
      tipHistoric: 'Scopri la storia! Tuo figlio può vivere lo sbarco sulla Luna, incontrare i dinosauri o scoprire leggende svizzere locali.',
      tipLearning: 'Le storie personalizzate invogliano i bambini a leggere — molto meglio delle discussioni sullo schermo!',
      tipCredits: `Ogni pagina costa ${CREDITS_PER_PAGE} crediti. Una storia di ${EXAMPLE_STORY_PAGES} pagine usa ${EXAMPLE_STORY_CREDITS} crediti — puoi creare storie fino a 25 pagine, ognuna con la sua illustrazione!`,
      cancelJob: 'Annulla generazione',
      cancelling: 'Annullamento...',
      continueInBackground: 'Continua in background',
    },
  };

  const t = translations[language as keyof typeof translations] || translations.en;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full p-6 md:p-8 max-w-md">
        <div className="text-center mb-6">
          <div className="relative inline-block mb-3">
            <Loader2 size={48} className="animate-spin text-indigo-500" />
            <span className="absolute -top-1 -right-1 text-xl">✨</span>
          </div>
          <h2 className="text-xl md:text-2xl font-bold text-gray-800">{t.title}</h2>
          {/* The hour message, settled: a small standing note under the spinner. */}
          {hourNoteSettled && (
            <p className="mt-2 text-xs text-gray-500 flex items-start justify-center gap-1.5">
              <Mail className="w-3.5 h-3.5 shrink-0 mt-px" />
              <span>{t.hourTitle} {t.hourBody}</span>
            </p>
          )}
        </div>

        {/* The hour message, first seconds: prominent, before anything else. */}
        {!hourNoteSettled && (
          <div className="mb-6 min-h-[220px] flex items-center justify-center">
            <div className="flex items-start gap-3 bg-indigo-50 border border-indigo-200 rounded-xl p-5 max-w-sm animate-fade-in">
              <Clock size={24} className="text-indigo-600 shrink-0 mt-0.5" />
              <div>
                <p className="text-base font-semibold text-gray-900 mb-1">{t.hourTitle}</p>
                <p className="text-sm text-gray-700">{t.hourBody}</p>
              </div>
            </div>
          </div>
        )}

        {/* Rotating tips and character avatars */}
        {hourNoteSettled && rotationItems.length > 0 && (
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
                return (
                  <div className="flex items-start gap-3 bg-gradient-to-r from-indigo-50 to-indigo-50 rounded-xl p-4 max-w-sm animate-fade-in">
                    <CheckCircle size={20} className="text-indigo-500 shrink-0" />
                    <p className="text-sm text-gray-700">{messageText}</p>
                  </div>
                );
              }
              return null; // Fallback while character display is being computed
            })()}
          </div>
        )}

        {/* Progress bar */}
        <div className="mb-4">
          <ProgressBar
            value={isDone ? 100 : displayProgress}
            max={100}
            showPercentage
            size="lg"
          />
        </div>

        {/* Continue in background — solid indigo CTA, outranks the info box
            below so users see the action they can take, not just the message. */}
        {onMinimize && (
          <button
            onClick={onMinimize}
            className="w-full mb-3 px-4 py-3 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg font-semibold transition-colors text-base shadow-sm"
          >
            {t.continueInBackground}
          </button>
        )}

        {/* Admin-only cancel — muted, kept small and at the bottom so it
            doesn't compete with the calm user-facing wait flow. */}
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
            className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs text-gray-500 hover:text-gray-700 transition-colors disabled:opacity-50"
          >
            {isCancelling ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <XCircle size={13} />
            )}
            {isCancelling ? t.cancelling : t.cancelJob} (admin)
          </button>
        )}

      </div>
    </div>
  );
}

export default GenerationProgress;
