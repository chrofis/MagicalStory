import type { StoryType, StoryCategory, LifeChallenge, EducationalTopic, LifeChallengeGroup, EducationalGroup, AdventureThemeGroup, AdventureThemeGroupId, HistoricalEvent, HistoricalEventGroup } from '@/types/story';

// =============================================================================
// STORY CATEGORIES
// =============================================================================
export const storyCategories: StoryCategory[] = [
  {
    id: 'adventure',
    name: { en: 'Adventure', de: 'Abenteuer', fr: 'Aventure', it: 'Avventura' },
    description: {
      en: 'Exciting journeys and heroic quests',
      de: 'Spannende Reisen und heldenhafte Abenteuer',
      fr: 'Voyages passionnants et quêtes héroïques',
      it: 'Viaggi emozionanti e imprese eroiche'
    },
    emoji: '🗡️'
  },
  {
    id: 'life-challenge',
    name: { en: 'Life Skills', de: 'Lebenskompetenzen', fr: 'Compétences de vie', it: 'Competenze di vita' },
    description: {
      en: 'Help overcome everyday challenges',
      de: 'Hilfe bei alltäglichen Herausforderungen',
      fr: 'Aide pour surmonter les défis quotidiens',
      it: 'Aiuto per superare le sfide quotidiane'
    },
    emoji: '💪'
  },
  {
    id: 'educational',
    name: { en: 'Learning', de: 'Lernen', fr: 'Apprentissage', it: 'Apprendimento' },
    description: {
      en: 'Fun stories that teach something new',
      de: 'Lustige Geschichten, die etwas Neues lehren',
      fr: 'Histoires amusantes qui enseignent quelque chose de nouveau',
      it: 'Storie divertenti che insegnano qualcosa di nuovo'
    },
    emoji: '📚'
  },
  {
    id: 'historical',
    name: { en: 'History', de: 'Geschichte', fr: 'Histoire', it: 'Storia' },
    description: {
      en: 'Experience real historical events',
      de: 'Erlebe echte historische Ereignisse',
      fr: 'Vivez de vrais événements historiques',
      it: 'Vivi eventi storici reali'
    },
    emoji: '🏛️'
  },
  {
    id: 'swiss-stories',
    name: { en: 'Swiss Stories & Legends', de: 'Schweizer Geschichten und Sagen', fr: 'Histoires et Légendes Suisses', it: 'Storie e Leggende Svizzere' },
    description: {
      en: 'Discover stories from Swiss cities, history, and fairy tales',
      de: 'Entdecke Geschichten aus Schweizer Städten, Geschichte und Sagen',
      fr: 'Découvrez des histoires des villes suisses, leur histoire et des contes',
      it: 'Scopri storie di città svizzere, storia e fiabe'
    },
    emoji: '🇨🇭'
  },
  {
    id: 'custom',
    name: { en: 'Create Your Own', de: 'Eigenes Thema', fr: 'Créer le vôtre', it: 'Crea la tua storia' },
    description: {
      en: 'Describe your own unique story idea',
      de: 'Beschreibe deine eigene Geschichte',
      fr: 'Décris ta propre idée d\'histoire',
      it: 'Descrivi la tua idea di storia'
    },
    emoji: '✨'
  }
];

// =============================================================================
// ADVENTURE THEMES (Setting/Wrapper) - Grouped
// =============================================================================

// Popular adventure theme IDs (shown in expanded "Popular" section).
// Easter removed after the 2026 holiday (no point promoting it until March 2027);
// mothers-day and fathers-day featured for the May/June window.
export const popularAdventureThemeIds = [
  'pirate', 'knight', 'cowboy', 'ninja', 'wizard', 'dragon', 'superhero', 'detective', 'mothers-day', 'fathers-day', 'unicorn', 'mermaid', 'roman'
];

export const adventureThemeGroups: AdventureThemeGroup[] = [
  { id: 'popular', name: { en: 'Popular', de: 'Beliebt', fr: 'Populaires', it: 'Popolari' } },
  { id: 'historical', name: { en: 'Historical Times', de: 'Historische Zeiten', fr: 'Époques historiques', it: 'Epoche storiche' } },
  { id: 'fantasy', name: { en: 'Fantasy & Magic', de: 'Fantasie & Magie', fr: 'Fantaisie & Magie', it: 'Fantasia e Magia' } },
  { id: 'locations', name: { en: 'Exploration', de: 'Entdeckung', fr: 'Exploration', it: 'Esplorazione' } },
  { id: 'professions', name: { en: 'Heroes & Helpers', de: 'Helden & Helfer', fr: 'Héros & Aides', it: 'Eroi e Aiutanti' } },
  { id: 'seasonal', name: { en: 'Seasonal', de: 'Jahreszeiten', fr: 'Saisonnier', it: 'Stagionale' } },
  { id: 'custom', name: { en: 'Custom', de: 'Eigenes Thema', fr: 'Personnalisé', it: 'Personalizzato' } },
];

export const storyTypes: StoryType[] = [
  // Historical Times
  { id: 'pirate', name: { en: 'Pirate Adventure', de: 'Piraten-Abenteuer', fr: 'Aventure de Pirates', it: 'Avventura dei Pirati' }, emoji: '🏴‍☠️', group: 'historical' },
  { id: 'knight', name: { en: 'Knights & Dragons', de: 'Ritter & Drachen', fr: 'Chevaliers & Dragons', it: 'Cavalieri e Draghi' }, emoji: '⚔️', group: 'historical' },
  { id: 'princess', name: { en: 'Princess & Castle', de: 'Prinzessin & Schloss', fr: 'Princesse & Château', it: 'Principessa e Castello' }, emoji: '👑', group: 'historical' },
  { id: 'cowboy', name: { en: 'Cowboys & Indians', de: 'Cowboys und Indianer', fr: 'Cowboys et Indiens', it: 'Cowboy e Indiani' }, emoji: '🤠', group: 'historical' },
  { id: 'ninja', name: { en: 'Secret Ninja', de: 'Geheimer Ninja', fr: 'Ninja Secret', it: 'Ninja Segreto' }, emoji: '🥷', group: 'historical' },
  { id: 'viking', name: { en: 'Viking Adventure', de: 'Wikinger-Abenteuer', fr: 'Aventure Viking', it: 'Avventura Vichinga' }, emoji: '⚓', group: 'historical' },
  { id: 'roman', name: { en: 'Ancient Rome', de: 'Antikes Rom', fr: 'Rome Antique', it: 'Antica Roma' }, emoji: '🏛️', group: 'historical' },
  { id: 'egyptian', name: { en: 'Ancient Egypt', de: 'Altes Ägypten', fr: 'Égypte Ancienne', it: 'Antico Egitto' }, emoji: '🏺', group: 'historical' },
  { id: 'greek', name: { en: 'Ancient Greece', de: 'Antikes Griechenland', fr: 'Grèce Antique', it: 'Antica Grecia' }, emoji: '🏺', group: 'historical' },
  { id: 'caveman', name: { en: 'Stone Age', de: 'Steinzeit', fr: 'Âge de Pierre', it: 'Età della Pietra' }, emoji: '🦴', group: 'historical' },
  { id: 'samurai', name: { en: 'Samurai Adventure', de: 'Samurai-Abenteuer', fr: 'Aventure Samouraï', it: 'Avventura dei Samurai' }, emoji: '🎌', group: 'historical' },

  // Fantasy & Magic (wizard & witch combined, dragon, unicorn, mermaid, dinosaur, superhero)
  { id: 'wizard', name: { en: 'Wizard & Witch', de: 'Zauberer & Hexe', fr: 'Sorcier & Sorcière', it: 'Mago e Strega' }, emoji: '🧙', group: 'fantasy' },
  { id: 'dragon', name: { en: 'Dragon Quest', de: 'Drachen-Abenteuer', fr: 'Quête du Dragon', it: 'Ricerca del Drago' }, emoji: '🐉', group: 'fantasy' },
  { id: 'unicorn', name: { en: 'Magical Unicorn', de: 'Magisches Einhorn', fr: 'Licorne Magique', it: 'Unicorno Magico' }, emoji: '🦄', group: 'fantasy' },
  { id: 'mermaid', name: { en: 'Mermaid Adventure', de: 'Meerjungfrauen-Abenteuer', fr: 'Aventure de Sirène', it: 'Avventura della Sirena' }, emoji: '🧜‍♀️', group: 'fantasy' },
  { id: 'dinosaur', name: { en: 'Dinosaur World', de: 'Dinosaurier-Welt', fr: 'Monde des Dinosaures', it: 'Mondo dei Dinosauri' }, emoji: '🦖', group: 'fantasy' },
  { id: 'superhero', name: { en: 'Superhero', de: 'Superheld', fr: 'Super-héros', it: 'Supereroe' }, emoji: '🦸', group: 'fantasy' },

  // Exploration / Locations (space, ocean, jungle, farm, forest)
  { id: 'space', name: { en: 'Space Explorer', de: 'Weltraum-Entdecker', fr: 'Explorateur Spatial', it: 'Esploratore Spaziale' }, emoji: '🚀', group: 'locations' },
  { id: 'ocean', name: { en: 'Ocean Explorer', de: 'Ozean-Entdecker', fr: 'Explorateur des Océans', it: 'Esploratore degli Oceani' }, emoji: '🌊', group: 'locations' },
  { id: 'jungle', name: { en: 'Jungle Safari', de: 'Dschungel-Safari', fr: 'Safari dans la Jungle', it: 'Safari nella Giungla' }, emoji: '🌴', group: 'locations' },
  { id: 'farm', name: { en: 'Farm Life', de: 'Bauernhof-Leben', fr: 'Vie à la Ferme', it: 'Vita in Fattoria' }, emoji: '🐄', group: 'locations' },
  { id: 'forest', name: { en: 'Forest Friends', de: 'Waldfreunde', fr: 'Amis de la Forêt', it: 'Amici della Foresta' }, emoji: '🦊', group: 'locations' },

  // Heroes & Helpers / Professions (firefighter, doctor, police, detective)
  { id: 'fireman', name: { en: 'Brave Firefighter', de: 'Tapferer Feuerwehrmann', fr: 'Pompier Courageux', it: 'Pompiere Coraggioso' }, emoji: '🚒', group: 'professions' },
  { id: 'doctor', name: { en: 'Helpful Doctor', de: 'Hilfreicher Arzt', fr: 'Docteur Serviable', it: 'Dottore Premuroso' }, emoji: '👨‍⚕️', group: 'professions' },
  { id: 'police', name: { en: 'Police Officer', de: 'Polizist', fr: 'Policier', it: 'Agente di Polizia' }, emoji: '👮', group: 'professions' },
  { id: 'detective', name: { en: 'Detective Mystery', de: 'Detektiv-Geheimnis', fr: 'Mystère Détective', it: 'Mistero del Detective' }, emoji: '🔍', group: 'professions' },

  // Seasonal (christmas, new year, easter, halloween, mother's day, father's day)
  { id: 'christmas', name: { en: 'Christmas Story', de: 'Weihnachts-Geschichte', fr: 'Histoire de Noël', it: 'Storia di Natale' }, emoji: '🎄', group: 'seasonal' },
  { id: 'newyear', name: { en: 'New Year Story', de: 'Neujahrs-Geschichte', fr: 'Histoire du Nouvel An', it: 'Storia di Capodanno' }, emoji: '🎆', group: 'seasonal' },
  { id: 'easter', name: { en: 'Easter Story', de: 'Oster-Geschichte', fr: 'Histoire de Pâques', it: 'Storia di Pasqua' }, emoji: '🐰', group: 'seasonal' },
  { id: 'halloween', name: { en: 'Halloween Story', de: 'Halloween-Geschichte', fr: 'Histoire d\'Halloween', it: 'Storia di Halloween' }, emoji: '🎃', group: 'seasonal' },
  { id: 'mothers-day', name: { en: 'Mother\'s Day Story', de: 'Muttertag-Geschichte', fr: 'Histoire Fête des Mères', it: 'Storia per la Festa della Mamma' }, emoji: '💐', group: 'seasonal' },
  { id: 'fathers-day', name: { en: 'Father\'s Day Story', de: 'Vatertag-Geschichte', fr: 'Histoire Fête des Pères', it: 'Storia per la Festa del Papà' }, emoji: '🧢', group: 'seasonal' },

  // Custom - user creates their own theme
  { id: 'custom', name: { en: 'Create Your Own', de: 'Eigenes Thema', fr: 'Créer le vôtre', it: 'Crea la tua storia' }, emoji: '✨', group: 'custom' },
];

// For life challenges and educational stories, this can be used as optional wrapper
export const realisticSetting: StoryType = {
  id: 'realistic',
  name: { en: 'Everyday Life', de: 'Alltag', fr: 'Vie Quotidienne', it: 'Vita Quotidiana' },
  emoji: '🏠'
};

// =============================================================================
// LIFE CHALLENGES (Grouped by typical age)
// =============================================================================
export const lifeChallenges: LifeChallenge[] = [
  // Toddler (2-4 years)
  { id: 'potty-training', name: { en: 'Potty Training', de: 'Töpfchen-Training', fr: 'Apprentissage du pot', it: 'Uso del vasino' }, emoji: '🚽', ageGroup: 'toddler' },
  { id: 'washing-hands', name: { en: 'Washing Hands', de: 'Hände waschen', fr: 'Se laver les mains', it: 'Lavarsi le mani' }, emoji: '🧼', ageGroup: 'toddler' },
  { id: 'brushing-teeth', name: { en: 'Brushing Teeth', de: 'Zähne putzen', fr: 'Se brosser les dents', it: 'Lavarsi i denti' }, emoji: '🪥', ageGroup: 'toddler' },
  { id: 'eating-vegetables', name: { en: 'Eating Vegetables', de: 'Gemüse essen', fr: 'Manger des légumes', it: 'Mangiare verdure' }, emoji: '🥦', ageGroup: 'toddler' },
  { id: 'going-to-bed', name: { en: 'Going to Bed', de: 'Ins Bett gehen', fr: 'Aller au lit', it: 'Andare a letto' }, emoji: '🛏️', ageGroup: 'toddler' },
  { id: 'saying-goodbye', name: { en: 'Saying Goodbye', de: 'Abschied nehmen', fr: 'Dire au revoir', it: 'Dire addio' }, emoji: '👋', ageGroup: 'toddler' },
  { id: 'no-pacifier', name: { en: 'No More Pacifier', de: 'Ohne Schnuller', fr: 'Plus de tétine', it: 'Senza ciuccio' }, emoji: '🍼', ageGroup: 'toddler' },
  { id: 'getting-dressed', name: { en: 'Getting Dressed by Myself', de: 'Sich alleine anziehen', fr: 'S\'habiller tout seul', it: 'Vestirsi da solo' }, emoji: '👕', ageGroup: 'toddler' },

  // Preschool (4-6 years)
  { id: 'cleaning-up', name: { en: 'Cleaning Up Toys', de: 'Aufräumen', fr: 'Ranger les jouets', it: 'Riordinare i giocattoli' }, emoji: '🧹', ageGroup: 'preschool' },
  { id: 'sitting-still', name: { en: 'Sitting Still', de: 'Still sitzen', fr: 'Rester tranquille', it: 'Stare fermi' }, emoji: '🪑', ageGroup: 'preschool' },
  { id: 'sharing', name: { en: 'Learning to Share', de: 'Teilen lernen', fr: 'Apprendre à partager', it: 'Imparare a condividere' }, emoji: '🤝', ageGroup: 'preschool' },
  { id: 'waiting-turn', name: { en: 'Waiting Your Turn', de: 'Warten können', fr: 'Attendre son tour', it: 'Aspettare il proprio turno' }, emoji: '⏳', ageGroup: 'preschool' },
  { id: 'first-kindergarten', name: { en: 'First Day of Kindergarten', de: 'Erster Kindergartentag', fr: 'Premier jour de maternelle', it: 'Primo giorno all\'asilo' }, emoji: '🎒', ageGroup: 'preschool' },
  { id: 'making-friends', name: { en: 'Making Real Friends', de: 'Echte Freunde finden', fr: 'Se faire de vrais amis', it: 'Fare veri amici' }, emoji: '👫', ageGroup: 'preschool' },
  { id: 'being-brave', name: { en: 'Being Brave', de: 'Mutig sein', fr: 'Être courageux', it: 'Essere coraggiosi' }, emoji: '💪', ageGroup: 'preschool' },
  { id: 'new-sibling', name: { en: 'New Baby Sibling', de: 'Neues Geschwisterchen', fr: 'Nouveau bébé dans la famille', it: 'Nuovo fratellino o sorellina' }, emoji: '👶', ageGroup: 'preschool' },
  { id: 'managing-emotions', name: { en: 'Managing Big Emotions', de: 'Grosse Gefühle bewältigen', fr: 'Gérer les grandes émotions', it: 'Gestire le grandi emozioni' }, emoji: '😤', ageGroup: 'preschool' },
  { id: 'whining', name: { en: 'Using a Nice Voice', de: 'Nicht jammern', fr: 'Parler sans pleurnicher', it: 'Usare una voce gentile' }, emoji: '🗣️', ageGroup: 'preschool' },
  { id: 'saying-sorry', name: { en: 'Saying Sorry & Meaning It', de: 'Sich aufrichtig entschuldigen', fr: 'S\'excuser sincèrement', it: 'Chiedere scusa sinceramente' }, emoji: '🙏', ageGroup: 'preschool' },
  { id: 'picky-eating', name: { en: 'Trying New Foods', de: 'Neues Essen probieren', fr: 'Goûter de nouveaux aliments', it: 'Provare cibi nuovi' }, emoji: '🍽️', ageGroup: 'preschool' },
  { id: 'table-manners', name: { en: 'Table Manners', de: 'Tischmanieren', fr: 'Bonnes manières à table', it: 'Buone maniere a tavola' }, emoji: '🍴', ageGroup: 'preschool' },
  { id: 'being-patient', name: { en: 'Learning to Be Patient', de: 'Geduld lernen', fr: 'Apprendre la patience', it: 'Imparare la pazienza' }, emoji: '🐢', ageGroup: 'preschool' },

  // Early School (6-9 years)
  { id: 'first-school', name: { en: 'First Day of School', de: 'Erster Schultag', fr: 'Premier jour d\'école', it: 'Primo giorno di scuola' }, emoji: '🏫', ageGroup: 'early-school' },
  { id: 'homework', name: { en: 'Doing Homework', de: 'Hausaufgaben machen', fr: 'Faire ses devoirs', it: 'Fare i compiti' }, emoji: '📝', ageGroup: 'early-school' },
  { id: 'reading-alone', name: { en: 'Learning to Read', de: 'Lesen lernen', fr: 'Apprendre à lire', it: 'Imparare a leggere' }, emoji: '📖', ageGroup: 'early-school' },
  { id: 'losing-game', name: { en: 'Losing a Game', de: 'Verlieren können', fr: 'Savoir perdre', it: 'Saper perdere' }, emoji: '🎯', ageGroup: 'early-school' },
  { id: 'being-different', name: { en: 'Being Yourself', de: 'Du selbst sein', fr: 'Être soi-même', it: 'Essere se stessi' }, emoji: '🌈', ageGroup: 'early-school' },
  { id: 'dealing-bully', name: { en: 'Standing Up for Yourself', de: 'Für sich einstehen', fr: 'S\'affirmer face aux autres', it: 'Difendersi da soli' }, emoji: '🛡️', ageGroup: 'early-school' },
  { id: 'telling-truth', name: { en: 'Telling the Truth', de: 'Die Wahrheit sagen', fr: 'Dire la vérité', it: 'Dire la verità' }, emoji: '✅', ageGroup: 'early-school' },
  { id: 'trying-new-things', name: { en: 'Growing & Learning', de: 'Wachsen & Lernen', fr: 'Grandir & Apprendre', it: 'Crescere e imparare' }, emoji: '🌟', ageGroup: 'early-school' },
  { id: 'sibling-fighting', name: { en: 'Getting Along with Siblings', de: 'Geschwisterstreit', fr: 'S\'entendre avec ses frères et sœurs', it: 'Andare d\'accordo con i fratelli' }, emoji: '👧👦', ageGroup: 'early-school' },
  { id: 'jealousy', name: { en: 'Dealing with Jealousy', de: 'Mit Eifersucht umgehen', fr: 'Gérer la jalousie', it: 'Gestire la gelosia' }, emoji: '💚', ageGroup: 'early-school' },
  { id: 'not-giving-up', name: { en: 'Not Giving Up', de: 'Nicht aufgeben', fr: 'Ne pas abandonner', it: 'Non arrendersi' }, emoji: '🧗', ageGroup: 'early-school' },
  { id: 'being-left-out', name: { en: 'Being Left Out', de: 'Ausgeschlossen werden', fr: 'Être mis à l\'écart', it: 'Essere esclusi' }, emoji: '😔', ageGroup: 'early-school' },
  { id: 'taking-care-belongings', name: { en: 'Taking Care of Things', de: 'Auf Sachen aufpassen', fr: 'Prendre soin de ses affaires', it: 'Avere cura delle proprie cose' }, emoji: '🎒', ageGroup: 'early-school' },
  { id: 'helping-at-home', name: { en: 'Helping at Home', de: 'Im Haushalt helfen', fr: 'Aider à la maison', it: 'Aiutare in casa' }, emoji: '🏡', ageGroup: 'early-school' },
  { id: 'dealing-disappointment', name: { en: 'Dealing with Disappointment', de: 'Mit Enttäuschung umgehen', fr: 'Gérer la déception', it: 'Gestire la delusione' }, emoji: '😞', ageGroup: 'early-school' },
  { id: 'anxiety-worrying', name: { en: 'Worry & Anxiety', de: 'Sorgen & Ängste', fr: 'Soucis & Anxiété', it: 'Preoccupazioni e ansia' }, emoji: '😰', ageGroup: 'early-school' },
  { id: 'caring-for-pet', name: { en: 'Caring for a Pet', de: 'Sich um ein Haustier kümmern', fr: 'Prendre soin d\'un animal', it: 'Prendersi cura di un animale' }, emoji: '🐕', ageGroup: 'early-school' },
  { id: 'tattling-vs-telling', name: { en: 'Tattling vs Telling', de: 'Petzen vs Um Hilfe bitten', fr: 'Rapporter vs Demander de l\'aide', it: 'Fare la spia o chiedere aiuto' }, emoji: '🗣️', ageGroup: 'preschool' },
  { id: 'understanding-rules', name: { en: 'Why Parents Say No', de: 'Warum Eltern Nein sagen', fr: 'Pourquoi les parents disent non', it: 'Perché i genitori dicono no' }, emoji: '🚦', ageGroup: 'preschool' },

  // Family Changes (All ages)
  { id: 'moving-house', name: { en: 'Moving to a New Home', de: 'Umzug', fr: 'Déménagement', it: 'Trasloco' }, emoji: '🏠', ageGroup: 'family' },
  { id: 'going-vacation', name: { en: 'Going on Vacation', de: 'In den Urlaub fahren', fr: 'Partir en vacances', it: 'Andare in vacanza' }, emoji: '✈️', ageGroup: 'family' },
  { id: 'parents-splitting', name: { en: 'Parents Living Apart', de: 'Eltern leben getrennt', fr: 'Parents séparés', it: 'Genitori separati' }, emoji: '💔', ageGroup: 'family' },
  { id: 'visiting-doctor', name: { en: 'Going to the Doctor', de: 'Arztbesuch', fr: 'Visite chez le médecin', it: 'Andare dal dottore' }, emoji: '🏥', ageGroup: 'family' },
  { id: 'staying-hospital', name: { en: 'Staying in Hospital', de: 'Im Krankenhaus', fr: 'Séjour à l\'hôpital', it: 'In ospedale' }, emoji: '🩺', ageGroup: 'family' },
  { id: 'death-pet', name: { en: 'Losing a Pet', de: 'Haustier verlieren', fr: 'Perte d\'un animal', it: 'Perdere un animale' }, emoji: '🌈', ageGroup: 'family' },
  { id: 'grandparent-sick', name: { en: 'Grandparent is Sick', de: 'Grosseltern sind krank', fr: 'Grand-parent malade', it: 'I nonni sono malati' }, emoji: '❤️', ageGroup: 'family' },

  // Pre-Teen (9-12 years)
  { id: 'money-saving', name: { en: 'Saving Money', de: 'Geld sparen', fr: 'Économiser de l\'argent', it: 'Risparmiare denaro' }, emoji: '💰', ageGroup: 'preteen' },
  { id: 'spending-wisely', name: { en: 'Spending Wisely', de: 'Klug ausgeben', fr: 'Dépenser intelligemment', it: 'Spendere con saggezza' }, emoji: '🛒', ageGroup: 'preteen' },
  { id: 'screen-time', name: { en: 'Screen Time Balance', de: 'Bildschirmzeit-Balance', fr: 'Équilibre du temps d\'écran', it: 'Equilibrio con lo schermo' }, emoji: '📱', ageGroup: 'preteen' },
  { id: 'peer-pressure', name: { en: 'Peer Pressure', de: 'Gruppenzwang', fr: 'Pression des pairs', it: 'Pressione dei coetanei' }, emoji: '👥', ageGroup: 'preteen' },
  { id: 'body-changes', name: { en: 'Body Changes', de: 'Körperliche Veränderungen', fr: 'Changements corporels', it: 'Cambiamenti del corpo' }, emoji: '🌱', ageGroup: 'preteen' },
  { id: 'responsibility', name: { en: 'Taking Responsibility', de: 'Verantwortung übernehmen', fr: 'Prendre ses responsabilités', it: 'Assumersi responsabilità' }, emoji: '🎯', ageGroup: 'preteen' },
  { id: 'managing-time', name: { en: 'Managing Time', de: 'Zeitmanagement', fr: 'Gestion du temps', it: 'Gestione del tempo' }, emoji: '⏰', ageGroup: 'preteen' },
  { id: 'online-safety', name: { en: 'Online Safety', de: 'Sicherheit im Internet', fr: 'Sécurité en ligne', it: 'Sicurezza online' }, emoji: '🔒', ageGroup: 'preteen' },
  { id: 'being-active', name: { en: 'Being Active & Going Outdoors', de: 'Aktiv sein & Rausgehen', fr: 'Être actif & Sortir dehors', it: 'Essere attivi e uscire all\'aperto' }, emoji: '🏃', ageGroup: 'preteen' },
  { id: 'comparing-others', name: { en: 'Comparing Yourself to Others', de: 'Sich mit anderen vergleichen', fr: 'Se comparer aux autres', it: 'Confrontarsi con gli altri' }, emoji: '📊', ageGroup: 'preteen' },
  { id: 'test-stress', name: { en: 'Test & Exam Stress', de: 'Prüfungsangst', fr: 'Stress des examens', it: 'Stress da esami' }, emoji: '📋', ageGroup: 'preteen' },
];

// Popular life challenge IDs (shown in expanded "Popular" section)
export const popularLifeChallengeIds = [
  'sibling-fighting', 'table-manners', 'understanding-rules', 'making-friends',
  'going-to-bed', 'cleaning-up', 'first-kindergarten', 'first-school',
  'losing-game', 'dealing-bully', 'telling-truth', 'screen-time',
  'moving-house', 'sharing', 'brushing-teeth', 'eating-vegetables'
];

export const lifeChallengeGroups: LifeChallengeGroup[] = [
  { id: 'popular', name: { en: 'Popular', de: 'Beliebt', fr: 'Populaires', it: 'Popolari' }, ageRange: 'all' },
  { id: 'family', name: { en: 'Family Changes', de: 'Familien-Veränderungen', fr: 'Changements familiaux', it: 'Cambiamenti familiari' }, ageRange: 'all' },
  { id: 'toddler', name: { en: 'Toddler (2-4)', de: 'Kleinkind (2-4)', fr: 'Tout-petit (2-4)', it: 'Bambino piccolo (2-4)' }, ageRange: '2-4' },
  { id: 'preschool', name: { en: 'Preschool (4-6)', de: 'Vorschule (4-6)', fr: 'Préscolaire (4-6)', it: 'Prescolare (4-6)' }, ageRange: '4-6' },
  { id: 'early-school', name: { en: 'Early School (6-9)', de: 'Grundschule (6-9)', fr: 'École primaire (6-9)', it: 'Scuola elementare (6-9)' }, ageRange: '6-9' },
  { id: 'preteen', name: { en: 'Pre-Teen (9-12)', de: 'Vorpubertät (9-12)', fr: 'Préadolescent (9-12)', it: 'Preadolescenza (9-12)' }, ageRange: '9-12' },
];

// =============================================================================
// EDUCATIONAL TOPICS
// =============================================================================
export const educationalTopics: EducationalTopic[] = [
  // Letters & Reading
  { id: 'alphabet', name: { en: 'The Alphabet (ABC)', de: 'Das Alphabet (ABC)', fr: 'L\'Alphabet (ABC)', it: 'L\'Alfabeto (ABC)' }, emoji: '🔤', group: 'letters' },
  { id: 'vowels', name: { en: 'Vowels (A, E, I, O, U)', de: 'Vokale (A, E, I, O, U)', fr: 'Voyelles (A, E, I, O, U)', it: 'Vocali (A, E, I, O, U)' }, emoji: '🅰️', group: 'letters' },
  { id: 'rhyming', name: { en: 'Rhyming Words', de: 'Reimwörter', fr: 'Mots qui riment', it: 'Parole in rima' }, emoji: '🎵', group: 'letters' },
  { id: 'spelling-name', name: { en: 'Spelling My Name', de: 'Meinen Namen schreiben', fr: 'Écrire mon nom', it: 'Scrivere il mio nome' }, emoji: '✏️', group: 'letters' },

  // Numbers & Math
  { id: 'numbers-1-10', name: { en: 'Numbers 1-10', de: 'Zahlen 1-10', fr: 'Nombres 1-10', it: 'Numeri 1-10' }, emoji: '🔢', group: 'numbers' },
  { id: 'numbers-1-20', name: { en: 'Numbers 1-20', de: 'Zahlen 1-20', fr: 'Nombres 1-20', it: 'Numeri 1-20' }, emoji: '🔢', group: 'numbers' },
  { id: 'counting', name: { en: 'Learning to Count', de: 'Zählen lernen', fr: 'Apprendre à compter', it: 'Imparare a contare' }, emoji: '✋', group: 'numbers' },
  { id: 'shapes', name: { en: 'Shapes', de: 'Formen', fr: 'Formes', it: 'Forme' }, emoji: '🔷', group: 'numbers' },
  { id: 'addition', name: { en: 'Simple Addition', de: 'Einfaches Addieren', fr: 'Addition simple', it: 'Addizione semplice' }, emoji: '➕', group: 'numbers' },

  // Colors
  { id: 'colors-basic', name: { en: 'Basic Colors', de: 'Grundfarben', fr: 'Couleurs de base', it: 'Colori di base' }, emoji: '🌈', group: 'colors' },
  { id: 'colors-mixing', name: { en: 'Mixing Colors', de: 'Farben mischen', fr: 'Mélanger les couleurs', it: 'Mescolare i colori' }, emoji: '🎨', group: 'colors' },

  // Nature & Science
  { id: 'planets', name: { en: 'Planets & Space', de: 'Planeten & Weltraum', fr: 'Planètes & Espace', it: 'Pianeti e Spazio' }, emoji: '🪐', group: 'science' },
  { id: 'seasons', name: { en: 'The Four Seasons', de: 'Die vier Jahreszeiten', fr: 'Les quatre saisons', it: 'Le quattro stagioni' }, emoji: '🍂', group: 'science' },
  { id: 'weather', name: { en: 'Weather', de: 'Wetter', fr: 'Météo', it: 'Il tempo meteorologico' }, emoji: '⛅', group: 'science' },
  { id: 'water-cycle', name: { en: 'Water Cycle', de: 'Wasserkreislauf', fr: 'Cycle de l\'eau', it: 'Ciclo dell\'acqua' }, emoji: '💧', group: 'science' },
  { id: 'plants-grow', name: { en: 'How Plants Grow', de: 'Wie Pflanzen wachsen', fr: 'Comment poussent les plantes', it: 'Come crescono le piante' }, emoji: '🌱', group: 'science' },
  { id: 'day-night', name: { en: 'Day and Night', de: 'Tag und Nacht', fr: 'Jour et nuit', it: 'Giorno e notte' }, emoji: '🌙', group: 'science' },

  // Animals
  { id: 'farm-animals', name: { en: 'Farm Animals', de: 'Bauernhoftiere', fr: 'Animaux de la ferme', it: 'Animali della fattoria' }, emoji: '🐷', group: 'animals' },
  { id: 'wild-animals', name: { en: 'Wild Animals', de: 'Wilde Tiere', fr: 'Animaux sauvages', it: 'Animali selvatici' }, emoji: '🦁', group: 'animals' },
  { id: 'ocean-animals', name: { en: 'Ocean Animals', de: 'Meerestiere', fr: 'Animaux marins', it: 'Animali marini' }, emoji: '🐋', group: 'animals' },
  { id: 'insects', name: { en: 'Insects & Bugs', de: 'Insekten & Käfer', fr: 'Insectes', it: 'Insetti' }, emoji: '🐛', group: 'animals' },
  { id: 'dinosaurs', name: { en: 'Dinosaurs', de: 'Dinosaurier', fr: 'Dinosaures', it: 'Dinosauri' }, emoji: '🦕', group: 'animals' },

  // Body & Health
  { id: 'body-parts', name: { en: 'Body Parts', de: 'Körperteile', fr: 'Parties du corps', it: 'Parti del corpo' }, emoji: '🫀', group: 'body' },
  { id: 'five-senses', name: { en: 'The Five Senses', de: 'Die fünf Sinne', fr: 'Les cinq sens', it: 'I cinque sensi' }, emoji: '👁️', group: 'body' },
  { id: 'healthy-eating', name: { en: 'Healthy Eating', de: 'Gesund essen', fr: 'Manger sainement', it: 'Mangiare sano' }, emoji: '🥗', group: 'body' },

  // Time & Calendar
  { id: 'days-week', name: { en: 'Days of the Week', de: 'Wochentage', fr: 'Jours de la semaine', it: 'Giorni della settimana' }, emoji: '📅', group: 'time' },
  { id: 'months-year', name: { en: 'Months of the Year', de: 'Monate des Jahres', fr: 'Mois de l\'année', it: 'Mesi dell\'anno' }, emoji: '🗓️', group: 'time' },
  { id: 'telling-time', name: { en: 'Telling Time', de: 'Uhr lesen', fr: 'Lire l\'heure', it: 'Leggere l\'orologio' }, emoji: '🕐', group: 'time' },

  // World & Geography
  { id: 'continents', name: { en: 'Continents', de: 'Kontinente', fr: 'Continents', it: 'Continenti' }, emoji: '🌍', group: 'geography' },
  { id: 'countries-flags', name: { en: 'Countries & Flags', de: 'Länder & Flaggen', fr: 'Pays & Drapeaux', it: 'Paesi e Bandiere' }, emoji: '🏳️', group: 'geography' },

  // Music & Art
  { id: 'instruments', name: { en: 'Musical Instruments', de: 'Musikinstrumente', fr: 'Instruments de musique', it: 'Strumenti musicali' }, emoji: '🎸', group: 'arts' },
  { id: 'famous-artists', name: { en: 'Famous Artists', de: 'Berühmte Künstler', fr: 'Artistes célèbres', it: 'Artisti famosi' }, emoji: '🖼️', group: 'arts' },
];

// Popular educational topic IDs (shown in expanded "Popular" section)
export const popularEducationalTopicIds = [
  'alphabet', 'numbers-1-10', 'rhyming', 'seasons', 'weather',
  'water-cycle', 'farm-animals', 'five-senses', 'days-week', 'months-year'
];

export const educationalGroups: EducationalGroup[] = [
  { id: 'popular', name: { en: 'Popular', de: 'Beliebt', fr: 'Populaires', it: 'Popolari' } },
  { id: 'letters', name: { en: 'Letters & Reading', de: 'Buchstaben & Lesen', fr: 'Lettres & Lecture', it: 'Lettere e Lettura' } },
  { id: 'numbers', name: { en: 'Numbers & Math', de: 'Zahlen & Mathe', fr: 'Nombres & Maths', it: 'Numeri e Matematica' } },
  { id: 'colors', name: { en: 'Colors', de: 'Farben', fr: 'Couleurs', it: 'Colori' } },
  { id: 'science', name: { en: 'Nature & Science', de: 'Natur & Wissenschaft', fr: 'Nature & Science', it: 'Natura e Scienza' } },
  { id: 'animals', name: { en: 'Animals', de: 'Tiere', fr: 'Animaux', it: 'Animali' } },
  { id: 'body', name: { en: 'Body & Health', de: 'Körper & Gesundheit', fr: 'Corps & Santé', it: 'Corpo e Salute' } },
  { id: 'time', name: { en: 'Time & Calendar', de: 'Zeit & Kalender', fr: 'Temps & Calendrier', it: 'Tempo e Calendario' } },
  { id: 'geography', name: { en: 'World & Geography', de: 'Welt & Geografie', fr: 'Monde & Géographie', it: 'Mondo e Geografia' } },
  { id: 'arts', name: { en: 'Music & Art', de: 'Musik & Kunst', fr: 'Musique & Art', it: 'Musica e Arte' } },
];

// =============================================================================
// HISTORICAL EVENTS (for historically accurate story generation)
// =============================================================================
// Popular historical event IDs (shown in expanded "Popular" section)
export const popularHistoricalEventIds = [
  'wilhelm-tell', 'printing-press', 'columbus-voyage', 'galapagos-darwin',
  'gotthard-tunnel', 'wright-brothers', 'einstein-relativity', 'lindbergh-flight',
  'everest-summit', 'moon-landing', 'berlin-wall-fall', 'mandela-freedom'
];

export const historicalEventGroups: HistoricalEventGroup[] = [
  { id: 'popular', name: { en: 'Popular', de: 'Beliebt', fr: 'Populaires', it: 'Popolari' }, icon: '⭐' },
  { id: 'swiss', name: { en: 'Swiss History', de: 'Schweizer Geschichte', fr: 'Histoire Suisse', it: 'Storia Svizzera' }, icon: '🇨🇭' },
  { id: 'exploration', name: { en: 'Exploration & Discovery', de: 'Entdeckungen', fr: 'Exploration & Découverte', it: 'Esplorazione e Scoperta' }, icon: '🧭' },
  { id: 'science', name: { en: 'Science & Medicine', de: 'Wissenschaft & Medizin', fr: 'Science & Médecine', it: 'Scienza e Medicina' }, icon: '🔬' },
  { id: 'invention', name: { en: 'Inventions', de: 'Erfindungen', fr: 'Inventions', it: 'Invenzioni' }, icon: '💡' },
  { id: 'rights', name: { en: 'Human Rights & Freedom', de: 'Menschenrechte & Freiheit', fr: 'Droits humains & Liberté', it: 'Diritti Umani e Libertà' }, icon: '✊' },
  { id: 'construction', name: { en: 'Great Constructions', de: 'Grosse Bauwerke', fr: 'Grandes Constructions', it: 'Grandi Costruzioni' }, icon: '🏗️' },
  { id: 'culture', name: { en: 'Culture & Arts', de: 'Kultur & Kunst', fr: 'Culture & Arts', it: 'Cultura e Arte' }, icon: '🎭' },
  { id: 'archaeology', name: { en: 'Archaeological Discoveries', de: 'Archäologische Entdeckungen', fr: 'Découvertes Archéologiques', it: 'Scoperte Archeologiche' }, icon: '🏺' },
];

export const historicalEvents: HistoricalEvent[] = [
  // Swiss History
  { id: 'swiss-founding', name: { en: 'Founding of Switzerland (Rütlischwur)', de: 'Gründung der Schweiz (Rütlischwur)', fr: 'Fondation de la Suisse (Serment du Grütli)', it: 'Fondazione della Svizzera (Giuramento del Grütli)' }, shortName: { en: 'Rütlischwur', de: 'Rütlischwur', fr: 'Serment du Grütli', it: 'Giuramento del Grütli' }, emoji: '🤝', year: 1291, category: 'swiss' },
  { id: 'wilhelm-tell', name: { en: 'Wilhelm Tell and the Apple', de: 'Wilhelm Tell und der Apfel', fr: 'Guillaume Tell et la pomme', it: 'Guglielmo Tell e la mela' }, shortName: { en: 'Wilhelm Tell', de: 'Wilhelm Tell', fr: 'Guillaume Tell', it: 'Guglielmo Tell' }, emoji: '🏹', year: 1307, category: 'swiss', mainPerson: 'Wilhelm Tell' },
  { id: 'battle-morgarten', name: { en: 'Battle of Morgarten', de: 'Schlacht am Morgarten', fr: 'Bataille de Morgarten', it: 'Battaglia di Morgarten' }, shortName: { en: 'Morgarten', de: 'Morgarten', fr: 'Morgarten', it: 'Morgarten' }, emoji: '⚔️', year: 1315, category: 'swiss' },
  { id: 'battle-sempach', name: { en: 'Battle of Sempach (Winkelried)', de: 'Schlacht bei Sempach (Winkelried)', fr: 'Bataille de Sempach (Winkelried)', it: 'Battaglia di Sempach (Winkelried)' }, shortName: { en: 'Sempach', de: 'Sempach', fr: 'Sempach', it: 'Sempach' }, emoji: '🛡️', year: 1386, category: 'swiss', mainPerson: 'Arnold von Winkelried' },
  { id: 'swiss-reformation', name: { en: 'Swiss Reformation (Zwingli)', de: 'Schweizer Reformation (Zwingli)', fr: 'Réforme Suisse (Zwingli)', it: 'Riforma svizzera (Zwingli)' }, shortName: { en: 'Reformation', de: 'Reformation', fr: 'Réforme', it: 'Riforma' }, emoji: '📜', year: 1523, category: 'swiss', mainPerson: 'Huldrych Zwingli' },
  { id: 'red-cross-founding', name: { en: 'Henry Dunant Founds the Red Cross', de: 'Henry Dunant gründet das Rote Kreuz', fr: 'Henry Dunant fonde la Croix-Rouge', it: 'Henry Dunant fonda la Croce Rossa' }, shortName: { en: 'Red Cross', de: 'Rotes Kreuz', fr: 'Croix-Rouge', it: 'Croce Rossa' }, emoji: '❤️', year: 1863, category: 'swiss', mainPerson: 'Henry Dunant' },
  { id: 'general-dufour', name: { en: 'General Dufour and Swiss Unity', de: 'General Dufour und die Schweizer Einheit', fr: 'Général Dufour et l\'unité suisse', it: 'Il generale Dufour e l\'unità svizzera' }, shortName: { en: 'General Dufour', de: 'General Dufour', fr: 'Général Dufour', it: 'Generale Dufour' }, emoji: '🎖️', year: 1847, category: 'swiss', mainPerson: 'Guillaume-Henri Dufour' },
  { id: 'sonderbund-war', name: { en: 'The Sonderbund War', de: 'Der Sonderbundskrieg', fr: 'La Guerre du Sonderbund', it: 'La guerra del Sonderbund' }, shortName: { en: 'Sonderbund', de: 'Sonderbund', fr: 'Sonderbund', it: 'Sonderbund' }, emoji: '🏔️', year: 1847, category: 'swiss' },
  { id: 'swiss-constitution', name: { en: 'Swiss Federal Constitution', de: 'Schweizerische Bundesverfassung', fr: 'Constitution fédérale suisse', it: 'Costituzione federale svizzera' }, shortName: { en: 'Constitution', de: 'Bundesverfassung', fr: 'Constitution', it: 'Costituzione' }, emoji: '📋', year: 1848, category: 'swiss' },
  { id: 'gotthard-tunnel', name: { en: 'Building the Gotthard Tunnel', de: 'Bau des Gotthardtunnels', fr: 'Construction du tunnel du Gothard', it: 'Costruzione del tunnel del San Gottardo' }, shortName: { en: 'Gotthard Tunnel', de: 'Gotthardtunnel Bau', fr: 'Tunnel du Gothard', it: 'Tunnel del Gottardo' }, emoji: '🚂', year: 1882, category: 'swiss' },
  { id: 'swiss-ww1-neutrality', name: { en: 'Swiss Neutrality in WWI', de: 'Schweizer Neutralität im 1. Weltkrieg', fr: 'Neutralité suisse pendant la Première Guerre', it: 'Neutralità svizzera nella Prima Guerra Mondiale' }, shortName: { en: 'WWI Neutrality', de: 'Neutralität 1. WK', fr: 'Neutralité 1GM', it: 'Neutralità 1GM' }, emoji: '🕊️', year: 1914, category: 'swiss' },
  { id: 'general-guisan', name: { en: 'General Guisan and the Rütli Report', de: 'General Guisan und der Rütlirapport', fr: 'Général Guisan et le Rapport du Grütli', it: 'Il generale Guisan e il rapporto del Grütli' }, shortName: { en: 'General Guisan', de: 'General Guisan', fr: 'Général Guisan', it: 'Generale Guisan' }, emoji: '🎖️', year: 1940, category: 'swiss', mainPerson: 'Henri Guisan' },
  { id: 'swiss-ww2-neutrality', name: { en: 'Switzerland in World War II', de: 'Die Schweiz im 2. Weltkrieg', fr: 'La Suisse pendant la Seconde Guerre', it: 'La Svizzera nella Seconda Guerra Mondiale' }, shortName: { en: 'WWII', de: '2. Weltkrieg', fr: '2ème GM', it: '2ª Guerra Mondiale' }, emoji: '🏔️', year: 1939, category: 'swiss' },
  { id: 'swiss-womens-vote', name: { en: 'Swiss Women Win the Vote', de: 'Schweizer Frauenstimmrecht', fr: 'Droit de vote des femmes suisses', it: 'Le donne svizzere ottengono il voto' }, shortName: { en: 'Women\'s Vote', de: 'Frauenstimmrecht', fr: 'Vote des femmes', it: 'Voto delle donne' }, emoji: '🗳️', year: 1971, category: 'swiss' },

  // Exploration & Discovery
  { id: 'moon-landing', name: { en: 'Neil Armstrong Lands on the Moon', de: 'Neil Armstrong landet auf dem Mond', fr: 'Neil Armstrong marche sur la Lune', it: 'Neil Armstrong sbarca sulla Luna' }, shortName: { en: 'Moon Landing', de: 'Mondlandung', fr: 'Alunissage', it: 'Allunaggio' }, emoji: '🌙', year: 1969, category: 'exploration', mainPerson: 'Neil Armstrong' },
  { id: 'columbus-voyage', name: { en: 'Columbus Reaches the Americas', de: 'Kolumbus erreicht Amerika', fr: 'Colomb atteint les Amériques', it: 'Colombo raggiunge le Americhe' }, shortName: { en: 'Columbus', de: 'Kolumbus', fr: 'Colomb', it: 'Colombo' }, emoji: '⛵', year: 1492, category: 'exploration', mainPerson: 'Christopher Columbus' },
  { id: 'wright-brothers', name: { en: 'Wright Brothers Invent Powered Flight', de: 'Gebrüder Wright erfinden den Motorflug', fr: 'Les frères Wright inventent le vol motorisé', it: 'I fratelli Wright inventano il volo a motore' }, shortName: { en: 'First Flight', de: 'Erster Flug', fr: 'Premier vol', it: 'Primo volo' }, emoji: '✈️', year: 1903, category: 'exploration', mainPerson: 'Wright Brothers' },
  { id: 'lindbergh-flight', name: { en: 'Lindbergh Crosses the Atlantic Solo', de: 'Lindbergh überquert den Atlantik allein', fr: 'Lindbergh traverse l\'Atlantique en solo', it: 'Lindbergh attraversa l\'Atlantico in solitaria' }, shortName: { en: 'Atlantic Flight', de: 'Atlantikflug', fr: 'Vol Atlantique', it: 'Volo Atlantico' }, emoji: '🛩️', year: 1927, category: 'exploration', mainPerson: 'Charles Lindbergh' },
  { id: 'everest-summit', name: { en: 'Hillary & Tenzing Summit Everest', de: 'Hillary & Tenzing besteigen den Everest', fr: 'Hillary & Tenzing au sommet de l\'Everest', it: 'Hillary e Tenzing sulla vetta dell\'Everest' }, shortName: { en: 'Climbing Everest', de: 'Everest-Besteigung', fr: 'Ascension Everest', it: 'Scalata dell\'Everest' }, emoji: '🏔️', year: 1953, category: 'exploration', mainPerson: 'Edmund Hillary & Tenzing Norgay' },
  { id: 'south-pole', name: { en: 'First to the South Pole', de: 'Erster am Südpol', fr: 'Premier au Pôle Sud', it: 'Primi al Polo Sud' }, shortName: { en: 'South Pole', de: 'Südpol', fr: 'Pôle Sud', it: 'Polo Sud' }, emoji: '❄️', year: 1911, category: 'exploration', mainPerson: 'Roald Amundsen' },
  { id: 'magellan-circumnavigation', name: { en: 'First Circumnavigation', de: 'Erste Weltumsegelung', fr: 'Premier tour du monde', it: 'Prima circumnavigazione del globo' }, shortName: { en: 'Around the World', de: 'Weltumsegelung', fr: 'Tour du monde', it: 'Giro del mondo' }, emoji: '🌍', year: 1522, category: 'exploration', mainPerson: 'Ferdinand Magellan' },
  { id: 'mariana-trench', name: { en: 'Deepest Ocean Dive', de: 'Tiefster Meerstauchgang', fr: 'Plongée la plus profonde', it: 'L\'immersione oceanica più profonda' }, shortName: { en: 'Deep Sea Dive', de: 'Tiefseetauchen', fr: 'Plongée profonde', it: 'Immersione negli abissi' }, emoji: '🌊', year: 1960, category: 'exploration', mainPerson: 'Jacques Piccard' },

  // Science & Medicine
  { id: 'electricity-discovery', name: { en: 'Franklin\'s Kite Experiment', de: 'Franklins Drachenexperiment', fr: 'Expérience du cerf-volant', it: 'L\'esperimento dell\'aquilone di Franklin' }, shortName: { en: 'Electricity Discovery', de: 'Elektrizität entdeckt', fr: 'Découverte électricité', it: 'Scoperta dell\'elettricità' }, emoji: '⚡', year: 1752, category: 'science', mainPerson: 'Benjamin Franklin' },
  { id: 'penicillin', name: { en: 'Discovery of Penicillin', de: 'Entdeckung des Penicillins', fr: 'Découverte de la pénicilline', it: 'Scoperta della penicillina' }, shortName: { en: 'Penicillin', de: 'Penicillin', fr: 'Pénicilline', it: 'Penicillina' }, emoji: '💊', year: 1928, category: 'science', mainPerson: 'Alexander Fleming' },
  { id: 'vaccine-discovery', name: { en: 'First Vaccine', de: 'Erste Impfung', fr: 'Premier vaccin', it: 'Il primo vaccino' }, shortName: { en: 'First Vaccine', de: 'Erste Impfung', fr: 'Premier vaccin', it: 'Primo vaccino' }, emoji: '💉', year: 1796, category: 'science', mainPerson: 'Edward Jenner' },
  { id: 'dna-discovery', name: { en: 'DNA Structure Discovered', de: 'DNA-Struktur entdeckt', fr: 'Structure ADN découverte', it: 'Scoperta della struttura del DNA' }, shortName: { en: 'DNA Discovery', de: 'DNA-Entdeckung', fr: 'Découverte ADN', it: 'Scoperta del DNA' }, emoji: '🧬', year: 1953, category: 'science', mainPerson: 'Watson & Crick' },
  { id: 'dinosaur-discovery', name: { en: 'First Dinosaur Named', de: 'Erster Dinosaurier benannt', fr: 'Premier dinosaure nommé', it: 'Primo dinosauro classificato' }, shortName: { en: 'Dinosaur Discovery', de: 'Dinosaurier-Entdeckung', fr: 'Découverte dinosaure', it: 'Scoperta dei dinosauri' }, emoji: '🦕', year: 1824, category: 'science', mainPerson: 'William Buckland' },
  { id: 'einstein-relativity', name: { en: 'Einstein Discovers Relativity', de: 'Einstein entdeckt die Relativität', fr: 'Einstein découvre la relativité', it: 'Einstein scopre la relatività' }, shortName: { en: 'Einstein\'s Theory', de: 'Einsteins Theorie', fr: 'Théorie d\'Einstein', it: 'Teoria di Einstein' }, emoji: '🧠', year: 1905, category: 'science', mainPerson: 'Albert Einstein' },
  { id: 'galapagos-darwin', name: { en: 'Darwin Visits the Galápagos', de: 'Darwin besucht die Galápagos', fr: 'Darwin visite les Galápagos', it: 'Darwin visita le Galápagos' }, shortName: { en: 'Darwin\'s Voyage', de: 'Darwins Reise', fr: 'Voyage de Darwin', it: 'Viaggio di Darwin' }, emoji: '🐢', year: 1835, category: 'science', mainPerson: 'Charles Darwin' },
  { id: 'first-heart-transplant', name: { en: 'First Heart Transplant', de: 'Erste Herztransplantation', fr: 'Première greffe cardiaque', it: 'Primo trapianto di cuore' }, shortName: { en: 'Heart Transplant', de: 'Herztransplantation', fr: 'Greffe cardiaque', it: 'Trapianto di cuore' }, emoji: '❤️', year: 1967, category: 'science', mainPerson: 'Christiaan Barnard' },
  { id: 'human-genome', name: { en: 'Human Genome Decoded', de: 'Menschliches Genom entschlüsselt', fr: 'Génome humain décodé', it: 'Decodificato il genoma umano' }, shortName: { en: 'Genome Project', de: 'Genom-Projekt', fr: 'Projet Génome', it: 'Progetto Genoma' }, emoji: '🧪', year: 2003, category: 'science' },
  { id: 'hubble-launch', name: { en: 'Hubble Telescope Launch', de: 'Hubble-Teleskop Start', fr: 'Lancement télescope Hubble', it: 'Lancio del telescopio Hubble' }, shortName: { en: 'Hubble Telescope', de: 'Hubble-Teleskop', fr: 'Télescope Hubble', it: 'Telescopio Hubble' }, emoji: '🔭', year: 1990, category: 'science' },

  // Inventions
  { id: 'telephone-invention', name: { en: 'First Telephone Call', de: 'Erster Telefonanruf', fr: 'Premier appel téléphonique', it: 'Prima chiamata telefonica' }, shortName: { en: 'Telephone', de: 'Telefon', fr: 'Téléphone', it: 'Telefono' }, emoji: '📞', year: 1876, category: 'invention', mainPerson: 'Alexander Graham Bell' },
  { id: 'light-bulb', name: { en: 'Edison\'s Light Bulb', de: 'Edisons Glühbirne', fr: 'Ampoule d\'Edison', it: 'La lampadina di Edison' }, shortName: { en: 'Light Bulb', de: 'Glühbirne', fr: 'Ampoule', it: 'Lampadina' }, emoji: '💡', year: 1879, category: 'invention', mainPerson: 'Thomas Edison' },
  { id: 'printing-press', name: { en: 'Gutenberg Invents the Printing Press', de: 'Gutenberg erfindet den Buchdruck', fr: 'Gutenberg invente l\'imprimerie', it: 'Gutenberg inventa la stampa a caratteri mobili' }, shortName: { en: 'Printing Press', de: 'Buchdruck', fr: 'Imprimerie', it: 'Stampa' }, emoji: '📖', year: 1440, category: 'invention', mainPerson: 'Johannes Gutenberg' },
  { id: 'internet-creation', name: { en: 'Birth of the World Wide Web', de: 'Geburt des World Wide Web', fr: 'Naissance du Web', it: 'Nascita del World Wide Web' }, shortName: { en: 'The Web', de: 'Das Internet', fr: 'Le Web', it: 'Il Web' }, emoji: '🌐', year: 1991, category: 'invention', mainPerson: 'Tim Berners-Lee' },

  // Human Rights & Freedom
  { id: 'emancipation', name: { en: 'Abolition of Slavery', de: 'Abschaffung der Sklaverei', fr: 'Abolition de l\'esclavage', it: 'Abolizione della schiavitù' }, shortName: { en: 'End of Slavery', de: 'Ende der Sklaverei', fr: 'Fin de l\'esclavage', it: 'Fine della schiavitù' }, emoji: '⛓️', year: 1865, category: 'rights', mainPerson: 'Abraham Lincoln' },
  { id: 'womens-suffrage', name: { en: 'Women Win the Vote', de: 'Frauenwahlrecht', fr: 'Droit de vote des femmes', it: 'Le donne ottengono il voto' }, shortName: { en: 'Women\'s Vote', de: 'Frauenwahlrecht', fr: 'Vote des femmes', it: 'Voto delle donne' }, emoji: '🗳️', year: 1920, category: 'rights' },
  { id: 'rosa-parks', name: { en: 'Rosa Parks & Bus Boycott', de: 'Rosa Parks & Busboykott', fr: 'Rosa Parks & Boycott des bus', it: 'Rosa Parks e il boicottaggio degli autobus' }, shortName: { en: 'Rosa Parks', de: 'Rosa Parks', fr: 'Rosa Parks', it: 'Rosa Parks' }, emoji: '🚌', year: 1955, category: 'rights', mainPerson: 'Rosa Parks' },
  { id: 'berlin-wall-fall', name: { en: 'Fall of the Berlin Wall', de: 'Fall der Berliner Mauer', fr: 'Chute du mur de Berlin', it: 'Caduta del muro di Berlino' }, shortName: { en: 'Berlin Wall Fall', de: 'Fall der Berliner Mauer', fr: 'Chute du Mur de Berlin', it: 'Caduta del muro' }, emoji: '🧱', year: 1989, category: 'rights' },
  { id: 'mandela-freedom', name: { en: 'Mandela Wins Freedom', de: 'Mandela erringt die Freiheit', fr: 'Mandela gagne sa liberté', it: 'Mandela conquista la libertà' }, shortName: { en: 'Mandela Free', de: 'Mandela frei', fr: 'Mandela libre', it: 'Mandela libero' }, emoji: '✊', year: 1990, category: 'rights', mainPerson: 'Nelson Mandela' },

  // Great Constructions
  { id: 'pyramids', name: { en: 'Building the Great Pyramids', de: 'Bau der Pyramiden', fr: 'Construction des Pyramides', it: 'Costruzione delle grandi piramidi' }, shortName: { en: 'The Pyramids', de: 'Die Pyramiden', fr: 'Les Pyramides', it: 'Le Piramidi' }, emoji: '🔺', year: '-2560', category: 'construction' },
  { id: 'eiffel-tower', name: { en: 'Eiffel Tower Opens', de: 'Eiffelturm eröffnet', fr: 'Tour Eiffel inaugurée', it: 'Inaugurazione della Torre Eiffel' }, shortName: { en: 'Eiffel Tower', de: 'Eiffelturm', fr: 'Tour Eiffel', it: 'Torre Eiffel' }, emoji: '🗼', year: 1889, category: 'construction', mainPerson: 'Gustave Eiffel' },
  { id: 'panama-canal', name: { en: 'Panama Canal Opens', de: 'Panamakanal eröffnet', fr: 'Canal de Panama inauguré', it: 'Apertura del Canale di Panama' }, shortName: { en: 'Panama Canal', de: 'Panamakanal', fr: 'Canal de Panama', it: 'Canale di Panama' }, emoji: '🚢', year: 1914, category: 'construction' },
  { id: 'golden-gate', name: { en: 'Building the Golden Gate Bridge', de: 'Bau der Golden Gate Bridge', fr: 'Construction du pont Golden Gate', it: 'Costruzione del Golden Gate Bridge' }, shortName: { en: 'Golden Gate Bridge', de: 'Bau der Golden Gate Bridge', fr: 'Pont Golden Gate', it: 'Golden Gate Bridge' }, emoji: '🌉', year: 1937, category: 'construction' },
  { id: 'channel-tunnel', name: { en: 'Channel Tunnel Opens', de: 'Eurotunnel eröffnet', fr: 'Tunnel sous la Manche', it: 'Apertura dell\'Eurotunnel' }, shortName: { en: 'Chunnel', de: 'Eurotunnel', fr: 'Eurotunnel', it: 'Eurotunnel' }, emoji: '🚇', year: 1994, category: 'construction' },

  // Culture & Arts
  { id: 'first-olympics', name: { en: 'First Modern Olympics', de: 'Erste moderne Olympiade', fr: 'Premiers Jeux Olympiques modernes', it: 'Prime Olimpiadi moderne' }, shortName: { en: 'Modern Olympics', de: 'Moderne Olympiade', fr: 'Jeux modernes', it: 'Olimpiadi moderne' }, emoji: '🏅', year: 1896, category: 'culture' },
  { id: 'disneyland-opening', name: { en: 'Disneyland Opens', de: 'Disneyland eröffnet', fr: 'Disneyland ouvre', it: 'Apertura di Disneyland' }, shortName: { en: 'Disneyland', de: 'Disneyland', fr: 'Disneyland', it: 'Disneyland' }, emoji: '🏰', year: 1955, category: 'culture', mainPerson: 'Walt Disney' },
  { id: 'first-movie', name: { en: 'Birth of Cinema', de: 'Geburt des Kinos', fr: 'Naissance du cinéma', it: 'Nascita del cinema' }, shortName: { en: 'First Movies', de: 'Erste Filme', fr: 'Premiers films', it: 'Primi film' }, emoji: '🎬', year: 1895, category: 'culture', mainPerson: 'Lumière Brothers' },
  { id: 'first-zoo', name: { en: 'First Modern Zoo Opens', de: 'Erster moderner Zoo', fr: 'Premier zoo moderne', it: 'Apertura del primo zoo moderno' }, shortName: { en: 'London Zoo', de: 'London Zoo', fr: 'Zoo de Londres', it: 'Zoo di Londra' }, emoji: '🦁', year: 1828, category: 'culture' },
  { id: 'natural-history-museum', name: { en: 'Natural History Museum Opens', de: 'Naturhistorisches Museum', fr: 'Musée d\'Histoire Naturelle', it: 'Apertura del Museo di Storia Naturale' }, shortName: { en: 'Natural History Museum', de: 'Naturkundemuseum', fr: 'Musée Histoire Naturelle', it: 'Museo di Storia Naturale' }, emoji: '🏛️', year: 1881, category: 'culture' },

  // Archaeological Discoveries
  { id: 'king-tut', name: { en: 'King Tut\'s Tomb Discovered', de: 'Tutanchamuns Grab entdeckt', fr: 'Tombeau de Toutânkhamon', it: 'Scoperta della tomba di Tutankhamon' }, shortName: { en: 'King Tut', de: 'Tutanchamun', fr: 'Toutânkhamon', it: 'Tutankhamon' }, emoji: '👑', year: 1922, category: 'archaeology', mainPerson: 'Howard Carter' },
  { id: 'pompeii-discovery', name: { en: 'Rediscovery of Pompeii', de: 'Wiederentdeckung von Pompeji', fr: 'Redécouverte de Pompéi', it: 'Riscoperta di Pompei' }, shortName: { en: 'Pompeii', de: 'Pompeji', fr: 'Pompéi', it: 'Pompei' }, emoji: '🌋', year: 1748, category: 'archaeology' },
  { id: 'terracotta-army', name: { en: 'Terracotta Army Discovered', de: 'Terrakotta-Armee entdeckt', fr: 'Armée de terre cuite', it: 'Scoperta dell\'esercito di terracotta' }, shortName: { en: 'Terracotta Army', de: 'Terrakotta-Armee', fr: 'Armée terre cuite', it: 'Esercito di terracotta' }, emoji: '🗿', year: 1974, category: 'archaeology' },
];

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

export function getStoryTypesByGroup(groupId: AdventureThemeGroupId): StoryType[] {
  if (groupId === 'popular') {
    return popularAdventureThemeIds.map(id => storyTypes.find(t => t.id === id)).filter((t): t is StoryType => !!t);
  }
  return storyTypes.filter(t => t.group === groupId);
}

export function getLifeChallengesByGroup(groupId: string): LifeChallenge[] {
  if (groupId === 'popular') {
    return popularLifeChallengeIds.map(id => lifeChallenges.find(c => c.id === id)).filter((c): c is LifeChallenge => !!c);
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
    return popularHistoricalEventIds.map(id => historicalEvents.find(e => e.id === id)).filter((e): e is HistoricalEvent => !!e);
  }
  return historicalEvents.filter(e => e.category === groupId);
}

export function getHistoricalEventById(id: string): HistoricalEvent | undefined {
  return historicalEvents.find(e => e.id === id);
}
