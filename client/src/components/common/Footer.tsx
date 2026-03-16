import { Link } from 'react-router-dom';
import { useLanguage } from '@/context/LanguageContext';

const footerTexts = {
  en: {
    themes: 'Themes',
    occasions: 'Gift Ideas',
    compare: 'Compare',
    science: 'Science',
    terms: 'Terms of Service',
    privacy: 'Privacy Policy',
    faq: 'FAQ',
    about: 'About',
    contact: 'Contact',
    copyright: 'Magical Story. All rights reserved.',
  },
  de: {
    themes: 'Themen',
    occasions: 'Geschenkideen',
    compare: 'Vergleich',
    science: 'Forschung',
    terms: 'Nutzungsbedingungen',
    privacy: 'Datenschutz',
    faq: 'FAQ',
    about: 'Über uns',
    contact: 'Kontakt',
    copyright: 'Magical Story. Alle Rechte vorbehalten.',
  },
  fr: {
    themes: 'Thèmes',
    occasions: 'Idées cadeaux',
    compare: 'Comparaison',
    science: 'Science',
    terms: 'Conditions d\'Utilisation',
    privacy: 'Confidentialité',
    faq: 'FAQ',
    about: 'À propos',
    contact: 'Contact',
    copyright: 'Magical Story. Tous droits réservés.',
  },
};

export function Footer() {
  const { language } = useLanguage();
  const texts = footerTexts[language] || footerTexts.en;
  const currentYear = new Date().getFullYear();

  return (
    <footer className="bg-stone-100 border-t border-stone-200 py-4 px-4">
      <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-2 text-sm text-stone-600">
        <div className="flex items-center gap-4 flex-wrap">
          <Link to="/themes" className="hover:text-indigo-600 hover:underline">
            {texts.themes}
          </Link>
          <span className="text-stone-300">|</span>
          <Link to="/anlass" className="hover:text-indigo-600 hover:underline">
            {texts.occasions}
          </Link>
          <span className="text-stone-300">|</span>
          <Link to="/vergleich" className="hover:text-indigo-600 hover:underline">
            {texts.compare}
          </Link>
          <span className="text-stone-300">|</span>
          <Link to="/science" className="hover:text-indigo-600 hover:underline">
            {texts.science}
          </Link>
          <span className="text-stone-300">|</span>
          <Link to="/faq" className="hover:text-indigo-600 hover:underline">
            {texts.faq}
          </Link>
          <span className="text-stone-300">|</span>
          <Link to="/about" className="hover:text-indigo-600 hover:underline">
            {texts.about}
          </Link>
          <span className="text-stone-300">|</span>
          <Link to="/contact" className="hover:text-indigo-600 hover:underline">
            {texts.contact}
          </Link>
          <span className="text-stone-300">|</span>
          <Link to="/terms" className="hover:text-indigo-600 hover:underline">
            {texts.terms}
          </Link>
          <span className="text-stone-300">|</span>
          <Link to="/privacy" className="hover:text-indigo-600 hover:underline">
            {texts.privacy}
          </Link>
        </div>
        <div>
          © {currentYear} {texts.copyright}
        </div>
      </div>
    </footer>
  );
}

export default Footer;
