import { Loader2 } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
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

  if (!isGenerating || total === 0) {
    return null;
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-xl max-w-md w-full p-8 text-center">
        <div className="mb-6">
          <Loader2 size={48} className="animate-spin text-indigo-600 mx-auto mb-4" />
          <h2 className="text-2xl font-bold text-gray-800 mb-2">
            {language === 'de'
              ? 'Generiere Geschichte...'
              : language === 'fr'
              ? 'Generation en cours...'
              : 'Generating Story...'}
          </h2>
        </div>

        <ProgressBar
          value={current}
          max={total}
          showPercentage
          size="lg"
          className="mb-4"
        />

        {message && (
          <p className="text-gray-600 text-sm">{message}</p>
        )}

        <p className="text-gray-400 text-xs mt-4">
          {language === 'de'
            ? 'Bitte warten Sie, dies kann einige Minuten dauern...'
            : language === 'fr'
            ? 'Veuillez patienter, cela peut prendre quelques minutes...'
            : 'Please wait, this may take a few minutes...'}
        </p>
      </div>
    </div>
  );
}

export default GenerationProgress;
