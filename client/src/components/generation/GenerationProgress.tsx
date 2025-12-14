import { Loader2, Mail, Clock, ArrowLeft } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import { useAuth } from '@/context/AuthContext';
import { ProgressBar } from '@/components/common/ProgressBar';

interface GenerationProgressProps {
  current: number;
  total: number;
  message?: string;
  isGenerating?: boolean;
}

export function GenerationProgress({
  current,
  total,
  message,
  isGenerating = true,
}: GenerationProgressProps) {
  const { language } = useLanguage();
  const { user } = useAuth();
  const hasEmail = !!user?.email;

  if (!isGenerating || total === 0) {
    return null;
  }

  const translations = {
    en: {
      title: 'Creating Your Story!',
      subtitle: 'Your magical adventure is being crafted...',
      timeInfo: 'This typically takes about 10 minutes',
      emailInfo: 'You will receive an email when your story is ready',
      noEmailInfo: 'You can close this page and come back later',
      backgroundInfo: 'Generation continues in the background on our servers',
      stayOrGo: 'Feel free to wait here or come back later',
    },
    de: {
      title: 'Geschichte wird erstellt!',
      subtitle: 'Dein magisches Abenteuer wird gerade geschrieben...',
      timeInfo: 'Dies dauert normalerweise etwa 10 Minuten',
      emailInfo: 'Du erhältst eine E-Mail, wenn deine Geschichte fertig ist',
      noEmailInfo: 'Du kannst diese Seite schließen und später zurückkommen',
      backgroundInfo: 'Die Generierung läuft im Hintergrund auf unseren Servern',
      stayOrGo: 'Du kannst hier warten oder später wiederkommen',
    },
    fr: {
      title: 'Création de votre histoire!',
      subtitle: 'Votre aventure magique est en cours de création...',
      timeInfo: 'Cela prend généralement environ 10 minutes',
      emailInfo: 'Vous recevrez un email quand votre histoire sera prête',
      noEmailInfo: 'Vous pouvez fermer cette page et revenir plus tard',
      backgroundInfo: 'La génération continue en arrière-plan sur nos serveurs',
      stayOrGo: 'N\'hésitez pas à attendre ici ou à revenir plus tard',
    },
  };

  const t = translations[language as keyof typeof translations] || translations.en;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-xl max-w-lg w-full p-8">
        {/* Header with animation */}
        <div className="text-center mb-6">
          <div className="relative inline-block mb-4">
            <Loader2 size={56} className="animate-spin text-indigo-600" />
            <span className="absolute -top-1 -right-1 text-2xl">✨</span>
          </div>
          <h2 className="text-2xl font-bold text-gray-800 mb-1">{t.title}</h2>
          <p className="text-gray-500">{t.subtitle}</p>
        </div>

        {/* Progress bar */}
        <ProgressBar
          value={current}
          max={total}
          showPercentage
          size="lg"
          className="mb-2"
        />

        {/* Current step message */}
        {message && (
          <p className="text-indigo-600 text-sm text-center font-medium mb-6">{message}</p>
        )}

        {/* Info cards */}
        <div className="space-y-3 mt-6">
          {/* Time estimate */}
          <div className="flex items-start gap-3 p-3 bg-indigo-50 rounded-lg">
            <Clock size={20} className="text-indigo-600 mt-0.5 shrink-0" />
            <div>
              <p className="text-sm font-medium text-indigo-900">{t.timeInfo}</p>
              <p className="text-xs text-indigo-600">{t.backgroundInfo}</p>
            </div>
          </div>

          {/* Email notification or come back later */}
          <div className="flex items-start gap-3 p-3 bg-green-50 rounded-lg">
            {hasEmail ? (
              <>
                <Mail size={20} className="text-green-600 mt-0.5 shrink-0" />
                <div>
                  <p className="text-sm font-medium text-green-900">{t.emailInfo}</p>
                  <p className="text-xs text-green-600">{user?.email}</p>
                </div>
              </>
            ) : (
              <>
                <ArrowLeft size={20} className="text-green-600 mt-0.5 shrink-0" />
                <div>
                  <p className="text-sm font-medium text-green-900">{t.noEmailInfo}</p>
                  <p className="text-xs text-green-600">{t.stayOrGo}</p>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default GenerationProgress;
