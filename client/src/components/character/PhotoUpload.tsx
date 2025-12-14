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

  // Description text for the photo upload step
  const descriptionText = language === 'de'
    ? 'Deine Geschichte wird basierend auf den hochgeladenen Fotos erstellt. Verwende Fotos mit nur einer Person, idealerweise Ganzkörperaufnahmen, da auch die Kleidung in die Geschichte übernommen wird.'
    : language === 'fr'
    ? 'Votre histoire sera générée à partir des photos téléchargées. Utilisez des photos d\'une seule personne, idéalement en pied, car les vêtements seront également intégrés dans l\'histoire.'
    : 'Your story will be generated based on the photos you upload. Use photos of a single person, ideally full body shots, as clothing will also be copied into the story.';

  return (
    <div className="bg-indigo-50 border-2 border-indigo-300 rounded-lg p-4">
      {/* Description of this step */}
      <p className="text-sm text-gray-700 mb-4 text-center">
        {descriptionText}
      </p>

      {/* Upload button - prominent */}
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
                {language === 'de' ? 'Ganzkörper' : language === 'fr' ? 'Corps entier' : 'Full body'}
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
                {language === 'de' ? 'Oberkörper' : language === 'fr' ? 'Buste' : 'Upper body'}
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
                {language === 'de' ? 'Zu nah / Unscharf' : language === 'fr' ? 'Trop proche / Flou' : 'Too close / Blurry'}
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
                {language === 'de' ? 'Brille / Hut / Helm' : language === 'fr' ? 'Lunettes / Chapeau' : 'Glasses / Hat / Helmet'}
              </span>
            </div>
            {/* Bad example 3: Multiple people */}
            <div className="text-center">
              <img
                src="/images/One person not many.jpg"
                alt="One person only example"
                className="w-full md:max-h-32 object-contain rounded border-2 border-red-400 mb-1"
              />
              <span className="text-xs text-red-600 font-medium">
                {language === 'de' ? 'Nur eine Person' : language === 'fr' ? 'Une seule personne' : 'Only one person'}
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default PhotoUpload;
