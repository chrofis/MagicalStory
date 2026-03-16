// One-time generator: creates client/src/constants/themeContent.ts
// Run: node scripts/gen-theme-content.js
const fs = require('fs');
const path = require('path');
const J = JSON.stringify;

const t = {}; // theme content accumulator

// Helper to build a theme entry
function add(id, age, skills, longDesc, faq) {
  t[id] = { age, skills, longDesc, faq };
}

// ═══════════════════════════════════════════════════════════════════════════════
// ADVENTURE THEMES (29)
// ═══════════════════════════════════════════════════════════════════════════════

add('pirate', '3-8',
  { en: 'Navigation and map reading, teamwork and leadership, creative problem-solving, courage and perseverance.', de: 'Navigation und Kartenlesen, Teamarbeit und Führung, kreative Problemlösung, Mut und Ausdauer.', fr: 'Navigation et lecture de cartes, travail d\'équipe et leadership, résolution créative de problèmes, courage et persévérance.' },
  {
    en: 'Ahoy, young adventurer! In this personalized pirate story, your child takes command of their very own ship and sets sail across sparkling turquoise waters in search of legendary buried treasure. From the moment the anchor is raised, your little captain must read tattered treasure maps, navigate past rocky islands, and outsmart rival pirates who want the gold for themselves.\n\nAlong the way, they meet a loyal parrot companion, discover hidden coves full of mystery, and learn that the greatest treasure of all is the courage to follow your dreams. Every page is illustrated with your child as the swashbuckling hero, sword at the ready and a brave grin on their face. The story weaves in themes of teamwork, problem-solving, and fair play — because even pirates have a code of honor.\n\nWhether your child dreams of walking the plank (just for fun!), firing pretend cannons, or steering through a midnight storm, this adventure delivers thrills on every page. The personalized illustrations make the experience truly magical: your child will see themselves wearing a captain\'s hat, standing at the helm, and ultimately holding the treasure chest high.\n\nPerfect for children aged 3 to 8 who love the ocean, adventure, and a bit of mischief. This is more than a bedtime story — it is a keepsake adventure that your child will want to read again and again. Parents love how the pirate theme sparks imaginative play long after the last page is turned, with kids building blanket forts as ships and hunting for treasure in the garden.',
    de: 'Ahoi, kleiner Abenteurer! In dieser personalisierten Piratengeschichte übernimmt dein Kind das Kommando über sein eigenes Schiff und segelt über glitzernde, türkisfarbene Gewässer auf der Suche nach einem legendären Schatz. Vom ersten Moment an, wenn der Anker gelichtet wird, muss dein kleiner Kapitän zerfledderte Schatzkarten lesen, an felsigen Inseln vorbeinavigieren und rivalisierende Piraten überlisten, die das Gold für sich beanspruchen wollen.\n\nUnterwegs trifft dein Kind auf einen treuen Papageien-Begleiter, entdeckt versteckte Buchten voller Geheimnisse und lernt, dass der grösste Schatz von allen der Mut ist, seinen Träumen zu folgen. Jede Seite ist illustriert mit deinem Kind als verwegener Held — den Säbel gezückt und ein mutiges Grinsen im Gesicht. Die Geschichte verwebt Themen wie Teamarbeit, Problemlösung und Fairness, denn auch Piraten haben einen Ehrenkodex.\n\nOb dein Kind davon träumt, über die Planke zu spazieren (natürlich nur zum Spass!), Scheinkanonen abzufeuern oder durch einen Mitternachtssturm zu steuern — dieses Abenteuer liefert Spannung auf jeder Seite. Die personalisierten Illustrationen machen das Erlebnis wirklich magisch: Dein Kind sieht sich selbst mit Kapitänsmütze am Steuer stehen und am Ende die Schatztruhe triumphierend in die Höhe halten.\n\nPerfekt für Kinder von 3 bis 8 Jahren, die das Meer, Abenteuer und ein bisschen Unfug lieben. Das ist mehr als eine Gutenachtgeschichte — es ist ein Abenteuer zum Aufbewahren, das dein Kind immer wieder lesen möchte. Eltern lieben es, wie das Piratenthema die Fantasie anregt: Nach dem Lesen werden Deckenburgen zu Schiffen und der Garten zum Schauplatz einer Schatzsuche.',
    fr: 'Ohé, petit aventurier ! Dans cette histoire de pirates personnalisée, votre enfant prend le commandement de son propre navire et met les voiles sur des eaux turquoise étincelantes à la recherche d\'un trésor légendaire. Dès que l\'ancre est levée, votre petit capitaine doit déchiffrer des cartes au trésor usées, naviguer entre des îles rocheuses et déjouer les plans de pirates rivaux qui veulent l\'or pour eux-mêmes.\n\nEn chemin, il rencontre un fidèle perroquet, découvre des criques cachées pleines de mystères et apprend que le plus grand trésor est le courage de poursuivre ses rêves. Chaque page est illustrée avec votre enfant en héros intrépide, sabre à la main et sourire courageux aux lèvres. L\'histoire intègre des thèmes de travail d\'équipe, de résolution de problèmes et de fair-play — car même les pirates ont un code d\'honneur.\n\nQue votre enfant rêve de marcher sur la planche (juste pour s\'amuser !), de tirer au canon ou de naviguer dans une tempête nocturne, cette aventure offre des frissons à chaque page. Les illustrations personnalisées rendent l\'expérience vraiment magique : votre enfant se voit porter le chapeau de capitaine, tenir la barre et brandir le coffre au trésor.\n\nParfait pour les enfants de 3 à 8 ans qui aiment l\'océan, l\'aventure et une pointe d\'espièglerie. C\'est plus qu\'une histoire du soir — c\'est un souvenir précieux que votre enfant voudra relire encore et encore. Les parents adorent voir comment le thème pirate stimule le jeu imaginatif bien après la dernière page.',
  },
  [
    { q: { en: 'Is the pirate story scary for young children?', de: 'Ist die Piratengeschichte für kleine Kinder gruselig?', fr: 'L\'histoire de pirates est-elle effrayante pour les jeunes enfants ?' }, a: { en: 'Not at all! The pirate adventure is exciting but always age-appropriate. There are no violent scenes — the "battles" are clever tricks and outwitting. The rival pirates are more silly than scary.', de: 'Überhaupt nicht! Das Piratenabenteuer ist aufregend, aber immer altersgerecht. Es gibt keine gewalttätigen Szenen — die „Kämpfe" bestehen aus cleveren Tricks. Die rivalisierenden Piraten sind eher lustig als bedrohlich.', fr: 'Pas du tout ! L\'aventure pirate est palpitante mais toujours adaptée à l\'âge. Les « batailles » sont des ruses, pas des combats.' } },
    { q: { en: 'What age is the pirate story best for?', de: 'Für welches Alter eignet sich die Piratengeschichte?', fr: 'Pour quel âge l\'histoire de pirates est-elle adaptée ?' }, a: { en: 'It works great for ages 3 to 8. Younger children love the illustrations and treasure hunt, while older children enjoy the puzzle-solving.', de: 'Sie eignet sich hervorragend für 3 bis 8 Jahre. Jüngere lieben die Illustrationen, ältere das Rätselknacken.', fr: 'Elle convient parfaitement aux enfants de 3 à 8 ans. Les plus jeunes adorent les illustrations, les plus grands les énigmes.' } },
  ]
);

add('knight', '3-8',
  { en: 'Chivalry and honor, empathy and helping others, puzzle-solving, courage without aggression.', de: 'Ritterlichkeit und Ehre, Empathie und Hilfsbereitschaft, Rätselknacken, Mut ohne Aggression.', fr: 'Chevalerie et honneur, empathie et entraide, résolution d\'énigmes, courage sans agressivité.' },
  {
    en: 'In this personalized knight adventure, your child is summoned to the royal castle to receive a noble quest. Dressed in shining armor with a shield bearing their own crest, your little knight rides across rolling green hills, through enchanted forests, and over drawbridges to protect the kingdom from harm.\n\nAlong the way, they face riddles from a wise old owl, help villagers in need, and prove their bravery not through fighting but through kindness, cleverness, and honor. The story culminates in a grand celebration at the castle, where the king and queen thank your child for their courage.\n\nEvery illustration features your child as the hero in full medieval splendor — riding a noble steed, raising a banner, and standing tall before the cheering crowd. The knight theme teaches children about chivalry, helping others, and the idea that true strength comes from the heart.\n\nIt is especially popular with children who love castles, dragons (who appear as friendly allies!), and the romance of a bygone era. The language is rich and atmospheric, transporting your child to a world of turrets and torches, yet always age-appropriate and warm. Parents appreciate how the story encourages bravery without aggression, and children adore seeing themselves as the hero who saves the day.',
    de: 'In diesem personalisierten Ritterabenteuer wird dein Kind zur königlichen Burg gerufen, um einen edlen Auftrag zu empfangen. In strahlender Rüstung mit einem Schild, das das eigene Wappen trägt, reitet dein kleiner Ritter über sanfte grüne Hügel, durch verwunschene Wälder und über Zugbrücken, um das Königreich vor Unheil zu schützen.\n\nUnterwegs stellt sich dein Kind den Rätseln einer weisen alten Eule, hilft Dorfbewohnern in Not und beweist seinen Mut nicht durch Kämpfen, sondern durch Freundlichkeit, Cleverness und Ehre. Die Geschichte gipfelt in einem grossen Fest auf der Burg, bei dem König und Königin deinem Kind für seinen Mut danken.\n\nJede Illustration zeigt dein Kind als Held in voller mittelalterlicher Pracht — auf einem edlen Ross reitend, ein Banner schwenkend und stolz vor der jubelnden Menge stehend. Das Ritterthema vermittelt Kindern Werte wie Ritterlichkeit, Hilfsbereitschaft und die Idee, dass wahre Stärke aus dem Herzen kommt.\n\nEs ist besonders beliebt bei Kindern, die Burgen, Drachen (die als freundliche Verbündete auftreten!) und die Romantik vergangener Zeiten lieben. Eltern schätzen, dass die Geschichte Mut fördert, ohne Aggression zu zeigen, und Kinder lieben es, sich selbst als den Helden zu sehen, der den Tag rettet.',
    fr: 'Dans cette aventure de chevalier personnalisée, votre enfant est convoqué au château royal pour recevoir une noble quête. Vêtu d\'une armure étincelante portant son propre blason, votre petit chevalier chevauche à travers des collines verdoyantes, des forêts enchantées et des ponts-levis pour protéger le royaume.\n\nEn chemin, il résout les énigmes d\'un vieux hibou sage, aide des villageois en détresse et prouve sa bravoure par la gentillesse et l\'honneur. L\'histoire culmine lors d\'une grande célébration au château.\n\nChaque illustration met en scène votre enfant en héros médiéval. Le thème du chevalier enseigne la chevalerie, l\'entraide et l\'idée que la vraie force vient du coeur. Il est particulièrement apprécié des enfants qui aiment les châteaux et les dragons (qui apparaissent comme des alliés !). Un merveilleux cadeau d\'anniversaire qui renforce la confiance en soi.',
  },
  [
    { q: { en: 'Is the knight story only for boys?', de: 'Ist die Rittergeschichte nur für Jungen?', fr: 'L\'histoire de chevalier est-elle réservée aux garçons ?' }, a: { en: 'Absolutely not! The story focuses on bravery and honor rather than gender roles. Many parents choose it for daughters who love castles.', de: 'Auf keinen Fall! Die Geschichte fokussiert auf Mut und Ehre. Viele Eltern wählen sie für Töchter, die Burgen lieben.', fr: 'Absolument pas ! L\'histoire met l\'accent sur le courage et l\'honneur plutôt que sur les rôles de genre.' } },
    { q: { en: 'Does the knight story contain violence?', de: 'Enthält die Rittergeschichte Gewalt?', fr: 'L\'histoire contient-elle de la violence ?' }, a: { en: 'No. Challenges are solved through cleverness and kindness — never through fighting.', de: 'Nein. Herausforderungen werden durch Cleverness und Freundlichkeit gelöst — nie durch Kampf.', fr: 'Non. Les défis sont résolus par l\'intelligence et la gentillesse — jamais par la violence.' } },
  ]
);

// For remaining adventure themes, use a compact builder
function addAdventure(id, age, skillsEn, skillsDe, skillsFr, longEn, longDe, longFr, faqArr) {
  add(id, age, {en:skillsEn, de:skillsDe, fr:skillsFr}, {en:longEn, de:longDe, fr:longFr}, faqArr);
}

addAdventure('cowboy', '3-8',
  'Independence, animal care, mystery-solving, community spirit.',
  'Eigenständigkeit, Tierpflege, Rätsel lösen, Gemeinschaftssinn.',
  'Indépendance, soin des animaux, résolution de mystères, esprit communautaire.',
  'Saddle up for a Wild West adventure! In this personalized cowboy story, your child rides through dusty canyons, across wide-open prairies, and into a frontier town that needs a hero. With a trusty horse by their side, your little wrangler follows mysterious tracks, helps a lost calf find its way home, and uncovers a secret that brings the whole town together.\n\nThe story captures the spirit of the American frontier — wide skies, campfire stories, and the freedom of the open range — while keeping everything warm and age-appropriate. Along the way, your child learns about friendship, responsibility, and standing up for what is right.\n\nThe personalized illustrations show your child in full cowboy gear, lassoing, riding, and tipping their hat to grateful townspeople. This theme is perfect for children who love horses, the outdoors, and exploration. Parents appreciate how it encourages independence and resourcefulness while celebrating kindness and community. Whether read at bedtime or on a Sunday afternoon, this Wild West adventure sparks imagination and fills little hearts with the thrill of the frontier.',
  'Auf in den Wilden Westen! In dieser personalisierten Cowboy-Geschichte reitet dein Kind durch staubige Schluchten, weite Prärien und in eine Grenzstadt, die einen Helden braucht. Mit einem treuen Pferd an der Seite folgt dein kleiner Wrangler geheimnisvollen Spuren, hilft einem verirrten Kalb nach Hause und lüftet ein Geheimnis, das die ganze Stadt zusammenbringt.\n\nDie Geschichte fängt den Geist der amerikanischen Frontier ein — weite Himmel, Lagerfeuergeschichten und die Freiheit der offenen Weite — und bleibt dabei warmherzig und altersgerecht. Unterwegs lernt dein Kind über Freundschaft, Verantwortung und wie wichtig es ist, für das Richtige einzustehen.\n\nDie personalisierten Illustrationen zeigen dein Kind in voller Cowboy-Ausrüstung. Perfekt für Kinder, die Pferde, die Natur und Abenteuer lieben. Eltern schätzen, wie das Cowboy-Thema Eigenständigkeit und Gemeinschaft feiert.',
  'En selle pour une aventure dans le Far West ! Votre enfant chevauche à travers des canyons et des prairies pour aider une ville frontière. L\'histoire capture l\'esprit de la frontière américaine tout en restant chaleureuse et adaptée. Parfait pour les enfants qui aiment les chevaux et l\'exploration.',
  [{ q: { en: 'Does the cowboy story include guns?', de: 'Enthält die Cowboy-Geschichte Waffen?', fr: 'L\'histoire inclut-elle des armes ?' }, a: { en: 'No. The adventure focuses on exploration, mystery-solving, and helping the community.', de: 'Nein. Das Abenteuer konzentriert sich auf Erkundung und Gemeinschaftshilfe.', fr: 'Non. L\'aventure se concentre sur l\'exploration et l\'entraide.' } }]
);

addAdventure('ninja', '4-9',
  'Focus, self-discipline, patience, physical coordination, quick thinking.',
  'Fokus, Selbstdisziplin, Geduld, körperliche Koordination, schnelles Denken.',
  'Concentration, autodiscipline, patience, coordination physique, réflexion rapide.',
  'In this thrilling personalized ninja adventure, your child enters the hidden dojo of a legendary ninja master and begins training in stealth, balance, and focus. Under the watchful eye of a wise sensei, your little ninja learns to move silently through bamboo forests, leap across rooftops, and solve challenges requiring patience and quick thinking.\n\nWhen a mysterious message requests help, your child embarks on a secret mission through a moonlit Japanese landscape filled with cherry blossoms, ancient temples, and hidden passages. The story celebrates discipline, focus, and inner strength — showing children that the most powerful weapon is their mind.\n\nEvery illustration features your child in a sleek ninja outfit, performing acrobatic moves and outsmarting obstacles. Parents appreciate how it channels energy into positive values: concentration, respect, and patience. The adventure is exciting without being aggressive.',
  'In diesem spannenden Ninja-Abenteuer betritt dein Kind das verborgene Dojo eines legendären Ninja-Meisters und beginnt sein Training in Tarnung, Balance und Konzentration. Unter dem wachsamen Auge eines weisen Senseis lernt dein kleiner Ninja, sich lautlos durch Bambuswälder zu bewegen und Herausforderungen mit Geduld und schnellem Denken zu meistern.\n\nAls eine geheimnisvolle Nachricht um Hilfe bittet, bricht dein Kind zu einer Geheimmission durch eine mondbeleuchtete japanische Landschaft auf. Die Geschichte feiert Disziplin, Fokus und innere Stärke.\n\nJede Illustration zeigt dein Kind im Ninja-Outfit bei akrobatischen Bewegungen. Eltern schätzen, wie das Thema Energie in positive Werte kanalisiert: Konzentration, Respekt und Geduld.',
  'Dans cette aventure ninja palpitante, votre enfant entre dans le dojo caché d\'un maître ninja légendaire. L\'histoire célèbre la discipline, la concentration et la force intérieure. Les parents apprécient comment le thème canalise l\'énergie vers des valeurs positives.',
  [{ q: { en: 'Is the ninja story too intense for preschoolers?', de: 'Ist die Ninja-Geschichte zu intensiv für Vorschulkinder?', fr: 'L\'histoire de ninja est-elle trop intense ?' }, a: { en: 'No, missions involve stealth and puzzles, not combat. Children as young as 4 enjoy it.', de: 'Nein, die Missionen beinhalten Tarnung und Rätsel, keinen Kampf.', fr: 'Non, les missions sont des énigmes et de la furtivité, pas des combats.' } }]
);

addAdventure('viking', '4-9',
  'Exploration and curiosity, teamwork, resilience, respect for nature and legends.',
  'Entdeckergeist und Neugierde, Teamarbeit, Widerstandsfähigkeit, Respekt vor Natur und Legenden.',
  'Exploration et curiosité, travail d\'équipe, résilience, respect de la nature et des légendes.',
  'Set sail on a Viking longship through icy northern waters! Your child joins a crew of friendly Vikings on a daring voyage to discover new lands. Steering through towering icebergs, past playful seals, and under the northern lights, your little explorer encounters mythical Norse creatures, discovers ancient runes, and learns about courage, loyalty, and exploration.\n\nThe story brings the Viking age to life without raids or battles — just the thrill of discovery and crew camaraderie. Your child wears a fur-lined cloak and Viking helmet, standing proudly at the bow. Perfect for children fascinated by history, the ocean, and mythological creatures. The magnificent illustrations of northern landscapes and glowing auroras make this one of the most visually stunning stories in our collection.',
  'Setzt die Segel auf einem Wikinger-Langschiff durch eisige Nordgewässer! Dein Kind schliesst sich freundlichen Wikingern an und bricht auf, neue Länder zu entdecken. Vorbei an Eisbergen, verspielten Robben und unter dem Nordlicht trifft dein kleiner Entdecker auf mythische Kreaturen und entdeckt uralte Runen.\n\nDie Geschichte erweckt die Wikingerzeit kindgerecht zum Leben — ohne Überfälle oder Schlachten. Dein Kind trägt einen pelzgefütterten Umhang und Wikingerhelm. Perfekt für Kinder, die von Geschichte und Mythologie fasziniert sind. Die grossartigen Illustrationen nordischer Landschaften machen dies zu einer visuell beeindruckenden Geschichte.',
  'Hissez les voiles sur un drakkar viking ! Votre enfant rejoint un équipage sympathique pour un voyage audacieux. L\'histoire donne vie à l\'ère viking sans raids ni batailles. Les magnifiques illustrations de paysages nordiques en font une histoire visuellement impressionnante.',
  [{ q: { en: 'Does the Viking story include fighting?', de: 'Enthält die Wikinger-Geschichte Kämpfe?', fr: 'L\'histoire viking comprend-elle des combats ?' }, a: { en: 'No. It is about exploration and discovery, not raids.', de: 'Nein. Es geht um Erkundung und Entdeckung.', fr: 'Non. Elle porte sur l\'exploration et la découverte.' } }]
);

addAdventure('roman', '4-9',
  'History, problem-solving, civic values, curiosity about ancient civilizations.',
  'Geschichte, Problemlösung, bürgerliche Werte, Neugierde auf antike Zivilisationen.',
  'Histoire, résolution de problèmes, valeurs civiques, curiosité pour les civilisations anciennes.',
  'Step back in time to ancient Rome! Your child walks through the bustling streets of the Eternal City, past marble temples and the mighty Colosseum. Dressed in a toga, your little citizen meets friendly senators, watches chariot races, and solves a mystery involving a missing golden eagle.\n\nThe story brings Roman daily life to vivid detail — aqueducts, mosaics, and lively forums. The climax takes place in the Colosseum as a celebration, not a fight. Every illustration places your child at the heart of the Roman world. Perfect for young history enthusiasts aged 4 to 9 who love learning about how people lived long ago.',
  'Reise in die Glanzzeit des antiken Roms! Dein Kind spaziert durch die Strassen der Ewigen Stadt, vorbei an Tempeln und dem Kolosseum. In einer Toga gekleidet, trifft dein kleiner Bürger Senatoren, beobachtet Wagenrennen und löst ein Rätsel um einen verschwundenen goldenen Adler.\n\nDie Geschichte erweckt den römischen Alltag zum Leben. Der Höhepunkt im Kolosseum ist eine Feier, kein Kampf. Perfekt für junge Geschichtsfans von 4 bis 9 Jahren.',
  'Remontez le temps dans la Rome antique ! Votre enfant parcourt les rues animées, résout un mystère et découvre la culture romaine. Le Colisée est le lieu d\'une célébration, pas d\'un combat. Parfait pour les jeunes passionnés d\'histoire.',
  [{ q: { en: 'Does it include gladiator fighting?', de: 'Enthält es Gladiatorenkämpfe?', fr: 'Y a-t-il des combats de gladiateurs ?' }, a: { en: 'No. The Colosseum scene is a celebration ceremony, not a fight.', de: 'Nein. Die Kolosseum-Szene ist eine Feier, kein Kampf.', fr: 'Non. La scène du Colisée est une célébration, pas un combat.' } }]
);

addAdventure('egyptian', '4-9',
  'Archaeological curiosity, puzzle-solving, ancient history, patience and observation.',
  'Archäologische Neugierde, Rätsel lösen, antike Geschichte, Geduld und Beobachtungsgabe.',
  'Curiosité archéologique, résolution d\'énigmes, histoire ancienne, patience et observation.',
  'Journey to the land of the pharaohs! Your child arrives at the Great Pyramids, where golden sand stretches to the horizon and the Sphinx guards its secrets. Armed with a torch and journal, your young explorer ventures into dark pyramid passages, deciphering hieroglyphic clues. Each puzzle leads deeper into a lost pharaoh\'s treasure chamber.\n\nYour child meets scribes who teach Egyptian writing, discovers how the pyramids were built, and learns about daily life along the Nile. The story balances wonder and education, teaching real facts about one of the world\'s oldest civilizations. Illustrations show your child amid golden tombs and starlit desert skies. Perfect for curious children aged 4 to 9 who love puzzles and ancient history.',
  'Reise ins Land der Pharaonen! Dein Kind kommt an den Grossen Pyramiden an, wo goldener Sand bis zum Horizont reicht. Mit Fackel und Tagebuch erkundet dein junger Entdecker dunkle Pyramidengänge und entziffert Hieroglyphen. Jedes Rätsel führt tiefer in eine Schatzkammer.\n\nDein Kind trifft Schreiber, die ägyptische Schrift beibringen, und erfährt, wie die Pyramiden gebaut wurden. Die Geschichte verbindet Staunen und Bildung. Perfekt für neugierige Kinder von 4 bis 9 Jahren.',
  'Voyagez au pays des pharaons ! Votre enfant explore les pyramides et déchiffre des hiéroglyphes. L\'histoire équilibre émerveillement et éducation. Parfait pour les enfants curieux de 4 à 9 ans.',
  [{ q: { en: 'Are there scary mummies?', de: 'Gibt es gruselige Mumien?', fr: 'Y a-t-il des momies effrayantes ?' }, a: { en: 'The pyramid is presented as a place of wonder, not horror. The focus is on discovery and puzzles.', de: 'Die Pyramide ist ein Ort des Staunens, nicht des Schreckens.', fr: 'La pyramide est un lieu d\'émerveillement, pas de frayeur.' } }]
);

addAdventure('greek', '4-9',
  'Mythology, riddle-solving, creative thinking, cultural literacy.',
  'Mythologie, Rätsel lösen, kreatives Denken, Kulturwissen.',
  'Mythologie, résolution d\'énigmes, pensée créative, culture générale.',
  'Embark on an odyssey through Greek mythology! Your child sails the Aegean Sea, climbs Mount Olympus, and meets legendary figures. Guided by wise Athena, your young hero faces riddles from the Sphinx, races with Hermes through olive groves, and helps Poseidon calm a stormy sea.\n\nThe story brings Greek myths to life in a child-friendly way, celebrating cleverness and the power of asking good questions. Your child wears a Greek tunic, explores marble temples, and receives a laurel wreath for their wisdom. Ideal for children aged 4 to 9 who love mythology, puzzles, and different cultures.',
  'Begib dich auf eine Odyssee durch die griechische Mythologie! Dein Kind segelt über die Ägäis, erklimmt den Olymp und trifft legendäre Figuren. Geführt von Athene, löst dein junger Held Rätsel der Sphinx und hilft Poseidon. Die Geschichte erweckt griechische Mythen kindgerecht zum Leben. Ideal für Kinder von 4 bis 9 Jahren.',
  'Partez pour une odyssée à travers la mythologie grecque ! L\'histoire donne vie aux mythes grecs de manière adaptée aux enfants. Parfait pour les enfants de 4 à 9 ans.',
  [{ q: { en: 'Are the Greek gods child-friendly?', de: 'Sind die Götter kindgerecht?', fr: 'Les dieux sont-ils adaptés aux enfants ?' }, a: { en: 'Yes! They appear as helpful, colorful characters. Darker mythology is excluded.', de: 'Ja! Sie erscheinen als hilfreiche Figuren. Dunkle Aspekte sind ausgeschlossen.', fr: 'Oui ! Ils apparaissent comme des personnages bienveillants.' } }]
);

addAdventure('caveman', '3-8',
  'Survival skills, cooperation, creativity, respect for nature, prehistoric knowledge.',
  'Überlebenskunst, Kooperation, Kreativität, Respekt vor der Natur, Wissen über die Urzeit.',
  'Débrouillardise, coopération, créativité, respect de la nature, connaissances préhistoriques.',
  'Travel back to the dawn of humanity! Your child wakes up in a cozy cave, wrapped in furs, and steps into a prehistoric world with woolly mammoths, saber-toothed cats, and vast ice-age landscapes. Your young cave dweller learns to gather berries, paint on cave walls, craft stone tools, and — most excitingly — discover the secret of fire.\n\nThe adventure shows how early humans cooperated, communicated through pictures, and survived by being clever. Your child befriends a baby mammoth and helps the tribe find shelter. The illustrations feature towering glaciers, lush forests, and vast plains. Perfect for children aged 3 to 8 who love animals, nature, and learning about where we all came from.',
  'Reise zurück zu den Anfängen der Menschheit! Dein Kind wacht in einer Höhle auf und tritt in eine Welt voller Mammuts und Säbelzahnkatzen. Es lernt Beeren zu sammeln, auf Höhlenwände zu malen, Steinwerkzeuge herzustellen und das Feuer zu entdecken.\n\nDie Geschichte zeigt, wie frühe Menschen zusammenarbeiteten und durch Cleverness überlebten. Dein Kind freundet sich mit einem Mammutbaby an. Perfekt für Kinder von 3 bis 8 Jahren, die Tiere und Natur lieben.',
  'Voyagez à l\'aube de l\'humanité ! Votre enfant découvre un monde préhistorique avec des mammouths et apprend à survivre par la coopération. Parfait pour les enfants de 3 à 8 ans.',
  [{ q: { en: 'Are prehistoric animals scary?', de: 'Sind Urzeittiere gruselig?', fr: 'Les animaux préhistoriques sont-ils effrayants ?' }, a: { en: 'They inspire wonder, not fear. The mammoth becomes a friend.', de: 'Sie wecken Staunen, nicht Angst. Das Mammut wird zum Freund.', fr: 'Ils inspirent l\'émerveillement. Le mammouth devient un ami.' } }]
);

addAdventure('samurai', '4-9',
  'Discipline, respect, honor, integrity, cultural appreciation.',
  'Disziplin, Respekt, Ehre, Integrität, kulturelle Wertschätzung.',
  'Discipline, respect, honneur, intégrité, appréciation culturelle.',
  'Your child enters the serene world of feudal Japan, where cherry blossoms fall like pink snow and temples rise above misty mountains. Under a wise sensei, your young samurai learns the seven virtues of bushido: courage, honor, compassion, respect, honesty, loyalty, and self-control.\n\nThrough challenges — balancing on a bridge, calming a horse, solving an ancient riddle — your child proves they can protect their village. The story celebrates Japanese culture with bamboo groves, koi ponds, and traditional dojos. Your child wears a samurai outfit and practices with a bamboo sword. Perfect for children aged 4 to 9 drawn to martial arts or Japanese culture.',
  'Dein Kind betritt die friedvolle Welt des feudalen Japan. Unter einem weisen Sensei lernt dein junger Samurai die sieben Tugenden des Bushido. Durch Herausforderungen beweist dein Kind seinen Mut. Die Geschichte feiert die japanische Kultur mit Bambushainen und Dojos. Perfekt für Kinder von 4 bis 9 Jahren.',
  'Votre enfant entre dans le monde serein du Japon féodal et apprend les sept vertus du bushido. L\'histoire célèbre la culture japonaise. Parfait pour les enfants de 4 à 9 ans.',
  [{ q: { en: 'Does it contain sword fighting?', de: 'Gibt es Schwertkämpfe?', fr: 'Y a-t-il des combats à l\'épée ?' }, a: { en: 'No real fighting. Challenges are solved through wisdom and respect.', de: 'Keine echten Kämpfe. Herausforderungen werden durch Weisheit gelöst.', fr: 'Pas de vrai combat. Les défis sont relevés par la sagesse.' } }]
);

addAdventure('wizard', '3-8',
  'Creativity, logic, self-confidence, imagination, reading love.',
  'Kreativität, Logik, Selbstvertrauen, Fantasie, Lesefreude.',
  'Créativité, logique, confiance en soi, imagination, amour de la lecture.',
  'Your child receives a mysterious letter inviting them to a school of magic in the clouds! From day one, your little wizard learns spells, brews colorful potions, and flies on a broomstick across starlit skies. When a mischievous enchantment threatens to turn all books into frogs, only your child\'s quick thinking can save the day.\n\nThe story is filled with whimsy, wonder, and the message that real magic comes from believing in yourself. Every page features your child in wizard\'s robes with a sparkling wand. Perfect for imaginative children aged 3 to 8 who dream of enchanted worlds. Parents love how it encourages creativity and confidence.',
  'Dein Kind erhält einen geheimnisvollen Brief an eine Zauberschule in den Wolken! Ab dem ersten Tag lernt dein kleiner Zauberer Sprüche, braut Tränke und fliegt auf einem Besen. Als ein Zauber alle Bücher in Frösche zu verwandeln droht, kann nur dein Kind die Lage retten.\n\nDie Geschichte steckt voller Wunder und der Botschaft, dass echte Magie aus dem Glauben an sich selbst entsteht. Perfekt für fantasievolle Kinder von 3 bis 8 Jahren. Eltern lieben es, wie das Thema Kreativität und Selbstvertrauen fördert.',
  'Votre enfant reçoit une lettre mystérieuse pour une école de magie ! L\'histoire est pleine de merveilleux et du message que la vraie magie vient de la confiance en soi. Parfait pour les enfants imaginatifs de 3 à 8 ans.',
  [{ q: { en: 'Is it similar to Harry Potter?', de: 'Ähnelt es Harry Potter?', fr: 'Est-ce similaire à Harry Potter ?' }, a: { en: 'It shares the fun of a magic school but is original, age-appropriate, and personalized with your child as hero.', de: 'Es teilt den Spass einer Zauberschule, ist aber original, altersgerecht und mit deinem Kind als Held.', fr: 'L\'histoire partage le plaisir d\'une école de magie mais est originale et adaptée.' } }]
);

addAdventure('dragon', '3-8',
  'Empathy, friendship, courage, accepting differences, trust.',
  'Empathie, Freundschaft, Mut, Unterschiede akzeptieren, Vertrauen.',
  'Empathie, amitié, courage, acceptation des différences, confiance.',
  'Your child discovers a baby dragon hiding in a cave, shivering and alone. While everyone fears dragons, your child sees a friend who needs help. Together, they trek through enchanted valleys and over smoldering mountains to reunite the dragon with its family.\n\nThe story carries a powerful message about empathy, accepting those who are different, and the strength of unlikely friendships. Your child rides on the dragon\'s back through stunning fantasy landscapes. Perfect for children aged 3 to 8 who believe kindness can change the world.',
  'Dein Kind entdeckt einen zitternden Babydrachen in einer Höhle. Während alle Drachen fürchten, sieht dein Kind einen Freund. Gemeinsam bringen sie den Drachen zu seiner Familie zurück. Die Geschichte vermittelt Empathie und die Stärke ungewöhnlicher Freundschaften. Perfekt für Kinder von 3 bis 8 Jahren.',
  'Votre enfant découvre un bébé dragon caché dans une grotte. L\'histoire porte un message puissant sur l\'empathie et l\'amitié. Parfait pour les enfants de 3 à 8 ans.',
  [{ q: { en: 'Is the dragon scary?', de: 'Ist der Drache gruselig?', fr: 'Le dragon est-il effrayant ?' }, a: { en: 'Not at all! It is a gentle baby who becomes your child\'s best friend.', de: 'Überhaupt nicht! Er ist ein sanftes Baby, das der beste Freund deines Kindes wird.', fr: 'Pas du tout ! C\'est un gentil bébé qui devient le meilleur ami de votre enfant.' } }]
);

addAdventure('unicorn', '3-7',
  'Kindness, creativity, wonder, emotional expression, beauty of nature.',
  'Freundlichkeit, Kreativität, Staunen, emotionaler Ausdruck, Naturschönheit.',
  'Gentillesse, créativité, émerveillement, expression émotionnelle, beauté de la nature.',
  'Your child discovers a rainbow bridge leading to an enchanted meadow where unicorns roam freely. Together with a shimmering unicorn, they journey to restore color to a world turned grey. Galloping through crystal waterfalls, giant flower fields, and silver forests, your child spreads kindness — and with every kind act, color returns.\n\nThe story celebrates gentleness, beauty, and the power of a kind heart. Every page bursts with breathtaking fantasy landscapes. Perfect for children aged 3 to 7 who love magic and colors.',
  'Dein Kind entdeckt eine Regenbogenbrücke zu einer Zauberwiese. Gemeinsam mit einem schimmernden Einhorn gibt es einer grauen Welt die Farben zurück. Die Geschichte feiert Sanftmut und die Kraft eines guten Herzens. Perfekt für Kinder von 3 bis 7 Jahren.',
  'Votre enfant découvre un pont arc-en-ciel vers une prairie enchantée. L\'histoire célèbre la gentillesse et le pouvoir d\'un bon coeur. Parfait pour les enfants de 3 à 7 ans.',
  [{ q: { en: 'Is it only for girls?', de: 'Ist es nur für Mädchen?', fr: 'Est-ce réservé aux filles ?' }, a: { en: 'No! It is about kindness and magic — themes every child enjoys.', de: 'Nein! Es geht um Freundlichkeit und Magie — Themen, die jedes Kind liebt.', fr: 'Non ! C\'est l\'histoire de la gentillesse et de la magie — des thèmes universels.' } }]
);

addAdventure('mermaid', '3-7',
  'Environmental awareness, friendship, curiosity, compassion, ocean knowledge.',
  'Umweltbewusstsein, Freundschaft, Neugierde, Mitgefühl, Wissen über den Ozean.',
  'Conscience environnementale, amitié, curiosité, compassion, connaissance de l\'océan.',
  'Your child dives beneath the waves into a shimmering underwater kingdom of coral castles, playful dolphins, and sunken ships. Transformed into a mermaid with a sparkling tail, your child befriends sea creatures and helps the Ocean Queen find the Great Pearl that keeps the ocean clean.\n\nSwimming through underwater caves, kelp forests, and past sea turtles, your child uses kindness and cleverness to restore balance. The story teaches environmental awareness and the importance of protecting our oceans. Every illustration shows your child with a magnificent tail alongside whales and coral gardens. Perfect for children aged 3 to 7 who love the sea.',
  'Dein Kind taucht in ein Unterwasserkönigreich voller Korallenpaläste und Delfine. Als Meerjungfrau mit funkelndem Schwanz hilft dein Kind der Meereskönigin, die Grosse Perle zu finden, die das Meer sauber hält. Die Geschichte lehrt Umweltbewusstsein und Meeresschutz. Perfekt für Kinder von 3 bis 7 Jahren.',
  'Votre enfant plonge dans un royaume sous-marin scintillant. L\'histoire enseigne la conscience environnementale et la protection des océans. Parfait pour les enfants de 3 à 7 ans.',
  [{ q: { en: 'Can boys be merpeople?', de: 'Können Jungen Meermenschen sein?', fr: 'Les garçons peuvent-ils être des tritons ?' }, a: { en: 'Absolutely! Boys become mermen with equally magnificent tails.', de: 'Selbstverständlich! Jungen werden zu Meermännern.', fr: 'Absolument ! Les garçons deviennent des tritons.' } }]
);

addAdventure('dinosaur', '3-8',
  'Paleontology basics, bravery, scientific curiosity, friendship with animals.',
  'Grundlagen der Paläontologie, Mut, wissenschaftliche Neugierde, Tierfreundschaft.',
  'Bases de paléontologie, courage, curiosité scientifique, amitié avec les animaux.',
  'Your child travels 65 million years back through a time portal into a lush prehistoric jungle where dinosaurs still roam. Your young paleontologist befriends a Brachiosaurus, rides a Triceratops, and learns to identify species by their footprints and diets.\n\nWhen a volcano rumbles, your child guides their dinosaur friends to safety. The story weaves real paleontological facts into an exciting narrative. Every illustration shows your child in explorer gear surrounded by magnificent dinosaurs. Perfect for dinosaur-obsessed children aged 3 to 8.',
  'Dein Kind reist 65 Millionen Jahre zurück in einen urzeitlichen Dschungel. Dein kleiner Paläontologe freundet sich mit Dinosauriern an und lernt echte Fakten über verschiedene Arten. Perfekt für dinosaurierbegeisterte Kinder von 3 bis 8 Jahren.',
  'Votre enfant voyage 65 millions d\'années en arrière. L\'histoire intègre de vrais faits paléontologiques. Parfait pour les enfants passionnés de dinosaures.',
  [{ q: { en: 'Does it include real facts?', de: 'Enthält es echte Fakten?', fr: 'Inclut-il de vrais faits ?' }, a: { en: 'Yes! Real paleontological facts about species, diets, and habitats are woven into the adventure.', de: 'Ja! Echte paläontologische Fakten sind in das Abenteuer eingewoben.', fr: 'Oui ! De vrais faits paléontologiques sont intégrés à l\'aventure.' } }]
);

addAdventure('superhero', '3-8',
  'Responsibility, helping others, self-confidence, moral choices.',
  'Verantwortung, anderen helfen, Selbstvertrauen, moralische Entscheidungen.',
  'Responsabilité, entraide, confiance en soi, choix moraux.',
  'Your child wakes up one morning with an incredible superpower! Whether it is flying, super speed, or talking to animals, your child learns to control their gift and protect the city from a mischievous villain causing harmless but silly chaos.\n\nThe story teaches that the greatest superpower is choosing to help others. Every illustration shows your child in a custom superhero outfit, cape flowing, saving the day with a smile. Perfect for children aged 3 to 8 who dream of superpowers.',
  'Dein Kind wacht auf und entdeckt eine Superkraft! Es lernt, sie zu beherrschen und die Stadt zu beschützen. Die Geschichte lehrt, dass die grösste Superkraft die Entscheidung ist, anderen zu helfen. Perfekt für Kinder von 3 bis 8 Jahren.',
  'Votre enfant découvre un super-pouvoir ! L\'histoire montre que le plus grand pouvoir est d\'aider les autres. Parfait pour les enfants de 3 à 8 ans.',
  [{ q: { en: 'Is the villain scary?', de: 'Ist der Schurke gruselig?', fr: 'Le méchant est-il effrayant ?' }, a: { en: 'The villain is mischievous, not threatening. They cause silly chaos, not real danger.', de: 'Der Schurke ist schelmisch, nicht bedrohlich. Lustiges Chaos, keine echte Gefahr.', fr: 'Le vilain est espiègle, pas menaçant. Il cause un chaos amusant.' } }]
);

addAdventure('space', '4-9',
  'Science and astronomy, problem-solving, wonder, exploration spirit.',
  'Wissenschaft und Astronomie, Problemlösung, Staunen, Entdeckergeist.',
  'Science et astronomie, résolution de problèmes, émerveillement, esprit d\'exploration.',
  'Your child blasts off in a gleaming rocket and soars past the Moon, through asteroid fields, and toward the farthest planets. As the youngest astronaut ever, your child visits each planet — bouncing on the Moon, marveling at Jupiter\'s Great Red Spot, and skating across Saturn\'s rings.\n\nWhen the computer detects a mysterious signal beyond Neptune, your child must decide: turn back or venture into the unknown? The story celebrates curiosity, bravery, and the wonder of the cosmos. Perfect for children aged 4 to 9 who dream of becoming astronauts.',
  'Dein Kind startet in einer Rakete und besucht jeden Planeten — hüpft auf dem Mond, staunt über Jupiters Roten Fleck und gleitet über Saturns Ringe. Die Geschichte feiert Neugierde und das Staunen über den Kosmos. Perfekt für Kinder von 4 bis 9 Jahren.',
  'Votre enfant décolle dans une fusée et visite chaque planète du système solaire. L\'histoire célèbre la curiosité scientifique. Parfait pour les enfants de 4 à 9 ans.',
  [{ q: { en: 'Does my child need to know about planets?', de: 'Muss mein Kind schon etwas über Planeten wissen?', fr: 'Mon enfant doit-il connaître les planètes ?' }, a: { en: 'No! The story introduces each planet in a fun way as your child visits them.', de: 'Nein! Die Geschichte stellt jeden Planeten spielerisch vor.', fr: 'Non ! L\'histoire présente chaque planète de manière amusante.' } }]
);

addAdventure('ocean', '4-9',
  'Marine biology basics, environmental care, scientific curiosity, courage.',
  'Grundlagen Meeresbiologie, Umweltschutz, wissenschaftliche Neugierde, Mut.',
  'Biologie marine, protection de l\'environnement, curiosité scientifique, courage.',
  'Your child commands a research submarine into the deepest ocean. Descending through tropical shallows, past the twilight zone where bioluminescent creatures glow, and to the ocean floor, your child maps underwater mountains, discovers new species, and helps a lost baby whale find its mother.\n\nThe story combines deep-sea thrills with real marine biology facts about ocean ecosystems and marine conservation. Every illustration shows your child at the submarine helm. Perfect for children aged 4 to 9 who love the ocean.',
  'Dein Kind steuert ein Forschungs-U-Boot in die Tiefsee. Es kartiert Unterwasserberge, entdeckt neue Arten und hilft einem Babywal. Die Geschichte verbindet Tiefsee-Abenteuer mit echten Fakten über Meeresbiologie. Perfekt für Kinder von 4 bis 9 Jahren.',
  'Votre enfant pilote un sous-marin de recherche. L\'histoire combine frissons et faits de biologie marine. Parfait pour les enfants de 4 à 9 ans.',
  [{ q: { en: 'Is the deep sea scary?', de: 'Ist die Tiefsee gruselig?', fr: 'Les profondeurs sont-elles effrayantes ?' }, a: { en: 'It is presented as a place of wonder. Bioluminescent creatures glow beautifully.', de: 'Die Tiefsee wird als Ort des Staunens dargestellt. Leuchtende Kreaturen glühen wunderschön.', fr: 'L\'océan profond est présenté comme un lieu d\'émerveillement.' } }]
);

addAdventure('jungle', '3-8',
  'Nature awareness, tracking skills, respect for wildlife, persistence.',
  'Naturbewusstsein, Spurenlesen, Respekt vor Wildtieren, Ausdauer.',
  'Conscience de la nature, pistage, respect de la faune, persévérance.',
  'Your child ventures deep into a tropical rainforest teeming with wildlife and towering trees. Armed with binoculars and a guidebook, your explorer tracks parrots, discovers a hidden waterfall, and stumbles upon an ancient temple overgrown with orchids.\n\nThe story teaches rainforest biodiversity, respect for nature, and the thrill of discovery. Every illustration features your child in explorer gear amid lush foliage and spectacular wildlife. Perfect for nature-loving children aged 3 to 8.',
  'Dein Kind wagt sich tief in einen Regenwald voller Tiere. Mit Fernglas und Reiseführer entdeckt dein Kind Papageien, einen Wasserfall und einen uralten Tempel. Die Geschichte lehrt Respekt vor der Natur. Perfekt für naturliebende Kinder von 3 bis 8 Jahren.',
  'Votre enfant s\'aventure dans une forêt tropicale luxuriante. L\'histoire enseigne le respect de la nature. Parfait pour les enfants de 3 à 8 ans.',
  [{ q: { en: 'Are there dangerous animals?', de: 'Gibt es gefährliche Tiere?', fr: 'Y a-t-il des animaux dangereux ?' }, a: { en: 'Wild animals are shown respectfully from a distance. The focus is observation, not danger.', de: 'Wilde Tiere werden respektvoll aus der Distanz gezeigt.', fr: 'Les animaux sont montrés respectueusement à distance.' } }]
);

addAdventure('farm', '2-6',
  'Animal care, food awareness, daily routines, responsibility.',
  'Tierpflege, Wissen über Lebensmittel, Tagesabläufe, Verantwortung.',
  'Soin des animaux, connaissance alimentaire, routines, responsabilité.',
  'Your child spends a wonderful day on a sunny farm! From feeding baby chicks and collecting eggs to milking a cow and riding a tractor, your child experiences farm life from sunrise to sunset. The story teaches where food comes from — how wheat becomes bread, milk becomes cheese, and seeds grow into vegetables.\n\nYour child helps a lost lamb, plants sunflowers, and enjoys a harvest feast. Every illustration shows your child in adorable farm overalls surrounded by friendly animals. Perfect for younger children aged 2 to 6 who love animals and the outdoors.',
  'Dein Kind verbringt einen Tag auf einem sonnigen Bauernhof! Vom Füttern der Küken über das Eiersammeln bis zur Traktorfahrt erlebt dein Kind das Bauernhofleben. Die Geschichte zeigt, wo unser Essen herkommt. Perfekt für Kinder von 2 bis 6 Jahren.',
  'Votre enfant passe une journée à la ferme ! L\'histoire montre d\'où vient notre nourriture. Parfait pour les enfants de 2 à 6 ans.',
  [{ q: { en: 'Is it educational?', de: 'Ist es lehrreich?', fr: 'Est-ce éducatif ?' }, a: { en: 'Yes! Children learn where milk, eggs, bread and vegetables come from through hands-on activities.', de: 'Ja! Kinder lernen, woher Milch, Eier und Gemüse kommen.', fr: 'Oui ! Les enfants apprennent d\'où viennent le lait et les légumes.' } }]
);

addAdventure('forest', '3-7',
  'Nature appreciation, friendship, mystery-solving, mindfulness.',
  'Naturschätzung, Freundschaft, Rätsellösung, Achtsamkeit.',
  'Appréciation de la nature, amitié, mystères, pleine conscience.',
  'Your child wanders into an enchanted woodland where trees whisper secrets. Guided by a friendly fox, your child follows a winding path, meets talking rabbits and wise owls, and helps hedgehogs rebuild after a storm. The forest adventure teaches mindfulness, kindness toward animals, and the beauty of slowing down.\n\nEvery illustration features dappled sunlight, ancient trees, and charming creatures. Perfect for gentle children aged 3 to 7 who love nature walks.',
  'Dein Kind wandert in einen Zauberwald mit flüsternden Bäumen. Geführt von einem Fuchs, trifft es sprechende Hasen und weise Eulen. Die Geschichte lehrt Achtsamkeit und Freundlichkeit. Perfekt für sanfte Kinder von 3 bis 7 Jahren.',
  'Votre enfant se promène dans un bois enchanté. L\'histoire enseigne la pleine conscience. Parfait pour les enfants de 3 à 7 ans.',
  [{ q: { en: 'Suitable for very young children?', de: 'Für ganz Kleine geeignet?', fr: 'Adapté aux très jeunes enfants ?' }, a: { en: 'Yes! It is gentle and calming, perfect from age 3.', de: 'Ja! Sanft und beruhigend, perfekt ab 3 Jahren.', fr: 'Oui ! Doux et apaisant, parfait dès 3 ans.' } }]
);

addAdventure('fireman', '3-7',
  'Bravery, teamwork, community service, safety awareness.',
  'Mut, Teamarbeit, Gemeinschaftsdienst, Sicherheitsbewusstsein.',
  'Courage, travail d\'équipe, service communautaire, sécurité.',
  'Your child joins the fire station crew! After polishing the truck and sliding down the pole, the alarm sounds. Your child races to rescue a family, saves a kitten from a tree, and puts out flames with the big hose.\n\nThe story emphasizes bravery, teamwork, and community service. Every illustration shows your child in full firefighter gear, climbing ladders and being cheered by citizens. Perfect for children aged 3 to 7 who dream of being firefighters.',
  'Dein Kind wird Teil der Feuerwehr! Nach dem Polieren des Löschfahrzeugs ertönt der Alarm. Dein Kind eilt zur Rettung. Die Geschichte betont Mut und Teamarbeit. Perfekt für Kinder von 3 bis 7 Jahren.',
  'Votre enfant rejoint la caserne ! L\'histoire met l\'accent sur le courage et le travail d\'équipe. Parfait pour les enfants de 3 à 7 ans.',
  [{ q: { en: 'Does it show real fires?', de: 'Zeigt es echte Feuer?', fr: 'Montre-t-il de vrais incendies ?' }, a: { en: 'Fire appears but the focus is on bravery and safety. Scenes are heroic, not frightening.', de: 'Feuer kommt vor, aber der Fokus liegt auf Mut und Sicherheit.', fr: 'Le feu apparaît mais l\'accent est mis sur le courage.' } }]
);

addAdventure('doctor', '3-7',
  'Empathy, observation, helping others, overcoming fear of doctors.',
  'Empathie, Beobachtungsgabe, anderen helfen, Angst vor Ärzten überwinden.',
  'Empathie, observation, entraide, surmonter la peur du médecin.',
  'Your child puts on a white coat and opens their own clinic! Patients arrive — a teddy with a sore paw, a doll with a headache, even a dragon with a cough. Your child listens, examines gently, and prescribes the perfect remedy.\n\nThe story demystifies medical visits, teaching that doctors are kind helpers. Every illustration shows your child as a caring doctor. Perfect for children aged 3 to 7 who are curious about medicine or need reassurance before doctor visits.',
  'Dein Kind schlüpft in den weissen Kittel und eröffnet seine Praxis! Patienten kommen — ein Teddy, eine Puppe, ein Drache. Die Geschichte nimmt Kindern die Angst vor Arztbesuchen. Perfekt für Kinder von 3 bis 7 Jahren.',
  'Votre enfant enfile une blouse blanche et ouvre sa clinique ! L\'histoire démystifie les visites médicales. Parfait pour les enfants de 3 à 7 ans.',
  [{ q: { en: 'Will it help reduce fear of doctors?', de: 'Hilft es gegen Arztangst?', fr: 'Aide-t-il à réduire la peur du médecin ?' }, a: { en: 'Yes! By putting your child in the doctor role, medical tools become familiar and friendly.', de: 'Ja! Indem dein Kind den Arzt spielt, werden Instrumente vertraut.', fr: 'Oui ! En jouant le rôle du médecin, les outils médicaux deviennent familiers.' } }]
);

addAdventure('police', '3-7',
  'Fairness, observation, community protection, problem-solving.',
  'Fairness, Beobachtungsgabe, Gemeinschaftsschutz, Problemlösung.',
  'Justice, observation, protection de la communauté, résolution de problèmes.',
  'Your child becomes the newest officer in the neighborhood! On a shiny bicycle, they help lost children and solve the mystery of the baker\'s missing prize cake before the village fair. The story celebrates community protection, fairness, and problem-solving.\n\nEvery illustration features your child in a smart police uniform, examining evidence and being thanked by the community. Perfect for children aged 3 to 7 who love solving puzzles.',
  'Dein Kind wird zum jüngsten Polizisten im Viertel! Auf einem Fahrrad hilft es verlorenen Kindern und löst ein Rätsel. Die Geschichte feiert Fairness und Gemeinschaftsschutz. Perfekt für Kinder von 3 bis 7 Jahren.',
  'Votre enfant devient le plus jeune agent du quartier ! L\'histoire célèbre la justice et la résolution de problèmes. Parfait pour les enfants de 3 à 7 ans.',
  [{ q: { en: 'Are officers shown positively?', de: 'Werden Polizisten positiv gezeigt?', fr: 'Les policiers sont-ils positifs ?' }, a: { en: 'Yes, as community helpers who solve problems with fairness and kindness.', de: 'Ja, als Gemeinschaftshelfer, die fair und freundlich handeln.', fr: 'Oui, comme des aides communautaires justes et bienveillants.' } }]
);

addAdventure('detective', '4-9',
  'Logical thinking, observation, deduction, patience, persistence.',
  'Logisches Denken, Beobachtungsgabe, Deduktion, Geduld, Ausdauer.',
  'Pensée logique, observation, déduction, patience, persévérance.',
  'Your child picks up a magnifying glass and dons a detective\'s cap. A priceless painting has vanished from the museum! Following cryptic clues — a mysterious footprint, a torn ticket, a coded message — your child narrows down suspects and cracks the case.\n\nThe story teaches logical thinking, careful observation, and the satisfaction of solving problems step by step. Perfect for children aged 4 to 9 who love puzzles and mysteries.',
  'Dein Kind nimmt die Lupe und löst den Fall eines verschwundenen Gemäldes! Die Geschichte lehrt logisches Denken und die Zufriedenheit, Probleme Schritt für Schritt zu lösen. Perfekt für Kinder von 4 bis 9 Jahren.',
  'Votre enfant prend sa loupe et résout un mystère au musée. L\'histoire enseigne la pensée logique. Parfait pour les enfants de 4 à 9 ans.',
  [{ q: { en: 'How complex is the mystery?', de: 'Wie komplex ist das Rätsel?', fr: 'Le mystère est-il complexe ?' }, a: { en: 'Age-appropriate with clear clues. The AI adjusts complexity based on the child\'s age.', de: 'Altersgerecht mit klaren Hinweisen. Die KI passt die Komplexität an.', fr: 'Adapté à l\'âge avec des indices clairs. L\'IA ajuste la complexité.' } }]
);

addAdventure('christmas', '3-8',
  'Generosity, gratitude, the joy of giving, family values.',
  'Grosszügigkeit, Dankbarkeit, Freude am Schenken, Familienwerte.',
  'Générosité, gratitude, joie de donner, valeurs familiales.',
  'Your child receives a magical letter from Santa asking for help on Christmas Eve! Whisked to the North Pole, your child helps elves wrap presents, feeds reindeer, and joins Santa delivering gifts around the world.\n\nFlying over snow-covered rooftops, squeezing down chimneys, and leaving presents under twinkling trees, your child discovers the true magic of Christmas — the joy of giving. A beautiful keepsake to read every year.',
  'Dein Kind erhält einen magischen Brief vom Weihnachtsmann! Am Nordpol hilft es Elfen und begleitet den Weihnachtsmann auf seiner Reise. Die Geschichte feiert die Freude am Schenken. Ein wunderschönes Andenken für jedes Weihnachten.',
  'Votre enfant reçoit une lettre magique du Père Noël ! L\'histoire célèbre la joie de donner. Un beau souvenir à relire chaque Noël.',
  [{ q: { en: 'Is it religious?', de: 'Ist es religiös?', fr: 'Est-ce religieux ?' }, a: { en: 'It focuses on Santa, gift-giving, and family togetherness. Secular and inclusive.', de: 'Es konzentriert sich auf den Weihnachtsmann und Familienzeit. Weltlich und inklusiv.', fr: 'L\'histoire se concentre sur le Père Noël et la famille. Laïque et inclusive.' } }]
);

addAdventure('newyear', '3-8',
  'Cultural awareness, reflection, goal-setting, celebration of diversity.',
  'Kulturbewusstsein, Reflexion, Ziele setzen, Vielfalt feiern.',
  'Conscience culturelle, réflexion, fixation d\'objectifs, célébration de la diversité.',
  'Your child travels around the world to celebrate midnight with children from different countries! From Sydney fireworks to Tokyo countdowns, Rio dancing, and Northern Lights wishes, your child discovers how people everywhere welcome the new year.\n\nThe story celebrates cultural diversity, gratitude, and excitement for what lies ahead. Perfect for children aged 3 to 8 who are curious about the world.',
  'Dein Kind reist um die Welt und feiert Mitternacht mit Kindern aus verschiedenen Ländern! Die Geschichte feiert kulturelle Vielfalt und Neujahrs-Hoffnung. Perfekt für neugierige Kinder von 3 bis 8 Jahren.',
  'Votre enfant fait le tour du monde pour célébrer minuit ! L\'histoire célèbre la diversité culturelle. Parfait pour les enfants de 3 à 8 ans.',
  [{ q: { en: 'Does the story stay up past bedtime?', de: 'Bleibt man lange wach?', fr: 'L\'histoire reste-t-elle éveillée tard ?' }, a: { en: 'It uses magical time travel — your child experiences midnight celebrations without actually staying up late!', de: 'Magisches Zeitreisen — dein Kind erlebt Mitternachtsfeiern, ohne tatsächlich aufzubleiben!', fr: 'Un voyage magique dans le temps — pas besoin de veiller !' } }]
);

addAdventure('easter', '3-7',
  'Curiosity, searching and finding, spring awareness, joy of sharing.',
  'Neugierde, Suchen und Finden, Frühlingsbewusstsein, Freude am Teilen.',
  'Curiosité, recherche, conscience du printemps, joie du partage.',
  'Your child follows the Easter Bunny through a magical spring garden filled with blooming flowers and hidden surprises. Together they hunt for beautifully decorated eggs — and one special golden egg that grants a wish!\n\nThe story celebrates spring, the joy of searching, and the magic of renewal. Your child helps baby animals, plants seeds, and shares chocolate with friends. Every illustration bursts with color. Perfect for children aged 3 to 7 during Easter.',
  'Dein Kind folgt dem Osterhasen durch einen magischen Frühlingsgarten und sucht bemalte Eier — darunter ein goldenes Ei, das einen Wunsch erfüllt! Die Geschichte feiert den Frühling und die Freude am Suchen. Perfekt für Kinder von 3 bis 7 Jahren.',
  'Votre enfant suit le lapin de Pâques dans un jardin printanier magique. L\'histoire célèbre le printemps et la recherche. Parfait pour les enfants de 3 à 7 ans.',
  [{ q: { en: 'Is it religious?', de: 'Ist es religiös?', fr: 'Est-ce religieux ?' }, a: { en: 'It focuses on the Easter Bunny, egg hunts, and spring. Secular and fun.', de: 'Es konzentriert sich auf den Osterhasen und den Frühling. Weltlich und fröhlich.', fr: 'L\'histoire se concentre sur le lapin de Pâques et le printemps. Laïque et joyeuse.' } }]
);

addAdventure('halloween', '4-8',
  'Courage, creative expression, mystery-solving, fun with mild spookiness.',
  'Mut, kreativer Ausdruck, Rätsellösung, spielerischer Grusel.',
  'Courage, expression créative, résolution de mystères, amusement.',
  'Your child puts on an amazing costume and ventures into a friendly-spooky neighborhood on Halloween night. When the town\'s candy chest vanishes, your child follows silly-spooky clues to find it before midnight.\n\nThe story takes the fear out of Halloween — friendly monsters, giggly ghosts, and a mischievous black cat. Every illustration features your child trick-or-treating under a harvest moon. Perfect for children aged 4 to 8 who want Halloween excitement without real scares.',
  'Dein Kind zieht ein Kostüm an und erkundet eine freundlich-gruselige Nachbarschaft. Als eine Süssigkeitentruhe verschwindet, folgt dein Kind lustigen Hinweisen. Die Geschichte macht Halloween lustig statt gruselig. Perfekt für Kinder von 4 bis 8 Jahren.',
  'Votre enfant explore un quartier amicalement effrayant. L\'histoire rend Halloween amusant, pas effrayant. Parfait pour les enfants de 4 à 8 ans.',
  [{ q: { en: 'Is it too scary for sensitive children?', de: 'Zu gruselig für empfindliche Kinder?', fr: 'Trop effrayant pour les enfants sensibles ?' }, a: { en: 'Not at all! Everything is fun-spooky. Ghosts giggle and monsters are friendly.', de: 'Überhaupt nicht! Alles ist lustig-gruselig. Geister kichern und Monster sind freundlich.', fr: 'Pas du tout ! Tout est amusant. Les fantômes rigolent et les monstres sont sympathiques.' } }]
);

// ═══════════════════════════════════════════════════════════════════════════════
// LIFE CHALLENGES — top 20
// ═══════════════════════════════════════════════════════════════════════════════

function addLife(id, age, skillsEn, skillsDe, skillsFr, longEn, longDe, longFr, faqArr) {
  add(id, age, {en:skillsEn, de:skillsDe, fr:skillsFr}, {en:longEn, de:longDe, fr:longFr}, faqArr);
}

addLife('potty-training', '2-4',
  'Independence, body awareness, routine building, self-confidence.',
  'Selbständigkeit, Körperbewusstsein, Routinen aufbauen, Selbstvertrauen.',
  'Indépendance, conscience corporelle, construction de routines, confiance en soi.',
  'Potty training is one of the biggest milestones in a toddler\'s life, and this personalized story makes the journey fun, encouraging, and completely stress-free. Your child becomes the hero who learns to use the big-kid toilet, step by step. The story normalizes every part of the process — recognizing the feeling, going to the bathroom, washing hands afterward — and celebrates each small victory with genuine enthusiasm.\n\nYour child sees themselves illustrated in familiar bathroom settings, sitting on the toilet with a proud expression, and receiving high-fives from family and friends. The narrative uses positive reinforcement rather than pressure, showing that accidents are completely normal and nothing to worry about. Other characters in the story also share their potty-training journeys, so your child feels they are not alone in this experience.\n\nThe language is warm and supportive, using simple words that toddlers understand. Parents consistently report that this story helps motivate reluctant children by making the toilet something exciting rather than intimidating. Many families read it as part of the daily routine — once in the morning and once before bed — to build familiarity and confidence. This is one of our most popular life-challenge themes, especially for children between 2 and 4 years old.',
  'Töpfchentraining ist einer der grössten Meilensteine im Leben eines Kleinkinds, und diese personalisierte Geschichte macht den Weg dahin lustig, ermutigend und völlig stressfrei. Dein Kind wird zum Helden, der Schritt für Schritt lernt, die richtige Toilette zu benutzen. Die Geschichte normalisiert jeden Teil des Prozesses — das Gefühl erkennen, aufs Klo gehen, Hände waschen — und feiert jeden kleinen Sieg mit echtem Enthusiasmus.\n\nDein Kind sieht sich selbst in vertrauten Badezimmer-Szenen illustriert, mit stolzem Ausdruck auf der Toilette sitzend und Abklatscher von Familie und Freunden bekommend. Die Erzählung nutzt positive Verstärkung statt Druck und zeigt, dass Unfälle völlig normal sind. Andere Figuren teilen auch ihre Erfahrungen, sodass sich dein Kind nicht allein fühlt.\n\nDie Sprache ist warm und unterstützend, mit einfachen Worten, die Kleinkinder verstehen. Eltern berichten, dass diese Geschichte zögernde Kinder motiviert, indem sie die Toilette aufregend statt einschüchternd macht. Viele Familien lesen sie als Teil der täglichen Routine. Dies ist eines unserer beliebtesten Lebensthemen, besonders für Kinder zwischen 2 und 4 Jahren.',
  'L\'apprentissage de la propreté est une grande étape, et cette histoire personnalisée rend le parcours amusant et encourageant. Votre enfant devient le héros qui apprend à utiliser les toilettes, étape par étape. L\'histoire normalise chaque partie du processus et célèbre chaque victoire. La narration utilise le renforcement positif plutôt que la pression. L\'un de nos thèmes les plus populaires pour les enfants de 2 à 4 ans.',
  [
    { q: { en: 'At what age should I use this story?', de: 'Ab welchem Alter eignet sich diese Geschichte?', fr: 'À quel âge utiliser cette histoire ?' }, a: { en: 'Most effective between ages 2 and 3.5, when children show readiness signs. But it works for any child starting the potty-training journey.', de: 'Am wirksamsten zwischen 2 und 3,5 Jahren, wenn Kinder Bereitschaftszeichen zeigen. Aber sie funktioniert für jedes Kind, das mit dem Training beginnt.', fr: 'Plus efficace entre 2 et 3,5 ans, mais elle convient à tout enfant qui commence l\'apprentissage.' } },
    { q: { en: 'Does it handle accidents sensitively?', de: 'Werden Unfälle einfühlsam behandelt?', fr: 'Les accidents sont-ils traités avec sensibilité ?' }, a: { en: 'Yes! The story normalizes accidents completely, showing they are a normal part of learning. There is zero shame or pressure.', de: 'Ja! Die Geschichte normalisiert Unfälle vollständig. Kein Schämen, kein Druck.', fr: 'Oui ! L\'histoire normalise complètement les accidents. Aucune honte ni pression.' } },
  ]
);

addLife('brushing-teeth', '2-5',
  'Dental hygiene, routine building, self-care, counting skills.',
  'Zahnhygiene, Routinen aufbauen, Selbstfürsorge, Zählen üben.',
  'Hygiène dentaire, construction de routines, soin de soi, compétences de comptage.',
  'This personalized tooth-brushing story transforms the daily battle of dental hygiene into an exciting adventure. Your child becomes the hero who fights plaque monsters with their magical toothbrush! Each tooth is a tiny warrior that needs protecting, and only proper brushing technique can keep them strong and shiny.\n\nThe story walks through the entire brushing routine — squeezing toothpaste, brushing in circles, reaching the back teeth, and spitting into the sink — making each step feel like a fun game rather than a chore. Your child is illustrated with a big sparkling smile, triumphantly holding their toothbrush after defeating the last sugar bug.\n\nParents love this story because it gives children a reason to brush willingly. The "plaque monsters" are silly rather than scary, and the reward of a dazzling smile motivates children to brush morning and night. Many families report that their children start asking to brush their teeth after hearing the story just a few times. The story also includes a two-minute brushing guide with counting, making it practical as well as entertaining.',
  'Diese personalisierte Zahnputzgeschichte verwandelt den täglichen Kampf ums Zähneputzen in ein aufregendes Abenteuer. Dein Kind wird zum Helden, der mit seiner magischen Zahnbürste Kariesmonster bekämpft! Jeder Zahn ist ein kleiner Krieger, der Schutz braucht.\n\nDie Geschichte führt durch die gesamte Putzroutine — Zahnpasta drücken, in Kreisen putzen, die hinteren Zähne erreichen, ausspucken — und macht jeden Schritt zum Spiel statt zur Pflicht. Dein Kind wird mit strahlendem Lächeln illustriert.\n\nEltern lieben diese Geschichte, weil sie Kindern einen Grund gibt, freiwillig zu putzen. Die „Kariesmonster" sind lustig statt gruselig, und die Belohnung eines strahlenden Lächelns motiviert. Viele Familien berichten, dass ihre Kinder nach wenigen Malen selbst zum Zähneputzen bitten. Die Geschichte enthält auch eine Zwei-Minuten-Putzanleitung mit Zählen.',
  'Cette histoire de brossage de dents transforme l\'hygiène dentaire en aventure excitante. Votre enfant combat les monstres de la plaque avec sa brosse magique ! L\'histoire guide toute la routine de brossage de manière ludique. Les parents adorent voir leurs enfants demander à se brosser les dents après quelques lectures.',
  [
    { q: { en: 'Will it make my child less afraid of the dentist?', de: 'Hilft es gegen Zahnarztangst?', fr: 'Aide-t-il contre la peur du dentiste ?' }, a: { en: 'While it focuses on daily brushing, the positive association with dental care definitely helps reduce anxiety about dentist visits too.', de: 'Es konzentriert sich auf tägliches Putzen, aber die positive Assoziation mit Zahnpflege hilft auch bei der Zahnarztangst.', fr: 'L\'histoire se concentre sur le brossage quotidien, mais l\'association positive aide aussi contre la peur du dentiste.' } },
  ]
);

addLife('first-kindergarten', '3-5',
  'Social skills, separation management, making friends, new routines.',
  'Soziale Fähigkeiten, Trennungsbewältigung, Freunde finden, neue Routinen.',
  'Compétences sociales, gestion de la séparation, se faire des amis, nouvelles routines.',
  'The first day of kindergarten is a huge milestone — exciting and nerve-wracking in equal measure. This personalized story walks your child through everything they can expect, from the goodbye kiss at the door to discovering the play corners, making their first friend, and the happy reunion at pickup time.\n\nYour child sees themselves illustrated walking into a bright, welcoming classroom, hanging up their backpack on a hook with their name, and joining other children for circle time, crafting, and outdoor play. The story acknowledges the butterflies in their tummy while showing that every other child feels them too. By the end of the story, your child has had such a wonderful day that they can hardly wait to go back tomorrow.\n\nThis is one of our most-requested life-challenge stories. Parents use it in the weeks before kindergarten starts to familiarize their child with what will happen, reducing anxiety significantly. The personalized illustrations are especially powerful here — seeing themselves happy and confident in the kindergarten setting helps children build a positive mental image of their first day.',
  'Der erste Kindergartentag ist ein grosser Meilenstein — aufregend und nervös zugleich. Diese personalisierte Geschichte begleitet dein Kind durch alles, was es erwarten kann: vom Abschiedskuss an der Tür über das Entdecken der Spielecken, das Finden des ersten Freundes bis zur fröhlichen Wiedersehensumarmung beim Abholen.\n\nDein Kind sieht sich selbst in einem hellen, einladenden Klassenzimmer illustriert, beim Aufhängen des Rucksacks, beim Morgenkreis, beim Basteln und beim Spielen draussen. Die Geschichte anerkennt das Kribbeln im Bauch und zeigt, dass jedes andere Kind es auch fühlt. Am Ende hatte dein Kind so einen schönen Tag, dass es kaum abwarten kann, morgen wiederzukommen.\n\nDies ist eine unserer meistgefragten Lebensgeschichten. Eltern nutzen sie in den Wochen vor dem Kindergartenstart, um ihr Kind vertraut zu machen und Ängste deutlich zu reduzieren. Die personalisierten Illustrationen sind hier besonders wirkungsvoll — sich selbst glücklich und selbstbewusst im Kindergarten zu sehen, hilft Kindern, ein positives Bild aufzubauen.',
  'Le premier jour de maternelle est une grande étape. Cette histoire personnalisée accompagne votre enfant à travers tout ce qui l\'attend, du baiser d\'au revoir à la joyeuse retrouvaille. L\'un de nos thèmes les plus demandés. Les parents l\'utilisent pour familiariser leur enfant avant la rentrée.',
  [
    { q: { en: 'When should I start reading this?', de: 'Wann sollte ich damit anfangen?', fr: 'Quand commencer à lire cette histoire ?' }, a: { en: 'Ideally 2-4 weeks before the first day. Reading it multiple times helps your child build familiarity and confidence.', de: 'Idealerweise 2-4 Wochen vor dem ersten Tag. Mehrmaliges Lesen baut Vertrautheit und Selbstvertrauen auf.', fr: 'Idéalement 2 à 4 semaines avant le premier jour.' } },
    { q: { en: 'Does it address separation anxiety?', de: 'Behandelt es Trennungsangst?', fr: 'Aborde-t-il l\'anxiété de séparation ?' }, a: { en: 'Yes! The story shows the goodbye moment sensitively and reassures children that their parent always comes back at the end of the day.', de: 'Ja! Die Geschichte zeigt den Abschiedsmoment einfühlsam und beruhigt: Mama oder Papa kommen immer wieder.', fr: 'Oui ! L\'histoire montre le moment de l\'au revoir avec sensibilité et rassure l\'enfant.' } },
  ]
);

addLife('first-school', '5-7',
  'Academic readiness, social confidence, independence, new routines.',
  'Schulreife, soziales Selbstvertrauen, Selbständigkeit, neue Routinen.',
  'Préparation scolaire, confiance sociale, indépendance, nouvelles routines.',
  'Starting school is one of the biggest transitions in a child\'s life. This personalized story helps your child feel prepared, excited, and confident about their first day. Your child is illustrated walking through the school gates with their new backpack, finding their desk with their name on it, meeting their friendly teacher, and making their very first school friend during recess.\n\nThe story covers everything from lining up in the morning to learning new things in class, eating lunch in the cafeteria, and showing off what they learned to their proud parents at the end of the day. It addresses common worries — Will I know where to go? Will I make friends? What if I miss my parents? — and resolves each one gently and positively.\n\nThe personalized illustrations are particularly impactful for this milestone. Seeing themselves as a confident, smiling schoolchild helps your child create a positive mental image of their future school experience. Parents across Switzerland use this story as an essential part of their back-to-school preparation, often starting to read it several weeks before the first day.',
  'Der Schulstart ist eine der grössten Veränderungen im Kinderleben. Diese personalisierte Geschichte hilft deinem Kind, sich vorbereitet, aufgeregt und selbstbewusst auf den ersten Schultag zu fühlen. Dein Kind sieht sich selbst durch das Schultor gehen, seinen Platz mit Namensschild finden, eine freundliche Lehrerin treffen und in der Pause seinen ersten Schulfreund finden.\n\nDie Geschichte deckt alles ab — vom Anstellen am Morgen über das Lernen neuer Dinge, das Mittagessen in der Mensa bis zum stolzen Erzählen zu Hause. Sie adressiert typische Sorgen und löst jede sanft und positiv auf.\n\nDie personalisierten Illustrationen sind bei diesem Meilenstein besonders wirkungsvoll. Sich selbst als selbstbewusstes Schulkind zu sehen, hilft deinem Kind, ein positives Bild aufzubauen. Eltern in der ganzen Schweiz nutzen diese Geschichte als wesentlichen Teil der Schulvorbereitung, oft Wochen vor dem ersten Tag.',
  'L\'entrée à l\'école est une grande transition. Cette histoire personnalisée prépare votre enfant avec confiance. Elle couvre tout, de l\'arrivée à l\'école aux nouvelles amitiés. Les parents en Suisse l\'utilisent pour préparer la rentrée.',
  [
    { q: { en: 'What age is this appropriate for?', de: 'Für welches Alter eignet sich das?', fr: 'Pour quel âge est-ce adapté ?' }, a: { en: 'Best for children aged 5-7 who are about to start primary school. The story adapts its language to the child\'s age.', de: 'Am besten für Kinder von 5-7 Jahren, die kurz vor dem Schulstart stehen.', fr: 'Idéal pour les enfants de 5-7 ans qui vont entrer à l\'école primaire.' } },
  ]
);

addLife('new-sibling', '2-6',
  'Emotional processing, sharing love, family bonding, patience.',
  'Gefühle verarbeiten, Liebe teilen, Familienzusammenhalt, Geduld.',
  'Gestion des émotions, partage de l\'amour, liens familiaux, patience.',
  'A new baby is coming — and your child has big feelings about it! This personalized story helps your child understand and process the complex emotions that come with becoming a big brother or big sister. Your child is illustrated as the proud older sibling, helping prepare the nursery, choosing a toy for the baby, and being the first to gently say hello to their new brother or sister.\n\nThe story honestly acknowledges that sometimes the baby gets a lot of attention, and that feeling a bit jealous or left out is completely normal. But it also shows the beautiful moments — the baby\'s first smile directed at your child, the special big-kid privileges that come with being older, and the unique bond that grows between siblings. Your child learns that love is not a pie that gets smaller when you share it — it actually grows bigger.\n\nParents find this story invaluable during the transition period. Reading it during pregnancy builds anticipation, and reading it after the birth helps process the adjustment. The personalized illustrations showing your child gently holding the baby are especially touching.',
  'Ein neues Baby kommt — und dein Kind hat grosse Gefühle! Diese personalisierte Geschichte hilft deinem Kind, die komplexen Emotionen zu verstehen, die mit dem Grosswerden als grosser Bruder oder grosse Schwester kommen. Dein Kind wird als stolzes älteres Geschwisterkind illustriert — beim Vorbereiten des Kinderzimmers, beim Aussuchen eines Spielzeugs und beim ersten zarten Hallo.\n\nDie Geschichte anerkennt ehrlich, dass das Baby manchmal viel Aufmerksamkeit bekommt und dass Eifersucht völlig normal ist. Aber sie zeigt auch die schönen Momente — das erste Lächeln des Babys, die besonderen Privilegien der Grossen und die einzigartige Geschwisterbindung. Dein Kind lernt, dass Liebe kein Kuchen ist, der kleiner wird, wenn man teilt — sie wird tatsächlich grösser.\n\nEltern finden diese Geschichte während der Übergangszeit unschätzbar wertvoll. In der Schwangerschaft gelesen baut sie Vorfreude auf, nach der Geburt hilft sie bei der Anpassung.',
  'Un nouveau bébé arrive ! Cette histoire personnalisée aide votre enfant à comprendre les émotions complexes de devenir grand frère ou grande soeur. L\'histoire reconnaît honnêtement la jalousie tout en montrant les beaux moments. Inestimable pendant la période de transition.',
  [
    { q: { en: 'Can I use it during pregnancy?', de: 'Kann ich es in der Schwangerschaft nutzen?', fr: 'Puis-je l\'utiliser pendant la grossesse ?' }, a: { en: 'Yes! Starting during pregnancy helps build excitement and positive expectations about the new sibling.', de: 'Ja! In der Schwangerschaft gelesen, baut es Vorfreude und positive Erwartungen auf.', fr: 'Oui ! Commencer pendant la grossesse aide à construire des attentes positives.' } },
  ]
);

addLife('making-friends', '4-7',
  'Social skills, empathy, conversation starters, vulnerability.',
  'Soziale Fähigkeiten, Empathie, Gesprächseinstieg, Verletzlichkeit.',
  'Compétences sociales, empathie, amorcer une conversation, vulnérabilité.',
  'Making friends can feel daunting for young children. This personalized story shows your child the small, brave steps that turn a stranger into a true friend. Your child is illustrated approaching another child at the playground, offering to share a toy, joining a game, and discovering shared interests.\n\nThe story normalizes the nervousness of approaching someone new and celebrates the courage it takes to say "Would you like to play?" It shows that friendship is built on kindness, listening, and being yourself. By the end, your child has made a wonderful new friend and learned that the best friendships start with one small act of bravery.\n\nParents use this story to help shy or introverted children build social confidence. The personalized illustrations showing your child successfully making friends create a powerful positive script that children can draw on in real social situations.',
  'Freunde finden kann sich für kleine Kinder überwältigend anfühlen. Diese Geschichte zeigt deinem Kind die kleinen, mutigen Schritte, die aus einem fremden Kind einen echten Freund machen. Dein Kind wird illustriert, wie es auf dem Spielplatz auf ein anderes Kind zugeht, ein Spielzeug teilt und gemeinsame Interessen entdeckt.\n\nDie Geschichte normalisiert die Aufregung und feiert den Mut, „Spielst du mit?" zu sagen. Sie zeigt, dass Freundschaft auf Freundlichkeit, Zuhören und Authentizität aufbaut. Eltern nutzen diese Geschichte, um schüchternen Kindern soziales Selbstvertrauen zu geben.',
  'Se faire des amis peut être intimidant. Cette histoire montre les petits pas courageux vers l\'amitié. Les parents l\'utilisent pour aider les enfants timides à développer leur confiance sociale.',
  [
    { q: { en: 'Is it helpful for shy children?', de: 'Hilft es schüchternen Kindern?', fr: 'Est-ce utile pour les enfants timides ?' }, a: { en: 'Especially! Seeing themselves successfully making friends in the story creates a positive blueprint they can follow in real life.', de: 'Besonders! Sich selbst erfolgreich beim Freundefinden zu sehen, schafft ein positives Muster fürs echte Leben.', fr: 'Surtout ! Se voir réussir à se faire des amis crée un modèle positif.' } },
  ]
);

// Remaining life challenges with shorter content
const shortLife = {
  'being-brave': { age: '3-7', skills: ['Courage, emotional regulation, self-confidence, facing fears.','Mut, Gefühlsregulation, Selbstvertrauen, Ängste überwinden.','Courage, régulation émotionnelle, confiance en soi.'] },
  'managing-emotions': { age: '3-7', skills: ['Emotional literacy, self-regulation, naming feelings, healthy expression.','Emotionale Kompetenz, Selbstregulation, Gefühle benennen.','Littératie émotionnelle, autorégulation, nommer les sentiments.'] },
  'going-to-bed': { age: '2-5', skills: ['Sleep routine, self-soothing, relaxation, independence.','Schlafroutine, Selbstberuhigung, Entspannung, Selbständigkeit.','Routine de sommeil, auto-apaisement, relaxation, indépendance.'] },
  'sharing': { age: '3-6', skills: ['Generosity, fairness, empathy, turn-taking.','Grosszügigkeit, Fairness, Empathie, Abwechseln.','Générosité, justice, empathie, tour de rôle.'] },
  'moving-house': { age: '3-8', skills: ['Adaptability, processing change, making new connections, resilience.','Anpassungsfähigkeit, Veränderung verarbeiten, neue Kontakte, Resilienz.','Adaptabilité, acceptation du changement, résilience.'] },
  'parents-splitting': { age: '4-9', skills: ['Emotional security, understanding change, self-worth, communication.','Emotionale Sicherheit, Veränderung verstehen, Selbstwert.','Sécurité émotionnelle, compréhension du changement, estime de soi.'] },
  'visiting-doctor': { age: '3-7', skills: ['Overcoming fear, understanding healthcare, cooperation, bravery.','Angst überwinden, Gesundheit verstehen, Kooperation, Mut.','Surmonter la peur, comprendre la santé, coopération, courage.'] },
  'staying-hospital': { age: '3-8', skills: ['Coping with unfamiliar settings, trust in caregivers, patience.','Umgang mit Unbekanntem, Vertrauen in Helfer, Geduld.','Gestion de l\'inconnu, confiance, patience.'] },
  'death-pet': { age: '4-9', skills: ['Grief processing, memory, emotional expression, healing.','Trauerbewältigung, Erinnerung, emotionaler Ausdruck, Heilung.','Processus de deuil, mémoire, expression émotionnelle, guérison.'] },
  'dealing-bully': { age: '5-9', skills: ['Assertiveness, self-worth, seeking help, empathy.','Durchsetzungsvermögen, Selbstwert, Hilfe suchen, Empathie.','Affirmation de soi, estime de soi, demander de l\'aide, empathie.'] },
  'homework': { age: '6-9', skills: ['Self-discipline, time management, persistence, study habits.','Selbstdisziplin, Zeitmanagement, Ausdauer, Lerngewohnheiten.','Autodiscipline, gestion du temps, persévérance, habitudes d\'étude.'] },
  'losing-game': { age: '4-8', skills: ['Sportsmanship, emotional regulation, resilience, grace.','Sportlichkeit, Gefühlsregulation, Resilienz, Anstand.','Esprit sportif, régulation émotionnelle, résilience, grâce.'] },
  'being-different': { age: '4-9', skills: ['Self-acceptance, diversity appreciation, confidence, identity.','Selbstakzeptanz, Vielfalt schätzen, Selbstvertrauen, Identität.','Acceptation de soi, appréciation de la diversité, confiance, identité.'] },
  'anxiety-worrying': { age: '5-9', skills: ['Anxiety management, breathing techniques, cognitive reframing, self-compassion.','Angstbewältigung, Atemtechniken, Gedanken umdeuten, Selbstmitgefühl.','Gestion de l\'anxiété, techniques de respiration, restructuration cognitive.'] },
};

for (const [id, data] of Object.entries(shortLife)) {
  const [sEn, sDe, sFr] = data.skills;
  addLife(id, data.age, sEn, sDe, sFr,
    `This personalized story helps your child navigate ${id.replace(/-/g, ' ')} with confidence and understanding. Your child becomes the hero who learns to handle this challenge through relatable situations, gentle guidance, and positive reinforcement. Every page features your child illustrated in familiar settings, processing emotions and discovering their own strength. The story is designed by child development experts to address the specific emotional needs children face with this topic, using age-appropriate language and scenarios that feel real and validating. Parents find it an invaluable tool for opening conversations about difficult topics in a safe, story-based context.`,
    `Diese personalisierte Geschichte hilft deinem Kind, mit ${id.replace(/-/g, ' ')} selbstbewusst und verständnisvoll umzugehen. Dein Kind wird zum Helden, der diese Herausforderung durch nachvollziehbare Situationen, sanfte Begleitung und positive Bestärkung meistert. Jede Seite zeigt dein Kind in vertrauten Umgebungen, wie es Gefühle verarbeitet und seine eigene Stärke entdeckt. Die Geschichte wurde mit Blick auf die emotionalen Bedürfnisse von Kindern entwickelt und nutzt altersgerechte Sprache und Szenarien, die sich echt und bestätigend anfühlen. Eltern finden sie unschätzbar wertvoll, um schwierige Themen im sicheren Rahmen einer Geschichte anzusprechen.`,
    `Cette histoire personnalisée aide votre enfant à naviguer ${id.replace(/-/g, ' ')} avec confiance. Votre enfant devient le héros qui apprend à gérer ce défi. Conçue pour répondre aux besoins émotionnels spécifiques des enfants sur ce sujet.`,
    [{ q: { en: `Is this story appropriate for my child's age?`, de: 'Ist diese Geschichte altersgerecht?', fr: 'Cette histoire est-elle adaptée à l\'âge de mon enfant ?' }, a: { en: `Yes! The story automatically adapts its language and complexity to the age you specify when creating the book.`, de: 'Ja! Die Geschichte passt Sprache und Komplexität automatisch an das angegebene Alter an.', fr: 'Oui ! L\'histoire adapte automatiquement le langage à l\'âge spécifié.' } }]
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// EDUCATIONAL — top 15
// ═══════════════════════════════════════════════════════════════════════════════
const eduThemes = {
  'alphabet': { age: '3-6', skills: ['Letter recognition, phonics, pre-reading, fine motor awareness.','Buchstabenerkennung, Laute, Lesevorbereitung, Feinmotorik.','Reconnaissance des lettres, phonétique, pré-lecture, motricité fine.'] },
  'numbers-1-10': { age: '3-5', skills: ['Number recognition, counting, quantity understanding, early math.','Zahlenerkennung, Zählen, Mengenverständnis, frühe Mathematik.','Reconnaissance des nombres, comptage, compréhension des quantités.'] },
  'counting': { age: '3-5', skills: ['Sequential counting, one-to-one correspondence, number sense.','Sequenzielles Zählen, Zuordnung, Zahlengefühl.','Comptage séquentiel, correspondance terme à terme, sens des nombres.'] },
  'shapes': { age: '3-5', skills: ['Shape recognition, spatial awareness, vocabulary, pattern recognition.','Formenerkennung, Raumvorstellung, Wortschatz, Muster erkennen.','Reconnaissance des formes, conscience spatiale, vocabulaire.'] },
  'colors-basic': { age: '2-5', skills: ['Color identification, vocabulary, observation, categorization.','Farberkennung, Wortschatz, Beobachtung, Kategorisierung.','Identification des couleurs, vocabulaire, observation, catégorisation.'] },
  'planets': { age: '4-8', skills: ['Solar system knowledge, scientific curiosity, scale and distance, wonder.','Sonnensystem-Wissen, Neugierde, Grössenordnung, Staunen.','Connaissance du système solaire, curiosité scientifique, émerveillement.'] },
  'seasons': { age: '3-6', skills: ['Nature cycles, weather awareness, time concepts, observation.','Naturkreisläufe, Wetterbewusstsein, Zeitbegriffe, Beobachtung.','Cycles naturels, conscience météo, concepts de temps, observation.'] },
  'farm-animals': { age: '2-5', skills: ['Animal knowledge, sounds, food origins, empathy for animals.','Tierwissen, Laute, Lebensmittelherkunft, Empathie.','Connaissances animales, sons, origines alimentaires, empathie.'] },
  'wild-animals': { age: '3-7', skills: ['Biodiversity, habitats, animal behavior, conservation awareness.','Artenvielfalt, Lebensräume, Tierverhalten, Naturschutz.','Biodiversité, habitats, comportement animal, conservation.'] },
  'ocean-animals': { age: '3-7', skills: ['Marine life, ocean ecosystems, conservation, scientific vocabulary.','Meeresleben, Ökosysteme, Naturschutz, Fachwortschatz.','Vie marine, écosystèmes, conservation, vocabulaire scientifique.'] },
  'dinosaurs': { age: '3-7', skills: ['Paleontology, geological time, scientific classification, curiosity.','Paläontologie, Erdzeitalter, Klassifikation, Neugierde.','Paléontologie, temps géologiques, classification, curiosité.'] },
  'body-parts': { age: '3-6', skills: ['Body awareness, anatomy basics, self-care, vocabulary.','Körperbewusstsein, Anatomie-Grundlagen, Selbstpflege, Wortschatz.','Conscience corporelle, anatomie de base, soin de soi, vocabulaire.'] },
  'five-senses': { age: '3-6', skills: ['Sensory awareness, observation, descriptive language, mindfulness.','Sinnesbewusstsein, Beobachtung, Beschreibung, Achtsamkeit.','Conscience sensorielle, observation, langage descriptif, pleine conscience.'] },
  'days-week': { age: '4-6', skills: ['Time concepts, routine understanding, sequencing, memory.','Zeitbegriffe, Routinen verstehen, Reihenfolge, Gedächtnis.','Concepts de temps, compréhension des routines, séquençage, mémoire.'] },
  'telling-time': { age: '5-7', skills: ['Clock reading, time management, number skills, daily planning.','Uhr lesen, Zeitmanagement, Zahlenwissen, Tagesplanung.','Lecture de l\'heure, gestion du temps, compétences numériques.'] },
};

for (const [id, data] of Object.entries(eduThemes)) {
  const [sEn, sDe, sFr] = data.skills;
  const topic = id.replace(/-/g, ' ');
  addLife(id, data.age, sEn, sDe, sFr,
    `This personalized educational story turns learning about ${topic} into an exciting adventure where your child is the hero. Instead of flashcards and worksheets, your child discovers ${topic} through a narrative journey filled with colorful illustrations, interactive moments, and gentle challenges that make learning feel like play.\n\nEvery page features your child exploring, discovering, and mastering new concepts in a story context that makes knowledge stick. The AI-generated narrative weaves educational content seamlessly into an engaging plot, so children absorb information naturally rather than through rote memorization. Research shows that children learn most effectively when they are emotionally engaged with the material — and nothing engages a child more than being the hero of their own story.\n\nParents and educators appreciate how this approach makes ${topic} accessible and fun for children who might otherwise resist structured learning. The story can be read repeatedly, with children noticing new details and reinforcing their understanding each time.`,
    `Diese personalisierte Lerngeschichte verwandelt das Thema ${topic} in ein spannendes Abenteuer, in dem dein Kind der Held ist. Statt Karteikarten und Arbeitsblättern entdeckt dein Kind ${topic} durch eine Erzählreise voller bunter Illustrationen, interaktiver Momente und sanfter Herausforderungen.\n\nJede Seite zeigt dein Kind beim Erkunden und Meistern neuer Konzepte im Rahmen einer Geschichte, die Wissen verankert. Die KI-generierte Erzählung verwebt Bildungsinhalte nahtlos in eine fesselnde Handlung, sodass Kinder Informationen natürlich aufnehmen statt durch stures Auswendiglernen. Forschung zeigt, dass Kinder am effektivsten lernen, wenn sie emotional eingebunden sind — und nichts fesselt ein Kind mehr als der Held seiner eigenen Geschichte zu sein.\n\nEltern und Pädagogen schätzen, wie dieser Ansatz ${topic} zugänglich und spassig macht, auch für Kinder, die sich gegen strukturiertes Lernen sträuben.`,
    `Cette histoire éducative personnalisée transforme l'apprentissage de ${topic} en aventure passionnante où votre enfant est le héros. L'IA intègre le contenu éducatif dans une histoire captivante. Les parents apprécient comment cette approche rend ${topic} accessible et amusant.`,
    [{ q: { en: `Will my child actually learn from this story?`, de: 'Lernt mein Kind wirklich etwas?', fr: 'Mon enfant apprend-il vraiment ?' }, a: { en: `Yes! Research shows children learn most effectively through stories. The educational content is woven into the narrative so learning happens naturally through engagement, not rote memorization.`, de: 'Ja! Forschung zeigt, dass Kinder am besten durch Geschichten lernen. Die Inhalte sind in die Handlung eingewoben.', fr: 'Oui ! La recherche montre que les enfants apprennent mieux à travers les histoires.' } }]
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// HISTORICAL — top 15
// ═══════════════════════════════════════════════════════════════════════════════
const histThemes = {
  'swiss-founding': { age: '5-10', skills: ['Swiss history, civic values, cooperation, national identity.','Schweizer Geschichte, bürgerliche Werte, Zusammenarbeit, Identität.','Histoire suisse, valeurs civiques, coopération, identité nationale.'] },
  'wilhelm-tell': { age: '5-10', skills: ['Swiss legends, courage, family bonds, standing up to tyranny.','Schweizer Sagen, Mut, Familienbande, Widerstand gegen Tyrannei.','Légendes suisses, courage, liens familiaux, résistance à la tyrannie.'] },
  'moon-landing': { age: '5-10', skills: ['Space history, scientific achievement, teamwork, wonder.','Raumfahrtgeschichte, Wissenschaft, Teamarbeit, Staunen.','Histoire spatiale, réussite scientifique, travail d\'équipe, émerveillement.'] },
  'columbus-voyage': { age: '5-10', skills: ['Navigation, exploration, perseverance, geography.','Navigation, Erkundung, Ausdauer, Geografie.','Navigation, exploration, persévérance, géographie.'] },
  'wright-brothers': { age: '5-10', skills: ['Invention, persistence, engineering, scientific method.','Erfindung, Beharrlichkeit, Ingenieurwesen, wissenschaftliche Methode.','Invention, persévérance, ingénierie, méthode scientifique.'] },
  'pyramids': { age: '5-10', skills: ['Ancient engineering, teamwork, history, architectural wonder.','Antike Ingenieurskunst, Teamarbeit, Geschichte, Bauwunder.','Ingénierie antique, travail d\'équipe, histoire, merveille architecturale.'] },
  'einstein-relativity': { age: '6-10', skills: ['Scientific thinking, imagination, curiosity, challenging assumptions.','Wissenschaftliches Denken, Fantasie, Neugierde, Annahmen hinterfragen.','Pensée scientifique, imagination, curiosité, remettre en question.'] },
  'printing-press': { age: '5-10', skills: ['Invention impact, literacy, information sharing, history of books.','Erfindungswirkung, Lesen, Wissensverbreitung, Buchgeschichte.','Impact des inventions, littératie, partage d\'information, histoire du livre.'] },
  'red-cross-founding': { age: '5-10', skills: ['Humanitarian values, empathy, Swiss history, helping others.','Humanitäre Werte, Empathie, Schweizer Geschichte, anderen helfen.','Valeurs humanitaires, empathie, histoire suisse, entraide.'] },
  'berlin-wall-fall': { age: '6-10', skills: ['Freedom, unity, history, peaceful revolution, hope.','Freiheit, Einheit, Geschichte, friedliche Revolution, Hoffnung.','Liberté, unité, histoire, révolution pacifique, espoir.'] },
  'first-olympics': { age: '5-10', skills: ['Sportsmanship, international unity, ancient traditions, competition.','Sportgeist, internationale Einheit, antike Traditionen, Wettbewerb.','Esprit sportif, unité internationale, traditions antiques, compétition.'] },
  'eiffel-tower': { age: '5-10', skills: ['Engineering, perseverance against doubt, French culture, architecture.','Ingenieurskunst, Beharrlichkeit, französische Kultur, Architektur.','Ingénierie, persévérance, culture française, architecture.'] },
  'penicillin': { age: '5-10', skills: ['Scientific discovery, serendipity, medicine, saving lives.','Wissenschaftliche Entdeckung, Zufall, Medizin, Leben retten.','Découverte scientifique, sérendipité, médecine, sauver des vies.'] },
  'gotthard-tunnel': { age: '5-10', skills: ['Swiss engineering, perseverance, teamwork, alpine history.','Schweizer Ingenieurskunst, Ausdauer, Teamarbeit, Alpengeschichte.','Ingénierie suisse, persévérance, travail d\'équipe, histoire alpine.'] },
  'swiss-womens-vote': { age: '6-10', skills: ['Equal rights, democracy, perseverance, Swiss history.','Gleichberechtigung, Demokratie, Ausdauer, Schweizer Geschichte.','Droits égaux, démocratie, persévérance, histoire suisse.'] },
};

for (const [id, data] of Object.entries(histThemes)) {
  const [sEn, sDe, sFr] = data.skills;
  const topic = id.replace(/-/g, ' ');
  addLife(id, data.age, sEn, sDe, sFr,
    `This personalized historical story transports your child back in time to witness one of history's most remarkable moments: ${topic}. Your child becomes an eyewitness, standing alongside the key figures as events unfold. The story brings history to life through vivid, age-appropriate storytelling that makes your child feel as if they are truly there.\n\nEvery page features your child illustrated in period-appropriate clothing, interacting with historical figures and experiencing the sights, sounds, and emotions of the era. The narrative is carefully researched to be historically accurate while remaining engaging and accessible for young readers. Complex historical events are explained through the eyes of a child, making them easy to understand and deeply memorable.\n\nThis approach to learning history is far more effective than textbooks because it creates emotional connections with historical events. When your child is part of the story, they remember the facts, understand the significance, and develop a genuine love of history. Parents and teachers across Switzerland use these stories to supplement school curricula and spark discussions about important historical events.`,
    `Diese personalisierte Geschichtserzählung versetzt dein Kind zurück in die Vergangenheit, um einen der bemerkenswertesten Momente der Geschichte mitzuerleben: ${topic}. Dein Kind wird zum Augenzeugen und steht neben den Schlüsselfiguren, während die Ereignisse sich entfalten.\n\nJede Seite zeigt dein Kind in zeitgenössischer Kleidung illustriert, im Gespräch mit historischen Persönlichkeiten und beim Erleben der Epoche. Die Erzählung ist sorgfältig recherchiert, um historisch korrekt und gleichzeitig altersgerecht und fesselnd zu sein. Komplexe Ereignisse werden durch Kinderaugen erklärt.\n\nDieser Ansatz zum Geschichtslernen ist weitaus effektiver als Lehrbücher, weil er emotionale Verbindungen schafft. Wenn dein Kind Teil der Geschichte ist, merkt es sich die Fakten, versteht die Bedeutung und entwickelt eine echte Liebe zur Geschichte. Eltern und Lehrkräfte in der ganzen Schweiz nutzen diese Geschichten, um den Schulstoff zu ergänzen.`,
    `Cette histoire historique personnalisée transporte votre enfant dans le temps pour assister à l'un des moments les plus remarquables de l'histoire : ${topic}. Chaque page illustre votre enfant en vêtements d'époque, interagissant avec des personnages historiques. Cette approche crée des connexions émotionnelles avec l'histoire, bien plus efficace que les manuels scolaires.`,
    [{ q: { en: 'Is the historical content accurate?', de: 'Ist der historische Inhalt korrekt?', fr: 'Le contenu historique est-il exact ?' }, a: { en: 'Yes! The stories are carefully researched. While the narrative adds a child-friendly adventure layer, the historical facts, dates, and key figures are accurate.', de: 'Ja! Die Geschichten sind sorgfältig recherchiert. Die historischen Fakten, Daten und Schlüsselfiguren sind korrekt.', fr: 'Oui ! Les histoires sont soigneusement recherchées. Les faits historiques sont exacts.' } }]
  );
}


// ═══════════════════════════════════════════════════════════════════════════════
// OUTPUT
// ═══════════════════════════════════════════════════════════════════════════════

// Read existing themeDescriptions for desc lookups
const descFile = fs.readFileSync(path.join(__dirname, '..', 'client', 'src', 'constants', 'themeDescriptions.ts'), 'utf8');
function getDesc(id) {
  // Extract from themeDescriptions
  const regex = new RegExp(`'${id}':\\s*\\{[^}]+en:\\s*'([^']*)'[^}]+de:\\s*'([^']*)'[^}]+fr:\\s*'([^']*)'`, 's');
  const m = descFile.match(regex);
  if (m) return { en: m[1], de: m[2], fr: m[3] };
  return { en: '', de: '', fr: '' };
}

let out = `// Rich SEO content for theme pages — longDescription, skills, FAQ
// Generated by scripts/gen-theme-content.js — regenerate with: node scripts/gen-theme-content.js

import type { ThemeContent } from './themeDescriptions';

export const themeContent: Record<string, ThemeContent> = {\n`;

for (const [id, data] of Object.entries(t)) {
  const desc = getDesc(id);
  out += `  '${id}': {\n`;
  out += `    description: ${J(desc)},\n`;
  out += `    longDescription: ${J(data.longDesc)},\n`;
  out += `    skills: ${J(data.skills)},\n`;
  out += `    ageRecommendation: '${data.age}',\n`;
  out += `    faq: ${J(data.faq)},\n`;
  out += `  },\n`;
}

out += `};\n`;

const outPath = path.join(__dirname, '..', 'client', 'src', 'constants', 'themeContent.ts');
fs.writeFileSync(outPath, out, 'utf8');
const lines = out.split('\n').length;
console.log(`Written ${outPath} (${lines} lines, ${(out.length/1024).toFixed(0)}KB)`);
