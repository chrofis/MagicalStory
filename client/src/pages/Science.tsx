import { useLanguage } from '@/context/LanguageContext';
import { Navigation, Footer } from '@/components/common';
import { Brain, BookOpen, Sparkles, Heart, Gift } from 'lucide-react';
import { Link } from 'react-router-dom';

const scienceContent: Record<string, {
  heroTitle: string;
  heroSubtitle: string;
  sections: { icon: string; title: string; text: string }[];
  giftTitle: string;
  giftText: string;
  ctaTitle: string;
  ctaText: string;
  ctaButton: string;
}> = {
  en: {
    heroTitle: 'Why Children Love Being the Hero',
    heroSubtitle: 'Every child loves a good story. But when they see themselves in that story — their name, their face, their world — something magical happens. They don\'t just listen. They live it.',
    sections: [
      {
        icon: 'bookopen',
        title: 'It\'s Their Story',
        text: 'Children are naturally drawn to stories about themselves. When they open a book and see their own face looking back at them, the story stops being something that happens to someone else — it becomes their adventure. They lean in closer, turn pages faster, and ask to read it again.',
      },
      {
        icon: 'brain',
        title: 'They Remember More',
        text: 'Studies show that children remember over 40% more from stories where they are the main character. It\'s called the self-reference effect — our brains simply pay more attention to information about ourselves. For children aged 2-10, this effect is especially strong.',
      },
      {
        icon: 'sparkles',
        title: 'They Feel Brave',
        text: 'When a child sees themselves conquering a dragon, starting school, or making a new friend, they start to believe they can do it too. Personalized stories quietly build confidence — not through lessons, but through adventure.',
      },
      {
        icon: 'heart',
        title: 'You Read Together',
        text: 'Parents and children who read personalized books together laugh more, talk more, and connect more deeply. It turns reading time into something both of you look forward to.',
      },
    ],
    giftTitle: 'The Perfect Gift',
    giftText: 'Looking for a truly unique gift? A personalized children\'s book is something no other child has. Perfect for birthdays, Christmas, the first day of school, or just because. A gift they\'ll treasure — and ask you to read every night.',
    ctaTitle: 'Create Their Story',
    ctaText: 'Your child as the hero of their own adventure. First story free.',
    ctaButton: 'Start Creating',
  },
  de: {
    heroTitle: 'Warum Kinder es lieben, der Held zu sein',
    heroSubtitle: 'Jedes Kind liebt eine gute Geschichte. Aber wenn es sich selbst in dieser Geschichte sieht — seinen Namen, sein Gesicht, seine Welt — passiert etwas Magisches. Es hört nicht nur zu. Es lebt die Geschichte.',
    sections: [
      {
        icon: 'bookopen',
        title: 'Es ist ihre Geschichte',
        text: 'Kinder fühlen sich von Natur aus zu Geschichten über sich selbst hingezogen. Wenn sie ein Buch öffnen und ihr eigenes Gesicht sehen, wird die Geschichte nicht mehr etwas, das jemand anderem passiert — es wird ihr Abenteuer. Sie rücken näher, blättern schneller und bitten darum, es nochmal vorzulesen.',
      },
      {
        icon: 'brain',
        title: 'Sie erinnern sich an mehr',
        text: 'Studien zeigen, dass Kinder sich an über 40% mehr erinnern, wenn sie selbst die Hauptfigur sind. Es heisst Selbstreferenz-Effekt — unser Gehirn schenkt Informationen über uns selbst einfach mehr Aufmerksamkeit. Bei Kindern zwischen 2 und 10 Jahren ist dieser Effekt besonders stark.',
      },
      {
        icon: 'sparkles',
        title: 'Sie fühlen sich mutig',
        text: 'Wenn ein Kind sich selbst dabei sieht, wie es einen Drachen besiegt, den ersten Schultag meistert oder einen neuen Freund findet, beginnt es zu glauben, dass es das auch kann. Personalisierte Geschichten bauen leise Selbstvertrauen auf — nicht durch Lektionen, sondern durch Abenteuer.',
      },
      {
        icon: 'heart',
        title: 'Ihr lest zusammen',
        text: 'Eltern und Kinder, die personalisierte Bücher zusammen lesen, lachen mehr, reden mehr und verbinden sich tiefer. Es verwandelt die Lesezeit in etwas, auf das ihr euch beide freut.',
      },
    ],
    giftTitle: 'Das perfekte Geschenk',
    giftText: 'Du suchst ein wirklich einzigartiges Geschenk? Ein personalisiertes Kinderbuch ist etwas, das kein anderes Kind hat. Perfekt zum Geburtstag, zu Weihnachten, zum Schulanfang oder einfach so. Ein Geschenk, das sie schätzen werden — und jeden Abend vorgelesen haben wollen.',
    ctaTitle: 'Erstelle ihre Geschichte',
    ctaText: 'Dein Kind als Held seines eigenen Abenteuers. Erste Geschichte gratis.',
    ctaButton: 'Jetzt starten',
  },
  fr: {
    heroTitle: 'Pourquoi les enfants adorent être le héros',
    heroSubtitle: 'Chaque enfant aime une bonne histoire. Mais quand il se voit dans cette histoire — son nom, son visage, son monde — quelque chose de magique se produit. Il ne fait pas qu\'écouter. Il la vit.',
    sections: [
      {
        icon: 'bookopen',
        title: 'C\'est leur histoire',
        text: 'Les enfants sont naturellement attirés par les histoires qui parlent d\'eux. Quand ils ouvrent un livre et voient leur propre visage, l\'histoire n\'arrive plus à quelqu\'un d\'autre — c\'est leur aventure. Ils se rapprochent, tournent les pages plus vite et demandent à la relire.',
      },
      {
        icon: 'brain',
        title: 'Ils retiennent plus',
        text: 'Les études montrent que les enfants retiennent plus de 40% d\'informations en plus quand ils sont le personnage principal. C\'est l\'effet d\'autoréférence — notre cerveau accorde simplement plus d\'attention aux informations qui nous concernent. Chez les enfants de 2 à 10 ans, cet effet est particulièrement fort.',
      },
      {
        icon: 'sparkles',
        title: 'Ils se sentent courageux',
        text: 'Quand un enfant se voit vaincre un dragon, commencer l\'école ou se faire un nouvel ami, il commence à croire qu\'il peut le faire aussi. Les histoires personnalisées construisent discrètement la confiance — pas par des leçons, mais par l\'aventure.',
      },
      {
        icon: 'heart',
        title: 'Vous lisez ensemble',
        text: 'Les parents et les enfants qui lisent des livres personnalisés ensemble rient plus, parlent plus et se connectent plus profondément. Cela transforme le moment de lecture en quelque chose que vous attendez tous les deux avec impatience.',
      },
    ],
    giftTitle: 'Le cadeau parfait',
    giftText: 'Vous cherchez un cadeau vraiment unique ? Un livre pour enfants personnalisé est quelque chose qu\'aucun autre enfant ne possède. Parfait pour les anniversaires, Noël, la rentrée scolaire, ou juste comme ça. Un cadeau qu\'ils chériront — et vous demanderont de lire chaque soir.',
    ctaTitle: 'Créez leur histoire',
    ctaText: 'Votre enfant comme héros de sa propre aventure. Première histoire gratuite.',
    ctaButton: 'Commencer',
  },
};

const iconMap = {
  bookopen: BookOpen,
  brain: Brain,
  sparkles: Sparkles,
  heart: Heart,
};

export default function Science() {
  const { language } = useLanguage();
  const content = scienceContent[language] || scienceContent.en;

  return (
    <div className="min-h-screen bg-stone-50 flex flex-col">
      <Navigation currentStep={0} />

      {/* Hero header */}
      <div className="bg-white border-b border-stone-100">
        <div className="max-w-3xl mx-auto px-4 pt-10 pb-10 text-center">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-indigo-50 mb-5">
            <Brain className="w-8 h-8 text-indigo-600" />
          </div>
          <h1 className="text-3xl md:text-4xl font-bold text-stone-900 mb-3">{content.heroTitle}</h1>
          <p className="text-stone-500 text-lg max-w-xl mx-auto">{content.heroSubtitle}</p>
        </div>
      </div>

      <div className="flex-1 max-w-3xl mx-auto px-4 py-10 w-full">
        {/* Content sections */}
        <div className="space-y-6 mb-10">
          {content.sections.map((section, index) => {
            const Icon = iconMap[section.icon as keyof typeof iconMap];
            return (
              <div key={index} className="bg-white rounded-2xl border border-stone-100 p-6 md:p-8">
                <div className="flex items-start gap-5">
                  <div className="bg-indigo-50 w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0">
                    <Icon className="w-5 h-5 text-indigo-500" />
                  </div>
                  <div>
                    <h2 className="text-lg font-semibold text-stone-800 mb-2">{section.title}</h2>
                    <p className="text-stone-600 text-[15px] leading-relaxed">{section.text}</p>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Gift section */}
        <div className="bg-amber-50 rounded-2xl border border-amber-200 p-6 md:p-8 mb-10">
          <div className="flex items-start gap-5">
            <div className="bg-amber-100 w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0">
              <Gift className="w-5 h-5 text-amber-600" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-stone-800 mb-2">{content.giftTitle}</h2>
              <p className="text-stone-600 text-[15px] leading-relaxed">{content.giftText}</p>
            </div>
          </div>
        </div>

        {/* CTA */}
        <div className="bg-indigo-600 rounded-2xl p-8 text-center">
          <h3 className="text-xl font-semibold text-white mb-2">{content.ctaTitle}</h3>
          <p className="text-indigo-100 mb-5 max-w-md mx-auto">{content.ctaText}</p>
          <Link
            to="/try"
            className="inline-flex items-center gap-2 px-6 py-3 rounded-lg bg-white text-indigo-600 font-medium hover:bg-indigo-50 transition-colors"
          >
            <Sparkles size={18} />
            {content.ctaButton}
          </Link>
        </div>
      </div>

      <Footer />
    </div>
  );
}
