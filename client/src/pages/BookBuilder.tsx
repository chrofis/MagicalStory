import { useState, useEffect, useMemo } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { ArrowLeft, ArrowUp, ArrowDown, Book, BookOpen, ShoppingCart, AlertTriangle, Info, Printer } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import { useAuth } from '@/context/AuthContext';
import { Navigation, LoadingSpinner } from '@/components/common';
import { storyService } from '@/services';
import { getPriceForPages, MAX_BOOK_PAGES } from './Pricing';
import { createLogger } from '@/services/logger';

const log = createLogger('BookBuilder');

interface SelectedStory {
  id: string;
  title: string;
  pages: number;
  thumbnail?: string;
}

export default function BookBuilder() {
  const navigate = useNavigate();
  const location = useLocation();
  const { language } = useLanguage();
  const { isAuthenticated, user } = useAuth();
  const isAdmin = user?.role === 'admin';

  const [stories, setStories] = useState<SelectedStory[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [coverType, setCoverType] = useState<'softcover' | 'hardcover'>('softcover');
  const [isCheckingOut, setIsCheckingOut] = useState(false);
  const [isPrintingPdf, setIsPrintingPdf] = useState(false);

  const translations = {
    en: {
      title: 'Create Your Book',
      subtitle: 'Arrange your stories and choose your cover type',
      noStories: 'No stories selected',
      noStoriesDesc: 'Please go back and select stories to combine.',
      backToStories: 'Back to My Stories',
      storyOrder: 'Story Order',
      storyOrderHint: 'Drag stories to reorder. The first story\'s cover will be used as the book cover.',
      coverNote: 'The cover from the first story will be used as your book cover.',
      moveUp: 'Move up',
      moveDown: 'Move down',
      pages: 'pages',
      totalPages: 'Total Pages',
      chooseFormat: 'Choose Format',
      softcover: 'Softcover',
      hardcover: 'Hardcover',
      softcoverSize: '14 × 14 cm',
      hardcoverSize: '20 × 20 cm',
      price: 'Price',
      includesShipping: 'Includes shipping & taxes (Switzerland)',
      orderBook: 'Order Book',
      tooManyPages: 'Too many pages',
      tooManyPagesDesc: 'Maximum is 100 pages. Please remove some stories.',
      processing: 'Processing...',
      printPdf: 'Print PDF (Test)',
      generatingPdf: 'Generating PDF...',
    },
    de: {
      title: 'Dein Buch erstellen',
      subtitle: 'Ordne deine Geschichten an und wähle deinen Einband',
      noStories: 'Keine Geschichten ausgewählt',
      noStoriesDesc: 'Bitte geh zurück und wähle Geschichten zum Kombinieren aus.',
      backToStories: 'Zurück zu Meine Geschichten',
      storyOrder: 'Reihenfolge der Geschichten',
      storyOrderHint: 'Verschiebe Geschichten, um die Reihenfolge zu ändern. Das Cover der ersten Geschichte wird als Buchcover verwendet.',
      coverNote: 'Das Cover der ersten Geschichte wird als Buchcover verwendet.',
      moveUp: 'Nach oben',
      moveDown: 'Nach unten',
      pages: 'Seiten',
      totalPages: 'Seiten insgesamt',
      chooseFormat: 'Format wählen',
      softcover: 'Softcover',
      hardcover: 'Hardcover',
      softcoverSize: '14 × 14 cm',
      hardcoverSize: '20 × 20 cm',
      price: 'Preis',
      includesShipping: 'Inkl. Versand & Steuern (Schweiz)',
      orderBook: 'Buch bestellen',
      tooManyPages: 'Zu viele Seiten',
      tooManyPagesDesc: 'Maximal 100 Seiten erlaubt. Bitte entferne einige Geschichten.',
      processing: 'Wird verarbeitet...',
      printPdf: 'Druck-PDF (Test)',
      generatingPdf: 'PDF wird erstellt...',
    },
    fr: {
      title: 'Créer votre livre',
      subtitle: 'Arrangez vos histoires et choisissez votre type de couverture',
      noStories: 'Aucune histoire sélectionnée',
      noStoriesDesc: 'Veuillez retourner et sélectionner des histoires à combiner.',
      backToStories: 'Retour à Mes histoires',
      storyOrder: 'Ordre des histoires',
      storyOrderHint: 'Déplacez les histoires pour les réorganiser. La couverture de la première histoire sera utilisée comme couverture du livre.',
      coverNote: 'La couverture de la première histoire sera utilisée comme couverture du livre.',
      moveUp: 'Monter',
      moveDown: 'Descendre',
      pages: 'pages',
      totalPages: 'Pages totales',
      chooseFormat: 'Choisir le format',
      softcover: 'Couverture souple',
      hardcover: 'Couverture rigide',
      softcoverSize: '14 × 14 cm',
      hardcoverSize: '20 × 20 cm',
      price: 'Prix',
      includesShipping: 'Livraison & taxes incluses (Suisse)',
      orderBook: 'Commander le livre',
      tooManyPages: 'Trop de pages',
      tooManyPagesDesc: 'Maximum 100 pages. Veuillez retirer quelques histoires.',
      processing: 'Traitement en cours...',
      printPdf: 'PDF impression (Test)',
      generatingPdf: 'Génération du PDF...',
    },
  };

  const t = translations[language as keyof typeof translations] || translations.en;

  // Load stories from location state
  useEffect(() => {
    if (!isAuthenticated) {
      navigate('/');
      return;
    }

    const state = location.state as { selectedStories?: SelectedStory[] } | null;
    if (state?.selectedStories && state.selectedStories.length > 0) {
      setStories(state.selectedStories);
      setIsLoading(false);
    } else {
      // No stories in state, redirect back
      setIsLoading(false);
    }
  }, [isAuthenticated, navigate, location.state]);

  // Calculate total pages
  const totalPages = useMemo(() => {
    return stories.reduce((sum, story) => sum + story.pages, 0);
  }, [stories]);

  // Calculate price
  const price = useMemo(() => {
    return getPriceForPages(totalPages, coverType === 'hardcover');
  }, [totalPages, coverType]);

  const isOverLimit = totalPages > MAX_BOOK_PAGES;

  // Move story up/down
  const moveStory = (index: number, direction: 'up' | 'down') => {
    const newStories = [...stories];
    const newIndex = direction === 'up' ? index - 1 : index + 1;
    if (newIndex < 0 || newIndex >= stories.length) return;

    [newStories[index], newStories[newIndex]] = [newStories[newIndex], newStories[index]];
    setStories(newStories);
  };

  // Handle checkout
  const handleCheckout = async () => {
    if (isOverLimit || !price) return;

    setIsCheckingOut(true);
    try {
      log.info('Creating combined book checkout:', { storyIds: stories.map(s => s.id), coverType, totalPages });

      // TODO: Implement combined book checkout API
      // For now, we'll use the first story's checkout as a placeholder
      const { url } = await storyService.createCheckoutSession(stories[0].id);
      window.location.href = url;
    } catch (error) {
      log.error('Checkout failed:', error);
      alert(language === 'de'
        ? 'Checkout fehlgeschlagen. Bitte versuche es erneut.'
        : language === 'fr'
        ? 'Échec du paiement. Veuillez réessayer.'
        : 'Checkout failed. Please try again.');
    } finally {
      setIsCheckingOut(false);
    }
  };

  // Handle print PDF download (admin only) - uses same format as Gelato print
  const handlePrintPdf = async () => {
    if (stories.length === 0) return;

    setIsPrintingPdf(true);
    try {
      // Use the first story for now (TODO: implement combined stories PDF)
      const storyId = stories[0].id;
      log.debug('Downloading print PDF for story:', storyId);

      const token = localStorage.getItem('token');
      const response = await fetch(`/api/stories/${storyId}/print-pdf`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = response.headers.get('Content-Disposition')?.split('filename=')[1]?.replace(/"/g, '') || 'story-print.pdf';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);
    } catch (error) {
      log.error('Failed to download print PDF:', error);
      alert(language === 'de'
        ? 'PDF konnte nicht heruntergeladen werden.'
        : language === 'fr'
        ? 'Impossible de télécharger le PDF.'
        : 'Failed to download PDF.');
    } finally {
      setIsPrintingPdf(false);
    }
  };

  if (!isAuthenticated) {
    return <LoadingSpinner fullScreen />;
  }

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gray-50">
        <Navigation currentStep={0} />
        <LoadingSpinner message={language === 'de' ? 'Laden...' : language === 'fr' ? 'Chargement...' : 'Loading...'} />
      </div>
    );
  }

  // No stories selected
  if (stories.length === 0) {
    return (
      <div className="min-h-screen bg-gray-50">
        <Navigation currentStep={0} />
        <div className="px-4 md:px-8 py-8 max-w-4xl mx-auto">
          <div className="text-center py-12">
            <Book className="w-16 h-16 text-gray-300 mx-auto mb-4" />
            <h2 className="text-xl font-bold text-gray-800 mb-2">{t.noStories}</h2>
            <p className="text-gray-500 mb-6">{t.noStoriesDesc}</p>
            <button
              onClick={() => navigate('/stories')}
              className="px-6 py-3 bg-indigo-600 text-white rounded-lg font-semibold hover:bg-indigo-700"
            >
              {t.backToStories}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <Navigation currentStep={0} />

      <div className="px-4 md:px-8 py-8 max-w-4xl mx-auto">
        {/* Back button */}
        <button
          onClick={() => navigate('/stories')}
          className="flex items-center gap-2 text-gray-600 hover:text-indigo-600 mb-6 transition-colors"
        >
          <ArrowLeft size={20} />
          {t.backToStories}
        </button>

        {/* Header */}
        <div className="text-center mb-8">
          <h1 className="text-3xl md:text-4xl font-bold text-gray-800 mb-2">
            {t.title}
          </h1>
          <p className="text-gray-600">{t.subtitle}</p>
        </div>

        <div className="grid md:grid-cols-2 gap-8">
          {/* Left: Story Order */}
          <div>
            <h2 className="text-xl font-bold text-gray-800 mb-3">{t.storyOrder}</h2>

            {/* Cover note */}
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 mb-4 flex items-start gap-2">
              <Info size={18} className="text-amber-600 shrink-0 mt-0.5" />
              <p className="text-sm text-amber-800">{t.coverNote}</p>
            </div>

            {/* Story list */}
            <div className="space-y-3">
              {stories.map((story, index) => (
                <div
                  key={story.id}
                  className={`bg-white rounded-xl shadow-md p-4 flex items-center gap-4 ${
                    index === 0 ? 'ring-2 ring-indigo-400' : ''
                  }`}
                >
                  {/* Thumbnail */}
                  {story.thumbnail ? (
                    <img
                      src={story.thumbnail}
                      alt={story.title}
                      className="w-16 h-16 rounded-lg object-cover"
                    />
                  ) : (
                    <div className="w-16 h-16 rounded-lg bg-gradient-to-br from-indigo-100 to-purple-100 flex items-center justify-center">
                      <Book size={24} className="text-indigo-300" />
                    </div>
                  )}

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <h3 className="font-semibold text-gray-800 truncate">{story.title}</h3>
                    <p className="text-sm text-gray-500">{story.pages} {t.pages}</p>
                    {index === 0 && (
                      <span className="inline-block mt-1 px-2 py-0.5 bg-indigo-100 text-indigo-700 text-xs rounded-full font-medium">
                        Cover
                      </span>
                    )}
                  </div>

                  {/* Reorder buttons */}
                  <div className="flex flex-col gap-1">
                    <button
                      onClick={() => moveStory(index, 'up')}
                      disabled={index === 0}
                      className="p-1.5 rounded hover:bg-gray-100 disabled:opacity-30 disabled:cursor-not-allowed"
                      title={t.moveUp}
                    >
                      <ArrowUp size={18} className="text-gray-600" />
                    </button>
                    <button
                      onClick={() => moveStory(index, 'down')}
                      disabled={index === stories.length - 1}
                      className="p-1.5 rounded hover:bg-gray-100 disabled:opacity-30 disabled:cursor-not-allowed"
                      title={t.moveDown}
                    >
                      <ArrowDown size={18} className="text-gray-600" />
                    </button>
                  </div>
                </div>
              ))}
            </div>

            {/* Total pages */}
            <div className={`mt-4 p-4 rounded-xl ${isOverLimit ? 'bg-red-50 border-2 border-red-300' : 'bg-gray-100'}`}>
              <div className="flex items-center justify-between">
                <span className={`font-semibold ${isOverLimit ? 'text-red-700' : 'text-gray-700'}`}>
                  {t.totalPages}
                </span>
                <span className={`text-2xl font-bold ${isOverLimit ? 'text-red-700' : 'text-gray-800'}`}>
                  {totalPages}
                </span>
              </div>
              {isOverLimit && (
                <div className="mt-2 flex items-center gap-2 text-red-700">
                  <AlertTriangle size={16} />
                  <span className="text-sm">{t.tooManyPagesDesc}</span>
                </div>
              )}
            </div>
          </div>

          {/* Right: Format & Price */}
          <div>
            <h2 className="text-xl font-bold text-gray-800 mb-3">{t.chooseFormat}</h2>

            {/* Format selection */}
            <div className="space-y-3 mb-6">
              {/* Softcover */}
              <button
                onClick={() => setCoverType('softcover')}
                className={`w-full p-4 rounded-xl border-2 text-left transition-all ${
                  coverType === 'softcover'
                    ? 'border-indigo-600 bg-indigo-50'
                    : 'border-gray-200 hover:border-indigo-300'
                }`}
              >
                <div className="flex items-center gap-4">
                  <Book size={32} className={coverType === 'softcover' ? 'text-indigo-600' : 'text-gray-400'} />
                  <div className="flex-1">
                    <div className="font-semibold text-gray-800">{t.softcover}</div>
                    <div className="text-sm text-gray-500">{t.softcoverSize}</div>
                  </div>
                  {!isOverLimit && (
                    <div className="text-xl font-bold text-gray-800">
                      CHF {getPriceForPages(totalPages, false)}.-
                    </div>
                  )}
                </div>
              </button>

              {/* Hardcover */}
              <button
                onClick={() => setCoverType('hardcover')}
                className={`w-full p-4 rounded-xl border-2 text-left transition-all ${
                  coverType === 'hardcover'
                    ? 'border-indigo-600 bg-indigo-50'
                    : 'border-gray-200 hover:border-indigo-300'
                }`}
              >
                <div className="flex items-center gap-4">
                  <BookOpen size={32} className={coverType === 'hardcover' ? 'text-indigo-600' : 'text-gray-400'} />
                  <div className="flex-1">
                    <div className="font-semibold text-gray-800">{t.hardcover}</div>
                    <div className="text-sm text-gray-500">{t.hardcoverSize}</div>
                  </div>
                  {!isOverLimit && (
                    <div className="text-xl font-bold text-indigo-700">
                      CHF {getPriceForPages(totalPages, true)}.-
                    </div>
                  )}
                </div>
              </button>
            </div>

            {/* Price summary */}
            {!isOverLimit && price && (
              <div className="bg-gradient-to-r from-indigo-50 to-purple-50 rounded-xl p-6 mb-6">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-gray-700">{t.price}</span>
                  <span className="text-3xl font-bold text-indigo-700">CHF {price}.-</span>
                </div>
                <p className="text-sm text-gray-500">{t.includesShipping}</p>
              </div>
            )}

            {/* Order button */}
            <button
              onClick={handleCheckout}
              disabled={isOverLimit || isCheckingOut}
              className="w-full py-4 bg-gradient-to-r from-indigo-600 to-purple-600 text-white rounded-xl font-bold text-lg hover:from-indigo-700 hover:to-purple-700 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {isCheckingOut ? (
                <>
                  <div className="animate-spin rounded-full h-5 w-5 border-2 border-white border-t-transparent" />
                  {t.processing}
                </>
              ) : (
                <>
                  <ShoppingCart size={22} />
                  {t.orderBook}
                </>
              )}
            </button>

            {/* Print PDF button - admin only */}
            {isAdmin && (
              <button
                onClick={handlePrintPdf}
                disabled={isPrintingPdf || stories.length === 0}
                className="w-full mt-3 py-3 bg-purple-100 text-purple-700 border-2 border-purple-300 rounded-xl font-semibold hover:bg-purple-200 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {isPrintingPdf ? (
                  <>
                    <div className="animate-spin rounded-full h-5 w-5 border-2 border-purple-700 border-t-transparent" />
                    {t.generatingPdf}
                  </>
                ) : (
                  <>
                    <Printer size={20} />
                    {t.printPdf}
                  </>
                )}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
