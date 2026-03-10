import { useState, useMemo } from 'react';
import { useLanguage } from '@/context/LanguageContext';
import { Navigation, Footer } from '@/components/common';
import { ChevronDown, Search, BookOpen, Palette, Printer, Truck, CreditCard, Lock, HelpCircle, Mail } from 'lucide-react';
import { Link } from 'react-router-dom';
import { LucideIcon } from 'lucide-react';

interface FAQItem {
  question: string;
  answer: string;
}

interface FAQCategory {
  id: string;
  icon: LucideIcon;
  color: string;
  bgColor: string;
  label: string;
  items: FAQItem[];
}

const faqContent: Record<string, {
  title: string;
  subtitle: string;
  searchPlaceholder: string;
  noResults: string;
  contactTitle: string;
  contactText: string;
  contactButton: string;
  categories: FAQCategory[];
}> = {
  en: {
    title: 'How can we help?',
    subtitle: 'Find answers to common questions about creating your personalized story.',
    searchPlaceholder: 'Search for a question...',
    noResults: 'No matching questions found. Try a different search term.',
    contactTitle: 'Still have questions?',
    contactText: 'We\'re happy to help. Send us an email and we\'ll get back to you within 24 hours.',
    contactButton: 'Contact Us',
    categories: [
      {
        id: 'getting-started',
        icon: BookOpen,
        color: 'text-indigo-600',
        bgColor: 'bg-indigo-50',
        label: 'Getting Started',
        items: [
          {
            question: 'How does it work?',
            answer: 'Upload a photo of your child, choose a story theme, and we generate a fully illustrated personalized story. Your child appears as an illustrated character on every page, keeping their unique appearance throughout the whole book.',
          },
          {
            question: 'How long does it take?',
            answer: 'Your first free story is ready in under 3 minutes. Full stories with more pages and higher quality take about 10-15 minutes. You\'ll receive an email when your story is ready.',
          },
          {
            question: 'What ages is this for?',
            answer: 'Stories can be created for children of all ages. You can adjust the reading level to match your child — from simple picture books for toddlers to longer stories for school-age children.',
          },
        ],
      },
      {
        id: 'your-story',
        icon: Palette,
        color: 'text-purple-600',
        bgColor: 'bg-purple-50',
        label: 'Your Story',
        items: [
          {
            question: 'Can I add multiple characters?',
            answer: 'Yes! You can add your whole family — children, parents, grandparents, siblings, or friends. Each character gets their own illustrated appearance based on their photo.',
          },
          {
            question: 'What illustration styles are available?',
            answer: 'We offer 8+ styles including Pixar-style 3D, watercolor, comic, anime, and more. Each style is applied consistently across all pages of your story.',
          },
          {
            question: 'Can I edit the story after it\'s generated?',
            answer: 'Yes. You can regenerate individual pages, adjust illustrations, and fine-tune the story to your liking before ordering a printed version.',
          },
        ],
      },
      {
        id: 'printing',
        icon: Printer,
        color: 'text-emerald-600',
        bgColor: 'bg-emerald-50',
        label: 'Printing & Quality',
        items: [
          {
            question: 'How is the book printed?',
            answer: 'Books are professionally printed on high-quality paper in 20x20cm format. You can choose between hardcover and softcover binding. Print quality is comparable to professionally published children\'s books.',
          },
          {
            question: 'Can I download my story as a PDF?',
            answer: 'Yes. Every story can be downloaded as a high-resolution PDF, perfect for reading on tablets or printing at home.',
          },
        ],
      },
      {
        id: 'shipping',
        icon: Truck,
        color: 'text-blue-600',
        bgColor: 'bg-blue-50',
        label: 'Shipping',
        items: [
          {
            question: 'Where do you ship?',
            answer: 'We currently ship printed books within Switzerland. International shipping is available at additional cost. You can also download your story as a PDF to read on any device.',
          },
        ],
      },
      {
        id: 'pricing',
        icon: CreditCard,
        color: 'text-amber-600',
        bgColor: 'bg-amber-50',
        label: 'Pricing',
        items: [
          {
            question: 'How much does it cost?',
            answer: 'Your first story is completely free — no account needed. After that, stories are created with credits. Printed books start at CHF 38 for softcover and CHF 53 for hardcover (including shipping within Switzerland). See our pricing page for details.',
          },
        ],
      },
      {
        id: 'privacy',
        icon: Lock,
        color: 'text-rose-600',
        bgColor: 'bg-rose-50',
        label: 'Privacy & Data',
        items: [
          {
            question: 'Is my data safe?',
            answer: 'Yes. Your photos are used only to create your story illustrations and are never shared, sold, or used for any other purpose. We take privacy seriously — see our Privacy Policy for details.',
          },
        ],
      },
    ],
  },
  de: {
    title: 'Wie können wir helfen?',
    subtitle: 'Finde Antworten auf häufige Fragen rund um deine personalisierte Geschichte.',
    searchPlaceholder: 'Frage suchen...',
    noResults: 'Keine passenden Fragen gefunden. Versuche einen anderen Suchbegriff.',
    contactTitle: 'Noch Fragen?',
    contactText: 'Wir helfen gerne. Schreib uns eine E-Mail und wir melden uns innerhalb von 24 Stunden.',
    contactButton: 'Kontakt aufnehmen',
    categories: [
      {
        id: 'getting-started',
        icon: BookOpen,
        color: 'text-indigo-600',
        bgColor: 'bg-indigo-50',
        label: 'Erste Schritte',
        items: [
          {
            question: 'Wie funktioniert es?',
            answer: 'Lade ein Foto deines Kindes hoch, wähle ein Story-Thema und wir erstellen eine vollständig illustrierte, personalisierte Geschichte. Dein Kind erscheint als illustrierte Figur auf jeder Seite und behält sein einzigartiges Aussehen im ganzen Buch.',
          },
          {
            question: 'Wie lange dauert es?',
            answer: 'Deine erste Gratis-Geschichte ist in unter 3 Minuten fertig. Vollständige Geschichten mit mehr Seiten und höherer Qualität dauern etwa 10-15 Minuten. Du erhältst eine E-Mail, wenn deine Geschichte fertig ist.',
          },
          {
            question: 'Für welches Alter ist das geeignet?',
            answer: 'Geschichten können für Kinder jeden Alters erstellt werden. Du kannst das Leseniveau anpassen — von einfachen Bilderbüchern für Kleinkinder bis zu längeren Geschichten für Schulkinder.',
          },
        ],
      },
      {
        id: 'your-story',
        icon: Palette,
        color: 'text-purple-600',
        bgColor: 'bg-purple-50',
        label: 'Deine Geschichte',
        items: [
          {
            question: 'Kann ich mehrere Charaktere hinzufügen?',
            answer: 'Ja! Du kannst deine ganze Familie hinzufügen — Kinder, Eltern, Grosseltern, Geschwister oder Freunde. Jede Figur erhält ihr eigenes illustriertes Aussehen basierend auf ihrem Foto.',
          },
          {
            question: 'Welche Illustrationsstile gibt es?',
            answer: 'Wir bieten 8+ Stile an, darunter Pixar-ähnliches 3D, Aquarell, Comic, Anime und mehr. Jeder Stil wird einheitlich auf allen Seiten deiner Geschichte angewendet.',
          },
          {
            question: 'Kann ich die Geschichte nach der Erstellung bearbeiten?',
            answer: 'Ja. Du kannst einzelne Seiten neu generieren, Illustrationen anpassen und die Geschichte nach deinen Wünschen verfeinern, bevor du eine gedruckte Version bestellst.',
          },
        ],
      },
      {
        id: 'printing',
        icon: Printer,
        color: 'text-emerald-600',
        bgColor: 'bg-emerald-50',
        label: 'Druck & Qualität',
        items: [
          {
            question: 'Wie wird das Buch gedruckt?',
            answer: 'Bücher werden professionell auf hochwertigem Papier im Format 20x20cm gedruckt. Du kannst zwischen Hardcover und Softcover wählen. Die Druckqualität ist vergleichbar mit professionell veröffentlichten Kinderbüchern.',
          },
          {
            question: 'Kann ich die Geschichte als PDF herunterladen?',
            answer: 'Ja. Jede Geschichte kann als hochauflösendes PDF heruntergeladen werden — perfekt zum Lesen auf dem Tablet oder zum Ausdrucken zu Hause.',
          },
        ],
      },
      {
        id: 'shipping',
        icon: Truck,
        color: 'text-blue-600',
        bgColor: 'bg-blue-50',
        label: 'Versand',
        items: [
          {
            question: 'Wohin wird geliefert?',
            answer: 'Wir liefern gedruckte Bücher derzeit innerhalb der Schweiz. Internationaler Versand ist gegen Aufpreis möglich. Du kannst deine Geschichte auch als PDF herunterladen und auf jedem Gerät lesen.',
          },
        ],
      },
      {
        id: 'pricing',
        icon: CreditCard,
        color: 'text-amber-600',
        bgColor: 'bg-amber-50',
        label: 'Preise',
        items: [
          {
            question: 'Was kostet es?',
            answer: 'Deine erste Geschichte ist komplett kostenlos — ohne Konto. Danach werden Geschichten mit Credits erstellt. Gedruckte Bücher beginnen ab CHF 38 für Softcover und CHF 53 für Hardcover (inkl. Versand innerhalb der Schweiz). Details findest du auf unserer Preisseite.',
          },
        ],
      },
      {
        id: 'privacy',
        icon: Lock,
        color: 'text-rose-600',
        bgColor: 'bg-rose-50',
        label: 'Datenschutz',
        items: [
          {
            question: 'Sind meine Daten sicher?',
            answer: 'Ja. Deine Fotos werden ausschliesslich zur Erstellung deiner Geschichte verwendet und niemals geteilt, verkauft oder für andere Zwecke genutzt. Datenschutz ist uns wichtig — Details findest du in unserer Datenschutzerklärung.',
          },
        ],
      },
    ],
  },
  fr: {
    title: 'Comment pouvons-nous vous aider ?',
    subtitle: 'Trouvez les réponses aux questions fréquentes sur la création de votre histoire personnalisée.',
    searchPlaceholder: 'Rechercher une question...',
    noResults: 'Aucune question correspondante. Essayez un autre terme de recherche.',
    contactTitle: 'Encore des questions ?',
    contactText: 'Nous sommes là pour vous aider. Envoyez-nous un email et nous vous répondrons dans les 24 heures.',
    contactButton: 'Nous contacter',
    categories: [
      {
        id: 'getting-started',
        icon: BookOpen,
        color: 'text-indigo-600',
        bgColor: 'bg-indigo-50',
        label: 'Pour commencer',
        items: [
          {
            question: 'Comment ça marche ?',
            answer: 'Téléchargez une photo de votre enfant, choisissez un thème et nous créons une histoire personnalisée entièrement illustrée. Votre enfant apparaît comme un personnage illustré sur chaque page, gardant son apparence unique tout au long du livre.',
          },
          {
            question: 'Combien de temps faut-il ?',
            answer: 'Votre première histoire gratuite est prête en moins de 3 minutes. Les histoires complètes avec plus de pages et une meilleure qualité prennent environ 10-15 minutes. Vous recevrez un email quand votre histoire sera prête.',
          },
          {
            question: 'Pour quel âge ?',
            answer: 'Les histoires peuvent être créées pour les enfants de tous âges. Vous pouvez ajuster le niveau de lecture — des livres d\'images simples pour les tout-petits aux histoires plus longues pour les enfants d\'âge scolaire.',
          },
        ],
      },
      {
        id: 'your-story',
        icon: Palette,
        color: 'text-purple-600',
        bgColor: 'bg-purple-50',
        label: 'Votre histoire',
        items: [
          {
            question: 'Puis-je ajouter plusieurs personnages ?',
            answer: 'Oui ! Vous pouvez ajouter toute votre famille — enfants, parents, grands-parents, frères et sœurs ou amis. Chaque personnage obtient sa propre apparence illustrée basée sur sa photo.',
          },
          {
            question: 'Quels styles d\'illustration sont disponibles ?',
            answer: 'Nous proposons 8+ styles dont le 3D style Pixar, l\'aquarelle, la bande dessinée, l\'anime et plus. Chaque style est appliqué de manière cohérente sur toutes les pages de votre histoire.',
          },
          {
            question: 'Puis-je modifier l\'histoire après sa création ?',
            answer: 'Oui. Vous pouvez régénérer des pages individuelles, ajuster les illustrations et affiner l\'histoire selon vos souhaits avant de commander une version imprimée.',
          },
        ],
      },
      {
        id: 'printing',
        icon: Printer,
        color: 'text-emerald-600',
        bgColor: 'bg-emerald-50',
        label: 'Impression & Qualité',
        items: [
          {
            question: 'Comment le livre est-il imprimé ?',
            answer: 'Les livres sont imprimés professionnellement sur du papier de haute qualité au format 20x20cm. Vous pouvez choisir entre couverture rigide et brochée. La qualité d\'impression est comparable aux livres pour enfants publiés professionnellement.',
          },
          {
            question: 'Puis-je télécharger mon histoire en PDF ?',
            answer: 'Oui. Chaque histoire peut être téléchargée en PDF haute résolution — parfait pour la lecture sur tablette ou l\'impression à la maison.',
          },
        ],
      },
      {
        id: 'shipping',
        icon: Truck,
        color: 'text-blue-600',
        bgColor: 'bg-blue-50',
        label: 'Livraison',
        items: [
          {
            question: 'Où livrez-vous ?',
            answer: 'Nous livrons actuellement les livres imprimés en Suisse. La livraison internationale est disponible à un coût supplémentaire. Vous pouvez aussi télécharger votre histoire en PDF pour la lire sur n\'importe quel appareil.',
          },
        ],
      },
      {
        id: 'pricing',
        icon: CreditCard,
        color: 'text-amber-600',
        bgColor: 'bg-amber-50',
        label: 'Tarifs',
        items: [
          {
            question: 'Combien ça coûte ?',
            answer: 'Votre première histoire est entièrement gratuite — sans compte nécessaire. Ensuite, les histoires sont créées avec des crédits. Les livres imprimés commencent à CHF 38 en brochée et CHF 53 en couverture rigide (livraison en Suisse incluse). Consultez notre page de tarifs pour plus de détails.',
          },
        ],
      },
      {
        id: 'privacy',
        icon: Lock,
        color: 'text-rose-600',
        bgColor: 'bg-rose-50',
        label: 'Confidentialité',
        items: [
          {
            question: 'Mes données sont-elles en sécurité ?',
            answer: 'Oui. Vos photos sont utilisées uniquement pour créer vos illustrations et ne sont jamais partagées, vendues ou utilisées à d\'autres fins. Consultez notre Politique de confidentialité pour plus de détails.',
          },
        ],
      },
    ],
  },
};

function FAQAccordion({ item, defaultOpen = false }: { item: FAQItem; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="border-b border-gray-100 last:border-b-0">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between py-5 text-left group"
        aria-expanded={open}
      >
        <span className="text-base font-medium text-gray-800 pr-4 group-hover:text-indigo-600 transition-colors">{item.question}</span>
        <div className={`flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center transition-colors ${open ? 'bg-indigo-100' : 'bg-gray-100 group-hover:bg-indigo-50'}`}>
          <ChevronDown
            size={18}
            className={`transition-transform duration-300 ${open ? 'rotate-180 text-indigo-600' : 'text-gray-400'}`}
          />
        </div>
      </button>
      <div
        className={`grid transition-all duration-300 ease-in-out ${open ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'}`}
      >
        <div className="overflow-hidden">
          <div className="pb-5 text-gray-600 leading-relaxed text-[15px]">
            {item.answer}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function FAQ() {
  const { language } = useLanguage();
  const [search, setSearch] = useState('');
  const content = faqContent[language] || faqContent.en;

  const filteredCategories = useMemo(() => {
    if (!search.trim()) return content.categories;
    const term = search.toLowerCase();
    return content.categories
      .map(cat => ({
        ...cat,
        items: cat.items.filter(
          item => item.question.toLowerCase().includes(term) || item.answer.toLowerCase().includes(term)
        ),
      }))
      .filter(cat => cat.items.length > 0);
  }, [search, content.categories]);

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      <Navigation currentStep={0} />

      {/* Header */}
      <div className="bg-white border-b border-gray-100">
        <div className="max-w-3xl mx-auto px-4 pt-10 pb-8 text-center">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-indigo-50 mb-5">
            <HelpCircle className="w-8 h-8 text-indigo-600" />
          </div>
          <h1 className="text-3xl md:text-4xl font-bold text-gray-900 mb-3">{content.title}</h1>
          <p className="text-gray-500 text-lg max-w-xl mx-auto mb-8">{content.subtitle}</p>

          {/* Search */}
          <div className="relative max-w-md mx-auto">
            <Search size={20} className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={content.searchPlaceholder}
              className="w-full pl-12 pr-4 py-3 rounded-xl border border-gray-200 bg-gray-50 focus:bg-white focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100 outline-none transition-all text-gray-700 placeholder-gray-400"
            />
          </div>
        </div>
      </div>

      {/* Category quick links (only when not searching) */}
      {!search.trim() && (
        <div className="max-w-3xl mx-auto px-4 w-full -mt-1 pt-6 pb-2">
          <div className="flex flex-wrap gap-2 justify-center">
            {content.categories.map((cat) => {
              const Icon = cat.icon;
              return (
                <a
                  key={cat.id}
                  href={`#${cat.id}`}
                  className={`inline-flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium ${cat.bgColor} ${cat.color} hover:opacity-80 transition-opacity`}
                >
                  <Icon size={16} />
                  {cat.label}
                </a>
              );
            })}
          </div>
        </div>
      )}

      {/* FAQ Categories */}
      <div className="flex-1 max-w-3xl mx-auto px-4 py-8 w-full">
        {filteredCategories.length === 0 ? (
          <div className="text-center py-12">
            <Search size={40} className="mx-auto text-gray-300 mb-4" />
            <p className="text-gray-500">{content.noResults}</p>
          </div>
        ) : (
          <div className="space-y-6">
            {filteredCategories.map((category) => {
              const Icon = category.icon;
              return (
                <div key={category.id} id={category.id} className="scroll-mt-24">
                  <div className="flex items-center gap-3 mb-3">
                    <div className={`w-9 h-9 rounded-lg ${category.bgColor} flex items-center justify-center`}>
                      <Icon size={18} className={category.color} />
                    </div>
                    <h2 className="text-lg font-semibold text-gray-800">{category.label}</h2>
                  </div>
                  <div className="bg-white rounded-2xl shadow-sm border border-gray-100 px-6">
                    {category.items.map((item, index) => (
                      <FAQAccordion key={index} item={item} defaultOpen={!!search.trim()} />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Contact CTA */}
        <div className="mt-12 bg-gradient-to-br from-indigo-50 to-purple-50 rounded-2xl p-8 text-center border border-indigo-100">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-indigo-100 mb-4">
            <Mail className="w-6 h-6 text-indigo-600" />
          </div>
          <h3 className="text-xl font-semibold text-gray-800 mb-2">{content.contactTitle}</h3>
          <p className="text-gray-600 mb-5 max-w-md mx-auto">{content.contactText}</p>
          <Link
            to="/contact"
            className="inline-flex items-center gap-2 px-6 py-3 rounded-lg bg-indigo-600 text-white font-medium hover:bg-indigo-700 transition-colors"
          >
            {content.contactButton}
          </Link>
        </div>
      </div>

      <Footer />
    </div>
  );
}
