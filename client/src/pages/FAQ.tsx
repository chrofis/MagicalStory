import { useState } from 'react';
import { useLanguage } from '@/context/LanguageContext';
import { Navigation, Footer } from '@/components/common';
import { ArrowLeft, ChevronDown } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

interface FAQItem {
  question: string;
  answer: string;
}

const faqContent: Record<string, { title: string; items: FAQItem[] }> = {
  en: {
    title: 'Frequently Asked Questions',
    items: [
      {
        question: 'How does it work?',
        answer: 'Upload a photo of your child, choose a story theme, and we generate a fully illustrated personalized story. Your child appears as an illustrated character on every page, keeping their unique appearance throughout the whole book.',
      },
      {
        question: 'How long does it take?',
        answer: 'A trial story is ready in under 3 minutes. A full story with more pages and higher quality takes about 10-15 minutes. You will receive an email when your story is ready.',
      },
      {
        question: 'What ages is this for?',
        answer: 'Stories can be created for children of all ages. You can adjust the reading level to match your child — from simple picture books for toddlers to longer stories for school-age children.',
      },
      {
        question: 'Can I add multiple characters?',
        answer: 'Yes! With a full account you can add your whole family — children, parents, grandparents, siblings, or friends. Each character gets their own illustrated appearance based on their photo.',
      },
      {
        question: 'What illustration styles are available?',
        answer: 'We offer 8+ styles including Pixar-style 3D, watercolor, comic, anime, and more. Each style is applied consistently across all pages of your story.',
      },
      {
        question: 'How is the book printed?',
        answer: 'Books are professionally printed on high-quality paper in 20x20cm format. You can choose between hardcover and softcover binding. Print quality is comparable to professionally published children\'s books.',
      },
      {
        question: 'Where do you ship?',
        answer: 'We currently ship printed books within Switzerland. International shipping is available at additional cost. You can also download your story as a PDF to read on any device.',
      },
      {
        question: 'Is my data safe?',
        answer: 'Yes. Your photos are used only to create your story illustrations and are never shared, sold, or used for any other purpose. We take privacy seriously — see our Privacy Policy for details.',
      },
      {
        question: 'How much does it cost?',
        answer: 'Creating and reading your story online is free. Printed books start at CHF 38 for softcover and CHF 53 for hardcover (including shipping within Switzerland). See our pricing page for details.',
      },
      {
        question: 'Can I edit the story after it is generated?',
        answer: 'Yes. You can regenerate individual pages, adjust illustrations, and fine-tune the story to your liking before ordering a printed version.',
      },
    ],
  },
  de: {
    title: 'Häufig gestellte Fragen',
    items: [
      {
        question: 'Wie funktioniert es?',
        answer: 'Lade ein Foto deines Kindes hoch, wähle ein Story-Thema und wir erstellen eine vollständig illustrierte, personalisierte Geschichte. Dein Kind erscheint als illustrierte Figur auf jeder Seite und behält sein einzigartiges Aussehen im ganzen Buch.',
      },
      {
        question: 'Wie lange dauert es?',
        answer: 'Eine Probegeschichte ist in unter 3 Minuten fertig. Eine vollständige Geschichte mit mehr Seiten und höherer Qualität dauert etwa 10-15 Minuten. Du erhältst eine E-Mail, wenn deine Geschichte fertig ist.',
      },
      {
        question: 'Für welches Alter ist das geeignet?',
        answer: 'Geschichten können für Kinder jeden Alters erstellt werden. Du kannst das Leseniveau anpassen — von einfachen Bilderbüchern für Kleinkinder bis zu längeren Geschichten für Schulkinder.',
      },
      {
        question: 'Kann ich mehrere Charaktere hinzufügen?',
        answer: 'Ja! Mit einem vollständigen Konto kannst du deine ganze Familie hinzufügen — Kinder, Eltern, Grosseltern, Geschwister oder Freunde. Jede Figur erhält ihr eigenes illustriertes Aussehen basierend auf ihrem Foto.',
      },
      {
        question: 'Welche Illustrationsstile gibt es?',
        answer: 'Wir bieten 8+ Stile an, darunter Pixar-ähnliches 3D, Aquarell, Comic, Anime und mehr. Jeder Stil wird einheitlich auf allen Seiten deiner Geschichte angewendet.',
      },
      {
        question: 'Wie wird das Buch gedruckt?',
        answer: 'Bücher werden professionell auf hochwertigem Papier im Format 20x20cm gedruckt. Du kannst zwischen Hardcover und Softcover wählen. Die Druckqualität ist vergleichbar mit professionell veröffentlichten Kinderbüchern.',
      },
      {
        question: 'Wohin wird geliefert?',
        answer: 'Wir liefern gedruckte Bücher derzeit innerhalb der Schweiz. Internationaler Versand ist gegen Aufpreis möglich. Du kannst deine Geschichte auch als PDF herunterladen und auf jedem Gerät lesen.',
      },
      {
        question: 'Sind meine Daten sicher?',
        answer: 'Ja. Deine Fotos werden ausschliesslich zur Erstellung deiner Geschichte verwendet und niemals geteilt, verkauft oder für andere Zwecke genutzt. Datenschutz ist uns wichtig — Details findest du in unserer Datenschutzerklärung.',
      },
      {
        question: 'Was kostet es?',
        answer: 'Das Erstellen und Lesen deiner Geschichte online ist kostenlos. Gedruckte Bücher beginnen ab CHF 38 für Softcover und CHF 53 für Hardcover (inkl. Versand innerhalb der Schweiz). Details findest du auf unserer Preisseite.',
      },
      {
        question: 'Kann ich die Geschichte nach der Erstellung bearbeiten?',
        answer: 'Ja. Du kannst einzelne Seiten neu generieren, Illustrationen anpassen und die Geschichte nach deinen Wünschen verfeinern, bevor du eine gedruckte Version bestellst.',
      },
    ],
  },
  fr: {
    title: 'Questions fréquentes',
    items: [
      {
        question: 'Comment ça marche ?',
        answer: 'Téléchargez une photo de votre enfant, choisissez un thème et nous créons une histoire personnalisée entièrement illustrée. Votre enfant apparaît comme un personnage illustré sur chaque page, gardant son apparence unique tout au long du livre.',
      },
      {
        question: 'Combien de temps faut-il ?',
        answer: 'Une histoire d\'essai est prête en moins de 3 minutes. Une histoire complète avec plus de pages et une meilleure qualité prend environ 10-15 minutes. Vous recevrez un email quand votre histoire sera prête.',
      },
      {
        question: 'Pour quel âge ?',
        answer: 'Les histoires peuvent être créées pour les enfants de tous âges. Vous pouvez ajuster le niveau de lecture — des livres d\'images simples pour les tout-petits aux histoires plus longues pour les enfants d\'âge scolaire.',
      },
      {
        question: 'Puis-je ajouter plusieurs personnages ?',
        answer: 'Oui ! Avec un compte complet, vous pouvez ajouter toute votre famille — enfants, parents, grands-parents, frères et sœurs ou amis. Chaque personnage obtient sa propre apparence illustrée basée sur sa photo.',
      },
      {
        question: 'Quels styles d\'illustration sont disponibles ?',
        answer: 'Nous proposons 8+ styles dont le 3D style Pixar, l\'aquarelle, la bande dessinée, l\'anime et plus. Chaque style est appliqué de manière cohérente sur toutes les pages de votre histoire.',
      },
      {
        question: 'Comment le livre est-il imprimé ?',
        answer: 'Les livres sont imprimés professionnellement sur du papier de haute qualité au format 20x20cm. Vous pouvez choisir entre couverture rigide et brochée. La qualité d\'impression est comparable aux livres pour enfants publiés professionnellement.',
      },
      {
        question: 'Où livrez-vous ?',
        answer: 'Nous livrons actuellement les livres imprimés en Suisse. La livraison internationale est disponible à un coût supplémentaire. Vous pouvez aussi télécharger votre histoire en PDF pour la lire sur n\'importe quel appareil.',
      },
      {
        question: 'Mes données sont-elles en sécurité ?',
        answer: 'Oui. Vos photos sont utilisées uniquement pour créer vos illustrations et ne sont jamais partagées, vendues ou utilisées à d\'autres fins. Consultez notre Politique de confidentialité pour plus de détails.',
      },
      {
        question: 'Combien ça coûte ?',
        answer: 'La création et la lecture de votre histoire en ligne sont gratuites. Les livres imprimés commencent à CHF 38 en brochée et CHF 53 en couverture rigide (livraison en Suisse incluse). Consultez notre page de tarifs pour plus de détails.',
      },
      {
        question: 'Puis-je modifier l\'histoire après sa création ?',
        answer: 'Oui. Vous pouvez régénérer des pages individuelles, ajuster les illustrations et affiner l\'histoire selon vos souhaits avant de commander une version imprimée.',
      },
    ],
  },
};

function FAQAccordion({ item }: { item: FAQItem }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="border-b border-gray-200 last:border-b-0">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between py-4 text-left"
      >
        <span className="text-lg font-medium text-gray-800 pr-4">{item.question}</span>
        <ChevronDown
          size={20}
          className={`text-gray-400 flex-shrink-0 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {open && (
        <div className="pb-4 text-gray-600 leading-relaxed">
          {item.answer}
        </div>
      )}
    </div>
  );
}

export default function FAQ() {
  const { language } = useLanguage();
  const navigate = useNavigate();
  const content = faqContent[language] || faqContent.en;

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      <Navigation currentStep={0} />

      <div className="flex-1 max-w-3xl mx-auto px-4 py-8 w-full">
        <button
          onClick={() => window.history.length > 1 ? navigate(-1) : navigate('/')}
          className="flex items-center gap-2 text-indigo-600 hover:text-indigo-800 mb-6"
        >
          <ArrowLeft size={20} />
          {language === 'de' ? 'Zurück' : language === 'fr' ? 'Retour' : 'Back'}
        </button>

        <h1 className="text-3xl font-bold text-gray-900 mb-8">{content.title}</h1>

        <div className="bg-white rounded-2xl shadow-sm p-6 md:p-8">
          {content.items.map((item, index) => (
            <FAQAccordion key={index} item={item} />
          ))}
        </div>
      </div>

      <Footer />
    </div>
  );
}
