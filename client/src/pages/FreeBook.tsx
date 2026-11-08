import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Gift, ArrowRight } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import { useAuth } from '@/context/AuthContext';
import { INITIAL_USER_CREDITS, CREDITS_PER_PAGE } from '@/constants/credits';

/** Pages the initial grant buys. Computed from the credit constants, never typed into copy. */
export const FREE_BOOK_PAGES = Math.floor(INITIAL_USER_CREDITS / CREDITS_PER_PAGE);

// DRAFT copy, owner review pending (docs/decisions.md 2026-11-08). A trial has exactly one
// character, so every line speaks of one: "your character", never a plural.
const translations = {
  en: {
    title: 'Your first real book is free',
    body: `Your account includes a free book of up to ${FREE_BOOK_PAGES} pages. Your character is already here, so you can start right away.`,
    cta: 'Create my free book',
    later: 'Later',
  },
  de: {
    title: 'Dein erstes richtiges Buch ist gratis',
    body: `In deinem Konto wartet ein Gratis-Buch mit bis zu ${FREE_BOOK_PAGES} Seiten. Deine Figur ist schon da, du kannst sofort loslegen.`,
    cta: 'Gratis-Buch erstellen',
    later: 'Später',
  },
  fr: {
    title: 'Votre premier vrai livre est offert',
    body: `Votre compte inclut un livre gratuit de ${FREE_BOOK_PAGES} pages au maximum. Votre personnage est déjà là, vous pouvez commencer tout de suite.`,
    cta: 'Créer mon livre gratuit',
    later: 'Plus tard',
  },
  it: {
    title: 'Il tuo primo vero libro è gratis',
    body: `Nel tuo account c'è un libro gratuito di al massimo ${FREE_BOOK_PAGES} pagine. Il tuo personaggio è già qui, puoi iniziare subito.`,
    cta: 'Crea il mio libro gratuito',
    later: 'Più tardi',
  },
};

/**
 * The one screen every trial sign-up path ends on (Google at the gate, email verify + password,
 * claim page). Replaces the old silent redirect to /stories, which sent 18 of 25 sign-ups away
 * with their free credits unused (docs/decisions.md 2026-11-08).
 */
export default function FreeBook() {
  const navigate = useNavigate();
  const { language } = useLanguage();
  const { isAuthenticated, isLoading } = useAuth();
  const t = translations[language as keyof typeof translations] || translations.en;

  useEffect(() => {
    if (!isLoading && !isAuthenticated) navigate('/');
  }, [isLoading, isAuthenticated, navigate]);

  if (isLoading || !isAuthenticated) return null;

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 via-white to-indigo-50 px-4 py-16">
      <div className="max-w-md mx-auto text-center">
        <div className="w-16 h-16 bg-amber-100 rounded-full flex items-center justify-center mx-auto mb-5">
          <Gift className="w-8 h-8 text-amber-600" />
        </div>
        <h1 className="text-2xl md:text-3xl font-bold text-gray-900 mb-3">{t.title}</h1>
        <p className="text-gray-600 mb-8">{t.body}</p>
        <button
          onClick={() => navigate('/create?new=true')}
          className="w-full bg-indigo-500 text-white px-3 py-2 rounded-lg text-sm font-semibold flex items-center justify-center gap-1.5 hover:bg-indigo-600"
        >
          {t.cta}
          <ArrowRight size={16} />
        </button>
        <button
          onClick={() => navigate('/stories')}
          className="mt-4 text-sm text-gray-500 underline hover:text-gray-700"
        >
          {t.later}
        </button>
      </div>
    </div>
  );
}
