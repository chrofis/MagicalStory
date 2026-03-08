import { useNavigate } from 'react-router-dom';
import { useLanguage } from '@/context/LanguageContext';
import { Sparkles, ArrowLeft } from 'lucide-react';

const translations = {
  en: {
    title: 'Your story is being created!',
    description: 'We\'ll email you the finished story as PDF in about 5-10 minutes.',
    tip: 'Keep an eye on your inbox\n(and spam folder, just in case).',
    backHome: 'Back to home',
    brand: 'Magical Story',
  },
  de: {
    title: 'Deine Geschichte wird erstellt!',
    description: 'Du erhältst die fertige Geschichte als PDF in etwa 5-10 Minuten.',
    tip: 'Behalte deinen Posteingang im Auge\n(und den Spam-Ordner, nur für den Fall).',
    backHome: 'Zurück zur Startseite',
    brand: 'Magical Story',
  },
  fr: {
    title: 'Votre histoire est en cours de création !',
    description: 'Vous recevrez l\'histoire terminée en PDF dans environ 5 à 10 minutes.',
    tip: 'Gardez un œil sur votre boîte de réception\n(et le dossier spam, au cas où).',
    backHome: 'Retour à l\'accueil',
    brand: 'Magical Story',
  },
};

export default function TrialStarted() {
  const navigate = useNavigate();
  const { language } = useLanguage();
  const t = translations[language as keyof typeof translations] || translations.en;

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Navigation bar matching the trial wizard */}
      <nav className="bg-black text-white px-3 py-3">
        <div className="flex justify-between items-center">
          <button onClick={() => navigate('/')} className="text-sm md:text-base font-bold whitespace-nowrap hover:opacity-80">
            ✨ {t.brand}
          </button>
        </div>
      </nav>

      {/* Content */}
      <div className="px-3 md:px-8 py-4 md:py-8">
        <div className="bg-white rounded-2xl shadow-xl max-w-md mx-auto p-10 text-center">
          <div className="w-20 h-20 bg-indigo-100 rounded-full flex items-center justify-center mx-auto mb-6">
            <Sparkles className="w-10 h-10 text-indigo-600" />
          </div>

          <h1 className="text-3xl font-bold text-gray-800 mb-3">{t.title}</h1>
          <p className="text-gray-600 mb-4 text-lg">{t.description}</p>
          <p className="text-sm text-gray-400 mb-8 whitespace-pre-line">{t.tip}</p>

          <button
            onClick={() => navigate('/')}
            className="inline-flex items-center gap-2 text-indigo-600 hover:text-indigo-800 font-medium transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            {t.backHome}
          </button>
        </div>
      </div>
    </div>
  );
}
