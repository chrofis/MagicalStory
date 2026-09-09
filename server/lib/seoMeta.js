// server/lib/seoMeta.js — SEO meta tag injection, sitemap generation, and route metadata
// CommonJS module for server-side use

const fs = require('fs');
const path = require('path');

// BASE_URL drives canonical, og:url, hreflang, and sitemap URLs across
// every SSR-rendered page. Reads from process.env.BASE_URL (set per
// Railway environment — staging has BASE_URL=https://staging.magicalstory.ch
// — so the prerender bakes the right hostname into the deployed HTML and
// avoids React hydration mismatch on staging). Falls back to prod URL when
// unset so local dev / one-off scripts don't break.
const BASE_URL = process.env.BASE_URL || 'https://magicalstory.ch';

// ─── Swiss City Data (loaded from JSON for /stadt routes) ────────────────────

let SWISS_CITIES = [];
try {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/swiss-cities.json'), 'utf-8'));
  SWISS_CITIES = raw.cities || [];
} catch (_) { /* data file optional */ }

// ─── Theme Data (id → { en, de, fr }) ────────────────────────────────────────

const THEME_CATEGORIES = {
  adventure: { en: 'Adventure Stories', de: 'Abenteuer-Geschichten', fr: "Histoires d'Aventure", it: 'Storie di Avventura' },
  'life-challenges': { en: 'Life Challenge Stories', de: 'Lebensherausforderungen-Geschichten', fr: 'Histoires de Défis de Vie', it: 'Storie sulle Sfide della Vita' },
  educational: { en: 'Educational Stories', de: 'Lehrreiche Geschichten', fr: 'Histoires Éducatives', it: 'Storie Educative' },
  historical: { en: 'Historical Stories', de: 'Historische Geschichten', fr: 'Histoires Historiques', it: 'Storie Storiche' },
};

const THEMES = {
  adventure: {
    pirate: { en: 'Pirate Adventure', de: 'Piraten-Abenteuer', fr: 'Aventure de Pirates', it: 'Avventura dei Pirati' },
    knight: { en: 'Knights & Princess', de: 'Ritter & Prinzessin', fr: 'Chevaliers & Princesse', it: 'Cavalieri & Principessa' },
    cowboy: { en: 'Cowboys & Indians', de: 'Cowboys und Indianer', fr: 'Cowboys et Indiens', it: 'Cowboy e Indiani' },
    ninja: { en: 'Secret Ninja', de: 'Geheimer Ninja', fr: 'Ninja Secret', it: 'Ninja Segreto' },
    viking: { en: 'Viking Adventure', de: 'Wikinger-Abenteuer', fr: 'Aventure Viking', it: 'Avventura Vichinga' },
    roman: { en: 'Ancient Rome', de: 'Antikes Rom', fr: 'Rome Antique', it: 'Antica Roma' },
    egyptian: { en: 'Ancient Egypt', de: 'Altes Ägypten', fr: 'Égypte Ancienne', it: 'Antico Egitto' },
    greek: { en: 'Ancient Greece', de: 'Antikes Griechenland', fr: 'Grèce Antique', it: 'Antica Grecia' },
    caveman: { en: 'Stone Age', de: 'Steinzeit', fr: 'Âge de Pierre', it: "Età della Pietra" },
    samurai: { en: 'Samurai Adventure', de: 'Samurai-Abenteuer', fr: 'Aventure Samouraï', it: 'Avventura del Samurai' },
    wizard: { en: 'Wizard & Witch', de: 'Zauberer & Hexe', fr: 'Sorcier & Sorcière', it: 'Mago & Strega' },
    dragon: { en: 'Dragon Quest', de: 'Drachen-Abenteuer', fr: 'Quête du Dragon', it: 'Avventura del Drago' },
    unicorn: { en: 'Magical Unicorn', de: 'Magisches Einhorn', fr: 'Licorne Magique', it: 'Unicorno Magico' },
    mermaid: { en: 'Mermaid Adventure', de: 'Meerjungfrauen-Abenteuer', fr: 'Aventure de Sirène', it: 'Avventura della Sirenetta' },
    dinosaur: { en: 'Dinosaur World', de: 'Dinosaurier-Welt', fr: 'Monde des Dinosaures', it: 'Mondo dei Dinosauri' },
    superhero: { en: 'Superhero', de: 'Superheld', fr: 'Super-héros', it: 'Supereroe' },
    space: { en: 'Space Explorer', de: 'Weltraum-Entdecker', fr: 'Explorateur Spatial', it: 'Esploratore Spaziale' },
    ocean: { en: 'Ocean Explorer', de: 'Ozean-Entdecker', fr: 'Explorateur des Océans', it: "Esploratore dell'Oceano" },
    jungle: { en: 'Jungle Safari', de: 'Dschungel-Safari', fr: 'Safari dans la Jungle', it: 'Safari nella Giungla' },
    farm: { en: 'Farm Life', de: 'Bauernhof-Leben', fr: 'Vie à la Ferme', it: 'Vita in Fattoria' },
    forest: { en: 'Forest Friends', de: 'Waldfreunde', fr: 'Amis de la Forêt', it: 'Amici del Bosco' },
    fireman: { en: 'Brave Firefighter', de: 'Tapferer Feuerwehrmann', fr: 'Pompier Courageux', it: 'Coraggioso Pompiere' },
    doctor: { en: 'Helpful Doctor', de: 'Hilfreicher Arzt', fr: 'Docteur Serviable', it: 'Dottore Premuroso' },
    police: { en: 'Police Officer', de: 'Polizist', fr: 'Policier', it: 'Poliziotto' },
    detective: { en: 'Detective Mystery', de: 'Detektiv-Geheimnis', fr: 'Mystère Détective', it: 'Mistero da Detective' },
    christmas: { en: 'Christmas Story', de: 'Weihnachts-Geschichte', fr: 'Histoire de Noël', it: 'Storia di Natale' },
    newyear: { en: 'New Year Story', de: 'Neujahrs-Geschichte', fr: 'Histoire du Nouvel An', it: "Storia di Capodanno" },
    easter: { en: 'Easter Story', de: 'Oster-Geschichte', fr: 'Histoire de Pâques', it: 'Storia di Pasqua' },
    halloween: { en: 'Halloween Story', de: 'Halloween-Geschichte', fr: "Histoire d'Halloween", it: 'Storia di Halloween' },
  },
  'life-challenges': {
    'potty-training': { en: 'Potty Training', de: 'Töpfchen-Training', fr: "Apprentissage du pot", it: 'Uso del Vasino' },
    'washing-hands': { en: 'Washing Hands', de: 'Hände waschen', fr: 'Se laver les mains', it: 'Lavarsi le Mani' },
    'brushing-teeth': { en: 'Brushing Teeth', de: 'Zähne putzen', fr: 'Se brosser les dents', it: 'Lavarsi i Denti' },
    'eating-vegetables': { en: 'Eating Vegetables', de: 'Gemüse essen', fr: 'Manger des légumes', it: 'Mangiare Verdure' },
    'going-to-bed': { en: 'Going to Bed', de: 'Ins Bett gehen', fr: 'Aller au lit', it: 'Andare a Letto' },
    'saying-goodbye': { en: 'Saying Goodbye', de: 'Abschied nehmen', fr: 'Dire au revoir', it: 'Dire Addio' },
    'no-pacifier': { en: 'No More Pacifier', de: 'Ohne Schnuller', fr: 'Plus de tétine', it: 'Basta Ciuccio' },
    'getting-dressed': { en: 'Getting Dressed by Myself', de: 'Sich alleine anziehen', fr: "S'habiller tout seul", it: 'Vestirsi da Solo' },
    'cleaning-up': { en: 'Cleaning Up Toys', de: 'Aufräumen', fr: 'Ranger les jouets', it: 'Riordinare i Giochi' },
    'sitting-still': { en: 'Sitting Still', de: 'Still sitzen', fr: 'Rester tranquille', it: 'Stare Seduti Fermi' },
    sharing: { en: 'Learning to Share', de: 'Teilen lernen', fr: 'Apprendre à partager', it: 'Imparare a Condividere' },
    'waiting-turn': { en: 'Waiting Your Turn', de: 'Warten können', fr: 'Attendre son tour', it: 'Aspettare il Proprio Turno' },
    'first-kindergarten': { en: 'First Day of Kindergarten', de: 'Erster Kindergartentag', fr: 'Premier jour de maternelle', it: "Primo Giorno all'Asilo" },
    'making-friends': { en: 'Making Real Friends', de: 'Echte Freunde finden', fr: 'Se faire de vrais amis', it: 'Trovare Veri Amici' },
    'being-brave': { en: 'Being Brave', de: 'Mutig sein', fr: 'Être courageux', it: 'Essere Coraggiosi' },
    'new-sibling': { en: 'New Baby Sibling', de: 'Neues Geschwisterchen', fr: 'Nouveau bébé dans la famille', it: 'Un Nuovo Fratellino' },
    'managing-emotions': { en: 'Managing Big Emotions', de: 'Grosse Gefühle bewältigen', fr: 'Gérer les grandes émotions', it: 'Gestire le Grandi Emozioni' },
    'first-school': { en: 'First Day of School', de: 'Erster Schultag', fr: "Premier jour d'école", it: 'Primo Giorno di Scuola' },
    homework: { en: 'Doing Homework', de: 'Hausaufgaben machen', fr: 'Faire ses devoirs', it: 'Fare i Compiti' },
    'losing-game': { en: 'Losing a Game', de: 'Verlieren können', fr: 'Savoir perdre', it: 'Saper Perdere' },
    'being-different': { en: 'Being Yourself', de: 'Du selbst sein', fr: 'Être soi-même', it: 'Essere se Stessi' },
    'dealing-bully': { en: 'Standing Up for Yourself', de: 'Für sich einstehen', fr: "S'affirmer face aux autres", it: 'Farsi Rispettare' },
    'telling-truth': { en: 'Telling the Truth', de: 'Die Wahrheit sagen', fr: 'Dire la vérité', it: 'Dire la Verità' },
    'moving-house': { en: 'Moving to a New Home', de: 'Umzug', fr: 'Déménagement', it: 'Il Trasloco' },
    'parents-splitting': { en: 'Parents Living Apart', de: 'Eltern leben getrennt', fr: 'Parents séparés', it: 'Genitori Separati' },
    'visiting-doctor': { en: 'Going to the Doctor', de: 'Arztbesuch', fr: 'Visite chez le médecin', it: 'Andare dal Dottore' },
    'staying-hospital': { en: 'Staying in Hospital', de: 'Im Krankenhaus', fr: "Séjour à l'hôpital", it: "Un Ricovero in Ospedale" },
    'death-pet': { en: 'Losing a Pet', de: 'Haustier verlieren', fr: "Perte d'un animal", it: 'La Perdita di un Animale' },
    'screen-time': { en: 'Screen Time Balance', de: 'Bildschirmzeit-Balance', fr: "Équilibre du temps d'écran", it: 'Il Tempo Davanti agli Schermi' },
    'peer-pressure': { en: 'Peer Pressure', de: 'Gruppenzwang', fr: 'Pression des pairs', it: 'La Pressione del Gruppo' },
    'anxiety-worrying': { en: 'Worry & Anxiety', de: 'Sorgen & Ängste', fr: 'Soucis & Anxiété', it: 'Preoccupazioni & Ansia' },
    'sibling-fighting': { en: 'Getting Along with Siblings', de: 'Geschwisterstreit', fr: "S'entendre avec ses frères et sœurs", it: 'Andare d\'Accordo tra Fratelli' },
    jealousy: { en: 'Dealing with Jealousy', de: 'Mit Eifersucht umgehen', fr: 'Gérer la jalousie', it: 'Gestire la Gelosia' },
    'not-giving-up': { en: 'Not Giving Up', de: 'Nicht aufgeben', fr: 'Ne pas abandonner', it: 'Non Arrendersi Mai' },
    'being-left-out': { en: 'Being Left Out', de: 'Ausgeschlossen werden', fr: "Être mis à l'écart", it: 'Essere Esclusi' },
    whining: { en: 'Using a Nice Voice', de: 'Nicht jammern', fr: 'Parler sans pleurnicher', it: 'Parlare Senza Piagnucolare' },
    'saying-sorry': { en: 'Saying Sorry & Meaning It', de: 'Sich aufrichtig entschuldigen', fr: "S'excuser sincèrement", it: 'Scusarsi Sinceramente' },
    'picky-eating': { en: 'Trying New Foods', de: 'Neues Essen probieren', fr: 'Goûter de nouveaux aliments', it: 'Assaggiare Cibi Nuovi' },
    'table-manners': { en: 'Table Manners', de: 'Tischmanieren', fr: 'Bonnes manières à table', it: 'Buone Maniere a Tavola' },
    'being-patient': { en: 'Learning to Be Patient', de: 'Geduld lernen', fr: 'Apprendre la patience', it: 'Imparare la Pazienza' },
    'reading-alone': { en: 'Learning to Read', de: 'Lesen lernen', fr: 'Apprendre à lire', it: 'Imparare a Leggere' },
    'trying-new-things': { en: 'Growing & Learning', de: 'Wachsen & Lernen', fr: 'Grandir & Apprendre', it: 'Crescere & Imparare' },
    'understanding-rules': { en: 'Why Parents Say No', de: 'Warum Eltern Nein sagen', fr: 'Pourquoi les parents disent non', it: 'Perché i Genitori Dicono No' },
    'tattling-vs-telling': { en: 'Tattling vs Telling', de: 'Petzen vs Um Hilfe bitten', fr: "Rapporter vs Demander de l'aide", it: 'Fare la Spia vs Chiedere Aiuto' },
    'dealing-disappointment': { en: 'Dealing with Disappointment', de: 'Mit Enttäuschung umgehen', fr: 'Gérer la déception', it: 'Affrontare la Delusione' },
    'taking-care-belongings': { en: 'Taking Care of Things', de: 'Auf Sachen aufpassen', fr: 'Prendre soin de ses affaires', it: 'Avere Cura delle Cose' },
    'helping-at-home': { en: 'Helping at Home', de: 'Im Haushalt helfen', fr: 'Aider à la maison', it: 'Aiutare in Casa' },
    'caring-for-pet': { en: 'Caring for a Pet', de: 'Sich um ein Haustier kümmern', fr: "Prendre soin d'un animal", it: 'Prendersi Cura di un Animale' },
    'going-vacation': { en: 'Going on Vacation', de: 'In den Urlaub fahren', fr: 'Partir en vacances', it: 'Andare in Vacanza' },
    'grandparent-sick': { en: 'Grandparent is Sick', de: 'Grosseltern sind krank', fr: 'Grand-parent malade', it: 'Il Nonno è Malato' },
    'money-saving': { en: 'Saving Money', de: 'Geld sparen', fr: "Économiser de l'argent", it: 'Risparmiare Denaro' },
    'spending-wisely': { en: 'Spending Wisely', de: 'Klug ausgeben', fr: 'Dépenser intelligemment', it: 'Spendere con Saggezza' },
    'body-changes': { en: 'Body Changes', de: 'Körperliche Veränderungen', fr: 'Changements corporels', it: 'Cambiamenti del Corpo' },
    responsibility: { en: 'Taking Responsibility', de: 'Verantwortung übernehmen', fr: 'Prendre ses responsabilités', it: 'Assumersi Responsabilità' },
    'managing-time': { en: 'Managing Time', de: 'Zeitmanagement', fr: 'Gestion du temps', it: 'Gestire il Tempo' },
    'online-safety': { en: 'Online Safety', de: 'Sicherheit im Internet', fr: 'Sécurité en ligne', it: 'Sicurezza Online' },
    'being-active': { en: 'Being Active & Going Outdoors', de: 'Aktiv sein & Rausgehen', fr: 'Être actif & Sortir dehors', it: "Muoversi & Stare all'Aperto" },
    'comparing-others': { en: 'Comparing Yourself to Others', de: 'Sich mit anderen vergleichen', fr: 'Se comparer aux autres', it: 'Confrontarsi con gli Altri' },
    'test-stress': { en: 'Test & Exam Stress', de: 'Prüfungsangst', fr: 'Stress des examens', it: "Ansia da Verifica" },
  },
  educational: {
    alphabet: { en: 'The Alphabet (ABC)', de: 'Das Alphabet (ABC)', fr: "L'Alphabet (ABC)", it: "L'Alfabeto (ABC)" },
    vowels: { en: 'Vowels', de: 'Vokale', fr: 'Voyelles', it: 'Vocali' },
    rhyming: { en: 'Rhyming Words', de: 'Reimwörter', fr: 'Mots qui riment', it: 'Parole in Rima' },
    'numbers-1-10': { en: 'Numbers 1-10', de: 'Zahlen 1-10', fr: 'Nombres 1-10', it: 'Numeri 1-10' },
    'numbers-1-20': { en: 'Numbers 1-20', de: 'Zahlen 1-20', fr: 'Nombres 1-20', it: 'Numeri 1-20' },
    counting: { en: 'Learning to Count', de: 'Zählen lernen', fr: 'Apprendre à compter', it: 'Imparare a Contare' },
    shapes: { en: 'Shapes', de: 'Formen', fr: 'Formes', it: 'Forme' },
    addition: { en: 'Simple Addition', de: 'Einfaches Addieren', fr: 'Addition simple', it: 'Addizioni Semplici' },
    'colors-basic': { en: 'Basic Colors', de: 'Grundfarben', fr: 'Couleurs de base', it: 'Colori di Base' },
    'colors-mixing': { en: 'Mixing Colors', de: 'Farben mischen', fr: 'Mélanger les couleurs', it: 'Mescolare i Colori' },
    planets: { en: 'Planets & Space', de: 'Planeten & Weltraum', fr: 'Planètes & Espace', it: 'Pianeti & Spazio' },
    seasons: { en: 'The Four Seasons', de: 'Die vier Jahreszeiten', fr: 'Les quatre saisons', it: 'Le Quattro Stagioni' },
    weather: { en: 'Weather', de: 'Wetter', fr: 'Météo', it: 'Il Tempo Atmosferico' },
    'water-cycle': { en: 'Water Cycle', de: 'Wasserkreislauf', fr: "Cycle de l'eau", it: "Il Ciclo dell'Acqua" },
    'plants-grow': { en: 'How Plants Grow', de: 'Wie Pflanzen wachsen', fr: 'Comment poussent les plantes', it: 'Come Crescono le Piante' },
    'day-night': { en: 'Day and Night', de: 'Tag und Nacht', fr: 'Jour et nuit', it: 'Giorno e Notte' },
    'farm-animals': { en: 'Farm Animals', de: 'Bauernhoftiere', fr: 'Animaux de la ferme', it: 'Animali della Fattoria' },
    'wild-animals': { en: 'Wild Animals', de: 'Wilde Tiere', fr: 'Animaux sauvages', it: 'Animali Selvatici' },
    'ocean-animals': { en: 'Ocean Animals', de: 'Meerestiere', fr: 'Animaux marins', it: 'Animali Marini' },
    insects: { en: 'Insects & Bugs', de: 'Insekten & Käfer', fr: 'Insectes', it: 'Insetti' },
    dinosaurs: { en: 'Dinosaurs', de: 'Dinosaurier', fr: 'Dinosaures', it: 'Dinosauri' },
    'body-parts': { en: 'Body Parts', de: 'Körperteile', fr: 'Parties du corps', it: 'Parti del Corpo' },
    'five-senses': { en: 'The Five Senses', de: 'Die fünf Sinne', fr: 'Les cinq sens', it: 'I Cinque Sensi' },
    'healthy-eating': { en: 'Healthy Eating', de: 'Gesund essen', fr: 'Manger sainement', it: 'Mangiare Sano' },
    'days-week': { en: 'Days of the Week', de: 'Wochentage', fr: 'Jours de la semaine', it: 'Giorni della Settimana' },
    'months-year': { en: 'Months of the Year', de: 'Monate des Jahres', fr: "Mois de l'année", it: "Mesi dell'Anno" },
    'telling-time': { en: 'Telling Time', de: 'Uhr lesen', fr: "Lire l'heure", it: "Leggere l'Orologio" },
    continents: { en: 'Continents', de: 'Kontinente', fr: 'Continents', it: 'Continenti' },
    'countries-flags': { en: 'Countries & Flags', de: 'Länder & Flaggen', fr: 'Pays & Drapeaux', it: 'Paesi & Bandiere' },
    instruments: { en: 'Musical Instruments', de: 'Musikinstrumente', fr: 'Instruments de musique', it: 'Strumenti Musicali' },
    'famous-artists': { en: 'Famous Artists', de: 'Berühmte Künstler', fr: 'Artistes célèbres', it: 'Artisti Famosi' },
  },
  historical: {
    'swiss-founding': { en: 'Founding of Switzerland', de: 'Gründung der Schweiz', fr: 'Fondation de la Suisse', it: 'Fondazione della Svizzera' },
    'wilhelm-tell': { en: 'Wilhelm Tell and the Apple', de: 'Wilhelm Tell und der Apfel', fr: 'Guillaume Tell et la pomme', it: 'Guglielmo Tell e la Mela' },
    'battle-morgarten': { en: 'Battle of Morgarten', de: 'Schlacht am Morgarten', fr: 'Bataille de Morgarten', it: 'Battaglia di Morgarten' },
    'battle-sempach': { en: 'Battle of Sempach', de: 'Schlacht bei Sempach', fr: 'Bataille de Sempach', it: 'Battaglia di Sempach' },
    'swiss-reformation': { en: 'Swiss Reformation', de: 'Schweizer Reformation', fr: 'Réforme Suisse', it: 'La Riforma Svizzera' },
    'red-cross-founding': { en: 'Henry Dunant Founds the Red Cross', de: 'Henry Dunant gründet das Rote Kreuz', fr: 'Henry Dunant fonde la Croix-Rouge', it: 'Henry Dunant Fonda la Croce Rossa' },
    'general-dufour': { en: 'General Dufour and Swiss Unity', de: 'General Dufour und die Schweizer Einheit', fr: "Général Dufour et l'unité suisse", it: "Il Generale Dufour e l'Unità Svizzera" },
    'sonderbund-war': { en: 'The Sonderbund War', de: 'Der Sonderbundskrieg', fr: 'La Guerre du Sonderbund', it: 'La Guerra del Sonderbund' },
    'swiss-constitution': { en: 'Swiss Federal Constitution', de: 'Schweizerische Bundesverfassung', fr: 'Constitution fédérale suisse', it: 'La Costituzione Federale Svizzera' },
    'gotthard-tunnel': { en: 'Building the Gotthard Tunnel', de: 'Bau des Gotthardtunnels', fr: 'Construction du tunnel du Gothard', it: 'La Costruzione della Galleria del Gottardo' },
    'swiss-ww1-neutrality': { en: 'Swiss Neutrality in WWI', de: 'Schweizer Neutralität im 1. Weltkrieg', fr: 'Neutralité suisse pendant la Première Guerre', it: 'La Neutralità Svizzera nella Prima Guerra' },
    'general-guisan': { en: 'General Guisan and the Rütli Report', de: 'General Guisan und der Rütlirapport', fr: 'Général Guisan et le Rapport du Grütli', it: 'Il Generale Guisan e il Rapporto del Grütli' },
    'swiss-ww2-neutrality': { en: 'Switzerland in World War II', de: 'Die Schweiz im 2. Weltkrieg', fr: 'La Suisse pendant la Seconde Guerre', it: 'La Svizzera nella Seconda Guerra Mondiale' },
    'swiss-womens-vote': { en: 'Swiss Women Win the Vote', de: 'Schweizer Frauenstimmrecht', fr: 'Droit de vote des femmes suisses', it: 'Il Diritto di Voto delle Donne Svizzere' },
    'moon-landing': { en: 'Neil Armstrong Lands on the Moon', de: 'Neil Armstrong landet auf dem Mond', fr: 'Neil Armstrong marche sur la Lune', it: 'Neil Armstrong Sbarca sulla Luna' },
    'columbus-voyage': { en: 'Columbus Reaches the Americas', de: 'Kolumbus erreicht Amerika', fr: 'Colomb atteint les Amériques', it: 'Colombo Raggiunge le Americhe' },
    'wright-brothers': { en: 'Wright Brothers Invent Powered Flight', de: 'Gebrüder Wright erfinden den Motorflug', fr: 'Les frères Wright inventent le vol motorisé', it: 'I Fratelli Wright Inventano il Volo' },
    'lindbergh-flight': { en: 'Lindbergh Crosses the Atlantic Solo', de: 'Lindbergh überquert den Atlantik allein', fr: "Lindbergh traverse l'Atlantique en solo", it: "Lindbergh Attraversa l'Atlantico in Solitaria" },
    'everest-summit': { en: 'Hillary & Tenzing Summit Everest', de: 'Hillary & Tenzing besteigen den Everest', fr: "Hillary & Tenzing au sommet de l'Everest", it: "Hillary e Tenzing sull'Everest" },
    'south-pole': { en: 'First to the South Pole', de: 'Erster am Südpol', fr: 'Premier au Pôle Sud', it: 'Il Primo al Polo Sud' },
    'magellan-circumnavigation': { en: 'First Circumnavigation', de: 'Erste Weltumsegelung', fr: 'Premier tour du monde', it: 'Il Primo Giro del Mondo' },
    'mariana-trench': { en: 'Deepest Ocean Dive', de: 'Tiefster Meerstauchgang', fr: 'Plongée la plus profonde', it: "L'Immersione più Profonda" },
    'electricity-discovery': { en: "Franklin's Kite Experiment", de: 'Franklins Drachenexperiment', fr: 'Expérience du cerf-volant', it: "L'Esperimento dell'Aquilone di Franklin" },
    penicillin: { en: 'Discovery of Penicillin', de: 'Entdeckung des Penicillins', fr: 'Découverte de la pénicilline', it: 'La Scoperta della Penicillina' },
    'vaccine-discovery': { en: 'First Vaccine', de: 'Erste Impfung', fr: 'Premier vaccin', it: 'Il Primo Vaccino' },
    'dna-discovery': { en: 'DNA Structure Discovered', de: 'DNA-Struktur entdeckt', fr: 'Structure ADN découverte', it: 'La Scoperta del DNA' },
    'dinosaur-discovery': { en: 'First Dinosaur Named', de: 'Erster Dinosaurier benannt', fr: 'Premier dinosaure nommé', it: 'Il Primo Dinosauro Classificato' },
    'einstein-relativity': { en: 'Einstein Discovers Relativity', de: 'Einstein entdeckt die Relativität', fr: 'Einstein découvre la relativité', it: 'Einstein Scopre la Relatività' },
    'galapagos-darwin': { en: 'Darwin Visits the Galápagos', de: 'Darwin besucht die Galápagos', fr: 'Darwin visite les Galápagos', it: 'Darwin alle Isole Galápagos' },
    'first-heart-transplant': { en: 'First Heart Transplant', de: 'Erste Herztransplantation', fr: 'Première greffe cardiaque', it: 'Il Primo Trapianto di Cuore' },
    'human-genome': { en: 'Human Genome Decoded', de: 'Menschliches Genom entschlüsselt', fr: 'Génome humain décodé', it: 'La Decifrazione del Genoma Umano' },
    'hubble-launch': { en: 'Hubble Telescope Launch', de: 'Hubble-Teleskop Start', fr: 'Lancement télescope Hubble', it: 'Il Lancio del Telescopio Hubble' },
    'telephone-invention': { en: 'First Telephone Call', de: 'Erster Telefonanruf', fr: 'Premier appel téléphonique', it: 'La Prima Telefonata' },
    'light-bulb': { en: "Edison's Light Bulb", de: 'Edisons Glühbirne', fr: "Ampoule d'Edison", it: 'La Lampadina di Edison' },
    'printing-press': { en: 'Gutenberg Invents the Printing Press', de: 'Gutenberg erfindet den Buchdruck', fr: "Gutenberg invente l'imprimerie", it: 'Gutenberg Inventa la Stampa' },
    'internet-creation': { en: 'Birth of the World Wide Web', de: 'Geburt des World Wide Web', fr: 'Naissance du Web', it: 'La Nascita del Web' },
    emancipation: { en: 'Abolition of Slavery', de: 'Abschaffung der Sklaverei', fr: "Abolition de l'esclavage", it: "L'Abolizione della Schiavitù" },
    'womens-suffrage': { en: 'Women Win the Vote', de: 'Frauenwahlrecht', fr: 'Droit de vote des femmes', it: 'Il Diritto di Voto alle Donne' },
    'rosa-parks': { en: 'Rosa Parks & Bus Boycott', de: 'Rosa Parks & Busboykott', fr: 'Rosa Parks & Boycott des bus', it: 'Rosa Parks e il Boicottaggio degli Autobus' },
    'berlin-wall-fall': { en: 'Fall of the Berlin Wall', de: 'Fall der Berliner Mauer', fr: 'Chute du mur de Berlin', it: 'La Caduta del Muro di Berlino' },
    'mandela-freedom': { en: 'Mandela Wins Freedom', de: 'Mandela erringt die Freiheit', fr: 'Mandela gagne sa liberté', it: 'Mandela Conquista la Libertà' },
    pyramids: { en: 'Building the Great Pyramids', de: 'Bau der Pyramiden', fr: 'Construction des Pyramides', it: 'La Costruzione delle Piramidi' },
    'eiffel-tower': { en: 'Eiffel Tower Opens', de: 'Eiffelturm eröffnet', fr: 'Tour Eiffel inaugurée', it: 'Inaugurazione della Torre Eiffel' },
    'panama-canal': { en: 'Panama Canal Opens', de: 'Panamakanal eröffnet', fr: 'Canal de Panama inauguré', it: 'Inaugurazione del Canale di Panama' },
    'golden-gate': { en: 'Building the Golden Gate Bridge', de: 'Bau der Golden Gate Bridge', fr: 'Construction du pont Golden Gate', it: 'La Costruzione del Golden Gate' },
    'channel-tunnel': { en: 'Channel Tunnel Opens', de: 'Eurotunnel eröffnet', fr: 'Tunnel sous la Manche', it: "Inaugurazione dell'Eurotunnel" },
    'first-olympics': { en: 'First Modern Olympics', de: 'Erste moderne Olympiade', fr: 'Premiers Jeux Olympiques modernes', it: 'Le Prime Olimpiadi Moderne' },
    'disneyland-opening': { en: 'Disneyland Opens', de: 'Disneyland eröffnet', fr: 'Disneyland ouvre', it: 'Apertura di Disneyland' },
    'first-movie': { en: 'Birth of Cinema', de: 'Geburt des Kinos', fr: 'Naissance du cinéma', it: 'La Nascita del Cinema' },
    'first-zoo': { en: 'First Modern Zoo Opens', de: 'Erster moderner Zoo', fr: 'Premier zoo moderne', it: 'Il Primo Zoo Moderno' },
    'natural-history-museum': { en: 'Natural History Museum Opens', de: 'Naturhistorisches Museum', fr: "Musée d'Histoire Naturelle", it: 'Il Museo di Storia Naturale' },
    'king-tut': { en: "King Tut's Tomb Discovered", de: 'Tutanchamuns Grab entdeckt', fr: 'Tombeau de Toutânkhamon', it: 'La Tomba di Tutankhamon' },
    'pompeii-discovery': { en: 'Rediscovery of Pompeii', de: 'Wiederentdeckung von Pompeji', fr: 'Redécouverte de Pompéi', it: 'La Riscoperta di Pompei' },
    'terracotta-army': { en: 'Terracotta Army Discovered', de: 'Terrakotta-Armee entdeckt', fr: 'Armée de terre cuite', it: "L'Esercito di Terracotta" },
  },
};

// ─── Static Route Meta ────────────────────────────────────────────────────────

const STATIC_ROUTES = {
  '/': {
    title: {
      en: 'Magical Story – Your Child as the Hero of Their Own Book',
      de: 'Magical Story – Dein Kind als Held seiner eigenen Geschichte',
      fr: 'Magical Story – Votre enfant héros de son propre livre',
      it: 'Magical Story – Il tuo bambino protagonista della sua storia',
    },
    description: {
      en: 'Make your child the hero of their own story. Upload a photo, pick a theme, create your first story free.',
      de: 'Mach dein Kind zum Helden seiner eigenen Geschichte. Foto hochladen, Thema wählen, erste Geschichte gratis erstellen.',
      fr: 'Faites de votre enfant le héros de sa propre histoire. Téléchargez une photo, choisissez un thème, créez votre première histoire gratuitement.',
      it: 'Rendi il tuo bambino il protagonista della sua storia. Carica una foto, scegli un tema, crea gratis la prima storia.',
    },
  },
  '/pricing': {
    title: {
      en: 'Pricing – Magical Story',
      de: 'Preise – Magical Story',
      fr: 'Tarifs – Magical Story',
      it: 'Prezzi – Magical Story',
    },
    description: {
      en: 'Your first story is free. Printed books start at CHF 33. View all pricing plans for Magical Story.',
      de: 'Deine erste Geschichte ist gratis. Gedruckte Bücher ab CHF 33. Alle Preise für Magical Story.',
      fr: 'Votre première histoire est gratuite. Livres imprimés dès CHF 33. Tous les tarifs de Magical Story.',
      it: 'La tua prima storia è gratis. Libri stampati da CHF 33. Tutti i prezzi di Magical Story.',
    },
  },
  '/faq': {
    title: {
      en: 'FAQ – Magical Story',
      de: 'Häufige Fragen – Magical Story',
      fr: 'FAQ – Magical Story',
      it: 'FAQ – Magical Story',
    },
    description: {
      en: 'Frequently asked questions about Magical Story. Learn how personalized children\'s books work, pricing, and more.',
      de: 'Häufig gestellte Fragen zu Magical Story. Erfahre, wie personalisierte Kinderbücher funktionieren, Preise und mehr.',
      fr: 'Questions fréquemment posées sur Magical Story. Découvrez comment fonctionnent les livres personnalisés pour enfants.',
      it: 'Domande frequenti su Magical Story. Scopri come funzionano i libri personalizzati per bambini, i prezzi e altro.',
    },
  },
  '/ratgeber': {
    title: {
      en: 'Guides — Making and Choosing Children\'s Books | Magical Story',
      de: 'Ratgeber — Kinderbücher erstellen und Anbieter wählen | Magical Story',
      fr: 'Guides — Créer un livre pour enfant et choisir un service | Magical Story',
      it: 'Guide — Creare e scegliere un libro per bambini | Magical Story',
    },
    description: {
      en: 'Practical guides on creating a children\'s book with AI, keeping characters consistent, writing for a child\'s reading level, and choosing between personalized book services.',
      de: 'Praktische Ratgeber zum Kinderbuch-Erstellen mit KI: Figuren konsistent halten, altersgerecht schreiben und zwischen Anbietern personalisierter Bücher wählen.',
      fr: 'Guides pratiques pour créer un livre pour enfant avec l\'IA, garder des personnages cohérents, écrire au bon niveau de lecture et choisir entre les services de livres personnalisés.',
      it: 'Guide pratiche per creare un libro per bambini con l\'IA, mantenere i personaggi coerenti, scrivere al giusto livello di lettura e scegliere tra i servizi di libri personalizzati.',
    },
  },
  '/kinderbuch-erstellen': {
    title: {
      en: 'Create a Children\'s Book with AI – Your Own Story | Magical Story',
      de: 'Kinderbuch erstellen mit KI – deine eigene Geschichte | Magical Story',
      fr: 'Créer un livre pour enfant avec l\'IA – votre propre histoire | Magical Story',
      it: 'Crea un libro per bambini con l\'IA – la tua storia | Magical Story',
    },
    description: {
      en: 'Create your own children\'s book: upload a photo, describe the story you want, and AI writes and illustrates it. Not a template with the name swapped — an original story. Edit every word and regenerate any page. First story free.',
      de: 'Kinderbuch selbst erstellen: Foto hochladen, deine Geschichte beschreiben, die KI schreibt und illustriert sie. Keine Vorlage mit ausgetauschtem Namen — eine eigene Geschichte. Jedes Wort bearbeiten, jede Seite neu generieren. Erste Geschichte gratis.',
      fr: 'Créez votre propre livre pour enfant : téléchargez une photo, décrivez votre histoire, l\'IA l\'écrit et l\'illustre. Pas un modèle avec le prénom remplacé — une histoire originale. Modifiez chaque mot, régénérez chaque page. Première histoire gratuite.',
      it: 'Crea il tuo libro per bambini: carica una foto, descrivi la storia che vuoi, l\'IA la scrive e la illustra. Non un modello col nome cambiato — una storia originale. Modifica ogni parola, rigenera ogni pagina. Prima storia gratis.',
    },
  },
  '/about': {
    title: {
      en: 'About – Magical Story',
      de: 'Über uns – Magical Story',
      fr: 'À propos – Magical Story',
      it: 'Chi siamo – Magical Story',
    },
    description: {
      en: 'Magical Story is made in Switzerland. We believe every child deserves to see themselves as the hero of their own story.',
      de: 'Magical Story kommt aus der Schweiz. Wir glauben, dass jedes Kind verdient, der Held seiner eigenen Geschichte zu sein.',
      fr: 'Magical Story est conçu en Suisse. Nous croyons que chaque enfant mérite d\'être le héros de sa propre histoire.',
      it: 'Magical Story nasce in Svizzera. Crediamo che ogni bambino meriti di essere il protagonista della propria storia.',
    },
  },
  '/contact': {
    title: {
      en: 'Contact – Magical Story',
      de: 'Kontakt – Magical Story',
      fr: 'Contact – Magical Story',
      it: 'Contatto – Magical Story',
    },
    description: {
      en: 'Get in touch with the Magical Story team. We\'re here to help with your personalized children\'s books.',
      de: 'Kontaktiere das Magical Story Team. Wir helfen dir gerne bei deinen personalisierten Kinderbüchern.',
      fr: 'Contactez l\'équipe Magical Story. Nous sommes là pour vous aider avec vos livres personnalisés.',
      it: 'Contatta il team di Magical Story. Siamo qui per aiutarti con i tuoi libri personalizzati per bambini.',
    },
  },
  '/try': {
    title: {
      en: 'Create Your Free Story – Magical Story',
      de: 'Gratis Geschichte erstellen – Magical Story',
      fr: 'Créez votre histoire gratuite – Magical Story',
      it: 'Crea la tua storia gratis – Magical Story',
    },
    description: {
      en: 'Create your first personalized children\'s story for free. Upload a photo and choose a theme to get started.',
      de: 'Erstelle deine erste personalisierte Kindergeschichte gratis. Foto hochladen und Thema wählen.',
      fr: 'Créez votre première histoire personnalisée gratuitement. Téléchargez une photo et choisissez un thème.',
      it: 'Crea gratis la tua prima storia personalizzata. Carica una foto e scegli un tema per iniziare.',
    },
  },
  '/terms': {
    title: {
      en: 'Terms of Service – Magical Story',
      de: 'Nutzungsbedingungen – Magical Story',
      fr: 'Conditions d\'utilisation – Magical Story',
      it: 'Termini di servizio – Magical Story',
    },
    description: {
      en: 'Terms of service for Magical Story personalized children\'s books.',
      de: 'Nutzungsbedingungen für Magical Story personalisierte Kinderbücher.',
      fr: 'Conditions d\'utilisation de Magical Story, livres personnalisés pour enfants.',
      it: 'Termini di servizio per i libri personalizzati per bambini di Magical Story.',
    },
  },
  '/privacy': {
    title: {
      en: 'Privacy Policy – Magical Story',
      de: 'Datenschutz – Magical Story',
      fr: 'Politique de confidentialité – Magical Story',
      it: 'Informativa sulla privacy – Magical Story',
    },
    description: {
      en: 'Privacy policy for Magical Story. Learn how we protect your data and photos.',
      de: 'Datenschutzerklärung für Magical Story. Erfahre, wie wir deine Daten und Fotos schützen.',
      fr: 'Politique de confidentialité de Magical Story. Découvrez comment nous protégeons vos données et photos.',
      it: 'Informativa sulla privacy di Magical Story. Scopri come proteggiamo i tuoi dati e le tue foto.',
    },
  },
  '/impressum': {
    title: {
      en: 'Impressum – Magical Story',
      de: 'Impressum – Magical Story',
      fr: 'Impressum – Magical Story',
      it: 'Impressum – Magical Story',
    },
    description: {
      en: 'Legal notice and imprint for Magical Story.',
      de: 'Impressum und rechtliche Hinweise für Magical Story.',
      fr: 'Mentions légales et impressum de Magical Story.',
      it: 'Note legali e impressum di Magical Story.',
    },
  },
  '/science': {
    title: {
      en: 'Why Personalized Books Work – The Science | Magical Story',
      de: 'Warum personalisierte Kinderbücher wirken | Magical Story',
      fr: 'Pourquoi les livres personnalisés fonctionnent | Magical Story',
      it: 'Perché i libri personalizzati funzionano | Magical Story',
    },
    description: {
      en: 'Children remember more, engage more deeply, and build confidence when they see themselves as the hero. The perfect personalized gift for birthdays and special occasions.',
      de: 'Kinder erinnern sich an mehr, tauchen tiefer ein und bauen Selbstvertrauen auf, wenn sie der Held der Geschichte sind. Das perfekte personalisierte Geschenk für Geburtstage und besondere Anlässe.',
      fr: 'Les enfants retiennent plus, s\'engagent plus profondément et développent leur confiance quand ils sont le héros. Le cadeau personnalisé parfait pour les anniversaires.',
      it: 'I bambini ricordano di più, si coinvolgono più a fondo e crescono in sicurezza quando sono loro il protagonista. Il regalo personalizzato perfetto per compleanni e occasioni speciali.',
    },
  },
  '/themes': {
    title: {
      en: 'Story Themes – Magical Story',
      de: 'Geschichten-Themen – Magical Story',
      fr: 'Thèmes d\'histoires – Magical Story',
      it: 'Temi delle storie – Magical Story',
    },
    description: {
      en: 'Browse all story themes: adventure, life challenges, educational, and historical. Create a personalized book for your child.',
      de: 'Alle Geschichten-Themen entdecken: Abenteuer, Lebensherausforderungen, Lehrreiches und Historisches. Ein personalisiertes Buch erstellen.',
      fr: 'Parcourez tous les thèmes: aventure, défis de vie, éducatif et historique. Créez un livre personnalisé pour votre enfant.',
      it: 'Scopri tutti i temi delle storie: avventura, sfide della vita, educativi e storici. Crea un libro personalizzato per il tuo bambino.',
    },
  },
  '/geschichten-aus': {
    title: {
      de: 'Kindergeschichten aus der Schweiz | MagicalStory',
      en: 'Children\'s Stories from Switzerland | MagicalStory',
      fr: 'Histoires pour enfants de Suisse | MagicalStory',
      it: 'Storie per bambini dalla Svizzera | MagicalStory',
    },
    description: {
      de: 'Personalisierte Kindergeschichten aus 50 Schweizer Städten. Dein Kind erlebt Abenteuer in Zürich, Bern, Basel und mehr.',
      en: 'Personalized children\'s stories from 50 Swiss cities. Your child goes on adventures in Zurich, Bern, Basel and more.',
      fr: 'Histoires personnalisées pour enfants de 50 villes suisses. Votre enfant vit des aventures à Zurich, Berne, Bâle et plus.',
      it: 'Storie personalizzate per bambini da 50 città svizzere. Il tuo bambino vive avventure a Zurigo, Berna, Basilea e altre città.',
    },
  },
  '/stadt': {
    title: {
      de: 'Kindergeschichten aus der Schweiz — Alle Städte | MagicalStory',
      en: 'Children\'s Stories from Switzerland — All Cities | MagicalStory',
      fr: 'Histoires pour enfants de Suisse — Toutes les villes | MagicalStory',
      it: 'Storie per bambini dalla Svizzera — Tutte le città | MagicalStory',
    },
    description: {
      de: 'Personalisierte Kindergeschichten aus 100 Schweizer Städten. Entdecke Geschichte und Sagen aus deiner Stadt — dein Kind wird zum Helden.',
      en: 'Personalized children\'s stories from 100 Swiss cities. Discover history and legends from your city — your child becomes the hero.',
      fr: 'Histoires personnalisées pour enfants de 100 villes suisses. Découvrez l\'histoire et les légendes de votre ville — votre enfant devient le héros.',
      it: 'Storie personalizzate per bambini da 100 città svizzere. Scopri la storia e le leggende della tua città — il tuo bambino diventa il protagonista.',
    },
  },
  '/vergleich': {
    title: {
      de: 'MagicalStory im Vergleich | Personalisierte Kinderbücher',
      en: 'MagicalStory Compared | Personalized Children\'s Books',
      fr: 'MagicalStory en comparaison | Livres personnalisés pour enfants',
      it: 'MagicalStory a confronto | Libri personalizzati per bambini',
    },
    description: {
      de: 'Ehrlicher Vergleich von MagicalStory mit Wonderbly, Hooray Heroes, Librio und anderen personalisierten Kinderbuch-Anbietern.',
      en: 'Honest comparison of MagicalStory with Wonderbly, Hooray Heroes, Librio, and other personalized children\'s book providers.',
      fr: 'Comparaison honnête de MagicalStory avec Wonderbly, Hooray Heroes, Librio et d\'autres fournisseurs de livres personnalisés.',
      it: 'Confronto onesto di MagicalStory con Wonderbly, Hooray Heroes, Librio e altri fornitori di libri personalizzati per bambini.',
    },
  },
  '/anlass': {
    title: {
      de: 'Das perfekte Geschenk für jeden Anlass | MagicalStory',
      en: 'The Perfect Gift for Every Occasion | MagicalStory',
      fr: 'Le cadeau parfait pour chaque occasion | MagicalStory',
      it: 'Il regalo perfetto per ogni occasione | MagicalStory',
    },
    description: {
      de: 'Personalisierte Kinderbücher als Geschenk: Geburtstag, Weihnachten, Taufe, Einschulung und mehr. Erste Geschichte gratis.',
      en: 'Personalized children\'s books as gifts: birthdays, Christmas, baptism, first day of school and more. First story free.',
      fr: 'Livres personnalisés comme cadeau: anniversaire, Noël, baptême, rentrée et plus. Première histoire gratuite.',
      it: 'Libri personalizzati per bambini come regalo: compleanno, Natale, battesimo, inizio scuola e altro. Prima storia gratuita.',
    },
  },
  '/geschenk': {
    title: {
      de: 'Geschenkideen für Kinder | Personalisierte Kinderbücher | MagicalStory',
      en: 'Gift Ideas for Kids | Personalized Children\'s Books | MagicalStory',
      fr: 'Idées cadeaux pour enfants | Livres personnalisés | MagicalStory',
      it: 'Idee regalo per bambini | Libri personalizzati | MagicalStory',
    },
    description: {
      de: 'Finde das perfekte Geschenk für Kinder: einzigartige, personalisierte Kinderbücher mit dem Foto deines Kindes. Für Enkel, Patenkinder, zu Weihnachten, Ostern & mehr.',
      en: 'Find the perfect gift for kids: unique, personalized children\'s books with your child\'s photo. For grandkids, godchildren, Christmas, Easter & more.',
      fr: 'Trouvez le cadeau parfait pour enfants: livres personnalisés uniques avec la photo de votre enfant. Pour petits-enfants, filleuls, Noël, Pâques et plus.',
      it: 'Trova il regalo perfetto per bambini: libri personalizzati unici con la foto del tuo bambino. Per nipoti, figliocci, Natale, Pasqua e altro.',
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
  zuerich: { name: 'Zürich', de: 'Kindergeschichten aus Zürich', en: 'Children\'s Stories from Zurich', fr: 'Histoires pour enfants de Zurich', it: 'Storie per bambini da Zurigo' },
  basel: { name: 'Basel', de: 'Kindergeschichten aus Basel', en: 'Children\'s Stories from Basel', fr: 'Histoires pour enfants de Bâle', it: 'Storie per bambini da Basilea' },
  bern: { name: 'Bern', de: 'Kindergeschichten aus Bern', en: 'Children\'s Stories from Bern', fr: 'Histoires pour enfants de Berne', it: 'Storie per bambini da Berna' },
  luzern: { name: 'Luzern', de: 'Kindergeschichten aus Luzern', en: 'Children\'s Stories from Lucerne', fr: 'Histoires pour enfants de Lucerne', it: 'Storie per bambini da Lucerna' },
  'st-gallen': { name: 'St. Gallen', de: 'Kindergeschichten aus St. Gallen', en: 'Children\'s Stories from St. Gallen', fr: 'Histoires pour enfants de Saint-Gall', it: 'Storie per bambini da San Gallo' },
  winterthur: { name: 'Winterthur', de: 'Kindergeschichten aus Winterthur', en: 'Children\'s Stories from Winterthur', fr: 'Histoires pour enfants de Winterthour', it: 'Storie per bambini da Winterthur' },
  zug: { name: 'Zug', de: 'Kindergeschichten aus Zug', en: 'Children\'s Stories from Zug', fr: 'Histoires pour enfants de Zoug', it: 'Storie per bambini da Zug' },
  thun: { name: 'Thun', de: 'Kindergeschichten aus Thun', en: 'Children\'s Stories from Thun', fr: 'Histoires pour enfants de Thoune', it: 'Storie per bambini da Thun' },
  aarau: { name: 'Aarau', de: 'Kindergeschichten aus Aarau', en: 'Children\'s Stories from Aarau', fr: 'Histoires pour enfants d\'Aarau', it: 'Storie per bambini da Aarau' },
  baden: { name: 'Baden', de: 'Kindergeschichten aus Baden', en: 'Children\'s Stories from Baden', fr: 'Histoires pour enfants de Baden', it: 'Storie per bambini da Baden' },
  schaffhausen: { name: 'Schaffhausen', de: 'Kindergeschichten aus Schaffhausen', en: 'Children\'s Stories from Schaffhausen', fr: 'Histoires pour enfants de Schaffhouse', it: 'Storie per bambini da Sciaffusa' },
  olten: { name: 'Olten', de: 'Kindergeschichten aus Olten', en: 'Children\'s Stories from Olten', fr: 'Histoires pour enfants d\'Olten', it: 'Storie per bambini da Olten' },
  chur: { name: 'Chur', de: 'Kindergeschichten aus Chur', en: 'Children\'s Stories from Chur', fr: 'Histoires pour enfants de Coire', it: 'Storie per bambini da Coira' },
  solothurn: { name: 'Solothurn', de: 'Kindergeschichten aus Solothurn', en: 'Children\'s Stories from Solothurn', fr: 'Histoires pour enfants de Soleure', it: 'Storie per bambini da Soletta' },
  'rapperswil-jona': { name: 'Rapperswil-Jona', de: 'Kindergeschichten aus Rapperswil-Jona', en: 'Children\'s Stories from Rapperswil-Jona', fr: 'Histoires pour enfants de Rapperswil-Jona', it: 'Storie per bambini da Rapperswil-Jona' },
  uster: { name: 'Uster', de: 'Kindergeschichten aus Uster', en: 'Children\'s Stories from Uster', fr: 'Histoires pour enfants d\'Uster', it: 'Storie per bambini da Uster' },
  davos: { name: 'Davos', de: 'Kindergeschichten aus Davos', en: 'Children\'s Stories from Davos', fr: 'Histoires pour enfants de Davos', it: 'Storie per bambini da Davos' },
  interlaken: { name: 'Interlaken', de: 'Kindergeschichten aus Interlaken', en: 'Children\'s Stories from Interlaken', fr: 'Histoires pour enfants d\'Interlaken', it: 'Storie per bambini da Interlaken' },
  koeniz: { name: 'Köniz', de: 'Kindergeschichten aus Köniz', en: 'Children\'s Stories from Köniz', fr: 'Histoires pour enfants de Köniz', it: 'Storie per bambini da Köniz' },
  emmen: { name: 'Emmen', de: 'Kindergeschichten aus Emmen', en: 'Children\'s Stories from Emmen', fr: 'Histoires pour enfants d\'Emmen', it: 'Storie per bambini da Emmen' },
  kriens: { name: 'Kriens', de: 'Kindergeschichten aus Kriens', en: 'Children\'s Stories from Kriens', fr: 'Histoires pour enfants de Kriens', it: 'Storie per bambini da Kriens' },
  horgen: { name: 'Horgen', de: 'Kindergeschichten aus Horgen', en: 'Children\'s Stories from Horgen', fr: 'Histoires pour enfants de Horgen', it: 'Storie per bambini da Horgen' },
  waedenswil: { name: 'Wädenswil', de: 'Kindergeschichten aus Wädenswil', en: 'Children\'s Stories from Wädenswil', fr: 'Histoires pour enfants de Wädenswil', it: 'Storie per bambini da Wädenswil' },
  dietikon: { name: 'Dietikon', de: 'Kindergeschichten aus Dietikon', en: 'Children\'s Stories from Dietikon', fr: 'Histoires pour enfants de Dietikon', it: 'Storie per bambini da Dietikon' },
  duebendorf: { name: 'Dübendorf', de: 'Kindergeschichten aus Dübendorf', en: 'Children\'s Stories from Dübendorf', fr: 'Histoires pour enfants de Dübendorf', it: 'Storie per bambini da Dübendorf' },
  kloten: { name: 'Kloten', de: 'Kindergeschichten aus Kloten', en: 'Children\'s Stories from Kloten', fr: 'Histoires pour enfants de Kloten', it: 'Storie per bambini da Kloten' },
  wetzikon: { name: 'Wetzikon', de: 'Kindergeschichten aus Wetzikon', en: 'Children\'s Stories from Wetzikon', fr: 'Histoires pour enfants de Wetzikon', it: 'Storie per bambini da Wetzikon' },
  frauenfeld: { name: 'Frauenfeld', de: 'Kindergeschichten aus Frauenfeld', en: 'Children\'s Stories from Frauenfeld', fr: 'Histoires pour enfants de Frauenfeld', it: 'Storie per bambini da Frauenfeld' },
  kreuzlingen: { name: 'Kreuzlingen', de: 'Kindergeschichten aus Kreuzlingen', en: 'Children\'s Stories from Kreuzlingen', fr: 'Histoires pour enfants de Kreuzlingen', it: 'Storie per bambini da Kreuzlingen' },
  rheinfelden: { name: 'Rheinfelden', de: 'Kindergeschichten aus Rheinfelden', en: 'Children\'s Stories from Rheinfelden', fr: 'Histoires pour enfants de Rheinfelden', it: 'Storie per bambini da Rheinfelden' },
  lausanne: { name: 'Lausanne', de: 'Kindergeschichten aus Lausanne', en: 'Children\'s Stories from Lausanne', fr: 'Histoires pour enfants de Lausanne', it: 'Storie per bambini da Losanna' },
  geneve: { name: 'Genève', de: 'Kindergeschichten aus Genf', en: 'Children\'s Stories from Geneva', fr: 'Histoires pour enfants de Genève', it: 'Storie per bambini da Ginevra' },
  'biel-bienne': { name: 'Biel/Bienne', de: 'Kindergeschichten aus Biel', en: 'Children\'s Stories from Biel', fr: 'Histoires pour enfants de Bienne', it: 'Storie per bambini da Bienne' },
  fribourg: { name: 'Fribourg', de: 'Kindergeschichten aus Freiburg', en: 'Children\'s Stories from Fribourg', fr: 'Histoires pour enfants de Fribourg', it: 'Storie per bambini da Friburgo' },
  neuchatel: { name: 'Neuchâtel', de: 'Kindergeschichten aus Neuenburg', en: 'Children\'s Stories from Neuchâtel', fr: 'Histoires pour enfants de Neuchâtel', it: 'Storie per bambini da Neuchâtel' },
  montreux: { name: 'Montreux', de: 'Kindergeschichten aus Montreux', en: 'Children\'s Stories from Montreux', fr: 'Histoires pour enfants de Montreux', it: 'Storie per bambini da Montreux' },
  nyon: { name: 'Nyon', de: 'Kindergeschichten aus Nyon', en: 'Children\'s Stories from Nyon', fr: 'Histoires pour enfants de Nyon', it: 'Storie per bambini da Nyon' },
  vevey: { name: 'Vevey', de: 'Kindergeschichten aus Vevey', en: 'Children\'s Stories from Vevey', fr: 'Histoires pour enfants de Vevey', it: 'Storie per bambini da Vevey' },
  morges: { name: 'Morges', de: 'Kindergeschichten aus Morges', en: 'Children\'s Stories from Morges', fr: 'Histoires pour enfants de Morges', it: 'Storie per bambini da Morges' },
  yverdon: { name: 'Yverdon-les-Bains', de: 'Kindergeschichten aus Yverdon', en: 'Children\'s Stories from Yverdon', fr: 'Histoires pour enfants d\'Yverdon', it: 'Storie per bambini da Yverdon' },
  'la-chaux-de-fonds': { name: 'La Chaux-de-Fonds', de: 'Kindergeschichten aus La Chaux-de-Fonds', en: 'Children\'s Stories from La Chaux-de-Fonds', fr: 'Histoires pour enfants de La Chaux-de-Fonds', it: 'Storie per bambini da La Chaux-de-Fonds' },
  sion: { name: 'Sion', de: 'Kindergeschichten aus Sitten', en: 'Children\'s Stories from Sion', fr: 'Histoires pour enfants de Sion', it: 'Storie per bambini da Sion' },
  sierre: { name: 'Sierre', de: 'Kindergeschichten aus Siders', en: 'Children\'s Stories from Sierre', fr: 'Histoires pour enfants de Sierre', it: 'Storie per bambini da Sierre' },
  delemont: { name: 'Delémont', de: 'Kindergeschichten aus Delsberg', en: 'Children\'s Stories from Delémont', fr: 'Histoires pour enfants de Delémont', it: 'Storie per bambini da Delémont' },
  martigny: { name: 'Martigny', de: 'Kindergeschichten aus Martigny', en: 'Children\'s Stories from Martigny', fr: 'Histoires pour enfants de Martigny', it: 'Storie per bambini da Martigny' },
  lugano: { name: 'Lugano', de: 'Kindergeschichten aus Lugano', en: 'Children\'s Stories from Lugano', fr: 'Histoires pour enfants de Lugano', it: 'Storie per bambini da Lugano' },
  locarno: { name: 'Locarno', de: 'Kindergeschichten aus Locarno', en: 'Children\'s Stories from Locarno', fr: 'Histoires pour enfants de Locarno', it: 'Storie per bambini da Locarno' },
  bellinzona: { name: 'Bellinzona', de: 'Kindergeschichten aus Bellinzona', en: 'Children\'s Stories from Bellinzona', fr: 'Histoires pour enfants de Bellinzone', it: 'Storie per bambini da Bellinzona' },
  mendrisio: { name: 'Mendrisio', de: 'Kindergeschichten aus Mendrisio', en: 'Children\'s Stories from Mendrisio', fr: 'Histoires pour enfants de Mendrisio', it: 'Storie per bambini da Mendrisio' },
  chiasso: { name: 'Chiasso', de: 'Kindergeschichten aus Chiasso', en: 'Children\'s Stories from Chiasso', fr: 'Histoires pour enfants de Chiasso', it: 'Storie per bambini da Chiasso' },
};

// ─── Comparison Data (for meta tags) ──────────────────────────────────────────

const COMPARISONS = {
  wonderbly: { name: 'Wonderbly', de: 'MagicalStory vs Wonderbly', en: 'MagicalStory vs Wonderbly', fr: 'MagicalStory vs Wonderbly', it: 'MagicalStory vs Wonderbly' },
  'hooray-heroes': { name: 'Hooray Heroes', de: 'MagicalStory vs Hooray Heroes', en: 'MagicalStory vs Hooray Heroes', fr: 'MagicalStory vs Hooray Heroes', it: 'MagicalStory vs Hooray Heroes' },
  librio: { name: 'Librio', de: 'MagicalStory vs Librio', en: 'MagicalStory vs Librio', fr: 'MagicalStory vs Librio', it: 'MagicalStory vs Librio' },
  framily: { name: 'Framily', de: 'MagicalStory vs Framily', en: 'MagicalStory vs Framily', fr: 'MagicalStory vs Framily', it: 'MagicalStory vs Framily' },
  'lullaby-ink': { name: 'Lullaby.ink', de: 'MagicalStory vs Lullaby.ink', en: 'MagicalStory vs Lullaby.ink', fr: 'MagicalStory vs Lullaby.ink', it: 'MagicalStory vs Lullaby.ink' },
  lovetoread: { name: 'LoveToRead', de: 'MagicalStory vs LoveToRead', en: 'MagicalStory vs LoveToRead', fr: 'MagicalStory vs LoveToRead', it: 'MagicalStory vs LoveToRead' },
  buchheldenwelt: { name: 'BuchHeldenWelt', de: 'MagicalStory vs BuchHeldenWelt', en: 'MagicalStory vs BuchHeldenWelt', fr: 'MagicalStory vs BuchHeldenWelt', it: 'MagicalStory vs BuchHeldenWelt' },
  // NOTE: mirrors client/src/constants/comparisonData.ts — both must be edited.
  'magisches-kinderbuch': { name: 'Magisches Kinderbuch', de: 'MagicalStory vs Magisches Kinderbuch', en: 'MagicalStory vs Magisches Kinderbuch', fr: 'MagicalStory vs Magisches Kinderbuch', it: 'MagicalStory vs Magisches Kinderbuch' },
  'beste-personalisierte-kinderbuecher': { name: 'Beste Kinderbücher', de: 'Beste personalisierte Kinderbücher Schweiz 2026', en: 'Best Personalized Children\'s Books Switzerland 2026', fr: 'Meilleurs livres personnalisés pour enfants Suisse 2026', it: 'Migliori libri personalizzati per bambini Svizzera 2026' },
  'beste-ki-kinderbuch-generatoren': { name: 'Beste KI-Generatoren', de: 'Beste KI-Kinderbuch-Generatoren 2026', en: 'Best AI Children\'s Book Generators 2026', fr: 'Meilleurs générateurs de livres IA pour enfants 2026', it: 'Migliori generatori IA di libri per bambini 2026' },
};

// ─── Guide Data (for meta tags) ───────────────────────────────────────────────
// The /ratgeber editorial cluster. Mirrors client/src/constants/guideData.ts —
// both must be edited when a guide is added, same as COMPARISONS above.
// Descriptions are kept in sync with the `description` field of each article.

const GUIDES = {
  'kinderbuch-mit-ki-erstellen': {
    title: {
      de: 'Kinderbuch mit KI erstellen: die praktische Anleitung',
      en: 'How to Create a Children\'s Book with AI: A Practical Guide',
      fr: 'Créer un livre pour enfant avec l\'IA : le guide pratique',
      it: 'Creare un libro per bambini con l\'IA: la guida pratica',
    },
    description: {
      de: 'Was beim Kinderbuch-Erstellen mit KI wirklich funktioniert: wie du die Geschichte beschreibst, warum Figuren zwischen den Seiten anders aussehen und was du vor dem Druck prüfen solltest.',
      en: 'What actually works when you create a children\'s book with AI: how to describe the story, why characters change appearance between pages, and what to check before you print.',
      fr: 'Ce qui fonctionne vraiment pour créer un livre pour enfant avec l\'IA : comment décrire l\'histoire, pourquoi les personnages changent d\'apparence, et quoi vérifier avant d\'imprimer.',
      it: 'Cosa funziona davvero per creare un libro per bambini con l\'IA: come descrivere la storia, perché i personaggi cambiano aspetto tra le pagine e cosa controllare prima di stampare.',
    },
  },
  'geschwisterstreit-was-tun': {
    title: {
      de: 'Geschwisterstreit: was wirklich hilft',
      en: 'Siblings Fighting Constantly: What Actually Helps',
      fr: 'Disputes entre frères et sœurs : ce qui aide vraiment',
      it: 'Litigi tra fratelli: cosa aiuta davvero',
    },
    description: {
      de: 'Warum Geschwister streiten, warum Schlichten es schlimmer macht und was stattdessen hilft — und woran du erkennst, wann aus normalem Streit etwas anderes wird.',
      en: 'Why siblings fight, why refereeing makes it worse, and what to do instead — plus how to tell ordinary conflict from something that needs help.',
      fr: 'Pourquoi les fratries se disputent, pourquoi arbitrer aggrave les choses, et quoi faire à la place — et comment distinguer un conflit ordinaire d\'un problème réel.',
      it: 'Perché i fratelli litigano, perché arbitrare peggiora le cose e cosa fare invece — e come distinguere un conflitto normale da un problema serio.',
    },
  },
  'umzug-mit-kind': {
    title: {
      de: 'Umzug mit Kind: wenn es nicht weg will',
      en: 'Moving House with a Child Who Does Not Want To',
      fr: 'Déménager avec un enfant qui ne veut pas partir',
      it: 'Traslocare con un bambino che non vuole andarsene',
    },
    description: {
      de: 'Was ein Umzug für ein Kind wirklich bedroht, wann du es sagst, warum der Abschied wichtiger ist als die Ankunft — und warum die schwersten Wochen erst nach dem Auspacken kommen.',
      en: 'What a move actually threatens for a child, when to tell them, why the goodbye matters more than the welcome, and why the hardest weeks come after the boxes are unpacked.',
      fr: 'Ce qu\'un déménagement menace vraiment pour un enfant, quand lui dire, pourquoi l\'au revoir compte plus que l\'accueil, et pourquoi les semaines les plus dures viennent après.',
      it: 'Cosa minaccia davvero un trasloco per un bambino, quando dirglielo, perché l\'addio conta più del benvenuto e perché le settimane più difficili arrivano dopo aver disfatto le scatole.',
    },
  },
  'neues-geschwisterchen': {
    title: {
      de: 'Ein Geschwisterchen kommt: das ältere Kind vorbereiten',
      en: 'A New Baby Is Coming: Preparing the Older Child',
      fr: 'Un bébé arrive : préparer l\'aîné',
      it: 'Arriva un fratellino: preparare il figlio maggiore',
    },
    description: {
      de: 'Warum Rückschritte normal sind, warum das Versprechen eines Spielkameraden nach hinten losgeht, was du schützen solltest und welche gut gemeinten Sätze am meisten Ärger machen.',
      en: 'Why regression is normal, why promising a playmate backfires, what to protect, and which well-meant sentences cause the most trouble.',
      fr: 'Pourquoi la régression est normale, pourquoi promettre un camarade de jeu se retourne contre vous, quoi protéger, et quelles phrases bien intentionnées font le plus de dégâts.',
      it: 'Perché le regressioni sono normali, perché promettere un compagno di gioco si ritorce contro, cosa proteggere e quali frasi ben intenzionate causano più guai.',
    },
  },
  'eigene-geschichte-oder-vorlage': {
    title: {
      de: 'Vorlage oder eigene Geschichte? Der echte Unterschied bei personalisierten Büchern',
      en: 'Template or Your Own Story? The Real Difference in Personalized Books',
      fr: 'Modèle ou histoire originale ? La vraie différence',
      it: 'Modello o storia originale? La vera differenza',
    },
    description: {
      de: 'Die meisten personalisierten Kinderbücher sind eine fertige Geschichte mit ausgetauschtem Namen. Wenige schreiben eine eigene Geschichte. So erkennst du vor dem Kauf, was du bekommst.',
      en: 'Most personalized children\'s books are one pre-written story with the name swapped in. A few write an original story. Here is how to tell which is which before you pay.',
      fr: 'La plupart des livres personnalisés sont une histoire pré-écrite avec le prénom remplacé. Quelques-uns écrivent une histoire originale. Voici comment les distinguer avant de payer.',
      it: 'La maggior parte dei libri personalizzati è una storia già scritta con il nome sostituito. Pochi scrivono una storia originale. Ecco come riconoscerli prima di pagare.',
    },
  },
};

// ─── Occasion Data (for meta tags) ────────────────────────────────────────────

const OCCASIONS = {
  geburtstag: { de: 'Personalisiertes Kinderbuch zum Geburtstag', en: 'Personalized Birthday Book for Kids', fr: 'Livre personnalisé pour anniversaire', it: 'Libro personalizzato per il compleanno' },
  weihnachten: { de: 'Personalisiertes Kinderbuch zu Weihnachten', en: 'Personalized Christmas Book for Kids', fr: 'Livre personnalisé pour Noël', it: 'Libro personalizzato per Natale' },
  ostern: { de: 'Personalisiertes Kinderbuch zu Ostern', en: 'Personalized Easter Book for Kids', fr: 'Livre personnalisé pour Pâques', it: 'Libro personalizzato per Pasqua' },
  taufe: { de: 'Personalisiertes Kinderbuch zur Taufe', en: 'Personalized Baptism Book for Kids', fr: 'Livre personnalisé pour le baptême', it: 'Libro personalizzato per il battesimo' },
  einschulung: { de: 'Personalisiertes Kinderbuch zur Einschulung', en: 'Personalized First Day of School Book', fr: 'Livre personnalisé pour la rentrée', it: 'Libro personalizzato per il primo giorno di scuola' },
  geschwisterchen: { de: 'Personalisiertes Kinderbuch zum Geschwisterchen', en: 'Personalized New Sibling Book', fr: 'Livre personnalisé nouveau bébé', it: 'Libro personalizzato per il nuovo fratellino' },
  muttertag: { de: 'Personalisiertes Kinderbuch zum Muttertag', en: 'Personalized Mother\'s Day Book', fr: 'Livre personnalisé fête des mères', it: 'Libro personalizzato per la Festa della Mamma' },
  vatertag: { de: 'Personalisiertes Kinderbuch zum Vatertag', en: 'Personalized Father\'s Day Book', fr: 'Livre personnalisé fête des pères', it: 'Libro personalizzato per la Festa del Papà' },
  nikolaus: { de: 'Personalisiertes Kinderbuch zum Nikolaus', en: 'Personalized St. Nicholas Day Book', fr: 'Livre personnalisé pour la Saint-Nicolas', it: 'Libro personalizzato per San Nicolao' },
  advent: { de: 'Personalisiertes Kinderbuch zum Advent', en: 'Personalized Advent Book for Kids', fr: 'Livre personnalisé pour l\'Avent', it: 'Libro personalizzato per l\'Avvento' },
  umzug: { de: 'Personalisiertes Kinderbuch zum Umzug', en: 'Personalized Moving House Book', fr: 'Livre personnalisé pour le déménagement', it: 'Libro personalizzato per il trasloco' },
  kindergartenstart: { de: 'Personalisiertes Kinderbuch zum Kindergartenstart', en: 'Personalized Starting Kindergarten Book', fr: 'Livre personnalisé pour l\'entrée en maternelle', it: 'Libro personalizzato per l\'inizio della scuola materna' },
};

// ─── Gift Page Data (for meta tags) ───────────────────────────────────────────

const GIFT_PAGES = {
  'fuer-kinder': { de: 'Einzigartiges Geschenk für Kinder', en: 'Unique Gift for Kids', fr: 'Cadeau unique pour enfants', it: 'Regalo unico per bambini' },
  'fuer-enkel': { de: 'Das perfekte Geschenk für Enkel', en: 'The Perfect Gift for Grandchildren', fr: 'Le cadeau parfait pour les petits-enfants', it: 'Il regalo perfetto per i nipoti' },
  'fuer-nichte-neffe': { de: 'Geschenk für Nichte & Neffe', en: 'Gift for Niece & Nephew', fr: 'Cadeau pour nièce et neveu', it: 'Regalo per nipote (nipotina/nipotino)' },
  'fuer-patenkind': { de: 'Geschenk für Patenkind & Göttikind', en: 'Gift for Godchild', fr: 'Cadeau pour filleul(e)', it: 'Regalo per figlioccio/a' },
  'geschenk-von-grosseltern': { de: 'Geschenk von Grosseltern', en: 'Gift from Grandparents', fr: 'Cadeau des grands-parents', it: 'Regalo dai nonni' },
  'ostergeschenk': { de: 'Ostergeschenk für Kinder', en: 'Easter Gift for Kids', fr: 'Cadeau de Pâques pour enfants', it: 'Regalo di Pasqua per bambini' },
  'weihnachtsgeschenk': { de: 'Weihnachtsgeschenk für Kinder', en: 'Christmas Gift for Kids', fr: 'Cadeau de Noël pour enfants', it: 'Regalo di Natale per bambini' },
  'geburtstagsgeschenk': { de: 'Geburtstagsgeschenk für Kinder', en: 'Birthday Gift for Kids', fr: "Cadeau d'anniversaire pour enfants", it: 'Regalo di compleanno per bambini' },
  'taufgeschenk': { de: 'Taufgeschenk — persönlich & unvergesslich', en: 'Baptism Gift — Personal & Unforgettable', fr: 'Cadeau de baptême — personnel & inoubliable', it: 'Regalo di battesimo — personale e indimenticabile' },
  'einschulungsgeschenk': { de: 'Einschulungsgeschenk für Kinder', en: 'First Day of School Gift', fr: 'Cadeau de rentrée scolaire', it: 'Regalo per il primo giorno di scuola' },
  'nikolausgeschenk': { de: 'Nikolausgeschenk für Kinder', en: 'St. Nicholas Gift for Kids', fr: 'Cadeau de Saint-Nicolas pour enfants', it: 'Regalo di San Nicolao per bambini' },
  'einzigartiges-geschenk': { de: 'Einzigartiges Geschenk für Kinder', en: 'Unique Gift for Kids', fr: 'Cadeau unique pour enfants', it: 'Regalo unico per bambini' },
  'personalisiertes-geschenk': { de: 'Personalisiertes Geschenk für Kinder', en: 'Personalized Gift for Kids', fr: 'Cadeau personnalisé pour enfants', it: 'Regalo personalizzato per bambini' },
  'sinnvolles-geschenk': { de: 'Sinnvolles Geschenk für Kinder', en: 'Meaningful Gift for Kids', fr: 'Cadeau éducatif pour enfants', it: 'Regalo educativo per bambini' },
  'last-minute-geschenk': { de: 'Last-Minute-Geschenk für Kinder', en: 'Last-Minute Gift for Kids', fr: 'Cadeau de dernière minute pour enfants', it: 'Regalo dell\'ultimo minuto per bambini' },
  'geschenk-3-jahre': { de: 'Geschenk für 3-Jährige', en: 'Gift for 3-Year-Olds', fr: 'Cadeau pour enfant de 3 ans', it: 'Regalo per bambini di 3 anni' },
  'geschenk-4-jahre': { de: 'Geschenk für 4-Jährige', en: 'Gift for 4-Year-Olds', fr: 'Cadeau pour enfant de 4 ans', it: 'Regalo per bambini di 4 anni' },
  'geschenk-5-jahre': { de: 'Geschenk für 5-Jährige', en: 'Gift for 5-Year-Olds', fr: 'Cadeau pour enfant de 5 ans', it: 'Regalo per bambini di 5 anni' },
  'geschenk-6-jahre': { de: 'Geschenk für 6-Jährige', en: 'Gift for 6-Year-Olds', fr: 'Cadeau pour enfant de 6 ans', it: 'Regalo per bambini di 6 anni' },
  'geschenk-7-8-jahre': { de: 'Geschenk für 7–8-Jährige', en: 'Gift for 7-8-Year-Olds', fr: 'Cadeau pour enfant de 7-8 ans', it: 'Regalo per bambini di 7-8 anni' },
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
    availableLanguage: ['German', 'English', 'French', 'Italian'],
  },
};

const PRODUCT_JSON_LD_BY_LANG = {
  de: {
    name: 'Personalisiertes Kinderbuch',
    description: 'KI-illustriertes Kinderbuch mit deinem Kind als Held. 170+ Themen, 8 Kunststile, 4 Sprachen.',
  },
  en: {
    name: "Personalized children's book",
    description: "AI-illustrated children's book with your child as the hero. 170+ themes, 8 art styles, 4 languages.",
  },
  fr: {
    name: 'Livre pour enfants personnalisé',
    description: "Livre illustré par IA avec votre enfant comme héros. Plus de 170 thèmes, 8 styles, 4 langues.",
  },
  it: {
    name: 'Libro per bambini personalizzato',
    description: "Libro illustrato con l'IA e tuo figlio come protagonista. Oltre 170 temi, 8 stili, 4 lingue.",
  },
};

// The structured data a page carries must be in the page's own language:
// German JSON-LD on an English page is a language mismatch to Google and can
// surface German text inside a non-German rich result.
function buildProductJsonLd(lang) {
  const copy = PRODUCT_JSON_LD_BY_LANG[lang] || PRODUCT_JSON_LD_BY_LANG.en;
  return {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: copy.name,
    description: copy.description,
    brand: { '@type': 'Brand', name: 'MagicalStory' },
    offers: {
      '@type': 'AggregateOffer',
      lowPrice: '0',
      highPrice: '96',
      priceCurrency: 'CHF',
      availability: 'https://schema.org/InStock',
      offerCount: '170',
    },
    category: "Personalized Children's Books",
  };
}

const FAQ_BY_LANG = {
    "de": [
      {
        "@type": "Question",
        "name": "Wie funktioniert MagicalStory?",
        "acceptedAnswer": {
          "@type": "Answer",
          "text": "Lade ein Foto deines Kindes hoch, wähle ein Geschichten-Thema, und erhalte in wenigen Minuten eine vollständig illustrierte, personalisierte Geschichte. Dein Kind erscheint als Hauptfigur auf jeder Seite."
        }
      },
      {
        "@type": "Question",
        "name": "Wie lange dauert es?",
        "acceptedAnswer": {
          "@type": "Answer",
          "text": "Deine erste kostenlose Geschichte ist in unter 3 Minuten fertig. Text und alle Illustrationen werden automatisch generiert."
        }
      },
      {
        "@type": "Question",
        "name": "Für welches Alter ist MagicalStory geeignet?",
        "acceptedAnswer": {
          "@type": "Answer",
          "text": "Geschichten können für Kinder jeden Alters erstellt werden. Inhalt und Komplexität werden an das angegebene Alter angepasst."
        }
      },
      {
        "@type": "Question",
        "name": "Kann ich mehrere Charaktere hinzufügen?",
        "acceptedAnswer": {
          "@type": "Answer",
          "text": "Ja! Du kannst die ganze Familie, Freunde oder Haustiere als Figuren in der Geschichte hinzufügen. Jeder Charakter bekommt eigene personalisierte Illustrationen."
        }
      },
      {
        "@type": "Question",
        "name": "Was kostet MagicalStory?",
        "acceptedAnswer": {
          "@type": "Answer",
          "text": "Deine erste Geschichte ist komplett gratis. Danach werden Geschichten mit Credits erstellt. Gedruckte Bücher gibt es ab CHF 33 als hochwertiges Hardcover."
        }
      },
      {
        "@type": "Question",
        "name": "Sind meine Daten sicher?",
        "acceptedAnswer": {
          "@type": "Answer",
          "text": "Ja. Deine Fotos werden ausschliesslich zur Erstellung der Illustrationen verwendet und niemals an Dritte weitergegeben. Wir nehmen Datenschutz ernst und halten uns an die Schweizer Datenschutzgesetze."
        }
      }
    ],
    "en": [
      {
        "@type": "Question",
        "name": "How does MagicalStory work?",
        "acceptedAnswer": {
          "@type": "Answer",
          "text": "Upload a photo of your child, choose a story theme, and get a fully illustrated, personalized story in just a few minutes. Your child appears as the main character on every page."
        }
      },
      {
        "@type": "Question",
        "name": "How long does it take?",
        "acceptedAnswer": {
          "@type": "Answer",
          "text": "Your first free story is ready in under 3 minutes. The text and all illustrations are generated automatically."
        }
      },
      {
        "@type": "Question",
        "name": "What age is MagicalStory suitable for?",
        "acceptedAnswer": {
          "@type": "Answer",
          "text": "Stories can be created for children of any age. Content and complexity are adapted to the age you specify."
        }
      },
      {
        "@type": "Question",
        "name": "Can I add several characters?",
        "acceptedAnswer": {
          "@type": "Answer",
          "text": "Yes! You can add the whole family, friends, or pets as characters in the story. Every character gets their own personalized illustrations."
        }
      },
      {
        "@type": "Question",
        "name": "What does MagicalStory cost?",
        "acceptedAnswer": {
          "@type": "Answer",
          "text": "Your first story is completely free. After that, stories are created using credits. Printed books start at CHF 33 as a high-quality hardcover."
        }
      },
      {
        "@type": "Question",
        "name": "Is my data safe?",
        "acceptedAnswer": {
          "@type": "Answer",
          "text": "Yes. Your photos are used exclusively to create the illustrations and are never shared with third parties. We take data protection seriously and comply with Swiss data protection laws."
        }
      }
    ],
    "fr": [
      {
        "@type": "Question",
        "name": "Comment fonctionne MagicalStory ?",
        "acceptedAnswer": {
          "@type": "Answer",
          "text": "Téléchargez une photo de votre enfant, choisissez un thème d'histoire et obtenez en quelques minutes une histoire personnalisée entièrement illustrée. Votre enfant apparaît comme personnage principal sur chaque page."
        }
      },
      {
        "@type": "Question",
        "name": "Combien de temps cela prend-il ?",
        "acceptedAnswer": {
          "@type": "Answer",
          "text": "Votre première histoire gratuite est prête en moins de 3 minutes. Le texte et toutes les illustrations sont générés automatiquement."
        }
      },
      {
        "@type": "Question",
        "name": "Pour quel âge MagicalStory convient-il ?",
        "acceptedAnswer": {
          "@type": "Answer",
          "text": "Les histoires peuvent être créées pour des enfants de tout âge. Le contenu et la complexité sont adaptés à l'âge indiqué."
        }
      },
      {
        "@type": "Question",
        "name": "Puis-je ajouter plusieurs personnages ?",
        "acceptedAnswer": {
          "@type": "Answer",
          "text": "Oui ! Vous pouvez ajouter toute la famille, des amis ou des animaux de compagnie comme personnages de l'histoire. Chaque personnage reçoit ses propres illustrations personnalisées."
        }
      },
      {
        "@type": "Question",
        "name": "Combien coûte MagicalStory ?",
        "acceptedAnswer": {
          "@type": "Answer",
          "text": "Votre première histoire est entièrement gratuite. Ensuite, les histoires sont créées avec des crédits. Les livres imprimés sont disponibles à partir de CHF 33 en couverture rigide de haute qualité."
        }
      },
      {
        "@type": "Question",
        "name": "Mes données sont-elles en sécurité ?",
        "acceptedAnswer": {
          "@type": "Answer",
          "text": "Oui. Vos photos sont utilisées exclusivement pour créer les illustrations et ne sont jamais transmises à des tiers. Nous prenons la protection des données au sérieux et respectons les lois suisses en la matière."
        }
      }
    ],
    "it": [
      {
        "@type": "Question",
        "name": "Come funziona MagicalStory?",
        "acceptedAnswer": {
          "@type": "Answer",
          "text": "Carica una foto di tuo figlio, scegli un tema per la storia e ottieni in pochi minuti una storia personalizzata completamente illustrata. Tuo figlio appare come protagonista in ogni pagina."
        }
      },
      {
        "@type": "Question",
        "name": "Quanto tempo ci vuole?",
        "acceptedAnswer": {
          "@type": "Answer",
          "text": "La tua prima storia gratuita è pronta in meno di 3 minuti. Il testo e tutte le illustrazioni vengono generati automaticamente."
        }
      },
      {
        "@type": "Question",
        "name": "Per quale età è adatto MagicalStory?",
        "acceptedAnswer": {
          "@type": "Answer",
          "text": "Le storie possono essere create per bambini di qualsiasi età. Contenuto e complessità vengono adattati all'età indicata."
        }
      },
      {
        "@type": "Question",
        "name": "Posso aggiungere più personaggi?",
        "acceptedAnswer": {
          "@type": "Answer",
          "text": "Sì! Puoi aggiungere tutta la famiglia, amici o animali domestici come personaggi della storia. Ogni personaggio riceve le proprie illustrazioni personalizzate."
        }
      },
      {
        "@type": "Question",
        "name": "Quanto costa MagicalStory?",
        "acceptedAnswer": {
          "@type": "Answer",
          "text": "La tua prima storia è completamente gratuita. Dopodiché, le storie vengono create usando crediti. I libri stampati partono da CHF 33 in copertina rigida di alta qualità."
        }
      },
      {
        "@type": "Question",
        "name": "I miei dati sono al sicuro?",
        "acceptedAnswer": {
          "@type": "Answer",
          "text": "Sì. Le tue foto vengono usate esclusivamente per creare le illustrazioni e non vengono mai condivise con terzi. Prendiamo sul serio la protezione dei dati e rispettiamo le leggi svizzere sulla protezione dei dati."
        }
      }
    ]
  };

// FAQ markup earns the expandable Q&A rows in search results, so it must be
// in the language of the page carrying it.
function buildFaqJsonLd(lang) {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: FAQ_BY_LANG[lang] || FAQ_BY_LANG.en,
  };
}

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

function buildProductJsonLdForTheme(themeName, category, themeId, lang) {
  const copy = {
    de: {
      name: `Personalisiertes Kinderbuch: ${themeName}`,
      description: `KI-illustriertes ${themeName}-Kinderbuch mit deinem Kind als Held.`,
      offer: 'Erste Geschichte kostenlos. Hardcover ab CHF 33.',
    },
    en: {
      name: `Personalized children's book: ${themeName}`,
      description: `AI-illustrated ${themeName} children's book with your child as the hero.`,
      offer: 'First story free. Hardcover from CHF 33.',
    },
    fr: {
      name: `Livre pour enfants personnalisé : ${themeName}`,
      description: `Livre ${themeName} illustré par IA avec votre enfant comme héros.`,
      offer: 'Première histoire gratuite. Couverture rigide dès CHF 33.',
    },
    it: {
      name: `Libro per bambini personalizzato: ${themeName}`,
      description: `Libro ${themeName} illustrato con l'IA e tuo figlio come protagonista.`,
      offer: 'Prima storia gratuita. Cartonato da CHF 33.',
    },
  }[lang] || {
    name: `Personalized children's book: ${themeName}`,
    description: `AI-illustrated ${themeName} children's book with your child as the hero.`,
    offer: 'First story free. Hardcover from CHF 33.',
  };
  return {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: copy.name,
    description: copy.description,
    brand: { '@type': 'Brand', name: 'MagicalStory' },
    url: `${BASE_URL}/themes/${category}/${themeId}`,
    offers: {
      '@type': 'Offer',
      price: '0',
      priceCurrency: 'CHF',
      availability: 'https://schema.org/InStock',
      description: copy.offer,
    },
    category: "Personalized Children's Books",
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
    it: [
      { name: 'Carica una foto', text: 'Carica una foto del tuo bambino. Diventa il protagonista illustrato della storia.' },
      { name: 'Scegli un tema', text: 'Scegli tra oltre 170 temi: avventura, sfide della vita, educativi o storici.' },
      { name: 'Ricevi la tua storia', text: 'La tua storia illustrata personalizzata è pronta in pochi minuti. Leggila online o ordina il libro.' },
    ],
  };
  const s = pickLang(steps, lang);
  return {
    '@context': 'https://schema.org',
    '@type': 'HowTo',
    name: lang === 'de' ? 'Personalisiertes Kinderbuch erstellen' : lang === 'fr' ? 'Créer un livre personnalisé' : lang === 'it' ? 'Creare un libro personalizzato per bambini' : 'Create a Personalized Children\'s Book',
    description: lang === 'de' ? 'In 3 einfachen Schritten zum personalisierten Kinderbuch' : lang === 'fr' ? 'En 3 étapes simples vers votre livre personnalisé' : lang === 'it' ? 'Il tuo libro personalizzato in 3 semplici passi' : 'Create your personalized book in 3 simple steps',
    totalTime: 'PT3M',
    tool: { '@type': 'HowToTool', name: lang === 'de' ? 'Ein Foto deines Kindes' : lang === 'fr' ? 'Une photo de votre enfant' : lang === 'it' ? 'Una foto del tuo bambino' : 'A photo of your child' },
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
  if (l === 'en' || l === 'fr' || l === 'it') return l;
  return 'de';
}

/**
 * Pick a localized value out of a { de, en, fr, it? } map.
 * Italian copy is still being translated: where an `it` string is missing we
 * fall back to ENGLISH, never German, so an Italian page never renders German
 * text. de/en/fr keep their existing German fallback unchanged.
 */
function pickLang(map, lang) {
  if (!map) return undefined;
  if (map[lang]) return map[lang];
  // Any non-German language falls back to ENGLISH, never German: serving German
  // text on an English or French page is a language mismatch to Google, and it
  // is how the comparison-title / unknown-route / gift-description bugs hid.
  if (lang !== 'de' && map.en) return map.en;
  return map.de;
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

  // Self-referencing canonical helper: each language variant must canonicalize to itself,
  // not to the default-language version. Non-self-referencing canonicals are the #1 cause
  // of "Crawled - currently not indexed" on multilingual sites with ?lang= query params.
  // Root path: DE → "https://magicalstory.ch", non-DE → "https://magicalstory.ch/?lang=en".
  const isRoot = cleanPath === '/';
  const canonicalUrl = lang === 'de'
    ? `${BASE_URL}${isRoot ? '' : cleanPath}`
    : `${BASE_URL}${isRoot ? '/' : cleanPath}?lang=${lang}`;

  // Check noindex routes (prefix match for routes like /create/*)
  const isNoindex = NOINDEX_ROUTES.some(nr => cleanPath === nr || cleanPath.startsWith(nr + '/'));

  // 1. Static routes
  const staticMeta = STATIC_ROUTES[cleanPath];
  if (staticMeta) {
    const meta = {
      title: pickLang(staticMeta.title, lang),
      description: pickLang(staticMeta.description, lang),
      canonical: canonicalUrl,
      path: cleanPath,
      noindex: isNoindex,
      hreflang: buildHreflang(cleanPath),
      jsonLd: [],
    };

    // Page-specific schemas
    if (cleanPath === '/') {
      meta.jsonLd = [
        ORGANIZATION_JSON_LD,
        buildProductJsonLd(lang),
        buildBreadcrumbJsonLd([{ name: 'Home' }]),
      ];
    } else if (cleanPath === '/faq') {
      meta.jsonLd = [
        buildFaqJsonLd(lang),
        buildBreadcrumbJsonLd([{ name: 'Home', url: '/' }, { name: 'FAQ' }]),
      ];
    } else if (cleanPath === '/about') {
      meta.jsonLd = [
        ORGANIZATION_JSON_LD,
        buildBreadcrumbJsonLd([{ name: 'Home', url: '/' }, { name: lang === 'de' ? 'Über uns' : lang === 'fr' ? 'À propos' : lang === 'it' ? 'Chi siamo' : 'About' }]),
      ];
    } else if (cleanPath === '/pricing') {
      meta.jsonLd = [
        buildProductJsonLd(lang),
        buildBreadcrumbJsonLd([{ name: 'Home', url: '/' }, { name: lang === 'de' ? 'Preise' : lang === 'fr' ? 'Tarifs' : lang === 'it' ? 'Prezzi' : 'Pricing' }]),
      ];
    } else if (cleanPath === '/try') {
      meta.jsonLd = [
        buildHowToJsonLd(lang),
        buildBreadcrumbJsonLd([{ name: 'Home', url: '/' }, { name: lang === 'de' ? 'Gratis Geschichte erstellen' : lang === 'fr' ? 'Créer une histoire' : lang === 'it' ? 'Crea una storia gratis' : 'Create Your Story' }]),
      ];
    } else if (cleanPath === '/kinderbuch-erstellen') {
      // Same HowTo as /try — this is the indexable, content-bearing version of that
      // intent, while /try is the wizard itself.
      meta.jsonLd = [
        buildHowToJsonLd(lang),
        buildBreadcrumbJsonLd([{ name: 'Home', url: '/' }, { name: lang === 'de' ? 'Kinderbuch erstellen' : lang === 'fr' ? 'Créer un livre' : lang === 'it' ? 'Crea un libro' : 'Create a Book' }]),
      ];
    } else if (cleanPath === '/themes') {
      meta.jsonLd = [
        buildBreadcrumbJsonLd([{ name: 'Home', url: '/' }, { name: lang === 'de' ? 'Themen' : lang === 'fr' ? 'Thèmes' : lang === 'it' ? 'Temi' : 'Themes' }]),
      ];
    } else if (cleanPath === '/science') {
      meta.jsonLd = [
        buildBreadcrumbJsonLd([{ name: 'Home', url: '/' }, { name: lang === 'de' ? 'Forschung' : lang === 'fr' ? 'Science' : lang === 'it' ? 'Ricerca' : 'Science' }]),
      ];
    } else {
      // Other static pages get breadcrumb only
      const pageName = pickLang(staticMeta.title, lang);
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
      const catName = pickLang(category, lang);
      return {
        title: `${catName} – Magical Story`,
        description: buildCategoryDescription(catName, lang),
        canonical: canonicalUrl,
        path: cleanPath,
        noindex: false,
        hreflang: buildHreflang(cleanPath),
        jsonLd: [
          buildBreadcrumbJsonLd([
            { name: 'Home', url: '/' },
            { name: lang === 'de' ? 'Themen' : lang === 'fr' ? 'Thèmes' : lang === 'it' ? 'Temi' : 'Themes', url: '/themes' },
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
      const themeName = pickLang(found.theme, lang);
      const catName = pickLang(THEME_CATEGORIES[categoryId], lang) || categoryId;
      const titleTemplate = lang === 'de'
        ? `Personalisiertes ${themeName}-Kinderbuch | MagicalStory`
        : lang === 'fr'
          ? `Livre personnalisé ${themeName} | MagicalStory`
          : lang === 'it'
            ? `Libro personalizzato ${themeName} | MagicalStory`
            : `Personalized ${themeName} Story | MagicalStory`;
      return {
        title: titleTemplate,
        description: buildThemeDescription(themeName, lang),
        canonical: canonicalUrl,
        path: cleanPath,
        noindex: false,
        hreflang: buildHreflang(cleanPath),
        jsonLd: [
          buildProductJsonLdForTheme(themeName, categoryId, themeId, lang),
          buildBreadcrumbJsonLd([
            { name: 'Home', url: '/' },
            { name: lang === 'de' ? 'Themen' : lang === 'fr' ? 'Thèmes' : lang === 'it' ? 'Temi' : 'Themes', url: '/themes' },
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
      const title = pickLang(town, lang);
      return {
        title: `${title} | MagicalStory`,
        description: buildTownDescription(town.name, lang),
        canonical: canonicalUrl,
        path: cleanPath,
        noindex: false,
        hreflang: buildHreflang(cleanPath),
        jsonLd: [
          buildBreadcrumbJsonLd([
            { name: 'Home', url: '/' },
            { name: lang === 'de' ? 'Geschichten aus der Schweiz' : lang === 'fr' ? 'Histoires de Suisse' : lang === 'it' ? 'Storie dalla Svizzera' : 'Stories from Switzerland', url: '/geschichten-aus' },
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
      const title = pickLang(comp, lang);
      return {
        title: lang === 'it'
          ? `${title} — Confronto onesto | MagicalStory`
          : lang === 'fr'
            ? `${title} — comparaison honnête | MagicalStory`
            : lang === 'en'
              ? `${title} — an honest comparison | MagicalStory`
              : `${title} — Ehrlicher Vergleich | MagicalStory`,
        description: buildComparisonDescription(comp.name, lang),
        canonical: canonicalUrl,
        path: cleanPath,
        noindex: false,
        hreflang: buildHreflang(cleanPath),
        jsonLd: [
          buildBreadcrumbJsonLd([
            { name: 'Home', url: '/' },
            { name: lang === 'de' ? 'Vergleich' : lang === 'fr' ? 'Comparaison' : lang === 'it' ? 'Confronto' : 'Compare', url: '/vergleich' },
            { name: title },
          ]),
        ],
      };
    }
  }

  // 5b. Guide article: /ratgeber/:guideSlug
  const guideMatch = cleanPath.match(/^\/ratgeber\/([^/]+)$/);
  if (guideMatch) {
    const guide = GUIDES[guideMatch[1]];
    if (guide) {
      const title = pickLang(guide.title, lang);
      return {
        title: `${title} | Magical Story`,
        description: pickLang(guide.description, lang),
        canonical: canonicalUrl,
        path: cleanPath,
        noindex: false,
        hreflang: buildHreflang(cleanPath),
        jsonLd: [
          {
            '@context': 'https://schema.org',
            '@type': 'Article',
            headline: title,
            description: pickLang(guide.description, lang),
            inLanguage: lang,
            author: { '@type': 'Organization', name: 'Magical Story' },
            publisher: { '@type': 'Organization', name: 'Magical Story' },
            mainEntityOfPage: { '@type': 'WebPage', '@id': canonicalUrl },
          },
          buildBreadcrumbJsonLd([
            { name: 'Home', url: '/' },
            { name: lang === 'de' ? 'Ratgeber' : lang === 'fr' ? 'Guides' : lang === 'it' ? 'Guide' : 'Guides', url: '/ratgeber' },
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
      const title = pickLang(occasion, lang);
      return {
        title: `${title} | MagicalStory`,
        description: buildOccasionDescription(occasionSlug, lang),
        canonical: canonicalUrl,
        path: cleanPath,
        noindex: false,
        hreflang: buildHreflang(cleanPath),
        jsonLd: [
          buildProductJsonLd(lang),
          buildBreadcrumbJsonLd([
            { name: 'Home', url: '/' },
            { name: lang === 'de' ? 'Anlässe' : lang === 'fr' ? 'Occasions' : lang === 'it' ? 'Occasioni' : 'Occasions', url: '/anlass' },
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
      const title = pickLang(giftPage, lang);
      return {
        title: `${title} | MagicalStory`,
        description: buildGiftDescription(giftSlug, lang),
        canonical: canonicalUrl,
        path: cleanPath,
        noindex: false,
        hreflang: buildHreflang(cleanPath),
        jsonLd: [
          buildProductJsonLd(lang),
          buildBreadcrumbJsonLd([
            { name: 'Home', url: '/' },
            { name: lang === 'de' ? 'Geschenkideen' : lang === 'fr' ? 'Idées cadeaux' : lang === 'it' ? 'Idee regalo' : 'Gift Ideas', url: '/geschenk' },
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
      const cityName = pickLang(cityData.name, lang);
      const canton = cityData.canton;
      const titleTpl = lang === 'de'
        ? `Personalisiertes Kinderbuch ${cityName} (${canton}) | MagicalStory`
        : lang === 'fr'
          ? `Livre personnalisé pour enfants ${cityName} (${canton}) | MagicalStory`
          : lang === 'it'
            ? `Libro personalizzato per bambini ${cityName} (${canton}) | MagicalStory`
            : `Personalized Children's Book ${cityName} (${canton}) | MagicalStory`;
      return {
        title: titleTpl,
        description: buildCityDescription(cityName, lang),
        canonical: canonicalUrl,
        path: cleanPath,
        noindex: false,
        hreflang: buildHreflang(cleanPath),
        jsonLd: [
          buildBreadcrumbJsonLd([
            { name: 'Home', url: '/' },
            { name: lang === 'de' ? 'Schweizer Städte' : lang === 'fr' ? 'Villes suisses' : lang === 'it' ? 'Città svizzere' : 'Swiss Cities', url: '/stadt' },
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
      canonical: canonicalUrl,
      path: cleanPath,
      noindex: true,
      hreflang: [],
    };
  }

  // 10. Fallback — unknown route
  return {
    title: lang === 'it'
      ? 'Magical Story – Il tuo bambino protagonista della sua storia'
      : lang === 'fr'
        ? 'Magical Story – Votre enfant, héros de sa propre histoire'
        : lang === 'en'
          ? 'Magical Story – Your Child as the Hero of Their Own Story'
          : 'Magical Story – Dein Kind als Held seiner eigenen Geschichte',
    description: lang === 'it'
      ? 'Rendi il tuo bambino il protagonista della sua storia. Carica una foto, scegli un tema, crea gratis la prima storia.'
      : lang === 'fr'
        ? 'Faites de votre enfant le héros de sa propre histoire. Chargez une photo, choisissez un thème, créez la première histoire gratuitement.'
        : lang === 'en'
          ? 'Make your child the hero of their own story. Upload a photo, pick a theme, create your first story free.'
          : 'Mach dein Kind zum Helden seiner eigenen Geschichte. Foto hochladen, Thema wählen, erste Geschichte gratis erstellen.',
    canonical: canonicalUrl,
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
    { lang: 'it-CH', href: `${BASE_URL}${p}?lang=it` },
    { lang: 'it', href: `${BASE_URL}${p}?lang=it` },
    { lang: 'en', href: `${BASE_URL}${p}?lang=en` },
    { lang: 'x-default', href: `${BASE_URL}${p}` },
  ];
}

function buildCategoryDescription(catName, lang) {
  const templates = {
    en: `Browse ${catName} for your child. Create a personalized illustrated book in minutes with Magical Story.`,
    de: `Entdecke ${catName} für dein Kind. Erstelle in Minuten ein personalisiertes illustriertes Buch mit Magical Story.`,
    fr: `Découvrez les ${catName} pour votre enfant. Créez un livre illustré personnalisé en quelques minutes avec Magical Story.`,
    it: `Scopri ${catName} per il tuo bambino. Crea in pochi minuti un libro illustrato personalizzato con Magical Story.`,
  };
  return pickLang(templates, lang);
}

function buildThemeDescription(themeName, lang) {
  const templates = {
    de: `Erstelle ein personalisiertes ${themeName}-Kinderbuch mit dem Foto deines Kindes. KI-illustriert, einzigartig, ab CHF 33. Erste Geschichte gratis.`,
    en: `Create a personalized ${themeName} children's book with your child's photo. AI-illustrated, unique, from CHF 33. First story free.`,
    fr: `Créez un livre personnalisé ${themeName} avec la photo de votre enfant. Illustré par IA, unique, dès CHF 33. Première histoire gratuite.`,
    it: `Crea un libro personalizzato ${themeName} con la foto del tuo bambino. Illustrato dall'IA, unico, da CHF 33. Prima storia gratuita.`,
  };
  return pickLang(templates, lang);
}

function buildTownDescription(townName, lang) {
  const templates = {
    de: `Dein Kind erlebt ein personalisiertes Abenteuer in ${townName} — als Held eines illustrierten Kinderbuchs. Lokale Wahrzeichen, echte Schauplätze. Kostenlos testen.`,
    en: `Your child goes on a personalized adventure in ${townName} — as the hero of an illustrated children's book. Local landmarks, real settings. Try free.`,
    fr: `Votre enfant vit une aventure personnalisée à ${townName} — en héros d'un livre illustré. Monuments locaux, lieux réels. Essai gratuit.`,
    it: `Il tuo bambino vive un'avventura personalizzata a ${townName} — da protagonista di un libro illustrato. Luoghi reali, monumenti locali. Prova gratis.`,
  };
  return pickLang(templates, lang);
}

function buildCityDescription(cityName, lang) {
  const templates = {
    de: `Personalisierte Kindergeschichten aus ${cityName}: Dein Kind erlebt echte Geschichte und lokale Sagen als Held eines illustrierten Kinderbuchs. Kostenlos testen.`,
    en: `Personalized children's stories from ${cityName}: Your child experiences real history and local legends as the hero of an illustrated book. Try free.`,
    fr: `Histoires personnalisées pour enfants de ${cityName}: Votre enfant vit l'histoire locale en héros d'un livre illustré. Essai gratuit.`,
    it: `Storie personalizzate per bambini da ${cityName}: il tuo bambino vive la storia e le leggende locali da protagonista di un libro illustrato. Prova gratis.`,
  };
  return pickLang(templates, lang);
}

function buildComparisonDescription(competitorName, lang) {
  const templates = {
    de: `Ehrlicher Vergleich: MagicalStory vs ${competitorName}. Features, Preise, Vor- und Nachteile. Finde das beste personalisierte Kinderbuch.`,
    en: `Honest comparison: MagicalStory vs ${competitorName}. Features, pricing, pros and cons. Find the best personalized children's book.`,
    fr: `Comparaison honnête: MagicalStory vs ${competitorName}. Fonctionnalités, prix, avantages et inconvénients. Trouvez le meilleur livre personnalisé.`,
    it: `Confronto onesto: MagicalStory vs ${competitorName}. Funzioni, prezzi, pro e contro. Trova il miglior libro personalizzato per bambini.`,
  };
  return pickLang(templates, lang);
}

function buildOccasionDescription(occasionSlug, lang) {
  const occasionGifts = {
    geburtstag: { de: 'Geburtstag', en: 'birthday', fr: 'anniversaire', it: 'il compleanno' },
    weihnachten: { de: 'Weihnachten', en: 'Christmas', fr: 'Noël', it: 'Natale' },
    ostern: { de: 'Ostern', en: 'Easter', fr: 'Pâques', it: 'Pasqua' },
    taufe: { de: 'Taufe', en: 'baptism', fr: 'baptême', it: 'il battesimo' },
    einschulung: { de: 'Einschulung', en: 'first day of school', fr: 'rentrée scolaire', it: 'il primo giorno di scuola' },
    geschwisterchen: { de: 'Geschwisterchen', en: 'new sibling', fr: 'nouveau bébé', it: 'l\'arrivo di un fratellino' },
    muttertag: { de: 'Muttertag', en: 'Mother\'s Day', fr: 'fête des mères', it: 'la Festa della Mamma' },
    vatertag: { de: 'Vatertag', en: 'Father\'s Day', fr: 'fête des pères', it: 'la Festa del Papà' },
    nikolaus: { de: 'Nikolaus', en: 'St. Nicholas Day', fr: 'Saint-Nicolas', it: 'San Nicolao' },
    advent: { de: 'Advent', en: 'Advent', fr: 'Avent', it: 'l\'Avvento' },
    umzug: { de: 'Umzug', en: 'moving house', fr: 'déménagement', it: 'un trasloco' },
    kindergartenstart: { de: 'Kindergartenstart', en: 'starting kindergarten', fr: 'entrée en maternelle', it: 'l\'inizio della scuola materna' },
  };
  const occ = occasionGifts[occasionSlug] || { de: 'Anlass', en: 'occasion', fr: 'occasion', it: 'un\'occasione speciale' };
  const templates = {
    de: `Das perfekte Geschenk zum ${occ.de}: Ein personalisiertes Kinderbuch mit deinem Kind als Held. 170+ Themen, Hardcover ab CHF 33. Erste Geschichte gratis.`,
    en: `The perfect gift for ${occ.en}: A personalized children's book with your child as the hero. 170+ themes, hardcover from CHF 33. First story free.`,
    fr: `Le cadeau parfait pour ${occ.fr}: Un livre personnalisé avec votre enfant en héros. 170+ thèmes, couverture rigide dès CHF 33. Première histoire gratuite.`,
    it: `Il regalo perfetto per ${occ.it}: un libro personalizzato con il tuo bambino come protagonista. 170+ temi, copertina rigida da CHF 33. Prima storia gratuita.`,
  };
  return pickLang(templates, lang);
}

function buildGiftDescription(giftSlug, lang) {
  const descriptions = {
    'fuer-kinder': {
      de: 'Ein Geschenk, das Kinderaugen leuchten lässt: ein personalisiertes Kinderbuch mit dem eigenen Foto. 170+ Themen, Hardcover ab CHF 33. Erste Geschichte gratis testen.',
      en: 'A gift that makes children\'s eyes light up: a personalized book with their own photo. 170+ themes, hardcover from CHF 33. Try the first story free.',
      fr: 'Un cadeau qui fait briller les yeux des enfants: un livre personnalisé avec leur photo. 170+ thèmes, couverture rigide dès CHF 33. Première histoire gratuite.',
      it: 'Un regalo che fa brillare gli occhi dei bambini: un libro personalizzato con la loro foto. 170+ temi, copertina rigida da CHF 33. Prova gratis la prima storia.',
    },
    'fuer-enkel': {
      de: 'Das Geschenk von Oma & Opa, das Enkel nie vergessen: ein personalisiertes Kinderbuch mit eigenem Foto. Einzigartig, liebevoll, ab CHF 33.',
      en: 'The gift from grandma & grandpa that grandchildren never forget: a personalized book with their photo. Unique, heartfelt, from CHF 33.',
      fr: 'Le cadeau des grands-parents que les petits-enfants n\'oublient jamais: un livre personnalisé avec leur photo. Unique et touchant, dès CHF 33.',
      it: 'Il regalo di nonna e nonno che i nipoti non dimenticano mai: un libro personalizzato con la loro foto. Unico e speciale, da CHF 33.',
    },
    'fuer-nichte-neffe': {
      de: 'Überrasche Nichte oder Neffe mit einem personalisierten Kinderbuch — mit eigenem Foto als Held der Geschichte. Ab CHF 33, erste Geschichte gratis.',
      en: 'Surprise your niece or nephew with a personalized book — starring them as the hero. From CHF 33, first story free.',
      fr: 'Surprenez votre nièce ou neveu avec un livre personnalisé — ils sont le héros. Dès CHF 33, première histoire gratuite.',
      it: 'Sorprendi tua nipote o tuo nipote con un libro personalizzato — sono loro il protagonista. Da CHF 33, prima storia gratuita.',
    },
    'fuer-patenkind': {
      de: 'Ein besonderes Geschenk vom Götti oder der Gotte: ein personalisiertes Kinderbuch mit dem Foto deines Patenkinds. Ab CHF 33.',
      en: 'A special gift from godparent to godchild: a personalized book with their photo. From CHF 33, first story free.',
      fr: 'Un cadeau spécial du parrain ou de la marraine: un livre personnalisé avec la photo de votre filleul(e). Dès CHF 33.',
      it: 'Un regalo speciale dal padrino o dalla madrina: un libro personalizzato con la foto del tuo figlioccio. Da CHF 33, prima storia gratuita.',
    },
    'geschenk-von-grosseltern': {
      de: 'Das ideale Geschenk von Grosseltern: ein personalisiertes Kinderbuch, das Enkel zum Helden macht. Einfach online erstellen, ab CHF 33.',
      en: 'The ideal gift from grandparents: a personalized book that makes grandchildren the hero. Easy to create online, from CHF 33.',
      fr: 'Le cadeau idéal des grands-parents: un livre personnalisé qui fait de vos petits-enfants le héros. Facile à créer, dès CHF 33.',
      it: 'Il regalo ideale dai nonni: un libro personalizzato che rende i nipoti il protagonista. Facile da creare online, da CHF 33.',
    },
    'ostergeschenk': {
      de: 'Das besondere Ostergeschenk für Kinder: ein personalisiertes Kinderbuch statt Schoggi-Hasen. Mit eigenem Foto, ab CHF 33. Kostenlos testen.',
      en: 'A special Easter gift for kids: a personalized book instead of chocolate bunnies. With their photo, from CHF 33. Try free.',
      fr: 'Un cadeau de Pâques spécial: un livre personnalisé au lieu de lapins en chocolat. Avec leur photo, dès CHF 33. Essai gratuit.',
      it: 'Un regalo di Pasqua speciale: un libro personalizzato al posto dei conigli di cioccolato. Con la loro foto, da CHF 33. Prova gratis.',
    },
    'weihnachtsgeschenk': {
      de: 'Das Weihnachtsgeschenk, das Kinder lieben: ein personalisiertes Kinderbuch mit eigenem Foto unter dem Tannenbaum. Ab CHF 33.',
      en: 'The Christmas gift kids love: a personalized book with their photo under the tree. From CHF 33, first story free.',
      fr: 'Le cadeau de Noël que les enfants adorent: un livre personnalisé avec leur photo sous le sapin. Dès CHF 33.',
      it: 'Il regalo di Natale che i bambini adorano: un libro personalizzato con la loro foto sotto l\'albero. Da CHF 33, prima storia gratuita.',
    },
    'geburtstagsgeschenk': {
      de: 'Das perfekte Geburtstagsgeschenk für Kinder: ein personalisiertes Kinderbuch mit dem Geburtstagskind als Held. Ab CHF 33.',
      en: 'The perfect birthday gift for kids: a personalized book with the birthday child as hero. From CHF 33, first story free.',
      fr: "Le cadeau d'anniversaire parfait: un livre personnalisé avec l'enfant fêté en héros. Dès CHF 33, première histoire gratuite.",
      it: 'Il regalo di compleanno perfetto: un libro personalizzato con il festeggiato come protagonista. Da CHF 33, prima storia gratuita.',
    },
    'taufgeschenk': {
      de: 'Ein Taufgeschenk mit bleibendem Wert: ein personalisiertes Kinderbuch mit dem Namen und Foto des Täuflings. Ab CHF 33.',
      en: 'A baptism gift with lasting value: a personalized book with the child\'s name and photo. From CHF 33.',
      fr: 'Un cadeau de baptême à valeur durable: un livre personnalisé avec le nom et la photo de l\'enfant. Dès CHF 33.',
      it: 'Un regalo di battesimo dal valore duraturo: un libro personalizzato con il nome e la foto del bambino. Da CHF 33.',
    },
    'einschulungsgeschenk': {
      de: 'Geschenk zur Einschulung: ein personalisiertes Kinderbuch für den grossen Tag. Mit dem Schulkind als Held der Geschichte. Ab CHF 33.',
      en: 'First day of school gift: a personalized book for the big day. With the child as hero of the story. From CHF 33.',
      fr: 'Cadeau de rentrée: un livre personnalisé pour le grand jour. L\'enfant est le héros de l\'histoire. Dès CHF 33.',
      it: 'Regalo per il primo giorno di scuola: un libro personalizzato per il grande giorno. Il bambino è il protagonista della storia. Da CHF 33.',
    },
    'nikolausgeschenk': {
      de: 'Nikolausgeschenk für Kinder: ein personalisiertes Kinderbuch im Samichlaus-Sack. Mit eigenem Foto, ab CHF 33. Kostenlos testen.',
      en: 'St. Nicholas gift for kids: a personalized book in the gift bag. With their own photo, from CHF 33. Try free.',
      fr: 'Cadeau de Saint-Nicolas: un livre personnalisé dans la hotte. Avec leur photo, dès CHF 33. Essai gratuit.',
      it: 'Regalo di San Nicolao per bambini: un libro personalizzato nel sacco dei doni. Con la loro foto, da CHF 33. Prova gratis.',
    },
    'einzigartiges-geschenk': {
      de: 'Auf der Suche nach einem einzigartigen Kindergeschenk? Ein personalisiertes Kinderbuch mit Foto — gibt es kein zweites Mal. Ab CHF 33.',
      en: 'Looking for a unique gift for kids? A personalized book with their photo — truly one of a kind. From CHF 33.',
      fr: 'Vous cherchez un cadeau unique? Un livre personnalisé avec la photo de l\'enfant — vraiment unique. Dès CHF 33.',
      it: 'Cerchi un regalo unico per bambini? Un libro personalizzato con la foto del bambino — davvero irripetibile. Da CHF 33.',
    },
    'personalisiertes-geschenk': {
      de: 'Personalisiertes Geschenk für Kinder: Kinderbuch mit eigenem Foto, Namen und 170+ Themen. Hardcover ab CHF 33. Erste Geschichte gratis.',
      en: 'Personalized gift for kids: a book with their photo, name and 170+ themes. Hardcover from CHF 33. First story free.',
      fr: 'Cadeau personnalisé pour enfants: livre avec photo, prénom et 170+ thèmes. Couverture rigide dès CHF 33. Première histoire gratuite.',
      it: 'Regalo personalizzato per bambini: libro con foto, nome e 170+ temi. Copertina rigida da CHF 33. Prima storia gratuita.',
    },
    'sinnvolles-geschenk': {
      de: 'Sinnvolles Geschenk für Kinder: ein personalisiertes Kinderbuch, das Lesen fördert und Selbstvertrauen stärkt. Ab CHF 33.',
      en: 'A meaningful gift for kids: a personalized book that encourages reading and builds confidence. From CHF 33.',
      fr: 'Un cadeau éducatif pour enfants: un livre personnalisé qui encourage la lecture et renforce la confiance. Dès CHF 33.',
      it: 'Un regalo educativo per bambini: un libro personalizzato che incoraggia la lettura e rafforza l\'autostima. Da CHF 33.',
    },
    'last-minute-geschenk': {
      de: 'Last-Minute-Geschenk für Kinder: personalisiertes Kinderbuch sofort als PDF oder in 5 Tagen als Hardcover. Ab CHF 33.',
      en: 'Last-minute gift for kids: personalized book instantly as PDF or hardcover in 5 days. From CHF 33.',
      fr: 'Cadeau de dernière minute: livre personnalisé en PDF immédiat ou couverture rigide en 5 jours. Dès CHF 33.',
      it: 'Regalo dell\'ultimo minuto per bambini: libro personalizzato subito in PDF o copertina rigida in 5 giorni. Da CHF 33.',
    },
    'geschenk-3-jahre': {
      de: 'Geschenk für 3-Jährige: ein personalisiertes Kinderbuch mit grossen Bildern und einfachen Texten. Mit eigenem Foto, ab CHF 33.',
      en: 'Gift for 3-year-olds: a personalized book with big pictures and simple text. With their photo, from CHF 33.',
      fr: 'Cadeau pour enfant de 3 ans: un livre personnalisé avec de grandes images et des textes simples. Dès CHF 33.',
      it: 'Regalo per bambini di 3 anni: un libro personalizzato con grandi immagini e testi semplici. Con la loro foto, da CHF 33.',
    },
    'geschenk-4-jahre': {
      de: 'Geschenk für 4-Jährige: ein personalisiertes Kinderbuch voller Abenteuer. Mit dem Kind als Held, ab CHF 33.',
      en: 'Gift for 4-year-olds: a personalized adventure book. With the child as hero, from CHF 33.',
      fr: "Cadeau pour enfant de 4 ans: un livre d'aventures personnalisé. L'enfant est le héros, dès CHF 33.",
      it: 'Regalo per bambini di 4 anni: un libro d\'avventura personalizzato. Il bambino è il protagonista, da CHF 33.',
    },
    'geschenk-5-jahre': {
      de: 'Geschenk für 5-Jährige: ein personalisiertes Kinderbuch zum Vorlesen und Selbstentdecken. 170+ Themen, ab CHF 33.',
      en: 'Gift for 5-year-olds: a personalized book for reading aloud and self-discovery. 170+ themes, from CHF 33.',
      fr: 'Cadeau pour enfant de 5 ans: un livre personnalisé à lire ensemble et explorer. 170+ thèmes, dès CHF 33.',
      it: 'Regalo per bambini di 5 anni: un libro personalizzato da leggere insieme e scoprire da soli. 170+ temi, da CHF 33.',
    },
    'geschenk-6-jahre': {
      de: 'Geschenk für 6-Jährige: ein personalisiertes Kinderbuch für Erstleser. Spannende Geschichten mit eigenem Foto, ab CHF 33.',
      en: 'Gift for 6-year-olds: a personalized book for early readers. Exciting stories with their photo, from CHF 33.',
      fr: 'Cadeau pour enfant de 6 ans: un livre personnalisé pour jeunes lecteurs. Histoires passionnantes, dès CHF 33.',
      it: 'Regalo per bambini di 6 anni: un libro personalizzato per giovani lettori. Storie appassionanti con la loro foto, da CHF 33.',
    },
    'geschenk-7-8-jahre': {
      de: 'Geschenk für 7–8-Jährige: ein personalisiertes Kinderbuch mit längeren Geschichten und spannenden Abenteuern. Ab CHF 33.',
      en: 'Gift for 7-8-year-olds: a personalized book with longer stories and exciting adventures. From CHF 33.',
      fr: 'Cadeau pour enfant de 7-8 ans: un livre personnalisé avec des histoires plus longues et des aventures passionnantes. Dès CHF 33.',
      it: 'Regalo per bambini di 7-8 anni: un libro personalizzato con storie più lunghe e avventure appassionanti. Da CHF 33.',
    },
  };
  return pickLang(descriptions[giftSlug], lang)
    || (lang === 'it'
      ? 'Un libro personalizzato per bambini come regalo — con la foto del tuo bambino da protagonista. Da CHF 33, prima storia gratuita.'
      : lang === 'fr'
        ? 'Un livre personnalisé pour enfant comme cadeau — avec la photo de votre enfant en héros. Dès CHF 33, première histoire gratuite.'
        : lang === 'en'
          ? 'A personalized children\'s book as a gift — with your child\'s photo as the hero. From CHF 33, first story free.'
          : 'Personalisiertes Kinderbuch als Geschenk — mit dem Foto deines Kindes als Held. Ab CHF 33, erste Geschichte gratis.');
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
  const htmlLang = lang === 'fr' ? 'fr' : lang === 'en' ? 'en' : lang === 'it' ? 'it' : 'de';
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
  const ogLocale = lang === 'fr' ? 'fr_CH' : lang === 'en' ? 'en_US' : lang === 'it' ? 'it_CH' : 'de_CH';
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
    // '/geschichten-aus' hub removed — see the town-pages note below.
    '/stadt': '0.7',
    '/anlass': '0.7',
    '/geschenk': '0.8',
    '/vergleich': '0.6',
    '/ratgeber': '0.8',
    '/science': '0.7',
    '/faq': '0.5',
    '/kinderbuch-erstellen': '0.9',
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

  // Town pages (/geschichten-aus/:town) intentionally NOT in the sitemap:
  // they were added 2026-03 as server-side meta only and never got a client
  // route or prerendered page — every sitemap'd town URL served the generic
  // SPA shell (soft-404/duplicate ballast, 153 URLs; found in the 2026-07-10
  // organic-decline investigation). The /stadt/:city pages cover city SEO.
  // If "Geschichten aus {town}" ever becomes a real page (route + prerender
  // + own content), re-add the loop over Object.keys(TOWNS) here.

  // Comparison pages
  for (const compSlug of Object.keys(COMPARISONS)) {
    paths.push({
      path: `/vergleich/${compSlug}`,
      lastmod: today,
      changefreq: 'monthly',
      priority: '0.6',
    });
  }

  // Guide articles
  for (const guideSlug of Object.keys(GUIDES)) {
    paths.push({
      path: `/ratgeber/${guideSlug}`,
      lastmod: today,
      changefreq: 'monthly',
      priority: '0.7',
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

  // Build XML — each path gets 4 <url> entries (de, en, fr, it) with xhtml:link alternates
  const LANGS = ['de', 'en', 'fr', 'it'];
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
      const itUrl = escapeXml(`${BASE_URL}${basePath}?lang=it`);
      entry += `\n    <xhtml:link rel="alternate" hreflang="de-CH" href="${deUrl}" />`;
      entry += `\n    <xhtml:link rel="alternate" hreflang="de-DE" href="${deUrl}" />`;
      entry += `\n    <xhtml:link rel="alternate" hreflang="de-AT" href="${deUrl}" />`;
      entry += `\n    <xhtml:link rel="alternate" hreflang="de" href="${deUrl}" />`;
      entry += `\n    <xhtml:link rel="alternate" hreflang="fr-CH" href="${frUrl}" />`;
      entry += `\n    <xhtml:link rel="alternate" hreflang="fr" href="${frUrl}" />`;
      entry += `\n    <xhtml:link rel="alternate" hreflang="it-CH" href="${itUrl}" />`;
      entry += `\n    <xhtml:link rel="alternate" hreflang="it" href="${itUrl}" />`;
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
