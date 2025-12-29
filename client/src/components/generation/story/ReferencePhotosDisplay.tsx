import type { ReferencePhoto } from '@/types/story';

interface ReferencePhotosDisplayProps {
  referencePhotos: ReferencePhoto[];
  language: string;
}

/**
 * Component to display reference photos used for image generation
 */
export function ReferencePhotosDisplay({
  referencePhotos,
  language
}: ReferencePhotosDisplayProps) {
  if (!referencePhotos || referencePhotos.length === 0) return null;

  const getPhotoTypeLabel = (photoType: string) => {
    switch (photoType) {
      case 'bodyNoBg':
      case 'body-no-bg': return language === 'de' ? 'Ganzkörper (freigestellt)' : language === 'fr' ? 'Corps entier (détouré)' : 'Full body (no bg)';
      case 'body': return language === 'de' ? 'Ganzkörper' : language === 'fr' ? 'Corps entier' : 'Full body';
      case 'face': return language === 'de' ? 'Gesicht' : language === 'fr' ? 'Visage' : 'Face only';
      case 'clothing-winter': return language === 'de' ? 'Winter-Avatar' : language === 'fr' ? 'Avatar hiver' : 'Winter avatar';
      case 'clothing-summer': return language === 'de' ? 'Sommer-Avatar' : language === 'fr' ? 'Avatar été' : 'Summer avatar';
      case 'clothing-formal': return language === 'de' ? 'Formell-Avatar' : language === 'fr' ? 'Avatar formel' : 'Formal avatar';
      case 'clothing-standard': return language === 'de' ? 'Standard-Avatar' : language === 'fr' ? 'Avatar standard' : 'Standard avatar';
      case 'none': return language === 'de' ? 'Kein Foto' : language === 'fr' ? 'Pas de photo' : 'No photo';
      default: return photoType;
    }
  };

  const getPhotoTypeColor = (photoType: string) => {
    switch (photoType) {
      case 'bodyNoBg':
      case 'body-no-bg': return 'bg-green-100 text-green-700 border-green-300';
      case 'body': return 'bg-blue-100 text-blue-700 border-blue-300';
      case 'face': return 'bg-yellow-100 text-yellow-700 border-yellow-300';
      case 'clothing-winter': return 'bg-cyan-100 text-cyan-700 border-cyan-300';
      case 'clothing-summer': return 'bg-orange-100 text-orange-700 border-orange-300';
      case 'clothing-formal': return 'bg-purple-100 text-purple-700 border-purple-300';
      case 'clothing-standard': return 'bg-teal-100 text-teal-700 border-teal-300';
      case 'none': return 'bg-red-100 text-red-700 border-red-300';
      default: return 'bg-gray-100 text-gray-700 border-gray-300';
    }
  };

  // Get clothing category from first photo that has it
  const clothingCategory = referencePhotos.find(p => p.clothingCategory)?.clothingCategory;

  const getClothingLabel = (category: string | undefined) => {
    if (!category) return '';
    switch (category) {
      case 'winter': return language === 'de' ? 'Winter' : language === 'fr' ? 'Hiver' : 'Winter';
      case 'summer': return language === 'de' ? 'Sommer' : language === 'fr' ? 'Été' : 'Summer';
      case 'formal': return language === 'de' ? 'Formell' : language === 'fr' ? 'Formel' : 'Formal';
      case 'standard': return language === 'de' ? 'Standard' : 'Standard';
      default: return category;
    }
  };

  return (
    <details className="bg-pink-50 border border-pink-300 rounded-lg p-3">
      <summary className="cursor-pointer text-sm font-semibold text-pink-700 hover:text-pink-900 flex items-center gap-2">
        <span>📸</span>
        {language === 'de' ? 'Referenzfotos' : language === 'fr' ? 'Photos de référence' : 'Reference Photos'}
        <span className="text-xs text-pink-600">({referencePhotos.length})</span>
        {clothingCategory && (
          <span className="ml-2 px-2 py-0.5 bg-pink-200 text-pink-800 text-xs rounded">
            👕 {getClothingLabel(clothingCategory)}
          </span>
        )}
      </summary>
      <div className="mt-3 grid grid-cols-2 sm:grid-cols-3 gap-2">
        {referencePhotos.map((photo, idx) => (
          <div key={idx} className="bg-white rounded-lg p-2 border border-pink-200">
            <div className="flex items-center justify-between mb-2">
              <span className="font-semibold text-xs text-gray-800 truncate">{photo.name}</span>
              <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium border whitespace-nowrap ${getPhotoTypeColor(photo.photoType)}`}>
                {getPhotoTypeLabel(photo.photoType)}
              </span>
            </div>
            {photo.photoUrl && (
              <>
                <img
                  src={photo.photoUrl}
                  alt={`${photo.name} - ${getPhotoTypeLabel(photo.photoType)}`}
                  className="w-full max-h-32 object-contain rounded border border-gray-200 bg-gray-50"
                />
                {photo.photoHash && (
                  <div className="mt-1 text-[9px] font-mono text-gray-500 bg-gray-100 px-1 py-0.5 rounded text-center">
                    🔐 {photo.photoHash}
                  </div>
                )}
              </>
            )}
          </div>
        ))}
      </div>
    </details>
  );
}
