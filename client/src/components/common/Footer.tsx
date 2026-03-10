import { Link } from 'react-router-dom';
import { useLanguage } from '@/context/LanguageContext';

const footerTexts = {
  en: {
    terms: 'Terms of Service',
    privacy: 'Privacy Policy',
    faq: 'FAQ',
    about: 'About',
    contact: 'Contact',
    copyright: 'Magical Story. All rights reserved.',
  },
  de: {
    terms: 'Nutzungsbedingungen',
    privacy: 'Datenschutz',
    faq: 'FAQ',
    about: 'Über uns',
    contact: 'Kontakt',
    copyright: 'Magical Story. Alle Rechte vorbehalten.',
  },
  fr: {
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
    <footer className="bg-gray-100 border-t border-gray-200 py-4 px-4">
      <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-2 text-sm text-gray-600">
        <div className="flex items-center gap-4 flex-wrap">
          <Link to="/faq" className="hover:text-indigo-600 hover:underline">
            {texts.faq}
          </Link>
          <span className="text-gray-300">|</span>
          <Link to="/about" className="hover:text-indigo-600 hover:underline">
            {texts.about}
          </Link>
          <span className="text-gray-300">|</span>
          <Link to="/contact" className="hover:text-indigo-600 hover:underline">
            {texts.contact}
          </Link>
          <span className="text-gray-300">|</span>
          <Link to="/terms" className="hover:text-indigo-600 hover:underline">
            {texts.terms}
          </Link>
          <span className="text-gray-300">|</span>
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
