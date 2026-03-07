import { useNavigate } from 'react-router-dom';
import { useLanguage } from '@/context/LanguageContext';
import { Sparkles, BookOpen, ArrowLeft } from 'lucide-react';

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
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 via-white to-purple-50">
      {/* Header */}
      <header className="bg-white/80 backdrop-blur-sm border-b border-gray-100">
        <div className="max-w-4xl mx-auto px-4 py-3 flex items-center">
          <button
            onClick={() => navigate('/')}
            className="flex items-center gap-2 text-indigo-700 font-bold text-lg hover:opacity-80 transition-opacity"
          >
            <BookOpen className="w-5 h-5" />
            {t.brand}
          </button>
        </div>
      </header>

      {/* Content */}
      <div className="flex-1 flex items-center justify-center p-4 mt-20">
        <div className="bg-white rounded-2xl shadow-lg max-w-md w-full p-10 text-center">
          <div className="w-20 h-20 bg-purple-100 rounded-full flex items-center justify-center mx-auto mb-6">
            <Sparkles className="w-10 h-10 text-purple-600" />
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
