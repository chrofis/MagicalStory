import { useState, useCallback } from 'react';
import type { ReferencePhoto } from '@/types/story';
import { ImageLightbox } from '@/components/common/ImageLightbox';
import storyService from '@/services/storyService';

interface LandmarkPhoto {
  name: string;
  photoData?: string;  // May be stripped in dev-metadata response
  hasPhoto?: boolean;  // Flag when photoData is stripped
  attribution?: string;
  source?: string;
}

interface ReferencePhotosDisplayProps {
  referencePhotos: ReferencePhoto[];
  landmarkPhotos?: LandmarkPhoto[];
  visualBibleGrid?: string;  // Base64 data URL of combined VB elements grid
  language: string;
  // For lazy loading
  storyId?: string;
  pageNumber?: number;
}

/**
 * Component to display reference photos used for image generation
 */
export function ReferencePhotosDisplay({
  referencePhotos,
  landmarkPhotos,
  visualBibleGrid,
  language,
  storyId,
  pageNumber
}: ReferencePhotosDisplayProps) {
  const [lightboxImage, setLightboxImage] = useState<string | null>(null);
  const [loadedReferencePhotos, setLoadedReferencePhotos] = useState<ReferencePhoto[] | null>(null);
  const [loadedLandmarkPhotos, setLoadedLandmarkPhotos] = useState<LandmarkPhoto[] | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Check if we need to lazy load (photos have hasPhoto flag but no actual data)
  const needsLazyLoadRef = referencePhotos?.some(p => p.hasPhoto && !p.photoUrl);
  const needsLazyLoadLandmark = landmarkPhotos?.some(p => p.hasPhoto && !p.photoData);

  const loadImages = useCallback(async () => {
    if (!storyId || !pageNumber || isLoading) return;
    if (!needsLazyLoadRef && !needsLazyLoadLandmark) return;

    setIsLoading(true);
    setLoadError(null);

    try {
      // Load reference photos
      if (needsLazyLoadRef) {
        const refData = await storyService.getDevImage(storyId, pageNumber, 'reference');
        if (refData?.referencePhotos) {
          setLoadedReferencePhotos(refData.referencePhotos as ReferencePhoto[]);
        }
      }

      // Load landmark photos
      if (needsLazyLoadLandmark) {
        const landmarkData = await storyService.getDevImage(storyId, pageNumber, 'landmark');
        if (landmarkData?.landmarkPhotos) {
          setLoadedLandmarkPhotos(landmarkData.landmarkPhotos as LandmarkPhoto[]);
        }
      }
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load images');
    } finally {
      setIsLoading(false);
    }
  }, [storyId, pageNumber, isLoading, needsLazyLoadRef, needsLazyLoadLandmark]);

  // Use loaded photos if available, otherwise use props
  const displayRefPhotos = loadedReferencePhotos || referencePhotos;
  const displayLandmarkPhotos = loadedLandmarkPhotos || landmarkPhotos;

  const hasCharacterPhotos = displayRefPhotos && displayRefPhotos.length > 0;
  const hasLandmarkPhotos = displayLandmarkPhotos && displayLandmarkPhotos.length > 0;
  const hasVBGrid = !!visualBibleGrid;

  if (!hasCharacterPhotos && !hasLandmarkPhotos && !hasVBGrid) return null;

  const totalCount = (referencePhotos?.length || 0) + (landmarkPhotos?.length || 0) + (hasVBGrid ? 1 : 0);

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
  const clothingCategory = displayRefPhotos?.find(p => p.clothingCategory)?.clothingCategory;

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
    <details
      className="bg-pink-50 border border-pink-300 rounded-lg p-3"
      onToggle={(e) => {
        if ((e.target as HTMLDetailsElement).open && (needsLazyLoadRef || needsLazyLoadLandmark)) {
          loadImages();
        }
      }}
    >
      <summary className="cursor-pointer text-sm font-semibold text-pink-700 hover:text-pink-900 flex items-center gap-2">
        <span>📸</span>
        {language === 'de' ? 'Referenzfotos' : language === 'fr' ? 'Photos de référence' : 'Reference Photos'}
        <span className="text-xs text-pink-600">({totalCount})</span>
        {clothingCategory && (
          <span className="ml-2 px-2 py-0.5 bg-pink-200 text-pink-800 text-xs rounded">
            👕 {getClothingLabel(clothingCategory)}
          </span>
        )}
        {hasLandmarkPhotos && (
          <span className="ml-2 px-2 py-0.5 bg-amber-200 text-amber-800 text-xs rounded">
            📍 {displayLandmarkPhotos!.length} {language === 'de' ? 'Wahrzeichen' : 'Landmark'}
          </span>
        )}
        {hasVBGrid && (
          <span className="ml-2 px-2 py-0.5 bg-indigo-200 text-indigo-800 text-xs rounded">
            🔲 VB Grid
          </span>
        )}
        {isLoading && (
          <span className="ml-2 text-xs text-gray-500 animate-pulse">Loading...</span>
        )}
      </summary>

      {/* Loading error */}
      {loadError && (
        <div className="mt-3 text-sm text-red-600 bg-red-50 p-2 rounded">
          {loadError}
        </div>
      )}

      {/* Character photos */}
      {hasCharacterPhotos && (
        <div className="mt-3 grid grid-cols-2 sm:grid-cols-3 gap-2">
          {displayRefPhotos!.map((photo, idx) => (
            <div key={idx} className="bg-white rounded-lg p-2 border border-pink-200">
              <div className="flex items-center justify-between mb-2">
                <span className="font-semibold text-xs text-gray-800 truncate">{photo.name}</span>
                {photo.photoType && (
                  <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium border whitespace-nowrap ${getPhotoTypeColor(photo.photoType)}`}>
                    {getPhotoTypeLabel(photo.photoType)}
                  </span>
                )}
              </div>
              {photo.photoUrl ? (
                <>
                  <div className="relative">
                    <img
                      src={photo.photoUrl}
                      alt={`${photo.name} - ${getPhotoTypeLabel(photo.photoType || 'unknown')}`}
                      className={`w-full max-h-32 object-contain rounded border bg-gray-50 cursor-pointer hover:opacity-80 transition-opacity ${photo.isStyled ? 'border-purple-400 ring-2 ring-purple-200' : 'border-gray-200'}`}
                      onClick={() => setLightboxImage(photo.photoUrl)}
                      title="Click to enlarge"
                    />
                    {photo.isStyled && (
                      <span className="absolute top-1 right-1 px-1 py-0.5 text-[9px] font-bold bg-purple-500 text-white rounded">
                        🎨 STYLED
                      </span>
                    )}
                  </div>
                  {photo.photoHash && (
                    <div className="mt-1 text-[9px] font-mono text-gray-500 bg-gray-100 px-1 py-0.5 rounded text-center">
                      🔐 {photo.photoHash}
                    </div>
                  )}
                </>
              ) : (
                <div className="text-xs text-gray-500 italic py-2 text-center bg-gray-100 rounded">
                  {language === 'de' ? 'Foto nicht geladen' : 'Photo not loaded'}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Landmark photos */}
      {hasLandmarkPhotos && (
        <div className={hasCharacterPhotos ? "mt-4 pt-3 border-t border-pink-200" : "mt-3"}>
          <div className="text-xs font-semibold text-amber-700 mb-2 flex items-center gap-1">
            📍 {language === 'de' ? 'Wahrzeichen-Referenzfotos' : language === 'fr' ? 'Photos de monuments' : 'Landmark Reference Photos'}
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {displayLandmarkPhotos!.map((landmark, idx) => (
              <div key={idx} className="bg-amber-50 rounded-lg p-2 border border-amber-200">
                <div className="flex items-center justify-between mb-2">
                  <span className="font-semibold text-xs text-gray-800 truncate">{landmark.name}</span>
                  <span className="px-1.5 py-0.5 rounded text-[10px] font-medium border whitespace-nowrap bg-amber-100 text-amber-700 border-amber-300">
                    📍 LANDMARK
                  </span>
                </div>
                {landmark.photoData ? (
                  <>
                    <div className="relative">
                      <img
                        src={landmark.photoData}
                        alt={`${landmark.name} landmark`}
                        className="w-full max-h-32 object-contain rounded border border-amber-200 bg-gray-50 cursor-pointer hover:opacity-80 transition-opacity"
                        onClick={() => setLightboxImage(landmark.photoData!)}
                        title="Click to enlarge"
                      />
                    </div>
                    {landmark.attribution && (
                      <div className="mt-1 text-[9px] text-gray-500 bg-gray-100 px-1 py-0.5 rounded truncate" title={landmark.attribution}>
                        📷 {landmark.attribution}
                      </div>
                    )}
                    {landmark.source && (
                      <div className="mt-0.5 text-[9px] text-gray-400">
                        Source: {landmark.source}
                      </div>
                    )}
                  </>
                ) : (
                  <div className="text-xs text-gray-500 italic py-2 text-center bg-gray-100 rounded">
                    {language === 'de' ? 'Foto nicht geladen' : 'Photo not loaded'}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Visual Bible Grid (combined VB elements + secondary landmarks) */}
      {hasVBGrid && (
        <div className={hasCharacterPhotos || hasLandmarkPhotos ? "mt-4 pt-3 border-t border-pink-200" : "mt-3"}>
          <div className="text-xs font-semibold text-indigo-700 mb-2 flex items-center gap-1">
            🔲 {language === 'de' ? 'Visual Bible Referenzgitter' : language === 'fr' ? 'Grille Visual Bible' : 'Visual Bible Reference Grid'}
          </div>
          <div className="bg-indigo-50 rounded-lg p-2 border border-indigo-200">
            <div className="flex items-center justify-between mb-2">
              <span className="font-semibold text-xs text-gray-800">
                {language === 'de' ? 'Kombinierte Referenzen' : language === 'fr' ? 'Références combinées' : 'Combined References'}
              </span>
              <span className="px-1.5 py-0.5 rounded text-[10px] font-medium border whitespace-nowrap bg-indigo-100 text-indigo-700 border-indigo-300">
                🔲 VB GRID
              </span>
            </div>
            <div className="text-[10px] text-gray-500 mb-2">
              {language === 'de'
                ? 'Sekundäre Charaktere, Tiere, Artefakte, Fahrzeuge und zusätzliche Wahrzeichen'
                : language === 'fr'
                ? 'Personnages secondaires, animaux, artefacts, véhicules et monuments supplémentaires'
                : 'Secondary characters, animals, artifacts, vehicles, and additional landmarks'}
            </div>
            <img
              src={visualBibleGrid}
              alt="Visual Bible Reference Grid"
              className="w-full max-h-64 object-contain rounded border border-indigo-200 bg-gray-50 cursor-pointer hover:opacity-80 transition-opacity"
              onClick={() => setLightboxImage(visualBibleGrid!)}
              title="Click to enlarge"
            />
          </div>
        </div>
      )}

      {/* Lightbox for enlarged view */}
      <ImageLightbox
        src={lightboxImage}
        onClose={() => setLightboxImage(null)}
      />
    </details>
  );
}
