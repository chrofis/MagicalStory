import { Link } from 'react-router-dom';
import { useLanguage } from '@/context/LanguageContext';

const footerTexts = {
  en: {
    faq: 'FAQ',
    cities: 'Swiss cities',
    about: 'About',
    contact: 'Contact',
    terms: 'Terms of Service',
    privacy: 'Privacy Policy',
    copyright: 'Magical Story. All rights reserved.',
  },
  de: {
    faq: 'FAQ',
    cities: 'Schweizer Städte',
    about: 'Über uns',
    contact: 'Kontakt',
    terms: 'Nutzungsbedingungen',
    privacy: 'Datenschutz',
    copyright: 'Magical Story. Alle Rechte vorbehalten.',
  },
  fr: {
    faq: 'FAQ',
    cities: 'Villes suisses',
    about: 'À propos',
    contact: 'Contact',
    terms: 'Conditions d\'Utilisation',
    privacy: 'Confidentialité',
    copyright: 'Magical Story. Tous droits réservés.',
  },
};

export function Footer() {
  const { language } = useLanguage();
  const texts = footerTexts[language as keyof typeof footerTexts] || footerTexts.en;
  const currentYear = new Date().getFullYear();

  return (
    <footer className="bg-stone-100 border-t border-stone-200 py-4 px-4">
      <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-2 text-sm text-stone-600">
        <div className="flex items-center gap-4 flex-wrap">
          <Link to="/stadt" className="hover:text-indigo-500 hover:underline">
            {texts.cities}
          </Link>
          <span className="text-stone-300">|</span>
          <Link to="/faq" className="hover:text-indigo-500 hover:underline">
            {texts.faq}
          </Link>
          <span className="text-stone-300">|</span>
          <Link to="/about" className="hover:text-indigo-500 hover:underline">
            {texts.about}
          </Link>
          <span className="text-stone-300">|</span>
          <Link to="/contact" className="hover:text-indigo-500 hover:underline">
            {texts.contact}
          </Link>
          <span className="text-stone-300">|</span>
          <Link to="/terms" className="hover:text-indigo-500 hover:underline">
            {texts.terms}
          </Link>
          <span className="text-stone-300">|</span>
          <Link to="/privacy" className="hover:text-indigo-500 hover:underline">
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
