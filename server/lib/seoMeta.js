// server/lib/seoMeta.js — SEO meta tag injection, sitemap generation, and route metadata
// CommonJS module for server-side use

const BASE_URL = 'https://magicalstory.ch';

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
      en: 'Your first story is free. Printed hardcover books start at CHF 38. View all pricing plans for Magical Story.',
      de: 'Deine erste Geschichte ist gratis. Gedruckte Hardcover-Bücher ab CHF 38. Alle Preise für Magical Story.',
      fr: 'Votre première histoire est gratuite. Livres cartonnés imprimés dès CHF 38. Tous les tarifs de Magical Story.',
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
      de: 'Magical Story wird in der Schweiz entwickelt. Wir glauben, dass jedes Kind verdient, der Held seiner eigenen Geschichte zu sein.',
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
};

// Routes that should have noindex
const NOINDEX_ROUTES = [
  '/create', '/stories', '/orders', '/admin', '/book-builder',
  '/welcome', '/trial-generation', '/claim', '/reset-password', '/email-verified',
];

// ─── FAQ JSON-LD ──────────────────────────────────────────────────────────────

const FAQ_JSON_LD = {
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  mainEntity: [
    {
      '@type': 'Question',
      name: 'How does it work?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'Upload a photo of your child, choose a story theme, and get a fully illustrated personalized story in minutes. Your child appears as the main character on every page.',
      },
    },
    {
      '@type': 'Question',
      name: 'How long does it take?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'Your first free story is ready in under 3 minutes. Story text and all illustrations are generated automatically.',
      },
    },
    {
      '@type': 'Question',
      name: 'What ages is this for?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'Stories can be created for children of all ages. The story content and complexity are adapted to the age you specify when creating the story.',
      },
    },
    {
      '@type': 'Question',
      name: 'Can I add multiple characters?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'Yes! You can add your whole family, friends, or pets as characters in the story. Each character gets their own personalized illustrations.',
      },
    },
    {
      '@type': 'Question',
      name: 'How much does it cost?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'Your first story is completely free. After that, stories are created with credits. Printed books start at CHF 38 for a high-quality hardcover.',
      },
    },
    {
      '@type': 'Question',
      name: 'Is my data safe?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'Yes. Your photos are used only to create your story illustrations and are never shared with third parties. We take data protection seriously and comply with Swiss privacy laws.',
      },
    },
  ],
};

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
    };
    // Add FAQ JSON-LD for /faq
    if (cleanPath === '/faq') {
      meta.jsonLd = FAQ_JSON_LD;
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
      return {
        title: `${themeName} – Personalized Story | Magical Story`,
        description: buildThemeDescription(themeName, lang),
        canonical: `${BASE_URL}${cleanPath}`,
        path: cleanPath,
        noindex: false,
        hreflang: buildHreflang(cleanPath),
      };
    }
  }

  // 4. Noindex route (auth/app pages)
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

  // 5. Fallback — unknown route
  return {
    title: 'Magical Story – Your Child as the Hero of Their Own Book',
    description: 'Your child becomes the hero of a beautifully illustrated story. Upload a photo, pick a theme, and hold a finished book in your hands.',
    canonical: `${BASE_URL}${cleanPath === '/' ? '' : cleanPath}`,
    path: cleanPath,
    noindex: false,
    hreflang: buildHreflang(cleanPath),
  };
}

function buildHreflang(routePath) {
  const p = routePath === '/' ? '' : routePath;
  return [
    { lang: 'de', href: `${BASE_URL}${p}` },
    { lang: 'en', href: `${BASE_URL}${p}?lang=en` },
    { lang: 'fr', href: `${BASE_URL}${p}?lang=fr` },
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
    en: `Create a personalized ${themeName} story for your child. Upload a photo and get an illustrated book in minutes.`,
    de: `Erstelle eine personalisierte ${themeName}-Geschichte für dein Kind. Foto hochladen und in Minuten ein illustriertes Buch erhalten.`,
    fr: `Créez une histoire personnalisée ${themeName} pour votre enfant. Téléchargez une photo et obtenez un livre illustré en minutes.`,
  };
  return templates[lang] || templates.de;
}

// ─── injectMeta ───────────────────────────────────────────────────────────────

/**
 * Replaces placeholders/existing tags in HTML with route-specific meta.
 * @param {string} html - The HTML template string (index.html contents)
 * @param {object} meta - Meta object from getMetaForRoute()
 * @returns {string} - Modified HTML
 */
function injectMeta(html, meta) {
  let result = html;

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

  // Add JSON-LD
  if (meta.jsonLd) {
    injectTags.push(`<script type="application/ld+json">${JSON.stringify(meta.jsonLd)}</script>`);
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
  const urls = [];
  const today = new Date().toISOString().split('T')[0];

  // Priority mappings
  const staticPriorities = {
    '/': '1.0',
    '/try': '0.9',
    '/pricing': '0.9',
    '/themes': '0.8',
    '/faq': '0.5',
    '/about': '0.5',
    '/contact': '0.5',
    '/terms': '0.3',
    '/privacy': '0.3',
    '/impressum': '0.3',
  };

  // Static public pages
  for (const [route, priority] of Object.entries(staticPriorities)) {
    urls.push({
      loc: `${BASE_URL}${route === '/' ? '' : route}`,
      lastmod: today,
      changefreq: route === '/' ? 'weekly' : 'monthly',
      priority,
    });
  }

  // Theme category pages
  for (const categoryId of Object.keys(THEME_CATEGORIES)) {
    urls.push({
      loc: `${BASE_URL}/themes/${categoryId}`,
      lastmod: today,
      changefreq: 'monthly',
      priority: '0.7',
    });
  }

  // Individual theme pages
  for (const [categoryId, themes] of Object.entries(THEMES)) {
    for (const themeId of Object.keys(themes)) {
      urls.push({
        loc: `${BASE_URL}/themes/${categoryId}/${themeId}`,
        lastmod: today,
        changefreq: 'monthly',
        priority: '0.6',
      });
    }
  }

  // Build XML
  const urlEntries = urls.map(u =>
    `  <url>\n    <loc>${escapeXml(u.loc)}</loc>\n    <lastmod>${u.lastmod}</lastmod>\n    <changefreq>${u.changefreq}</changefreq>\n    <priority>${u.priority}</priority>\n  </url>`
  ).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urlEntries}\n</urlset>`;
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
