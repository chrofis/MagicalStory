import { Link } from 'react-router-dom';
import { ArrowRight, BookOpen } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';

/**
 * Compact product-explainer strip for SEO landing pages (themes, occasions,
 * city pages, …). Cold visitors arriving from ads or search often land on a
 * theme page that describes the THEME but never says what the product is —
 * a personalized, illustrated book starring their own child. This strip
 * states it in one line, right under the page hero.
 */
const texts: Record<string, { line: string; free: string; cta: string }> = {
  en: {
    line: 'Your child becomes the hero of a personalized, illustrated book — upload a photo, pick a theme, and the story is ready in minutes.',
    free: 'First story free',
    cta: 'Try it free',
  },
  de: {
    line: 'Dein Kind wird zur Hauptfigur eines personalisierten, illustrierten Buchs — Foto hochladen, Thema wählen, in Minuten ist die Geschichte fertig.',
    free: 'Erste Geschichte gratis',
    cta: 'Gratis testen',
  },
  fr: {
    line: 'Votre enfant devient le héros d\'un livre illustré personnalisé — téléchargez une photo, choisissez un thème, l\'histoire est prête en quelques minutes.',
    free: 'Première histoire gratuite',
    cta: 'Essayer gratuitement',
  },
};

export function ProductPitch() {
  const { language } = useLanguage();
  const t = texts[language] || texts.en;

  return (
    <div className="bg-indigo-50 border-b border-indigo-100">
      <div className="max-w-4xl mx-auto px-4 py-3.5 flex flex-col sm:flex-row items-center gap-2 sm:gap-4 text-center sm:text-left">
        <BookOpen size={20} className="text-indigo-500 flex-shrink-0 hidden sm:block" />
        <p className="text-sm text-indigo-900 flex-1">
          {t.line}{' '}
          <span className="font-semibold whitespace-nowrap">{t.free}.</span>
        </p>
        <Link
          to="/try"
          className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-indigo-500 text-white text-sm font-semibold hover:bg-indigo-600 transition-colors flex-shrink-0"
        >
          {t.cta} <ArrowRight size={14} />
        </Link>
      </div>
    </div>
  );
}

export default ProductPitch;
