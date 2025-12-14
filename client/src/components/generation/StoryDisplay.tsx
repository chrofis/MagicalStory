import { BookOpen, FileText, ShoppingCart, Plus, Download } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import type { SceneImage } from '@/types/story';
import type { LanguageLevel } from '@/types/story';

interface StoryDisplayProps {
  title: string;
  story: string;
  sceneImages: SceneImage[];
  languageLevel?: LanguageLevel;
  isGenerating?: boolean;
  onDownloadPdf?: () => void;
  onBuyBook?: () => void;
  onPrintBook?: () => void;
  onCreateAnother?: () => void;
  onDownloadTxt?: () => void;
  storyId?: string | null;
  developerMode?: boolean;
}

export function StoryDisplay({
  title,
  story,
  sceneImages,
  languageLevel = 'standard',
  isGenerating = false,
  onDownloadPdf,
  onBuyBook,
  onPrintBook,
  onCreateAnother,
  onDownloadTxt,
  storyId,
  developerMode = false,
}: StoryDisplayProps) {
  const { t, language } = useLanguage();
  const isPictureBook = languageLevel === '1st-grade';

  // Parse story into pages - handle both markdown (## Seite/Page 1) and old format (--- Page 1 ---)
  const parseStoryPages = (storyText: string) => {
    if (!storyText) return [];
    const pageMatches = storyText.split(/(?:---\s*(?:Page|Seite)\s+\d+\s*---|##\s*(?:Page|Seite)\s+\d+)/i);
    return pageMatches.slice(1).filter(p => p.trim().length > 0);
  };

  const storyPages = parseStoryPages(story);
  const hasImages = sceneImages.length > 0;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex justify-between items-center flex-wrap gap-3">
        <h2 className="text-2xl font-bold text-gray-800 flex items-center gap-2">
          <BookOpen size={24} /> {t.yourStory}
        </h2>
      </div>

      {/* Action Buttons Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {/* TXT Download - Developer mode only */}
        {developerMode && onDownloadTxt && (
          <button
            onClick={onDownloadTxt}
            className="bg-indigo-600 text-white px-6 py-3 rounded-lg hover:bg-indigo-700 font-semibold flex items-center justify-center gap-2"
          >
            <Download size={20} /> {t.downloadTXT}
          </button>
        )}

        {/* PDF Download - All users when images exist */}
        {hasImages && onDownloadPdf && (
          <button
            onClick={onDownloadPdf}
            disabled={isGenerating}
            className={`bg-green-500 text-white px-6 py-3 rounded-lg font-semibold flex items-center justify-center gap-2 ${
              isGenerating ? 'opacity-50 cursor-not-allowed' : 'hover:bg-green-600'
            }`}
          >
            <FileText size={20} /> {language === 'de' ? 'PDF herunterladen' : language === 'fr' ? 'Télécharger PDF' : 'Download PDF'}
          </button>
        )}

        {/* Buy Book - All users when images exist and story is saved */}
        {hasImages && storyId && onBuyBook && (
          <button
            onClick={onBuyBook}
            disabled={isGenerating}
            className={`bg-indigo-500 text-white px-6 py-3 rounded-lg font-semibold flex items-center justify-center gap-2 ${
              isGenerating ? 'opacity-50 cursor-not-allowed' : 'hover:bg-indigo-600'
            }`}
          >
            <ShoppingCart size={20} /> {language === 'de' ? 'Buch kaufen (CHF 36)' : language === 'fr' ? 'Acheter le livre (CHF 36)' : 'Buy Book (CHF 36)'}
          </button>
        )}

        {/* Print Book - Developer mode only (bypasses payment) */}
        {developerMode && hasImages && storyId && onPrintBook && (
          <button
            onClick={onPrintBook}
            disabled={isGenerating}
            className={`bg-yellow-500 text-black px-6 py-3 rounded-lg font-semibold flex items-center justify-center gap-2 ${
              isGenerating ? 'opacity-50 cursor-not-allowed' : 'hover:bg-yellow-600'
            }`}
          >
            <BookOpen size={20} /> {language === 'de' ? 'Buch drucken (DEV)' : language === 'fr' ? 'Imprimer livre (DEV)' : 'Print Book (DEV)'}
          </button>
        )}

        {/* Create Another Story */}
        {onCreateAnother && (
          <button
            onClick={onCreateAnother}
            disabled={isGenerating}
            className={`bg-indigo-500 text-white px-6 py-3 rounded-lg font-semibold flex items-center justify-center gap-2 sm:col-span-2 lg:col-span-1 ${
              isGenerating ? 'opacity-50 cursor-not-allowed' : 'hover:bg-indigo-600'
            }`}
          >
            <Plus size={20} /> {t.createAnotherStory}
          </button>
        )}
      </div>

      {/* Story Pages with Images */}
      {hasImages && story && (
        <div className="space-y-8 mt-8">
          <h3 className="text-2xl font-bold text-gray-800 text-center mb-6">
            {title || (language === 'de' ? 'Ihre Geschichte' : language === 'fr' ? 'Votre histoire' : 'Your Story')}
          </h3>

          {storyPages.map((pageText, index) => {
            const pageNumber = index + 1;
            const image = sceneImages.find(img => img.pageNumber === pageNumber);

            return (
              <div key={pageNumber} className="p-4 md:p-6">
                <h4 className="text-xl font-bold text-gray-800 mb-4 text-center">
                  {language === 'de' ? `Seite ${pageNumber}` : language === 'fr' ? `Page ${pageNumber}` : `Page ${pageNumber}`}
                </h4>

                {/* Picture Book Layout: Image on top, text below */}
                {isPictureBook ? (
                  <div className="flex flex-col items-center max-w-2xl mx-auto">
                    {/* Image on top */}
                    {image && image.imageData ? (
                      <div className="w-full mb-4">
                        <img
                          src={image.imageData}
                          alt={`Scene for page ${pageNumber}`}
                          className="w-full rounded-lg shadow-md object-cover"
                        />
                        {/* Developer Mode: Quality Score */}
                        {developerMode && image.qualityScore !== undefined && (
                          <div className="mt-2 p-2 bg-indigo-50 rounded border border-indigo-200">
                            <div className="flex items-center justify-between text-sm">
                              <span className="font-semibold text-indigo-700">Quality Score:</span>
                              <span className={`font-bold ${
                                image.qualityScore >= 70 ? 'text-green-600' :
                                image.qualityScore >= 50 ? 'text-yellow-600' :
                                'text-red-600'
                              }`}>
                                {(image.qualityScore / 10).toFixed(1)}/10
                              </span>
                            </div>
                          </div>
                        )}
                        {/* Developer Mode: Regeneration Info */}
                        {developerMode && image.wasRegenerated && (
                          <details className="mt-2 bg-orange-50 border border-orange-300 rounded-lg p-3">
                            <summary className="cursor-pointer text-sm font-semibold text-orange-700 flex items-center justify-between">
                              <span>🔄 Image Regenerated</span>
                              {image.originalScore !== undefined && (
                                <span className="text-red-600">Original: {(image.originalScore / 10).toFixed(1)}/10</span>
                              )}
                            </summary>
                            <div className="mt-2">
                              <p className="text-xs text-gray-600 mb-2">
                                Image was automatically regenerated because the first version had low quality.
                              </p>
                              {image.originalImage && (
                                <div className="mt-2">
                                  <p className="text-xs font-semibold text-gray-700 mb-1">Original Image:</p>
                                  <img
                                    src={image.originalImage}
                                    alt="Original (lower quality)"
                                    className="w-full rounded border-2 border-orange-200 opacity-75"
                                  />
                                </div>
                              )}
                            </div>
                          </details>
                        )}
                      </div>
                    ) : (
                      <div className="w-full flex items-center justify-center bg-gray-100 rounded-lg p-8 mb-4">
                        <p className="text-gray-500 text-center">
                          {language === 'de' ? 'Kein Bild für diese Seite' : language === 'fr' ? 'Pas d\'image pour cette page' : 'No image for this page'}
                        </p>
                      </div>
                    )}

                    {/* Text below */}
                    <div className="w-full bg-indigo-50 rounded-lg p-6 border-2 border-indigo-200">
                      <p className="text-gray-800 leading-relaxed whitespace-pre-wrap font-serif text-xl text-center">
                        {pageText.trim()}
                      </p>
                    </div>
                  </div>
                ) : (
                  /* Standard Layout: Image on left, text on right (side-by-side) */
                  <div className="grid md:grid-cols-2 gap-6">
                    {/* Image on the left */}
                    {image && image.imageData ? (
                      <div className="flex flex-col">
                        <img
                          src={image.imageData}
                          alt={`Scene for page ${pageNumber}`}
                          className="w-full rounded-lg shadow-md object-cover"
                        />
                        {/* Developer Mode: Quality Score */}
                        {developerMode && image.qualityScore !== undefined && (
                          <div className="mt-2 p-2 bg-indigo-50 rounded border border-indigo-200">
                            <div className="flex items-center justify-between text-sm">
                              <span className="font-semibold text-indigo-700">Quality Score:</span>
                              <span className={`font-bold ${
                                image.qualityScore >= 70 ? 'text-green-600' :
                                image.qualityScore >= 50 ? 'text-yellow-600' :
                                'text-red-600'
                              }`}>
                                {(image.qualityScore / 10).toFixed(1)}/10
                              </span>
                            </div>
                          </div>
                        )}
                        {/* Developer Mode: Regeneration Info */}
                        {developerMode && image.wasRegenerated && (
                          <details className="mt-2 bg-orange-50 border border-orange-300 rounded-lg p-3">
                            <summary className="cursor-pointer text-sm font-semibold text-orange-700 flex items-center justify-between">
                              <span>🔄 Image Regenerated</span>
                              {image.originalScore !== undefined && (
                                <span className="text-red-600">Original: {(image.originalScore / 10).toFixed(1)}/10</span>
                              )}
                            </summary>
                            <div className="mt-2">
                              <p className="text-xs text-gray-600 mb-2">
                                Image was automatically regenerated because the first version had low quality.
                              </p>
                              {image.originalImage && (
                                <div className="mt-2">
                                  <p className="text-xs font-semibold text-gray-700 mb-1">Original Image:</p>
                                  <img
                                    src={image.originalImage}
                                    alt="Original (lower quality)"
                                    className="w-full rounded border-2 border-orange-200 opacity-75"
                                  />
                                </div>
                              )}
                            </div>
                          </details>
                        )}
                      </div>
                    ) : (
                      <div className="flex items-center justify-center bg-gray-100 rounded-lg p-8">
                        <p className="text-gray-500 text-center">
                          {language === 'de' ? 'Kein Bild für diese Seite' : language === 'fr' ? 'Pas d\'image pour cette page' : 'No image for this page'}
                        </p>
                      </div>
                    )}

                    {/* Text on the right */}
                    <div className="flex items-center">
                      <div className="prose max-w-none">
                        <p className="text-gray-800 leading-relaxed whitespace-pre-wrap font-serif text-xl">
                          {pageText.trim()}
                        </p>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Bottom Action Buttons - for users who scrolled to the end */}
      {hasImages && story && (
        <div className="bg-gradient-to-r from-indigo-50 to-purple-50 border-2 border-indigo-200 rounded-xl p-6 mt-6">
          <h3 className="text-lg font-bold text-gray-800 mb-4 text-center">
            {language === 'de' ? 'Was möchten Sie als Nächstes tun?' : language === 'fr' ? 'Que souhaitez-vous faire ensuite ?' : 'What would you like to do next?'}
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {/* Download PDF */}
            {onDownloadPdf && (
              <button
                onClick={onDownloadPdf}
                disabled={isGenerating}
                className={`bg-green-500 text-white px-6 py-3 rounded-lg font-semibold flex items-center justify-center gap-2 ${
                  isGenerating ? 'opacity-50 cursor-not-allowed' : 'hover:bg-green-600'
                }`}
              >
                <FileText size={20} /> {language === 'de' ? 'PDF herunterladen' : language === 'fr' ? 'Télécharger PDF' : 'Download PDF'}
              </button>
            )}

            {/* Buy Book */}
            {storyId && onBuyBook && (
              <button
                onClick={onBuyBook}
                disabled={isGenerating}
                className={`bg-indigo-500 text-white px-6 py-3 rounded-lg font-semibold flex items-center justify-center gap-2 ${
                  isGenerating ? 'opacity-50 cursor-not-allowed' : 'hover:bg-indigo-600'
                }`}
              >
                <ShoppingCart size={20} /> {language === 'de' ? 'Buch kaufen (CHF 36)' : language === 'fr' ? 'Acheter le livre (CHF 36)' : 'Buy Book (CHF 36)'}
              </button>
            )}

            {/* Create Another Story */}
            {onCreateAnother && (
              <button
                onClick={onCreateAnother}
                disabled={isGenerating}
                className={`bg-indigo-500 text-white px-6 py-3 rounded-lg font-semibold flex items-center justify-center gap-2 ${
                  isGenerating ? 'opacity-50 cursor-not-allowed' : 'hover:bg-indigo-600'
                }`}
              >
                <Plus size={20} /> {t.createAnotherStory}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default StoryDisplay;
