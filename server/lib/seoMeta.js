// server/lib/seoMeta.js — SEO meta tag injection, sitemap generation, and route metadata
// CommonJS module for server-side use

const fs = require('fs');
const path = require('path');

const BASE_URL = 'https://magicalstory.ch';

// ─── Swiss City Data (loaded from JSON for /stadt routes) ────────────────────

let SWISS_CITIES = [];
try {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/swiss-cities.json'), 'utf-8'));
  SWISS_CITIES = raw.cities || [];
} catch (_) { /* data file optional */ }

// ─── Theme Data (id → { en, de, fr }) ────────────────────────────────────────

const THEME_CATEGORIES = {
  adventure: { en: 'Adventure Stories', de: 'Abenteuer-Geschichten', fr: "Histoires d'Aventure" },
  'life-challenges': { en: 'Life Challenge Stories', de: 'Lebensherausforderungen-Geschichten', fr: 'Histoires de Défis de Vie' },
  educational: { en: 'Educational Stories', de: 'Lehrreiche Geschichten', fr: 'Histoires Éducatives' },
  historical: { en: 'Historical Stories', de: 'Historische Geschichten', fr: 'Histoires Historiques' },
};

const THEMES = {
  adventure: {
    pirate: { en: 'Pirate Adventure', de: 'Piraten-Abenteuer', fr: 'Aventure de Pirates' },
    knight: { en: 'Knights & Princess', de: 'Ritter & Prinzessin', fr: 'Chevaliers & Princesse' },
    cowboy: { en: 'Cowboys & Indians', de: 'Cowboys und Indianer', fr: 'Cowboys et Indiens' },
    ninja: { en: 'Secret Ninja', de: 'Geheimer Ninja', fr: 'Ninja Secret' },
    viking: { en: 'Viking Adventure', de: 'Wikinger-Abenteuer', fr: 'Aventure Viking' },
    roman: { en: 'Ancient Rome', de: 'Antikes Rom', fr: 'Rome Antique' },
    egyptian: { en: 'Ancient Egypt', de: 'Altes Ägypten', fr: 'Égypte Ancienne' },
    greek: { en: 'Ancient Greece', de: 'Antikes Griechenland', fr: 'Grèce Antique' },
    caveman: { en: 'Stone Age', de: 'Steinzeit', fr: 'Âge de Pierre' },
    samurai: { en: 'Samurai Adventure', de: 'Samurai-Abenteuer', fr: 'Aventure Samouraï' },
    wizard: { en: 'Wizard & Witch', de: 'Zauberer & Hexe', fr: 'Sorcier & Sorcière' },
    dragon: { en: 'Dragon Quest', de: 'Drachen-Abenteuer', fr: 'Quête du Dragon' },
    unicorn: { en: 'Magical Unicorn', de: 'Magisches Einhorn', fr: 'Licorne Magique' },
    mermaid: { en: 'Mermaid Adventure', de: 'Meerjungfrauen-Abenteuer', fr: 'Aventure de Sirène' },
    dinosaur: { en: 'Dinosaur World', de: 'Dinosaurier-Welt', fr: 'Monde des Dinosaures' },
    superhero: { en: 'Superhero', de: 'Superheld', fr: 'Super-héros' },
    space: { en: 'Space Explorer', de: 'Weltraum-Entdecker', fr: 'Explorateur Spatial' },
    ocean: { en: 'Ocean Explorer', de: 'Ozean-Entdecker', fr: 'Explorateur des Océans' },
    jungle: { en: 'Jungle Safari', de: 'Dschungel-Safari', fr: 'Safari dans la Jungle' },
    farm: { en: 'Farm Life', de: 'Bauernhof-Leben', fr: 'Vie à la Ferme' },
    forest: { en: 'Forest Friends', de: 'Waldfreunde', fr: 'Amis de la Forêt' },
    fireman: { en: 'Brave Firefighter', de: 'Tapferer Feuerwehrmann', fr: 'Pompier Courageux' },
    doctor: { en: 'Helpful Doctor', de: 'Hilfreicher Arzt', fr: 'Docteur Serviable' },
    police: { en: 'Police Officer', de: 'Polizist', fr: 'Policier' },
    detective: { en: 'Detective Mystery', de: 'Detektiv-Geheimnis', fr: 'Mystère Détective' },
    christmas: { en: 'Christmas Story', de: 'Weihnachts-Geschichte', fr: 'Histoire de Noël' },
    newyear: { en: 'New Year Story', de: 'Neujahrs-Geschichte', fr: 'Histoire du Nouvel An' },
    easter: { en: 'Easter Story', de: 'Oster-Geschichte', fr: 'Histoire de Pâques' },
    halloween: { en: 'Halloween Story', de: 'Halloween-Geschichte', fr: "Histoire d'Halloween" },
  },
  'life-challenges': {
    'potty-training': { en: 'Potty Training', de: 'Töpfchen-Training', fr: "Apprentissage du pot" },
    'washing-hands': { en: 'Washing Hands', de: 'Hände waschen', fr: 'Se laver les mains' },
    'brushing-teeth': { en: 'Brushing Teeth', de: 'Zähne putzen', fr: 'Se brosser les dents' },
    'eating-vegetables': { en: 'Eating Vegetables', de: 'Gemüse essen', fr: 'Manger des légumes' },
    'going-to-bed': { en: 'Going to Bed', de: 'Ins Bett gehen', fr: 'Aller au lit' },
    'saying-goodbye': { en: 'Saying Goodbye', de: 'Abschied nehmen', fr: 'Dire au revoir' },
    'no-pacifier': { en: 'No More Pacifier', de: 'Ohne Schnuller', fr: 'Plus de tétine' },
    'getting-dressed': { en: 'Getting Dressed by Myself', de: 'Sich alleine anziehen', fr: "S'habiller tout seul" },
    'cleaning-up': { en: 'Cleaning Up Toys', de: 'Aufräumen', fr: 'Ranger les jouets' },
    'sitting-still': { en: 'Sitting Still', de: 'Still sitzen', fr: 'Rester tranquille' },
    sharing: { en: 'Learning to Share', de: 'Teilen lernen', fr: 'Apprendre à partager' },
    'waiting-turn': { en: 'Waiting Your Turn', de: 'Warten können', fr: 'Attendre son tour' },
    'first-kindergarten': { en: 'First Day of Kindergarten', de: 'Erster Kindergartentag', fr: 'Premier jour de maternelle' },
    'making-friends': { en: 'Making Real Friends', de: 'Echte Freunde finden', fr: 'Se faire de vrais amis' },
    'being-brave': { en: 'Being Brave', de: 'Mutig sein', fr: 'Être courageux' },
    'new-sibling': { en: 'New Baby Sibling', de: 'Neues Geschwisterchen', fr: 'Nouveau bébé dans la famille' },
    'managing-emotions': { en: 'Managing Big Emotions', de: 'Grosse Gefühle bewältigen', fr: 'Gérer les grandes émotions' },
    'first-school': { en: 'First Day of School', de: 'Erster Schultag', fr: "Premier jour d'école" },
    homework: { en: 'Doing Homework', de: 'Hausaufgaben machen', fr: 'Faire ses devoirs' },
    'losing-game': { en: 'Losing a Game', de: 'Verlieren können', fr: 'Savoir perdre' },
    'being-different': { en: 'Being Yourself', de: 'Du selbst sein', fr: 'Être soi-même' },
    'dealing-bully': { en: 'Standing Up for Yourself', de: 'Für sich einstehen', fr: "S'affirmer face aux autres" },
    'telling-truth': { en: 'Telling the Truth', de: 'Die Wahrheit sagen', fr: 'Dire la vérité' },
    'moving-house': { en: 'Moving to a New Home', de: 'Umzug', fr: 'Déménagement' },
    'parents-splitting': { en: 'Parents Living Apart', de: 'Eltern leben getrennt', fr: 'Parents séparés' },
    'visiting-doctor': { en: 'Going to the Doctor', de: 'Arztbesuch', fr: 'Visite chez le médecin' },
    'staying-hospital': { en: 'Staying in Hospital', de: 'Im Krankenhaus', fr: "Séjour à l'hôpital" },
    'death-pet': { en: 'Losing a Pet', de: 'Haustier verlieren', fr: "Perte d'un animal" },
    'screen-time': { en: 'Screen Time Balance', de: 'Bildschirmzeit-Balance', fr: "Équilibre du temps d'écran" },
    'peer-pressure': { en: 'Peer Pressure', de: 'Gruppenzwang', fr: 'Pression des pairs' },
    'anxiety-worrying': { en: 'Worry & Anxiety', de: 'Sorgen & Ängste', fr: 'Soucis & Anxiété' },
    'sibling-fighting': { en: 'Getting Along with Siblings', de: 'Geschwisterstreit', fr: "S'entendre avec ses frères et sœurs" },
    jealousy: { en: 'Dealing with Jealousy', de: 'Mit Eifersucht umgehen', fr: 'Gérer la jalousie' },
    'not-giving-up': { en: 'Not Giving Up', de: 'Nicht aufgeben', fr: 'Ne pas abandonner' },
    'being-left-out': { en: 'Being Left Out', de: 'Ausgeschlossen werden', fr: "Être mis à l'écart" },
    whining: { en: 'Using a Nice Voice', de: 'Nicht jammern', fr: 'Parler sans pleurnicher' },
    'saying-sorry': { en: 'Saying Sorry & Meaning It', de: 'Sich aufrichtig entschuldigen', fr: "S'excuser sincèrement" },
    'picky-eating': { en: 'Trying New Foods', de: 'Neues Essen probieren', fr: 'Goûter de nouveaux aliments' },
    'table-manners': { en: 'Table Manners', de: 'Tischmanieren', fr: 'Bonnes manières à table' },
    'being-patient': { en: 'Learning to Be Patient', de: 'Geduld lernen', fr: 'Apprendre la patience' },
    'reading-alone': { en: 'Learning to Read', de: 'Lesen lernen', fr: 'Apprendre à lire' },
    'trying-new-things': { en: 'Growing & Learning', de: 'Wachsen & Lernen', fr: 'Grandir & Apprendre' },
    'understanding-rules': { en: 'Why Parents Say No', de: 'Warum Eltern Nein sagen', fr: 'Pourquoi les parents disent non' },
    'tattling-vs-telling': { en: 'Tattling vs Telling', de: 'Petzen vs Um Hilfe bitten', fr: "Rapporter vs Demander de l'aide" },
    'dealing-disappointment': { en: 'Dealing with Disappointment', de: 'Mit Enttäuschung umgehen', fr: 'Gérer la déception' },
    'taking-care-belongings': { en: 'Taking Care of Things', de: 'Auf Sachen aufpassen', fr: 'Prendre soin de ses affaires' },
    'helping-at-home': { en: 'Helping at Home', de: 'Im Haushalt helfen', fr: 'Aider à la maison' },
    'caring-for-pet': { en: 'Caring for a Pet', de: 'Sich um ein Haustier kümmern', fr: "Prendre soin d'un animal" },
    'going-vacation': { en: 'Going on Vacation', de: 'In den Urlaub fahren', fr: 'Partir en vacances' },
    'grandparent-sick': { en: 'Grandparent is Sick', de: 'Grosseltern sind krank', fr: 'Grand-parent malade' },
    'money-saving': { en: 'Saving Money', de: 'Geld sparen', fr: "Économiser de l'argent" },
    'spending-wisely': { en: 'Spending Wisely', de: 'Klug ausgeben', fr: 'Dépenser intelligemment' },
    'body-changes': { en: 'Body Changes', de: 'Körperliche Veränderungen', fr: 'Changements corporels' },
    responsibility: { en: 'Taking Responsibility', de: 'Verantwortung übernehmen', fr: 'Prendre ses responsabilités' },
    'managing-time': { en: 'Managing Time', de: 'Zeitmanagement', fr: 'Gestion du temps' },
    'online-safety': { en: 'Online Safety', de: 'Sicherheit im Internet', fr: 'Sécurité en ligne' },
    'being-active': { en: 'Being Active & Going Outdoors', de: 'Aktiv sein & Rausgehen', fr: 'Être actif & Sortir dehors' },
    'comparing-others': { en: 'Comparing Yourself to Others', de: 'Sich mit anderen vergleichen', fr: 'Se comparer aux autres' },
    'test-stress': { en: 'Test & Exam Stress', de: 'Prüfungsangst', fr: 'Stress des examens' },
  },
  educational: {
    alphabet: { en: 'The Alphabet (ABC)', de: 'Das Alphabet (ABC)', fr: "L'Alphabet (ABC)" },
    vowels: { en: 'Vowels', de: 'Vokale', fr: 'Voyelles' },
    rhyming: { en: 'Rhyming Words', de: 'Reimwörter', fr: 'Mots qui riment' },
    'numbers-1-10': { en: 'Numbers 1-10', de: 'Zahlen 1-10', fr: 'Nombres 1-10' },
    'numbers-1-20': { en: 'Numbers 1-20', de: 'Zahlen 1-20', fr: 'Nombres 1-20' },
    counting: { en: 'Learning to Count', de: 'Zählen lernen', fr: 'Apprendre à compter' },
    shapes: { en: 'Shapes', de: 'Formen', fr: 'Formes' },
    addition: { en: 'Simple Addition', de: 'Einfaches Addieren', fr: 'Addition simple' },
    'colors-basic': { en: 'Basic Colors', de: 'Grundfarben', fr: 'Couleurs de base' },
    'colors-mixing': { en: 'Mixing Colors', de: 'Farben mischen', fr: 'Mélanger les couleurs' },
    planets: { en: 'Planets & Space', de: 'Planeten & Weltraum', fr: 'Planètes & Espace' },
    seasons: { en: 'The Four Seasons', de: 'Die vier Jahreszeiten', fr: 'Les quatre saisons' },
    weather: { en: 'Weather', de: 'Wetter', fr: 'Météo' },
    'water-cycle': { en: 'Water Cycle', de: 'Wasserkreislauf', fr: "Cycle de l'eau" },
    'plants-grow': { en: 'How Plants Grow', de: 'Wie Pflanzen wachsen', fr: 'Comment poussent les plantes' },
    'day-night': { en: 'Day and Night', de: 'Tag und Nacht', fr: 'Jour et nuit' },
    'farm-animals': { en: 'Farm Animals', de: 'Bauernhoftiere', fr: 'Animaux de la ferme' },
    'wild-animals': { en: 'Wild Animals', de: 'Wilde Tiere', fr: 'Animaux sauvages' },
    'ocean-animals': { en: 'Ocean Animals', de: 'Meerestiere', fr: 'Animaux marins' },
    insects: { en: 'Insects & Bugs', de: 'Insekten & Käfer', fr: 'Insectes' },
    dinosaurs: { en: 'Dinosaurs', de: 'Dinosaurier', fr: 'Dinosaures' },
    'body-parts': { en: 'Body Parts', de: 'Körperteile', fr: 'Parties du corps' },
    'five-senses': { en: 'The Five Senses', de: 'Die fünf Sinne', fr: 'Les cinq sens' },
    'healthy-eating': { en: 'Healthy Eating', de: 'Gesund essen', fr: 'Manger sainement' },
    'days-week': { en: 'Days of the Week', de: 'Wochentage', fr: 'Jours de la semaine' },
    'months-year': { en: 'Months of the Year', de: 'Monate des Jahres', fr: "Mois de l'année" },
    'telling-time': { en: 'Telling Time', de: 'Uhr lesen', fr: "Lire l'heure" },
    continents: { en: 'Continents', de: 'Kontinente', fr: 'Continents' },
    'countries-flags': { en: 'Countries & Flags', de: 'Länder & Flaggen', fr: 'Pays & Drapeaux' },
    instruments: { en: 'Musical Instruments', de: 'Musikinstrumente', fr: 'Instruments de musique' },
    'famous-artists': { en: 'Famous Artists', de: 'Berühmte Künstler', fr: 'Artistes célèbres' },
  },
  historical: {
    'swiss-founding': { en: 'Founding of Switzerland', de: 'Gründung der Schweiz', fr: 'Fondation de la Suisse' },
    'wilhelm-tell': { en: 'Wilhelm Tell and the Apple', de: 'Wilhelm Tell und der Apfel', fr: 'Guillaume Tell et la pomme' },
    'battle-morgarten': { en: 'Battle of Morgarten', de: 'Schlacht am Morgarten', fr: 'Bataille de Morgarten' },
    'battle-sempach': { en: 'Battle of Sempach', de: 'Schlacht bei Sempach', fr: 'Bataille de Sempach' },
    'swiss-reformation': { en: 'Swiss Reformation', de: 'Schweizer Reformation', fr: 'Réforme Suisse' },
    'red-cross-founding': { en: 'Henry Dunant Founds the Red Cross', de: 'Henry Dunant gründet das Rote Kreuz', fr: 'Henry Dunant fonde la Croix-Rouge' },
    'general-dufour': { en: 'General Dufour and Swiss Unity', de: 'General Dufour und die Schweizer Einheit', fr: "Général Dufour et l'unité suisse" },
    'sonderbund-war': { en: 'The Sonderbund War', de: 'Der Sonderbundskrieg', fr: 'La Guerre du Sonderbund' },
    'swiss-constitution': { en: 'Swiss Federal Constitution', de: 'Schweizerische Bundesverfassung', fr: 'Constitution fédérale suisse' },
    'gotthard-tunnel': { en: 'Building the Gotthard Tunnel', de: 'Bau des Gotthardtunnels', fr: 'Construction du tunnel du Gothard' },
    'swiss-ww1-neutrality': { en: 'Swiss Neutrality in WWI', de: 'Schweizer Neutralität im 1. Weltkrieg', fr: 'Neutralité suisse pendant la Première Guerre' },
    'general-guisan': { en: 'General Guisan and the Rütli Report', de: 'General Guisan und der Rütlirapport', fr: 'Général Guisan et le Rapport du Grütli' },
    'swiss-ww2-neutrality': { en: 'Switzerland in World War II', de: 'Die Schweiz im 2. Weltkrieg', fr: 'La Suisse pendant la Seconde Guerre' },
    'swiss-womens-vote': { en: 'Swiss Women Win the Vote', de: 'Schweizer Frauenstimmrecht', fr: 'Droit de vote des femmes suisses' },
    'moon-landing': { en: 'Neil Armstrong Lands on the Moon', de: 'Neil Armstrong landet auf dem Mond', fr: 'Neil Armstrong marche sur la Lune' },
    'columbus-voyage': { en: 'Columbus Reaches the Americas', de: 'Kolumbus erreicht Amerika', fr: 'Colomb atteint les Amériques' },
    'wright-brothers': { en: 'Wright Brothers Invent Powered Flight', de: 'Gebrüder Wright erfinden den Motorflug', fr: 'Les frères Wright inventent le vol motorisé' },
    'lindbergh-flight': { en: 'Lindbergh Crosses the Atlantic Solo', de: 'Lindbergh überquert den Atlantik allein', fr: "Lindbergh traverse l'Atlantique en solo" },
    'everest-summit': { en: 'Hillary & Tenzing Summit Everest', de: 'Hillary & Tenzing besteigen den Everest', fr: "Hillary & Tenzing au sommet de l'Everest" },
    'south-pole': { en: 'First to the South Pole', de: 'Erster am Südpol', fr: 'Premier au Pôle Sud' },
    'magellan-circumnavigation': { en: 'First Circumnavigation', de: 'Erste Weltumsegelung', fr: 'Premier tour du monde' },
    'mariana-trench': { en: 'Deepest Ocean Dive', de: 'Tiefster Meerstauchgang', fr: 'Plongée la plus profonde' },
    'electricity-discovery': { en: "Franklin's Kite Experiment", de: 'Franklins Drachenexperiment', fr: 'Expérience du cerf-volant' },
    penicillin: { en: 'Discovery of Penicillin', de: 'Entdeckung des Penicillins', fr: 'Découverte de la pénicilline' },
    'vaccine-discovery': { en: 'First Vaccine', de: 'Erste Impfung', fr: 'Premier vaccin' },
    'dna-discovery': { en: 'DNA Structure Discovered', de: 'DNA-Struktur entdeckt', fr: 'Structure ADN découverte' },
    'dinosaur-discovery': { en: 'First Dinosaur Named', de: 'Erster Dinosaurier benannt', fr: 'Premier dinosaure nommé' },
    'einstein-relativity': { en: 'Einstein Discovers Relativity', de: 'Einstein entdeckt die Relativität', fr: 'Einstein découvre la relativité' },
    'galapagos-darwin': { en: 'Darwin Visits the Galápagos', de: 'Darwin besucht die Galápagos', fr: 'Darwin visite les Galápagos' },
    'first-heart-transplant': { en: 'First Heart Transplant', de: 'Erste Herztransplantation', fr: 'Première greffe cardiaque' },
    'human-genome': { en: 'Human Genome Decoded', de: 'Menschliches Genom entschlüsselt', fr: 'Génome humain décodé' },
    'hubble-launch': { en: 'Hubble Telescope Launch', de: 'Hubble-Teleskop Start', fr: 'Lancement télescope Hubble' },
    'telephone-invention': { en: 'First Telephone Call', de: 'Erster Telefonanruf', fr: 'Premier appel téléphonique' },
    'light-bulb': { en: "Edison's Light Bulb", de: 'Edisons Glühbirne', fr: "Ampoule d'Edison" },
    'printing-press': { en: 'Gutenberg Invents the Printing Press', de: 'Gutenberg erfindet den Buchdruck', fr: "Gutenberg invente l'imprimerie" },
    'internet-creation': { en: 'Birth of the World Wide Web', de: 'Geburt des World Wide Web', fr: 'Naissance du Web' },
    emancipation: { en: 'Abolition of Slavery', de: 'Abschaffung der Sklaverei', fr: "Abolition de l'esclavage" },
    'womens-suffrage': { en: 'Women Win the Vote', de: 'Frauenwahlrecht', fr: 'Droit de vote des femmes' },
    'rosa-parks': { en: 'Rosa Parks & Bus Boycott', de: 'Rosa Parks & Busboykott', fr: 'Rosa Parks & Boycott des bus' },
    'berlin-wall-fall': { en: 'Fall of the Berlin Wall', de: 'Fall der Berliner Mauer', fr: 'Chute du mur de Berlin' },
    'mandela-freedom': { en: 'Mandela Wins Freedom', de: 'Mandela erringt die Freiheit', fr: 'Mandela gagne sa liberté' },
    pyramids: { en: 'Building the Great Pyramids', de: 'Bau der Pyramiden', fr: 'Construction des Pyramides' },
    'eiffel-tower': { en: 'Eiffel Tower Opens', de: 'Eiffelturm eröffnet', fr: 'Tour Eiffel inaugurée' },
    'panama-canal': { en: 'Panama Canal Opens', de: 'Panamakanal eröffnet', fr: 'Canal de Panama inauguré' },
    'golden-gate': { en: 'Building the Golden Gate Bridge', de: 'Bau der Golden Gate Bridge', fr: 'Construction du pont Golden Gate' },
    'channel-tunnel': { en: 'Channel Tunnel Opens', de: 'Eurotunnel eröffnet', fr: 'Tunnel sous la Manche' },
    'first-olympics': { en: 'First Modern Olympics', de: 'Erste moderne Olympiade', fr: 'Premiers Jeux Olympiques modernes' },
    'disneyland-opening': { en: 'Disneyland Opens', de: 'Disneyland eröffnet', fr: 'Disneyland ouvre' },
    'first-movie': { en: 'Birth of Cinema', de: 'Geburt des Kinos', fr: 'Naissance du cinéma' },
    'first-zoo': { en: 'First Modern Zoo Opens', de: 'Erster moderner Zoo', fr: 'Premier zoo moderne' },
    'natural-history-museum': { en: 'Natural History Museum Opens', de: 'Naturhistorisches Museum', fr: "Musée d'Histoire Naturelle" },
    'king-tut': { en: "King Tut's Tomb Discovered", de: 'Tutanchamuns Grab entdeckt', fr: 'Tombeau de Toutânkhamon' },
    'pompeii-discovery': { en: 'Rediscovery of Pompeii', de: 'Wiederentdeckung von Pompeji', fr: 'Redécouverte de Pompéi' },
    'terracotta-army': { en: 'Terracotta Army Discovered', de: 'Terrakotta-Armee entdeckt', fr: 'Armée de terre cuite' },
  },
};

// ─── Static Route Meta ────────────────────────────────────────────────────────

const STATIC_ROUTES = {
  '/': {
    title: {
      en: 'Magical Story – Your Child as the Hero of Their Own Book',
      de: 'Magical Story – Dein Kind als Held seiner eigenen Geschichte',
      fr: 'Magical Story – Votre enfant héros de son propre livre',
    },
    description: {
      en: 'Your child becomes the hero of a beautifully illustrated story. Upload a photo, pick a theme, and hold a finished book in your hands. First story free.',
      de: 'Dein Kind wird zum Helden einer wunderschön illustrierten Geschichte. Foto hochladen, Thema wählen und ein fertiges Buch in den Händen halten. Erste Geschichte gratis.',
      fr: 'Votre enfant devient le héros d\'une histoire magnifiquement illustrée. Téléchargez une photo, choisissez un thème et tenez un vrai livre entre vos mains. Première histoire gratuite.',
    },
  },
  '/pricing': {
    title: {
      en: 'Pricing – Magical Story',
      de: 'Preise – Magical Story',
      fr: 'Tarifs – Magical Story',
    },
    description: {
      en: 'Your first story is free. Printed books start at CHF 33. View all pricing plans for Magical Story.',
      de: 'Deine erste Geschichte ist gratis. Gedruckte Bücher ab CHF 33. Alle Preise für Magical Story.',
      fr: 'Votre première histoire est gratuite. Livres imprimés dès CHF 33. Tous les tarifs de Magical Story.',
    },
  },
  '/faq': {
    title: {
      en: 'FAQ – Magical Story',
      de: 'Häufige Fragen – Magical Story',
      fr: 'FAQ – Magical Story',
    },
    description: {
      en: 'Frequently asked questions about Magical Story. Learn how personalized children\'s books work, pricing, and more.',
      de: 'Häufig gestellte Fragen zu Magical Story. Erfahre, wie personalisierte Kinderbücher funktionieren, Preise und mehr.',
      fr: 'Questions fréquemment posées sur Magical Story. Découvrez comment fonctionnent les livres personnalisés pour enfants.',
    },
  },
  '/about': {
    title: {
      en: 'About – Magical Story',
      de: 'Über uns – Magical Story',
      fr: 'À propos – Magical Story',
    },
    description: {
      en: 'Magical Story is made in Switzerland. We believe every child deserves to see themselves as the hero of their own story.',
      de: 'Magical Story kommt aus der Schweiz. Wir glauben, dass jedes Kind verdient, der Held seiner eigenen Geschichte zu sein.',
      fr: 'Magical Story est conçu en Suisse. Nous croyons que chaque enfant mérite d\'être le héros de sa propre histoire.',
    },
  },
  '/contact': {
    title: {
      en: 'Contact – Magical Story',
      de: 'Kontakt – Magical Story',
      fr: 'Contact – Magical Story',
    },
    description: {
      en: 'Get in touch with the Magical Story team. We\'re here to help with your personalized children\'s books.',
      de: 'Kontaktiere das Magical Story Team. Wir helfen dir gerne bei deinen personalisierten Kinderbüchern.',
      fr: 'Contactez l\'équipe Magical Story. Nous sommes là pour vous aider avec vos livres personnalisés.',
    },
  },
  '/try': {
    title: {
      en: 'Create Your Free Story – Magical Story',
      de: 'Gratis Geschichte erstellen – Magical Story',
      fr: 'Créez votre histoire gratuite – Magical Story',
    },
    description: {
      en: 'Create your first personalized children\'s story for free. Upload a photo and choose a theme to get started.',
      de: 'Erstelle deine erste personalisierte Kindergeschichte gratis. Foto hochladen und Thema wählen.',
      fr: 'Créez votre première histoire personnalisée gratuitement. Téléchargez une photo et choisissez un thème.',
    },
  },
  '/terms': {
    title: {
      en: 'Terms of Service – Magical Story',
      de: 'Nutzungsbedingungen – Magical Story',
      fr: 'Conditions d\'utilisation – Magical Story',
    },
    description: {
      en: 'Terms of service for Magical Story personalized children\'s books.',
      de: 'Nutzungsbedingungen für Magical Story personalisierte Kinderbücher.',
      fr: 'Conditions d\'utilisation de Magical Story, livres personnalisés pour enfants.',
    },
  },
  '/privacy': {
    title: {
      en: 'Privacy Policy – Magical Story',
      de: 'Datenschutz – Magical Story',
      fr: 'Politique de confidentialité – Magical Story',
    },
    description: {
      en: 'Privacy policy for Magical Story. Learn how we protect your data and photos.',
      de: 'Datenschutzerklärung für Magical Story. Erfahre, wie wir deine Daten und Fotos schützen.',
      fr: 'Politique de confidentialité de Magical Story. Découvrez comment nous protégeons vos données et photos.',
    },
  },
  '/impressum': {
    title: {
      en: 'Impressum – Magical Story',
      de: 'Impressum – Magical Story',
      fr: 'Impressum – Magical Story',
    },
    description: {
      en: 'Legal notice and imprint for Magical Story.',
      de: 'Impressum und rechtliche Hinweise für Magical Story.',
      fr: 'Mentions légales et impressum de Magical Story.',
    },
  },
  '/science': {
    title: {
      en: 'Why Personalized Books Work – The Science | Magical Story',
      de: 'Warum personalisierte Kinderbücher wirken | Magical Story',
      fr: 'Pourquoi les livres personnalisés fonctionnent | Magical Story',
    },
    description: {
      en: 'Children remember more, engage more deeply, and build confidence when they see themselves as the hero. The perfect personalized gift for birthdays and special occasions.',
      de: 'Kinder erinnern sich an mehr, tauchen tiefer ein und bauen Selbstvertrauen auf, wenn sie der Held der Geschichte sind. Das perfekte personalisierte Geschenk für Geburtstage und besondere Anlässe.',
      fr: 'Les enfants retiennent plus, s\'engagent plus profondément et développent leur confiance quand ils sont le héros. Le cadeau personnalisé parfait pour les anniversaires.',
    },
  },
  '/themes': {
    title: {
      en: 'Story Themes – Magical Story',
      de: 'Story-Themen – Magical Story',
      fr: 'Thèmes d\'histoires – Magical Story',
    },
    description: {
      en: 'Browse all story themes: adventure, life challenges, educational, and historical. Create a personalized book for your child.',
      de: 'Alle Story-Themen entdecken: Abenteuer, Lebensherausforderungen, Lehrreiches und Historisches. Ein personalisiertes Buch erstellen.',
      fr: 'Parcourez tous les thèmes: aventure, défis de vie, éducatif et historique. Créez un livre personnalisé pour votre enfant.',
    },
  },
  '/geschichten-aus': {
    title: {
      de: 'Kindergeschichten aus der Schweiz | MagicalStory',
      en: 'Children\'s Stories from Switzerland | MagicalStory',
      fr: 'Histoires pour enfants de Suisse | MagicalStory',
    },
    description: {
      de: 'Personalisierte Kindergeschichten aus 50 Schweizer Städten. Dein Kind erlebt Abenteuer in Zürich, Bern, Basel und mehr.',
      en: 'Personalized children\'s stories from 50 Swiss cities. Your child goes on adventures in Zurich, Bern, Basel and more.',
      fr: 'Histoires personnalisées pour enfants de 50 villes suisses. Votre enfant vit des aventures à Zurich, Berne, Bâle et plus.',
    },
  },
  '/stadt': {
    title: {
      de: 'Kindergeschichten aus der Schweiz — Alle Städte | MagicalStory',
      en: 'Children\'s Stories from Switzerland — All Cities | MagicalStory',
      fr: 'Histoires pour enfants de Suisse — Toutes les villes | MagicalStory',
    },
    description: {
      de: 'Personalisierte Kindergeschichten aus 100 Schweizer Städten. Entdecke Geschichte und Sagen aus deiner Stadt — dein Kind wird zum Helden.',
      en: 'Personalized children\'s stories from 100 Swiss cities. Discover history and legends from your city — your child becomes the hero.',
      fr: 'Histoires personnalisées pour enfants de 100 villes suisses. Découvrez l\'histoire et les légendes de votre ville — votre enfant devient le héros.',
    },
  },
  '/vergleich': {
    title: {
      de: 'MagicalStory im Vergleich | Personalisierte Kinderbücher',
      en: 'MagicalStory Compared | Personalized Children\'s Books',
      fr: 'MagicalStory en comparaison | Livres personnalisés pour enfants',
    },
    description: {
      de: 'Ehrlicher Vergleich von MagicalStory mit Wonderbly, Hooray Heroes, Librio und anderen personalisierten Kinderbuch-Anbietern.',
      en: 'Honest comparison of MagicalStory with Wonderbly, Hooray Heroes, Librio, and other personalized children\'s book providers.',
      fr: 'Comparaison honnête de MagicalStory avec Wonderbly, Hooray Heroes, Librio et d\'autres fournisseurs de livres personnalisés.',
    },
  },
  '/anlass': {
    title: {
      de: 'Das perfekte Geschenk für jeden Anlass | MagicalStory',
      en: 'The Perfect Gift for Every Occasion | MagicalStory',
      fr: 'Le cadeau parfait pour chaque occasion | MagicalStory',
    },
    description: {
      de: 'Personalisierte Kinderbücher als Geschenk: Geburtstag, Weihnachten, Taufe, Einschulung und mehr. Erste Geschichte gratis.',
      en: 'Personalized children\'s books as gifts: birthdays, Christmas, baptism, first day of school and more. First story free.',
      fr: 'Livres personnalisés comme cadeau: anniversaire, Noël, baptême, rentrée et plus. Première histoire gratuite.',
    },
  },
  '/geschenk': {
    title: {
      de: 'Geschenkideen für Kinder | Personalisierte Kinderbücher | MagicalStory',
      en: 'Gift Ideas for Kids | Personalized Children\'s Books | MagicalStory',
      fr: 'Idées cadeaux pour enfants | Livres personnalisés | MagicalStory',
    },
    description: {
      de: 'Finde das perfekte Geschenk für Kinder: einzigartige, personalisierte Kinderbücher mit dem Foto deines Kindes. Für Enkel, Patenkinder, zu Weihnachten, Ostern & mehr.',
      en: 'Find the perfect gift for kids: unique, personalized children\'s books with your child\'s photo. For grandkids, godchildren, Christmas, Easter & more.',
      fr: 'Trouvez le cadeau parfait pour enfants: livres personnalisés uniques avec la photo de votre enfant. Pour petits-enfants, filleuls, Noël, Pâques et plus.',
    },
  },
};

// Routes that should have noindex
const NOINDEX_ROUTES = [
  '/create', '/stories', '/orders', '/admin', '/book-builder',
  '/welcome', '/trial-generation', '/claim', '/reset-password', '/email-verified',
];

// ─── Town Data (for meta tags) ────────────────────────────────────────────────

const TOWNS = {
  zuerich: { name: 'Zürich', de: 'Kindergeschichten aus Zürich', en: 'Children\'s Stories from Zurich', fr: 'Histoires pour enfants de Zurich' },
  basel: { name: 'Basel', de: 'Kindergeschichten aus Basel', en: 'Children\'s Stories from Basel', fr: 'Histoires pour enfants de Bâle' },
  bern: { name: 'Bern', de: 'Kindergeschichten aus Bern', en: 'Children\'s Stories from Bern', fr: 'Histoires pour enfants de Berne' },
  luzern: { name: 'Luzern', de: 'Kindergeschichten aus Luzern', en: 'Children\'s Stories from Lucerne', fr: 'Histoires pour enfants de Lucerne' },
  'st-gallen': { name: 'St. Gallen', de: 'Kindergeschichten aus St. Gallen', en: 'Children\'s Stories from St. Gallen', fr: 'Histoires pour enfants de Saint-Gall' },
  winterthur: { name: 'Winterthur', de: 'Kindergeschichten aus Winterthur', en: 'Children\'s Stories from Winterthur', fr: 'Histoires pour enfants de Winterthour' },
  zug: { name: 'Zug', de: 'Kindergeschichten aus Zug', en: 'Children\'s Stories from Zug', fr: 'Histoires pour enfants de Zoug' },
  thun: { name: 'Thun', de: 'Kindergeschichten aus Thun', en: 'Children\'s Stories from Thun', fr: 'Histoires pour enfants de Thoune' },
  aarau: { name: 'Aarau', de: 'Kindergeschichten aus Aarau', en: 'Children\'s Stories from Aarau', fr: 'Histoires pour enfants d\'Aarau' },
  baden: { name: 'Baden', de: 'Kindergeschichten aus Baden', en: 'Children\'s Stories from Baden', fr: 'Histoires pour enfants de Baden' },
  schaffhausen: { name: 'Schaffhausen', de: 'Kindergeschichten aus Schaffhausen', en: 'Children\'s Stories from Schaffhausen', fr: 'Histoires pour enfants de Schaffhouse' },
  olten: { name: 'Olten', de: 'Kindergeschichten aus Olten', en: 'Children\'s Stories from Olten', fr: 'Histoires pour enfants d\'Olten' },
  chur: { name: 'Chur', de: 'Kindergeschichten aus Chur', en: 'Children\'s Stories from Chur', fr: 'Histoires pour enfants de Coire' },
  solothurn: { name: 'Solothurn', de: 'Kindergeschichten aus Solothurn', en: 'Children\'s Stories from Solothurn', fr: 'Histoires pour enfants de Soleure' },
  'rapperswil-jona': { name: 'Rapperswil-Jona', de: 'Kindergeschichten aus Rapperswil-Jona', en: 'Children\'s Stories from Rapperswil-Jona', fr: 'Histoires pour enfants de Rapperswil-Jona' },
  uster: { name: 'Uster', de: 'Kindergeschichten aus Uster', en: 'Children\'s Stories from Uster', fr: 'Histoires pour enfants d\'Uster' },
  davos: { name: 'Davos', de: 'Kindergeschichten aus Davos', en: 'Children\'s Stories from Davos', fr: 'Histoires pour enfants de Davos' },
  interlaken: { name: 'Interlaken', de: 'Kindergeschichten aus Interlaken', en: 'Children\'s Stories from Interlaken', fr: 'Histoires pour enfants d\'Interlaken' },
  koeniz: { name: 'Köniz', de: 'Kindergeschichten aus Köniz', en: 'Children\'s Stories from Köniz', fr: 'Histoires pour enfants de Köniz' },
  emmen: { name: 'Emmen', de: 'Kindergeschichten aus Emmen', en: 'Children\'s Stories from Emmen', fr: 'Histoires pour enfants d\'Emmen' },
  kriens: { name: 'Kriens', de: 'Kindergeschichten aus Kriens', en: 'Children\'s Stories from Kriens', fr: 'Histoires pour enfants de Kriens' },
  horgen: { name: 'Horgen', de: 'Kindergeschichten aus Horgen', en: 'Children\'s Stories from Horgen', fr: 'Histoires pour enfants de Horgen' },
  waedenswil: { name: 'Wädenswil', de: 'Kindergeschichten aus Wädenswil', en: 'Children\'s Stories from Wädenswil', fr: 'Histoires pour enfants de Wädenswil' },
  dietikon: { name: 'Dietikon', de: 'Kindergeschichten aus Dietikon', en: 'Children\'s Stories from Dietikon', fr: 'Histoires pour enfants de Dietikon' },
  duebendorf: { name: 'Dübendorf', de: 'Kindergeschichten aus Dübendorf', en: 'Children\'s Stories from Dübendorf', fr: 'Histoires pour enfants de Dübendorf' },
  kloten: { name: 'Kloten', de: 'Kindergeschichten aus Kloten', en: 'Children\'s Stories from Kloten', fr: 'Histoires pour enfants de Kloten' },
  wetzikon: { name: 'Wetzikon', de: 'Kindergeschichten aus Wetzikon', en: 'Children\'s Stories from Wetzikon', fr: 'Histoires pour enfants de Wetzikon' },
  frauenfeld: { name: 'Frauenfeld', de: 'Kindergeschichten aus Frauenfeld', en: 'Children\'s Stories from Frauenfeld', fr: 'Histoires pour enfants de Frauenfeld' },
  kreuzlingen: { name: 'Kreuzlingen', de: 'Kindergeschichten aus Kreuzlingen', en: 'Children\'s Stories from Kreuzlingen', fr: 'Histoires pour enfants de Kreuzlingen' },
  rheinfelden: { name: 'Rheinfelden', de: 'Kindergeschichten aus Rheinfelden', en: 'Children\'s Stories from Rheinfelden', fr: 'Histoires pour enfants de Rheinfelden' },
  lausanne: { name: 'Lausanne', de: 'Kindergeschichten aus Lausanne', en: 'Children\'s Stories from Lausanne', fr: 'Histoires pour enfants de Lausanne' },
  geneve: { name: 'Genève', de: 'Kindergeschichten aus Genf', en: 'Children\'s Stories from Geneva', fr: 'Histoires pour enfants de Genève' },
  'biel-bienne': { name: 'Biel/Bienne', de: 'Kindergeschichten aus Biel', en: 'Children\'s Stories from Biel', fr: 'Histoires pour enfants de Bienne' },
  fribourg: { name: 'Fribourg', de: 'Kindergeschichten aus Freiburg', en: 'Children\'s Stories from Fribourg', fr: 'Histoires pour enfants de Fribourg' },
  neuchatel: { name: 'Neuchâtel', de: 'Kindergeschichten aus Neuenburg', en: 'Children\'s Stories from Neuchâtel', fr: 'Histoires pour enfants de Neuchâtel' },
  montreux: { name: 'Montreux', de: 'Kindergeschichten aus Montreux', en: 'Children\'s Stories from Montreux', fr: 'Histoires pour enfants de Montreux' },
  nyon: { name: 'Nyon', de: 'Kindergeschichten aus Nyon', en: 'Children\'s Stories from Nyon', fr: 'Histoires pour enfants de Nyon' },
  vevey: { name: 'Vevey', de: 'Kindergeschichten aus Vevey', en: 'Children\'s Stories from Vevey', fr: 'Histoires pour enfants de Vevey' },
  morges: { name: 'Morges', de: 'Kindergeschichten aus Morges', en: 'Children\'s Stories from Morges', fr: 'Histoires pour enfants de Morges' },
  yverdon: { name: 'Yverdon-les-Bains', de: 'Kindergeschichten aus Yverdon', en: 'Children\'s Stories from Yverdon', fr: 'Histoires pour enfants d\'Yverdon' },
  'la-chaux-de-fonds': { name: 'La Chaux-de-Fonds', de: 'Kindergeschichten aus La Chaux-de-Fonds', en: 'Children\'s Stories from La Chaux-de-Fonds', fr: 'Histoires pour enfants de La Chaux-de-Fonds' },
  sion: { name: 'Sion', de: 'Kindergeschichten aus Sitten', en: 'Children\'s Stories from Sion', fr: 'Histoires pour enfants de Sion' },
  sierre: { name: 'Sierre', de: 'Kindergeschichten aus Siders', en: 'Children\'s Stories from Sierre', fr: 'Histoires pour enfants de Sierre' },
  delemont: { name: 'Delémont', de: 'Kindergeschichten aus Delsberg', en: 'Children\'s Stories from Delémont', fr: 'Histoires pour enfants de Delémont' },
  martigny: { name: 'Martigny', de: 'Kindergeschichten aus Martigny', en: 'Children\'s Stories from Martigny', fr: 'Histoires pour enfants de Martigny' },
  lugano: { name: 'Lugano', de: 'Kindergeschichten aus Lugano', en: 'Children\'s Stories from Lugano', fr: 'Histoires pour enfants de Lugano' },
  locarno: { name: 'Locarno', de: 'Kindergeschichten aus Locarno', en: 'Children\'s Stories from Locarno', fr: 'Histoires pour enfants de Locarno' },
  bellinzona: { name: 'Bellinzona', de: 'Kindergeschichten aus Bellinzona', en: 'Children\'s Stories from Bellinzona', fr: 'Histoires pour enfants de Bellinzone' },
  mendrisio: { name: 'Mendrisio', de: 'Kindergeschichten aus Mendrisio', en: 'Children\'s Stories from Mendrisio', fr: 'Histoires pour enfants de Mendrisio' },
  chiasso: { name: 'Chiasso', de: 'Kindergeschichten aus Chiasso', en: 'Children\'s Stories from Chiasso', fr: 'Histoires pour enfants de Chiasso' },
};

// ─── Comparison Data (for meta tags) ──────────────────────────────────────────

const COMPARISONS = {
  wonderbly: { name: 'Wonderbly', de: 'MagicalStory vs Wonderbly', en: 'MagicalStory vs Wonderbly', fr: 'MagicalStory vs Wonderbly' },
  'hooray-heroes': { name: 'Hooray Heroes', de: 'MagicalStory vs Hooray Heroes', en: 'MagicalStory vs Hooray Heroes', fr: 'MagicalStory vs Hooray Heroes' },
  librio: { name: 'Librio', de: 'MagicalStory vs Librio', en: 'MagicalStory vs Librio', fr: 'MagicalStory vs Librio' },
  framily: { name: 'Framily', de: 'MagicalStory vs Framily', en: 'MagicalStory vs Framily', fr: 'MagicalStory vs Framily' },
  'lullaby-ink': { name: 'Lullaby.ink', de: 'MagicalStory vs Lullaby.ink', en: 'MagicalStory vs Lullaby.ink', fr: 'MagicalStory vs Lullaby.ink' },
  lovetoread: { name: 'LoveToRead', de: 'MagicalStory vs LoveToRead', en: 'MagicalStory vs LoveToRead', fr: 'MagicalStory vs LoveToRead' },
  'beste-personalisierte-kinderbuecher': { name: 'Beste Kinderbücher', de: 'Beste personalisierte Kinderbücher Schweiz 2026', en: 'Best Personalized Children\'s Books Switzerland 2026', fr: 'Meilleurs livres personnalisés pour enfants Suisse 2026' },
  'beste-ki-kinderbuch-generatoren': { name: 'Beste KI-Generatoren', de: 'Beste KI-Kinderbuch-Generatoren 2026', en: 'Best AI Children\'s Book Generators 2026', fr: 'Meilleurs générateurs de livres IA pour enfants 2026' },
};

// ─── Occasion Data (for meta tags) ────────────────────────────────────────────

const OCCASIONS = {
  geburtstag: { de: 'Personalisiertes Kinderbuch zum Geburtstag', en: 'Personalized Birthday Book for Kids', fr: 'Livre personnalisé pour anniversaire' },
  weihnachten: { de: 'Personalisiertes Kinderbuch zu Weihnachten', en: 'Personalized Christmas Book for Kids', fr: 'Livre personnalisé pour Noël' },
  ostern: { de: 'Personalisiertes Kinderbuch zu Ostern', en: 'Personalized Easter Book for Kids', fr: 'Livre personnalisé pour Pâques' },
  taufe: { de: 'Personalisiertes Kinderbuch zur Taufe', en: 'Personalized Baptism Book for Kids', fr: 'Livre personnalisé pour le baptême' },
  einschulung: { de: 'Personalisiertes Kinderbuch zur Einschulung', en: 'Personalized First Day of School Book', fr: 'Livre personnalisé pour la rentrée' },
  geschwisterchen: { de: 'Personalisiertes Kinderbuch zum Geschwisterchen', en: 'Personalized New Sibling Book', fr: 'Livre personnalisé nouveau bébé' },
  muttertag: { de: 'Personalisiertes Kinderbuch zum Muttertag', en: 'Personalized Mother\'s Day Book', fr: 'Livre personnalisé fête des mères' },
  vatertag: { de: 'Personalisiertes Kinderbuch zum Vatertag', en: 'Personalized Father\'s Day Book', fr: 'Livre personnalisé fête des pères' },
  nikolaus: { de: 'Personalisiertes Kinderbuch zum Nikolaus', en: 'Personalized St. Nicholas Day Book', fr: 'Livre personnalisé pour la Saint-Nicolas' },
  advent: { de: 'Personalisiertes Kinderbuch zum Advent', en: 'Personalized Advent Book for Kids', fr: 'Livre personnalisé pour l\'Avent' },
  umzug: { de: 'Personalisiertes Kinderbuch zum Umzug', en: 'Personalized Moving House Book', fr: 'Livre personnalisé pour le déménagement' },
  kindergartenstart: { de: 'Personalisiertes Kinderbuch zum Kindergartenstart', en: 'Personalized Starting Kindergarten Book', fr: 'Livre personnalisé pour l\'entrée en maternelle' },
};

// ─── Gift Page Data (for meta tags) ───────────────────────────────────────────

const GIFT_PAGES = {
  'fuer-kinder': { de: 'Einzigartiges Geschenk für Kinder', en: 'Unique Gift for Kids', fr: 'Cadeau unique pour enfants' },
  'fuer-enkel': { de: 'Das perfekte Geschenk für Enkel', en: 'The Perfect Gift for Grandchildren', fr: 'Le cadeau parfait pour les petits-enfants' },
  'fuer-nichte-neffe': { de: 'Geschenk für Nichte & Neffe', en: 'Gift for Niece & Nephew', fr: 'Cadeau pour nièce et neveu' },
  'fuer-patenkind': { de: 'Geschenk für Patenkind', en: 'Gift for Godchild', fr: 'Cadeau pour filleul(e)' },
  'geschenk-von-grosseltern': { de: 'Geschenk von Grosseltern', en: 'Gift from Grandparents', fr: 'Cadeau des grands-parents' },
  'ostergeschenk': { de: 'Ostergeschenk für Kinder', en: 'Easter Gift for Kids', fr: 'Cadeau de Pâques pour enfants' },
  'weihnachtsgeschenk': { de: 'Weihnachtsgeschenk für Kinder', en: 'Christmas Gift for Kids', fr: 'Cadeau de Noël pour enfants' },
  'geburtstagsgeschenk': { de: 'Geburtstagsgeschenk für Kinder', en: 'Birthday Gift for Kids', fr: "Cadeau d'anniversaire pour enfants" },
  'taufgeschenk': { de: 'Taufgeschenk — persönlich & unvergesslich', en: 'Baptism Gift — Personal & Unforgettable', fr: 'Cadeau de baptême — personnel & inoubliable' },
  'einschulungsgeschenk': { de: 'Einschulungsgeschenk für Kinder', en: 'First Day of School Gift', fr: 'Cadeau de rentrée scolaire' },
  'nikolausgeschenk': { de: 'Nikolausgeschenk für Kinder', en: 'St. Nicholas Gift for Kids', fr: 'Cadeau de Saint-Nicolas pour enfants' },
  'einzigartiges-geschenk': { de: 'Einzigartiges Geschenk für Kinder', en: 'Unique Gift for Kids', fr: 'Cadeau unique pour enfants' },
  'personalisiertes-geschenk': { de: 'Personalisiertes Geschenk für Kinder', en: 'Personalized Gift for Kids', fr: 'Cadeau personnalisé pour enfants' },
  'sinnvolles-geschenk': { de: 'Sinnvolles Geschenk für Kinder', en: 'Meaningful Gift for Kids', fr: 'Cadeau éducatif pour enfants' },
  'last-minute-geschenk': { de: 'Last-Minute-Geschenk für Kinder', en: 'Last-Minute Gift for Kids', fr: 'Cadeau de dernière minute pour enfants' },
  'geschenk-3-jahre': { de: 'Geschenk für 3-Jährige', en: 'Gift for 3-Year-Olds', fr: 'Cadeau pour enfant de 3 ans' },
  'geschenk-4-jahre': { de: 'Geschenk für 4-Jährige', en: 'Gift for 4-Year-Olds', fr: 'Cadeau pour enfant de 4 ans' },
  'geschenk-5-jahre': { de: 'Geschenk für 5-Jährige', en: 'Gift for 5-Year-Olds', fr: 'Cadeau pour enfant de 5 ans' },
  'geschenk-6-jahre': { de: 'Geschenk für 6-Jährige', en: 'Gift for 6-Year-Olds', fr: 'Cadeau pour enfant de 6 ans' },
  'geschenk-7-8-jahre': { de: 'Geschenk für 7–8-Jährige', en: 'Gift for 7-8-Year-Olds', fr: 'Cadeau pour enfant de 7-8 ans' },
};

// ─── JSON-LD Schema Templates ─────────────────────────────────────────────────

const ORGANIZATION_JSON_LD = {
  '@context': 'https://schema.org',
  '@type': 'Organization',
  name: 'MagicalStory',
  url: BASE_URL,
  logo: `${BASE_URL}/images/logo.png`,
  description: 'AI-powered personalized children\'s storybooks made in Switzerland. 170+ themes, 8 art styles, 3 languages.',
  foundingLocation: { '@type': 'Place', name: 'Switzerland' },
  sameAs: [],
  contactPoint: {
    '@type': 'ContactPoint',
    contactType: 'customer service',
    url: `${BASE_URL}/contact`,
    availableLanguage: ['German', 'English', 'French'],
  },
};

const PRODUCT_JSON_LD = {
  '@context': 'https://schema.org',
  '@type': 'Product',
  name: 'Personalisiertes Kinderbuch',
  description: 'KI-illustriertes Kinderbuch mit deinem Kind als Held. 170+ Themen, 8 Kunststile, 3 Sprachen.',
  brand: { '@type': 'Brand', name: 'MagicalStory' },
  offers: {
    '@type': 'AggregateOffer',
    lowPrice: '0',
    highPrice: '96',
    priceCurrency: 'CHF',
    availability: 'https://schema.org/InStock',
    offerCount: '170',
  },
  category: 'Personalized Children\'s Books',
};

const FAQ_JSON_LD = {
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  mainEntity: [
    {
      '@type': 'Question',
      name: 'Wie funktioniert MagicalStory?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'Lade ein Foto deines Kindes hoch, wähle ein Story-Thema, und erhalte in wenigen Minuten eine vollständig illustrierte, personalisierte Geschichte. Dein Kind erscheint als Hauptfigur auf jeder Seite.',
      },
    },
    {
      '@type': 'Question',
      name: 'Wie lange dauert es?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'Deine erste kostenlose Geschichte ist in unter 3 Minuten fertig. Text und alle Illustrationen werden automatisch generiert.',
      },
    },
    {
      '@type': 'Question',
      name: 'Für welches Alter ist MagicalStory geeignet?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'Geschichten können für Kinder jeden Alters erstellt werden. Inhalt und Komplexität werden an das angegebene Alter angepasst.',
      },
    },
    {
      '@type': 'Question',
      name: 'Kann ich mehrere Charaktere hinzufügen?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'Ja! Du kannst die ganze Familie, Freunde oder Haustiere als Figuren in der Geschichte hinzufügen. Jeder Charakter bekommt eigene personalisierte Illustrationen.',
      },
    },
    {
      '@type': 'Question',
      name: 'Was kostet MagicalStory?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'Deine erste Geschichte ist komplett gratis. Danach werden Geschichten mit Credits erstellt. Gedruckte Bücher gibt es ab CHF 33 als hochwertiges Hardcover.',
      },
    },
    {
      '@type': 'Question',
      name: 'Sind meine Daten sicher?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'Ja. Deine Fotos werden ausschliesslich zur Erstellung der Illustrationen verwendet und niemals an Dritte weitergegeben. Wir nehmen Datenschutz ernst und halten uns an die Schweizer Datenschutzgesetze.',
      },
    },
  ],
};

function buildBreadcrumbJsonLd(items) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: item.name,
      item: item.url ? `${BASE_URL}${item.url}` : undefined,
    })),
  };
}

function buildProductJsonLdForTheme(themeName, category, themeId) {
  return {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: `Personalisiertes Kinderbuch: ${themeName}`,
    description: `KI-illustriertes ${themeName}-Kinderbuch mit deinem Kind als Held.`,
    brand: { '@type': 'Brand', name: 'MagicalStory' },
    url: `${BASE_URL}/themes/${category}/${themeId}`,
    offers: {
      '@type': 'Offer',
      price: '0',
      priceCurrency: 'CHF',
      availability: 'https://schema.org/InStock',
      description: 'Erste Geschichte kostenlos. Hardcover ab CHF 33.',
    },
    category: 'Personalized Children\'s Books',
  };
}

function buildHowToJsonLd(lang) {
  const steps = {
    de: [
      { name: 'Foto hochladen', text: 'Lade ein Foto deines Kindes hoch. Es wird zum illustrierten Helden der Geschichte.' },
      { name: 'Thema wählen', text: 'Wähle aus über 170 Themen: Abenteuer, Lebensherausforderungen, Lehrreiches oder Historisches.' },
      { name: 'Geschichte erhalten', text: 'Deine personalisierte illustrierte Geschichte ist in Minuten fertig. Online lesen oder als Buch bestellen.' },
    ],
    en: [
      { name: 'Upload a photo', text: 'Upload a photo of your child. They become the illustrated hero of the story.' },
      { name: 'Choose a theme', text: 'Pick from 170+ themes: adventure, life challenges, educational, or historical.' },
      { name: 'Get your story', text: 'Your personalized illustrated story is ready in minutes. Read online or order a printed book.' },
    ],
    fr: [
      { name: 'Télécharger une photo', text: 'Téléchargez une photo de votre enfant. Il devient le héros illustré de l\'histoire.' },
      { name: 'Choisir un thème', text: 'Choisissez parmi 170+ thèmes: aventure, défis de vie, éducatif ou historique.' },
      { name: 'Recevoir votre histoire', text: 'Votre histoire personnalisée illustrée est prête en quelques minutes. Lisez en ligne ou commandez un livre.' },
    ],
  };
  const s = steps[lang] || steps.de;
  return {
    '@context': 'https://schema.org',
    '@type': 'HowTo',
    name: lang === 'de' ? 'Personalisiertes Kinderbuch erstellen' : lang === 'fr' ? 'Créer un livre personnalisé' : 'Create a Personalized Children\'s Book',
    description: lang === 'de' ? 'In 3 einfachen Schritten zum personalisierten Kinderbuch' : lang === 'fr' ? 'En 3 étapes simples vers votre livre personnalisé' : 'Create your personalized book in 3 simple steps',
    totalTime: 'PT3M',
    tool: { '@type': 'HowToTool', name: lang === 'de' ? 'Ein Foto deines Kindes' : 'A photo of your child' },
    step: s.map((step, i) => ({
      '@type': 'HowToStep',
      position: i + 1,
      name: step.name,
      text: step.text,
    })),
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normalizeLang(lang) {
  const l = (lang || 'de').toLowerCase();
  if (l === 'en' || l === 'fr') return l;
  return 'de';
}

/**
 * Look up a theme by its ID across all categories.
 * Returns { category, themeId, theme } or null.
 */
function findTheme(category, themeId) {
  const catThemes = THEMES[category];
  if (!catThemes) return null;
  const theme = catThemes[themeId];
  if (!theme) return null;
  return { category, themeId, theme };
}

// ─── getMetaForRoute ──────────────────────────────────────────────────────────

/**
 * Returns meta object for a given route path and language.
 * @param {string} routePath - e.g. "/", "/faq", "/themes/adventure/pirate"
 * @param {string} lang - "en", "de", or "fr" (defaults to "de")
 * @returns {{ title, description, canonical, noindex, hreflang[], jsonLd?, path }}
 */
function getMetaForRoute(routePath, lang) {
  lang = normalizeLang(lang);
  const cleanPath = routePath.replace(/\/+$/, '') || '/';

  // Check noindex routes (prefix match for routes like /create/*)
  const isNoindex = NOINDEX_ROUTES.some(nr => cleanPath === nr || cleanPath.startsWith(nr + '/'));

  // 1. Static routes
  const staticMeta = STATIC_ROUTES[cleanPath];
  if (staticMeta) {
    const meta = {
      title: staticMeta.title[lang] || staticMeta.title.de,
      description: staticMeta.description[lang] || staticMeta.description.de,
      canonical: `${BASE_URL}${cleanPath === '/' ? '' : cleanPath}`,
      path: cleanPath,
      noindex: isNoindex,
      hreflang: buildHreflang(cleanPath),
      jsonLd: [],
    };

    // Page-specific schemas
    if (cleanPath === '/') {
      meta.jsonLd = [
        ORGANIZATION_JSON_LD,
        PRODUCT_JSON_LD,
        buildBreadcrumbJsonLd([{ name: 'Home' }]),
      ];
    } else if (cleanPath === '/faq') {
      meta.jsonLd = [
        FAQ_JSON_LD,
        buildBreadcrumbJsonLd([{ name: 'Home', url: '/' }, { name: 'FAQ' }]),
      ];
    } else if (cleanPath === '/about') {
      meta.jsonLd = [
        ORGANIZATION_JSON_LD,
        buildBreadcrumbJsonLd([{ name: 'Home', url: '/' }, { name: lang === 'de' ? 'Über uns' : lang === 'fr' ? 'À propos' : 'About' }]),
      ];
    } else if (cleanPath === '/pricing') {
      meta.jsonLd = [
        PRODUCT_JSON_LD,
        buildBreadcrumbJsonLd([{ name: 'Home', url: '/' }, { name: lang === 'de' ? 'Preise' : lang === 'fr' ? 'Tarifs' : 'Pricing' }]),
      ];
    } else if (cleanPath === '/try') {
      meta.jsonLd = [
        buildHowToJsonLd(lang),
        buildBreadcrumbJsonLd([{ name: 'Home', url: '/' }, { name: lang === 'de' ? 'Gratis Geschichte erstellen' : lang === 'fr' ? 'Créer une histoire' : 'Create Your Story' }]),
      ];
    } else if (cleanPath === '/themes') {
      meta.jsonLd = [
        buildBreadcrumbJsonLd([{ name: 'Home', url: '/' }, { name: lang === 'de' ? 'Themen' : lang === 'fr' ? 'Thèmes' : 'Themes' }]),
      ];
    } else if (cleanPath === '/science') {
      meta.jsonLd = [
        buildBreadcrumbJsonLd([{ name: 'Home', url: '/' }, { name: lang === 'de' ? 'Forschung' : lang === 'fr' ? 'Science' : 'Science' }]),
      ];
    } else {
      // Other static pages get breadcrumb only
      const pageName = staticMeta.title[lang] || staticMeta.title.de;
      meta.jsonLd = [buildBreadcrumbJsonLd([{ name: 'Home', url: '/' }, { name: pageName.replace(/ – Magical Story$/, '') }])];
    }

    return meta;
  }

  // 2. Theme category page: /themes/:category
  const categoryMatch = cleanPath.match(/^\/themes\/([^/]+)$/);
  if (categoryMatch) {
    const categoryId = categoryMatch[1];
    const category = THEME_CATEGORIES[categoryId];
    if (category) {
      const catName = category[lang] || category.de;
      return {
        title: `${catName} – Magical Story`,
        description: buildCategoryDescription(catName, lang),
        canonical: `${BASE_URL}${cleanPath}`,
        path: cleanPath,
        noindex: false,
        hreflang: buildHreflang(cleanPath),
        jsonLd: [
          buildBreadcrumbJsonLd([
            { name: 'Home', url: '/' },
            { name: lang === 'de' ? 'Themen' : lang === 'fr' ? 'Thèmes' : 'Themes', url: '/themes' },
            { name: catName },
          ]),
        ],
      };
    }
  }

  // 3. Individual theme page: /themes/:category/:themeId
  const themeMatch = cleanPath.match(/^\/themes\/([^/]+)\/([^/]+)$/);
  if (themeMatch) {
    const [, categoryId, themeId] = themeMatch;
    const found = findTheme(categoryId, themeId);
    if (found) {
      const themeName = found.theme[lang] || found.theme.de;
      const catName = (THEME_CATEGORIES[categoryId] || {})[lang] || (THEME_CATEGORIES[categoryId] || {}).de || categoryId;
      const titleTemplate = lang === 'de'
        ? `Personalisiertes ${themeName}-Kinderbuch | MagicalStory`
        : lang === 'fr'
          ? `Livre personnalisé ${themeName} | MagicalStory`
          : `Personalized ${themeName} Story | MagicalStory`;
      return {
        title: titleTemplate,
        description: buildThemeDescription(themeName, lang),
        canonical: `${BASE_URL}${cleanPath}`,
        path: cleanPath,
        noindex: false,
        hreflang: buildHreflang(cleanPath),
        jsonLd: [
          buildProductJsonLdForTheme(themeName, categoryId, themeId),
          buildBreadcrumbJsonLd([
            { name: 'Home', url: '/' },
            { name: lang === 'de' ? 'Themen' : lang === 'fr' ? 'Thèmes' : 'Themes', url: '/themes' },
            { name: catName, url: `/themes/${categoryId}` },
            { name: themeName },
          ]),
        ],
      };
    }
  }

  // 4. Town page: /geschichten-aus/:townSlug
  const townMatch = cleanPath.match(/^\/geschichten-aus\/([^/]+)$/);
  if (townMatch) {
    const townSlug = townMatch[1];
    const town = TOWNS[townSlug];
    if (town) {
      const title = town[lang] || town.de;
      return {
        title: `${title} | MagicalStory`,
        description: buildTownDescription(town.name, lang),
        canonical: `${BASE_URL}${cleanPath}`,
        path: cleanPath,
        noindex: false,
        hreflang: buildHreflang(cleanPath),
        jsonLd: [
          buildBreadcrumbJsonLd([
            { name: 'Home', url: '/' },
            { name: lang === 'de' ? 'Geschichten aus der Schweiz' : lang === 'fr' ? 'Histoires de Suisse' : 'Stories from Switzerland', url: '/geschichten-aus' },
            { name: town.name },
          ]),
        ],
      };
    }
  }

  // 5. Comparison page: /vergleich/:competitorSlug
  const compMatch = cleanPath.match(/^\/vergleich\/([^/]+)$/);
  if (compMatch) {
    const compSlug = compMatch[1];
    const comp = COMPARISONS[compSlug];
    if (comp) {
      const title = comp[lang] || comp.de;
      return {
        title: `${title} — Ehrlicher Vergleich | MagicalStory`,
        description: buildComparisonDescription(comp.name, lang),
        canonical: `${BASE_URL}${cleanPath}`,
        path: cleanPath,
        noindex: false,
        hreflang: buildHreflang(cleanPath),
        jsonLd: [
          buildBreadcrumbJsonLd([
            { name: 'Home', url: '/' },
            { name: lang === 'de' ? 'Vergleich' : lang === 'fr' ? 'Comparaison' : 'Compare', url: '/vergleich' },
            { name: title },
          ]),
        ],
      };
    }
  }

  // 6. Occasion page: /anlass/:occasionSlug
  const occasionMatch = cleanPath.match(/^\/anlass\/([^/]+)$/);
  if (occasionMatch) {
    const occasionSlug = occasionMatch[1];
    const occasion = OCCASIONS[occasionSlug];
    if (occasion) {
      const title = occasion[lang] || occasion.de;
      return {
        title: `${title} | MagicalStory`,
        description: buildOccasionDescription(occasionSlug, lang),
        canonical: `${BASE_URL}${cleanPath}`,
        path: cleanPath,
        noindex: false,
        hreflang: buildHreflang(cleanPath),
        jsonLd: [
          PRODUCT_JSON_LD,
          buildBreadcrumbJsonLd([
            { name: 'Home', url: '/' },
            { name: lang === 'de' ? 'Anlässe' : lang === 'fr' ? 'Occasions' : 'Occasions', url: '/anlass' },
            { name: title },
          ]),
        ],
      };
    }
  }

  // 7. Gift page: /geschenk/:giftSlug
  const giftMatch = cleanPath.match(/^\/geschenk\/([^/]+)$/);
  if (giftMatch) {
    const giftSlug = giftMatch[1];
    const giftPage = GIFT_PAGES[giftSlug];
    if (giftPage) {
      const title = giftPage[lang] || giftPage.de;
      return {
        title: `${title} | MagicalStory`,
        description: buildGiftDescription(giftSlug, lang),
        canonical: `${BASE_URL}${cleanPath}`,
        path: cleanPath,
        noindex: false,
        hreflang: buildHreflang(cleanPath),
        jsonLd: [
          PRODUCT_JSON_LD,
          buildBreadcrumbJsonLd([
            { name: 'Home', url: '/' },
            { name: lang === 'de' ? 'Geschenkideen' : lang === 'fr' ? 'Idées cadeaux' : 'Gift Ideas', url: '/geschenk' },
            { name: title },
          ]),
        ],
      };
    }
  }

  // 8. City page: /stadt/:cityId
  const cityMatch = cleanPath.match(/^\/stadt\/([^/]+)$/);
  if (cityMatch) {
    const cId = cityMatch[1];
    const cityData = SWISS_CITIES.find(c => c.id === cId);
    if (cityData) {
      const cityName = cityData.name[lang] || cityData.name.de;
      const canton = cityData.canton;
      const titleTpl = lang === 'de'
        ? `Personalisiertes Kinderbuch ${cityName} (${canton}) | MagicalStory`
        : lang === 'fr'
          ? `Livre personnalisé pour enfants ${cityName} (${canton}) | MagicalStory`
          : `Personalized Children's Book ${cityName} (${canton}) | MagicalStory`;
      return {
        title: titleTpl,
        description: buildCityDescription(cityName, lang),
        canonical: `${BASE_URL}${cleanPath}`,
        path: cleanPath,
        noindex: false,
        hreflang: buildHreflang(cleanPath),
        jsonLd: [
          buildBreadcrumbJsonLd([
            { name: 'Home', url: '/' },
            { name: lang === 'de' ? 'Schweizer Städte' : lang === 'fr' ? 'Villes suisses' : 'Swiss Cities', url: '/stadt' },
            { name: cityName },
          ]),
        ],
      };
    }
  }

  // 9. Noindex route (auth/app pages)
  if (isNoindex) {
    return {
      title: 'Magical Story',
      description: '',
      canonical: `${BASE_URL}${cleanPath}`,
      path: cleanPath,
      noindex: true,
      hreflang: [],
    };
  }

  // 10. Fallback — unknown route
  return {
    title: 'Magical Story – Dein Kind als Held seiner eigenen Geschichte',
    description: 'Dein Kind wird zum Helden einer wunderschön illustrierten Geschichte. Foto hochladen, Thema wählen und ein fertiges Buch in den Händen halten.',
    canonical: `${BASE_URL}${cleanPath === '/' ? '' : cleanPath}`,
    path: cleanPath,
    noindex: false,
    hreflang: buildHreflang(cleanPath),
  };
}

function buildHreflang(routePath) {
  const p = routePath === '/' ? '' : routePath;
  return [
    { lang: 'de-CH', href: `${BASE_URL}${p}` },
    { lang: 'de-DE', href: `${BASE_URL}${p}` },
    { lang: 'de-AT', href: `${BASE_URL}${p}` },
    { lang: 'de', href: `${BASE_URL}${p}` },
    { lang: 'fr-CH', href: `${BASE_URL}${p}?lang=fr` },
    { lang: 'fr', href: `${BASE_URL}${p}?lang=fr` },
    { lang: 'en', href: `${BASE_URL}${p}?lang=en` },
    { lang: 'x-default', href: `${BASE_URL}${p}` },
  ];
}

function buildCategoryDescription(catName, lang) {
  const templates = {
    en: `Browse ${catName} for your child. Create a personalized illustrated book in minutes with Magical Story.`,
    de: `Entdecke ${catName} für dein Kind. Erstelle in Minuten ein personalisiertes illustriertes Buch mit Magical Story.`,
    fr: `Découvrez les ${catName} pour votre enfant. Créez un livre illustré personnalisé en quelques minutes avec Magical Story.`,
  };
  return templates[lang] || templates.de;
}

function buildThemeDescription(themeName, lang) {
  const templates = {
    de: `Erstelle ein personalisiertes ${themeName}-Kinderbuch mit dem Foto deines Kindes. KI-illustriert, einzigartig, ab CHF 33. Erste Geschichte gratis.`,
    en: `Create a personalized ${themeName} children's book with your child's photo. AI-illustrated, unique, from CHF 33. First story free.`,
    fr: `Créez un livre personnalisé ${themeName} avec la photo de votre enfant. Illustré par IA, unique, dès CHF 33. Première histoire gratuite.`,
  };
  return templates[lang] || templates.de;
}

function buildTownDescription(townName, lang) {
  const templates = {
    de: `Dein Kind erlebt ein personalisiertes Abenteuer in ${townName} — als Held eines illustrierten Kinderbuchs. Lokale Wahrzeichen, echte Schauplätze. Kostenlos testen.`,
    en: `Your child goes on a personalized adventure in ${townName} — as the hero of an illustrated children's book. Local landmarks, real settings. Try free.`,
    fr: `Votre enfant vit une aventure personnalisée à ${townName} — en héros d'un livre illustré. Monuments locaux, lieux réels. Essai gratuit.`,
  };
  return templates[lang] || templates.de;
}

function buildCityDescription(cityName, lang) {
  const templates = {
    de: `Personalisierte Kindergeschichten aus ${cityName}: Dein Kind erlebt echte Geschichte und lokale Sagen als Held eines illustrierten Kinderbuchs. Kostenlos testen.`,
    en: `Personalized children's stories from ${cityName}: Your child experiences real history and local legends as the hero of an illustrated book. Try free.`,
    fr: `Histoires personnalisées pour enfants de ${cityName}: Votre enfant vit l'histoire locale en héros d'un livre illustré. Essai gratuit.`,
  };
  return templates[lang] || templates.de;
}

function buildComparisonDescription(competitorName, lang) {
  const templates = {
    de: `Ehrlicher Vergleich: MagicalStory vs ${competitorName}. Features, Preise, Vor- und Nachteile. Finde das beste personalisierte Kinderbuch.`,
    en: `Honest comparison: MagicalStory vs ${competitorName}. Features, pricing, pros and cons. Find the best personalized children's book.`,
    fr: `Comparaison honnête: MagicalStory vs ${competitorName}. Fonctionnalités, prix, avantages et inconvénients. Trouvez le meilleur livre personnalisé.`,
  };
  return templates[lang] || templates.de;
}

function buildOccasionDescription(occasionSlug, lang) {
  const occasionGifts = {
    geburtstag: { de: 'Geburtstag', en: 'birthday', fr: 'anniversaire' },
    weihnachten: { de: 'Weihnachten', en: 'Christmas', fr: 'Noël' },
    ostern: { de: 'Ostern', en: 'Easter', fr: 'Pâques' },
    taufe: { de: 'Taufe', en: 'baptism', fr: 'baptême' },
    einschulung: { de: 'Einschulung', en: 'first day of school', fr: 'rentrée scolaire' },
    geschwisterchen: { de: 'Geschwisterchen', en: 'new sibling', fr: 'nouveau bébé' },
    muttertag: { de: 'Muttertag', en: 'Mother\'s Day', fr: 'fête des mères' },
    vatertag: { de: 'Vatertag', en: 'Father\'s Day', fr: 'fête des pères' },
    nikolaus: { de: 'Nikolaus', en: 'St. Nicholas Day', fr: 'Saint-Nicolas' },
    advent: { de: 'Advent', en: 'Advent', fr: 'Avent' },
    umzug: { de: 'Umzug', en: 'moving house', fr: 'déménagement' },
    kindergartenstart: { de: 'Kindergartenstart', en: 'starting kindergarten', fr: 'entrée en maternelle' },
  };
  const occ = occasionGifts[occasionSlug] || { de: 'Anlass', en: 'occasion', fr: 'occasion' };
  const templates = {
    de: `Das perfekte Geschenk zum ${occ.de}: Ein personalisiertes Kinderbuch mit deinem Kind als Held. 170+ Themen, Hardcover ab CHF 33. Erste Geschichte gratis.`,
    en: `The perfect gift for ${occ.en}: A personalized children's book with your child as the hero. 170+ themes, hardcover from CHF 33. First story free.`,
    fr: `Le cadeau parfait pour ${occ.fr}: Un livre personnalisé avec votre enfant en héros. 170+ thèmes, couverture rigide dès CHF 33. Première histoire gratuite.`,
  };
  return templates[lang] || templates.de;
}

function buildGiftDescription(giftSlug, lang) {
  const descriptions = {
    'fuer-kinder': {
      de: 'Ein Geschenk, das Kinderaugen leuchten lässt: ein personalisiertes Kinderbuch mit dem eigenen Foto. 170+ Themen, Hardcover ab CHF 33. Erste Geschichte gratis testen.',
      en: 'A gift that makes children\'s eyes light up: a personalized book with their own photo. 170+ themes, hardcover from CHF 33. Try the first story free.',
      fr: 'Un cadeau qui fait briller les yeux des enfants: un livre personnalisé avec leur photo. 170+ thèmes, couverture rigide dès CHF 33. Première histoire gratuite.',
    },
    'fuer-enkel': {
      de: 'Das Geschenk von Oma & Opa, das Enkel nie vergessen: ein personalisiertes Kinderbuch mit eigenem Foto. Einzigartig, liebevoll, ab CHF 33.',
      en: 'The gift from grandma & grandpa that grandchildren never forget: a personalized book with their photo. Unique, heartfelt, from CHF 33.',
      fr: 'Le cadeau des grands-parents que les petits-enfants n\'oublient jamais: un livre personnalisé avec leur photo. Unique et touchant, dès CHF 33.',
    },
    'fuer-nichte-neffe': {
      de: 'Überrasche Nichte oder Neffe mit einem personalisierten Kinderbuch — mit eigenem Foto als Held der Geschichte. Ab CHF 33, erste Geschichte gratis.',
      en: 'Surprise your niece or nephew with a personalized book — starring them as the hero. From CHF 33, first story free.',
      fr: 'Surprenez votre nièce ou neveu avec un livre personnalisé — ils sont le héros. Dès CHF 33, première histoire gratuite.',
    },
    'fuer-patenkind': {
      de: 'Ein besonderes Geschenk vom Götti oder der Gotte: ein personalisiertes Kinderbuch mit dem Foto deines Patenkinds. Ab CHF 33.',
      en: 'A special gift from godparent to godchild: a personalized book with their photo. From CHF 33, first story free.',
      fr: 'Un cadeau spécial du parrain ou de la marraine: un livre personnalisé avec la photo de votre filleul(e). Dès CHF 33.',
    },
    'geschenk-von-grosseltern': {
      de: 'Das ideale Geschenk von Grosseltern: ein personalisiertes Kinderbuch, das Enkel zum Helden macht. Einfach online erstellen, ab CHF 33.',
      en: 'The ideal gift from grandparents: a personalized book that makes grandchildren the hero. Easy to create online, from CHF 33.',
      fr: 'Le cadeau idéal des grands-parents: un livre personnalisé qui fait de vos petits-enfants le héros. Facile à créer, dès CHF 33.',
    },
    'ostergeschenk': {
      de: 'Das besondere Ostergeschenk für Kinder: ein personalisiertes Kinderbuch statt Schoggi-Hasen. Mit eigenem Foto, ab CHF 33. Kostenlos testen.',
      en: 'A special Easter gift for kids: a personalized book instead of chocolate bunnies. With their photo, from CHF 33. Try free.',
      fr: 'Un cadeau de Pâques spécial: un livre personnalisé au lieu de lapins en chocolat. Avec leur photo, dès CHF 33. Essai gratuit.',
    },
    'weihnachtsgeschenk': {
      de: 'Das Weihnachtsgeschenk, das Kinder lieben: ein personalisiertes Kinderbuch mit eigenem Foto unter dem Tannenbaum. Ab CHF 33.',
      en: 'The Christmas gift kids love: a personalized book with their photo under the tree. From CHF 33, first story free.',
      fr: 'Le cadeau de Noël que les enfants adorent: un livre personnalisé avec leur photo sous le sapin. Dès CHF 33.',
    },
    'geburtstagsgeschenk': {
      de: 'Das perfekte Geburtstagsgeschenk für Kinder: ein personalisiertes Kinderbuch mit dem Geburtstagskind als Held. Ab CHF 33.',
      en: 'The perfect birthday gift for kids: a personalized book with the birthday child as hero. From CHF 33, first story free.',
      fr: "Le cadeau d'anniversaire parfait: un livre personnalisé avec l'enfant fêté en héros. Dès CHF 33, première histoire gratuite.",
    },
    'taufgeschenk': {
      de: 'Ein Taufgeschenk mit bleibendem Wert: ein personalisiertes Kinderbuch mit dem Namen und Foto des Täuflings. Ab CHF 33.',
      en: 'A baptism gift with lasting value: a personalized book with the child\'s name and photo. From CHF 33.',
      fr: 'Un cadeau de baptême à valeur durable: un livre personnalisé avec le nom et la photo de l\'enfant. Dès CHF 33.',
    },
    'einschulungsgeschenk': {
      de: 'Geschenk zur Einschulung: ein personalisiertes Kinderbuch für den grossen Tag. Mit dem Schulkind als Held der Geschichte. Ab CHF 33.',
      en: 'First day of school gift: a personalized book for the big day. With the child as hero of the story. From CHF 33.',
      fr: 'Cadeau de rentrée: un livre personnalisé pour le grand jour. L\'enfant est le héros de l\'histoire. Dès CHF 33.',
    },
    'nikolausgeschenk': {
      de: 'Nikolausgeschenk für Kinder: ein personalisiertes Kinderbuch im Samichlaus-Sack. Mit eigenem Foto, ab CHF 33. Kostenlos testen.',
      en: 'St. Nicholas gift for kids: a personalized book in the gift bag. With their own photo, from CHF 33. Try free.',
      fr: 'Cadeau de Saint-Nicolas: un livre personnalisé dans la hotte. Avec leur photo, dès CHF 33. Essai gratuit.',
    },
    'einzigartiges-geschenk': {
      de: 'Auf der Suche nach einem einzigartigen Kindergeschenk? Ein personalisiertes Kinderbuch mit Foto — gibt es kein zweites Mal. Ab CHF 33.',
      en: 'Looking for a unique gift for kids? A personalized book with their photo — truly one of a kind. From CHF 33.',
      fr: 'Vous cherchez un cadeau unique? Un livre personnalisé avec la photo de l\'enfant — vraiment unique. Dès CHF 33.',
    },
    'personalisiertes-geschenk': {
      de: 'Personalisiertes Geschenk für Kinder: Kinderbuch mit eigenem Foto, Namen und 170+ Themen. Hardcover ab CHF 33. Erste Geschichte gratis.',
      en: 'Personalized gift for kids: a book with their photo, name and 170+ themes. Hardcover from CHF 33. First story free.',
      fr: 'Cadeau personnalisé pour enfants: livre avec photo, prénom et 170+ thèmes. Couverture rigide dès CHF 33. Première histoire gratuite.',
    },
    'sinnvolles-geschenk': {
      de: 'Sinnvolles Geschenk für Kinder: ein personalisiertes Kinderbuch, das Lesen fördert und Selbstvertrauen stärkt. Ab CHF 33.',
      en: 'A meaningful gift for kids: a personalized book that encourages reading and builds confidence. From CHF 33.',
      fr: 'Un cadeau éducatif pour enfants: un livre personnalisé qui encourage la lecture et renforce la confiance. Dès CHF 33.',
    },
    'last-minute-geschenk': {
      de: 'Last-Minute-Geschenk für Kinder: personalisiertes Kinderbuch sofort als PDF oder in 5 Tagen als Hardcover. Ab CHF 33.',
      en: 'Last-minute gift for kids: personalized book instantly as PDF or hardcover in 5 days. From CHF 33.',
      fr: 'Cadeau de dernière minute: livre personnalisé en PDF immédiat ou couverture rigide en 5 jours. Dès CHF 33.',
    },
    'geschenk-3-jahre': {
      de: 'Geschenk für 3-Jährige: ein personalisiertes Kinderbuch mit grossen Bildern und einfachen Texten. Mit eigenem Foto, ab CHF 33.',
      en: 'Gift for 3-year-olds: a personalized book with big pictures and simple text. With their photo, from CHF 33.',
      fr: 'Cadeau pour enfant de 3 ans: un livre personnalisé avec de grandes images et des textes simples. Dès CHF 33.',
    },
    'geschenk-4-jahre': {
      de: 'Geschenk für 4-Jährige: ein personalisiertes Kinderbuch voller Abenteuer. Mit dem Kind als Held, ab CHF 33.',
      en: 'Gift for 4-year-olds: a personalized adventure book. With the child as hero, from CHF 33.',
      fr: "Cadeau pour enfant de 4 ans: un livre d'aventures personnalisé. L'enfant est le héros, dès CHF 33.",
    },
    'geschenk-5-jahre': {
      de: 'Geschenk für 5-Jährige: ein personalisiertes Kinderbuch zum Vorlesen und Selbstentdecken. 170+ Themen, ab CHF 33.',
      en: 'Gift for 5-year-olds: a personalized book for reading aloud and self-discovery. 170+ themes, from CHF 33.',
      fr: 'Cadeau pour enfant de 5 ans: un livre personnalisé à lire ensemble et explorer. 170+ thèmes, dès CHF 33.',
    },
    'geschenk-6-jahre': {
      de: 'Geschenk für 6-Jährige: ein personalisiertes Kinderbuch für Erstleser. Spannende Geschichten mit eigenem Foto, ab CHF 33.',
      en: 'Gift for 6-year-olds: a personalized book for early readers. Exciting stories with their photo, from CHF 33.',
      fr: 'Cadeau pour enfant de 6 ans: un livre personnalisé pour jeunes lecteurs. Histoires passionnantes, dès CHF 33.',
    },
    'geschenk-7-8-jahre': {
      de: 'Geschenk für 7–8-Jährige: ein personalisiertes Kinderbuch mit längeren Geschichten und spannenden Abenteuern. Ab CHF 33.',
      en: 'Gift for 7-8-year-olds: a personalized book with longer stories and exciting adventures. From CHF 33.',
      fr: 'Cadeau pour enfant de 7-8 ans: un livre personnalisé avec des histoires plus longues et des aventures passionnantes. Dès CHF 33.',
    },
  };
  return descriptions[giftSlug]?.[lang] || descriptions[giftSlug]?.de || 'Personalisiertes Kinderbuch als Geschenk — mit dem Foto deines Kindes als Held. Ab CHF 33, erste Geschichte gratis.';
}

// ─── injectMeta ───────────────────────────────────────────────────────────────

/**
 * Replaces placeholders/existing tags in HTML with route-specific meta.
 * @param {string} html - The HTML template string (index.html contents)
 * @param {object} meta - Meta object from getMetaForRoute()
 * @returns {string} - Modified HTML
 */
function injectMeta(html, meta, lang = 'de') {
  let result = html;

  // Replace <html lang="..."> to match content language
  const htmlLang = lang === 'fr' ? 'fr' : lang === 'en' ? 'en' : 'de';
  result = result.replace(/<html\s+lang="[^"]*"/, `<html lang="${htmlLang}"`);

  // Replace <title>
  result = result.replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(meta.title)}</title>`);

  // Replace meta description
  result = result.replace(
    /<meta\s+name="description"\s+content="[^"]*"\s*\/?>/,
    `<meta name="description" content="${escapeAttr(meta.description)}" />`
  );

  // Replace canonical URL
  result = result.replace(
    /<link\s+rel="canonical"\s+href="[^"]*"\s*\/?>/,
    `<link rel="canonical" href="${escapeAttr(meta.canonical)}" />`
  );

  // Replace OG tags
  result = result.replace(
    /<meta\s+property="og:title"\s+content="[^"]*"\s*\/?>/,
    `<meta property="og:title" content="${escapeAttr(meta.title)}" />`
  );
  result = result.replace(
    /<meta\s+property="og:description"\s+content="[^"]*"\s*\/?>/,
    `<meta property="og:description" content="${escapeAttr(meta.description)}" />`
  );
  result = result.replace(
    /<meta\s+property="og:url"\s+content="[^"]*"\s*\/?>/,
    `<meta property="og:url" content="${escapeAttr(meta.canonical)}" />`
  );

  // Replace og:locale to match content language
  const ogLocale = lang === 'fr' ? 'fr_CH' : lang === 'en' ? 'en_US' : 'de_CH';
  result = result.replace(
    /<meta\s+property="og:locale"\s+content="[^"]*"\s*\/?>/,
    `<meta property="og:locale" content="${ogLocale}" />`
  );

  // Replace Twitter tags
  result = result.replace(
    /<meta\s+name="twitter:title"\s+content="[^"]*"\s*\/?>/,
    `<meta name="twitter:title" content="${escapeAttr(meta.title)}" />`
  );
  result = result.replace(
    /<meta\s+name="twitter:description"\s+content="[^"]*"\s*\/?>/,
    `<meta name="twitter:description" content="${escapeAttr(meta.description)}" />`
  );
  result = result.replace(
    /<meta\s+name="twitter:url"\s+content="[^"]*"\s*\/?>/,
    `<meta name="twitter:url" content="${escapeAttr(meta.canonical)}" />`
  );

  // Replace robots meta tag
  if (meta.noindex) {
    result = result.replace(
      /<meta\s+name="robots"\s+content="[^"]*"\s*\/?>/,
      `<meta name="robots" content="noindex, nofollow" />`
    );
  }

  // Build tags to inject before </head>
  const injectTags = [];

  // Add hreflang links
  if (meta.hreflang && meta.hreflang.length > 0) {
    for (const hl of meta.hreflang) {
      injectTags.push(`<link rel="alternate" hreflang="${hl.lang}" href="${escapeAttr(hl.href)}" />`);
    }
  }

  // Add JSON-LD (supports single object or array of objects)
  if (meta.jsonLd) {
    const jsonLdItems = Array.isArray(meta.jsonLd) ? meta.jsonLd : [meta.jsonLd];
    for (const item of jsonLdItems) {
      if (item) injectTags.push(`<script type="application/ld+json">${JSON.stringify(item)}</script>`);
    }
  }

  // Inject before </head>
  if (injectTags.length > 0) {
    result = result.replace('</head>', `  ${injectTags.join('\n    ')}\n  </head>`);
  }

  return result;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttr(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ─── generateSitemap ──────────────────────────────────────────────────────────

/**
 * Generates a complete XML sitemap string.
 * @returns {string} XML sitemap
 */
function generateSitemap() {
  const paths = [];
  const today = new Date().toISOString().split('T')[0];

  // Priority mappings
  const staticPriorities = {
    '/': '1.0',
    '/try': '0.9',
    '/pricing': '0.9',
    '/themes': '0.8',
    '/geschichten-aus': '0.7',
    '/stadt': '0.7',
    '/anlass': '0.7',
    '/geschenk': '0.8',
    '/vergleich': '0.6',
    '/science': '0.7',
    '/faq': '0.5',
    '/about': '0.5',
    '/contact': '0.5',
    '/terms': '0.3',
    '/privacy': '0.3',
    '/impressum': '0.3',
  };

  // Static public pages
  for (const [route, priority] of Object.entries(staticPriorities)) {
    paths.push({
      path: route,
      lastmod: today,
      changefreq: route === '/' ? 'weekly' : 'monthly',
      priority,
    });
  }

  // Theme category pages
  for (const categoryId of Object.keys(THEME_CATEGORIES)) {
    paths.push({
      path: `/themes/${categoryId}`,
      lastmod: today,
      changefreq: 'monthly',
      priority: '0.7',
    });
  }

  // Individual theme pages
  for (const [categoryId, themes] of Object.entries(THEMES)) {
    for (const themeId of Object.keys(themes)) {
      paths.push({
        path: `/themes/${categoryId}/${themeId}`,
        lastmod: today,
        changefreq: 'monthly',
        priority: '0.6',
      });
    }
  }

  // Town pages
  for (const townSlug of Object.keys(TOWNS)) {
    paths.push({
      path: `/geschichten-aus/${townSlug}`,
      lastmod: today,
      changefreq: 'monthly',
      priority: '0.7',
    });
  }

  // Comparison pages
  for (const compSlug of Object.keys(COMPARISONS)) {
    paths.push({
      path: `/vergleich/${compSlug}`,
      lastmod: today,
      changefreq: 'monthly',
      priority: '0.6',
    });
  }

  // Occasion pages
  for (const occasionSlug of Object.keys(OCCASIONS)) {
    paths.push({
      path: `/anlass/${occasionSlug}`,
      lastmod: today,
      changefreq: 'monthly',
      priority: '0.6',
    });
  }

  // Gift pages
  for (const giftSlug of Object.keys(GIFT_PAGES)) {
    paths.push({
      path: `/geschenk/${giftSlug}`,
      lastmod: today,
      changefreq: 'monthly',
      priority: '0.7',
    });
  }

  // City pages (/stadt/:cityId)
  for (const city of SWISS_CITIES) {
    paths.push({
      path: `/stadt/${city.id}`,
      lastmod: today,
      changefreq: 'monthly',
      priority: '0.6',
    });
  }

  // Build XML — each path gets 3 <url> entries (de, en, fr) with xhtml:link alternates
  const LANGS = ['de', 'en', 'fr'];
  const urlEntries = [];

  for (const p of paths) {
    for (const lang of LANGS) {
      const loc = lang === 'de'
        ? `${BASE_URL}${p.path === '/' ? '' : p.path}`
        : `${BASE_URL}${p.path === '/' ? '' : p.path}?lang=${lang}`;

      let entry = `  <url>\n    <loc>${escapeXml(loc)}</loc>\n    <lastmod>${p.lastmod}</lastmod>\n    <changefreq>${p.changefreq}</changefreq>\n    <priority>${p.priority}</priority>`;

      // xhtml:link alternates for regional + language variants
      const basePath = p.path === '/' ? '' : p.path;
      const deUrl = escapeXml(`${BASE_URL}${basePath}`);
      const enUrl = escapeXml(`${BASE_URL}${basePath}?lang=en`);
      const frUrl = escapeXml(`${BASE_URL}${basePath}?lang=fr`);
      entry += `\n    <xhtml:link rel="alternate" hreflang="de-CH" href="${deUrl}" />`;
      entry += `\n    <xhtml:link rel="alternate" hreflang="de-DE" href="${deUrl}" />`;
      entry += `\n    <xhtml:link rel="alternate" hreflang="de-AT" href="${deUrl}" />`;
      entry += `\n    <xhtml:link rel="alternate" hreflang="de" href="${deUrl}" />`;
      entry += `\n    <xhtml:link rel="alternate" hreflang="fr-CH" href="${frUrl}" />`;
      entry += `\n    <xhtml:link rel="alternate" hreflang="fr" href="${frUrl}" />`;
      entry += `\n    <xhtml:link rel="alternate" hreflang="en" href="${enUrl}" />`;
      entry += `\n    <xhtml:link rel="alternate" hreflang="x-default" href="${deUrl}" />`;

      // Add video entry for homepage (German only)
      if (p.path === '/' && lang === 'de') {
        entry += `\n    <video:video>` +
          `\n      <video:thumbnail_loc>${BASE_URL}/images/video-poster.jpg</video:thumbnail_loc>` +
          `\n      <video:title>MagicalStory – Personalisierte Kinderbücher mit KI</video:title>` +
          `\n      <video:description>So wird das Foto deines Kindes zum personalisierten, illustrierten Bilderbuch. Foto hochladen, Thema wählen und staunen.</video:description>` +
          `\n      <video:content_loc>${BASE_URL}/images/Boy%20to%20pirat%20to%20book.mp4</video:content_loc>` +
          `\n      <video:family_friendly>yes</video:family_friendly>` +
          `\n    </video:video>`;
      }

      entry += `\n  </url>`;
      urlEntries.push(entry);
    }
  }

  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml" xmlns:video="http://www.google.com/schemas/sitemap-video/1.1">\n${urlEntries.join('\n')}\n</urlset>`;
}

function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = { getMetaForRoute, injectMeta, generateSitemap };
