import { BookOpen, FileText, ShoppingCart, Plus, Download, RefreshCw, Edit3, History } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import type { SceneImage, SceneDescription, CoverImages, CoverImageData, RetryAttempt } from '@/types/story';
import type { LanguageLevel } from '@/types/story';
import type { VisualBible, VisualBibleEntry } from '@/types/character';

// Helper component to display retry history
function RetryHistoryDisplay({
  retryHistory,
  totalAttempts,
  language
}: {
  retryHistory: RetryAttempt[];
  totalAttempts: number;
  language: string;
}) {
  if (!retryHistory || retryHistory.length === 0) return null;

  return (
    <details className="bg-purple-50 border border-purple-300 rounded-lg p-3">
      <summary className="cursor-pointer text-sm font-semibold text-purple-700 flex items-center justify-between">
        <span className="flex items-center gap-2">
          <History size={14} />
          {language === 'de' ? 'Generierungshistorie' : language === 'fr' ? 'Historique de génération' : 'Generation History'}
        </span>
        <span className="text-purple-600">
          {totalAttempts} {language === 'de' ? 'Versuche' : language === 'fr' ? 'tentatives' : 'attempts'}
        </span>
      </summary>
      <div className="mt-3 space-y-3">
        {retryHistory.map((attempt, idx) => (
          <div key={idx} className={`border rounded-lg p-3 ${
            idx === retryHistory.length - 1
              ? 'bg-green-50 border-green-300'
              : 'bg-white border-gray-200'
          }`}>
            <div className="flex items-center justify-between mb-2">
              <span className="font-semibold text-sm">
                {language === 'de' ? `Versuch ${attempt.attempt}` : language === 'fr' ? `Tentative ${attempt.attempt}` : `Attempt ${attempt.attempt}`}
                {attempt.type === 'text_edit' && (
                  <span className="text-xs ml-2 text-blue-600">(text edit)</span>
                )}
                {attempt.type === 'text_edit_failed' && (
                  <span className="text-xs ml-2 text-red-600">(text edit failed)</span>
                )}
                {idx === retryHistory.length - 1 && (
                  <span className="text-xs ml-2 text-green-600 font-bold">✓ USED</span>
                )}
              </span>
              {attempt.score !== undefined && (
                <span className={`font-bold ${
                  attempt.score >= 70 ? 'text-green-600' :
                  attempt.score >= 50 ? 'text-yellow-600' :
                  'text-red-600'
                }`}>
                  {Math.round(attempt.score)}%
                </span>
              )}
            </div>

            {attempt.error && (
              <div className="text-xs text-red-600 mb-2">Error: {attempt.error}</div>
            )}

            {attempt.textIssue && attempt.textIssue !== 'NONE' && (
              <div className="text-xs text-orange-600 mb-2">
                Text issue: {attempt.textIssue}
                {attempt.expectedText && <span className="block">Expected: "{attempt.expectedText}"</span>}
                {attempt.actualText && <span className="block">Actual: "{attempt.actualText}"</span>}
              </div>
            )}

            {attempt.reasoning && (
              <details className="text-xs text-gray-600 mb-2">
                <summary className="cursor-pointer">{language === 'de' ? 'Feedback' : 'Feedback'}</summary>
                <p className="mt-1 whitespace-pre-wrap bg-gray-50 p-2 rounded">{attempt.reasoning}</p>
              </details>
            )}

            {attempt.imageData && (
              <details>
                <summary className="cursor-pointer text-xs text-blue-600">
                  {language === 'de' ? 'Bild anzeigen' : language === 'fr' ? 'Voir image' : 'View image'}
                </summary>
                <img
                  src={attempt.imageData}
                  alt={`Attempt ${attempt.attempt}`}
                  className={`mt-2 w-full rounded border ${idx === retryHistory.length - 1 ? 'border-green-300' : 'border-gray-200 opacity-75'}`}
                />
              </details>
            )}

            <div className="text-xs text-gray-400 mt-1">
              {new Date(attempt.timestamp).toLocaleTimeString()}
            </div>
          </div>
        ))}
      </div>
    </details>
  );
}

interface StoryTextPrompt {
  batch: number;
  startPage: number;
  endPage: number;
  prompt: string;
}

interface StoryDisplayProps {
  title: string;
  story: string;
  outline?: string;
  outlinePrompt?: string;
  storyTextPrompts?: StoryTextPrompt[];
  visualBible?: VisualBible;
  sceneImages: SceneImage[];
  sceneDescriptions?: SceneDescription[];
  coverImages?: CoverImages;
  languageLevel?: LanguageLevel;
  isGenerating?: boolean;
  onDownloadPdf?: () => void;
  onBuyBook?: () => void;
  onPrintBook?: () => void;
  onCreateAnother?: () => void;
  onDownloadTxt?: () => void;
  onRegenerateImage?: (pageNumber: number) => Promise<void>;
  onRegenerateCover?: (coverType: 'front' | 'back' | 'initial') => Promise<void>;
  onEditImage?: (pageNumber: number) => void;
  onEditCover?: (coverType: 'front' | 'back' | 'initial') => void;
  storyId?: string | null;
  developerMode?: boolean;
  // Partial story fields
  isPartial?: boolean;
  failureReason?: string;
  generatedPages?: number;
  totalPages?: number;
}

export function StoryDisplay({
  title,
  story,
  outline,
  outlinePrompt,
  storyTextPrompts = [],
  visualBible,
  sceneImages,
  sceneDescriptions = [],
  coverImages,
  languageLevel = 'standard',
  isGenerating = false,
  onDownloadPdf,
  onBuyBook,
  onPrintBook,
  onCreateAnother,
  onDownloadTxt,
  onRegenerateImage,
  onRegenerateCover,
  onEditImage,
  onEditCover,
  storyId,
  developerMode = false,
  isPartial = false,
  failureReason,
  generatedPages,
  totalPages,
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

  // Helper to get cover image data (handles both string and object formats)
  const getCoverImageData = (img: string | CoverImageData | null | undefined): string | null => {
    if (!img) return null;
    if (typeof img === 'string') return img;
    return img.imageData || null;
  };

  // Helper to get full cover image object
  const getCoverImageObject = (img: string | CoverImageData | null | undefined): CoverImageData | null => {
    if (!img) return null;
    if (typeof img === 'string') return { imageData: img };
    return img;
  };

  // Helper to get scene description for a page
  const getSceneDescription = (pageNumber: number): string | undefined => {
    // First check sceneDescriptions array
    const fromDescriptions = sceneDescriptions.find(s => s.pageNumber === pageNumber)?.description;
    if (fromDescriptions) return fromDescriptions;
    // Fall back to image.description if available
    const image = sceneImages.find(img => img.pageNumber === pageNumber);
    return image?.description;
  };

  return (
    <div className="space-y-6">
      {/* Story Title */}
      <h1 className="text-3xl md:text-4xl font-bold text-gray-800 text-center">
        {title || t.yourStory}
      </h1>

      {/* Partial Story Warning Banner */}
      {isPartial && (
        <div className="bg-amber-50 border-2 border-amber-400 rounded-lg p-4">
          <div className="flex items-start gap-3">
            <div className="text-amber-500 text-2xl">⚠️</div>
            <div>
              <h3 className="font-bold text-amber-800">
                {language === 'de' ? 'Unvollständige Geschichte' : language === 'fr' ? 'Histoire incomplète' : 'Incomplete Story'}
              </h3>
              <p className="text-amber-700 text-sm mt-1">
                {language === 'de'
                  ? `Diese Geschichte konnte nicht vollständig generiert werden. ${generatedPages || sceneImages.length} von ${totalPages || 'unbekannt'} Seiten wurden erstellt.`
                  : language === 'fr'
                  ? `Cette histoire n'a pas pu être générée complètement. ${generatedPages || sceneImages.length} sur ${totalPages || 'inconnu'} pages ont été créées.`
                  : `This story could not be fully generated. ${generatedPages || sceneImages.length} of ${totalPages || 'unknown'} pages were created.`}
              </p>
              {failureReason && developerMode && (
                <details className="mt-2 text-sm">
                  <summary className="cursor-pointer text-amber-600 hover:text-amber-700">
                    {language === 'de' ? 'Fehlerdetails' : language === 'fr' ? 'Détails de l\'erreur' : 'Error details'}
                  </summary>
                  <p className="mt-1 bg-amber-100 p-2 rounded text-amber-800 font-mono text-xs">
                    {failureReason}
                  </p>
                </details>
              )}
            </div>
          </div>
        </div>
      )}

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

      {/* Developer Mode: Story Overview and Full Text */}
      {developerMode && (
        <div className="space-y-4 mt-6">
          {/* Story Outline/Overview */}
          {outline && (
            <details className="bg-purple-50 border-2 border-purple-200 rounded-xl p-4">
              <summary className="cursor-pointer text-lg font-bold text-purple-800 hover:text-purple-900 flex items-center gap-2">
                <FileText size={20} />
                {language === 'de' ? 'Story-Übersicht (Outline)' : language === 'fr' ? 'Aperçu de l\'histoire' : 'Story Overview (Outline)'}
              </summary>
              <pre className="mt-4 text-sm text-gray-700 whitespace-pre-wrap font-mono bg-white p-4 rounded-lg border border-purple-200 overflow-x-auto max-h-96 overflow-y-auto">
                {outline}
              </pre>
            </details>
          )}

          {/* Full Story Text */}
          {story && (
            <details className="bg-amber-50 border-2 border-amber-200 rounded-xl p-4">
              <summary className="cursor-pointer text-lg font-bold text-amber-800 hover:text-amber-900 flex items-center gap-2">
                <BookOpen size={20} />
                {language === 'de' ? 'Vollständiger Story-Text' : language === 'fr' ? 'Texte complet de l\'histoire' : 'Full Story Text'}
              </summary>
              <pre className="mt-4 text-sm text-gray-700 whitespace-pre-wrap font-mono bg-white p-4 rounded-lg border border-amber-200 overflow-x-auto max-h-96 overflow-y-auto">
                {story}
              </pre>
            </details>
          )}

          {/* Outline API Prompt */}
          {outlinePrompt && (
            <details className="bg-cyan-50 border-2 border-cyan-200 rounded-xl p-4">
              <summary className="cursor-pointer text-lg font-bold text-cyan-800 hover:text-cyan-900 flex items-center gap-2">
                <FileText size={20} />
                {language === 'de' ? 'API-Prompt: Outline' : language === 'fr' ? 'Prompt API: Plan' : 'API Prompt: Outline'}
              </summary>
              <pre className="mt-4 text-sm text-gray-700 whitespace-pre-wrap font-mono bg-white p-4 rounded-lg border border-cyan-200 overflow-x-auto max-h-96 overflow-y-auto">
                {outlinePrompt}
              </pre>
            </details>
          )}

          {/* Story Text API Prompts */}
          {storyTextPrompts.length > 0 && (
            <details className="bg-teal-50 border-2 border-teal-200 rounded-xl p-4">
              <summary className="cursor-pointer text-lg font-bold text-teal-800 hover:text-teal-900 flex items-center gap-2">
                <FileText size={20} />
                {language === 'de' ? `API-Prompts: Story-Text (${storyTextPrompts.length} Batches)` : language === 'fr' ? `Prompts API: Texte (${storyTextPrompts.length} lots)` : `API Prompts: Story Text (${storyTextPrompts.length} batches)`}
              </summary>
              <div className="mt-4 space-y-4">
                {storyTextPrompts.map((batch) => (
                  <details key={batch.batch} className="bg-white border border-teal-200 rounded-lg p-3">
                    <summary className="cursor-pointer text-sm font-semibold text-teal-700">
                      {language === 'de' ? `Batch ${batch.batch}: Seiten ${batch.startPage}-${batch.endPage}` : language === 'fr' ? `Lot ${batch.batch}: Pages ${batch.startPage}-${batch.endPage}` : `Batch ${batch.batch}: Pages ${batch.startPage}-${batch.endPage}`}
                    </summary>
                    <pre className="mt-2 text-xs text-gray-700 whitespace-pre-wrap font-mono bg-gray-50 p-3 rounded border overflow-x-auto max-h-64 overflow-y-auto">
                      {batch.prompt}
                    </pre>
                  </details>
                ))}
              </div>
            </details>
          )}

          {/* Visual Bible - Recurring Elements for Consistency */}
          {visualBible && (
            <details className="bg-rose-50 border-2 border-rose-200 rounded-xl p-4">
              <summary className="cursor-pointer text-lg font-bold text-rose-800 hover:text-rose-900 flex items-center gap-2">
                <BookOpen size={20} />
                {language === 'de' ? 'Visual Bible (Wiederkehrende Elemente)' : language === 'fr' ? 'Bible Visuelle (Éléments Récurrents)' : 'Visual Bible (Recurring Elements)'}
                {visualBible.changeLog && visualBible.changeLog.length > 0 && (
                  <span className="ml-2 px-2 py-0.5 bg-rose-200 text-rose-800 rounded-full text-xs font-medium">
                    {visualBible.changeLog.length} {language === 'de' ? 'Änderungen' : language === 'fr' ? 'changements' : 'changes'}
                  </span>
                )}
              </summary>
              <div className="mt-4 space-y-4">
                {/* Main Characters - Style Analysis */}
                {visualBible.mainCharacters && visualBible.mainCharacters.length > 0 && (
                  <div className="bg-white border border-purple-300 rounded-lg p-3">
                    <h4 className="text-sm font-bold text-purple-700 mb-2 flex items-center gap-2">
                      <span className="text-lg">👗</span>
                      {language === 'de' ? 'Hauptcharaktere (Style Profile)' : language === 'fr' ? 'Personnages Principaux (Profil Style)' : 'Main Characters (Style Profile)'}
                    </h4>
                    <div className="space-y-3">
                      {visualBible.mainCharacters.map((char) => (
                        <details key={char.id} className="bg-purple-50 p-2 rounded text-sm">
                          <summary className="cursor-pointer font-semibold text-purple-800 hover:text-purple-900">
                            {char.name}
                            <span className={`ml-2 px-2 py-0.5 rounded text-xs font-medium ${
                              char.referenceOutfit?.setting === 'outdoor-cold' ? 'bg-blue-100 text-blue-800' :
                              char.referenceOutfit?.setting === 'outdoor-warm' ? 'bg-yellow-100 text-yellow-800' :
                              char.referenceOutfit?.setting === 'indoor-casual' ? 'bg-green-100 text-green-800' :
                              char.referenceOutfit?.setting === 'indoor-formal' ? 'bg-purple-100 text-purple-800' :
                              char.referenceOutfit?.setting === 'active' ? 'bg-orange-100 text-orange-800' :
                              char.referenceOutfit?.setting === 'sleep' ? 'bg-indigo-100 text-indigo-800' :
                              'bg-gray-100 text-gray-800'
                            }`}>
                              {char.referenceOutfit?.setting || 'neutral'}
                            </span>
                            {Object.keys(char.generatedOutfits || {}).length > 0 && (
                              <span className="ml-1 px-1.5 py-0.5 bg-green-100 text-green-700 rounded text-xs">
                                {Object.keys(char.generatedOutfits).length} {language === 'de' ? 'Outfits' : language === 'fr' ? 'tenues' : 'outfits'}
                              </span>
                            )}
                          </summary>
                          <div className="mt-2 space-y-2">
                            {/* Physical Features */}
                            <div className="text-xs">
                              <span className="font-medium text-gray-600">Physical:</span>
                              <span className="text-gray-700 ml-1">
                                {char.physical?.face || 'Not analyzed'} | {char.physical?.hair || 'N/A'} | {char.physical?.build || 'N/A'}
                              </span>
                            </div>
                            {/* Style DNA */}
                            {char.styleDNA && (
                              <div className="text-xs">
                                <span className="font-medium text-gray-600">Style DNA:</span>
                                {char.styleDNA.aesthetic && (
                                  <span className="text-gray-700 italic ml-1">{char.styleDNA.aesthetic}</span>
                                )}
                                {char.styleDNA.signatureColors && char.styleDNA.signatureColors.length > 0 && (
                                  <span className="text-gray-700 ml-1">| Colors: {char.styleDNA.signatureColors.slice(0, 3).join(', ')}</span>
                                )}
                              </div>
                            )}
                            {/* Reference Outfit */}
                            {char.referenceOutfit && (
                              <div className="text-xs">
                                <span className="font-medium text-gray-600">Reference:</span>
                                <span className="text-gray-700 ml-1">
                                  {char.referenceOutfit.garmentType} in {char.referenceOutfit.primaryColor}
                                  {char.referenceOutfit.pattern && char.referenceOutfit.pattern !== 'solid' && char.referenceOutfit.pattern !== 'none' && ` (${char.referenceOutfit.pattern})`}
                                </span>
                              </div>
                            )}
                            {/* Generated Outfits */}
                            {char.generatedOutfits && Object.keys(char.generatedOutfits).length > 0 && (
                              <div className="mt-2 pt-2 border-t border-purple-200">
                                <span className="font-medium text-gray-600 text-xs">Generated Outfits:</span>
                                <div className="mt-1 space-y-1">
                                  {Object.entries(char.generatedOutfits).map(([pageNum, outfit]) => (
                                    <div key={pageNum} className="bg-white p-1.5 rounded text-xs">
                                      <span className="font-medium text-purple-600">Page {pageNum}:</span>
                                      <span className="text-gray-700 ml-1">{outfit.outfit?.substring(0, 80)}...</span>
                                      <span className={`ml-1 px-1 py-0.5 rounded text-[10px] ${
                                        outfit.setting === 'outdoor-cold' ? 'bg-blue-100 text-blue-700' :
                                        outfit.setting === 'outdoor-warm' ? 'bg-yellow-100 text-yellow-700' :
                                        'bg-gray-100 text-gray-600'
                                      }`}>
                                        {outfit.setting}
                                      </span>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
                        </details>
                      ))}
                    </div>
                  </div>
                )}

                {/* Secondary Characters */}
                {visualBible.secondaryCharacters && visualBible.secondaryCharacters.length > 0 && (
                  <div className="bg-white border border-rose-200 rounded-lg p-3">
                    <h4 className="text-sm font-bold text-rose-700 mb-2">
                      {language === 'de' ? 'Nebencharaktere' : language === 'fr' ? 'Personnages Secondaires' : 'Secondary Characters'}
                    </h4>
                    <div className="space-y-2">
                      {visualBible.secondaryCharacters.map((entry) => (
                        <div key={entry.id} className="bg-rose-50 p-2 rounded text-sm">
                          <div className="font-semibold text-rose-800">{entry.name} <span className="text-xs text-rose-600">(Pages: {entry.appearsInPages.join(', ')})</span></div>
                          <div className="text-gray-700 text-xs mt-1">{entry.description}</div>
                          {entry.extractedDescription && (
                            <div className="text-green-700 text-xs mt-1 bg-green-50 p-1 rounded">
                              <span className="font-semibold">Extracted:</span> {entry.extractedDescription}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Animals & Creatures */}
                {visualBible.animals.length > 0 && (
                  <div className="bg-white border border-rose-200 rounded-lg p-3">
                    <h4 className="text-sm font-bold text-rose-700 mb-2">
                      {language === 'de' ? 'Tiere & Wesen' : language === 'fr' ? 'Animaux & Créatures' : 'Animals & Creatures'}
                    </h4>
                    <div className="space-y-2">
                      {visualBible.animals.map((entry) => (
                        <div key={entry.id} className="bg-rose-50 p-2 rounded text-sm">
                          <div className="font-semibold text-rose-800">{entry.name} <span className="text-xs text-rose-600">(Pages: {entry.appearsInPages.join(', ')})</span></div>
                          <div className="text-gray-700 text-xs mt-1">{entry.description}</div>
                          {entry.extractedDescription && (
                            <div className="text-green-700 text-xs mt-1 bg-green-50 p-1 rounded">
                              <span className="font-semibold">Extracted:</span> {entry.extractedDescription}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Artifacts */}
                {visualBible.artifacts.length > 0 && (
                  <div className="bg-white border border-rose-200 rounded-lg p-3">
                    <h4 className="text-sm font-bold text-rose-700 mb-2">
                      {language === 'de' ? 'Artefakte & Objekte' : language === 'fr' ? 'Artefacts & Objets' : 'Artifacts & Objects'}
                    </h4>
                    <div className="space-y-2">
                      {visualBible.artifacts.map((entry) => (
                        <div key={entry.id} className="bg-rose-50 p-2 rounded text-sm">
                          <div className="font-semibold text-rose-800">{entry.name} <span className="text-xs text-rose-600">(Pages: {entry.appearsInPages.join(', ')})</span></div>
                          <div className="text-gray-700 text-xs mt-1">{entry.description}</div>
                          {entry.extractedDescription && (
                            <div className="text-green-700 text-xs mt-1 bg-green-50 p-1 rounded">
                              <span className="font-semibold">Extracted:</span> {entry.extractedDescription}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Locations */}
                {visualBible.locations.length > 0 && (
                  <div className="bg-white border border-rose-200 rounded-lg p-3">
                    <h4 className="text-sm font-bold text-rose-700 mb-2">
                      {language === 'de' ? 'Wiederkehrende Orte' : language === 'fr' ? 'Lieux Récurrents' : 'Recurring Locations'}
                    </h4>
                    <div className="space-y-2">
                      {visualBible.locations.map((entry) => (
                        <div key={entry.id} className="bg-rose-50 p-2 rounded text-sm">
                          <div className="font-semibold text-rose-800">{entry.name} <span className="text-xs text-rose-600">(Pages: {entry.appearsInPages.join(', ')})</span></div>
                          <div className="text-gray-700 text-xs mt-1">{entry.description}</div>
                          {entry.extractedDescription && (
                            <div className="text-green-700 text-xs mt-1 bg-green-50 p-1 rounded">
                              <span className="font-semibold">Extracted:</span> {entry.extractedDescription}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Change Log */}
                {visualBible.changeLog && visualBible.changeLog.length > 0 && (
                  <details className="bg-white border border-amber-300 rounded-lg p-3">
                    <summary className="cursor-pointer text-sm font-bold text-amber-700 hover:text-amber-800 flex items-center gap-2">
                      <span className="text-lg">📝</span>
                      {language === 'de' ? 'Änderungsprotokoll' : language === 'fr' ? 'Journal des Modifications' : 'Change Log'}
                      <span className="ml-1 px-1.5 py-0.5 bg-amber-100 text-amber-700 rounded text-xs">
                        {visualBible.changeLog.length}
                      </span>
                    </summary>
                    <div className="mt-2 space-y-1 max-h-64 overflow-y-auto">
                      {visualBible.changeLog.slice().reverse().map((entry, idx) => (
                        <div key={idx} className="bg-amber-50 p-2 rounded text-xs border-l-2 border-amber-400">
                          <div className="flex items-center gap-2">
                            <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                              entry.type === 'mainCharacter' ? 'bg-purple-100 text-purple-700' :
                              entry.type === 'secondaryCharacter' ? 'bg-rose-100 text-rose-700' :
                              entry.type === 'generatedOutfit' ? 'bg-green-100 text-green-700' :
                              entry.type === 'animal' ? 'bg-orange-100 text-orange-700' :
                              entry.type === 'artifact' ? 'bg-blue-100 text-blue-700' :
                              'bg-gray-100 text-gray-700'
                            }`}>
                              {entry.type}
                            </span>
                            <span className="font-semibold text-amber-800">{entry.element}</span>
                            <span className="text-gray-500">
                              {language === 'de' ? 'Seite' : language === 'fr' ? 'Page' : 'Page'} {entry.page}
                            </span>
                          </div>
                          <div className="mt-1 text-gray-600">
                            <span className="font-medium">{entry.change}:</span>
                            <span className="ml-1 text-gray-700">{entry.after?.substring(0, 100)}{entry.after && entry.after.length > 100 ? '...' : ''}</span>
                          </div>
                          {entry.before && (
                            <div className="text-gray-400 line-through text-[10px] mt-0.5">
                              {language === 'de' ? 'Vorher' : language === 'fr' ? 'Avant' : 'Before'}: {entry.before.substring(0, 50)}...
                            </div>
                          )}
                          <div className="text-gray-400 text-[10px] mt-0.5">
                            {new Date(entry.timestamp).toLocaleTimeString()}
                          </div>
                        </div>
                      ))}
                    </div>
                  </details>
                )}

                {/* Empty state message */}
                {(!visualBible.mainCharacters || visualBible.mainCharacters.length === 0) &&
                 (!visualBible.secondaryCharacters || visualBible.secondaryCharacters.length === 0) &&
                 (!visualBible.animals || visualBible.animals.length === 0) &&
                 (!visualBible.artifacts || visualBible.artifacts.length === 0) &&
                 (!visualBible.locations || visualBible.locations.length === 0) && (
                  <div className="text-gray-500 text-sm italic">
                    {language === 'de' ? 'Keine wiederkehrenden Elemente gefunden' : language === 'fr' ? 'Aucun élément récurrent trouvé' : 'No recurring elements found in this story'}
                  </div>
                )}
              </div>
            </details>
          )}
        </div>
      )}

      {/* Cover Images Display */}
      {coverImages && (getCoverImageData(coverImages.frontCover) || getCoverImageData(coverImages.initialPage) || getCoverImageData(coverImages.backCover)) && (
        <div className="bg-indigo-50 border-2 border-indigo-200 rounded-xl p-6 mt-6">
          <h3 className="text-xl font-bold text-gray-800 mb-4 flex items-center gap-2">
            <BookOpen size={24} /> {language === 'de' ? 'Buchcover' : language === 'fr' ? 'Couvertures' : 'Book Covers'}
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {/* Front Cover */}
            {getCoverImageData(coverImages.frontCover) && (() => {
              const coverObj = getCoverImageObject(coverImages.frontCover);
              return (
                <div className="bg-white border-2 border-indigo-300 rounded-lg p-4 shadow-lg">
                  <h4 className="text-lg font-bold text-gray-800 mb-3">
                    {language === 'de' ? 'Titelseite' : language === 'fr' ? 'Couverture' : 'Front Cover'}
                  </h4>
                  <img
                    src={getCoverImageData(coverImages.frontCover)!}
                    alt="Front Cover"
                    className="w-full rounded-lg shadow-md"
                  />
                  {developerMode && (
                    <div className="mt-3 space-y-2">
                      <div className="flex gap-2">
                        {onRegenerateCover && (
                          <button onClick={() => onRegenerateCover('front')} disabled={isGenerating}
                            className={`flex-1 bg-indigo-500 text-white px-3 py-2 rounded-lg flex items-center justify-center gap-2 text-sm font-semibold ${isGenerating ? 'opacity-50 cursor-not-allowed' : 'hover:bg-indigo-600'}`}>
                            <RefreshCw size={14} /> {language === 'de' ? 'Neu' : 'Regen'}
                          </button>
                        )}
                        {onEditCover && (
                          <button onClick={() => onEditCover('front')} disabled={isGenerating}
                            className={`flex-1 bg-gray-500 text-white px-3 py-2 rounded-lg flex items-center justify-center gap-2 text-sm font-semibold ${isGenerating ? 'opacity-50 cursor-not-allowed' : 'hover:bg-gray-600'}`}>
                            <Edit3 size={14} /> {language === 'de' ? 'Bearbeiten' : 'Edit'}
                          </button>
                        )}
                      </div>
                      {coverObj?.description && (
                        <details className="bg-green-50 border border-green-300 rounded-lg p-3">
                          <summary className="cursor-pointer text-sm font-semibold text-green-800">{language === 'de' ? 'Szenenbeschreibung' : 'Scene Description'}</summary>
                          <pre className="mt-2 text-xs text-gray-700 whitespace-pre-wrap font-mono bg-white p-3 rounded border overflow-x-auto">{coverObj.description}</pre>
                        </details>
                      )}
                      {coverObj?.prompt && (
                        <details className="bg-blue-50 border border-blue-300 rounded-lg p-3">
                          <summary className="cursor-pointer text-sm font-semibold text-blue-800">{language === 'de' ? 'API-Prompt' : 'API Prompt'}</summary>
                          <pre className="mt-2 text-xs text-gray-700 whitespace-pre-wrap font-mono bg-white p-3 rounded border overflow-x-auto max-h-48 overflow-y-auto">{coverObj.prompt}</pre>
                        </details>
                      )}
                      {coverObj?.qualityScore !== undefined && (
                        <details className="bg-indigo-50 border border-indigo-300 rounded-lg p-3">
                          <summary className="cursor-pointer text-sm font-semibold text-indigo-700 flex items-center justify-between">
                            <span>{language === 'de' ? 'Qualität' : 'Quality'}</span>
                            <span className={`text-lg font-bold ${coverObj.qualityScore >= 70 ? 'text-green-600' : coverObj.qualityScore >= 50 ? 'text-yellow-600' : 'text-red-600'}`}>
                              {Math.round(coverObj.qualityScore)}%
                            </span>
                          </summary>
                          {coverObj.qualityReasoning && <div className="mt-2 text-xs bg-white p-3 rounded border"><p className="whitespace-pre-wrap">{coverObj.qualityReasoning}</p></div>}
                        </details>
                      )}
                      {coverObj?.retryHistory && coverObj.retryHistory.length > 0 && (
                        <RetryHistoryDisplay
                          retryHistory={coverObj.retryHistory}
                          totalAttempts={coverObj.totalAttempts || coverObj.retryHistory.length}
                          language={language}
                        />
                      )}
                    </div>
                  )}
                </div>
              );
            })()}

            {/* Initial Page */}
            {getCoverImageData(coverImages.initialPage) && (() => {
              const coverObj = getCoverImageObject(coverImages.initialPage);
              return (
                <div className="bg-white border-2 border-indigo-300 rounded-lg p-4 shadow-lg">
                  <h4 className="text-lg font-bold text-gray-800 mb-3">
                    {language === 'de' ? 'Einleitungsseite' : language === 'fr' ? 'Page d\'introduction' : 'Initial Page'}
                  </h4>
                  <img
                    src={getCoverImageData(coverImages.initialPage)!}
                    alt="Initial Page"
                    className="w-full rounded-lg shadow-md"
                  />
                  {developerMode && (
                    <div className="mt-3 space-y-2">
                      <div className="flex gap-2">
                        {onRegenerateCover && (
                          <button onClick={() => onRegenerateCover('initial')} disabled={isGenerating}
                            className={`flex-1 bg-indigo-500 text-white px-3 py-2 rounded-lg flex items-center justify-center gap-2 text-sm font-semibold ${isGenerating ? 'opacity-50 cursor-not-allowed' : 'hover:bg-indigo-600'}`}>
                            <RefreshCw size={14} /> {language === 'de' ? 'Neu' : 'Regen'}
                          </button>
                        )}
                        {onEditCover && (
                          <button onClick={() => onEditCover('initial')} disabled={isGenerating}
                            className={`flex-1 bg-gray-500 text-white px-3 py-2 rounded-lg flex items-center justify-center gap-2 text-sm font-semibold ${isGenerating ? 'opacity-50 cursor-not-allowed' : 'hover:bg-gray-600'}`}>
                            <Edit3 size={14} /> {language === 'de' ? 'Bearbeiten' : 'Edit'}
                          </button>
                        )}
                      </div>
                      {coverObj?.description && (
                        <details className="bg-green-50 border border-green-300 rounded-lg p-3">
                          <summary className="cursor-pointer text-sm font-semibold text-green-800">{language === 'de' ? 'Szenenbeschreibung' : 'Scene Description'}</summary>
                          <pre className="mt-2 text-xs text-gray-700 whitespace-pre-wrap font-mono bg-white p-3 rounded border overflow-x-auto">{coverObj.description}</pre>
                        </details>
                      )}
                      {coverObj?.prompt && (
                        <details className="bg-blue-50 border border-blue-300 rounded-lg p-3">
                          <summary className="cursor-pointer text-sm font-semibold text-blue-800">{language === 'de' ? 'API-Prompt' : 'API Prompt'}</summary>
                          <pre className="mt-2 text-xs text-gray-700 whitespace-pre-wrap font-mono bg-white p-3 rounded border overflow-x-auto max-h-48 overflow-y-auto">{coverObj.prompt}</pre>
                        </details>
                      )}
                      {coverObj?.qualityScore !== undefined && (
                        <details className="bg-indigo-50 border border-indigo-300 rounded-lg p-3">
                          <summary className="cursor-pointer text-sm font-semibold text-indigo-700 flex items-center justify-between">
                            <span>{language === 'de' ? 'Qualität' : 'Quality'}</span>
                            <span className={`text-lg font-bold ${coverObj.qualityScore >= 70 ? 'text-green-600' : coverObj.qualityScore >= 50 ? 'text-yellow-600' : 'text-red-600'}`}>
                              {Math.round(coverObj.qualityScore)}%
                            </span>
                          </summary>
                          {coverObj.qualityReasoning && <div className="mt-2 text-xs bg-white p-3 rounded border"><p className="whitespace-pre-wrap">{coverObj.qualityReasoning}</p></div>}
                        </details>
                      )}
                      {coverObj?.retryHistory && coverObj.retryHistory.length > 0 && (
                        <RetryHistoryDisplay
                          retryHistory={coverObj.retryHistory}
                          totalAttempts={coverObj.totalAttempts || coverObj.retryHistory.length}
                          language={language}
                        />
                      )}
                    </div>
                  )}
                </div>
              );
            })()}

            {/* Back Cover */}
            {getCoverImageData(coverImages.backCover) && (() => {
              const coverObj = getCoverImageObject(coverImages.backCover);
              return (
                <div className="bg-white border-2 border-indigo-300 rounded-lg p-4 shadow-lg">
                  <h4 className="text-lg font-bold text-gray-800 mb-3">
                    {language === 'de' ? 'Rückseite' : language === 'fr' ? 'Quatrième de couverture' : 'Back Cover'}
                  </h4>
                  <img
                    src={getCoverImageData(coverImages.backCover)!}
                    alt="Back Cover"
                    className="w-full rounded-lg shadow-md"
                  />
                  {developerMode && (
                    <div className="mt-3 space-y-2">
                      <div className="flex gap-2">
                        {onRegenerateCover && (
                          <button onClick={() => onRegenerateCover('back')} disabled={isGenerating}
                            className={`flex-1 bg-indigo-500 text-white px-3 py-2 rounded-lg flex items-center justify-center gap-2 text-sm font-semibold ${isGenerating ? 'opacity-50 cursor-not-allowed' : 'hover:bg-indigo-600'}`}>
                            <RefreshCw size={14} /> {language === 'de' ? 'Neu' : 'Regen'}
                          </button>
                        )}
                        {onEditCover && (
                          <button onClick={() => onEditCover('back')} disabled={isGenerating}
                            className={`flex-1 bg-gray-500 text-white px-3 py-2 rounded-lg flex items-center justify-center gap-2 text-sm font-semibold ${isGenerating ? 'opacity-50 cursor-not-allowed' : 'hover:bg-gray-600'}`}>
                            <Edit3 size={14} /> {language === 'de' ? 'Bearbeiten' : 'Edit'}
                          </button>
                        )}
                      </div>
                      {coverObj?.description && (
                        <details className="bg-green-50 border border-green-300 rounded-lg p-3">
                          <summary className="cursor-pointer text-sm font-semibold text-green-800">{language === 'de' ? 'Szenenbeschreibung' : 'Scene Description'}</summary>
                          <pre className="mt-2 text-xs text-gray-700 whitespace-pre-wrap font-mono bg-white p-3 rounded border overflow-x-auto">{coverObj.description}</pre>
                        </details>
                      )}
                      {coverObj?.prompt && (
                        <details className="bg-blue-50 border border-blue-300 rounded-lg p-3">
                          <summary className="cursor-pointer text-sm font-semibold text-blue-800">{language === 'de' ? 'API-Prompt' : 'API Prompt'}</summary>
                          <pre className="mt-2 text-xs text-gray-700 whitespace-pre-wrap font-mono bg-white p-3 rounded border overflow-x-auto max-h-48 overflow-y-auto">{coverObj.prompt}</pre>
                        </details>
                      )}
                      {coverObj?.qualityScore !== undefined && (
                        <details className="bg-indigo-50 border border-indigo-300 rounded-lg p-3">
                          <summary className="cursor-pointer text-sm font-semibold text-indigo-700 flex items-center justify-between">
                            <span>{language === 'de' ? 'Qualität' : 'Quality'}</span>
                            <span className={`text-lg font-bold ${coverObj.qualityScore >= 70 ? 'text-green-600' : coverObj.qualityScore >= 50 ? 'text-yellow-600' : 'text-red-600'}`}>
                              {Math.round(coverObj.qualityScore)}%
                            </span>
                          </summary>
                          {coverObj.qualityReasoning && <div className="mt-2 text-xs bg-white p-3 rounded border"><p className="whitespace-pre-wrap">{coverObj.qualityReasoning}</p></div>}
                        </details>
                      )}
                      {coverObj?.retryHistory && coverObj.retryHistory.length > 0 && (
                        <RetryHistoryDisplay
                          retryHistory={coverObj.retryHistory}
                          totalAttempts={coverObj.totalAttempts || coverObj.retryHistory.length}
                          language={language}
                        />
                      )}
                    </div>
                  )}
                </div>
              );
            })()}
          </div>
        </div>
      )}

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
                        {/* Developer Mode Features */}
                        {developerMode && (
                          <div className="mt-3 space-y-2">
                            {/* Action Buttons */}
                            <div className="flex gap-2">
                              {onRegenerateImage && (
                                <button
                                  onClick={() => onRegenerateImage(pageNumber)}
                                  disabled={isGenerating}
                                  className={`flex-1 bg-indigo-500 text-white px-3 py-2 rounded-lg flex items-center justify-center gap-2 text-sm font-semibold ${
                                    isGenerating ? 'opacity-50 cursor-not-allowed' : 'hover:bg-indigo-600'
                                  }`}
                                >
                                  <RefreshCw size={14} /> {language === 'de' ? 'Neu generieren' : 'Regenerate'}
                                </button>
                              )}
                              {onEditImage && (
                                <button
                                  onClick={() => onEditImage(pageNumber)}
                                  disabled={isGenerating}
                                  className={`flex-1 bg-gray-500 text-white px-3 py-2 rounded-lg flex items-center justify-center gap-2 text-sm font-semibold ${
                                    isGenerating ? 'opacity-50 cursor-not-allowed' : 'hover:bg-gray-600'
                                  }`}
                                >
                                  <Edit3 size={14} /> {language === 'de' ? 'Bearbeiten' : 'Edit'}
                                </button>
                              )}
                            </div>

                            {/* Scene Description */}
                            {getSceneDescription(pageNumber) && (
                              <details className="bg-green-50 border border-green-300 rounded-lg p-3">
                                <summary className="cursor-pointer text-sm font-semibold text-green-800 hover:text-green-900">
                                  {language === 'de' ? 'Szenenbeschreibung' : language === 'fr' ? 'Description de scène' : 'Scene Description'}
                                </summary>
                                <pre className="mt-2 text-xs text-gray-700 whitespace-pre-wrap font-mono bg-white p-3 rounded border border-gray-200 overflow-x-auto">
                                  {getSceneDescription(pageNumber)}
                                </pre>
                              </details>
                            )}

                            {/* API Prompt */}
                            {image.prompt && (
                              <details className="bg-blue-50 border border-blue-300 rounded-lg p-3">
                                <summary className="cursor-pointer text-sm font-semibold text-blue-800 hover:text-blue-900">
                                  {language === 'de' ? 'API-Prompt' : language === 'fr' ? 'Prompt API' : 'API Prompt'}
                                </summary>
                                <pre className="mt-2 text-xs text-gray-700 whitespace-pre-wrap font-mono bg-white p-3 rounded border border-gray-200 overflow-x-auto max-h-48 overflow-y-auto">
                                  {image.prompt}
                                </pre>
                              </details>
                            )}

                            {/* Quality Score with Reasoning */}
                            {image.qualityScore !== undefined && (
                              <details className="bg-indigo-50 border border-indigo-300 rounded-lg p-3">
                                <summary className="cursor-pointer text-sm font-semibold text-indigo-700 hover:text-indigo-900 flex items-center justify-between">
                                  <span>{language === 'de' ? 'Qualitätsbewertung' : language === 'fr' ? 'Score de qualité' : 'Quality Score'}</span>
                                  <span className={`text-lg font-bold ${
                                    image.qualityScore >= 70 ? 'text-green-600' :
                                    image.qualityScore >= 50 ? 'text-yellow-600' :
                                    'text-red-600'
                                  }`}>
                                    {Math.round(image.qualityScore)}%
                                  </span>
                                </summary>
                                {image.qualityReasoning && (
                                  <div className="mt-2 text-xs text-gray-800 bg-white p-3 rounded border border-gray-200">
                                    <div className="font-semibold mb-1">{language === 'de' ? 'Feedback:' : language === 'fr' ? 'Retour:' : 'Feedback:'}</div>
                                    <p className="whitespace-pre-wrap">{image.qualityReasoning}</p>
                                  </div>
                                )}
                              </details>
                            )}

                            {/* Retry History (shows all attempts with images) */}
                            {image.retryHistory && image.retryHistory.length > 0 && (
                              <RetryHistoryDisplay
                                retryHistory={image.retryHistory}
                                totalAttempts={image.totalAttempts || image.retryHistory.length}
                                language={language}
                              />
                            )}

                            {/* Regeneration Info (fallback for older data without retryHistory) */}
                            {image.wasRegenerated && (!image.retryHistory || image.retryHistory.length === 0) && (
                              <details className="bg-orange-50 border border-orange-300 rounded-lg p-3">
                                <summary className="cursor-pointer text-sm font-semibold text-orange-700 flex items-center justify-between">
                                  <span>🔄 {language === 'de' ? 'Bild regeneriert' : language === 'fr' ? 'Image régénérée' : 'Image Regenerated'}</span>
                                  {image.originalScore !== undefined && (
                                    <span className="text-red-600">Original: {Math.round(image.originalScore)}%</span>
                                  )}
                                </summary>
                                <div className="mt-2">
                                  <p className="text-xs text-gray-600 mb-2">
                                    {language === 'de' ? 'Das Bild wurde automatisch regeneriert, da die erste Version eine niedrige Qualität hatte.' :
                                     language === 'fr' ? "L'image a été automatiquement régénérée car la première version avait une qualité faible." :
                                     'Image was automatically regenerated because the first version had low quality.'}
                                  </p>
                                  {image.originalImage && (
                                    <div className="mt-2">
                                      <p className="text-xs font-semibold text-gray-700 mb-1">
                                        {language === 'de' ? 'Originalbild:' : language === 'fr' ? 'Image originale:' : 'Original Image:'}
                                      </p>
                                      <img
                                        src={image.originalImage}
                                        alt="Original (lower quality)"
                                        className="w-full rounded border-2 border-orange-200 opacity-75"
                                      />
                                      {image.originalReasoning && (
                                        <div className="mt-2 text-xs text-gray-600 bg-white p-2 rounded border">
                                          <div className="font-semibold mb-1">{language === 'de' ? 'Original Feedback:' : language === 'fr' ? 'Retour original:' : 'Original Feedback:'}</div>
                                          <p className="whitespace-pre-wrap">{image.originalReasoning}</p>
                                        </div>
                                      )}
                                    </div>
                                  )}
                                </div>
                              </details>
                            )}
                          </div>
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
                      <p className="text-gray-800 leading-snug whitespace-pre-wrap font-serif text-xl text-center">
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
                        {/* Developer Mode Features */}
                        {developerMode && (
                          <div className="mt-3 space-y-2">
                            {/* Action Buttons */}
                            <div className="flex gap-2">
                              {onRegenerateImage && (
                                <button
                                  onClick={() => onRegenerateImage(pageNumber)}
                                  disabled={isGenerating}
                                  className={`flex-1 bg-indigo-500 text-white px-3 py-2 rounded-lg flex items-center justify-center gap-2 text-sm font-semibold ${
                                    isGenerating ? 'opacity-50 cursor-not-allowed' : 'hover:bg-indigo-600'
                                  }`}
                                >
                                  <RefreshCw size={14} /> {language === 'de' ? 'Neu generieren' : 'Regenerate'}
                                </button>
                              )}
                              {onEditImage && (
                                <button
                                  onClick={() => onEditImage(pageNumber)}
                                  disabled={isGenerating}
                                  className={`flex-1 bg-gray-500 text-white px-3 py-2 rounded-lg flex items-center justify-center gap-2 text-sm font-semibold ${
                                    isGenerating ? 'opacity-50 cursor-not-allowed' : 'hover:bg-gray-600'
                                  }`}
                                >
                                  <Edit3 size={14} /> {language === 'de' ? 'Bearbeiten' : 'Edit'}
                                </button>
                              )}
                            </div>

                            {/* Scene Description */}
                            {getSceneDescription(pageNumber) && (
                              <details className="bg-green-50 border border-green-300 rounded-lg p-3">
                                <summary className="cursor-pointer text-sm font-semibold text-green-800 hover:text-green-900">
                                  {language === 'de' ? 'Szenenbeschreibung' : language === 'fr' ? 'Description de scène' : 'Scene Description'}
                                </summary>
                                <pre className="mt-2 text-xs text-gray-700 whitespace-pre-wrap font-mono bg-white p-3 rounded border border-gray-200 overflow-x-auto">
                                  {getSceneDescription(pageNumber)}
                                </pre>
                              </details>
                            )}

                            {/* API Prompt */}
                            {image.prompt && (
                              <details className="bg-blue-50 border border-blue-300 rounded-lg p-3">
                                <summary className="cursor-pointer text-sm font-semibold text-blue-800 hover:text-blue-900">
                                  {language === 'de' ? 'API-Prompt' : language === 'fr' ? 'Prompt API' : 'API Prompt'}
                                </summary>
                                <pre className="mt-2 text-xs text-gray-700 whitespace-pre-wrap font-mono bg-white p-3 rounded border border-gray-200 overflow-x-auto max-h-48 overflow-y-auto">
                                  {image.prompt}
                                </pre>
                              </details>
                            )}

                            {/* Quality Score with Reasoning */}
                            {image.qualityScore !== undefined && (
                              <details className="bg-indigo-50 border border-indigo-300 rounded-lg p-3">
                                <summary className="cursor-pointer text-sm font-semibold text-indigo-700 hover:text-indigo-900 flex items-center justify-between">
                                  <span>{language === 'de' ? 'Qualitätsbewertung' : language === 'fr' ? 'Score de qualité' : 'Quality Score'}</span>
                                  <span className={`text-lg font-bold ${
                                    image.qualityScore >= 70 ? 'text-green-600' :
                                    image.qualityScore >= 50 ? 'text-yellow-600' :
                                    'text-red-600'
                                  }`}>
                                    {Math.round(image.qualityScore)}%
                                  </span>
                                </summary>
                                {image.qualityReasoning && (
                                  <div className="mt-2 text-xs text-gray-800 bg-white p-3 rounded border border-gray-200">
                                    <div className="font-semibold mb-1">{language === 'de' ? 'Feedback:' : language === 'fr' ? 'Retour:' : 'Feedback:'}</div>
                                    <p className="whitespace-pre-wrap">{image.qualityReasoning}</p>
                                  </div>
                                )}
                              </details>
                            )}

                            {/* Retry History (shows all attempts with images) */}
                            {image.retryHistory && image.retryHistory.length > 0 && (
                              <RetryHistoryDisplay
                                retryHistory={image.retryHistory}
                                totalAttempts={image.totalAttempts || image.retryHistory.length}
                                language={language}
                              />
                            )}

                            {/* Regeneration Info (fallback for older data without retryHistory) */}
                            {image.wasRegenerated && (!image.retryHistory || image.retryHistory.length === 0) && (
                              <details className="bg-orange-50 border border-orange-300 rounded-lg p-3">
                                <summary className="cursor-pointer text-sm font-semibold text-orange-700 flex items-center justify-between">
                                  <span>🔄 {language === 'de' ? 'Bild regeneriert' : language === 'fr' ? 'Image régénérée' : 'Image Regenerated'}</span>
                                  {image.originalScore !== undefined && (
                                    <span className="text-red-600">Original: {Math.round(image.originalScore)}%</span>
                                  )}
                                </summary>
                                <div className="mt-2">
                                  <p className="text-xs text-gray-600 mb-2">
                                    {language === 'de' ? 'Das Bild wurde automatisch regeneriert, da die erste Version eine niedrige Qualität hatte.' :
                                     language === 'fr' ? "L'image a été automatiquement régénérée car la première version avait une qualité faible." :
                                     'Image was automatically regenerated because the first version had low quality.'}
                                  </p>
                                  {image.originalImage && (
                                    <div className="mt-2">
                                      <p className="text-xs font-semibold text-gray-700 mb-1">
                                        {language === 'de' ? 'Originalbild:' : language === 'fr' ? 'Image originale:' : 'Original Image:'}
                                      </p>
                                      <img
                                        src={image.originalImage}
                                        alt="Original (lower quality)"
                                        className="w-full rounded border-2 border-orange-200 opacity-75"
                                      />
                                      {image.originalReasoning && (
                                        <div className="mt-2 text-xs text-gray-600 bg-white p-2 rounded border">
                                          <div className="font-semibold mb-1">{language === 'de' ? 'Original Feedback:' : language === 'fr' ? 'Retour original:' : 'Original Feedback:'}</div>
                                          <p className="whitespace-pre-wrap">{image.originalReasoning}</p>
                                        </div>
                                      )}
                                    </div>
                                  )}
                                </div>
                              </details>
                            )}
                          </div>
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
                        <p className="text-gray-800 leading-snug whitespace-pre-wrap font-serif text-xl">
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
