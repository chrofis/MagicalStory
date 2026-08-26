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

export type GuideCategory = 'creating' | 'choosing';

export interface GuideSection {
  heading: Record<'en' | 'de' | 'fr', string>;
  body: Record<'en' | 'de' | 'fr', string[]>;
}

export interface GuideArticle {
  id: string;
  category: GuideCategory;
  /** Minutes, shown to the reader and used for the Article schema. */
  readingMinutes: number;
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
];

export const guidesByCategory = (category: GuideCategory) =>
  guides.filter((g) => g.category === category);
