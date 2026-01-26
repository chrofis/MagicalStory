import type { StoryType, StoryCategory, LifeChallenge, EducationalTopic, LifeChallengeGroup, EducationalGroup, AdventureThemeGroup, AdventureThemeGroupId, HistoricalEvent, HistoricalEventGroup } from '@/types/story';

// =============================================================================
// STORY CATEGORIES
// =============================================================================
export const storyCategories: StoryCategory[] = [
  {
    id: 'adventure',
    name: { en: 'Adventure', de: 'Abenteuer', fr: 'Aventure' },
    description: {
      en: 'Exciting journeys and heroic quests',
      de: 'Spannende Reisen und heldenhafte Abenteuer',
      fr: 'Voyages passionnants et quêtes héroïques'
    },
    emoji: '🗡️'
  },
  {
    id: 'life-challenge',
    name: { en: 'Life Skills', de: 'Lebenskompetenzen', fr: 'Compétences de vie' },
    description: {
      en: 'Help overcome everyday challenges',
      de: 'Hilfe bei alltäglichen Herausforderungen',
      fr: 'Aide pour surmonter les défis quotidiens'
    },
    emoji: '💪'
  },
  {
    id: 'educational',
    name: { en: 'Learning', de: 'Lernen', fr: 'Apprentissage' },
    description: {
      en: 'Fun stories that teach something new',
      de: 'Lustige Geschichten, die etwas Neues lehren',
      fr: 'Histoires amusantes qui enseignent quelque chose de nouveau'
    },
    emoji: '📚'
  },
  {
    id: 'historical',
    name: { en: 'History', de: 'Geschichte', fr: 'Histoire' },
    description: {
      en: 'Experience real historical events',
      de: 'Erlebe echte historische Ereignisse',
      fr: 'Vivez de vrais événements historiques'
    },
    emoji: '🏛️'
  },
  {
    id: 'custom',
    name: { en: 'Create Your Own', de: 'Eigenes Thema', fr: 'Créer le vôtre' },
    description: {
      en: 'Describe your own unique story idea',
      de: 'Beschreibe deine eigene Geschichte',
      fr: 'Décris ta propre idée d\'histoire'
    },
    emoji: '✨'
  }
];

// =============================================================================
// ADVENTURE THEMES (Setting/Wrapper) - Grouped
// =============================================================================

// Popular adventure theme IDs (shown in expanded "Popular" section)
export const popularAdventureThemeIds = [
  'pirate', 'knight', 'cowboy', 'ninja', 'wizard', 'dragon', 'superhero', 'detective', 'easter'
];

export const adventureThemeGroups: AdventureThemeGroup[] = [
  { id: 'popular', name: { en: 'Popular', de: 'Beliebt', fr: 'Populaires' } },
  { id: 'historical', name: { en: 'Historical Times', de: 'Historische Zeiten', fr: 'Époques historiques' } },
  { id: 'fantasy', name: { en: 'Fantasy & Magic', de: 'Fantasie & Magie', fr: 'Fantaisie & Magie' } },
  { id: 'locations', name: { en: 'Exploration', de: 'Entdeckung', fr: 'Exploration' } },
  { id: 'professions', name: { en: 'Heroes & Helpers', de: 'Helden & Helfer', fr: 'Héros & Aides' } },
  { id: 'seasonal', name: { en: 'Seasonal', de: 'Jahreszeiten', fr: 'Saisonnier' } },
  { id: 'custom', name: { en: 'Custom', de: 'Eigenes Thema', fr: 'Personnalisé' } },
];

export const storyTypes: StoryType[] = [
  // Historical Times
  { id: 'pirate', name: { en: 'Pirate Adventure', de: 'Piraten-Abenteuer', fr: 'Aventure de Pirates' }, emoji: '🏴‍☠️', group: 'historical' },
  { id: 'knight', name: { en: 'Knights & Princess', de: 'Ritter & Prinzessin', fr: 'Chevaliers & Princesse' }, emoji: '⚔️', group: 'historical' },
  { id: 'cowboy', name: { en: 'Cowboys & Indians', de: 'Cowboys und Indianer', fr: 'Cowboys et Indiens' }, emoji: '🤠', group: 'historical' },
  { id: 'ninja', name: { en: 'Secret Ninja', de: 'Geheimer Ninja', fr: 'Ninja Secret' }, emoji: '🥷', group: 'historical' },
  { id: 'viking', name: { en: 'Viking Adventure', de: 'Wikinger-Abenteuer', fr: 'Aventure Viking' }, emoji: '⚓', group: 'historical' },
  { id: 'roman', name: { en: 'Ancient Rome', de: 'Antikes Rom', fr: 'Rome Antique' }, emoji: '🏛️', group: 'historical' },
  { id: 'egyptian', name: { en: 'Ancient Egypt', de: 'Altes Ägypten', fr: 'Égypte Ancienne' }, emoji: '🏺', group: 'historical' },
  { id: 'greek', name: { en: 'Ancient Greece', de: 'Antikes Griechenland', fr: 'Grèce Antique' }, emoji: '🏺', group: 'historical' },
  { id: 'caveman', name: { en: 'Stone Age', de: 'Steinzeit', fr: 'Âge de Pierre' }, emoji: '🦴', group: 'historical' },
  { id: 'samurai', name: { en: 'Samurai Adventure', de: 'Samurai-Abenteuer', fr: 'Aventure Samouraï' }, emoji: '🎌', group: 'historical' },

  // Fantasy & Magic (wizard & witch combined, dragon, unicorn, mermaid, dinosaur, superhero)
  { id: 'wizard', name: { en: 'Wizard & Witch', de: 'Zauberer & Hexe', fr: 'Sorcier & Sorcière' }, emoji: '🧙', group: 'fantasy' },
  { id: 'dragon', name: { en: 'Dragon Quest', de: 'Drachen-Abenteuer', fr: 'Quête du Dragon' }, emoji: '🐉', group: 'fantasy' },
  { id: 'unicorn', name: { en: 'Magical Unicorn', de: 'Magisches Einhorn', fr: 'Licorne Magique' }, emoji: '🦄', group: 'fantasy' },
  { id: 'mermaid', name: { en: 'Mermaid Adventure', de: 'Meerjungfrauen-Abenteuer', fr: 'Aventure de Sirène' }, emoji: '🧜‍♀️', group: 'fantasy' },
  { id: 'dinosaur', name: { en: 'Dinosaur World', de: 'Dinosaurier-Welt', fr: 'Monde des Dinosaures' }, emoji: '🦖', group: 'fantasy' },
  { id: 'superhero', name: { en: 'Superhero', de: 'Superheld', fr: 'Super-héros' }, emoji: '🦸', group: 'fantasy' },

  // Exploration / Locations (space, ocean, jungle, farm, forest)
  { id: 'space', name: { en: 'Space Explorer', de: 'Weltraum-Entdecker', fr: 'Explorateur Spatial' }, emoji: '🚀', group: 'locations' },
  { id: 'ocean', name: { en: 'Ocean Explorer', de: 'Ozean-Entdecker', fr: 'Explorateur des Océans' }, emoji: '🌊', group: 'locations' },
  { id: 'jungle', name: { en: 'Jungle Safari', de: 'Dschungel-Safari', fr: 'Safari dans la Jungle' }, emoji: '🌴', group: 'locations' },
  { id: 'farm', name: { en: 'Farm Life', de: 'Bauernhof-Leben', fr: 'Vie à la Ferme' }, emoji: '🐄', group: 'locations' },
  { id: 'forest', name: { en: 'Forest Friends', de: 'Waldfreunde', fr: 'Amis de la Forêt' }, emoji: '🦊', group: 'locations' },

  // Heroes & Helpers / Professions (firefighter, doctor, police, detective)
  { id: 'fireman', name: { en: 'Brave Firefighter', de: 'Tapferer Feuerwehrmann', fr: 'Pompier Courageux' }, emoji: '🚒', group: 'professions' },
  { id: 'doctor', name: { en: 'Helpful Doctor', de: 'Hilfreicher Arzt', fr: 'Docteur Serviable' }, emoji: '👨‍⚕️', group: 'professions' },
  { id: 'police', name: { en: 'Police Officer', de: 'Polizist', fr: 'Policier' }, emoji: '👮', group: 'professions' },
  { id: 'detective', name: { en: 'Detective Mystery', de: 'Detektiv-Geheimnis', fr: 'Mystère Détective' }, emoji: '🔍', group: 'professions' },

  // Seasonal (christmas, new year, easter, halloween)
  { id: 'christmas', name: { en: 'Christmas Story', de: 'Weihnachts-Geschichte', fr: 'Histoire de Noël' }, emoji: '🎄', group: 'seasonal' },
  { id: 'newyear', name: { en: 'New Year Story', de: 'Neujahrs-Geschichte', fr: 'Histoire du Nouvel An' }, emoji: '🎆', group: 'seasonal' },
  { id: 'easter', name: { en: 'Easter Story', de: 'Oster-Geschichte', fr: 'Histoire de Pâques' }, emoji: '🐰', group: 'seasonal' },
  { id: 'halloween', name: { en: 'Halloween Story', de: 'Halloween-Geschichte', fr: 'Histoire d\'Halloween' }, emoji: '🎃', group: 'seasonal' },

  // Custom - user creates their own theme
  { id: 'custom', name: { en: 'Create Your Own', de: 'Eigenes Thema', fr: 'Créer le vôtre' }, emoji: '✨', group: 'custom' },
];

// For life challenges and educational stories, this can be used as optional wrapper
export const realisticSetting: StoryType = {
  id: 'realistic',
  name: { en: 'Everyday Life', de: 'Alltag', fr: 'Vie Quotidienne' },
  emoji: '🏠'
};

// =============================================================================
// LIFE CHALLENGES (Grouped by typical age)
// =============================================================================
export const lifeChallenges: LifeChallenge[] = [
  // Toddler (2-4 years)
  { id: 'potty-training', name: { en: 'Potty Training', de: 'Töpfchen-Training', fr: 'Apprentissage du pot' }, emoji: '🚽', ageGroup: 'toddler' },
  { id: 'washing-hands', name: { en: 'Washing Hands', de: 'Hände waschen', fr: 'Se laver les mains' }, emoji: '🧼', ageGroup: 'toddler' },
  { id: 'brushing-teeth', name: { en: 'Brushing Teeth', de: 'Zähne putzen', fr: 'Se brosser les dents' }, emoji: '🪥', ageGroup: 'toddler' },
  { id: 'eating-vegetables', name: { en: 'Eating Vegetables', de: 'Gemüse essen', fr: 'Manger des légumes' }, emoji: '🥦', ageGroup: 'toddler' },
  { id: 'going-to-bed', name: { en: 'Going to Bed', de: 'Ins Bett gehen', fr: 'Aller au lit' }, emoji: '🛏️', ageGroup: 'toddler' },
  { id: 'saying-goodbye', name: { en: 'Saying Goodbye', de: 'Abschied nehmen', fr: 'Dire au revoir' }, emoji: '👋', ageGroup: 'toddler' },
  { id: 'no-pacifier', name: { en: 'No More Pacifier', de: 'Ohne Schnuller', fr: 'Plus de tétine' }, emoji: '🍼', ageGroup: 'toddler' },

  // Preschool (4-6 years)
  { id: 'cleaning-up', name: { en: 'Cleaning Up Toys', de: 'Aufräumen', fr: 'Ranger les jouets' }, emoji: '🧹', ageGroup: 'preschool' },
  { id: 'sitting-still', name: { en: 'Sitting Still', de: 'Still sitzen', fr: 'Rester tranquille' }, emoji: '🪑', ageGroup: 'preschool' },
  { id: 'sharing', name: { en: 'Learning to Share', de: 'Teilen lernen', fr: 'Apprendre à partager' }, emoji: '🤝', ageGroup: 'preschool' },
  { id: 'waiting-turn', name: { en: 'Waiting Your Turn', de: 'Warten können', fr: 'Attendre son tour' }, emoji: '⏳', ageGroup: 'preschool' },
  { id: 'first-kindergarten', name: { en: 'First Day of Kindergarten', de: 'Erster Kindergartentag', fr: 'Premier jour de maternelle' }, emoji: '🎒', ageGroup: 'preschool' },
  { id: 'making-friends', name: { en: 'Making Friends', de: 'Freunde finden', fr: 'Se faire des amis' }, emoji: '👫', ageGroup: 'preschool' },
  { id: 'being-brave', name: { en: 'Being Brave', de: 'Mutig sein', fr: 'Être courageux' }, emoji: '💪', ageGroup: 'preschool' },
  { id: 'new-sibling', name: { en: 'New Baby Sibling', de: 'Neues Geschwisterchen', fr: 'Nouveau bébé dans la famille' }, emoji: '👶', ageGroup: 'preschool' },

  // Early School (6-9 years)
  { id: 'first-school', name: { en: 'First Day of School', de: 'Erster Schultag', fr: 'Premier jour d\'école' }, emoji: '🏫', ageGroup: 'early-school' },
  { id: 'homework', name: { en: 'Doing Homework', de: 'Hausaufgaben machen', fr: 'Faire ses devoirs' }, emoji: '📝', ageGroup: 'early-school' },
  { id: 'reading-alone', name: { en: 'Learning to Read', de: 'Lesen lernen', fr: 'Apprendre à lire' }, emoji: '📖', ageGroup: 'early-school' },
  { id: 'losing-game', name: { en: 'Losing a Game', de: 'Verlieren können', fr: 'Savoir perdre' }, emoji: '🎯', ageGroup: 'early-school' },
  { id: 'being-different', name: { en: 'Being Different is OK', de: 'Anders sein ist OK', fr: 'Être différent c\'est bien' }, emoji: '🌈', ageGroup: 'early-school' },
  { id: 'dealing-bully', name: { en: 'Dealing with Bullies', de: 'Mit Hänseleien umgehen', fr: 'Faire face aux moqueries' }, emoji: '🛡️', ageGroup: 'early-school' },
  { id: 'telling-truth', name: { en: 'Telling the Truth', de: 'Die Wahrheit sagen', fr: 'Dire la vérité' }, emoji: '✅', ageGroup: 'early-school' },
  { id: 'trying-new-things', name: { en: 'Trying New Things', de: 'Neues ausprobieren', fr: 'Essayer de nouvelles choses' }, emoji: '🌟', ageGroup: 'early-school' },

  // Family Changes (All ages)
  { id: 'moving-house', name: { en: 'Moving to a New Home', de: 'Umzug', fr: 'Déménagement' }, emoji: '🏠', ageGroup: 'family' },
  { id: 'going-vacation', name: { en: 'Going on Vacation', de: 'In den Urlaub fahren', fr: 'Partir en vacances' }, emoji: '✈️', ageGroup: 'family' },
  { id: 'parents-splitting', name: { en: 'Parents Living Apart', de: 'Eltern leben getrennt', fr: 'Parents séparés' }, emoji: '💔', ageGroup: 'family' },
  { id: 'visiting-doctor', name: { en: 'Going to the Doctor', de: 'Arztbesuch', fr: 'Visite chez le médecin' }, emoji: '🏥', ageGroup: 'family' },
  { id: 'staying-hospital', name: { en: 'Staying in Hospital', de: 'Im Krankenhaus', fr: 'Séjour à l\'hôpital' }, emoji: '🩺', ageGroup: 'family' },
  { id: 'death-pet', name: { en: 'Losing a Pet', de: 'Haustier verlieren', fr: 'Perte d\'un animal' }, emoji: '🌈', ageGroup: 'family' },
  { id: 'grandparent-sick', name: { en: 'Grandparent is Sick', de: 'Grosseltern sind krank', fr: 'Grand-parent malade' }, emoji: '❤️', ageGroup: 'family' },

  // Pre-Teen (9-12 years)
  { id: 'money-saving', name: { en: 'Saving Money', de: 'Geld sparen', fr: 'Économiser de l\'argent' }, emoji: '💰', ageGroup: 'preteen' },
  { id: 'spending-wisely', name: { en: 'Spending Wisely', de: 'Klug ausgeben', fr: 'Dépenser intelligemment' }, emoji: '🛒', ageGroup: 'preteen' },
  { id: 'screen-time', name: { en: 'Screen Time Balance', de: 'Bildschirmzeit-Balance', fr: 'Équilibre du temps d\'écran' }, emoji: '📱', ageGroup: 'preteen' },
  { id: 'peer-pressure', name: { en: 'Peer Pressure', de: 'Gruppenzwang', fr: 'Pression des pairs' }, emoji: '👥', ageGroup: 'preteen' },
  { id: 'body-changes', name: { en: 'Body Changes', de: 'Körperliche Veränderungen', fr: 'Changements corporels' }, emoji: '🌱', ageGroup: 'preteen' },
  { id: 'responsibility', name: { en: 'Taking Responsibility', de: 'Verantwortung übernehmen', fr: 'Prendre ses responsabilités' }, emoji: '🎯', ageGroup: 'preteen' },
  { id: 'managing-time', name: { en: 'Managing Time', de: 'Zeitmanagement', fr: 'Gestion du temps' }, emoji: '⏰', ageGroup: 'preteen' },
  { id: 'online-safety', name: { en: 'Online Safety', de: 'Sicherheit im Internet', fr: 'Sécurité en ligne' }, emoji: '🔒', ageGroup: 'preteen' },
];

// Popular life challenge IDs (shown in expanded "Popular" section)
export const popularLifeChallengeIds = [
  'going-to-bed', 'cleaning-up', 'first-kindergarten', 'first-school',
  'losing-game', 'dealing-bully', 'telling-truth', 'spending-wisely',
  'moving-house', 'screen-time'
];

export const lifeChallengeGroups: LifeChallengeGroup[] = [
  { id: 'popular', name: { en: 'Popular', de: 'Beliebt', fr: 'Populaires' }, ageRange: 'all' },
  { id: 'family', name: { en: 'Family Changes', de: 'Familien-Veränderungen', fr: 'Changements familiaux' }, ageRange: 'all' },
  { id: 'toddler', name: { en: 'Toddler (2-4)', de: 'Kleinkind (2-4)', fr: 'Tout-petit (2-4)' }, ageRange: '2-4' },
  { id: 'preschool', name: { en: 'Preschool (4-6)', de: 'Vorschule (4-6)', fr: 'Préscolaire (4-6)' }, ageRange: '4-6' },
  { id: 'early-school', name: { en: 'Early School (6-9)', de: 'Grundschule (6-9)', fr: 'École primaire (6-9)' }, ageRange: '6-9' },
  { id: 'preteen', name: { en: 'Pre-Teen (9-12)', de: 'Vorpubertät (9-12)', fr: 'Préadolescent (9-12)' }, ageRange: '9-12' },
];

// =============================================================================
// EDUCATIONAL TOPICS
// =============================================================================
export const educationalTopics: EducationalTopic[] = [
  // Letters & Reading
  { id: 'alphabet', name: { en: 'The Alphabet (ABC)', de: 'Das Alphabet (ABC)', fr: 'L\'Alphabet (ABC)' }, emoji: '🔤', group: 'letters' },
  { id: 'vowels', name: { en: 'Vowels (A, E, I, O, U)', de: 'Vokale (A, E, I, O, U)', fr: 'Voyelles (A, E, I, O, U)' }, emoji: '🅰️', group: 'letters' },
  { id: 'rhyming', name: { en: 'Rhyming Words', de: 'Reimwörter', fr: 'Mots qui riment' }, emoji: '🎵', group: 'letters' },

  // Numbers & Math
  { id: 'numbers-1-10', name: { en: 'Numbers 1-10', de: 'Zahlen 1-10', fr: 'Nombres 1-10' }, emoji: '🔢', group: 'numbers' },
  { id: 'numbers-1-20', name: { en: 'Numbers 1-20', de: 'Zahlen 1-20', fr: 'Nombres 1-20' }, emoji: '🔢', group: 'numbers' },
  { id: 'counting', name: { en: 'Learning to Count', de: 'Zählen lernen', fr: 'Apprendre à compter' }, emoji: '✋', group: 'numbers' },
  { id: 'shapes', name: { en: 'Shapes', de: 'Formen', fr: 'Formes' }, emoji: '🔷', group: 'numbers' },
  { id: 'addition', name: { en: 'Simple Addition', de: 'Einfaches Addieren', fr: 'Addition simple' }, emoji: '➕', group: 'numbers' },

  // Colors
  { id: 'colors-basic', name: { en: 'Basic Colors', de: 'Grundfarben', fr: 'Couleurs de base' }, emoji: '🌈', group: 'colors' },
  { id: 'colors-mixing', name: { en: 'Mixing Colors', de: 'Farben mischen', fr: 'Mélanger les couleurs' }, emoji: '🎨', group: 'colors' },

  // Nature & Science
  { id: 'planets', name: { en: 'Planets & Space', de: 'Planeten & Weltraum', fr: 'Planètes & Espace' }, emoji: '🪐', group: 'science' },
  { id: 'seasons', name: { en: 'The Four Seasons', de: 'Die vier Jahreszeiten', fr: 'Les quatre saisons' }, emoji: '🍂', group: 'science' },
  { id: 'weather', name: { en: 'Weather', de: 'Wetter', fr: 'Météo' }, emoji: '⛅', group: 'science' },
  { id: 'water-cycle', name: { en: 'Water Cycle', de: 'Wasserkreislauf', fr: 'Cycle de l\'eau' }, emoji: '💧', group: 'science' },
  { id: 'plants-grow', name: { en: 'How Plants Grow', de: 'Wie Pflanzen wachsen', fr: 'Comment poussent les plantes' }, emoji: '🌱', group: 'science' },
  { id: 'day-night', name: { en: 'Day and Night', de: 'Tag und Nacht', fr: 'Jour et nuit' }, emoji: '🌙', group: 'science' },

  // Animals
  { id: 'farm-animals', name: { en: 'Farm Animals', de: 'Bauernhoftiere', fr: 'Animaux de la ferme' }, emoji: '🐷', group: 'animals' },
  { id: 'wild-animals', name: { en: 'Wild Animals', de: 'Wilde Tiere', fr: 'Animaux sauvages' }, emoji: '🦁', group: 'animals' },
  { id: 'ocean-animals', name: { en: 'Ocean Animals', de: 'Meerestiere', fr: 'Animaux marins' }, emoji: '🐋', group: 'animals' },
  { id: 'insects', name: { en: 'Insects & Bugs', de: 'Insekten & Käfer', fr: 'Insectes' }, emoji: '🐛', group: 'animals' },
  { id: 'dinosaurs', name: { en: 'Dinosaurs', de: 'Dinosaurier', fr: 'Dinosaures' }, emoji: '🦕', group: 'animals' },

  // Body & Health
  { id: 'body-parts', name: { en: 'Body Parts', de: 'Körperteile', fr: 'Parties du corps' }, emoji: '🫀', group: 'body' },
  { id: 'five-senses', name: { en: 'The Five Senses', de: 'Die fünf Sinne', fr: 'Les cinq sens' }, emoji: '👁️', group: 'body' },
  { id: 'healthy-eating', name: { en: 'Healthy Eating', de: 'Gesund essen', fr: 'Manger sainement' }, emoji: '🥗', group: 'body' },

  // Time & Calendar
  { id: 'days-week', name: { en: 'Days of the Week', de: 'Wochentage', fr: 'Jours de la semaine' }, emoji: '📅', group: 'time' },
  { id: 'months-year', name: { en: 'Months of the Year', de: 'Monate des Jahres', fr: 'Mois de l\'année' }, emoji: '🗓️', group: 'time' },
  { id: 'telling-time', name: { en: 'Telling Time', de: 'Uhr lesen', fr: 'Lire l\'heure' }, emoji: '🕐', group: 'time' },

  // World & Geography
  { id: 'continents', name: { en: 'Continents', de: 'Kontinente', fr: 'Continents' }, emoji: '🌍', group: 'geography' },
  { id: 'countries-flags', name: { en: 'Countries & Flags', de: 'Länder & Flaggen', fr: 'Pays & Drapeaux' }, emoji: '🏳️', group: 'geography' },

  // Music & Art
  { id: 'instruments', name: { en: 'Musical Instruments', de: 'Musikinstrumente', fr: 'Instruments de musique' }, emoji: '🎸', group: 'arts' },
  { id: 'famous-artists', name: { en: 'Famous Artists', de: 'Berühmte Künstler', fr: 'Artistes célèbres' }, emoji: '🖼️', group: 'arts' },
];

// Popular educational topic IDs (shown in expanded "Popular" section)
export const popularEducationalTopicIds = [
  'alphabet', 'numbers-1-10', 'rhyming', 'seasons', 'weather',
  'water-cycle', 'farm-animals', 'five-senses', 'days-week', 'months-year'
];

export const educationalGroups: EducationalGroup[] = [
  { id: 'popular', name: { en: 'Popular', de: 'Beliebt', fr: 'Populaires' } },
  { id: 'letters', name: { en: 'Letters & Reading', de: 'Buchstaben & Lesen', fr: 'Lettres & Lecture' } },
  { id: 'numbers', name: { en: 'Numbers & Math', de: 'Zahlen & Mathe', fr: 'Nombres & Maths' } },
  { id: 'colors', name: { en: 'Colors', de: 'Farben', fr: 'Couleurs' } },
  { id: 'science', name: { en: 'Nature & Science', de: 'Natur & Wissenschaft', fr: 'Nature & Science' } },
  { id: 'animals', name: { en: 'Animals', de: 'Tiere', fr: 'Animaux' } },
  { id: 'body', name: { en: 'Body & Health', de: 'Körper & Gesundheit', fr: 'Corps & Santé' } },
  { id: 'time', name: { en: 'Time & Calendar', de: 'Zeit & Kalender', fr: 'Temps & Calendrier' } },
  { id: 'geography', name: { en: 'World & Geography', de: 'Welt & Geografie', fr: 'Monde & Géographie' } },
  { id: 'arts', name: { en: 'Music & Art', de: 'Musik & Kunst', fr: 'Musique & Art' } },
];

// =============================================================================
// HISTORICAL EVENTS (for historically accurate story generation)
// =============================================================================
// Popular historical event IDs (shown in expanded "Popular" section)
export const popularHistoricalEventIds = [
  'wilhelm-tell', 'gotthard-tunnel', 'moon-landing', 'columbus-voyage',
  'wright-brothers', 'lindbergh-flight', 'galapagos-darwin', 'berlin-wall-fall', 'golden-gate'
];

export const historicalEventGroups: HistoricalEventGroup[] = [
  { id: 'popular', name: { en: 'Popular', de: 'Beliebt', fr: 'Populaires' }, icon: '⭐' },
  { id: 'swiss', name: { en: 'Swiss History', de: 'Schweizer Geschichte', fr: 'Histoire Suisse' }, icon: '🇨🇭' },
  { id: 'exploration', name: { en: 'Exploration & Discovery', de: 'Entdeckungen', fr: 'Exploration & Découverte' }, icon: '🧭' },
  { id: 'science', name: { en: 'Science & Medicine', de: 'Wissenschaft & Medizin', fr: 'Science & Médecine' }, icon: '🔬' },
  { id: 'invention', name: { en: 'Inventions', de: 'Erfindungen', fr: 'Inventions' }, icon: '💡' },
  { id: 'rights', name: { en: 'Human Rights & Freedom', de: 'Menschenrechte & Freiheit', fr: 'Droits humains & Liberté' }, icon: '✊' },
  { id: 'construction', name: { en: 'Great Constructions', de: 'Grosse Bauwerke', fr: 'Grandes Constructions' }, icon: '🏗️' },
  { id: 'culture', name: { en: 'Culture & Arts', de: 'Kultur & Kunst', fr: 'Culture & Arts' }, icon: '🎭' },
  { id: 'archaeology', name: { en: 'Archaeological Discoveries', de: 'Archäologische Entdeckungen', fr: 'Découvertes Archéologiques' }, icon: '🏺' },
];

export const historicalEvents: HistoricalEvent[] = [
  // Swiss History
  { id: 'swiss-founding', name: { en: 'Founding of Switzerland (Rütlischwur)', de: 'Gründung der Schweiz (Rütlischwur)', fr: 'Fondation de la Suisse (Serment du Grütli)' }, shortName: { en: 'Rütlischwur', de: 'Rütlischwur', fr: 'Serment du Grütli' }, emoji: '🤝', year: 1291, category: 'swiss' },
  { id: 'wilhelm-tell', name: { en: 'Wilhelm Tell and the Apple', de: 'Wilhelm Tell und der Apfel', fr: 'Guillaume Tell et la pomme' }, shortName: { en: 'Wilhelm Tell', de: 'Wilhelm Tell', fr: 'Guillaume Tell' }, emoji: '🏹', year: 1307, category: 'swiss', mainPerson: 'Wilhelm Tell' },
  { id: 'battle-morgarten', name: { en: 'Battle of Morgarten', de: 'Schlacht am Morgarten', fr: 'Bataille de Morgarten' }, shortName: { en: 'Morgarten', de: 'Morgarten', fr: 'Morgarten' }, emoji: '⚔️', year: 1315, category: 'swiss' },
  { id: 'battle-sempach', name: { en: 'Battle of Sempach (Winkelried)', de: 'Schlacht bei Sempach (Winkelried)', fr: 'Bataille de Sempach (Winkelried)' }, shortName: { en: 'Sempach', de: 'Sempach', fr: 'Sempach' }, emoji: '🛡️', year: 1386, category: 'swiss', mainPerson: 'Arnold von Winkelried' },
  { id: 'swiss-reformation', name: { en: 'Swiss Reformation (Zwingli)', de: 'Schweizer Reformation (Zwingli)', fr: 'Réforme Suisse (Zwingli)' }, shortName: { en: 'Reformation', de: 'Reformation', fr: 'Réforme' }, emoji: '📜', year: 1523, category: 'swiss', mainPerson: 'Huldrych Zwingli' },
  { id: 'red-cross-founding', name: { en: 'Henry Dunant Founds the Red Cross', de: 'Henry Dunant gründet das Rote Kreuz', fr: 'Henry Dunant fonde la Croix-Rouge' }, shortName: { en: 'Red Cross', de: 'Rotes Kreuz', fr: 'Croix-Rouge' }, emoji: '❤️', year: 1863, category: 'swiss', mainPerson: 'Henry Dunant' },
  { id: 'general-dufour', name: { en: 'General Dufour and Swiss Unity', de: 'General Dufour und die Schweizer Einheit', fr: 'Général Dufour et l\'unité suisse' }, shortName: { en: 'General Dufour', de: 'General Dufour', fr: 'Général Dufour' }, emoji: '🎖️', year: 1847, category: 'swiss', mainPerson: 'Guillaume-Henri Dufour' },
  { id: 'sonderbund-war', name: { en: 'The Sonderbund War', de: 'Der Sonderbundskrieg', fr: 'La Guerre du Sonderbund' }, shortName: { en: 'Sonderbund', de: 'Sonderbund', fr: 'Sonderbund' }, emoji: '🏔️', year: 1847, category: 'swiss' },
  { id: 'swiss-constitution', name: { en: 'Swiss Federal Constitution', de: 'Schweizerische Bundesverfassung', fr: 'Constitution fédérale suisse' }, shortName: { en: 'Constitution', de: 'Bundesverfassung', fr: 'Constitution' }, emoji: '📋', year: 1848, category: 'swiss' },
  { id: 'gotthard-tunnel', name: { en: 'Building the Gotthard Tunnel', de: 'Bau des Gotthardtunnels', fr: 'Construction du tunnel du Gothard' }, shortName: { en: 'Gotthard Tunnel', de: 'Gotthardtunnel Bau', fr: 'Tunnel du Gothard' }, emoji: '🚂', year: 1882, category: 'swiss' },
  { id: 'swiss-ww1-neutrality', name: { en: 'Swiss Neutrality in WWI', de: 'Schweizer Neutralität im 1. Weltkrieg', fr: 'Neutralité suisse pendant la Première Guerre' }, shortName: { en: 'WWI Neutrality', de: 'Neutralität 1. WK', fr: 'Neutralité 1GM' }, emoji: '🕊️', year: 1914, category: 'swiss' },
  { id: 'general-guisan', name: { en: 'General Guisan and the Rütli Report', de: 'General Guisan und der Rütlirapport', fr: 'Général Guisan et le Rapport du Grütli' }, shortName: { en: 'General Guisan', de: 'General Guisan', fr: 'Général Guisan' }, emoji: '🎖️', year: 1940, category: 'swiss', mainPerson: 'Henri Guisan' },
  { id: 'swiss-ww2-neutrality', name: { en: 'Switzerland in World War II', de: 'Die Schweiz im 2. Weltkrieg', fr: 'La Suisse pendant la Seconde Guerre' }, shortName: { en: 'WWII', de: '2. Weltkrieg', fr: '2ème GM' }, emoji: '🏔️', year: 1939, category: 'swiss' },
  { id: 'swiss-womens-vote', name: { en: 'Swiss Women Win the Vote', de: 'Schweizer Frauenstimmrecht', fr: 'Droit de vote des femmes suisses' }, shortName: { en: 'Women\'s Vote', de: 'Frauenstimmrecht', fr: 'Vote des femmes' }, emoji: '🗳️', year: 1971, category: 'swiss' },

  // Exploration & Discovery
  { id: 'moon-landing', name: { en: 'First Moon Landing', de: 'Erste Mondlandung', fr: 'Premier pas sur la Lune' }, shortName: { en: 'Moon Landing', de: 'Mondlandung', fr: 'Alunissage' }, emoji: '🌙', year: 1969, category: 'exploration', mainPerson: 'Neil Armstrong' },
  { id: 'columbus-voyage', name: { en: 'Columbus Reaches the Americas', de: 'Kolumbus erreicht Amerika', fr: 'Colomb atteint les Amériques' }, shortName: { en: 'Discovery of America', de: 'Entdeckung Amerikas', fr: 'Découverte de l\'Amérique' }, emoji: '⛵', year: 1492, category: 'exploration', mainPerson: 'Christopher Columbus' },
  { id: 'wright-brothers', name: { en: 'First Powered Flight', de: 'Erster Motorflug', fr: 'Premier vol motorisé' }, shortName: { en: 'First Flight', de: 'Erster Flug', fr: 'Premier vol' }, emoji: '✈️', year: 1903, category: 'exploration', mainPerson: 'Wright Brothers' },
  { id: 'lindbergh-flight', name: { en: 'First Solo Atlantic Crossing', de: 'Erster Atlantik-Soloflug', fr: 'Première traversée solitaire' }, shortName: { en: 'Atlantic Flight', de: 'Atlantikflug', fr: 'Vol Atlantique' }, emoji: '🛩️', year: 1927, category: 'exploration', mainPerson: 'Charles Lindbergh' },
  { id: 'everest-summit', name: { en: 'First Everest Summit', de: 'Erste Everest-Besteigung', fr: 'Premier sommet de l\'Everest' }, shortName: { en: 'Climbing Everest', de: 'Everest-Besteigung', fr: 'Ascension Everest' }, emoji: '🏔️', year: 1953, category: 'exploration', mainPerson: 'Edmund Hillary & Tenzing Norgay' },
  { id: 'south-pole', name: { en: 'First to the South Pole', de: 'Erster am Südpol', fr: 'Premier au Pôle Sud' }, shortName: { en: 'South Pole', de: 'Südpol', fr: 'Pôle Sud' }, emoji: '❄️', year: 1911, category: 'exploration', mainPerson: 'Roald Amundsen' },
  { id: 'magellan-circumnavigation', name: { en: 'First Circumnavigation', de: 'Erste Weltumsegelung', fr: 'Premier tour du monde' }, shortName: { en: 'Around the World', de: 'Weltumsegelung', fr: 'Tour du monde' }, emoji: '🌍', year: 1522, category: 'exploration', mainPerson: 'Ferdinand Magellan' },
  { id: 'mariana-trench', name: { en: 'Deepest Ocean Dive', de: 'Tiefster Meerstauchgang', fr: 'Plongée la plus profonde' }, shortName: { en: 'Deep Sea Dive', de: 'Tiefseetauchen', fr: 'Plongée profonde' }, emoji: '🌊', year: 1960, category: 'exploration', mainPerson: 'Jacques Piccard' },

  // Science & Medicine
  { id: 'electricity-discovery', name: { en: 'Franklin\'s Kite Experiment', de: 'Franklins Drachenexperiment', fr: 'Expérience du cerf-volant' }, shortName: { en: 'Electricity Discovery', de: 'Elektrizität entdeckt', fr: 'Découverte électricité' }, emoji: '⚡', year: 1752, category: 'science', mainPerson: 'Benjamin Franklin' },
  { id: 'penicillin', name: { en: 'Discovery of Penicillin', de: 'Entdeckung des Penicillins', fr: 'Découverte de la pénicilline' }, shortName: { en: 'Penicillin', de: 'Penicillin', fr: 'Pénicilline' }, emoji: '💊', year: 1928, category: 'science', mainPerson: 'Alexander Fleming' },
  { id: 'vaccine-discovery', name: { en: 'First Vaccine', de: 'Erste Impfung', fr: 'Premier vaccin' }, shortName: { en: 'First Vaccine', de: 'Erste Impfung', fr: 'Premier vaccin' }, emoji: '💉', year: 1796, category: 'science', mainPerson: 'Edward Jenner' },
  { id: 'dna-discovery', name: { en: 'DNA Structure Discovered', de: 'DNA-Struktur entdeckt', fr: 'Structure ADN découverte' }, shortName: { en: 'DNA Discovery', de: 'DNA-Entdeckung', fr: 'Découverte ADN' }, emoji: '🧬', year: 1953, category: 'science', mainPerson: 'Watson & Crick' },
  { id: 'dinosaur-discovery', name: { en: 'First Dinosaur Named', de: 'Erster Dinosaurier benannt', fr: 'Premier dinosaure nommé' }, shortName: { en: 'Dinosaur Discovery', de: 'Dinosaurier-Entdeckung', fr: 'Découverte dinosaure' }, emoji: '🦕', year: 1824, category: 'science', mainPerson: 'William Buckland' },
  { id: 'einstein-relativity', name: { en: 'Einstein\'s Relativity', de: 'Einsteins Relativitätstheorie', fr: 'Relativité d\'Einstein' }, shortName: { en: 'Einstein\'s Theory', de: 'Einsteins Theorie', fr: 'Théorie d\'Einstein' }, emoji: '🧠', year: 1905, category: 'science', mainPerson: 'Albert Einstein' },
  { id: 'galapagos-darwin', name: { en: 'Darwin Visits Galápagos', de: 'Darwin auf Galápagos', fr: 'Darwin aux Galápagos' }, shortName: { en: 'Darwin\'s Voyage', de: 'Darwins Reise', fr: 'Voyage de Darwin' }, emoji: '🐢', year: 1835, category: 'science', mainPerson: 'Charles Darwin' },
  { id: 'first-heart-transplant', name: { en: 'First Heart Transplant', de: 'Erste Herztransplantation', fr: 'Première greffe cardiaque' }, shortName: { en: 'Heart Transplant', de: 'Herztransplantation', fr: 'Greffe cardiaque' }, emoji: '❤️', year: 1967, category: 'science', mainPerson: 'Christiaan Barnard' },
  { id: 'human-genome', name: { en: 'Human Genome Decoded', de: 'Menschliches Genom entschlüsselt', fr: 'Génome humain décodé' }, shortName: { en: 'Genome Project', de: 'Genom-Projekt', fr: 'Projet Génome' }, emoji: '🧪', year: 2003, category: 'science' },
  { id: 'hubble-launch', name: { en: 'Hubble Telescope Launch', de: 'Hubble-Teleskop Start', fr: 'Lancement télescope Hubble' }, shortName: { en: 'Hubble Telescope', de: 'Hubble-Teleskop', fr: 'Télescope Hubble' }, emoji: '🔭', year: 1990, category: 'science' },

  // Inventions
  { id: 'telephone-invention', name: { en: 'First Telephone Call', de: 'Erster Telefonanruf', fr: 'Premier appel téléphonique' }, shortName: { en: 'Telephone', de: 'Telefon', fr: 'Téléphone' }, emoji: '📞', year: 1876, category: 'invention', mainPerson: 'Alexander Graham Bell' },
  { id: 'light-bulb', name: { en: 'Edison\'s Light Bulb', de: 'Edisons Glühbirne', fr: 'Ampoule d\'Edison' }, shortName: { en: 'Light Bulb', de: 'Glühbirne', fr: 'Ampoule' }, emoji: '💡', year: 1879, category: 'invention', mainPerson: 'Thomas Edison' },
  { id: 'printing-press', name: { en: 'Gutenberg\'s Printing Press', de: 'Gutenbergs Buchdruck', fr: 'Presse de Gutenberg' }, shortName: { en: 'Printing Press', de: 'Buchdruck', fr: 'Imprimerie' }, emoji: '📖', year: 1440, category: 'invention', mainPerson: 'Johannes Gutenberg' },
  { id: 'internet-creation', name: { en: 'Birth of the World Wide Web', de: 'Geburt des World Wide Web', fr: 'Naissance du Web' }, shortName: { en: 'The Web', de: 'Das Internet', fr: 'Le Web' }, emoji: '🌐', year: 1991, category: 'invention', mainPerson: 'Tim Berners-Lee' },

  // Human Rights & Freedom
  { id: 'emancipation', name: { en: 'Abolition of Slavery', de: 'Abschaffung der Sklaverei', fr: 'Abolition de l\'esclavage' }, shortName: { en: 'End of Slavery', de: 'Ende der Sklaverei', fr: 'Fin de l\'esclavage' }, emoji: '⛓️', year: 1865, category: 'rights', mainPerson: 'Abraham Lincoln' },
  { id: 'womens-suffrage', name: { en: 'Women Win the Vote', de: 'Frauenwahlrecht', fr: 'Droit de vote des femmes' }, shortName: { en: 'Women\'s Vote', de: 'Frauenwahlrecht', fr: 'Vote des femmes' }, emoji: '🗳️', year: 1920, category: 'rights' },
  { id: 'rosa-parks', name: { en: 'Rosa Parks & Bus Boycott', de: 'Rosa Parks & Busboykott', fr: 'Rosa Parks & Boycott des bus' }, shortName: { en: 'Rosa Parks', de: 'Rosa Parks', fr: 'Rosa Parks' }, emoji: '🚌', year: 1955, category: 'rights', mainPerson: 'Rosa Parks' },
  { id: 'berlin-wall-fall', name: { en: 'Fall of the Berlin Wall', de: 'Fall der Berliner Mauer', fr: 'Chute du mur de Berlin' }, shortName: { en: 'Berlin Wall Fall', de: 'Fall der Berliner Mauer', fr: 'Chute du Mur de Berlin' }, emoji: '🧱', year: 1989, category: 'rights' },
  { id: 'mandela-freedom', name: { en: 'Mandela Released', de: 'Mandela befreit', fr: 'Mandela libéré' }, shortName: { en: 'Mandela Free', de: 'Mandela frei', fr: 'Mandela libre' }, emoji: '✊', year: 1990, category: 'rights', mainPerson: 'Nelson Mandela' },

  // Great Constructions
  { id: 'pyramids', name: { en: 'Building the Great Pyramids', de: 'Bau der Pyramiden', fr: 'Construction des Pyramides' }, shortName: { en: 'The Pyramids', de: 'Die Pyramiden', fr: 'Les Pyramides' }, emoji: '🔺', year: '-2560', category: 'construction' },
  { id: 'eiffel-tower', name: { en: 'Eiffel Tower Opens', de: 'Eiffelturm eröffnet', fr: 'Tour Eiffel inaugurée' }, shortName: { en: 'Eiffel Tower', de: 'Eiffelturm', fr: 'Tour Eiffel' }, emoji: '🗼', year: 1889, category: 'construction', mainPerson: 'Gustave Eiffel' },
  { id: 'panama-canal', name: { en: 'Panama Canal Opens', de: 'Panamakanal eröffnet', fr: 'Canal de Panama inauguré' }, shortName: { en: 'Panama Canal', de: 'Panamakanal', fr: 'Canal de Panama' }, emoji: '🚢', year: 1914, category: 'construction' },
  { id: 'golden-gate', name: { en: 'Building the Golden Gate Bridge', de: 'Bau der Golden Gate Bridge', fr: 'Construction du pont Golden Gate' }, shortName: { en: 'Golden Gate Bridge', de: 'Bau der Golden Gate Bridge', fr: 'Pont Golden Gate' }, emoji: '🌉', year: 1937, category: 'construction' },
  { id: 'channel-tunnel', name: { en: 'Channel Tunnel Opens', de: 'Eurotunnel eröffnet', fr: 'Tunnel sous la Manche' }, shortName: { en: 'Chunnel', de: 'Eurotunnel', fr: 'Eurotunnel' }, emoji: '🚇', year: 1994, category: 'construction' },

  // Culture & Arts
  { id: 'first-olympics', name: { en: 'First Modern Olympics', de: 'Erste moderne Olympiade', fr: 'Premiers Jeux Olympiques modernes' }, shortName: { en: 'Modern Olympics', de: 'Moderne Olympiade', fr: 'Jeux modernes' }, emoji: '🏅', year: 1896, category: 'culture' },
  { id: 'disneyland-opening', name: { en: 'Disneyland Opens', de: 'Disneyland eröffnet', fr: 'Disneyland ouvre' }, shortName: { en: 'Disneyland', de: 'Disneyland', fr: 'Disneyland' }, emoji: '🏰', year: 1955, category: 'culture', mainPerson: 'Walt Disney' },
  { id: 'first-movie', name: { en: 'Birth of Cinema', de: 'Geburt des Kinos', fr: 'Naissance du cinéma' }, shortName: { en: 'First Movies', de: 'Erste Filme', fr: 'Premiers films' }, emoji: '🎬', year: 1895, category: 'culture', mainPerson: 'Lumière Brothers' },
  { id: 'first-zoo', name: { en: 'First Modern Zoo Opens', de: 'Erster moderner Zoo', fr: 'Premier zoo moderne' }, shortName: { en: 'London Zoo', de: 'London Zoo', fr: 'Zoo de Londres' }, emoji: '🦁', year: 1828, category: 'culture' },
  { id: 'natural-history-museum', name: { en: 'Natural History Museum Opens', de: 'Naturhistorisches Museum', fr: 'Musée d\'Histoire Naturelle' }, shortName: { en: 'Natural History Museum', de: 'Naturkundemuseum', fr: 'Musée Histoire Naturelle' }, emoji: '🏛️', year: 1881, category: 'culture' },

  // Archaeological Discoveries
  { id: 'king-tut', name: { en: 'King Tut\'s Tomb Discovered', de: 'Tutanchamuns Grab entdeckt', fr: 'Tombeau de Toutânkhamon' }, shortName: { en: 'King Tut', de: 'Tutanchamun', fr: 'Toutânkhamon' }, emoji: '👑', year: 1922, category: 'archaeology', mainPerson: 'Howard Carter' },
  { id: 'pompeii-discovery', name: { en: 'Rediscovery of Pompeii', de: 'Wiederentdeckung von Pompeji', fr: 'Redécouverte de Pompéi' }, shortName: { en: 'Pompeii', de: 'Pompeji', fr: 'Pompéi' }, emoji: '🌋', year: 1748, category: 'archaeology' },
  { id: 'terracotta-army', name: { en: 'Terracotta Army Discovered', de: 'Terrakotta-Armee entdeckt', fr: 'Armée de terre cuite' }, shortName: { en: 'Terracotta Army', de: 'Terrakotta-Armee', fr: 'Armée terre cuite' }, emoji: '🗿', year: 1974, category: 'archaeology' },
];

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

export function getStoryTypesByGroup(groupId: AdventureThemeGroupId): StoryType[] {
  if (groupId === 'popular') {
    return storyTypes.filter(t => popularAdventureThemeIds.includes(t.id));
  }
  return storyTypes.filter(t => t.group === groupId);
}

export function getLifeChallengesByGroup(groupId: string): LifeChallenge[] {
  if (groupId === 'popular') {
    return lifeChallenges.filter(c => popularLifeChallengeIds.includes(c.id));
  }
  return lifeChallenges.filter(c => c.ageGroup === groupId);
}

export function getEducationalTopicsByGroup(groupId: string): EducationalTopic[] {
  if (groupId === 'popular') {
    return educationalTopics.filter(t => popularEducationalTopicIds.includes(t.id));
  }
  return educationalTopics.filter(t => t.group === groupId);
}

export function getStoryTypeById(id: string): StoryType | undefined {
  if (id === 'realistic') return realisticSetting;
  return storyTypes.find(t => t.id === id);
}

export function getLifeChallengeById(id: string): LifeChallenge | undefined {
  return lifeChallenges.find(c => c.id === id);
}

export function getEducationalTopicById(id: string): EducationalTopic | undefined {
  return educationalTopics.find(t => t.id === id);
}

export function getStoryCategoryById(id: string): StoryCategory | undefined {
  return storyCategories.find(c => c.id === id);
}

export function getHistoricalEventsByGroup(groupId: string): HistoricalEvent[] {
  if (groupId === 'popular') {
    return historicalEvents.filter(e => popularHistoricalEventIds.includes(e.id));
  }
  return historicalEvents.filter(e => e.category === groupId);
}

export function getHistoricalEventById(id: string): HistoricalEvent | undefined {
  return historicalEvents.find(e => e.id === id);
}
