/**
 * The funny lines of the generation waiting screens (trial slideshow and the full-story progress panel).
 * ONE list, both screens: until 2026-10-09 the trial page kept 32 lines and GenerationProgress 25, 8 of them the same,
 * so each screen showed the other's best lines never (owner: "we had much better and more funny messages earlier").
 * Every line has {name} (the hero) except the nameless ones, which a resumed page without a character name uses.
 * Swiss spelling: ss, never the eszett. The rotation never repeats a line until all are used (funnyDeck).
 * docs/decisions.md 2026-10-09 "Funny messages".
 */
export interface FunnyMessage { en: string; de: string; fr: string; it: string }

export const FUNNY_MESSAGES: FunnyMessage[] = [
  { en: '{name} is getting ready for their big adventure...', de: '{name} macht sich bereit für das grosse Abenteuer...', fr: '{name} se prépare pour sa grande aventure…', it: '{name} si sta preparando per la grande avventura...' },
  { en: '{name} is practicing their hero pose...', de: '{name} übt gerade die Heldenpose...', fr: '{name} s\'entraîne à prendre la pose du héros…', it: '{name} sta provando la posa da eroe...' },
  { en: '{name} can\'t wait to see what happens next!', de: '{name} kann es kaum erwarten zu sehen, was als Nächstes passiert!', fr: '{name} a hâte de voir ce qui va se passer !', it: '{name} non vede l\'ora di sapere come va a finire!' },
  { en: '{name} is warming up for the adventure ahead...', de: '{name} wärmt sich für das bevorstehende Abenteuer auf...', fr: '{name} s\'échauffe pour l\'aventure à venir…', it: '{name} si sta scaldando per l\'avventura che arriva...' },
  { en: '{name} just found a magic feather! Adding it to the story...', de: '{name} hat gerade eine Zauberfeder gefunden! Wir fügen sie der Geschichte hinzu...', fr: '{name} vient de trouver une plume magique ! On l\'ajoute au récit…', it: '{name} ha appena trovato una piuma magica! La mettiamo nella storia...' },
  { en: '{name} is whispering secrets to the story wizard...', de: '{name} flüstert dem Geschichtenzauberer Geheimnisse zu...', fr: '{name} chuchote des secrets au magicien des histoires…', it: '{name} sussurra segreti al mago delle storie...' },
  { en: '{name} is peeking around the corner to see what\'s coming...', de: '{name} schaut um die Ecke, um zu sehen, was kommt...', fr: '{name} jette un coup d\'œil au coin pour voir ce qui arrive…', it: '{name} sbircia dietro l\'angolo per vedere cosa arriva...' },
  { en: '{name} is doing a little happy dance!', de: '{name} macht einen kleinen Freudentanz!', fr: '{name} fait une petite danse de joie !', it: '{name} si sta facendo un balletto di gioia!' },
  { en: '{name} is collecting stars for the story...', de: '{name} sammelt Sterne für die Geschichte...', fr: '{name} collectionne des étoiles pour le récit…', it: '{name} sta raccogliendo stelle per la storia...' },
  { en: '{name} just met a friendly dragon! Making friends...', de: '{name} hat gerade einen freundlichen Drachen getroffen! Sie werden Freunde...', fr: '{name} vient de rencontrer un dragon amical ! Ils deviennent amis…', it: '{name} ha appena incontrato un drago gentile! Stanno diventando amici...' },
  { en: '{name} is looking for the perfect hiding spot...', de: '{name} sucht das perfekte Versteck...', fr: '{name} cherche la cachette parfaite…', it: '{name} cerca il nascondiglio perfetto...' },
  { en: '{name} is trying on different hats for the story...', de: '{name} probiert verschiedene Hüte für die Geschichte an...', fr: '{name} essaie différents chapeaux pour le récit…', it: '{name} sta provando cappelli diversi per la storia...' },
  { en: '{name} just spotted a rainbow! Quick, follow it...', de: '{name} hat gerade einen Regenbogen entdeckt! Schnell, hinterher...', fr: '{name} vient de repérer un arc-en-ciel ! Vite, suivons-le…', it: '{name} ha appena avvistato un arcobaleno! Presto, seguiamolo...' },
  { en: '{name} is teaching the story characters a secret handshake...', de: '{name} bringt den Figuren einen geheimen Handschlag bei...', fr: '{name} apprend une poignée de main secrète aux personnages…', it: '{name} insegna ai personaggi una stretta di mano segreta...' },
  { en: '{name} found a treasure map in their pocket!', de: '{name} hat eine Schatzkarte in der Tasche gefunden!', fr: '{name} a trouvé une carte au trésor dans sa poche !', it: '{name} ha trovato una mappa del tesoro in tasca!' },
  { en: '{name} is building a fort out of storybooks...', de: '{name} baut eine Burg aus Geschichtenbüchern...', fr: '{name} construit un fort avec des livres d\'histoires…', it: '{name} sta costruendo un castello con i libri di fiabe...' },
  { en: '{name} is chasing butterflies between chapters...', de: '{name} jagt Schmetterlinge zwischen den Kapiteln...', fr: '{name} court après les papillons entre les chapitres…', it: '{name} rincorre le farfalle fra un capitolo e l\'altro...' },
  { en: '{name} is counting shooting stars...', de: '{name} zählt Sternschnuppen...', fr: '{name} compte les étoiles filantes…', it: '{name} sta contando le stelle cadenti...' },
  { en: '{name} just learned a new magic spell!', de: '{name} hat gerade einen neuen Zauberspruch gelernt!', fr: '{name} vient d\'apprendre un nouveau sort magique !', it: '{name} ha appena imparato un nuovo incantesimo!' },
  { en: '{name} is drawing pictures in the sand...', de: '{name} malt Bilder in den Sand...', fr: '{name} dessine des images dans le sable…', it: '{name} disegna sulla sabbia...' },
  { en: '{name} packed a picnic for the adventure...', de: '{name} hat ein Picknick für das Abenteuer eingepackt...', fr: '{name} a préparé un pique-nique pour l\'aventure…', it: '{name} ha preparato un picnic per l\'avventura...' },
  { en: '{name} is tiptoeing past a sleeping giant...', de: '{name} schleicht auf Zehenspitzen an einem schlafenden Riesen vorbei...', fr: '{name} passe sur la pointe des pieds devant un géant endormi…', it: '{name} passa in punta di piedi davanti a un gigante addormentato...' },
  { en: '{name} made friends with a talking squirrel!', de: '{name} hat sich mit einem sprechenden Eichhörnchen angefreundet!', fr: '{name} s\'est lié d\'amitié avec un écureuil parlant !', it: '{name} ha fatto amicizia con uno scoiattolo parlante!' },
  { en: '{name} discovered a secret door behind the bookshelf...', de: '{name} hat eine Geheimtür hinter dem Bücherregal entdeckt...', fr: '{name} a découvert une porte secrète derrière la bibliothèque…', it: '{name} ha scoperto una porta segreta dietro la libreria...' },
  { en: '{name} is braiding flowers into a crown...', de: '{name} flicht Blumen zu einer Krone...', fr: '{name} tresse des fleurs en couronne…', it: '{name} sta intrecciando fiori per farne una corona...' },
  { en: '{name} is painting the next scene with imagination...', de: '{name} malt die nächste Szene mit viel Fantasie...', fr: '{name} peint la prochaine scène avec imagination…', it: '{name} dipinge la prossima scena con tanta fantasia...' },
  { en: 'The story wizard is adding extra sparkle for {name}...', de: 'Der Geschichtenzauberer fügt extra Glitzer für {name} hinzu...', fr: 'Le magicien ajoute des paillettes supplémentaires pour {name}…', it: 'Il mago delle storie aggiunge scintille extra per {name}...' },
  { en: '{name} is choosing the perfect adventure outfit...', de: '{name} sucht das perfekte Abenteuer-Outfit aus...', fr: '{name} choisit la tenue d\'aventure parfaite…', it: '{name} sta scegliendo il vestito perfetto per l\'avventura...' },
  { en: '{name} is sneaking into the next page already...', de: '{name} schleicht sich schon auf die nächste Seite...', fr: '{name} se glisse déjà dans la page suivante…', it: '{name} si sta già intrufolando nella pagina successiva...' },
  { en: 'The illustrator is mixing fresh paint just for {name}...', de: 'Der Illustrator mischt neue Farben — extra für {name}...', fr: 'L\'illustrateur prépare des couleurs neuves pour {name}…', it: 'L\'illustratore sta mescolando i colori freschi solo per {name}...' },
  { en: '{name} is double-checking every comma...', de: '{name} prüft noch einmal jedes Komma...', fr: '{name} relit chaque virgule…', it: '{name} sta ricontrollando ogni virgola...' },
  { en: '{name} is asking the moon for a tiny smile...', de: '{name} bittet den Mond um ein kleines Lächeln...', fr: '{name} demande à la lune un petit sourire…', it: '{name} sta chiedendo alla luna un piccolo sorriso...' },
  { en: 'A tiny dragon just offered {name} some help. Polite refusal.', de: 'Ein kleiner Drache hat {name} Hilfe angeboten. Höflich abgelehnt.', fr: 'Un petit dragon propose son aide à {name}. Refus poli.', it: 'Un draghetto ha offerto aiuto a {name}. Rifiuto gentile.' },
  { en: '{name} is collecting just one more sparkle...', de: '{name} sammelt noch ein letztes Glitzern...', fr: '{name} ramasse encore un éclat de paillette…', it: '{name} sta raccogliendo ancora una scintilla...' },
  { en: 'The story wizard mislaid a comma. Looking now.', de: 'Der Geschichtenzauberer hat ein Komma verlegt. Sucht es gerade.', fr: 'Le magicien a égaré une virgule. Il la cherche.', it: 'Il mago delle storie ha perso una virgola. La sta cercando.' },
  { en: '{name} is humming the title page tune...', de: '{name} summt die Melodie vom Titelbild...', fr: '{name} fredonne l\'air de la couverture…', it: '{name} canticchia la melodia della pagina del titolo...' },
  { en: 'Adding extra colors to {name}\'s scarf...', de: 'Mehr Farben für {name}s Schal...', fr: 'Encore des couleurs pour l\'écharpe de {name}…', it: 'Aggiungiamo altri colori alla sciarpa di {name}...' },
  { en: '{name} is reading the last chapter twice for luck...', de: '{name} liest das letzte Kapitel zweimal, für\'s Glück...', fr: '{name} relit le dernier chapitre, pour porter chance…', it: '{name} rilegge l\'ultimo capitolo due volte per fortuna...' },
  { en: 'A fox in the margins waves at {name}...', de: 'Ein Fuchs am Seitenrand winkt {name} zu...', fr: 'Un renard dans la marge salue {name}…', it: 'Una volpe ai margini saluta {name}...' },
  { en: '{name} is stretching before the final scene...', de: '{name} streckt sich vor der letzten Szene...', fr: '{name} s\'étire avant la dernière scène…', it: '{name} si sta scaldando prima della scena finale...' },
  { en: 'The font is fluffing its serifs for {name}...', de: 'Die Schrift macht ihre Serifen schön für {name}...', fr: 'La police arrange ses sérifs pour {name}…', it: 'Il carattere si sta sistemando le grazie per {name}...' },
  { en: 'Polishing the moonlight before the night scene...', de: 'Das Mondlicht wird poliert für die Nachtszene...', fr: 'On lustre le clair de lune pour la scène nocturne…', it: 'Stiamo lucidando il chiaro di luna prima della scena notturna...' },
  { en: '{name} is convincing a cloud to pose nicely...', de: '{name} überredet eine Wolke, schön zu posieren...', fr: '{name} convainc un nuage de poser joliment…', it: '{name} sta convincendo una nuvola a mettersi in posa...' },
  { en: '{name} is checking that all the leaves are the right green...', de: '{name} prüft, ob alle Blätter im richtigen Grün leuchten...', fr: '{name} vérifie que toutes les feuilles ont le bon vert…', it: '{name} controlla che tutte le foglie siano del verde giusto...' },
  { en: 'A page is being rewritten because it wasn\'t magical enough...', de: 'Eine Seite wird neu geschrieben — sie war nicht magisch genug...', fr: 'Une page est réécrite — elle n\'était pas assez magique…', it: 'Una pagina viene riscritta perché non era abbastanza magica...' },
  { en: '{name} is rehearsing the very last sentence...', de: '{name} probt den allerletzten Satz...', fr: '{name} répète la toute dernière phrase…', it: '{name} sta provando l\'ultima frase...' },
  { en: 'The story wizard is brewing one last bit of imagination...', de: 'Der Geschichtenzauberer braut die letzte Portion Fantasie...', fr: 'Le magicien brasse une dernière dose d\'imagination…', it: 'Il mago delle storie prepara un ultimo pizzico di fantasia...' },
  { en: '{name} is asking a star for an extra wish...', de: '{name} bittet einen Stern um einen weiteren Wunsch...', fr: '{name} demande à une étoile un vœu de plus…', it: '{name} sta chiedendo a una stella un desiderio in più...' },
  { en: '{name} is teaching a snail to hurry. The snail disagrees.', de: '{name} bringt einer Schnecke bei, sich zu beeilen. Die Schnecke ist anderer Meinung.', fr: '{name} apprend à un escargot à se dépêcher. L\'escargot n\'est pas d\'accord.', it: '{name} sta insegnando a una lumaca a sbrigarsi. La lumaca non è d\'accordo.' },
  { en: 'The dragon promised {name} to keep the fire small indoors...', de: 'Der Drache hat {name} versprochen, drinnen nur ein kleines Feuer zu machen...', fr: 'Le dragon a promis à {name} de faire un tout petit feu à l\'intérieur…', it: 'Il drago ha promesso a {name} di fare solo un piccolo fuoco in casa...' },
  { en: '{name} is looking for the story wizard\'s missing sock...', de: '{name} sucht die verschwundene Socke des Geschichtenzauberers...', fr: '{name} cherche la chaussette perdue du magicien des histoires…', it: '{name} cerca il calzino scomparso del mago delle storie...' },
  { en: '{name} is tying the shoelaces of a very tall giant...', de: '{name} bindet einem sehr grossen Riesen die Schuhe zu...', fr: '{name} noue les lacets d\'un très grand géant…', it: '{name} sta allacciando le scarpe a un gigante altissimo...' },
  { en: '{name} is checking under the bed for friendly monsters...', de: '{name} schaut unter dem Bett nach freundlichen Monstern...', fr: '{name} regarde sous le lit s\'il y a des monstres gentils…', it: '{name} controlla sotto il letto se ci sono mostri gentili...' },
  { en: '{name} is giving the owl a very important message...', de: '{name} gibt der Eule eine sehr wichtige Nachricht mit...', fr: '{name} confie un message très important à la chouette…', it: '{name} affida un messaggio importantissimo al gufo...' },
  { en: '{name} is writing a thank-you note to the sun...', de: '{name} schreibt der Sonne einen Dankesbrief...', fr: '{name} écrit un mot de remerciement au soleil…', it: '{name} scrive un biglietto di ringraziamento al sole...' },
  { en: '{name} is sharing a cookie with a very hungry bear...', de: '{name} teilt einen Keks mit einem sehr hungrigen Bären...', fr: '{name} partage un biscuit avec un ours très affamé…', it: '{name} divide un biscotto con un orso affamatissimo...' },
  { en: 'The pencils are holding a short meeting about the color blue...', de: 'Die Stifte halten eine kurze Besprechung über die Farbe Blau ab...', fr: 'Les crayons tiennent une petite réunion à propos du bleu…', it: 'Le matite stanno facendo una breve riunione sul colore blu...' },
  { en: 'A butterfly is proofreading the last page, very slowly...', de: 'Ein Schmetterling liest die letzte Seite Korrektur, sehr langsam...', fr: 'Un papillon relit la dernière page, très lentement…', it: 'Una farfalla rilegge l\'ultima pagina, molto lentamente...' },
  { en: 'Somewhere a book is yawning and stretching its pages...', de: 'Irgendwo gähnt ein Buch und streckt seine Seiten...', fr: 'Quelque part, un livre bâille et étire ses pages…', it: 'Da qualche parte un libro sbadiglia e stiracchia le pagine...' },
  { en: 'The rainbow is being ironed. It takes a moment.', de: 'Der Regenbogen wird gerade gebügelt. Das dauert einen Moment.', fr: 'On repasse l\'arc-en-ciel. Ça prend un instant.', it: 'Stiamo stirando l\'arcobaleno. Ci vuole un momento.' },
  { en: 'The stars are lining up for a group photo...', de: 'Die Sterne stellen sich für ein Gruppenfoto auf...', fr: 'Les étoiles se mettent en rang pour la photo de groupe…', it: 'Le stelle si mettono in fila per la foto di gruppo...' },
];

/** Lines that read without a character name. */
export const NAMELESS_FUNNY_MESSAGES = FUNNY_MESSAGES.filter(m => !m.en.includes('{name}'));

/**
 * A shuffled order of the whole pool: every line once before any line a second time (Fisher-Yates).
 * The caller draws it ONCE per page view and indexes it by slot, so a rebuild of the slideshow (new avatar
 * slides arriving) never reshuffles the captions already shown.
 */
export function funnyDeck(size: number, random: () => number = Math.random): number[] {
  const order = Array.from({ length: size }, (_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

/** The line for a slot of the deck, in the page language, with the hero's name in. */
export function funnyLine(pool: FunnyMessage[], deck: number[], slot: number, lang: 'en' | 'de' | 'fr' | 'it', name: string): string {
  const message = pool[deck[slot % deck.length]];
  return (message[lang] || message.en).replace('{name}', name);
}
