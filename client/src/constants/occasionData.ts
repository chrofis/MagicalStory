export interface OccasionData {
  id: string;
  emoji: string;
  name: Record<'en' | 'de' | 'fr' | 'it', string>;
  title: Record<'en' | 'de' | 'fr' | 'it', string>;
  description: Record<'en' | 'de' | 'fr' | 'it', string>;
  intro: Record<'en' | 'de' | 'fr' | 'it', string>;
  tips: Record<'en' | 'de' | 'fr' | 'it', string[]>;
  recommendedThemes: { id: string; category: 'adventure' | 'life-challenges' | 'educational' | 'historical' }[];
  deliveryNote: Record<'en' | 'de' | 'fr' | 'it', string>;
  faq: { q: Record<'en' | 'de' | 'fr' | 'it', string>; a: Record<'en' | 'de' | 'fr' | 'it', string> }[];
}

export const occasions: OccasionData[] = [
  // 1. Birthday
  {
    id: 'geburtstag',
    emoji: '🎂',
    name: { en: 'Birthday', de: 'Geburtstag', fr: 'Anniversaire', it: 'Compleanno' },
    title: {
      en: 'Personalized Children\'s Book for Birthdays',
      de: 'Personalisiertes Kinderbuch zum Geburtstag',
      fr: 'Livre personnalisé pour anniversaire',
      it: 'Libro personalizzato per bambini per il compleanno',
    },
    description: {
      en: 'Give your child a birthday gift they\'ll never forget — a story where they are the hero. Personalized with their name, appearance, and photo.',
      de: 'Schenke deinem Kind ein Geburtstagsgeschenk, das es nie vergessen wird — eine Geschichte, in der es selbst der Held ist. Personalisiert mit Name, Aussehen und Foto.',
      fr: 'Offrez à votre enfant un cadeau d\'anniversaire inoubliable — une histoire dont il est le héros. Personnalisé avec son nom, son apparence et sa photo.',
      it: 'Regala a tuo figlio un regalo di compleanno indimenticabile — una storia in cui è lui l\'eroe. Personalizzata con il suo nome, il suo aspetto e la sua foto.',
    },
    intro: {
      en: 'A birthday is the most personal celebration of the year — and deserves the most personal gift. With a personalized story book, your child becomes the main character of their very own adventure. It\'s the kind of gift that gets read over and over, long after the party is over. Whether they turn 3 or 10, this is a present that sparks imagination and creates lasting memories.',
      de: 'Der Geburtstag ist der persönlichste Feiertag des Jahres — und verdient das persönlichste Geschenk. Mit einem personalisierten Geschichtenbuch wird dein Kind zur Hauptfigur seines eigenen Abenteuers. Es ist das Geschenk, das immer wieder gelesen wird, lange nachdem die Party vorbei ist. Ob 3 oder 10 Jahre — dieses Geschenk weckt Fantasie und schafft bleibende Erinnerungen.',
      fr: 'Un anniversaire est la célébration la plus personnelle de l\'année — et mérite le cadeau le plus personnel. Avec un livre d\'histoires personnalisé, votre enfant devient le personnage principal de sa propre aventure. C\'est le genre de cadeau qu\'on relit encore et encore, bien après la fête. Que votre enfant ait 3 ou 10 ans, c\'est un cadeau qui stimule l\'imagination et crée des souvenirs durables.',
      it: 'Il compleanno è la festa più personale dell\'anno — e merita il regalo più personale. Con un libro di storie personalizzato, tuo figlio diventa il protagonista della sua propria avventura. È il tipo di regalo che si legge e rilegge, molto tempo dopo la festa. Che compia 3 o 10 anni, è un regalo che accende la fantasia e crea ricordi duraturi.',
    },
    tips: {
      en: [
        'Choose a theme that matches your child\'s current passion (dinosaurs, unicorns, space...)',
        'Order the printed book version for a gift that feels truly special to unwrap',
        'Add siblings or friends as secondary characters for extra fun',
        'Create the story a week before the party — you can read it together on the big day',
      ],
      de: [
        'Wähle ein Thema, das zur aktuellen Leidenschaft deines Kindes passt (Dinosaurier, Einhörner, Weltraum...)',
        'Bestelle die gedruckte Buchversion für ein Geschenk, das sich beim Auspacken besonders anfühlt',
        'Füge Geschwister oder Freunde als Nebenfiguren hinzu für extra Spass',
        'Erstelle die Geschichte eine Woche vor der Party — ihr könnt sie am grossen Tag zusammen lesen',
      ],
      fr: [
        'Choisissez un thème qui correspond à la passion actuelle de votre enfant (dinosaures, licornes, espace...)',
        'Commandez la version imprimée pour un cadeau vraiment spécial à déballer',
        'Ajoutez des frères et soeurs ou amis comme personnages secondaires',
        'Créez l\'histoire une semaine avant la fête — vous pourrez la lire ensemble le jour J',
      ],
      it: [
        'Scegli un tema che rispecchi la passione del momento di tuo figlio (dinosauri, unicorni, spazio...)',
        'Ordina la versione stampata per un regalo che sembri davvero speciale da scartare',
        'Aggiungi fratelli, sorelle o amici come personaggi secondari per più divertimento',
        'Crea la storia una settimana prima della festa — potrete leggerla insieme nel grande giorno',
      ],
    },
    recommendedThemes: [
      { id: 'superhero', category: 'adventure' },
      { id: 'unicorn', category: 'adventure' },
      { id: 'dinosaur', category: 'adventure' },
      { id: 'pirate', category: 'adventure' },
      { id: 'dragon', category: 'adventure' },
      { id: 'space', category: 'adventure' },
    ],
    deliveryNote: {
      en: 'Tip: Create the story at least 5 days before the birthday to have time for the printed book delivery.',
      de: 'Tipp: Erstelle die Geschichte mindestens 5 Tage vor dem Geburtstag, damit das gedruckte Buch rechtzeitig ankommt.',
      fr: 'Conseil : Créez l\'histoire au moins 5 jours avant l\'anniversaire pour recevoir le livre imprimé à temps.',
      it: 'Consiglio: crea la storia almeno 5 giorni prima del compleanno per avere il tempo necessario alla consegna del libro stampato.',
    },
    faq: [
      {
        q: { en: 'How quickly can I get a printed book?', de: 'Wie schnell bekomme ich ein gedrucktes Buch?', fr: 'En combien de temps puis-je recevoir un livre imprimé ?', it: 'Quanto tempo ci vuole per ricevere un libro stampato?' },
        a: { en: 'The digital story is ready in minutes. Printed books are delivered within 5-7 business days to Swiss addresses.', de: 'Die digitale Geschichte ist in wenigen Minuten fertig. Gedruckte Bücher werden innerhalb von 5-7 Werktagen an Schweizer Adressen geliefert.', fr: 'L\'histoire numérique est prête en quelques minutes. Les livres imprimés sont livrés en 5 à 7 jours ouvrables en Suisse.', it: 'La storia digitale è pronta in pochi minuti. I libri stampati vengono consegnati entro 5-7 giorni lavorativi agli indirizzi svizzeri.' },
      },
      {
        q: { en: 'Can I add more than one child to the story?', de: 'Kann ich mehr als ein Kind zur Geschichte hinzufügen?', fr: 'Puis-je ajouter plus d\'un enfant à l\'histoire ?', it: 'Posso aggiungere più di un bambino alla storia?' },
        a: { en: 'Yes! You can add up to 3 characters. Perfect for siblings or best friends celebrating together.', de: 'Ja! Du kannst bis zu 3 Charaktere hinzufügen. Perfekt für Geschwister oder beste Freunde, die zusammen feiern.', fr: 'Oui ! Vous pouvez ajouter jusqu\'à 3 personnages. Parfait pour les frères et soeurs ou les meilleurs amis.', it: 'Sì! Puoi aggiungere fino a 3 personaggi. Perfetto per fratelli, sorelle o migliori amici che festeggiano insieme.' },
      },
      {
        q: { en: 'What age range is this suitable for?', de: 'Für welches Alter ist das geeignet?', fr: 'Pour quelle tranche d\'âge est-ce adapté ?', it: 'Per quale fascia d\'età è adatto?' },
        a: { en: 'Our stories are designed for children aged 2-12. The AI adapts the language complexity to the child\'s age.', de: 'Unsere Geschichten sind für Kinder von 2-12 Jahren konzipiert. Die KI passt die Sprachkomplexität an das Alter des Kindes an.', fr: 'Nos histoires sont conçues pour les enfants de 2 à 12 ans. L\'IA adapte la complexité du langage à l\'âge de l\'enfant.', it: 'Le nostre storie sono pensate per bambini dai 2 ai 12 anni. L\'IA adatta la complessità del linguaggio all\'età del bambino.' },
      },
    ],
  },

  // 2. Christmas
  {
    id: 'weihnachten',
    emoji: '🎄',
    name: { en: 'Christmas', de: 'Weihnachten', fr: 'Noël', it: 'Natale' },
    title: {
      en: 'Personalized Children\'s Book for Christmas',
      de: 'Personalisiertes Kinderbuch zu Weihnachten',
      fr: 'Livre personnalisé pour Noël',
      it: 'Libro personalizzato per bambini per Natale',
    },
    description: {
      en: 'A magical Christmas story with your child as the star. The perfect gift under the tree — personal, creative, and unforgettable.',
      de: 'Eine magische Weihnachtsgeschichte mit deinem Kind als Hauptfigur. Das perfekte Geschenk unter dem Baum — persönlich, kreativ und unvergesslich.',
      fr: 'Une histoire de Noël magique avec votre enfant comme personnage principal. Le cadeau parfait sous le sapin — personnel, créatif et inoubliable.',
      it: 'Una storia di Natale magica con tuo figlio come protagonista. Il regalo perfetto sotto l\'albero — personale, creativo e indimenticabile.',
    },
    intro: {
      en: 'Christmas is the season of wonder and stories. What better gift than a story where your child meets Santa, saves Christmas, or embarks on a magical winter adventure? A personalized Christmas book becomes a family treasure that you can read together by the fire every December. It\'s more than a toy — it\'s a tradition in the making.',
      de: 'Weihnachten ist die Zeit des Staunens und der Geschichten. Was könnte schöner sein als eine Geschichte, in der dein Kind dem Weihnachtsmann begegnet, Weihnachten rettet oder ein magisches Winterabenteuer erlebt? Ein personalisiertes Weihnachtsbuch wird zum Familienschatz, den ihr jeden Dezember gemeinsam am Kamin lesen könnt. Es ist mehr als ein Spielzeug — es ist der Beginn einer Tradition.',
      fr: 'Noël est la saison de l\'émerveillement et des histoires. Quel plus beau cadeau qu\'une histoire où votre enfant rencontre le Père Noël, sauve Noël ou vit une aventure hivernale magique ? Un livre de Noël personnalisé devient un trésor familial que vous lirez ensemble au coin du feu chaque décembre.',
      it: 'Il Natale è la stagione della meraviglia e delle storie. C\'è forse regalo migliore di una storia in cui tuo figlio incontra Babbo Natale, salva il Natale o vive una magica avventura invernale? Un libro di Natale personalizzato diventa un tesoro di famiglia da leggere insieme davanti al camino ogni dicembre. È più di un giocattolo — è l\'inizio di una tradizione.',
    },
    tips: {
      en: [
        'Choose the Christmas theme for a seasonal story, or pick any adventure with a festive twist',
        'Order by December 15 to ensure delivery before Christmas Eve',
        'Great as a gift from grandparents — just share the child\'s photo and details',
        'Read it together on Christmas Eve as a new family tradition',
      ],
      de: [
        'Wähle das Weihnachtsthema für eine saisonale Geschichte oder ein beliebiges Abenteuer mit festlichem Touch',
        'Bestelle bis 15. Dezember, damit das Buch rechtzeitig zu Heiligabend ankommt',
        'Perfekt als Geschenk von Grosseltern — einfach Foto und Details des Kindes teilen',
        'Lest es gemeinsam am Heiligabend als neue Familientradition',
      ],
      fr: [
        'Choisissez le thème Noël pour une histoire saisonnière ou toute aventure avec une touche festive',
        'Commandez avant le 15 décembre pour une livraison avant le réveillon',
        'Idéal comme cadeau des grands-parents — partagez simplement la photo et les détails de l\'enfant',
        'Lisez-le ensemble le soir de Noël comme nouvelle tradition familiale',
      ],
      it: [
        'Scegli il tema Natale per una storia stagionale, oppure un\'avventura qualsiasi con un tocco festivo',
        'Ordina entro il 15 dicembre per garantire la consegna prima della Vigilia',
        'Ottimo come regalo dai nonni — basta condividere la foto e i dettagli del bambino',
        'Leggetela insieme la Vigilia di Natale come nuova tradizione di famiglia',
      ],
    },
    recommendedThemes: [
      { id: 'christmas', category: 'adventure' },
      { id: 'wizard', category: 'adventure' },
      { id: 'forest', category: 'adventure' },
      { id: 'knight', category: 'adventure' },
      { id: 'seasons', category: 'educational' },
    ],
    deliveryNote: {
      en: 'Christmas deadline: Order by December 15 for guaranteed delivery before December 24.',
      de: 'Weihnachts-Frist: Bestelle bis 15. Dezember für garantierte Lieferung vor dem 24. Dezember.',
      fr: 'Date limite Noël : Commandez avant le 15 décembre pour une livraison garantie avant le 24 décembre.',
      it: 'Scadenza natalizia: ordina entro il 15 dicembre per la consegna garantita prima del 24 dicembre.',
    },
    faq: [
      {
        q: { en: 'Will the story have a Christmas theme?', de: 'Hat die Geschichte ein Weihnachtsthema?', fr: 'L\'histoire aura-t-elle un thème de Noël ?', it: 'La storia avrà un tema natalizio?' },
        a: { en: 'If you select the Christmas theme, absolutely! But you can also pick any other theme — the story itself is the gift.', de: 'Wenn du das Weihnachtsthema wählst, auf jeden Fall! Du kannst aber auch jedes andere Thema wählen — die Geschichte selbst ist das Geschenk.', fr: 'Si vous choisissez le thème Noël, absolument ! Mais vous pouvez aussi choisir n\'importe quel autre thème — l\'histoire elle-même est le cadeau.', it: 'Se scegli il tema Natale, assolutamente sì! Ma puoi anche scegliere qualsiasi altro tema — è la storia stessa il regalo.' },
      },
      {
        q: { en: 'Can I order multiple books for siblings?', de: 'Kann ich mehrere Bücher für Geschwister bestellen?', fr: 'Puis-je commander plusieurs livres pour des frères et soeurs ?', it: 'Posso ordinare più libri per fratelli e sorelle?' },
        a: { en: 'Yes! Create a unique story for each child, or create one story with all siblings as characters.', de: 'Ja! Erstelle eine einzigartige Geschichte für jedes Kind oder eine Geschichte mit allen Geschwistern als Charaktere.', fr: 'Oui ! Créez une histoire unique pour chaque enfant, ou une histoire avec tous les frères et soeurs comme personnages.', it: 'Sì! Crea una storia unica per ogni bambino, oppure una storia con tutti i fratelli e le sorelle come personaggi.' },
      },
    ],
  },

  // 3. Easter
  {
    id: 'ostern',
    emoji: '🐰',
    name: { en: 'Easter', de: 'Ostern', fr: 'Pâques', it: 'Pasqua' },
    title: {
      en: 'Personalized Children\'s Book for Easter',
      de: 'Personalisiertes Kinderbuch zu Ostern',
      fr: 'Livre personnalisé pour Pâques',
      it: 'Libro personalizzato per bambini per Pasqua',
    },
    description: {
      en: 'An egg-citing Easter adventure with your child as the hero. The perfect surprise for the Easter basket — more memorable than chocolate!',
      de: 'Ein eifriges Oster-Abenteuer mit deinem Kind als Held. Die perfekte Überraschung fürs Osternest — unvergesslicher als Schokolade!',
      fr: 'Une aventure de Pâques passionnante avec votre enfant comme héros. La surprise parfaite pour le panier de Pâques — plus mémorable que le chocolat !',
      it: 'Un\'avventura di Pasqua uovo-sionante con tuo figlio come eroe. La sorpresa perfetta per il cestino di Pasqua — più indimenticabile del cioccolato!',
    },
    intro: {
      en: 'Easter is a time of new beginnings, spring adventures, and joyful surprises. A personalized Easter story takes your child on a magical egg hunt, a spring garden adventure, or a journey with the Easter Bunny. Tuck it into their Easter basket alongside the chocolate eggs for a gift that lasts far beyond Easter Sunday. It\'s a wonderful way to celebrate spring together.',
      de: 'Ostern ist die Zeit des Neubeginns, der Frühlingsabenteuer und fröhlicher Überraschungen. Eine personalisierte Ostergeschichte nimmt dein Kind mit auf eine magische Eiersuche, ein Frühlingsgarten-Abenteuer oder eine Reise mit dem Osterhasen. Lege es neben die Schokoladeneier ins Osternest für ein Geschenk, das weit über den Ostersonntag hinaus Freude macht. Eine wunderbare Art, den Frühling gemeinsam zu feiern.',
      fr: 'Pâques est une période de renouveau, d\'aventures printanières et de joyeuses surprises. Une histoire de Pâques personnalisée emmène votre enfant dans une chasse aux oeufs magique ou une aventure printanière. Glissez-la dans le panier de Pâques à côté des oeufs en chocolat pour un cadeau qui dure bien au-delà du dimanche de Pâques.',
      it: 'Pasqua è il periodo dei nuovi inizi, delle avventure primaverili e delle sorprese gioiose. Una storia di Pasqua personalizzata porta tuo figlio in una magica caccia alle uova, in un\'avventura nel giardino primaverile o in un viaggio con il Coniglietto Pasquale. Nascondila nel cestino di Pasqua accanto alle uova di cioccolato, per un regalo che dura ben oltre la domenica di Pasqua. Un modo meraviglioso per festeggiare insieme la primavera.',
    },
    tips: {
      en: [
        'Hide the printed book in the Easter basket alongside the eggs',
        'Choose the Easter theme for bunnies, eggs, and spring magic',
        'Create the story 1-2 weeks before Easter for printed delivery',
        'A great alternative to too much chocolate!',
      ],
      de: [
        'Verstecke das gedruckte Buch im Osternest neben den Eiern',
        'Wähle das Osterthema für Hasen, Eier und Frühlingsmagie',
        'Erstelle die Geschichte 1-2 Wochen vor Ostern für die gedruckte Lieferung',
        'Eine tolle Alternative zu zu viel Schokolade!',
      ],
      fr: [
        'Cachez le livre imprimé dans le panier de Pâques avec les oeufs',
        'Choisissez le thème Pâques pour les lapins, les oeufs et la magie du printemps',
        'Créez l\'histoire 1 à 2 semaines avant Pâques pour la livraison imprimée',
        'Une super alternative à trop de chocolat !',
      ],
      it: [
        'Nascondi il libro stampato nel cestino di Pasqua insieme alle uova',
        'Scegli il tema Pasqua per conigli, uova e magia primaverile',
        'Crea la storia 1-2 settimane prima di Pasqua per la consegna stampata',
        'Un\'ottima alternativa a troppo cioccolato!',
      ],
    },
    recommendedThemes: [
      { id: 'easter', category: 'adventure' },
      { id: 'farm', category: 'adventure' },
      { id: 'forest', category: 'adventure' },
      { id: 'jungle', category: 'adventure' },
      { id: 'seasons', category: 'educational' },
      { id: 'farm-animals', category: 'educational' },
    ],
    deliveryNote: {
      en: 'Order at least 7 days before Easter for printed book delivery.',
      de: 'Bestelle mindestens 7 Tage vor Ostern für die Lieferung des gedruckten Buches.',
      fr: 'Commandez au moins 7 jours avant Pâques pour la livraison du livre imprimé.',
      it: 'Ordina almeno 7 giorni prima di Pasqua per la consegna del libro stampato.',
    },
    faq: [
      {
        q: { en: 'Does the story feature the Easter Bunny?', de: 'Kommt der Osterhase in der Geschichte vor?', fr: 'Le lapin de Pâques apparaît-il dans l\'histoire ?', it: 'Il Coniglietto Pasquale compare nella storia?' },
        a: { en: 'With the Easter theme, your child will go on an adventure that includes springtime elements and Easter magic. The AI crafts a unique story each time.', de: 'Mit dem Osterthema erlebt dein Kind ein Abenteuer mit Frühlingselementen und Ostermagie. Die KI erstellt jedes Mal eine einzigartige Geschichte.', fr: 'Avec le thème Pâques, votre enfant vivra une aventure avec des éléments printaniers et de la magie pascale. L\'IA crée une histoire unique à chaque fois.', it: 'Con il tema Pasqua, tuo figlio vivrà un\'avventura con elementi primaverili e magia pasquale. L\'IA crea una storia unica ogni volta.' },
      },
      {
        q: { en: 'Is this a good Easter basket gift?', de: 'Ist das ein gutes Geschenk fürs Osternest?', fr: 'Est-ce un bon cadeau pour le panier de Pâques ?', it: 'È un buon regalo per il cestino di Pasqua?' },
        a: { en: 'Absolutely! Parents love it as a meaningful addition to the Easter basket. It\'s a keepsake that outlasts any candy.', de: 'Auf jeden Fall! Eltern lieben es als bedeutungsvolle Ergänzung zum Osternest. Es ist ein Andenken, das länger hält als jede Süssigkeit.', fr: 'Absolument ! Les parents adorent comme ajout significatif au panier de Pâques. C\'est un souvenir qui dure plus longtemps que les bonbons.', it: 'Assolutamente sì! I genitori lo adorano come aggiunta significativa al cestino di Pasqua. È un ricordo che dura più a lungo di qualsiasi dolciume.' },
      },
    ],
  },

  // 4. Baptism / Christening
  {
    id: 'taufe',
    emoji: '💧',
    name: { en: 'Baptism', de: 'Taufe', fr: 'Baptême', it: 'Battesimo' },
    title: {
      en: 'Personalized Children\'s Book for Baptism',
      de: 'Personalisiertes Kinderbuch zur Taufe',
      fr: 'Livre personnalisé pour le baptême',
      it: 'Libro personalizzato per bambini per il battesimo',
    },
    description: {
      en: 'Celebrate a baptism with a personalized story book — a meaningful keepsake gift for this special milestone.',
      de: 'Feiere die Taufe mit einem personalisierten Geschichtenbuch — ein bedeutungsvolles Erinnerungsgeschenk für diesen besonderen Meilenstein.',
      fr: 'Célébrez un baptême avec un livre d\'histoires personnalisé — un cadeau souvenir significatif pour cette étape importante.',
      it: 'Festeggia un battesimo con un libro di storie personalizzato — un regalo ricordo pieno di significato per questa tappa speciale.',
    },
    intro: {
      en: 'A baptism is one of the first big celebrations in a child\'s life. Mark this special day with a personalized story that the child can treasure for years to come. As a godparent, grandparent, or family friend, this is a gift with real meaning — not just another toy that\'s forgotten in a week. The story can be read to them now and re-discovered when they\'re older.',
      de: 'Die Taufe ist einer der ersten grossen Feiertage im Leben eines Kindes. Markiere diesen besonderen Tag mit einer personalisierten Geschichte, die das Kind über Jahre hinweg schätzen wird. Als Götti, Gotti, Grosseltern oder Familienfreund ist dies ein Geschenk mit echter Bedeutung — nicht nur ein Spielzeug, das nach einer Woche vergessen ist. Die Geschichte kann jetzt vorgelesen und später wiederentdeckt werden.',
      fr: 'Le baptême est l\'une des premières grandes célébrations dans la vie d\'un enfant. Marquez ce jour spécial avec une histoire personnalisée que l\'enfant chérira pendant des années. En tant que parrain, marraine ou ami de la famille, c\'est un cadeau qui a du sens — pas juste un jouet oublié après une semaine.',
      it: 'Il battesimo è una delle prime grandi celebrazioni nella vita di un bambino. Rendi speciale questo giorno con una storia personalizzata che il bambino potrà custodire per anni. Come padrino, madrina, nonno o amico di famiglia, questo è un regalo con un significato vero — non solo un altro giocattolo dimenticato dopo una settimana. La storia può essere letta ora e riscoperta più avanti, da grande.',
    },
    tips: {
      en: [
        'Perfect gift from godparents — personal and meaningful',
        'Choose a gentle, magical theme like Unicorn or Forest Friends',
        'The printed book makes a beautiful keepsake for the baptism memory box',
        'Include the baptism date as a custom detail in your story',
      ],
      de: [
        'Perfektes Geschenk von Götti und Gotti — persönlich und bedeutungsvoll',
        'Wähle ein sanftes, magisches Thema wie Einhorn oder Waldfreunde',
        'Das gedruckte Buch ist ein wunderschönes Andenken für die Tauf-Erinnerungsbox',
        'Füge das Taufdatum als individuelles Detail in die Geschichte ein',
      ],
      fr: [
        'Cadeau parfait des parrains et marraines — personnel et significatif',
        'Choisissez un thème doux et magique comme Licorne ou Amis de la Forêt',
        'Le livre imprimé fait un beau souvenir pour la boîte à souvenirs du baptême',
        'Incluez la date du baptême comme détail personnalisé dans votre histoire',
      ],
      it: [
        'Regalo perfetto da padrini e madrine — personale e ricco di significato',
        'Scegli un tema delicato e magico come Unicorno o Amici della Foresta',
        'Il libro stampato è un bellissimo ricordo per la scatola dei ricordi del battesimo',
        'Includi la data del battesimo come dettaglio personalizzato nella storia',
      ],
    },
    recommendedThemes: [
      { id: 'unicorn', category: 'adventure' },
      { id: 'forest', category: 'adventure' },
      { id: 'ocean', category: 'adventure' },
      { id: 'farm', category: 'adventure' },
      { id: 'being-brave', category: 'life-challenges' },
    ],
    deliveryNote: {
      en: 'Order 1-2 weeks before the baptism ceremony for printed book delivery.',
      de: 'Bestelle 1-2 Wochen vor der Tauffeier für die Lieferung des gedruckten Buches.',
      fr: 'Commandez 1 à 2 semaines avant la cérémonie de baptême pour la livraison du livre imprimé.',
      it: 'Ordina 1-2 settimane prima della cerimonia di battesimo per la consegna del libro stampato.',
    },
    faq: [
      {
        q: { en: 'Is this suitable for a baby?', de: 'Ist das für ein Baby geeignet?', fr: 'Est-ce adapté pour un bébé ?', it: 'È adatto per un neonato?' },
        a: { en: 'Yes! While the baby won\'t read it themselves yet, parents can read it aloud. The printed book becomes a cherished keepsake as the child grows.', de: 'Ja! Das Baby wird es zwar noch nicht selbst lesen, aber die Eltern können es vorlesen. Das gedruckte Buch wird zu einem wertvollen Andenken, wenn das Kind grösser wird.', fr: 'Oui ! Bien que le bébé ne le lira pas encore lui-même, les parents peuvent le lire à voix haute. Le livre imprimé devient un souvenir précieux quand l\'enfant grandit.', it: 'Sì! Anche se il neonato non potrà ancora leggerlo da solo, i genitori possono leggerlo ad alta voce. Il libro stampato diventa un ricordo prezioso man mano che il bambino cresce.' },
      },
      {
        q: { en: 'Can I include a dedication message?', de: 'Kann ich eine Widmung hinzufügen?', fr: 'Puis-je inclure un message de dédicace ?', it: 'Posso includere una dedica?' },
        a: { en: 'The printed book includes a dedication page where you can add a personal message from the godparents or family.', de: 'Das gedruckte Buch enthält eine Widmungsseite, auf der du eine persönliche Nachricht von Götti/Gotti oder der Familie hinzufügen kannst.', fr: 'Le livre imprimé comprend une page de dédicace où vous pouvez ajouter un message personnel des parrains ou de la famille.', it: 'Il libro stampato include una pagina di dedica dove puoi aggiungere un messaggio personale da parte dei padrini o della famiglia.' },
      },
    ],
  },

  // 5. First Day of School (Einschulung)
  {
    id: 'einschulung',
    emoji: '🎒',
    name: { en: 'First Day of School', de: 'Einschulung', fr: 'Rentrée scolaire', it: 'Primo giorno di scuola' },
    title: {
      en: 'Personalized Children\'s Book for the First Day of School',
      de: 'Personalisiertes Kinderbuch zur Einschulung',
      fr: 'Livre personnalisé pour la rentrée scolaire',
      it: 'Libro personalizzato per bambini per il primo giorno di scuola',
    },
    description: {
      en: 'Make the first day of school unforgettable with a story where your child bravely starts their school adventure. The perfect Schultüte filling!',
      de: 'Mache den ersten Schultag unvergesslich mit einer Geschichte, in der dein Kind mutig sein Schulabenteuer startet. Die perfekte Füllung für die Schultüte!',
      fr: 'Rendez le premier jour d\'école inoubliable avec une histoire où votre enfant commence courageusement son aventure scolaire.',
      it: 'Rendi indimenticabile il primo giorno di scuola con una storia in cui tuo figlio inizia coraggiosamente la sua avventura scolastica. Il regalo perfetto per il primo giorno!',
    },
    intro: {
      en: 'Starting school is a huge milestone — exciting and a little scary at the same time. A personalized story about the first day of school helps your child feel prepared and confident. They\'ll see themselves as the brave hero who makes new friends and discovers exciting things. It\'s also a wonderful addition to the traditional Schultüte (school cone) in Swiss and German culture.',
      de: 'Die Einschulung ist ein riesiger Meilenstein — aufregend und ein bisschen beängstigend zugleich. Eine personalisierte Geschichte über den ersten Schultag hilft deinem Kind, sich vorbereitet und selbstbewusst zu fühlen. Es sieht sich selbst als mutigen Helden, der neue Freunde findet und spannende Dinge entdeckt. Und es ist eine wunderbare Ergänzung zur traditionellen Schultüte.',
      fr: 'La rentrée scolaire est une étape majeure — excitante et un peu effrayante à la fois. Une histoire personnalisée sur le premier jour d\'école aide votre enfant à se sentir préparé et confiant. Il se verra comme le héros courageux qui se fait de nouveaux amis et découvre des choses passionnantes.',
      it: 'Iniziare la scuola è una tappa enorme — emozionante e un po\' spaventosa allo stesso tempo. Una storia personalizzata sul primo giorno di scuola aiuta tuo figlio a sentirsi preparato e sicuro di sé. Si vedrà come il coraggioso eroe che fa nuove amicizie e scopre cose entusiasmanti. È anche un\'aggiunta meravigliosa al tradizionale Schultüte (il cono di dolci) della cultura svizzero-tedesca.',
    },
    tips: {
      en: [
        'Put the book in the Schultüte (school cone) alongside the treats',
        'Read the story together the night before the big day',
        'Choose the "First Day of School" life skills theme for a story that addresses school nerves',
        'The "Alphabet" or "Numbers" educational themes also make great school-start gifts',
      ],
      de: [
        'Lege das Buch in die Schultüte neben die Süssigkeiten',
        'Lest die Geschichte zusammen am Abend vor dem grossen Tag',
        'Wähle das Thema "Erster Schultag" für eine Geschichte, die Schulängste anspricht',
        'Die Lernthemen "Alphabet" oder "Zahlen" sind ebenfalls tolle Geschenke zum Schulstart',
      ],
      fr: [
        'Glissez le livre dans le cartable avec les fournitures scolaires',
        'Lisez l\'histoire ensemble la veille du grand jour',
        'Choisissez le thème "Premier jour d\'école" pour une histoire qui aborde le trac scolaire',
        'Les thèmes éducatifs "Alphabet" ou "Nombres" sont aussi de super cadeaux de rentrée',
      ],
      it: [
        'Metti il libro nello Schultüte (cono di dolci) insieme alle golosità',
        'Leggete la storia insieme la sera prima del grande giorno',
        'Scegli il tema "Primo giorno di scuola" per una storia che affronta l\'ansia scolastica',
        'Anche i temi educativi "Alfabeto" o "Numeri" sono ottimi regali per l\'inizio della scuola',
      ],
    },
    recommendedThemes: [
      { id: 'first-school', category: 'life-challenges' },
      { id: 'making-friends', category: 'life-challenges' },
      { id: 'being-brave', category: 'life-challenges' },
      { id: 'alphabet', category: 'educational' },
      { id: 'numbers-1-10', category: 'educational' },
      { id: 'detective', category: 'adventure' },
    ],
    deliveryNote: {
      en: 'Order 1-2 weeks before the first day of school. The Schultüte surprise is worth the planning!',
      de: 'Bestelle 1-2 Wochen vor dem ersten Schultag. Die Schultüten-Überraschung ist die Planung wert!',
      fr: 'Commandez 1 à 2 semaines avant la rentrée. La surprise en vaut la planification !',
      it: 'Ordina 1-2 settimane prima del primo giorno di scuola. La sorpresa dello Schultüte vale la pianificazione!',
    },
    faq: [
      {
        q: { en: 'What age is Einschulung typically?', de: 'In welchem Alter ist die Einschulung?', fr: 'À quel âge a lieu la rentrée scolaire ?', it: 'A che età si inizia tipicamente la scuola?' },
        a: { en: 'In Switzerland, children typically start school (Kindergarten or 1st grade) at age 4-6. Our stories adapt the language to the child\'s age.', de: 'In der Schweiz kommen Kinder typischerweise mit 4-6 Jahren in den Kindergarten oder die 1. Klasse. Unsere Geschichten passen die Sprache an das Alter des Kindes an.', fr: 'En Suisse, les enfants commencent généralement l\'école (jardin d\'enfants ou 1ère année) à 4-6 ans. Nos histoires adaptent le langage à l\'âge de l\'enfant.', it: 'In Svizzera, i bambini iniziano tipicamente la scuola (scuola dell\'infanzia o prima elementare) tra i 4 e i 6 anni. Le nostre storie adattano il linguaggio all\'età del bambino.' },
      },
      {
        q: { en: 'Does the story help with school anxiety?', de: 'Hilft die Geschichte bei Schulangst?', fr: 'L\'histoire aide-t-elle avec l\'anxiété scolaire ?', it: 'La storia aiuta con l\'ansia scolastica?' },
        a: { en: 'Yes! The "First Day of School" theme is specifically designed to address common fears and show your child that school is an exciting adventure.', de: 'Ja! Das Thema "Erster Schultag" ist speziell darauf ausgelegt, häufige Ängste anzusprechen und deinem Kind zu zeigen, dass Schule ein spannendes Abenteuer ist.', fr: 'Oui ! Le thème "Premier jour d\'école" est spécialement conçu pour aborder les peurs courantes et montrer à votre enfant que l\'école est une aventure passionnante.', it: 'Sì! Il tema "Primo giorno di scuola" è pensato apposta per affrontare le paure più comuni e mostrare a tuo figlio che la scuola è un\'avventura entusiasmante.' },
      },
    ],
  },

  // 6. New Sibling
  {
    id: 'geschwisterchen',
    emoji: '👶',
    name: { en: 'New Sibling', de: 'Geschwisterchen', fr: 'Nouveau bébé', it: 'Nuovo fratellino' },
    title: {
      en: 'Personalized Children\'s Book for a New Sibling',
      de: 'Personalisiertes Kinderbuch zum neuen Geschwisterchen',
      fr: 'Livre personnalisé pour l\'arrivée d\'un nouveau bébé',
      it: 'Libro personalizzato per bambini per un nuovo fratellino o sorellina',
    },
    description: {
      en: 'Help your child welcome their new baby brother or sister with a story that celebrates becoming a big sibling.',
      de: 'Hilf deinem Kind, sein neues Brüderchen oder Schwesterchen willkommen zu heissen — mit einer Geschichte, die das Grosswerden als Geschwister feiert.',
      fr: 'Aidez votre enfant à accueillir son nouveau petit frère ou sa petite soeur avec une histoire qui célèbre le fait de devenir grand frère ou grande soeur.',
      it: 'Aiuta tuo figlio ad accogliere il nuovo fratellino o sorellina con una storia che celebra il diventare fratello o sorella maggiore.',
    },
    intro: {
      en: 'A new baby in the family is a big adjustment for the older child. They might feel jealous, worried, or unsure about their new role. A personalized story helps them see being a big brother or sister as an exciting adventure. In the story, they\'re the hero who helps and protects — building confidence and connection before the baby even arrives. Many parents read it during pregnancy to prepare their child.',
      de: 'Ein neues Baby in der Familie ist eine grosse Umstellung für das ältere Kind. Es fühlt sich vielleicht eifersüchtig, besorgt oder unsicher in seiner neuen Rolle. Eine personalisierte Geschichte hilft ihm zu sehen, dass es ein spannendes Abenteuer ist, grosser Bruder oder grosse Schwester zu werden. In der Geschichte ist es der Held, der hilft und beschützt — das stärkt Selbstvertrauen und Verbindung, noch bevor das Baby da ist. Viele Eltern lesen sie schon in der Schwangerschaft vor.',
      fr: 'Un nouveau bébé dans la famille est un grand changement pour l\'aîné. Il peut se sentir jaloux, inquiet ou incertain de son nouveau rôle. Une histoire personnalisée l\'aide à voir le fait d\'être grand frère ou grande soeur comme une aventure excitante. Dans l\'histoire, c\'est le héros qui aide et protège. Beaucoup de parents la lisent pendant la grossesse pour préparer leur enfant.',
      it: 'L\'arrivo di un nuovo bebè in famiglia è un grande cambiamento per il figlio maggiore. Potrebbe sentirsi geloso, preoccupato o incerto sul suo nuovo ruolo. Una storia personalizzata lo aiuta a vedere il diventare fratello o sorella maggiore come un\'avventura entusiasmante. Nella storia, è lui l\'eroe che aiuta e protegge — costruendo fiducia e legame ancora prima che il bebè arrivi. Molti genitori la leggono durante la gravidanza per preparare il proprio figlio.',
    },
    tips: {
      en: [
        'Create the story before the baby arrives — it\'s a great preparation tool',
        'Choose the "New Baby Sibling" theme for a story that addresses sibling emotions',
        'Give the book as a special gift from the new baby to the big sibling',
        'Include both children in the story if the baby already has a name',
      ],
      de: [
        'Erstelle die Geschichte vor der Geburt — sie ist ein tolles Vorbereitungswerkzeug',
        'Wähle das Thema "Neues Geschwisterchen" für eine Geschichte über Geschwistergefühle',
        'Verschenke das Buch als spezielles Geschenk vom neuen Baby an das grosse Geschwisterchen',
        'Füge beide Kinder in die Geschichte ein, wenn das Baby bereits einen Namen hat',
      ],
      fr: [
        'Créez l\'histoire avant l\'arrivée du bébé — c\'est un excellent outil de préparation',
        'Choisissez le thème "Nouveau bébé" pour une histoire sur les émotions fraternelles',
        'Offrez le livre comme cadeau spécial du nouveau bébé au grand frère ou à la grande soeur',
        'Incluez les deux enfants dans l\'histoire si le bébé a déjà un prénom',
      ],
      it: [
        'Crea la storia prima che il bebè arrivi — è un ottimo strumento di preparazione',
        'Scegli il tema "Nuovo fratellino" per una storia che affronta le emozioni tra fratelli',
        'Regala il libro come dono speciale dal nuovo bebè al fratello o alla sorella maggiore',
        'Includi entrambi i bambini nella storia se il bebè ha già un nome',
      ],
    },
    recommendedThemes: [
      { id: 'new-sibling', category: 'life-challenges' },
      { id: 'sharing', category: 'life-challenges' },
      { id: 'managing-emotions', category: 'life-challenges' },
      { id: 'being-brave', category: 'life-challenges' },
      { id: 'superhero', category: 'adventure' },
    ],
    deliveryNote: {
      en: 'Ideal to order during pregnancy so the book is ready when the baby arrives.',
      de: 'Ideal in der Schwangerschaft zu bestellen, damit das Buch bereit ist, wenn das Baby kommt.',
      fr: 'Idéal à commander pendant la grossesse pour que le livre soit prêt à l\'arrivée du bébé.',
      it: 'Ideale ordinarlo durante la gravidanza, così il libro è pronto quando arriva il bebè.',
    },
    faq: [
      {
        q: { en: 'Should I create the story before or after the baby is born?', de: 'Soll ich die Geschichte vor oder nach der Geburt erstellen?', fr: 'Dois-je créer l\'histoire avant ou après la naissance ?', it: 'Devo creare la storia prima o dopo la nascita del bebè?' },
        a: { en: 'Before is ideal! Reading the story during pregnancy helps prepare your child for the change. You can always create another story after the baby arrives.', de: 'Vorher ist ideal! Das Vorlesen während der Schwangerschaft hilft deinem Kind, sich auf die Veränderung vorzubereiten. Du kannst nach der Geburt jederzeit eine weitere Geschichte erstellen.', fr: 'Avant, c\'est idéal ! Lire l\'histoire pendant la grossesse aide à préparer votre enfant au changement. Vous pouvez toujours créer une autre histoire après la naissance.', it: 'Prima è l\'ideale! Leggere la storia durante la gravidanza aiuta a preparare tuo figlio al cambiamento. Puoi comunque creare un\'altra storia dopo la nascita del bebè.' },
      },
      {
        q: { en: 'Can both siblings be in the story?', de: 'Können beide Geschwister in der Geschichte vorkommen?', fr: 'Les deux enfants peuvent-ils être dans l\'histoire ?', it: 'Possono comparire entrambi i fratelli nella storia?' },
        a: { en: 'Yes! You can add multiple characters. The older child is the main hero, with the baby as a supporting character.', de: 'Ja! Du kannst mehrere Charaktere hinzufügen. Das ältere Kind ist der Hauptheld, das Baby die Nebenfigur.', fr: 'Oui ! Vous pouvez ajouter plusieurs personnages. L\'aîné est le héros principal, le bébé un personnage secondaire.', it: 'Sì! Puoi aggiungere più personaggi. Il figlio maggiore è l\'eroe principale, con il bebè come personaggio secondario.' },
      },
    ],
  },

  // 7. Mother's Day
  {
    id: 'muttertag',
    emoji: '💐',
    name: { en: 'Mother\'s Day', de: 'Muttertag', fr: 'Fête des mères', it: 'Festa della mamma' },
    title: {
      en: 'Personalized Children\'s Book for Mother\'s Day',
      de: 'Personalisiertes Kinderbuch zum Muttertag',
      fr: 'Livre personnalisé pour la fête des mères',
      it: 'Libro personalizzato per bambini per la festa della mamma',
    },
    description: {
      en: 'A story where your child celebrates their amazing mom. The most heartwarming Mother\'s Day gift a child can give.',
      de: 'Eine Geschichte, in der dein Kind seine tolle Mama feiert. Das herzerwärmendste Muttertagsgeschenk, das ein Kind machen kann.',
      fr: 'Une histoire où votre enfant célèbre sa maman formidable. Le cadeau le plus touchant qu\'un enfant puisse offrir pour la fête des mères.',
      it: 'Una storia in cui tuo figlio festeggia la sua fantastica mamma. Il regalo più commovente che un bambino possa fare per la festa della mamma.',
    },
    intro: {
      en: 'Forget the socks and flowers — this Mother\'s Day, give something truly from the heart. A personalized story where the child goes on an adventure with (or for) their mom is a gift that will bring tears of joy. Dads and grandparents can help the child create it as a surprise. It\'s personal, creative, and shows mom just how special she is through the eyes of her child.',
      de: 'Vergiss Socken und Blumen — schenke diesen Muttertag etwas wirklich von Herzen. Eine personalisierte Geschichte, in der das Kind ein Abenteuer mit (oder für) seine Mama erlebt, ist ein Geschenk, das Freudentränen bringt. Papas und Grosseltern können dem Kind helfen, es als Überraschung zu erstellen. Es ist persönlich, kreativ und zeigt Mama, wie besonders sie ist — durch die Augen ihres Kindes.',
      fr: 'Oubliez les chaussettes et les fleurs — cette fête des mères, offrez quelque chose qui vient vraiment du coeur. Une histoire personnalisée où l\'enfant vit une aventure avec (ou pour) sa maman est un cadeau qui fera couler des larmes de joie. Les papas et grands-parents peuvent aider l\'enfant à le créer comme surprise.',
      it: 'Dimentica calzini e fiori — per questa festa della mamma, regala qualcosa che viene davvero dal cuore. Una storia personalizzata in cui il bambino vive un\'avventura con (o per) la propria mamma è un regalo che strapperà lacrime di gioia. Papà e nonni possono aiutare il bambino a crearla come sorpresa. È personale, creativa e mostra alla mamma quanto sia speciale, vista attraverso gli occhi di suo figlio.',
    },
    tips: {
      en: [
        'Dad or grandparents can help the child create the story as a surprise',
        'Include mom as a character in the story for extra magic',
        'Pick an adventure theme the child associates with mom (e.g., ocean if mom loves the sea)',
        'Read the story aloud to mom on Mother\'s Day morning — a priceless moment',
      ],
      de: [
        'Papa oder Grosseltern können dem Kind helfen, die Geschichte als Überraschung zu erstellen',
        'Füge Mama als Charakter in die Geschichte ein für extra Magie',
        'Wähle ein Abenteuerthema, das das Kind mit Mama verbindet (z.B. Ozean, wenn Mama das Meer liebt)',
        'Lest die Geschichte am Muttertagmorgen Mama laut vor — ein unbezahlbarer Moment',
      ],
      fr: [
        'Papa ou les grands-parents peuvent aider l\'enfant à créer l\'histoire comme surprise',
        'Incluez maman comme personnage dans l\'histoire pour encore plus de magie',
        'Choisissez un thème d\'aventure que l\'enfant associe à maman',
        'Lisez l\'histoire à voix haute à maman le matin de la fête des mères — un moment inestimable',
      ],
      it: [
        'Papà o i nonni possono aiutare il bambino a creare la storia come sorpresa',
        'Includi la mamma come personaggio nella storia per una magia in più',
        'Scegli un tema d\'avventura che il bambino associa alla mamma (es. oceano, se la mamma ama il mare)',
        'Leggete la storia ad alta voce alla mamma la mattina della sua festa — un momento impagabile',
      ],
    },
    recommendedThemes: [
      { id: 'mothers-day', category: 'adventure' },
      { id: 'unicorn', category: 'adventure' },
      { id: 'ocean', category: 'adventure' },
      { id: 'forest', category: 'adventure' },
      { id: 'mermaid', category: 'adventure' },
      { id: 'wizard', category: 'adventure' },
    ],
    deliveryNote: {
      en: 'Mother\'s Day is the second Sunday in May. Order 1-2 weeks ahead for the printed book.',
      de: 'Muttertag ist der zweite Sonntag im Mai. Bestelle 1-2 Wochen vorher für das gedruckte Buch.',
      fr: 'La fête des mères est le deuxième dimanche de mai. Commandez 1 à 2 semaines à l\'avance pour le livre imprimé.',
      it: 'La festa della mamma cade la seconda domenica di maggio. Ordina 1-2 settimane prima per il libro stampato.',
    },
    faq: [
      {
        q: { en: 'Can the child create the story themselves?', de: 'Kann das Kind die Geschichte selbst erstellen?', fr: 'L\'enfant peut-il créer l\'histoire lui-même ?', it: 'Il bambino può creare la storia da solo?' },
        a: { en: 'Older children (6+) can navigate the wizard with minimal help. For younger children, a parent or grandparent can guide them through the process.', de: 'Ältere Kinder (6+) können den Assistenten mit minimaler Hilfe bedienen. Für jüngere Kinder können Eltern oder Grosseltern sie durch den Prozess führen.', fr: 'Les enfants plus âgés (6+) peuvent utiliser l\'assistant avec un minimum d\'aide. Pour les plus jeunes, un parent ou grand-parent peut les guider.', it: 'I bambini più grandi (6+) possono usare la procedura guidata con poco aiuto. Per i più piccoli, un genitore o un nonno può accompagnarli passo dopo passo.' },
      },
      {
        q: { en: 'Can I add mom as a character?', de: 'Kann ich Mama als Charakter hinzufügen?', fr: 'Puis-je ajouter maman comme personnage ?', it: 'Posso aggiungere la mamma come personaggio?' },
        a: { en: 'Yes! Add mom as a second character with her name and description. She\'ll appear in the story alongside your child.', de: 'Ja! Füge Mama als zweiten Charakter mit ihrem Namen und Beschreibung hinzu. Sie erscheint in der Geschichte neben deinem Kind.', fr: 'Oui ! Ajoutez maman comme deuxième personnage avec son nom et sa description. Elle apparaîtra dans l\'histoire aux côtés de votre enfant.', it: 'Sì! Aggiungi la mamma come secondo personaggio con il suo nome e la sua descrizione. Apparirà nella storia accanto a tuo figlio.' },
      },
    ],
  },

  // 8. Father's Day
  {
    id: 'vatertag',
    emoji: '👔',
    name: { en: 'Father\'s Day', de: 'Vatertag', fr: 'Fête des pères', it: 'Festa del papà' },
    title: {
      en: 'Personalized Children\'s Book for Father\'s Day',
      de: 'Personalisiertes Kinderbuch zum Vatertag',
      fr: 'Livre personnalisé pour la fête des pères',
      it: 'Libro personalizzato per bambini per la festa del papà',
    },
    description: {
      en: 'A story where your child goes on an epic adventure with their dad. The Father\'s Day gift that every dad secretly wishes for.',
      de: 'Eine Geschichte, in der dein Kind ein episches Abenteuer mit seinem Papa erlebt. Das Vatertagsgeschenk, das sich jeder Papa insgeheim wünscht.',
      fr: 'Une histoire où votre enfant vit une aventure épique avec son papa. Le cadeau de fête des pères dont chaque papa rêve secrètement.',
      it: 'Una storia in cui tuo figlio vive un\'avventura epica con il suo papà. Il regalo per la festa del papà che ogni papà desidera in segreto.',
    },
    intro: {
      en: 'Ties and tool kits are nice, but nothing compares to a story where your child goes on an adventure with dad as the co-hero. Mom and grandparents can help the child create this special surprise. Whether it\'s a pirate voyage, a space mission, or a dragon quest — dad will love seeing himself in the story alongside his little one. This is the kind of gift that dads actually keep forever.',
      de: 'Krawatten und Werkzeugkästen sind nett, aber nichts kommt an eine Geschichte heran, in der dein Kind ein Abenteuer mit Papa als Co-Held erlebt. Mama und Grosseltern können dem Kind helfen, diese besondere Überraschung zu erstellen. Ob Piratenreise, Weltraummission oder Drachen-Quest — Papa wird es lieben, sich selbst neben seinem Kleinen in der Geschichte zu sehen. Das ist die Art von Geschenk, die Papas wirklich für immer aufheben.',
      fr: 'Les cravates et les boîtes à outils c\'est bien, mais rien ne vaut une histoire où votre enfant vit une aventure avec papa comme co-héros. Maman et les grands-parents peuvent aider l\'enfant à créer cette surprise spéciale. Que ce soit un voyage de pirates, une mission spatiale ou une quête de dragons — papa adorera se voir dans l\'histoire aux côtés de son petit.',
      it: 'Cravatte e cassette degli attrezzi sono carine, ma niente si avvicina a una storia in cui tuo figlio vive un\'avventura con papà come co-eroe. Mamma e nonni possono aiutare il bambino a creare questa sorpresa speciale. Che sia un viaggio da pirati, una missione spaziale o una ricerca di draghi — papà adorerà vedersi nella storia accanto al suo piccolo. È il tipo di regalo che i papà conservano davvero per sempre.',
    },
    tips: {
      en: [
        'Mom or grandparents can help the child create it as a surprise',
        'Add dad as a character — he\'ll love being part of the adventure',
        'Pick an action theme: pirate, knight, space, or superhero',
        'The printed book makes a great desk keepsake for dad',
      ],
      de: [
        'Mama oder Grosseltern können dem Kind helfen, es als Überraschung zu erstellen',
        'Füge Papa als Charakter hinzu — er wird es lieben, Teil des Abenteuers zu sein',
        'Wähle ein Action-Thema: Pirat, Ritter, Weltraum oder Superheld',
        'Das gedruckte Buch ist ein tolles Andenken für Papas Schreibtisch',
      ],
      fr: [
        'Maman ou les grands-parents peuvent aider l\'enfant à le créer comme surprise',
        'Ajoutez papa comme personnage — il adorera faire partie de l\'aventure',
        'Choisissez un thème d\'action : pirate, chevalier, espace ou super-héros',
        'Le livre imprimé fait un super souvenir pour le bureau de papa',
      ],
      it: [
        'Mamma o i nonni possono aiutare il bambino a crearla come sorpresa',
        'Aggiungi papà come personaggio — adorerà far parte dell\'avventura',
        'Scegli un tema d\'azione: pirata, cavaliere, spazio o supereroe',
        'Il libro stampato è un ottimo ricordo per la scrivania di papà',
      ],
    },
    recommendedThemes: [
      { id: 'fathers-day', category: 'adventure' },
      { id: 'pirate', category: 'adventure' },
      { id: 'knight', category: 'adventure' },
      { id: 'space', category: 'adventure' },
      { id: 'superhero', category: 'adventure' },
      { id: 'dragon', category: 'adventure' },
      { id: 'cowboy', category: 'adventure' },
    ],
    deliveryNote: {
      en: 'Father\'s Day is the first Sunday in June (Switzerland). Order 1-2 weeks ahead for the printed book.',
      de: 'Vatertag ist der erste Sonntag im Juni (Schweiz). Bestelle 1-2 Wochen vorher für das gedruckte Buch.',
      fr: 'La fête des pères est le premier dimanche de juin (Suisse). Commandez 1 à 2 semaines à l\'avance.',
      it: 'La festa del papà cade la prima domenica di giugno (Svizzera). Ordina 1-2 settimane prima per il libro stampato.',
    },
    faq: [
      {
        q: { en: 'Can dad be a character in the story?', de: 'Kann Papa ein Charakter in der Geschichte sein?', fr: 'Papa peut-il être un personnage de l\'histoire ?', it: 'Papà può essere un personaggio della storia?' },
        a: { en: 'Absolutely! Add dad as a second character. He\'ll appear alongside your child as an adventure partner.', de: 'Auf jeden Fall! Füge Papa als zweiten Charakter hinzu. Er erscheint als Abenteuer-Partner neben deinem Kind.', fr: 'Absolument ! Ajoutez papa comme deuxième personnage. Il apparaîtra aux côtés de votre enfant comme partenaire d\'aventure.', it: 'Assolutamente sì! Aggiungi papà come secondo personaggio. Apparirà accanto a tuo figlio come compagno d\'avventura.' },
      },
      {
        q: { en: 'Is this just for young children?', de: 'Ist das nur für kleine Kinder?', fr: 'Est-ce seulement pour les petits enfants ?', it: 'È solo per bambini piccoli?' },
        a: { en: 'Not at all! The AI adapts the story complexity to the child\'s age. A 10-year-old will get a more sophisticated story than a 3-year-old.', de: 'Ganz und gar nicht! Die KI passt die Komplexität der Geschichte an das Alter des Kindes an. Ein 10-Jähriger bekommt eine anspruchsvollere Geschichte als ein 3-Jähriger.', fr: 'Pas du tout ! L\'IA adapte la complexité de l\'histoire à l\'âge de l\'enfant. Un enfant de 10 ans aura une histoire plus élaborée qu\'un enfant de 3 ans.', it: 'Assolutamente no! L\'IA adatta la complessità della storia all\'età del bambino. Un bambino di 10 anni riceverà una storia più elaborata rispetto a uno di 3 anni.' },
      },
    ],
  },

  // 9. St. Nicholas Day
  {
    id: 'nikolaus',
    emoji: '🎅',
    name: { en: 'St. Nicholas Day', de: 'Nikolaustag', fr: 'Saint-Nicolas', it: 'San Nicolao' },
    title: {
      en: 'Personalized Children\'s Book for St. Nicholas Day',
      de: 'Personalisiertes Kinderbuch zum Nikolaustag',
      fr: 'Livre personnalisé pour la Saint-Nicolas',
      it: 'Libro personalizzato per bambini per San Nicolao',
    },
    description: {
      en: 'A magical St. Nicholas story with your child at the center. Perfect for December 6 — a Swiss tradition brought to life.',
      de: 'Eine magische Nikolausgeschichte mit deinem Kind im Mittelpunkt. Perfekt für den 6. Dezember — eine Schweizer Tradition zum Leben erweckt.',
      fr: 'Une histoire magique de Saint-Nicolas avec votre enfant au centre. Parfait pour le 6 décembre — une tradition suisse qui prend vie.',
      it: 'Una magica storia di San Nicolao con tuo figlio al centro. Perfetta per il 6 dicembre — una tradizione svizzera che prende vita.',
    },
    intro: {
      en: 'St. Nicholas Day on December 6 is a beloved tradition in Switzerland. The Samichlaus visits children, accompanied by Schmutzli, bringing nuts, tangerines, and gifts for those who\'ve been good. A personalized story about this magical visit makes the tradition even more special. Your child meets St. Nicholas in their very own adventure — a beautiful keepsake that captures the wonder of this Swiss celebration.',
      de: 'Der Nikolaustag am 6. Dezember ist eine geliebte Tradition in der Schweiz. Der Samichlaus besucht die Kinder, begleitet vom Schmutzli, und bringt Nüsse, Mandarinen und Geschenke für die Braven. Eine personalisierte Geschichte über diesen magischen Besuch macht die Tradition noch besonderer. Dein Kind trifft den Samichlaus in seinem eigenen Abenteuer — ein schönes Andenken, das den Zauber dieser Schweizer Tradition einfängt.',
      fr: 'La Saint-Nicolas le 6 décembre est une tradition adorée en Suisse. Le Saint-Nicolas rend visite aux enfants, accompagné du Père Fouettard, apportant noix, mandarines et cadeaux. Une histoire personnalisée de cette visite magique rend la tradition encore plus spéciale. Votre enfant rencontre Saint-Nicolas dans sa propre aventure.',
      it: 'Il giorno di San Nicolao, il 6 dicembre, è una tradizione amatissima in Svizzera. Il Samichlaus visita i bambini, accompagnato da Schmutzli, portando noci, mandarini e regali per chi si è comportato bene. Una storia personalizzata su questa visita magica rende la tradizione ancora più speciale. Tuo figlio incontra San Nicolao nella sua propria avventura — un bellissimo ricordo che cattura la meraviglia di questa festa svizzera.',
    },
    tips: {
      en: [
        'Put the book alongside nuts and tangerines in the Nikolaus bag',
        'Choose the Christmas theme or a winter adventure',
        'Read the story on the evening of December 5 before the Samichlaus visits',
        'A perfect pre-Christmas gift that builds anticipation for the holidays',
      ],
      de: [
        'Lege das Buch neben Nüsse und Mandarinen in den Nikolaussack',
        'Wähle das Weihnachtsthema oder ein Winterabenteuer',
        'Lest die Geschichte am Abend des 5. Dezember, bevor der Samichlaus kommt',
        'Ein perfektes Vorweihnachtsgeschenk, das die Vorfreude auf die Feiertage steigert',
      ],
      fr: [
        'Mettez le livre à côté des noix et mandarines dans le sac de Saint-Nicolas',
        'Choisissez le thème Noël ou une aventure hivernale',
        'Lisez l\'histoire le soir du 5 décembre avant la visite de Saint-Nicolas',
        'Un cadeau pré-Noël parfait qui renforce l\'anticipation des fêtes',
      ],
      it: [
        'Metti il libro insieme a noci e mandarini nel sacco di San Nicolao',
        'Scegli il tema Natale o un\'avventura invernale',
        'Leggete la storia la sera del 5 dicembre prima della visita del Samichlaus',
        'Un regalo pre-natalizio perfetto che aumenta l\'attesa per le feste',
      ],
    },
    recommendedThemes: [
      { id: 'christmas', category: 'adventure' },
      { id: 'forest', category: 'adventure' },
      { id: 'wizard', category: 'adventure' },
      { id: 'knight', category: 'adventure' },
      { id: 'being-brave', category: 'life-challenges' },
    ],
    deliveryNote: {
      en: 'Order by November 28 for printed book delivery before December 6.',
      de: 'Bestelle bis 28. November für die Lieferung des gedruckten Buches vor dem 6. Dezember.',
      fr: 'Commandez avant le 28 novembre pour une livraison avant le 6 décembre.',
      it: 'Ordina entro il 28 novembre per la consegna del libro stampato prima del 6 dicembre.',
    },
    faq: [
      {
        q: { en: 'Is St. Nicholas the same as Santa?', de: 'Ist der Nikolaus dasselbe wie der Weihnachtsmann?', fr: 'Saint-Nicolas est-il le même que le Père Noël ?', it: 'San Nicolao è lo stesso di Babbo Natale?' },
        a: { en: 'In Swiss tradition, the Samichlaus (St. Nicholas) visits on December 6 and is distinct from the Christkind or Weihnachtsmann on December 24/25.', de: 'In der Schweizer Tradition besucht der Samichlaus die Kinder am 6. Dezember und ist verschieden vom Christkind oder Weihnachtsmann am 24./25. Dezember.', fr: 'Dans la tradition suisse, le Saint-Nicolas rend visite le 6 décembre et est distinct du Père Noël du 24/25 décembre.', it: 'Nella tradizione svizzera, il Samichlaus (San Nicolao) visita i bambini il 6 dicembre ed è una figura distinta da Gesù Bambino o Babbo Natale del 24/25 dicembre.' },
      },
      {
        q: { en: 'Can the story include Samichlaus and Schmutzli?', de: 'Kann die Geschichte Samichlaus und Schmutzli enthalten?', fr: 'L\'histoire peut-elle inclure Saint-Nicolas et le Père Fouettard ?', it: 'La storia può includere Samichlaus e Schmutzli?' },
        a: { en: 'The Christmas theme creates a wintery, magical story. You can add custom details to guide the AI toward a Samichlaus-themed adventure.', de: 'Das Weihnachtsthema erstellt eine winterliche, magische Geschichte. Du kannst individuelle Details hinzufügen, um die KI zu einem Samichlaus-Abenteuer zu lenken.', fr: 'Le thème Noël crée une histoire hivernale et magique. Vous pouvez ajouter des détails personnalisés pour orienter l\'IA vers une aventure Saint-Nicolas.', it: 'Il tema Natale crea una storia invernale e magica. Puoi aggiungere dettagli personalizzati per guidare l\'IA verso un\'avventura a tema Samichlaus.' },
      },
    ],
  },

  // 10. Advent
  {
    id: 'advent',
    emoji: '🕯️',
    name: { en: 'Advent', de: 'Advent', fr: 'Avent', it: 'Avvento' },
    title: {
      en: 'Personalized Children\'s Book for Advent',
      de: 'Personalisiertes Kinderbuch zum Advent',
      fr: 'Livre personnalisé pour l\'Avent',
      it: 'Libro personalizzato per bambini per l\'Avvento',
    },
    description: {
      en: 'Make the Advent season extra special with a personalized story. A wonderful addition to any Advent calendar or a standalone December gift.',
      de: 'Mache die Adventszeit extra besonders mit einer personalisierten Geschichte. Eine wunderbare Ergänzung zum Adventskalender oder ein eigenständiges Dezember-Geschenk.',
      fr: 'Rendez la période de l\'Avent encore plus spéciale avec une histoire personnalisée. Un merveilleux complément au calendrier de l\'Avent.',
      it: 'Rendi il periodo dell\'Avvento ancora più speciale con una storia personalizzata. Un\'aggiunta meravigliosa a qualsiasi calendario dell\'Avvento o un regalo di dicembre a sé stante.',
    },
    intro: {
      en: 'The Advent season is all about anticipation, cozy evenings, and the magic of counting down to Christmas. A personalized story book is a perfect companion for this special time. Use it as the highlight gift in a DIY Advent calendar, or read one chapter each evening in the weeks before Christmas. It turns December into a month of storytelling magic for your family.',
      de: 'Die Adventszeit dreht sich um Vorfreude, gemütliche Abende und den Zauber des Countdowns bis Weihnachten. Ein personalisiertes Geschichtenbuch ist der perfekte Begleiter für diese besondere Zeit. Nutze es als Highlight-Geschenk im DIY-Adventskalender oder lest jeden Abend ein Kapitel in den Wochen vor Weihnachten. So wird der Dezember zu einem Monat voller Geschichten-Magie für die ganze Familie.',
      fr: 'La période de l\'Avent est synonyme d\'anticipation, de soirées cosy et de la magie du compte à rebours jusqu\'à Noël. Un livre personnalisé est le compagnon parfait pour cette période spéciale. Utilisez-le comme cadeau phare dans un calendrier de l\'Avent fait maison ou lisez un chapitre chaque soir.',
      it: 'Il periodo dell\'Avvento è fatto di attesa, serate accoglienti e la magia del conto alla rovescia verso Natale. Un libro di storie personalizzato è il compagno perfetto per questo momento speciale. Usalo come regalo clou in un calendario dell\'Avvento fai-da-te, oppure leggete un capitolo ogni sera nelle settimane prima di Natale. Trasforma dicembre in un mese di magia narrativa per tutta la famiglia.',
    },
    tips: {
      en: [
        'Use the book as a special door in a DIY Advent calendar (e.g., door 24)',
        'Read one page each evening during Advent for a nightly ritual',
        'Combine with a Christmas theme for maximum festive spirit',
        'Perfect as an early December gift to kick off the holiday season',
      ],
      de: [
        'Nutze das Buch als besonderes Türchen im DIY-Adventskalender (z.B. Türchen 24)',
        'Lest jeden Abend im Advent eine Seite als abendliches Ritual',
        'Kombiniere mit einem Weihnachtsthema für maximale Festtagsstimmung',
        'Perfekt als frühes Dezember-Geschenk zum Einstieg in die Weihnachtszeit',
      ],
      fr: [
        'Utilisez le livre comme case spéciale d\'un calendrier de l\'Avent fait maison (ex. case 24)',
        'Lisez une page chaque soir pendant l\'Avent comme rituel du soir',
        'Combinez avec un thème de Noël pour un esprit festif maximum',
        'Parfait comme cadeau de début décembre pour lancer la saison des fêtes',
      ],
      it: [
        'Usa il libro come casella speciale in un calendario dell\'Avvento fai-da-te (es. casella 24)',
        'Leggete una pagina ogni sera durante l\'Avvento come rituale serale',
        'Abbinalo al tema Natale per il massimo spirito festivo',
        'Perfetto come regalo di inizio dicembre per dare il via alla stagione delle feste',
      ],
    },
    recommendedThemes: [
      { id: 'christmas', category: 'adventure' },
      { id: 'forest', category: 'adventure' },
      { id: 'wizard', category: 'adventure' },
      { id: 'seasons', category: 'educational' },
      { id: 'going-to-bed', category: 'life-challenges' },
    ],
    deliveryNote: {
      en: 'Order by November 25 to receive the printed book before Advent starts (December 1).',
      de: 'Bestelle bis 25. November, um das gedruckte Buch vor Adventsbeginn (1. Dezember) zu erhalten.',
      fr: 'Commandez avant le 25 novembre pour recevoir le livre imprimé avant le début de l\'Avent (1er décembre).',
      it: 'Ordina entro il 25 novembre per ricevere il libro stampato prima dell\'inizio dell\'Avvento (1° dicembre).',
    },
    faq: [
      {
        q: { en: 'How many pages does the story have?', de: 'Wie viele Seiten hat die Geschichte?', fr: 'Combien de pages compte l\'histoire ?', it: 'Quante pagine ha la storia?' },
        a: { en: 'Stories typically have 10-16 illustrated pages — perfect for reading one page per Advent evening.', de: 'Geschichten haben typischerweise 10-16 illustrierte Seiten — perfekt, um jeden Adventabend eine Seite zu lesen.', fr: 'Les histoires comptent généralement 10 à 16 pages illustrées — parfait pour lire une page chaque soir de l\'Avent.', it: 'Le storie hanno tipicamente 10-16 pagine illustrate — perfette per leggerne una ogni sera d\'Avvento.' },
      },
      {
        q: { en: 'Can I use this in an Advent calendar?', de: 'Kann ich das in einem Adventskalender verwenden?', fr: 'Puis-je l\'utiliser dans un calendrier de l\'Avent ?', it: 'Posso usarlo in un calendario dell\'Avvento?' },
        a: { en: 'Yes! The printed book fits perfectly as the special gift behind the last (or first) door of a DIY Advent calendar.', de: 'Ja! Das gedruckte Buch passt perfekt als besonderes Geschenk hinter dem letzten (oder ersten) Türchen eines DIY-Adventskalenders.', fr: 'Oui ! Le livre imprimé s\'intègre parfaitement comme cadeau spécial derrière la dernière (ou première) porte d\'un calendrier de l\'Avent fait maison.', it: 'Sì! Il libro stampato si adatta perfettamente come regalo speciale dietro l\'ultima (o la prima) casella di un calendario dell\'Avvento fai-da-te.' },
      },
    ],
  },

  // 11. Moving House
  {
    id: 'umzug',
    emoji: '🏠',
    name: { en: 'Moving House', de: 'Umzug', fr: 'Déménagement', it: 'Trasloco' },
    title: {
      en: 'Personalized Children\'s Book for Moving House',
      de: 'Personalisiertes Kinderbuch zum Umzug',
      fr: 'Livre personnalisé pour un déménagement',
      it: 'Libro personalizzato per bambini per il trasloco',
    },
    description: {
      en: 'Help your child feel excited (not scared) about moving to a new home with a story that turns the big change into an adventure.',
      de: 'Hilf deinem Kind, sich auf das neue Zuhause zu freuen (statt Angst zu haben) — mit einer Geschichte, die die grosse Veränderung in ein Abenteuer verwandelt.',
      fr: 'Aidez votre enfant à se sentir enthousiaste (et non effrayé) par le déménagement avec une histoire qui transforme ce grand changement en aventure.',
      it: 'Aiuta tuo figlio a sentirsi entusiasta (e non spaventato) per il trasloco in una nuova casa con una storia che trasforma il grande cambiamento in un\'avventura.',
    },
    intro: {
      en: 'Moving to a new home can be overwhelming for children. They leave behind their familiar room, neighborhood, and sometimes friends. A personalized story helps them see the move as the beginning of an exciting new chapter. In the story, they bravely explore their new home and neighborhood, make new friends, and discover that change can be wonderful. It\'s a gentle, effective way to process big emotions.',
      de: 'Ein Umzug kann für Kinder überwältigend sein. Sie lassen ihr vertrautes Zimmer, ihre Nachbarschaft und manchmal Freunde zurück. Eine personalisierte Geschichte hilft ihnen, den Umzug als Beginn eines aufregenden neuen Kapitels zu sehen. In der Geschichte erkunden sie mutig ihr neues Zuhause und die Nachbarschaft, finden neue Freunde und entdecken, dass Veränderung wunderbar sein kann. Es ist ein sanfter, wirksamer Weg, grosse Gefühle zu verarbeiten.',
      fr: 'Déménager peut être bouleversant pour les enfants. Ils quittent leur chambre familière, leur quartier et parfois leurs amis. Une histoire personnalisée les aide à voir le déménagement comme le début d\'un nouveau chapitre passionnant. Dans l\'histoire, ils explorent courageusement leur nouveau chez-eux et découvrent que le changement peut être merveilleux.',
      it: 'Traslocare in una nuova casa può essere travolgente per i bambini. Lasciano dietro di sé la loro cameretta familiare, il quartiere e a volte gli amici. Una storia personalizzata li aiuta a vedere il trasloco come l\'inizio di un nuovo entusiasmante capitolo. Nella storia, esplorano coraggiosamente la loro nuova casa e il nuovo quartiere, fanno nuove amicizie e scoprono che il cambiamento può essere meraviglioso. È un modo delicato ed efficace per elaborare grandi emozioni.',
    },
    tips: {
      en: [
        'Create the story before the move to help with the transition',
        'Choose the "Moving House" life skills theme for a story that directly addresses moving fears',
        'Read it together in the new home on the first night — a comforting ritual',
        'Include details about the new home or city to build excitement',
      ],
      de: [
        'Erstelle die Geschichte vor dem Umzug, um beim Übergang zu helfen',
        'Wähle das Thema "Umzug" für eine Geschichte, die direkt Umzugsängste anspricht',
        'Lest es zusammen im neuen Zuhause in der ersten Nacht — ein tröstendes Ritual',
        'Füge Details über das neue Zuhause oder die neue Stadt hinzu, um Vorfreude zu wecken',
      ],
      fr: [
        'Créez l\'histoire avant le déménagement pour faciliter la transition',
        'Choisissez le thème "Déménagement" pour une histoire qui aborde les peurs du déménagement',
        'Lisez-la ensemble dans la nouvelle maison la première nuit — un rituel réconfortant',
        'Incluez des détails sur le nouveau chez-vous pour créer de l\'enthousiasme',
      ],
      it: [
        'Crea la storia prima del trasloco per facilitare la transizione',
        'Scegli il tema di vita quotidiana "Trasloco" per una storia che affronta direttamente le paure del cambiamento',
        'Leggetela insieme nella nuova casa la prima notte — un rituale confortante',
        'Includi dettagli sulla nuova casa o città per creare entusiasmo',
      ],
    },
    recommendedThemes: [
      { id: 'moving-house', category: 'life-challenges' },
      { id: 'making-friends', category: 'life-challenges' },
      { id: 'being-brave', category: 'life-challenges' },
      { id: 'managing-emotions', category: 'life-challenges' },
      { id: 'detective', category: 'adventure' },
    ],
    deliveryNote: {
      en: 'Order 1-2 weeks before the move so you can read it in the new home on the first night.',
      de: 'Bestelle 1-2 Wochen vor dem Umzug, damit ihr es in der ersten Nacht im neuen Zuhause lesen könnt.',
      fr: 'Commandez 1 à 2 semaines avant le déménagement pour le lire dans la nouvelle maison la première nuit.',
      it: 'Ordina 1-2 settimane prima del trasloco per poterlo leggere nella nuova casa la prima notte.',
    },
    faq: [
      {
        q: { en: 'How does this help with the move?', de: 'Wie hilft das beim Umzug?', fr: 'Comment cela aide-t-il avec le déménagement ?', it: 'In che modo questo aiuta con il trasloco?' },
        a: { en: 'Children process big changes through stories. Seeing themselves bravely navigating a move in a story builds confidence and reduces anxiety about the real thing.', de: 'Kinder verarbeiten grosse Veränderungen durch Geschichten. Wenn sie sich selbst mutig einen Umzug in einer Geschichte meistern sehen, stärkt das ihr Selbstvertrauen und reduziert Ängste.', fr: 'Les enfants traitent les grands changements à travers les histoires. Se voir naviguer courageusement un déménagement dans une histoire renforce la confiance et réduit l\'anxiété.', it: 'I bambini elaborano i grandi cambiamenti attraverso le storie. Vedersi affrontare coraggiosamente un trasloco in una storia rafforza la fiducia e riduce l\'ansia per la situazione reale.' },
      },
      {
        q: { en: 'Should I create the story before or after moving?', de: 'Soll ich die Geschichte vor oder nach dem Umzug erstellen?', fr: 'Dois-je créer l\'histoire avant ou après le déménagement ?', it: 'Devo creare la storia prima o dopo il trasloco?' },
        a: { en: 'Before is best — it helps prepare your child for the change. But it\'s also valuable after the move to help them settle in.', de: 'Vorher ist am besten — es hilft deinem Kind, sich auf die Veränderung vorzubereiten. Aber auch nach dem Umzug kann es helfen, sich einzuleben.', fr: 'Avant, c\'est le mieux — cela aide à préparer votre enfant au changement. Mais c\'est aussi utile après le déménagement.', it: 'Prima è la scelta migliore — aiuta a preparare tuo figlio al cambiamento. Ma è utile anche dopo il trasloco, per aiutarlo ad ambientarsi.' },
      },
    ],
  },

  // 12. Starting Kindergarten
  {
    id: 'kindergartenstart',
    emoji: '🧒',
    name: { en: 'Starting Kindergarten', de: 'Kindergartenstart', fr: 'Entrée en maternelle', it: 'Inizio della scuola dell\'infanzia' },
    title: {
      en: 'Personalized Children\'s Book for Starting Kindergarten',
      de: 'Personalisiertes Kinderbuch zum Kindergartenstart',
      fr: 'Livre personnalisé pour l\'entrée en maternelle',
      it: 'Libro personalizzato per bambini per l\'inizio della scuola dell\'infanzia',
    },
    description: {
      en: 'Prepare your child for their first day at kindergarten with a story that makes this big step feel like an exciting adventure.',
      de: 'Bereite dein Kind auf seinen ersten Kindergartentag vor — mit einer Geschichte, die diesen grossen Schritt zu einem aufregenden Abenteuer macht.',
      fr: 'Préparez votre enfant pour son premier jour de maternelle avec une histoire qui transforme cette grande étape en aventure passionnante.',
      it: 'Prepara tuo figlio al suo primo giorno alla scuola dell\'infanzia con una storia che trasforma questo grande passo in un\'avventura entusiasmante.',
    },
    intro: {
      en: 'Starting kindergarten is one of the first big adventures outside the family nest. It\'s normal for children to feel a mix of excitement and nervousness. A personalized story shows your child that kindergarten is a place full of fun, new friends, and exciting discoveries. They\'ll see themselves as the brave little hero who walks through the kindergarten door and has the best day ever. Reading it together in the weeks before builds confidence and positive anticipation.',
      de: 'Der Kindergartenstart ist eines der ersten grossen Abenteuer ausserhalb des Familiennests. Es ist ganz normal, dass Kinder eine Mischung aus Aufregung und Nervosität fühlen. Eine personalisierte Geschichte zeigt deinem Kind, dass der Kindergarten ein Ort voller Spass, neuer Freunde und aufregender Entdeckungen ist. Es sieht sich selbst als kleinen mutigen Helden, der durch die Kindergartentür geht und den besten Tag aller Zeiten erlebt. Gemeinsames Vorlesen in den Wochen davor stärkt das Selbstvertrauen und die Vorfreude.',
      fr: 'L\'entrée en maternelle est l\'une des premières grandes aventures hors du nid familial. Il est normal que les enfants ressentent un mélange d\'excitation et de nervosité. Une histoire personnalisée montre à votre enfant que la maternelle est un endroit plein de plaisir, de nouveaux amis et de découvertes passionnantes. La lire ensemble dans les semaines précédentes renforce la confiance.',
      it: 'L\'inizio della scuola dell\'infanzia è una delle prime grandi avventure fuori dal nido familiare. È normale che i bambini provino un misto di eccitazione e nervosismo. Una storia personalizzata mostra a tuo figlio che la scuola dell\'infanzia è un luogo pieno di divertimento, nuovi amici e scoperte entusiasmanti. Si vedrà come il piccolo eroe coraggioso che varca la porta della scuola dell\'infanzia e vive la giornata più bella di sempre. Leggerla insieme nelle settimane precedenti rafforza la fiducia e l\'attesa positiva.',
    },
    tips: {
      en: [
        'Start reading the story 2-3 weeks before kindergarten begins',
        'Choose the "First Kindergarten Day" theme for a story that addresses separation anxiety',
        'Talk about the story together — ask your child what they\'re excited about',
        'The "Making Friends" theme is also perfect for kindergarten preparation',
      ],
      de: [
        'Beginne 2-3 Wochen vor Kindergartenbeginn mit dem Vorlesen der Geschichte',
        'Wähle das Thema "Erster Kindergartentag" für eine Geschichte über Trennungsangst',
        'Sprecht gemeinsam über die Geschichte — frag dein Kind, worauf es sich freut',
        'Das Thema "Freunde finden" ist ebenfalls perfekt zur Kindergartenvorbereitung',
      ],
      fr: [
        'Commencez à lire l\'histoire 2 à 3 semaines avant le début de la maternelle',
        'Choisissez le thème "Premier jour de maternelle" pour aborder l\'anxiété de séparation',
        'Parlez de l\'histoire ensemble — demandez à votre enfant ce qui l\'enthousiasme',
        'Le thème "Se faire des amis" est aussi parfait pour préparer la maternelle',
      ],
      it: [
        'Inizia a leggere la storia 2-3 settimane prima dell\'inizio della scuola dell\'infanzia',
        'Scegli il tema "Primo giorno alla scuola dell\'infanzia" per una storia che affronta l\'ansia da separazione',
        'Parlate insieme della storia — chiedi a tuo figlio cosa lo entusiasma di più',
        'Anche il tema "Fare amicizia" è perfetto per prepararsi alla scuola dell\'infanzia',
      ],
    },
    recommendedThemes: [
      { id: 'first-kindergarten', category: 'life-challenges' },
      { id: 'making-friends', category: 'life-challenges' },
      { id: 'saying-goodbye', category: 'life-challenges' },
      { id: 'being-brave', category: 'life-challenges' },
      { id: 'colors-basic', category: 'educational' },
      { id: 'shapes', category: 'educational' },
    ],
    deliveryNote: {
      en: 'Order 2-3 weeks before kindergarten starts so you have time to read it together multiple times.',
      de: 'Bestelle 2-3 Wochen vor Kindergartenbeginn, damit ihr Zeit habt, die Geschichte mehrmals zusammen zu lesen.',
      fr: 'Commandez 2 à 3 semaines avant le début de la maternelle pour avoir le temps de la lire ensemble plusieurs fois.',
      it: 'Ordina 2-3 settimane prima dell\'inizio della scuola dell\'infanzia per avere tempo di leggerla insieme più volte.',
    },
    faq: [
      {
        q: { en: 'At what age do children start kindergarten in Switzerland?', de: 'In welchem Alter kommen Kinder in der Schweiz in den Kindergarten?', fr: 'À quel âge les enfants commencent-ils la maternelle en Suisse ?', it: 'A che età i bambini iniziano la scuola dell\'infanzia in Svizzera?' },
        a: { en: 'In most Swiss cantons, kindergarten starts at age 4 (turning 4 by July 31). Our stories are designed to be perfect for this age group.', de: 'In den meisten Schweizer Kantonen beginnt der Kindergarten mit 4 Jahren (Stichtag 31. Juli). Unsere Geschichten sind perfekt für diese Altersgruppe konzipiert.', fr: 'Dans la plupart des cantons suisses, la maternelle commence à 4 ans (anniversaire avant le 31 juillet). Nos histoires sont parfaitement adaptées à ce groupe d\'âge.', it: 'Nella maggior parte dei cantoni svizzeri, la scuola dell\'infanzia inizia a 4 anni (compiuti entro il 31 luglio). Le nostre storie sono pensate proprio per questa fascia d\'età.' },
      },
      {
        q: { en: 'Does the story help with separation anxiety?', de: 'Hilft die Geschichte bei Trennungsangst?', fr: 'L\'histoire aide-t-elle avec l\'anxiété de séparation ?', it: 'La storia aiuta con l\'ansia da separazione?' },
        a: { en: 'Yes! The "First Kindergarten Day" theme is specifically designed to show that saying goodbye to mom/dad is okay and that kindergarten is safe and fun.', de: 'Ja! Das Thema "Erster Kindergartentag" zeigt speziell, dass es okay ist, sich von Mama/Papa zu verabschieden und dass der Kindergarten sicher und lustig ist.', fr: 'Oui ! Le thème "Premier jour de maternelle" est spécialement conçu pour montrer que dire au revoir à maman/papa est normal et que la maternelle est sûre et amusante.', it: 'Sì! Il tema "Primo giorno alla scuola dell\'infanzia" è pensato apposta per mostrare che salutare mamma/papà va bene e che la scuola dell\'infanzia è un posto sicuro e divertente.' },
      },
      {
        q: { en: 'Can I customize the kindergarten name in the story?', de: 'Kann ich den Kindergarten-Namen in der Geschichte anpassen?', fr: 'Puis-je personnaliser le nom de la maternelle dans l\'histoire ?', it: 'Posso personalizzare il nome della scuola dell\'infanzia nella storia?' },
        a: { en: 'You can add custom details like the kindergarten name or teacher\'s name to make the story even more personal and recognizable for your child.', de: 'Du kannst individuelle Details wie den Kindergarten-Namen oder den Namen der Lehrperson hinzufügen, damit die Geschichte für dein Kind noch persönlicher und wiedererkennbarer wird.', fr: 'Vous pouvez ajouter des détails personnalisés comme le nom de la maternelle ou de l\'enseignant pour rendre l\'histoire encore plus personnelle.', it: 'Puoi aggiungere dettagli personalizzati come il nome della scuola dell\'infanzia o dell\'insegnante, per rendere la storia ancora più personale e riconoscibile per tuo figlio.' },
      },
    ],
  },
];
