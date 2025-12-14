import { Upload } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import { ChangeEvent } from 'react';

interface PhotoUploadProps {
  onPhotoSelect: (file: File) => void;
  showExamples?: boolean;
}

export function PhotoUpload({ onPhotoSelect, showExamples = true }: PhotoUploadProps) {
  const { t, language } = useLanguage();

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      onPhotoSelect(file);
    }
  };

  return (
    <div className="bg-indigo-50 border-2 border-indigo-300 rounded-lg p-4">
      <p className="text-sm font-semibold text-indigo-700 mb-4 text-center">{t.uploadPhotoFirst}</p>

      {/* Upload button - prominent, first */}
      <div className="text-center mb-5">
        <label className="cursor-pointer inline-flex items-center justify-center gap-3 bg-indigo-600 text-white px-10 py-4 rounded-xl text-xl hover:bg-indigo-700 font-bold shadow-lg transition-colors">
          <Upload size={28} /> {t.uploadPhoto}
          <input
            type="file"
            accept="image/*"
            onChange={handleFileChange}
            className="hidden"
          />
        </label>
      </div>

      {/* Photo examples - smaller on desktop */}
      {showExamples && (
        <div className="max-w-xl mx-auto">
          <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
            {/* Good example 1: Full body */}
            <div className="text-center">
              <img
                src="/images/Full body.jpg"
                alt="Full body example"
                className="w-full md:max-h-32 object-contain rounded border-2 border-green-400 mb-1"
              />
              <span className="text-xs text-green-600 font-medium">
                ✓ {language === 'de' ? 'Ganzkörper' : language === 'fr' ? 'Corps entier' : 'Full body'}
              </span>
            </div>
            {/* Good example 2: Upper body */}
            <div className="text-center">
              <img
                src="/images/Upper body.jpg"
                alt="Upper body example"
                className="w-full md:max-h-32 object-contain rounded border-2 border-green-400 mb-1"
              />
              <span className="text-xs text-green-600 font-medium">
                ✓ {language === 'de' ? 'Oberkörper' : language === 'fr' ? 'Buste' : 'Upper body'}
              </span>
            </div>
            {/* Bad example 1: Close up or blurry */}
            <div className="text-center">
              <img
                src="/images/No zoomed in close up.jpg"
                alt="Too close example"
                className="w-full md:max-h-32 object-contain rounded border-2 border-red-400 mb-1"
              />
              <span className="text-xs text-red-600 font-medium">
                ✗ {language === 'de' ? 'Nahaufnahme/Unscharf' : language === 'fr' ? 'Gros plan/Flou' : 'Close-up/Blurry'}
              </span>
            </div>
            {/* Bad example 2: Sunglasses, hat, helmet */}
            <div className="text-center">
              <img
                src="/images/No sunglasses, hat or helmets.jpg"
                alt="No accessories example"
                className="w-full md:max-h-32 object-contain rounded border-2 border-red-400 mb-1"
              />
              <span className="text-xs text-red-600 font-medium">
                ✗ {language === 'de' ? 'Brille/Hut/Helm' : language === 'fr' ? 'Lunettes/Chapeau' : 'Glasses/Hat/Helmet'}
              </span>
            </div>
            {/* Bad example 3: Crowded/multiple people */}
            <div className="text-center">
              <img
                src="/images/One person not many.jpg"
                alt="One person only example"
                className="w-full md:max-h-32 object-contain rounded border-2 border-red-400 mb-1"
              />
              <span className="text-xs text-red-600 font-medium">
                ✗ {language === 'de' ? 'Eine Person, nicht viele' : language === 'fr' ? 'Une personne, pas plusieurs' : 'One person, not many'}
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default PhotoUpload;
