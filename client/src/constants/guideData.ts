// Editorial guides — the /ratgeber cluster.
//
// Why this exists: measured in Search Console (90d to 2026-08-22), the creation-intent
// queries we rank for sit at positions 16-61 with no page aimed at them —
// "individuelle geschichten" (pos 16.9), "kinderbuch personalisieren" (pos 61),
// "buecher personalisieren" (pos 56), "buch mit eigener geschichte" (pos 52),
// "ai kids book generator" (pos 27). Inspecting those SERPs, the results are almost
// entirely editorial: how-to guides and "Ratgeber" sections on German regional news
// sites, not product pages. This is the page type that competes there.
//
// Adding a guide here automatically creates its route (enumerateRoutes in
// client/src/entry-server.tsx) and its sitemap entry — but the slug ALSO has to be
// added to GUIDES in server/lib/seoMeta.js or the page ships without meta, canonical
// or sitemap presence. Same duplication as COMPARISONS; see tasks/BACKLOG.md.

export type GuideCategory = 'creating' | 'choosing' | 'helping';

export interface GuideSection {
  heading: Record<'en' | 'de' | 'fr', string>;
  body: Record<'en' | 'de' | 'fr', string[]>;
}

export interface GuideArticle {
  id: string;
  category: GuideCategory;
  /** Minutes, shown to the reader and used for the Article schema. */
  readingMinutes: number;
  /**
   * Optional life-challenge theme id (see storyTypes.ts `lifeChallenges`). Renders
   * a link to /themes/life-challenges/<id> at the foot of the article — the story
   * is the next step for a parent the advice has already helped, not the pitch.
   */
  relatedTheme?: string;
  title: Record<'en' | 'de' | 'fr', string>;
  /** Meta description AND the hub card subtitle. */
  description: Record<'en' | 'de' | 'fr', string>;
  intro: Record<'en' | 'de' | 'fr', string>;
  sections: GuideSection[];
  faq: { q: Record<'en' | 'de' | 'fr', string>; a: Record<'en' | 'de' | 'fr', string> }[];
}

export const guides: GuideArticle[] = [
  // ─── 1. The verb query: "Kinderbuch erstellen / personalisieren mit KI" ───
  {
    id: 'kinderbuch-mit-ki-erstellen',
    category: 'creating',
    readingMinutes: 7,
    title: {
      en: 'How to Create a Children\'s Book with AI: A Practical Guide',
      de: 'Kinderbuch mit KI erstellen: die praktische Anleitung',
      fr: 'Créer un livre pour enfant avec l\'IA : le guide pratique',
    },
    description: {
      en: 'What actually works when you create a children\'s book with AI: how to describe the story, why characters change appearance between pages, and what to check before you print.',
      de: 'Was beim Kinderbuch-Erstellen mit KI wirklich funktioniert: wie du die Geschichte beschreibst, warum Figuren zwischen den Seiten anders aussehen und was du vor dem Druck prüfen solltest.',
      fr: 'Ce qui fonctionne vraiment pour créer un livre pour enfant avec l\'IA : comment décrire l\'histoire, pourquoi les personnages changent d\'apparence, et quoi vérifier avant d\'imprimer.',
    },
    intro: {
      en: 'Making a children\'s book with AI is no longer difficult — the tools are good enough that anyone can produce something in ten minutes. Making one a child actually wants read aloud twice is a different problem. This guide covers what makes the difference, whether you use a dedicated service or assemble one yourself with a chatbot and an image generator.',
      de: 'Ein Kinderbuch mit KI zu machen ist längst nicht mehr schwierig — die Werkzeuge sind gut genug, dass jeder in zehn Minuten etwas produziert. Ein Buch zu machen, das ein Kind zweimal vorgelesen haben will, ist ein anderes Problem. Dieser Ratgeber behandelt, worauf es dabei ankommt — egal ob du einen fertigen Dienst nutzt oder dir selbst etwas aus Chatbot und Bildgenerator zusammenbaust.',
      fr: 'Créer un livre pour enfant avec l\'IA n\'est plus difficile — les outils suffisent à produire quelque chose en dix minutes. Faire un livre qu\'un enfant redemande, c\'est autre chose. Ce guide couvre ce qui fait la différence, que vous utilisiez un service dédié ou que vous assembliez vous-même avec un chatbot et un générateur d\'images.',
    },
    sections: [
      {
        heading: {
          en: 'Describe the situation, not the plot',
          de: 'Beschreibe die Situation, nicht die Handlung',
          fr: 'Décrivez la situation, pas l\'intrigue',
        },
        body: {
          en: [
            'The most common mistake is asking for "a story about a brave girl and a dragon". That prompt has been in the training data ten million times, and you get the averaged version of all of them.',
            'What produces a story worth reading is specificity that only you have: that your daughter refuses to sleep without a particular stuffed rabbit, that she has just moved to a new town and does not know anyone, that she is frightened of the noise the boiler makes at night. Give the model the situation and let it invent the plot.',
            'A useful rule: if your description could apply to any child, it will produce a story about no child in particular.',
          ],
          de: [
            'Der häufigste Fehler ist, nach "einer Geschichte über ein mutiges Mädchen und einen Drachen" zu fragen. Diese Aufforderung stand zehn Millionen Mal in den Trainingsdaten — du bekommst den Durchschnitt aus allen.',
            'Was eine lesenswerte Geschichte ergibt, ist die Genauigkeit, die nur du hast: dass deine Tochter ohne ein bestimmtes Stoffkaninchen nicht einschläft, dass sie gerade umgezogen ist und niemanden kennt, dass sie das Geräusch der Heizung nachts erschreckt. Gib dem Modell die Situation und lass es die Handlung erfinden.',
            'Eine brauchbare Regel: Wenn deine Beschreibung auf jedes Kind passen könnte, entsteht eine Geschichte über kein bestimmtes Kind.',
          ],
          fr: [
            'L\'erreur la plus courante est de demander « une histoire sur une fille courageuse et un dragon ». Cette formulation figure dix millions de fois dans les données d\'entraînement — vous obtenez la moyenne de toutes.',
            'Ce qui produit une histoire digne d\'être lue, c\'est la précision que vous seul possédez : que votre fille ne s\'endort pas sans un lapin en peluche précis, qu\'elle vient de déménager et ne connaît personne, que le bruit de la chaudière lui fait peur la nuit. Donnez la situation au modèle et laissez-le inventer l\'intrigue.',
            'Une règle utile : si votre description pourrait s\'appliquer à n\'importe quel enfant, elle produira une histoire sur aucun enfant en particulier.',
          ],
        },
      },
      {
        heading: {
          en: 'Why the character\'s face changes between pages',
          de: 'Warum sich das Gesicht der Figur zwischen den Seiten ändert',
          fr: 'Pourquoi le visage du personnage change d\'une page à l\'autre',
        },
        body: {
          en: [
            'This is the single biggest quality gap between a book made with a general image generator and one made with a dedicated service, and it is worth understanding before you spend an evening on it.',
            'Image models generate each picture independently. Ask for "a seven-year-old girl with brown curls" twelve times and you get twelve different girls — different face shape, different hair length, different eye colour. A child notices this immediately, and it breaks the illusion that the book is about them.',
            'The fix is a reference: the same character description, and ideally the same reference image, fed into every page, plus a check afterwards that compares each rendered figure against the reference and re-renders the ones that drifted. If you are doing it yourself, expect to regenerate a lot of pages. If you are choosing a service, this is the capability to ask about — it is what separates the good ones from the cheap ones.',
          ],
          de: [
            'Das ist der grösste Qualitätsunterschied zwischen einem Buch aus einem allgemeinen Bildgenerator und einem aus einem spezialisierten Dienst — und es lohnt sich, das zu verstehen, bevor du einen Abend investierst.',
            'Bildmodelle erzeugen jedes Bild unabhängig. Frage zwölfmal nach "einem siebenjährigen Mädchen mit braunen Locken" und du bekommst zwölf verschiedene Mädchen — andere Gesichtsform, andere Haarlänge, andere Augenfarbe. Ein Kind bemerkt das sofort, und die Illusion, dass das Buch von ihm handelt, ist zerstört.',
            'Die Lösung ist eine Referenz: dieselbe Figurenbeschreibung und möglichst dasselbe Referenzbild für jede Seite, plus eine anschliessende Prüfung, die jede gezeichnete Figur mit der Referenz vergleicht und abweichende Seiten neu erzeugt. Wer es selbst macht, muss viele Seiten neu generieren. Wer einen Dienst wählt, sollte genau danach fragen — das unterscheidet die guten von den billigen.',
          ],
          fr: [
            'C\'est le plus grand écart de qualité entre un livre fait avec un générateur d\'images généraliste et un service dédié — à comprendre avant d\'y passer une soirée.',
            'Les modèles d\'images génèrent chaque illustration indépendamment. Demandez douze fois « une fille de sept ans aux boucles brunes » et vous obtenez douze filles différentes — visage, longueur de cheveux, couleur des yeux. Un enfant le remarque immédiatement, et l\'illusion que le livre parle de lui disparaît.',
            'La solution est une référence : la même description de personnage, idéalement la même image de référence, pour chaque page, plus une vérification qui compare chaque figure au référentiel et régénère celles qui dérivent. En autonomie, attendez-vous à régénérer beaucoup de pages. Pour choisir un service, c\'est la question à poser.',
          ],
        },
      },
      {
        heading: {
          en: 'Match the language to the child, not to the age on the box',
          de: 'Richte die Sprache nach dem Kind, nicht nach der Altersangabe',
          fr: 'Adaptez la langue à l\'enfant, pas à l\'âge indiqué',
        },
        body: {
          en: [
            'AI text defaults to a register that is slightly too old and slightly too smooth — long sentences, abstract feeling-words, a moral stated outright at the end. It reads fine to an adult and lands flat with a four-year-old.',
            'Ask for constraints instead of a target age: a maximum sentence length, concrete nouns over abstractions, no more than one new idea per page, and no closing moral. "Maximum five minutes of reading time, calming rather than exciting" gives a far better result than "for a 4-year-old".',
            'Then read it aloud before you commit to it. Text that looks fine on screen and text that works aloud are different things, and reading it out loud catches the difference in about ninety seconds.',
          ],
          de: [
            'KI-Texte landen standardmässig in einem Register, das etwas zu alt und etwas zu glatt ist — lange Sätze, abstrakte Gefühlswörter, am Ende eine ausgesprochene Moral. Für Erwachsene liest sich das gut, bei einem Vierjährigen verpufft es.',
            'Verlange Vorgaben statt einer Altersangabe: eine maximale Satzlänge, konkrete Substantive statt Abstraktionen, höchstens ein neuer Gedanke pro Seite, keine Schlussmoral. "Maximal fünf Minuten Vorlesezeit, beruhigend statt spannend" ergibt ein deutlich besseres Resultat als "für ein 4-jähriges Kind".',
            'Lies den Text danach laut vor, bevor du ihn festlegst. Text, der auf dem Bildschirm gut aussieht, und Text, der vorgelesen funktioniert, sind zweierlei — laut lesen zeigt den Unterschied in neunzig Sekunden.',
          ],
          fr: [
            'Les textes IA tombent par défaut dans un registre un peu trop âgé et un peu trop lisse — phrases longues, mots abstraits sur les émotions, morale énoncée à la fin. Cela se lit bien pour un adulte et tombe à plat avec un enfant de quatre ans.',
            'Demandez des contraintes plutôt qu\'un âge cible : longueur maximale de phrase, noms concrets plutôt qu\'abstractions, une seule idée nouvelle par page, pas de morale finale. « Cinq minutes de lecture maximum, apaisant plutôt que palpitant » donne un bien meilleur résultat que « pour un enfant de 4 ans ».',
            'Puis lisez-le à voix haute avant de le valider. Un texte qui paraît bon à l\'écran et un texte qui fonctionne à voix haute sont deux choses différentes.',
          ],
        },
      },
      {
        heading: {
          en: 'Check these four things before you print',
          de: 'Prüfe diese vier Dinge vor dem Druck',
          fr: 'Vérifiez ces quatre points avant d\'imprimer',
        },
        body: {
          en: [
            'Hands and fingers. Image models still get these wrong, and a six-fingered hand on page nine is the thing a child will point at every single time.',
            'Text placement. Check that no sentence sits over a busy or dark part of the illustration where it becomes unreadable, and that nothing important is cropped by the trim edge.',
            'Accidental lettering. Generators like to paint text-shaped marks onto signs, book covers and boxes inside the picture. It usually comes out as nonsense letters.',
            'Character count per page. If the story says three children are in the boat, count them in the picture. Missing and duplicated figures are common and easy to miss when you are reading rather than looking.',
          ],
          de: [
            'Hände und Finger. Bildmodelle machen hier immer noch Fehler, und eine sechsfingrige Hand auf Seite neun ist genau das, worauf ein Kind jedes Mal zeigt.',
            'Textplatzierung. Prüfe, dass kein Satz über einem unruhigen oder dunklen Bildbereich liegt und unlesbar wird, und dass nichts Wichtiges vom Beschnitt abgeschnitten ist.',
            'Zufällige Schrift. Generatoren malen gerne schriftähnliche Zeichen auf Schilder, Buchdeckel und Kisten im Bild. Meist kommt Buchstabensalat heraus.',
            'Figurenzahl pro Seite. Wenn im Text drei Kinder im Boot sitzen, zähle sie im Bild nach. Fehlende und doppelte Figuren sind häufig und werden leicht übersehen, wenn man liest statt schaut.',
          ],
          fr: [
            'Les mains et les doigts. Les modèles se trompent encore, et une main à six doigts page neuf est exactement ce qu\'un enfant montrera du doigt à chaque fois.',
            'Le placement du texte. Vérifiez qu\'aucune phrase ne se trouve sur une zone chargée ou sombre où elle devient illisible, et que rien d\'important n\'est coupé par le massicot.',
            'Les lettres accidentelles. Les générateurs peignent volontiers des signes ressemblant à du texte sur les panneaux, couvertures et caisses. Cela donne généralement des lettres sans signification.',
            'Le nombre de personnages par page. Si le texte dit que trois enfants sont dans la barque, comptez-les sur l\'image. Les figures manquantes ou dupliquées sont fréquentes.',
          ],
        },
      },
    ],
    faq: [
      {
        q: {
          en: 'Do I need a photo to create a children\'s book with AI?',
          de: 'Brauche ich ein Foto, um ein Kinderbuch mit KI zu erstellen?',
          fr: 'Faut-il une photo pour créer un livre avec l\'IA ?',
        },
        a: {
          en: 'No. A written description — age, hair, eye colour, a favourite jacket — is enough to keep a character consistent, and some parents prefer not to upload a child\'s photo at all. A photo mainly helps when you want the character to be recognisably your child rather than simply a child who matches the description.',
          de: 'Nein. Eine schriftliche Beschreibung — Alter, Haare, Augenfarbe, eine Lieblingsjacke — reicht, um eine Figur konsistent zu halten, und manche Eltern laden bewusst kein Kinderfoto hoch. Ein Foto hilft vor allem dann, wenn die Figur erkennbar dein Kind sein soll und nicht einfach ein Kind, das zur Beschreibung passt.',
          fr: 'Non. Une description écrite — âge, cheveux, couleur des yeux, une veste préférée — suffit à garder un personnage cohérent, et certains parents préfèrent ne pas téléverser de photo. La photo sert surtout à ce que le personnage soit reconnaissable comme votre enfant.',
        },
      },
      {
        q: {
          en: 'Can I sell a children\'s book I made with AI?',
          de: 'Darf ich ein mit KI erstelltes Kinderbuch verkaufen?',
          fr: 'Puis-je vendre un livre créé avec l\'IA ?',
        },
        a: {
          en: 'That depends on the terms of the specific tools you used and on the copyright law where you live, which treats AI-generated material differently from country to country. For a book made for your own family it does not arise. If you intend to publish or sell, check the commercial-use terms of every tool in the chain first.',
          de: 'Das hängt von den Bedingungen der eingesetzten Werkzeuge ab und vom Urheberrecht deines Landes, das KI-erzeugtes Material unterschiedlich behandelt. Für ein Buch für die eigene Familie stellt sich die Frage nicht. Wer veröffentlichen oder verkaufen will, sollte vorher die Bedingungen zur kommerziellen Nutzung aller beteiligten Werkzeuge prüfen.',
          fr: 'Cela dépend des conditions des outils utilisés et du droit d\'auteur de votre pays, qui traite différemment le matériel généré par IA. Pour un livre destiné à votre famille, la question ne se pose pas. Pour publier ou vendre, vérifiez d\'abord les conditions d\'usage commercial de chaque outil.',
        },
      },
      {
        q: {
          en: 'How long does it take?',
          de: 'Wie lange dauert es?',
          fr: 'Combien de temps cela prend-il ?',
        },
        a: {
          en: 'A first version takes minutes with a dedicated service. Assembling one yourself from a chatbot and an image generator takes an evening or two, most of it spent regenerating illustrations where the character drifted.',
          de: 'Eine erste Fassung dauert mit einem spezialisierten Dienst wenige Minuten. Selbst zusammenbauen aus Chatbot und Bildgenerator kostet ein bis zwei Abende — die meiste Zeit geht für das Neugenerieren von Bildern drauf, bei denen die Figur abgewichen ist.',
          fr: 'Une première version prend quelques minutes avec un service dédié. L\'assembler soi-même à partir d\'un chatbot et d\'un générateur d\'images prend une ou deux soirées, surtout passées à régénérer les illustrations où le personnage a dérivé.',
        },
      },
    ],
  },

  // ─── 2. "individuelle geschichten" (pos 16.9) + "buch mit eigener geschichte" ───
  {
    id: 'eigene-geschichte-oder-vorlage',
    category: 'choosing',
    readingMinutes: 5,
    title: {
      en: 'Template or Your Own Story? The Real Difference in Personalized Books',
      de: 'Vorlage oder eigene Geschichte? Der echte Unterschied bei personalisierten Büchern',
      fr: 'Modèle ou histoire originale ? La vraie différence',
    },
    description: {
      en: 'Most personalized children\'s books are one pre-written story with the name swapped in. A few write an original story. Here is how to tell which is which before you pay.',
      de: 'Die meisten personalisierten Kinderbücher sind eine fertige Geschichte mit ausgetauschtem Namen. Wenige schreiben eine eigene Geschichte. So erkennst du vor dem Kauf, was du bekommst.',
      fr: 'La plupart des livres personnalisés sont une histoire pré-écrite avec le prénom remplacé. Quelques-uns écrivent une histoire originale. Voici comment les distinguer avant de payer.',
    },
    intro: {
      en: 'Two products are sold under the same words. In one, an author wrote a story years ago and your child\'s name is inserted into it. In the other, a story is written for the situation you describe and has never existed before. Both are legitimate, they suit different occasions, and the marketing copy rarely tells you which one you are buying.',
      de: 'Unter denselben Worten werden zwei Produkte verkauft. Beim einen hat vor Jahren ein Autor eine Geschichte geschrieben, in die der Name deines Kindes eingesetzt wird. Beim anderen wird eine Geschichte für die von dir beschriebene Situation geschrieben, die es vorher nicht gab. Beides ist legitim, beides passt zu unterschiedlichen Anlässen — und der Werbetext verrät selten, was davon du kaufst.',
      fr: 'Deux produits sont vendus sous les mêmes mots. Dans l\'un, un auteur a écrit une histoire il y a des années et le prénom de votre enfant y est inséré. Dans l\'autre, une histoire est écrite pour la situation que vous décrivez. Les deux sont légitimes et conviennent à des occasions différentes — et la publicité dit rarement lequel vous achetez.',
    },
    sections: [
      {
        heading: {
          en: 'How to tell them apart in thirty seconds',
          de: 'Wie du sie in dreissig Sekunden unterscheidest',
          fr: 'Comment les distinguer en trente secondes',
        },
        body: {
          en: [
            'Look at what the order form asks you for. If it only collects facts that can be slotted into blanks — name, age, hair colour, skin tone, one of six occasions — it is a template. Nothing you enter can change what happens in the story.',
            'If it asks you to describe something in your own words, in a free text field, it can write to that description. That single field is the difference.',
            'A second check: if the site shows you the same sample story on every product page with different names in it, you are looking at a template. If it shows different plots, ask whether you can preview yours before paying.',
          ],
          de: [
            'Sieh dir an, was das Bestellformular abfragt. Werden nur Angaben erfasst, die sich in Lücken einsetzen lassen — Name, Alter, Haarfarbe, Hautton, einer von sechs Anlässen — ist es eine Vorlage. Nichts, was du eingibst, ändert, was in der Geschichte passiert.',
            'Wirst du gebeten, etwas in eigenen Worten in ein Freitextfeld zu schreiben, kann darauf hin geschrieben werden. Genau dieses Feld ist der Unterschied.',
            'Eine zweite Probe: Zeigt die Seite auf jeder Produktseite dieselbe Beispielgeschichte mit anderen Namen, ist es eine Vorlage. Zeigt sie unterschiedliche Handlungen, frage, ob du deine vor dem Bezahlen ansehen kannst.',
          ],
          fr: [
            'Regardez ce que demande le formulaire. S\'il ne collecte que des données insérables dans des blancs — prénom, âge, couleur des cheveux, teint, une occasion parmi six — c\'est un modèle. Rien de ce que vous saisissez ne change ce qui arrive dans l\'histoire.',
            'S\'il vous demande de décrire quelque chose avec vos propres mots, dans un champ libre, il peut écrire à partir de cette description. Ce champ est toute la différence.',
            'Deuxième test : si le site montre le même exemple d\'histoire sur chaque page produit avec des prénoms différents, c\'est un modèle.',
          ],
        },
      },
      {
        heading: {
          en: 'When a template is the better choice',
          de: 'Wann eine Vorlage die bessere Wahl ist',
          fr: 'Quand le modèle est le meilleur choix',
        },
        body: {
          en: [
            'Templates are edited, illustrated and proofread by people, sometimes over years. The rhythm is reliable, the artwork is consistent because a human drew it, and you know exactly what arrives.',
            'That makes them a good fit when the book is a gift for a child you do not know well, when it needs to be safely charming rather than specific, and when you want a physical object of predictable quality for a christening or a birthday.',
            'They are also the safer choice if the idea of a machine writing something for your child does not appeal to you, which is a perfectly reasonable position.',
          ],
          de: [
            'Vorlagen sind von Menschen lektoriert, illustriert und korrigiert, teils über Jahre. Der Rhythmus stimmt verlässlich, die Bilder sind einheitlich, weil sie ein Mensch gezeichnet hat, und du weisst genau, was ankommt.',
            'Das passt gut, wenn das Buch ein Geschenk für ein Kind ist, das du nicht gut kennst, wenn es eher sicher charmant als konkret sein soll, und wenn du zur Taufe oder zum Geburtstag einen physischen Gegenstand von vorhersehbarer Qualität willst.',
            'Sie sind auch die sicherere Wahl, wenn dir die Vorstellung nicht behagt, dass eine Maschine etwas für dein Kind schreibt — eine völlig nachvollziehbare Haltung.',
          ],
          fr: [
            'Les modèles sont édités, illustrés et relus par des humains, parfois pendant des années. Le rythme est fiable, les illustrations cohérentes, et vous savez exactement ce qui arrive.',
            'Cela convient quand le livre est un cadeau pour un enfant que vous connaissez peu, quand il doit être joliment consensuel plutôt que spécifique, et quand vous voulez un objet de qualité prévisible pour un baptême ou un anniversaire.',
            'C\'est aussi le choix le plus sûr si l\'idée qu\'une machine écrive pour votre enfant ne vous plaît pas — position tout à fait raisonnable.',
          ],
        },
      },
      {
        heading: {
          en: 'When only an original story will do',
          de: 'Wann nur eine eigene Geschichte hilft',
          fr: 'Quand seule une histoire originale convient',
        },
        body: {
          en: [
            'The moment you want the book to be about something, a template cannot help you. A grandmother who died in March. A move to another country. A hospital stay next week. A sibling arriving in a family that already has three children and a particular dynamic between them.',
            'These are the books children keep, and they are all specific. No catalogue contains them, because no catalogue can contain your family.',
            'This is also where the therapeutic use sits — a story that lets a child rehearse the dentist, the first day at a new school, or the night the parents separated. The value there is entirely in the specificity, and a swapped name does nothing for it.',
          ],
          de: [
            'Sobald das Buch von etwas handeln soll, hilft keine Vorlage. Eine Grossmutter, die im März gestorben ist. Ein Umzug ins Ausland. Ein Spitalaufenthalt nächste Woche. Ein Geschwisterchen in einer Familie, die schon drei Kinder hat, mit einer bestimmten Dynamik zwischen ihnen.',
            'Das sind die Bücher, die Kinder behalten, und sie sind alle konkret. Kein Katalog enthält sie, weil kein Katalog deine Familie enthalten kann.',
            'Hier liegt auch der therapeutische Nutzen — eine Geschichte, in der ein Kind den Zahnarzt, den ersten Tag an der neuen Schule oder die Trennung der Eltern durchspielen kann. Der Wert liegt vollständig in der Konkretheit; ein ausgetauschter Name leistet dafür nichts.',
          ],
          fr: [
            'Dès que le livre doit parler de quelque chose, aucun modèle ne peut aider. Une grand-mère décédée en mars. Un déménagement à l\'étranger. Une hospitalisation la semaine prochaine. Un petit frère dans une famille qui compte déjà trois enfants.',
            'Ce sont les livres que les enfants gardent, et ils sont tous spécifiques. Aucun catalogue ne les contient, parce qu\'aucun catalogue ne peut contenir votre famille.',
            'C\'est aussi là que se situe l\'usage thérapeutique — une histoire où l\'enfant peut répéter le dentiste, la rentrée, ou la séparation des parents. La valeur tient entièrement à la spécificité.',
          ],
        },
      },
    ],
    faq: [
      {
        q: {
          en: 'Are original AI stories worse written than template books?',
          de: 'Sind eigene KI-Geschichten schlechter geschrieben als Vorlagenbücher?',
          fr: 'Les histoires IA sont-elles moins bien écrites que les modèles ?',
        },
        a: {
          en: 'Sentence for sentence, a template that a human editor worked on for months is usually smoother. The trade is polish against relevance: a slightly less elegant story about the thing your child is actually going through generally beats a beautifully written story about nothing in particular. Services that let you edit the text afterwards narrow the gap considerably.',
          de: 'Satz für Satz ist eine Vorlage, an der ein Lektorat monatelang gearbeitet hat, meist runder. Der Tausch heisst Politur gegen Relevanz: Eine etwas weniger elegante Geschichte über das, was dein Kind gerade durchmacht, schlägt in der Regel eine schön geschriebene Geschichte über nichts Bestimmtes. Dienste, bei denen du den Text nachbearbeiten kannst, verkleinern den Abstand deutlich.',
          fr: 'Phrase par phrase, un modèle travaillé pendant des mois par un éditeur est généralement plus fluide. L\'échange, c\'est le poli contre la pertinence : une histoire un peu moins élégante sur ce que votre enfant traverse vaut mieux qu\'une belle histoire sur rien en particulier.',
        },
      },
      {
        q: {
          en: 'Can I edit the story if I do not like part of it?',
          de: 'Kann ich die Geschichte bearbeiten, wenn mir etwas nicht gefällt?',
          fr: 'Puis-je modifier l\'histoire si une partie ne me plaît pas ?',
        },
        a: {
          en: 'With a template, no — the text is fixed apart from the personalized fields. With an original story it depends on the service: some hand you a finished PDF, others let you rewrite any sentence and regenerate any illustration. If you care about the wording, check this before buying rather than after.',
          de: 'Bei einer Vorlage nein — der Text steht fest, abgesehen von den personalisierten Feldern. Bei einer eigenen Geschichte hängt es vom Anbieter ab: Manche liefern ein fertiges PDF, andere lassen dich jeden Satz umschreiben und jede Illustration neu erzeugen. Wenn dir der Wortlaut wichtig ist, kläre das vor dem Kauf.',
          fr: 'Avec un modèle, non — le texte est figé hormis les champs personnalisés. Avec une histoire originale, cela dépend du service : certains livrent un PDF fini, d\'autres permettent de réécrire chaque phrase et régénérer chaque illustration. Vérifiez avant d\'acheter.',
        },
      },
    ],
  },
  // ─── 3. Mutmacher: sibling conflict ──────────────────────────────────────
  // Targets the ADVICE query, not the product query: "geschwisterstreit was tun",
  // "geschwister streiten immer", "geschwisterstreit schlichten". Measured
  // 2026-08-26 via Keyword Planner: geschwisterstreit = 40/mo CH, 390/mo DE, at a
  // CHF 0.02-0.83 top-of-page bid — effectively unmonetised, because the intent is
  // informational. Meanwhile our /themes/life-challenges pages already rank pos
  // 5-11 while every commercial page sits at 38-52, so the topical authority is
  // real; what was missing is a page that answers the question instead of selling.
  //
  // House rule for every article in this category: no invented statistics and no
  // fabricated citations. The advice is mechanism-based and citation-free by
  // design, and each one ends by naming the point at which a professional, not an
  // article, is the right answer.
  {
    id: 'geschwisterstreit-was-tun',
    category: 'helping',
    readingMinutes: 6,
    relatedTheme: 'sibling-fighting',
    title: {
      en: 'Siblings Fighting Constantly: What Actually Helps',
      de: 'Geschwisterstreit: was wirklich hilft',
      fr: 'Disputes entre frères et sœurs : ce qui aide vraiment',
    },
    description: {
      en: 'Why siblings fight, why refereeing makes it worse, and what to do instead — plus how to tell ordinary conflict from something that needs help.',
      de: 'Warum Geschwister streiten, warum Schlichten es schlimmer macht und was stattdessen hilft — und woran du erkennst, wann aus normalem Streit etwas anderes wird.',
      fr: 'Pourquoi les fratries se disputent, pourquoi arbitrer aggrave les choses, et quoi faire à la place — et comment distinguer un conflit ordinaire d\'un problème réel.',
    },
    intro: {
      en: 'Most advice about sibling fighting assumes the fight is about the thing being fought over. It almost never is. Once you see what the argument is actually about, the useful responses change — and the exhausting job of working out who started it turns out to be the part you can drop.',
      de: 'Die meisten Ratschläge zu Geschwisterstreit gehen davon aus, dass es um den Gegenstand geht, um den gestritten wird. Das ist fast nie so. Wenn du siehst, worum es wirklich geht, ändern sich die hilfreichen Reaktionen — und die anstrengende Aufgabe herauszufinden, wer angefangen hat, ist genau der Teil, den du weglassen kannst.',
      fr: 'La plupart des conseils sur les disputes entre frères et sœurs supposent que le conflit porte sur l\'objet disputé. C\'est presque jamais le cas. Quand on voit de quoi il retourne vraiment, les réponses utiles changent — et la tâche épuisante de déterminer qui a commencé est justement celle qu\'on peut abandonner.',
    },
    sections: [
      {
        heading: {
          en: 'The fight is rarely about the toy',
          de: 'Es geht selten um das Spielzeug',
          fr: 'La dispute porte rarement sur le jouet',
        },
        body: {
          en: [
            'Two children argue over a red cup when there are four identical red cups in the cupboard. That is the clue. What is scarce in the room is not the cup — it is you, and the certainty of having a place nobody can take.',
            'Siblings are, from a child\'s point of view, the people who arrived to divide up a finite supply of parental attention. Much of what looks like squabbling is a test of that supply: does she get more, does he get away with more, what happens if I push.',
            'This is why fairness arithmetic fails. The moment you start measuring minutes and biscuits, you confirm that attention is a quantity being rationed, and both children begin auditing you. What lowers the temperature is unmeasured, unearned attention arriving when nothing is wrong — the opposite of how attention usually gets distributed, since it flows to whoever is loudest.',
          ],
          de: [
            'Zwei Kinder streiten um den roten Becher, obwohl vier identische rote Becher im Schrank stehen. Das ist der Hinweis. Knapp ist nicht der Becher — knapp bist du, und die Gewissheit, einen Platz zu haben, den niemand wegnehmen kann.',
            'Geschwister sind aus Sicht eines Kindes die Leute, die gekommen sind, um einen begrenzten Vorrat an elterlicher Aufmerksamkeit aufzuteilen. Vieles, was wie Gezänk aussieht, ist ein Test dieses Vorrats: Bekommt sie mehr, kommt er mit mehr durch, was passiert, wenn ich schiebe.',
            'Deshalb scheitert Gerechtigkeitsrechnen. Sobald du Minuten und Guetzli abmisst, bestätigst du, dass Aufmerksamkeit eine rationierte Menge ist — und beide Kinder fangen an, dich zu prüfen. Was die Temperatur senkt, ist ungemessene, unverdiente Aufmerksamkeit, die kommt, wenn gerade nichts ist. Das ist das Gegenteil davon, wie Aufmerksamkeit sonst verteilt wird, denn sie fliesst zu dem, der am lautesten ist.',
          ],
          fr: [
            'Deux enfants se disputent le gobelet rouge alors qu\'il y en a quatre identiques dans le placard. C\'est l\'indice. Ce qui est rare dans la pièce, ce n\'est pas le gobelet — c\'est vous, et la certitude d\'avoir une place que personne ne peut prendre.',
            'Du point de vue d\'un enfant, les frères et sœurs sont ceux qui sont arrivés pour partager une réserve limitée d\'attention parentale. L\'essentiel de ce qui ressemble à des chamailleries teste cette réserve : est-ce qu\'elle en reçoit plus, est-ce qu\'il s\'en tire mieux, que se passe-t-il si je pousse.',
            'C\'est pourquoi la comptabilité de l\'équité échoue. Dès que vous mesurez les minutes et les biscuits, vous confirmez que l\'attention est une quantité rationnée, et les deux enfants se mettent à vous auditer. Ce qui fait baisser la température, c\'est une attention non mesurée et non méritée, qui arrive quand rien ne va mal.',
          ],
        },
      },
      {
        heading: {
          en: 'Stop being the judge',
          de: 'Hör auf, Richter zu sein',
          fr: 'Cessez d\'être le juge',
        },
        body: {
          en: [
            'The instinct is to establish what happened and rule on it. It rarely works, for a structural reason: you did not see the start, both accounts are sincere and incompatible, and whatever you decide teaches the loser that the way to win next time is a better story told faster.',
            'Judging also makes you the prize. If a verdict from you is what conflict produces, then producing conflict is how to reach you.',
            'The alternative is to describe instead of decide. «Zwei Kinder, ein Trottinett, und ihr seid beide wütend.» You have said nothing about who is right, but you have shown that you saw it — which is most of what the shouting was for. Then hand the problem back: tell me when you have worked out what to do. Small children need more scaffolding than that, but the direction is the same: narrate the situation, name both feelings, leave ownership of the solution with them.',
          ],
          de: [
            'Der Reflex ist, festzustellen was passiert ist, und darüber zu urteilen. Das funktioniert selten, aus einem strukturellen Grund: Du hast den Anfang nicht gesehen, beide Darstellungen sind ehrlich gemeint und unvereinbar, und was immer du entscheidest, lehrt den Verlierer, dass man das nächste Mal mit der besseren, schneller erzählten Geschichte gewinnt.',
            'Urteilen macht dich ausserdem zum Preis. Wenn Streit ein Urteil von dir hervorbringt, dann ist Streit der Weg, dich zu erreichen.',
            'Die Alternative ist beschreiben statt entscheiden. «Zwei Kinder, ein Trottinett, und ihr seid beide wütend.» Du hast nichts darüber gesagt, wer recht hat, aber gezeigt, dass du es gesehen hast — und das war das meiste, wofür geschrien wurde. Dann gib das Problem zurück: «Sagt mir Bescheid, wenn ihr eine Lösung habt.» Kleine Kinder brauchen mehr Begleitung, aber die Richtung bleibt: Situation schildern, beide Gefühle benennen, die Lösung bei ihnen lassen.',
          ],
          fr: [
            'Le réflexe est d\'établir les faits et de trancher. Cela marche rarement, pour une raison structurelle : vous n\'avez pas vu le début, les deux versions sont sincères et incompatibles, et quoi que vous décidiez, le perdant apprend qu\'il faut raconter une meilleure histoire, plus vite.',
            'Juger fait aussi de vous le prix. Si le conflit produit un verdict de votre part, alors produire des conflits devient le moyen de vous atteindre.',
            'L\'alternative : décrire au lieu de décider. «Deux enfants, une trottinette, et vous êtes furieux tous les deux.» Vous n\'avez rien dit sur qui a raison, mais vous avez montré que vous aviez vu — c\'est l\'essentiel de ce pour quoi ils criaient. Puis rendez-leur le problème : dites-moi quand vous aurez trouvé.',
          ],
        },
      },
      {
        heading: {
          en: 'Separate safety from disagreement',
          de: 'Trenne Sicherheit von Meinungsverschiedenheit',
          fr: 'Séparez la sécurité du désaccord',
        },
        body: {
          en: [
            'There is one clean line worth holding, and it is not about who is right. Disagreement is allowed and normal, including loud disagreement. Hurting is not, and it stops immediately, without discussion and without a verdict.',
            'The useful move when someone gets hurt is counter-intuitive: go to the hurt child first and attend to them, without turning to prosecute the other. The child who lashed out is watching, and learns that hurting produces attention for the other person rather than a dramatic confrontation with you. The conversation about what happened comes later, when everyone is calm — and it works far better then, because nobody is defending themselves.',
            'Repair matters more than punishment. Something concrete and doable — fetching the ice pack, rebuilding the knocked-over tower — restores the relationship in a way that sitting on a step does not.',
          ],
          de: [
            'Es gibt eine klare Linie, die sich zu halten lohnt, und sie handelt nicht davon, wer recht hat. Uneinigkeit ist erlaubt und normal, auch laute. Wehtun ist es nicht, und es hört sofort auf, ohne Diskussion und ohne Urteil.',
            'Der hilfreiche Schritt, wenn jemand verletzt wird, ist gegenintuitiv: Geh zuerst zum verletzten Kind und kümmere dich, ohne dich zur Anklage des anderen umzudrehen. Das Kind, das zugeschlagen hat, schaut zu und lernt, dass Wehtun Aufmerksamkeit für die andere Person erzeugt, nicht eine dramatische Auseinandersetzung mit dir. Das Gespräch darüber kommt später, wenn alle ruhig sind — und funktioniert dann viel besser, weil sich niemand verteidigen muss.',
            'Wiedergutmachung wirkt mehr als Strafe. Etwas Konkretes und Machbares — den Kühlbeutel holen, den umgeworfenen Turm wieder aufbauen — stellt die Beziehung wieder her, was Sitzen auf einer Treppe nicht tut.',
          ],
          fr: [
            'Il y a une ligne claire à tenir, et elle ne porte pas sur qui a raison. Le désaccord est permis et normal, y compris bruyant. Faire mal ne l\'est pas, et cela s\'arrête immédiatement, sans discussion ni verdict.',
            'Le geste utile quand quelqu\'un est blessé est contre-intuitif : allez d\'abord vers l\'enfant blessé et occupez-vous de lui, sans vous retourner pour accuser l\'autre. Celui qui a frappé regarde, et apprend que faire mal produit de l\'attention pour l\'autre, pas une confrontation avec vous. La conversation vient plus tard, au calme — et fonctionne bien mieux, parce que personne ne se défend.',
            'La réparation compte plus que la punition. Quelque chose de concret — aller chercher la poche de glace, reconstruire la tour renversée — restaure la relation, ce que rester assis sur une marche ne fait pas.',
          ],
        },
      },
      {
        heading: {
          en: 'Drop the labels, especially the flattering ones',
          de: 'Lass die Etiketten weg, gerade die schmeichelhaften',
          fr: 'Abandonnez les étiquettes, surtout les flatteuses',
        },
        body: {
          en: [
            'Families settle quickly into casting: the sensible one, the wild one, the sensitive one, the easy one. The labels feel like observations. They function as instructions.',
            'The most costly is usually "the big one", because it converts an accident of birth order into a permanent job — yielding, waiting, understanding, being reasonable while someone smaller is not required to be. Resentment aimed at the younger child usually starts here, and it is aimed at the wrong target.',
            'The practical substitution is to describe the moment rather than the person. Not "you are so patient with her", which is a role to be maintained, but "you waited while she finished, that was hard" — a thing that happened once and can happen again without defining who you are.',
          ],
          de: [
            'Familien verteilen schnell Rollen: die Vernünftige, der Wilde, die Sensible, der Pflegeleichte. Die Etiketten fühlen sich wie Beobachtungen an. Sie wirken wie Anweisungen.',
            'Das teuerste ist meist «der Grosse», weil es einen Zufall der Geburtsreihenfolge in eine dauerhafte Aufgabe verwandelt: nachgeben, warten, verstehen, vernünftig sein, während jemand Kleineres das nicht muss. Groll gegen das jüngere Kind beginnt meistens hier — und richtet sich auf das falsche Ziel.',
            'Der praktische Ersatz ist, den Moment zu beschreiben statt die Person. Nicht «du bist so geduldig mit ihr», das ist eine Rolle, die gehalten werden muss, sondern «du hast gewartet, bis sie fertig war, das war schwierig» — etwas, das einmal passiert ist und wieder passieren kann, ohne zu bestimmen, wer du bist.',
          ],
          fr: [
            'Les familles distribuent vite les rôles : la raisonnable, le turbulent, la sensible, le facile. Ces étiquettes ressemblent à des observations. Elles fonctionnent comme des consignes.',
            'La plus coûteuse est souvent «le grand», parce qu\'elle transforme un hasard de naissance en fonction permanente : céder, attendre, comprendre, être raisonnable pendant qu\'un plus petit n\'y est pas tenu. Le ressentiment envers le cadet commence généralement là — et vise la mauvaise cible.',
            'Le remplacement pratique : décrire le moment plutôt que la personne. Non pas «tu es si patient avec elle», qui est un rôle à tenir, mais «tu as attendu qu\'elle finisse, c\'était difficile» — une chose arrivée une fois, qui peut se reproduire sans définir qui tu es.',
          ],
        },
      },
      {
        heading: {
          en: 'When it is more than ordinary fighting',
          de: 'Wann es mehr als normaler Streit ist',
          fr: 'Quand ce n\'est plus une dispute ordinaire',
        },
        body: {
          en: [
            'Ordinary sibling conflict is loud, frequent, roughly reciprocal, and over quickly. Children who fight like this usually play together again within the hour.',
            'Some patterns are worth taking more seriously: when it runs one direction only and the same child is always on the receiving end; when the aim seems to be humiliation rather than winning; when one child becomes fearful, withdrawn, or stops using shared rooms; when the fighting arrives suddenly alongside changes in sleep, appetite or school.',
            'None of that means something is wrong with your family, and none of it is a diagnosis. It means the situation is worth describing to someone who can assess it properly — your paediatrician, the school psychological service, or a family counselling centre. This article is general information written for the ordinary case, not advice about a specific child.',
          ],
          de: [
            'Normaler Geschwisterstreit ist laut, häufig, ungefähr wechselseitig und schnell vorbei. Kinder, die so streiten, spielen meist innerhalb einer Stunde wieder zusammen.',
            'Manche Muster verdienen mehr Aufmerksamkeit: wenn es nur in eine Richtung geht und immer dasselbe Kind trifft; wenn es um Demütigung geht statt ums Gewinnen; wenn ein Kind ängstlich wird, sich zurückzieht oder gemeinsame Räume meidet; wenn der Streit plötzlich zusammen mit Veränderungen bei Schlaf, Appetit oder Schule auftritt.',
            'Nichts davon bedeutet, dass mit deiner Familie etwas nicht stimmt, und nichts davon ist eine Diagnose. Es bedeutet, dass es sich lohnt, die Situation jemandem zu schildern, der sie richtig einschätzen kann — Kinderärztin, schulpsychologischer Dienst oder eine Erziehungsberatungsstelle. Dieser Text ist allgemeine Information für den Normalfall, keine Beratung für ein bestimmtes Kind.',
          ],
          fr: [
            'Un conflit ordinaire entre frères et sœurs est bruyant, fréquent, à peu près réciproque, et vite terminé. Les enfants qui se disputent ainsi rejouent ensemble dans l\'heure.',
            'Certains schémas méritent plus d\'attention : quand cela va dans un seul sens et vise toujours le même enfant ; quand le but semble être l\'humiliation plutôt que la victoire ; quand un enfant devient craintif, se retire ou évite les pièces communes ; quand les disputes surgissent soudainement avec des changements de sommeil, d\'appétit ou d\'école.',
            'Rien de cela ne signifie que quelque chose ne va pas dans votre famille, et rien n\'est un diagnostic. Cela signifie qu\'il vaut la peine d\'en parler à quelqu\'un qui peut l\'évaluer — pédiatre, service psychologique scolaire, ou centre de consultation familiale. Ce texte est une information générale, pas un conseil pour un enfant précis.',
          ],
        },
      },
    ],
    faq: [
      {
        q: {
          en: 'Should I make them apologise?',
          de: 'Soll ich sie zur Entschuldigung auffordern?',
          fr: 'Dois-je les forcer à s\'excuser ?',
        },
        a: {
          en: 'A forced apology teaches the word, not the meaning, and the wronged child can usually tell the difference. Repair works better: something concrete that helps the other person. If an apology comes later and unprompted, it is worth far more.',
          de: 'Eine erzwungene Entschuldigung lehrt das Wort, nicht die Bedeutung — und das benachteiligte Kind merkt den Unterschied meistens. Wiedergutmachung wirkt besser: etwas Konkretes, das dem anderen hilft. Kommt die Entschuldigung später von selbst, ist sie viel mehr wert.',
          fr: 'Des excuses forcées enseignent le mot, pas le sens, et l\'enfant lésé fait généralement la différence. La réparation fonctionne mieux : quelque chose de concret qui aide l\'autre. Si les excuses viennent plus tard, spontanément, elles valent bien plus.',
        },
      },
      {
        q: {
          en: 'One of them really does start it every time. Should I say so?',
          de: 'Eines fängt wirklich jedes Mal an. Soll ich das sagen?',
          fr: 'L\'un commence vraiment à chaque fois. Dois-je le dire ?',
        },
        a: {
          en: 'Saying it out loud installs the label, and children grow into the roles we assign them. It is usually more useful to ask what that child gets out of starting — attention, a reaction, a reliable way to be seen — and to supply it somewhere else, before the fight rather than after.',
          de: 'Es auszusprechen installiert das Etikett, und Kinder wachsen in die Rollen hinein, die wir ihnen zuweisen. Meist ist nützlicher zu fragen, was dieses Kind vom Anfangen hat — Aufmerksamkeit, eine Reaktion, ein verlässlicher Weg gesehen zu werden — und das woanders zu liefern, vor dem Streit statt danach.',
          fr: 'Le dire à voix haute installe l\'étiquette, et les enfants deviennent les rôles qu\'on leur assigne. Il est plus utile de demander ce que cet enfant retire du fait de commencer — attention, réaction, moyen fiable d\'être vu — et de le lui fournir ailleurs, avant la dispute plutôt qu\'après.',
        },
      },
      {
        q: {
          en: 'Does it ever stop?',
          de: 'Hört das jemals auf?',
          fr: 'Est-ce que cela s\'arrête un jour ?',
        },
        a: {
          en: 'The frequency usually drops as children get better at language and at leaving the room. What changes it most is not a technique but time spent together without a parent adjudicating — shared jokes, shared projects, being on the same side against something. Conflict does not disappear; the relationship simply gets big enough to hold it.',
          de: 'Die Häufigkeit nimmt meist ab, sobald Kinder besser sprechen und den Raum verlassen können. Am meisten ändert nicht eine Technik, sondern gemeinsame Zeit ohne schlichtende Eltern — gemeinsame Witze, gemeinsame Projekte, zusammen gegen etwas sein. Streit verschwindet nicht; die Beziehung wird nur gross genug, ihn auszuhalten.',
          fr: 'La fréquence baisse généralement à mesure que les enfants maîtrisent le langage et savent quitter la pièce. Ce qui change le plus n\'est pas une technique mais du temps passé ensemble sans parent arbitre — blagues communes, projets communs, être du même côté contre quelque chose. Le conflit ne disparaît pas ; la relation devient assez solide pour le contenir.',
        },
      },
    ],
  },
  // ─── 4. Mutmacher: moving house ──────────────────────────────────────────
  // "umzug mit kind", "kind angst umzug", "umzug kind eingewöhnung". We already
  // rank pos 10.0 for "umzug kinderbuch" and 12.0 for "kinderbuch umzug" — both
  // product-shaped. This page is for the parent who has not thought about a book.
  {
    id: 'umzug-mit-kind',
    category: 'helping',
    readingMinutes: 6,
    relatedTheme: 'moving-house',
    title: {
      en: 'Moving House with a Child Who Does Not Want To',
      de: 'Umzug mit Kind: wenn es nicht weg will',
      fr: 'Déménager avec un enfant qui ne veut pas partir',
    },
    description: {
      en: 'What a move actually threatens for a child, when to tell them, why the goodbye matters more than the welcome, and why the hardest weeks come after the boxes are unpacked.',
      de: 'Was ein Umzug für ein Kind wirklich bedroht, wann du es sagst, warum der Abschied wichtiger ist als die Ankunft — und warum die schwersten Wochen erst nach dem Auspacken kommen.',
      fr: 'Ce qu\'un déménagement menace vraiment pour un enfant, quand lui dire, pourquoi l\'au revoir compte plus que l\'accueil, et pourquoi les semaines les plus dures viennent après.',
    },
    intro: {
      en: 'Adults experience a move as logistics with an emotional edge. For a child it is closer to the reverse. Understanding which part is actually frightening makes the difference between reassurance that lands and reassurance that irritates — and most of the standard reassurances are aimed at the wrong thing.',
      de: 'Erwachsene erleben einen Umzug als Logistik mit emotionalem Rand. Für ein Kind ist es eher umgekehrt. Zu verstehen, welcher Teil wirklich Angst macht, entscheidet darüber, ob Beruhigung ankommt oder nervt — und die meisten üblichen Beruhigungen zielen auf das Falsche.',
      fr: 'Les adultes vivent un déménagement comme une logistique avec une part émotionnelle. Pour un enfant, c\'est plutôt l\'inverse. Comprendre quelle partie fait vraiment peur décide si le réconfort atteint sa cible ou agace — et la plupart des formules rassurantes visent à côté.',
    },
    sections: [
      {
        heading: {
          en: 'It is not the house',
          de: 'Es ist nicht das Haus',
          fr: 'Ce n\'est pas la maison',
        },
        body: {
          en: [
            'Parents reach for the new house: a bigger room, a garden, stairs, a shorter journey to work. The child is unmoved, and it looks like ingratitude. It is not — you are answering a question they did not ask.',
            'What a move threatens is predictability and belonging: knowing which cupboard the cups live in, which route leads to the shop, who says hello in the stairwell, where you sit at lunch and who sits next to you. That accumulated knowledge is how a child feels competent in the world, and a move deletes all of it at once.',
            'That is why "you will make new friends" reassures nobody. It is a promise about a future they cannot picture, offered in exchange for a present they can. Something concrete works better: naming who will still be reachable, what will still happen on Saturdays, which things will be in the new room, and which of their own routines will not change.',
          ],
          de: [
            'Eltern greifen zum neuen Haus: grösseres Zimmer, Garten, Treppe, kürzerer Arbeitsweg. Das Kind bleibt ungerührt, und es sieht nach Undankbarkeit aus. Ist es nicht — du beantwortest eine Frage, die es nicht gestellt hat.',
            'Was ein Umzug bedroht, sind Vorhersehbarkeit und Zugehörigkeit: zu wissen, in welchem Schrank die Becher stehen, welcher Weg zum Laden führt, wer im Treppenhaus grüsst, wo man beim Mittagessen sitzt und wer daneben sitzt. Dieses angesammelte Wissen ist die Art, wie ein Kind sich in der Welt kompetent fühlt — und ein Umzug löscht alles auf einmal.',
            'Deshalb beruhigt «du findest neue Freunde» niemanden. Es ist ein Versprechen über eine Zukunft, die es sich nicht vorstellen kann, im Tausch gegen eine Gegenwart, die es kennt. Konkretes wirkt besser: benennen, wer erreichbar bleibt, was samstags weiter passiert, welche Sachen ins neue Zimmer kommen und welche eigenen Abläufe sich nicht ändern.',
          ],
          fr: [
            'Les parents mettent en avant la nouvelle maison : une plus grande chambre, un jardin, un trajet plus court. L\'enfant reste de marbre, et cela ressemble à de l\'ingratitude. Ce n\'en est pas : vous répondez à une question qu\'il n\'a pas posée.',
            'Ce qu\'un déménagement menace, c\'est la prévisibilité et l\'appartenance : savoir dans quel placard sont les tasses, quel chemin mène au magasin, qui dit bonjour dans l\'escalier, où l\'on s\'assied à midi et qui est à côté. Ce savoir accumulé est ce qui rend un enfant compétent dans son monde, et un déménagement l\'efface d\'un coup.',
            '« Tu te feras de nouveaux amis » ne rassure donc personne : c\'est une promesse sur un futur inimaginable, en échange d\'un présent bien réel. Du concret marche mieux : nommer qui restera joignable, ce qui continuera le samedi, quels objets iront dans la nouvelle chambre, et quelles habitudes ne changeront pas.',
          ],
        },
      },
      {
        heading: {
          en: 'Tell them early, and tell them plainly',
          de: 'Sag es früh, und sag es klar',
          fr: 'Dites-le tôt, et dites-le clairement',
        },
        body: {
          en: [
            'The instinct to delay is protective and usually backfires. Children register tension long before they are told what it is about — packing, viewings, half-finished conversations that stop when they enter the room. What they do with unexplained tension is invent an explanation, and the invented one is often worse than the truth.',
            'Say it once it is certain, in plain words, with whatever concrete detail exists: we are moving, in about two months, to a flat in this town, you will have your own room, you will change school. Vagueness is what frightens; specifics are what a child can hold on to.',
            'Then expect the reaction to arrive late. Many children say "okay" and go back to playing, and the real response surfaces days later as tears about something unrelated, or as a sudden refusal to sleep alone. That delay is normal and is not manipulation.',
          ],
          de: [
            'Der Impuls, es aufzuschieben, ist beschützend und geht meist nach hinten los. Kinder registrieren Anspannung lange bevor man ihnen sagt, worum es geht — Kisten, Besichtigungen, halbe Gespräche, die abbrechen, wenn sie den Raum betreten. Was sie mit unerklärter Anspannung machen, ist eine Erklärung erfinden, und die erfundene ist oft schlimmer als die Wahrheit.',
            'Sag es, sobald es sicher ist, in klaren Worten, mit den konkreten Angaben, die es gibt: Wir ziehen um, in etwa zwei Monaten, in eine Wohnung in diesem Ort, du bekommst dein eigenes Zimmer, du wechselst die Schule. Vagheit macht Angst; Konkretes ist das, woran sich ein Kind festhalten kann.',
            'Und rechne damit, dass die Reaktion spät kommt. Viele Kinder sagen «okay» und spielen weiter, und die eigentliche Antwort zeigt sich Tage später als Tränen über etwas ganz anderes oder als plötzliche Weigerung, allein zu schlafen. Diese Verzögerung ist normal und keine Manipulation.',
          ],
          fr: [
            'L\'envie de repousser est protectrice et se retourne généralement contre vous. Les enfants perçoivent la tension bien avant qu\'on leur en donne la raison — cartons, visites, conversations interrompues quand ils entrent. Face à une tension inexpliquée, ils inventent une explication, souvent pire que la vérité.',
            'Dites-le dès que c\'est certain, avec des mots simples et les détails concrets disponibles : nous déménageons, dans deux mois environ, dans un appartement de cette commune, tu auras ta chambre, tu changeras d\'école. C\'est le flou qui fait peur ; le concret est ce à quoi un enfant peut se tenir.',
            'Attendez-vous ensuite à une réaction différée. Beaucoup d\'enfants disent « d\'accord » et retournent jouer ; la vraie réponse surgit des jours plus tard, en larmes à propos d\'autre chose. Ce décalage est normal et n\'est pas de la manipulation.',
          ],
        },
      },
      {
        heading: {
          en: 'Give them authority over something small and real',
          de: 'Gib ihm echte Macht über etwas Kleines',
          fr: 'Donnez-lui un pouvoir réel sur quelque chose de petit',
        },
        body: {
          en: [
            'A move is something that happens to a child. Almost nothing about it is theirs to decide, and that powerlessness is a large part of the distress. The remedy is not a fake choice — children detect those instantly — but a genuine one, however small.',
            'Which wall the bed goes against. Which box their things travel in, packed by them and opened first. Which two friends come for a farewell afternoon. Whether the old curtains come along. The decision must be real, meaning you will actually abide by it even if you would have chosen otherwise.',
            'One box packed by the child and unpacked on the first evening is worth more than a room decorated perfectly in advance. Familiar objects in a strange room are what turn it from a place they are staying into a place that is theirs.',
          ],
          de: [
            'Ein Umzug ist etwas, das einem Kind passiert. Fast nichts daran darf es entscheiden, und diese Machtlosigkeit ist ein grosser Teil der Belastung. Das Gegenmittel ist keine Scheinwahl — die durchschauen Kinder sofort — sondern eine echte, wie klein auch immer.',
            'An welche Wand das Bett kommt. In welche Kiste die eigenen Sachen reisen, selbst gepackt und zuerst geöffnet. Welche zwei Freunde zum Abschiedsnachmittag kommen. Ob die alten Vorhänge mitkommen. Die Entscheidung muss echt sein — du hältst dich daran, auch wenn du anders gewählt hättest.',
            'Eine vom Kind gepackte Kiste, die am ersten Abend ausgepackt wird, ist mehr wert als ein vorab perfekt eingerichtetes Zimmer. Vertraute Gegenstände in einem fremden Raum machen aus einem Ort, an dem es wohnt, einen Ort, der ihm gehört.',
          ],
          fr: [
            'Un déménagement est quelque chose qui arrive à l\'enfant. Presque rien n\'est de son ressort, et cette impuissance fait une grande part de la détresse. Le remède n\'est pas un faux choix — les enfants les détectent aussitôt — mais un vrai, même minuscule.',
            'Contre quel mur va le lit. Dans quel carton voyagent ses affaires, rempli par lui et ouvert en premier. Quels deux amis viennent pour l\'après-midi d\'adieu. Si les vieux rideaux suivent. La décision doit être réelle : vous vous y tiendrez même si vous auriez choisi autrement.',
            'Un carton rempli par l\'enfant et ouvert le premier soir vaut mieux qu\'une chambre parfaitement décorée à l\'avance. Des objets familiers dans une pièce étrangère transforment un lieu où il loge en un lieu qui est le sien.',
          ],
        },
      },
      {
        heading: {
          en: 'The goodbye matters more than the welcome',
          de: 'Der Abschied zählt mehr als die Ankunft',
          fr: 'L\'au revoir compte plus que l\'accueil',
        },
        body: {
          en: [
            'Most of the effort goes into the arrival — the new room, the new school, the welcome. The departure gets treated as the sad part to move through quickly. That is backwards.',
            'A child who has properly finished with the old place arrives able to start. One who was hurried past it arrives still holding it. Give the ending its own shape: a last walk to the places that mattered, photographing the empty room, saying goodbye out loud to the flat, a small farewell with the two or three people who count. Naming a loss makes it smaller, not bigger.',
            'Be careful with promises about staying in touch. Keep them few and keep them yours to guarantee — one video call with a named friend on a named day beats an open-ended assurance that everything will stay the same, which will not survive contact with the following month.',
          ],
          de: [
            'Die meiste Mühe geht in die Ankunft — neues Zimmer, neue Schule, Willkommen. Der Abschied gilt als der traurige Teil, den man schnell hinter sich bringt. Das ist verkehrt herum.',
            'Ein Kind, das mit dem alten Ort richtig fertig geworden ist, kommt an und kann anfangen. Eines, das daran vorbeigehetzt wurde, kommt an und hält ihn noch fest. Gib dem Ende eine eigene Form: ein letzter Gang zu den Orten, die zählten, das leere Zimmer fotografieren, der Wohnung laut auf Wiedersehen sagen, ein kleiner Abschied mit den zwei, drei Menschen, die wichtig sind. Einen Verlust zu benennen macht ihn kleiner, nicht grösser.',
            'Sei vorsichtig mit Versprechen über Kontakt. Wenige, und solche, die du garantieren kannst — ein Videoanruf mit einem bestimmten Kind an einem bestimmten Tag ist mehr wert als die offene Zusicherung, dass alles bleibt wie es war, die den nächsten Monat nicht übersteht.',
          ],
          fr: [
            'L\'essentiel de l\'effort va à l\'arrivée — la nouvelle chambre, la nouvelle école, l\'accueil. Le départ est traité comme la partie triste qu\'on traverse vite. C\'est l\'inverse.',
            'Un enfant qui a vraiment terminé avec l\'ancien lieu arrive capable de commencer. Celui qu\'on a pressé arrive en le tenant encore. Donnez une forme à la fin : une dernière promenade vers les lieux qui comptaient, photographier la chambre vide, dire au revoir à voix haute à l\'appartement, un petit adieu avec les deux ou trois personnes importantes. Nommer une perte la rend plus petite, pas plus grande.',
            'Méfiez-vous des promesses de rester en contact. Peu nombreuses, et de celles que vous pouvez garantir : un appel vidéo avec un ami nommé, un jour nommé, vaut mieux qu\'une assurance vague que rien ne changera.',
          ],
        },
      },
      {
        heading: {
          en: 'The hard part comes after the boxes are gone',
          de: 'Der schwere Teil kommt nach den Kisten',
          fr: 'Le plus dur vient après les cartons',
        },
        body: {
          en: [
            'The weeks before a move are busy, and busyness carries children too. The dip usually arrives afterwards, once the flat is arranged and the adults have relaxed — which is precisely when everyone expects it to be over.',
            'Expect some regression: broken sleep, clinginess, accidents in children who were dry, a return of a dropped comfort object, refusal to go to school. These are not setbacks and generally do not need correcting; they need the routines they belong to, and time. Reinstating the familiar bedtime sequence in the new room does more than any conversation about how nice the new place is.',
            'If, after roughly two to three months, a child is still not sleeping, still not willing to go to school, has made no connections at all, or has become persistently withdrawn or hopeless, that is the point to speak to your paediatrician or the school psychological service. That is not a failed move. It is the ordinary threshold at which a professional is more use than an article.',
          ],
          de: [
            'Die Wochen vor dem Umzug sind voll, und Betriebsamkeit trägt Kinder mit. Der Einbruch kommt meist danach, wenn die Wohnung eingerichtet ist und die Erwachsenen sich entspannt haben — also genau dann, wenn alle denken, es sei überstanden.',
            'Rechne mit Rückschritten: unruhiger Schlaf, Anhänglichkeit, Einnässen bei Kindern, die trocken waren, ein wiederentdecktes Nuscheli, Schulverweigerung. Das sind keine Rückfälle und braucht meist keine Korrektur; es braucht die Abläufe, zu denen es gehört, und Zeit. Die vertraute Einschlafroutine im neuen Zimmer wieder aufzunehmen wirkt mehr als jedes Gespräch darüber, wie schön es hier ist.',
            'Wenn ein Kind nach etwa zwei bis drei Monaten immer noch nicht schläft, immer noch nicht in die Schule will, überhaupt keine Anschlüsse gefunden hat oder anhaltend zurückgezogen oder mutlos ist, ist das der Punkt für ein Gespräch mit der Kinderärztin oder dem schulpsychologischen Dienst. Das ist kein misslungener Umzug, sondern die normale Schwelle, ab der eine Fachperson mehr nützt als ein Ratgebertext.',
          ],
          fr: [
            'Les semaines précédant un déménagement sont chargées, et l\'agitation porte les enfants. Le creux arrive généralement après, une fois l\'appartement installé et les adultes détendus — précisément quand tout le monde croit que c\'est fini.',
            'Attendez-vous à des régressions : sommeil perturbé, besoin de coller, pipi au lit chez des enfants propres, retour d\'un doudou abandonné, refus de l\'école. Ce ne sont pas des rechutes et cela ne demande pas de correction ; cela demande les routines auxquelles ces comportements appartiennent, et du temps.',
            'Si après deux à trois mois l\'enfant ne dort toujours pas, refuse toujours l\'école, n\'a créé aucun lien, ou reste durablement replié ou découragé, c\'est le moment d\'en parler au pédiatre ou au service psychologique scolaire. Ce n\'est pas un déménagement raté : c\'est le seuil ordinaire où un professionnel est plus utile qu\'un article.',
          ],
        },
      },
    ],
    faq: [
      {
        q: {
          en: 'How far in advance should we tell them?',
          de: 'Wie lange vorher sollen wir es sagen?',
          fr: 'Combien de temps à l\'avance faut-il le dire ?',
        },
        a: {
          en: 'As soon as it is certain rather than possible. Younger children have little use for a date months away and mainly need it repeated as it approaches; school-age children generally want the full timeline at once. The thing to avoid is their hearing it from someone else, or assembling it from overheard fragments.',
          de: 'Sobald es sicher ist statt möglich. Jüngere Kinder können mit einem Datum in Monaten wenig anfangen und brauchen es vor allem wiederholt, wenn es näher rückt; Schulkinder wollen meist den ganzen Ablauf auf einmal. Zu vermeiden ist, dass sie es von jemand anderem hören oder sich aus aufgeschnappten Fetzen zusammenreimen.',
          fr: 'Dès que c\'est certain plutôt que possible. Les plus jeunes font peu de cas d\'une date lointaine et ont surtout besoin qu\'on la répète à mesure ; les enfants scolarisés veulent généralement tout le calendrier d\'un coup. À éviter : qu\'ils l\'apprennent par quelqu\'un d\'autre ou par bribes surprises.',
        },
      },
      {
        q: {
          en: 'Should we recreate the old room exactly?',
          de: 'Sollen wir das alte Zimmer genau nachbauen?',
          fr: 'Faut-il reproduire l\'ancienne chambre à l\'identique ?',
        },
        a: {
          en: 'Keep the objects and the routines; do not try to reproduce the layout. The same bedding, the same lamp and the same order of events at bedtime carry the familiarity. An exact copy of a room that no longer exists tends to invite comparison rather than settle it.',
          de: 'Behaltet die Gegenstände und die Abläufe; versucht nicht, die Anordnung zu kopieren. Dieselbe Bettwäsche, dieselbe Lampe und dieselbe Reihenfolge beim Zubettgehen tragen das Vertraute. Eine exakte Kopie eines Zimmers, das es nicht mehr gibt, lädt eher zum Vergleichen ein, als dass sie beruhigt.',
          fr: 'Gardez les objets et les routines ; n\'essayez pas de reproduire la disposition. La même parure de lit, la même lampe et le même ordre du coucher portent la familiarité. Une copie exacte d\'une chambre qui n\'existe plus invite à la comparaison plutôt qu\'elle n\'apaise.',
        },
      },
      {
        q: {
          en: 'What if they refuse to say goodbye to anyone?',
          de: 'Was, wenn es sich von niemandem verabschieden will?',
          fr: 'Et s\'il refuse de dire au revoir à qui que ce soit ?',
        },
        a: {
          en: 'Refusing the goodbye is usually a way of refusing the move, and forcing it rarely helps. Offer a smaller version — a drawing left behind, a photo taken, a message recorded — and leave the door open. Some children do it a week later, from the new place, once it feels safe enough to look back.',
          de: 'Den Abschied zu verweigern ist meist eine Art, den Umzug zu verweigern, und Erzwingen hilft selten. Biete eine kleinere Form an — eine zurückgelassene Zeichnung, ein Foto, eine aufgenommene Nachricht — und lass die Tür offen. Manche Kinder holen es eine Woche später vom neuen Ort aus nach, wenn es sicher genug ist zurückzuschauen.',
          fr: 'Refuser l\'au revoir est souvent une manière de refuser le départ, et forcer aide rarement. Proposez une version plus petite — un dessin laissé, une photo, un message enregistré — et laissez la porte ouverte. Certains enfants le font une semaine plus tard, depuis le nouveau lieu.',
        },
      },
    ],
  },
  // ─── 5. Mutmacher: a new sibling ─────────────────────────────────────────
  // "ich bekomme ein geschwisterchen", "kind eifersucht baby", "geschwisterkind
  // vorbereiten". GSC already shows this cluster reaching us — but only via
  // product queries ("geschwisterbuch personalisiert", pos 38.3), never the
  // parent's own question.
  {
    id: 'neues-geschwisterchen',
    category: 'helping',
    readingMinutes: 6,
    relatedTheme: 'new-sibling',
    title: {
      en: 'A New Baby Is Coming: Preparing the Older Child',
      de: 'Ein Geschwisterchen kommt: das ältere Kind vorbereiten',
      fr: 'Un bébé arrive : préparer l\'aîné',
    },
    description: {
      en: 'Why regression is normal, why promising a playmate backfires, what to protect, and which well-meant sentences cause the most trouble.',
      de: 'Warum Rückschritte normal sind, warum das Versprechen eines Spielkameraden nach hinten losgeht, was du schützen solltest und welche gut gemeinten Sätze am meisten Ärger machen.',
      fr: 'Pourquoi la régression est normale, pourquoi promettre un camarade de jeu se retourne contre vous, quoi protéger, et quelles phrases bien intentionnées font le plus de dégâts.',
    },
    intro: {
      en: 'From the older child\'s side, a new baby is not an addition to the family. It is a renegotiation of their position in it, decided by other people, with no vote. Most of what follows — the clinginess, the regression, the sudden fury over nothing — makes sense once you read it as a response to that, rather than as bad behaviour.',
      de: 'Aus Sicht des älteren Kindes ist ein Baby keine Ergänzung der Familie. Es ist eine Neuverhandlung seines Platzes darin, entschieden von anderen, ohne Stimmrecht. Das meiste, was folgt — die Anhänglichkeit, die Rückschritte, die plötzliche Wut über nichts — ergibt Sinn, sobald man es als Antwort darauf liest und nicht als schlechtes Benehmen.',
      fr: 'Du point de vue de l\'aîné, un bébé n\'est pas un ajout à la famille. C\'est une renégociation de sa place, décidée par d\'autres, sans droit de vote. L\'essentiel de ce qui suit — l\'attachement, la régression, la colère soudaine pour rien — prend sens dès qu\'on le lit comme une réponse à cela.',
    },
    sections: [
      {
        heading: {
          en: 'Do not sell the baby as a playmate',
          de: 'Verkauf das Baby nicht als Spielkameraden',
          fr: 'Ne vendez pas le bébé comme camarade de jeu',
        },
        body: {
          en: [
            '"You will have someone to play with" is the most common preparation and the one most reliably followed by disappointment. What arrives cannot play, cannot talk, and absorbs the adults completely. A child who was promised a friend concludes either that they were lied to or that the baby is defective.',
            'The honest version works better and children handle it well: at first the baby will mostly sleep, cry and be carried around, it will not be able to play for a long time, and it will need a great deal of attention that used to be yours. Say that part out loud. Being warned about something hard is much easier than discovering it while also being told how lovely it is.',
            'It also helps to be clear about what will not change. Who collects them from kindergarten, where they sit at the table, what happens at bedtime, which afternoon is theirs. Continuity is more reassuring than any promise about the baby.',
          ],
          de: [
            '«Du bekommst jemanden zum Spielen» ist die häufigste Vorbereitung — und die, auf die am verlässlichsten Enttäuschung folgt. Was ankommt, kann nicht spielen, nicht sprechen und nimmt die Erwachsenen vollständig in Beschlag. Ein Kind, dem man einen Freund versprochen hat, schliesst entweder, dass man es angelogen hat, oder dass das Baby kaputt ist.',
            'Die ehrliche Variante wirkt besser, und Kinder halten sie gut aus: Am Anfang wird das Baby vor allem schlafen, schreien und herumgetragen werden, es wird lange nicht spielen können, und es wird sehr viel Aufmerksamkeit brauchen, die vorher dir gehörte. Sag diesen Teil laut. Vor etwas Schwierigem gewarnt zu werden ist viel leichter, als es zu entdecken, während einem erzählt wird, wie schön es ist.',
            'Ebenso hilfreich ist Klarheit darüber, was sich nicht ändert. Wer aus dem Kindergarten abholt, wo man am Tisch sitzt, was beim Zubettgehen passiert, welcher Nachmittag der eigene ist. Kontinuität beruhigt mehr als jedes Versprechen über das Baby.',
          ],
          fr: [
            '« Tu auras quelqu\'un avec qui jouer » est la préparation la plus courante et celle qui mène le plus sûrement à la déception. Ce qui arrive ne peut ni jouer, ni parler, et absorbe entièrement les adultes. Un enfant à qui on a promis un ami conclut soit qu\'on lui a menti, soit que le bébé est défectueux.',
            'La version honnête fonctionne mieux : au début le bébé dormira, pleurera et sera porté, il ne pourra pas jouer avant longtemps, et il demandera beaucoup d\'attention qui était la tienne. Dites cette partie à voix haute. Être prévenu d\'une difficulté est bien plus facile que la découvrir pendant qu\'on vous explique combien c\'est merveilleux.',
            'Il aide aussi d\'être clair sur ce qui ne changera pas : qui vient le chercher, où il s\'assied à table, ce qui se passe au coucher, quel après-midi est le sien. La continuité rassure plus que toute promesse sur le bébé.',
          ],
        },
      },
      {
        heading: {
          en: 'Regression is communication, not manipulation',
          de: 'Rückschritte sind Kommunikation, keine Manipulation',
          fr: 'La régression est une communication, pas une manipulation',
        },
        body: {
          en: [
            'A child who has been dry for a year starts wetting again. A child who talks in full sentences reverts to baby talk. Someone who fell asleep alone now needs a hand held. This is extremely common and it is not a plot.',
            'The logic is visible once stated: a very small creature arrived and is receiving enormous quantities of care. Being small looks, from the outside, like a highly effective strategy. Testing it is a reasonable experiment.',
            'The response that shortens it is to grant the underlying request rather than fight the behaviour. Being fed a spoonful, being carried up the stairs, being rocked — briefly, willingly, without commentary about being big. What extends regression is resistance, because it turns a request for closeness into a battle worth continuing. Most of it fades within weeks once the child establishes that closeness is still available without having to become a baby to get it.',
          ],
          de: [
            'Ein Kind, das seit einem Jahr trocken ist, nässt wieder ein. Eines, das in ganzen Sätzen spricht, fällt in Babysprache zurück. Wer allein eingeschlafen ist, braucht plötzlich eine Hand. Das ist ausgesprochen häufig und kein Komplott.',
            'Die Logik ist sichtbar, sobald man sie ausspricht: Ein sehr kleines Wesen ist angekommen und bekommt enorme Mengen an Fürsorge. Klein zu sein sieht von aussen nach einer hochwirksamen Strategie aus. Sie auszuprobieren ist ein vernünftiges Experiment.',
            'Die Reaktion, die es verkürzt, ist dem dahinterliegenden Wunsch nachzugeben statt das Verhalten zu bekämpfen. Einen Löffel gefüttert werden, die Treppe hochgetragen werden, geschaukelt werden — kurz, bereitwillig, ohne Kommentar darüber, dass man doch gross sei. Was Rückschritte verlängert, ist Widerstand, weil er aus einer Bitte um Nähe einen Kampf macht, den fortzusetzen sich lohnt. Das meiste verliert sich in Wochen, sobald das Kind festgestellt hat, dass Nähe weiter verfügbar ist, ohne dafür Baby werden zu müssen.',
          ],
          fr: [
            'Un enfant propre depuis un an refait pipi au lit. Un enfant qui parle par phrases revient au langage bébé. Celui qui s\'endormait seul réclame une main. C\'est extrêmement fréquent et ce n\'est pas un complot.',
            'La logique apparaît dès qu\'on l\'énonce : une très petite créature est arrivée et reçoit d\'énormes quantités de soins. Être petit ressemble, vu de l\'extérieur, à une stratégie très efficace. La tester est une expérience raisonnable.',
            'La réponse qui raccourcit tout cela consiste à accorder la demande sous-jacente plutôt qu\'à combattre le comportement : une cuillère donnée, être porté dans l\'escalier, être bercé — brièvement, volontiers, sans commentaire sur le fait d\'être grand. Ce qui prolonge la régression, c\'est la résistance, qui transforme une demande de proximité en bataille.',
          ],
        },
      },
      {
        heading: {
          en: 'Protect one thing that stays entirely theirs',
          de: 'Schütze eine Sache, die ganz ihm gehört',
          fr: 'Protégez une chose qui reste entièrement la sienne',
        },
        body: {
          en: [
            'Almost everything becomes shared: your lap, your attention, the living room, eventually the toys and possibly the bedroom. A child who experiences the arrival as pure subtraction has good reason to resent the cause.',
            'The counterweight is something reliably exempt. A shelf the baby will never be allowed to reach. A particular soft toy that is not communal. Twenty minutes after the baby goes down that belong to them, at a predictable time, doing something they choose, with the phone in another room. Short and dependable beats long and occasional.',
            'Guard it in front of them, visibly. Saying that the baby is not allowed to touch that shelf, in the older child\'s hearing, does more than an hour of explaining that you love them just the same.',
          ],
          de: [
            'Fast alles wird geteilt: dein Schoss, deine Aufmerksamkeit, das Wohnzimmer, irgendwann das Spielzeug und womöglich das Zimmer. Ein Kind, das die Ankunft als reine Subtraktion erlebt, hat guten Grund, dem Verursacher böse zu sein.',
            'Das Gegengewicht ist etwas verlässlich Ausgenommenes. Ein Regal, an das das Baby nie darf. Ein bestimmtes Kuscheltier, das nicht gemeinsam ist. Zwanzig Minuten, nachdem das Baby schläft, die ihm gehören, zu einer vorhersehbaren Zeit, mit etwas Selbstgewähltem, das Handy im anderen Zimmer. Kurz und verlässlich schlägt lang und gelegentlich.',
            'Verteidige es sichtbar vor ihm. Zu sagen, dass das Baby dieses Regal nicht anfassen darf, in Hörweite des älteren Kindes, wirkt mehr als eine Stunde Erklären, dass man es genauso lieb hat.',
          ],
          fr: [
            'Presque tout devient partagé : vos genoux, votre attention, le salon, bientôt les jouets et peut-être la chambre. Un enfant qui vit l\'arrivée comme une pure soustraction a de bonnes raisons d\'en vouloir à la cause.',
            'Le contrepoids est quelque chose de fiablement exempté. Une étagère où le bébé n\'aura jamais le droit d\'aller. Une peluche précise qui n\'est pas commune. Vingt minutes après le coucher du bébé qui lui appartiennent, à heure prévisible, avec une activité qu\'il choisit, téléphone dans l\'autre pièce. Court et fiable vaut mieux que long et occasionnel.',
            'Défendez-la visiblement devant lui. Dire que le bébé n\'a pas le droit de toucher cette étagère, à portée d\'oreille de l\'aîné, fait plus qu\'une heure d\'explications sur votre amour égal.',
          ],
        },
      },
      {
        heading: {
          en: 'The sentences that backfire',
          de: 'Die Sätze, die nach hinten losgehen',
          fr: 'Les phrases qui se retournent contre vous',
        },
        body: {
          en: [
            '"You are the big one now." It sounds like promotion and functions as a demotion: a set of obligations handed over on a day the child did not choose. Big is not something they asked to become.',
            '"Be careful, you will hurt him." Repeated often enough, this describes the older child as a danger to the baby, and children tend to live up to the descriptions they are given. Where possible, say what to do rather than what not to: support his head, sit down first, use two hands.',
            '"Look how much he loves you!" over an infant who is looking at a lamp. Older children detect the invention and it makes the rest of what you say less trustworthy. There will be real moments — the baby genuinely tracking them across a room, calming to their voice — and pointing at those instead is worth far more precisely because it is true.',
          ],
          de: [
            '«Du bist jetzt der Grosse.» Es klingt nach Beförderung und wirkt als Rückstufung: ein Paket Pflichten, übergeben an einem Tag, den das Kind nicht gewählt hat. Gross zu sein hat es nicht beantragt.',
            '«Pass auf, du tust ihm weh.» Oft genug wiederholt, beschreibt das das ältere Kind als Gefahr für das Baby — und Kinder wachsen in die Beschreibungen hinein, die sie bekommen. Sag, wo möglich, was zu tun ist statt was nicht: den Kopf stützen, dich zuerst hinsetzen, beide Hände nehmen.',
            '«Schau, wie lieb er dich hat!» über einem Säugling, der eine Lampe anschaut. Ältere Kinder merken die Erfindung, und sie macht alles Übrige weniger glaubwürdig. Es wird echte Momente geben — das Baby folgt ihm wirklich mit den Augen durch den Raum, beruhigt sich bei seiner Stimme — und auf die zu zeigen ist viel mehr wert, gerade weil es stimmt.',
          ],
          fr: [
            '« Tu es le grand maintenant. » Cela sonne comme une promotion et fonctionne comme une rétrogradation : un lot d\'obligations remis un jour que l\'enfant n\'a pas choisi.',
            '« Attention, tu vas lui faire mal. » Répété assez souvent, cela décrit l\'aîné comme un danger pour le bébé — et les enfants deviennent les descriptions qu\'on leur donne. Dites plutôt quoi faire : soutenir sa tête, s\'asseoir d\'abord, prendre à deux mains.',
            '« Regarde comme il t\'aime ! » au-dessus d\'un nourrisson qui fixe une lampe. Les aînés repèrent l\'invention, et cela rend le reste moins crédible. Il y aura de vrais moments — le bébé qui le suit vraiment des yeux, qui se calme à sa voix — et les montrer vaut bien plus, précisément parce que c\'est vrai.',
          ],
        },
      },
      {
        heading: {
          en: 'When to ask for help',
          de: 'Wann du Hilfe holen solltest',
          fr: 'Quand demander de l\'aide',
        },
        body: {
          en: [
            'Jealousy, regression, rough handling and periods of ignoring the baby entirely are all within the ordinary range, and most of it settles over the first months.',
            'Worth raising with someone: deliberate, repeated hurting that continues after consistent responses; a child who becomes persistently flat, withdrawn or joyless rather than angry; a marked and lasting change in eating or sleeping; or your own sense that you cannot manage, which matters just as much and is far more common than people admit.',
            'Your paediatrician and the local mother-and-child advisory service are the ordinary first places to ask. This article is general information for the usual case, not advice about a particular child.',
          ],
          de: [
            'Eifersucht, Rückschritte, grober Umgang und Phasen, in denen das Baby völlig ignoriert wird, liegen alle im normalen Bereich, und das meiste legt sich über die ersten Monate.',
            'Ansprechen sollte man: absichtliches, wiederholtes Wehtun, das trotz gleichbleibender Reaktionen weitergeht; ein Kind, das anhaltend flach, zurückgezogen oder freudlos wird statt wütend; eine deutliche, andauernde Veränderung bei Essen oder Schlaf; oder dein eigenes Gefühl, dass du nicht mehr kannst — das zählt genauso und ist weit häufiger, als zugegeben wird.',
            'Kinderärztin und die Mütter- und Väterberatung sind die üblichen ersten Anlaufstellen. Dieser Text ist allgemeine Information für den Normalfall, keine Beratung für ein bestimmtes Kind.',
          ],
          fr: [
            'Jalousie, régression, gestes brusques et périodes où le bébé est totalement ignoré font partie de la normale, et l\'essentiel se tasse sur les premiers mois.',
            'À signaler : des gestes blessants délibérés et répétés qui persistent malgré des réponses constantes ; un enfant durablement éteint, replié ou sans joie plutôt qu\'en colère ; un changement marqué et durable du sommeil ou de l\'appétit ; ou votre propre sentiment de ne plus y arriver, qui compte tout autant.',
            'Le pédiatre et le service de puériculture sont les premiers interlocuteurs habituels. Ce texte est une information générale, pas un conseil pour un enfant précis.',
          ],
        },
      },
    ],
    faq: [
      {
        q: {
          en: 'When should we tell the older child about the pregnancy?',
          de: 'Wann sollen wir dem älteren Kind von der Schwangerschaft erzählen?',
          fr: 'Quand annoncer la grossesse à l\'aîné ?',
        },
        a: {
          en: 'Later than you tell adults, for a practical reason: small children have little grasp of months, and a long wait mostly produces repeated questions about whether it is today. Telling them once it is visible and once other people might mention it in front of them is usually about right.',
          de: 'Später als den Erwachsenen, aus einem praktischen Grund: Kleine Kinder haben wenig Gefühl für Monate, und eine lange Wartezeit erzeugt vor allem wiederholte Fragen, ob es heute soweit ist. Es zu sagen, sobald es sichtbar ist und sobald andere es in ihrer Gegenwart erwähnen könnten, trifft es meist gut.',
          fr: 'Plus tard qu\'aux adultes, pour une raison pratique : les jeunes enfants saisissent mal les mois, et une longue attente produit surtout des questions répétées. L\'annoncer quand cela devient visible, et quand d\'autres pourraient en parler devant eux, tombe généralement juste.',
        },
      },
      {
        q: {
          en: 'He hits the baby. What do I do?',
          de: 'Es schlägt das Baby. Was mache ich?',
          fr: 'Il frappe le bébé. Que faire ?',
        },
        a: {
          en: 'Stop it physically and calmly, every time, without a lecture, and then attend to the baby. Afterwards, once things are quiet, name what you think was underneath it — that it is hard when someone else is being held. The behaviour needs a firm boundary; the feeling behind it needs somewhere else to go, and supplying that is what actually reduces the hitting.',
          de: 'Halte es jedes Mal körperlich und ruhig auf, ohne Predigt, und kümmere dich dann um das Baby. Später, wenn Ruhe ist, benenne, was du dahinter vermutest — dass es schwer ist, wenn jemand anderes gehalten wird. Das Verhalten braucht eine klare Grenze; das Gefühl dahinter braucht einen anderen Weg, und den zu geben ist das, was das Schlagen tatsächlich reduziert.',
          fr: 'Arrêtez-le physiquement et calmement, chaque fois, sans sermon, puis occupez-vous du bébé. Plus tard, au calme, nommez ce qu\'il y avait dessous — que c\'est dur quand quelqu\'un d\'autre est dans les bras. Le comportement a besoin d\'une limite ferme ; le sentiment a besoin d\'une autre issue.',
        },
      },
      {
        q: {
          en: 'How long does the jealousy last?',
          de: 'Wie lange dauert die Eifersucht?',
          fr: 'Combien de temps dure la jalousie ?',
        },
        a: {
          en: 'The acute phase is usually weeks to a few months. It often returns in a milder form when the baby starts moving and can reach things, which surprises parents who thought it was over — at that point the complaint is concrete and legitimate, because the baby really is wrecking the tower.',
          de: 'Die akute Phase dauert meist Wochen bis wenige Monate. Sie kommt oft milder zurück, wenn das Baby sich fortbewegt und an Dinge herankommt, was Eltern überrascht, die dachten, es sei vorbei — dann ist die Beschwerde konkret und berechtigt, denn das Baby zerstört den Turm tatsächlich.',
          fr: 'La phase aiguë dure généralement de quelques semaines à quelques mois. Elle revient souvent, atténuée, quand le bébé se déplace et attrape des objets — à ce moment la plainte est concrète et légitime, car le bébé détruit vraiment la tour.',
        },
      },
    ],
  },
];

export const guidesByCategory = (category: GuideCategory) =>
  guides.filter((g) => g.category === category);
