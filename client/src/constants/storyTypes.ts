import type { StoryType, StoryCategory, LifeChallenge, EducationalTopic, LifeChallengeGroup, EducationalGroup, AdventureThemeGroup, AdventureThemeGroupId } from '@/types/story';

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
    name: { en: 'Life Skills', de: 'Lebensthemen', fr: 'Compétences de vie' },
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
  }
];

// =============================================================================
// ADVENTURE THEMES (Setting/Wrapper) - Grouped
// =============================================================================
export const adventureThemeGroups: AdventureThemeGroup[] = [
  { id: 'historical', name: { en: 'Historical Times', de: 'Historische Zeiten', fr: 'Époques historiques' } },
  { id: 'fantasy', name: { en: 'Fantasy & Magic', de: 'Fantasie & Magie', fr: 'Fantaisie & Magie' } },
  { id: 'locations', name: { en: 'Exploration', de: 'Entdeckung', fr: 'Exploration' } },
  { id: 'professions', name: { en: 'Heroes & Helpers', de: 'Helden & Helfer', fr: 'Héros & Aides' } },
  { id: 'seasonal', name: { en: 'Seasonal', de: 'Jahreszeiten', fr: 'Saisonnier' } },
  { id: 'custom', name: { en: 'Custom', de: 'Eigenes Thema', fr: 'Personnalisé' } },
];

export const storyTypes: StoryType[] = [
  // Historical Times (pirates, knights & princess, wild west, ninja)
  { id: 'pirate', name: { en: 'Pirate Adventure', de: 'Piraten-Abenteuer', fr: 'Aventure de Pirates' }, emoji: '🏴‍☠️', group: 'historical' },
  { id: 'knight', name: { en: 'Knights & Princess', de: 'Ritter & Prinzessin', fr: 'Chevaliers & Princesse' }, emoji: '⚔️', group: 'historical' },
  { id: 'cowboy', name: { en: 'Wild West', de: 'Wilder Westen', fr: 'Far West' }, emoji: '🤠', group: 'historical' },
  { id: 'ninja', name: { en: 'Secret Ninja', de: 'Geheimer Ninja', fr: 'Ninja Secret' }, emoji: '🥷', group: 'historical' },

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

  // Heroes & Helpers / Professions (firefighter, doctor, police)
  { id: 'fireman', name: { en: 'Brave Firefighter', de: 'Tapferer Feuerwehrmann', fr: 'Pompier Courageux' }, emoji: '🚒', group: 'professions' },
  { id: 'doctor', name: { en: 'Helpful Doctor', de: 'Hilfreicher Arzt', fr: 'Docteur Serviable' }, emoji: '👨‍⚕️', group: 'professions' },
  { id: 'police', name: { en: 'Police Officer', de: 'Polizist', fr: 'Policier' }, emoji: '👮', group: 'professions' },

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

export const lifeChallengeGroups: LifeChallengeGroup[] = [
  { id: 'toddler', name: { en: 'Toddler (2-4)', de: 'Kleinkind (2-4)', fr: 'Tout-petit (2-4)' }, ageRange: '2-4' },
  { id: 'preschool', name: { en: 'Preschool (4-6)', de: 'Vorschule (4-6)', fr: 'Préscolaire (4-6)' }, ageRange: '4-6' },
  { id: 'early-school', name: { en: 'Early School (6-9)', de: 'Grundschule (6-9)', fr: 'École primaire (6-9)' }, ageRange: '6-9' },
  { id: 'family', name: { en: 'Family Changes', de: 'Familien-Veränderungen', fr: 'Changements familiaux' }, ageRange: 'all' },
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

export const educationalGroups: EducationalGroup[] = [
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
// HELPER FUNCTIONS
// =============================================================================

export function getStoryTypesByGroup(groupId: AdventureThemeGroupId): StoryType[] {
  return storyTypes.filter(t => t.group === groupId);
}

export function getLifeChallengesByGroup(groupId: string): LifeChallenge[] {
  return lifeChallenges.filter(c => c.ageGroup === groupId);
}

export function getEducationalTopicsByGroup(groupId: string): EducationalTopic[] {
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
