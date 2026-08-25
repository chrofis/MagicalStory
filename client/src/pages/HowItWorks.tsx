import { Link } from 'react-router-dom';
import { Pencil, Image, Wand2, BookOpen, Users, Palette, ArrowRight } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import { Navigation, Footer } from '@/components/common';

const translations = {
  en: {
    title: 'Create a Children\'s Book with AI',
    subtitle: 'Your own story — not a template with the name swapped in.',
    heroDesc: 'Most personalized books are one pre-written story with your child\'s name dropped into it. MagicalStory writes an original story instead: upload a photo, describe what should happen, and the AI writes and illustrates a book that has never existed before. Then you edit every word and regenerate any page until it is exactly how you imagined it.',
    stepsTitle: 'How to create your children\'s book',
    step1Title: 'Upload a photo',
    step1Desc: 'One clear photo per character. Your child, siblings, grandparents — up to 10 people, each recognizable on every page.',
    step2Title: 'Describe your story',
    step2Desc: 'Pick from 170+ themes or describe your own idea: a first day at school, a lost tooth, a dragon in the garden. The story is written around it.',
    step3Title: 'AI writes and illustrates',
    step3Desc: 'An original story with matching illustrations in your chosen art style, in German, English or French, at your child\'s reading level.',
    step4Title: 'Edit until it is right',
    step4Desc: 'Rewrite any sentence, regenerate any illustration, fix a single character on a single page. Then read it on screen or order it printed.',
    faqTitle: 'Questions about creating a book',
    faq1Q: 'Can I write my own story, or do I pick from templates?',
    faq1A: 'You describe the story you want and the AI writes it. Themes are starting points, not fixed texts — two books on the same theme come out as different stories. You can also edit every sentence afterwards.',
    faq2Q: 'What does the AI actually do?',
    faq2A: 'It writes the text and generates every illustration. Your uploaded photo is used to keep each character looking consistent across all pages, rather than pasting the photo into the book.',
    faq3Q: 'How long does it take to create a book?',
    faq3A: 'The first version is ready in a few minutes. Editing and regenerating pages takes as long as you want to spend on it.',
    faq4Q: 'What does it cost?',
    faq4A: 'The first story is free, with no account required. After that it is CHF 9.90 for a digital book and CHF 33–48 for a printed hardcover.',
    exploreTitle: 'Before you start',
    exploreThemes: 'Browse all 170+ story themes',
    exploreCompare: 'Compare AI children\'s book generators',
    // Sections
    s1Title: 'Edit Every Word',
    s1Desc: 'Every page of text is fully editable. Change names, rewrite sentences, adjust the story to fit your family perfectly. The AI writes the first draft — you make it yours.',
    s1b1: 'Click on any text to edit it directly',
    s1b2: 'Rewrite entire paragraphs or fix individual words',
    s1b3: 'Adjust reading level for your child\'s age',
    s2Title: 'Shape Every Image',
    s2Desc: 'Don\'t like how a scene looks? Describe what you want changed, and a new illustration is generated in seconds. Change the setting, adjust character positions, or try a completely different scene.',
    s2b1: 'Describe changes in your own words — "make the sky bluer" or "add a rainbow"',
    s2b2: 'Reimagine entire scenes with a new description',
    s2b3: 'Keep regenerating a page until it\'s exactly right',
    s3Title: 'Consistent Characters',
    s3Desc: 'Upload a photo once, and your child appears consistently throughout the book. If a character doesn\'t look quite right on one page, fix just that page without affecting the rest.',
    s3b1: 'AI maintains character appearance across all pages',
    s3b2: 'Fix individual characters on specific pages',
    s3b3: 'Add up to 10 family members as characters',
    s4Title: '170+ Themes',
    s4Desc: 'From pirate adventures to stories about the first day of school. Each theme is thoughtfully designed with age-appropriate language and engaging plots.',
    s4b1: 'Adventure, fantasy, birthday, bedtime stories',
    s4b2: 'Life challenges: new sibling, dentist visit, overcoming fears',
    s4b3: 'Local stories: Swiss cities, landmarks, and traditions',
    s5Title: '8 Art Styles',
    s5Desc: 'Choose from Pixar-style 3D, watercolor, comic, anime, realistic, and more. Every style is applied consistently across all pages.',
    ctaTitle: 'Try it free — your first story costs nothing',
    ctaDesc: 'Upload a photo, pick a theme, and see your personalized book in under 3 minutes. No account needed.',
    ctaButton: 'Create Your Story',
  },
  de: {
    title: 'Kinderbuch erstellen mit KI',
    subtitle: 'Deine eigene Geschichte — keine Vorlage mit ausgetauschtem Namen.',
    heroDesc: 'Die meisten personalisierten Bücher sind eine fertig geschriebene Geschichte, in die nur der Name deines Kindes eingesetzt wird. MagicalStory schreibt stattdessen eine eigene Geschichte: Foto hochladen, beschreiben was passieren soll — die KI schreibt und illustriert ein Buch, das es vorher nicht gab. Danach bearbeitest du jedes Wort und generierst jede Seite neu, bis alles genau so ist, wie du es dir vorgestellt hast.',
    stepsTitle: 'So erstellst du dein Kinderbuch',
    step1Title: 'Foto hochladen',
    step1Desc: 'Ein klares Foto pro Figur. Dein Kind, Geschwister, Grosseltern — bis zu 10 Personen, auf jeder Seite wiedererkennbar.',
    step2Title: 'Geschichte beschreiben',
    step2Desc: 'Wähle aus über 170 Themen oder beschreibe deine eigene Idee: der erste Schultag, ein Wackelzahn, ein Drache im Garten. Die Geschichte wird darum herum geschrieben.',
    step3Title: 'Die KI schreibt und illustriert',
    step3Desc: 'Eine eigene Geschichte mit passenden Illustrationen im gewählten Kunststil — auf Deutsch, Englisch oder Französisch, in der Lesestufe deines Kindes.',
    step4Title: 'Bearbeiten bis es stimmt',
    step4Desc: 'Jeden Satz umschreiben, jede Illustration neu generieren, eine einzelne Figur auf einer einzelnen Seite korrigieren. Danach am Bildschirm lesen oder gedruckt bestellen.',
    faqTitle: 'Fragen zum Erstellen',
    faq1Q: 'Kann ich meine eigene Geschichte schreiben oder wähle ich aus Vorlagen?',
    faq1A: 'Du beschreibst die Geschichte, die du möchtest, und die KI schreibt sie. Themen sind Ausgangspunkte, keine fertigen Texte — zwei Bücher zum selben Thema werden zu unterschiedlichen Geschichten. Jeden Satz kannst du danach bearbeiten.',
    faq2Q: 'Was macht die KI genau?',
    faq2A: 'Sie schreibt den Text und erzeugt jede Illustration. Dein hochgeladenes Foto dient dazu, jede Figur auf allen Seiten gleich aussehen zu lassen — das Foto wird nicht ins Buch geklebt.',
    faq3Q: 'Wie lange dauert es, ein Buch zu erstellen?',
    faq3A: 'Die erste Fassung ist in wenigen Minuten fertig. Bearbeiten und Neugenerieren dauert so lange, wie du dafür aufwenden möchtest.',
    faq4Q: 'Was kostet es?',
    faq4A: 'Die erste Geschichte ist gratis, ohne Konto. Danach kostet ein digitales Buch CHF 9.90, ein gedrucktes Hardcover CHF 33–48.',
    exploreTitle: 'Bevor du startest',
    exploreThemes: 'Alle 170+ Themen ansehen',
    exploreCompare: 'KI-Kinderbuch-Generatoren vergleichen',
    s1Title: 'Jeden Text bearbeiten',
    s1Desc: 'Jede Seite ist vollständig editierbar. Ändere Namen, schreibe Sätze um, passe die Geschichte an deine Familie an. Die KI schreibt den ersten Entwurf — du machst ihn zu deinem.',
    s1b1: 'Klicke auf einen Text, um ihn direkt zu bearbeiten',
    s1b2: 'Ganze Absätze umschreiben oder einzelne Wörter anpassen',
    s1b3: 'Lesestufe an das Alter deines Kindes anpassen',
    s2Title: 'Jedes Bild gestalten',
    s2Desc: 'Dir gefällt eine Szene nicht? Beschreibe, was du ändern möchtest, und eine neue Illustration wird in Sekunden erstellt. Ändere die Umgebung, passe Positionen an oder probiere eine komplett neue Szene.',
    s2b1: 'Beschreibe Änderungen in deinen Worten — "mach den Himmel blauer" oder "füge einen Regenbogen hinzu"',
    s2b2: 'Szenen komplett neu gestalten mit einer neuen Beschreibung',
    s2b3: 'Eine Seite immer wieder neu generieren, bis sie perfekt ist',
    s3Title: 'Einheitliche Charaktere',
    s3Desc: 'Lade ein Foto hoch und dein Kind erscheint einheitlich im ganzen Buch. Wenn ein Charakter auf einer Seite nicht perfekt aussieht, korrigiere nur diese Seite — ohne den Rest zu beeinflussen.',
    s3b1: 'KI behält das Aussehen der Charaktere auf allen Seiten bei',
    s3b2: 'Einzelne Charaktere auf bestimmten Seiten korrigieren',
    s3b3: 'Bis zu 10 Familienmitglieder als Charaktere hinzufügen',
    s4Title: '170+ Themen',
    s4Desc: 'Von Piraten-Abenteuern bis zu Geschichten über den ersten Schultag. Jedes Thema ist sorgfältig gestaltet mit altersgerechter Sprache und spannenden Handlungen.',
    s4b1: 'Abenteuer, Fantasy, Geburtstag, Gute-Nacht-Geschichten',
    s4b2: 'Herausforderungen: neues Geschwisterchen, Zahnarztbesuch, Ängste überwinden',
    s4b3: 'Lokale Geschichten: Schweizer Städte, Wahrzeichen und Traditionen',
    s5Title: '8 Kunststile',
    s5Desc: 'Wähle aus Pixar-ähnlichem 3D, Aquarell, Comic, Anime, Realistisch und mehr. Jeder Stil wird einheitlich auf allen Seiten angewendet.',
    ctaTitle: 'Kostenlos ausprobieren — deine erste Geschichte kostet nichts',
    ctaDesc: 'Lade ein Foto hoch, wähle ein Thema und sieh dein personalisiertes Buch in unter 3 Minuten. Kein Konto nötig.',
    ctaButton: 'Geschichte erstellen',
  },
  fr: {
    title: 'Créer un livre pour enfant avec l\'IA',
    subtitle: 'Votre propre histoire — pas un modèle avec le prénom remplacé.',
    heroDesc: 'La plupart des livres personnalisés sont une histoire déjà écrite dans laquelle on insère le prénom de votre enfant. MagicalStory écrit une histoire originale : téléchargez une photo, décrivez ce qui doit se passer, et l\'IA écrit et illustre un livre qui n\'existait pas avant. Ensuite vous modifiez chaque mot et régénérez chaque page jusqu\'à ce que tout soit exactement comme vous l\'imaginiez.',
    stepsTitle: 'Comment créer votre livre pour enfant',
    step1Title: 'Téléchargez une photo',
    step1Desc: 'Une photo nette par personnage. Votre enfant, ses frères et sœurs, ses grands-parents — jusqu\'à 10 personnes, reconnaissables sur chaque page.',
    step2Title: 'Décrivez votre histoire',
    step2Desc: 'Choisissez parmi plus de 170 thèmes ou décrivez votre propre idée : la rentrée, une dent qui bouge, un dragon dans le jardin. L\'histoire est écrite autour.',
    step3Title: 'L\'IA écrit et illustre',
    step3Desc: 'Une histoire originale avec des illustrations assorties dans le style choisi, en allemand, anglais ou français, au niveau de lecture de votre enfant.',
    step4Title: 'Modifiez jusqu\'au bon résultat',
    step4Desc: 'Réécrivez une phrase, régénérez une illustration, corrigez un seul personnage sur une seule page. Puis lisez à l\'écran ou commandez l\'impression.',
    faqTitle: 'Questions sur la création',
    faq1Q: 'Puis-je écrire ma propre histoire ou dois-je choisir un modèle ?',
    faq1A: 'Vous décrivez l\'histoire souhaitée et l\'IA l\'écrit. Les thèmes sont des points de départ, pas des textes figés — deux livres sur le même thème donnent deux histoires différentes. Vous pouvez ensuite modifier chaque phrase.',
    faq2Q: 'Que fait exactement l\'IA ?',
    faq2A: 'Elle écrit le texte et génère chaque illustration. Votre photo sert à garder chaque personnage identique sur toutes les pages — elle n\'est pas collée dans le livre.',
    faq3Q: 'Combien de temps faut-il pour créer un livre ?',
    faq3A: 'La première version est prête en quelques minutes. Les modifications prennent le temps que vous souhaitez y consacrer.',
    faq4Q: 'Quel est le prix ?',
    faq4A: 'La première histoire est gratuite, sans compte. Ensuite, CHF 9.90 pour un livre numérique et CHF 33–48 pour un livre relié imprimé.',
    exploreTitle: 'Avant de commencer',
    exploreThemes: 'Voir les 170+ thèmes',
    exploreCompare: 'Comparer les générateurs de livres IA',
    s1Title: 'Modifiez chaque texte',
    s1Desc: 'Chaque page est entièrement modifiable. Changez les noms, réécrivez des phrases, adaptez l\'histoire à votre famille. L\'IA écrit le premier brouillon — vous le personnalisez.',
    s1b1: 'Cliquez sur un texte pour le modifier directement',
    s1b2: 'Réécrivez des paragraphes entiers ou ajustez des mots',
    s1b3: 'Adaptez le niveau de lecture à l\'âge de votre enfant',
    s2Title: 'Façonnez chaque image',
    s2Desc: 'Une scène ne vous plaît pas ? Décrivez ce que vous voulez changer et une nouvelle illustration est créée en secondes.',
    s2b1: 'Décrivez les changements — "rendre le ciel plus bleu" ou "ajouter un arc-en-ciel"',
    s2b2: 'Réimaginez des scènes entières avec une nouvelle description',
    s2b3: 'Régénérez une page encore et encore jusqu\'à ce qu\'elle soit parfaite',
    s3Title: 'Personnages cohérents',
    s3Desc: 'Téléchargez une photo et votre enfant apparaît de manière cohérente dans tout le livre. Si un personnage n\'est pas parfait sur une page, corrigez uniquement cette page.',
    s3b1: 'L\'IA maintient l\'apparence sur toutes les pages',
    s3b2: 'Corrigez des personnages individuels sur des pages spécifiques',
    s3b3: 'Ajoutez jusqu\'à 10 membres de la famille',
    s4Title: '170+ thèmes',
    s4Desc: 'Des aventures de pirates aux histoires sur le premier jour d\'école. Chaque thème est conçu avec un langage adapté à l\'âge.',
    s4b1: 'Aventure, fantasy, anniversaire, histoires du soir',
    s4b2: 'Défis de la vie : nouveau bébé, dentiste, surmonter ses peurs',
    s4b3: 'Histoires locales : villes suisses, monuments et traditions',
    s5Title: '8 styles artistiques',
    s5Desc: 'Pixar 3D, aquarelle, bande dessinée, anime, réaliste et plus. Style cohérent sur toutes les pages.',
    ctaTitle: 'Essayez gratuitement — votre première histoire est gratuite',
    ctaDesc: 'Téléchargez une photo, choisissez un thème et découvrez votre livre personnalisé en moins de 3 minutes.',
    ctaButton: 'Créer votre histoire',
  },
};

const sections = [
  { key: 's1', icon: Pencil, color: 'indigo' },
  { key: 's2', icon: Image, color: 'emerald' },
  { key: 's3', icon: Users, color: 'amber' },
  { key: 's4', icon: BookOpen, color: 'rose' },
  { key: 's5', icon: Palette, color: 'violet' },
] as const;

const colorMap: Record<string, { bg: string; border: string; icon: string; bullet: string }> = {
  indigo: { bg: 'bg-indigo-50', border: 'border-indigo-200', icon: 'text-indigo-500', bullet: 'text-indigo-500' },
  emerald: { bg: 'bg-emerald-50', border: 'border-emerald-200', icon: 'text-emerald-600', bullet: 'text-emerald-500' },
  amber: { bg: 'bg-amber-50', border: 'border-amber-200', icon: 'text-amber-600', bullet: 'text-amber-500' },
  rose: { bg: 'bg-rose-50', border: 'border-rose-200', icon: 'text-rose-600', bullet: 'text-rose-500' },
  violet: { bg: 'bg-violet-50', border: 'border-violet-200', icon: 'text-violet-600', bullet: 'text-violet-500' },
};

export default function HowItWorks() {
  const { language } = useLanguage();
  const t = translations[language as keyof typeof translations] || translations.de;

  return (
    <div className="min-h-screen bg-white">
      <Navigation currentStep={0} />

      {/* Hero */}
      <section className="pt-24 pb-12 px-4 bg-gradient-to-b from-indigo-50 to-white">
        <div className="max-w-3xl mx-auto text-center">
          <h1 className="text-4xl md:text-5xl font-bold text-gray-900 mb-4">{t.title}</h1>
          <p className="text-xl text-indigo-500 font-medium mb-6">{t.subtitle}</p>
          <p className="text-lg text-gray-600 leading-relaxed">{t.heroDesc}</p>
        </div>
      </section>

      {/* Steps — the "how do I create one" intent, in the words people search with */}
      <section className="py-12 px-4 border-b border-stone-100">
        <div className="max-w-3xl mx-auto">
          <h2 className="text-3xl font-bold text-gray-900 mb-8 text-center">{t.stepsTitle}</h2>
          <ol className="space-y-6">
            {[1, 2, 3, 4].map((n) => (
              <li key={n} className="flex items-start gap-4">
                <span className="shrink-0 w-9 h-9 rounded-full bg-indigo-500 text-white font-bold flex items-center justify-center">
                  {n}
                </span>
                <div>
                  <h3 className="text-lg font-bold text-gray-900 mb-1">
                    {t[`step${n}Title` as keyof typeof t] as string}
                  </h3>
                  <p className="text-gray-600">{t[`step${n}Desc` as keyof typeof t] as string}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* Feature Sections */}
      <section className="py-12 px-4">
        <div className="max-w-3xl mx-auto space-y-8">
          {sections.map(({ key, icon: Icon, color }) => {
            const c = colorMap[color];
            const title = t[`${key}Title` as keyof typeof t] as string;
            const desc = t[`${key}Desc` as keyof typeof t] as string;
            const b1 = t[`${key}b1` as keyof typeof t] as string | undefined;
            const b2 = t[`${key}b2` as keyof typeof t] as string | undefined;
            const b3 = t[`${key}b3` as keyof typeof t] as string | undefined;
            const bullets = [b1, b2, b3].filter(Boolean) as string[];

            return (
              <div key={key} className={`${c.bg} border ${c.border} rounded-2xl p-6 md:p-8`}>
                <div className="flex items-start gap-4">
                  <div className={`shrink-0 w-12 h-12 rounded-xl bg-white shadow-sm flex items-center justify-center ${c.icon}`}>
                    <Icon size={24} />
                  </div>
                  <div>
                    <h2 className="text-xl font-bold text-gray-900 mb-2">{title}</h2>
                    <p className="text-gray-600 mb-4">{desc}</p>
                    {bullets.length > 0 && (
                      <ul className="space-y-2">
                        {bullets.map((b, i) => (
                          <li key={i} className="flex items-start gap-2 text-sm text-gray-700">
                            <span className={`mt-0.5 ${c.bullet}`}>&#10003;</span>
                            {b}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* FAQ — long-tail creation questions, and the answers Google quotes */}
      <section className="py-12 px-4 bg-stone-50 border-y border-stone-100">
        <div className="max-w-3xl mx-auto">
          <h2 className="text-3xl font-bold text-gray-900 mb-8 text-center">{t.faqTitle}</h2>
          <div className="space-y-6">
            {[1, 2, 3, 4].map((n) => (
              <div key={n}>
                <h3 className="text-lg font-bold text-gray-900 mb-2">
                  {t[`faq${n}Q` as keyof typeof t] as string}
                </h3>
                <p className="text-gray-600">{t[`faq${n}A` as keyof typeof t] as string}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Internal links out of this page into the two clusters that matter */}
      <section className="py-10 px-4">
        <div className="max-w-3xl mx-auto text-center">
          <h2 className="text-xl font-bold text-gray-900 mb-4">{t.exploreTitle}</h2>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <Link to="/themes" className="text-indigo-500 font-medium hover:underline">
              {t.exploreThemes}
            </Link>
            <span className="hidden sm:inline text-stone-300">|</span>
            <Link
              to="/vergleich/beste-ki-kinderbuch-generatoren"
              className="text-indigo-500 font-medium hover:underline"
            >
              {t.exploreCompare}
            </Link>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="py-16 px-4 bg-gradient-to-b from-white to-indigo-50">
        <div className="max-w-2xl mx-auto text-center">
          <h2 className="text-3xl font-bold text-gray-900 mb-4">{t.ctaTitle}</h2>
          <p className="text-lg text-gray-600 mb-8">{t.ctaDesc}</p>
          <Link
            to="/try"
            className="inline-flex items-center gap-2 bg-indigo-500 text-white px-8 py-4 rounded-xl text-lg font-semibold hover:bg-indigo-600 transition-colors shadow-lg shadow-indigo-200"
          >
            <Wand2 size={20} />
            {t.ctaButton}
            <ArrowRight size={20} />
          </Link>
        </div>
      </section>

      <Footer />
    </div>
  );
}
