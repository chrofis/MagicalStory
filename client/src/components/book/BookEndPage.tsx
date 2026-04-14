import React from 'react';
import { BookOpen, BookOpenCheck, Lock, Plus } from 'lucide-react';

interface BookEndPageProps {
  storyTitle: string;
  language: string;
  needsPassword?: boolean;
  onNavigate: (path: string) => void;
  onSetPassword: () => void;
}

const endPageText: Record<string, Record<string, string>> = {
  de: {
    secureTitle: 'Sichere deine Geschichte!',
    secureDesc: 'Setze ein Passwort, damit du jederzeit auf deine Geschichte zugreifen kannst.',
    setPassword: 'Passwort setzen',
    benefits: 'Mit deinem kostenlosen Konto kannst du:',
    endTitle: 'Ende der Geschichte',
    printBook: 'Als Buch drucken',
    newStory: 'Neue Geschichte',
    f1: 'Mehrere Figuren in einer Geschichte',
    f2: 'Längere Geschichten mit mehr Seiten',
    f3: 'Verschiedene Zeichenstile',
    f4: 'Höhere Bildqualität und Titelseite',
    f5: 'Als gedrucktes Buch bestellen',
  },
  en: {
    secureTitle: 'Secure your story!',
    secureDesc: 'Set a password so you can access your story anytime.',
    setPassword: 'Set password',
    benefits: 'With your free account you can:',
    endTitle: 'The End',
    printBook: 'Print as a book',
    newStory: 'New story',
    f1: 'Multiple characters in one story',
    f2: 'Longer stories with more pages',
    f3: 'Different drawing styles',
    f4: 'Higher image quality and title page',
    f5: 'Order as a printed book',
  },
  fr: {
    secureTitle: 'Sécurisez votre histoire !',
    secureDesc: 'Définissez un mot de passe pour accéder à votre histoire.',
    setPassword: 'Définir un mot de passe',
    benefits: 'Avec votre compte gratuit :',
    endTitle: 'Fin de l\'histoire',
    printBook: 'Imprimer en livre',
    newStory: 'Nouvelle histoire',
    f1: 'Plusieurs personnages',
    f2: 'Des histoires plus longues',
    f3: 'Différents styles de dessin',
    f4: 'Meilleure qualité d\'image',
    f5: 'Commander en livre imprimé',
  },
};

/**
 * Hard end page with CTA — "The End" or password setup prompt.
 * react-pageflip requires forwardRef.
 */
const BookEndPage = React.forwardRef<HTMLDivElement, BookEndPageProps>(
  ({ storyTitle, language, needsPassword, onNavigate, onSetPassword }, ref) => {
    const lang = (language || 'en').split('-')[0].toLowerCase();
    const et = endPageText[lang] || endPageText.en;

    return (
      <div ref={ref} className="w-full h-full bg-gradient-to-br from-indigo-100 to-blue-100 flex items-center justify-center p-4">
        <div className="text-center max-w-[85%]">
          {needsPassword ? (
            <>
              <div className="w-12 h-12 bg-amber-100 rounded-full flex items-center justify-center mx-auto mb-3">
                <Lock className="w-6 h-6 text-amber-600" />
              </div>
              <h2 className="text-lg font-bold text-gray-800 mb-1">{et.secureTitle}</h2>
              <p className="text-gray-600 text-xs mb-3">{et.secureDesc}</p>
              <button
                onClick={(e) => { e.stopPropagation(); onSetPassword(); }}
                className="w-full bg-indigo-500 text-white py-2 rounded-lg text-sm font-semibold hover:bg-indigo-600 transition-colors mb-3"
              >
                {et.setPassword}
              </button>
              <div className="bg-indigo-50 rounded-lg p-3 border border-indigo-100 text-left">
                <p className="text-[10px] font-semibold text-indigo-700 mb-1">{et.benefits}</p>
                <ul className="text-[10px] text-gray-600 space-y-0.5">
                  {[et.f1, et.f2, et.f3, et.f4, et.f5].map((f, i) => (
                    <li key={i} className="flex items-center gap-1"><span className="text-indigo-500 font-bold">+</span> {f}</li>
                  ))}
                </ul>
              </div>
            </>
          ) : (
            <>
              <div className="w-12 h-12 bg-indigo-100 rounded-full flex items-center justify-center mx-auto mb-3">
                <BookOpenCheck className="w-6 h-6 text-indigo-500" />
              </div>
              <h2 className="text-lg font-bold text-gray-800 mb-1">{et.endTitle}</h2>
              <p className="text-gray-500 text-xs mb-4">{storyTitle}</p>
              <div className="flex flex-col gap-2">
                <button
                  onClick={(e) => { e.stopPropagation(); onNavigate('/stories'); }}
                  className="w-full bg-indigo-500 text-white py-2 rounded-lg text-sm font-semibold hover:bg-indigo-600 transition-colors flex items-center justify-center gap-1.5"
                >
                  <BookOpen className="w-4 h-4" />
                  {et.printBook}
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); onNavigate('/create?new=true'); }}
                  className="w-full bg-white text-indigo-500 py-2 rounded-lg text-sm font-semibold border-2 border-indigo-200 hover:bg-indigo-50 transition-colors flex items-center justify-center gap-1.5"
                >
                  <Plus className="w-4 h-4" />
                  {et.newStory}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    );
  }
);

BookEndPage.displayName = 'BookEndPage';
export default BookEndPage;
