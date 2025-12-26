import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Book, Trash2, Eye, AlertTriangle, BookOpen, Tag } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import { useAuth } from '@/context/AuthContext';
import { useToast } from '@/context/ToastContext';
import { storyService } from '@/services';
import { LoadingSpinner, Navigation } from '@/components/common';
import { MAX_BOOK_PAGES } from './Pricing';
import { createLogger } from '@/services/logger';

const log = createLogger('MyStories');

// Simple cache for stories to prevent reload on navigation
let storiesCache: { data: StoryListItem[] | null; total: number; timestamp: number } = { data: null, total: 0, timestamp: 0 };
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes
const STORIES_PER_PAGE = 6;
const AUTO_LOAD_LIMIT = 18; // Auto-load first 18 stories, then show "Load All"

interface StoryListItem {
  id: string;
  title: string;
  story_type: string;
  art_style: string;
  language: string;
  languageLevel?: string; // '1st-grade', 'standard', 'advanced'
  pages: number;
  pageCount?: number; // Calculated page count (accounts for picture book vs standard layout + cover pages)
  created_at: string;
  createdAt?: string;
  thumbnail?: string; // Loaded lazily via getStoryCover
  hasThumbnail?: boolean; // Indicates if cover image is available
  isPartial?: boolean;
  generatedPages?: number;
  totalPages?: number;
}

// Story card component with lazy loading and individual image loading state
function StoryCard({
  story,
  language,
  onView,
  onDelete,
  formatDate,
  isSelected,
  onToggleSelect,
  onLoadCover,
  t,
}: {
  story: StoryListItem;
  language: string;
  onView: () => void;
  onDelete: () => void;
  formatDate: (date: string | undefined) => string;
  isSelected: boolean;
  onToggleSelect: () => void;
  onLoadCover: (storyId: string) => void;
  t: { add: string; remove: string };
}) {
  const [imageLoaded, setImageLoaded] = useState(false);
  const [imageError, setImageError] = useState(false);
  const [isVisible, setIsVisible] = useState(false);
  const [coverLoading, setCoverLoading] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);

  // Lazy load images using IntersectionObserver
  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setIsVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: '100px' }
    );

    if (cardRef.current) {
      observer.observe(cardRef.current);
    }

    return () => observer.disconnect();
  }, []);

  // Load cover image when visible and hasThumbnail but no thumbnail yet
  useEffect(() => {
    if (isVisible && story.hasThumbnail && !story.thumbnail && !coverLoading) {
      setCoverLoading(true);
      onLoadCover(story.id);
    }
  }, [isVisible, story.hasThumbnail, story.thumbnail, story.id, coverLoading, onLoadCover]);

  return (
    <div
      ref={cardRef}
      className={`bg-white rounded-xl shadow-md overflow-hidden transition-all flex flex-col hover:shadow-lg ${
        story.isPartial ? 'ring-2 ring-amber-400' : ''
      } ${
        isSelected ? 'ring-8 ring-green-500' : ''
      }`}
    >
      {/* Thumbnail */}
      <div className="relative">
        {isVisible && story.thumbnail && !imageError ? (
          <div className="relative w-full h-48 bg-gray-100">
            {!imageLoaded && (
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="w-8 h-8 spinner" />
              </div>
            )}
            <img
              src={story.thumbnail}
              alt={story.title}
              className={`w-full h-48 object-cover transition-opacity duration-300 ${imageLoaded ? 'opacity-100' : 'opacity-0'}`}
              onLoad={() => setImageLoaded(true)}
              onError={() => setImageError(true)}
            />
          </div>
        ) : !isVisible || (story.hasThumbnail && !story.thumbnail && !imageError) ? (
          // Show loading spinner while not visible or while loading cover
          <div className="relative w-full h-48 bg-gray-100 flex items-center justify-center">
            <div className="w-8 h-8 spinner" />
          </div>
        ) : (
          // No cover image available
          <div className="relative w-full h-48 bg-gradient-to-br from-indigo-100 to-purple-100 flex items-center justify-center">
            <Book className="w-12 h-12 text-indigo-300" />
          </div>
        )}

        {/* Partial badge (top-left) */}
        {story.isPartial && (
          <div className="absolute top-2 left-2 bg-amber-500 text-white px-2 py-1 rounded-md text-xs font-medium flex items-center gap-1">
            <AlertTriangle size={12} />
            {language === 'de' ? 'Teilweise' : language === 'fr' ? 'Partiel' : 'Partial'}
          </div>
        )}

        {/* Delete button (top-right) */}
        <button
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          className="absolute top-2 right-2 p-2 bg-white/90 text-red-600 hover:bg-red-100 rounded-lg shadow-sm"
        >
          <Trash2 size={16} />
        </button>
      </div>

      <div className="p-4 flex flex-col flex-1">
        <div className="flex-1">
          <h3 className="font-bold text-lg text-gray-800 mb-2">{story.title}</h3>
          {story.isPartial ? (
            <p className="text-sm text-amber-600 mb-3">
              {story.generatedPages || 0}/{story.totalPages || story.pages} {language === 'de' ? 'Seiten generiert' : language === 'fr' ? 'pages générées' : 'pages generated'} • {formatDate(story.created_at || story.createdAt)}
            </p>
          ) : (
            <p className="text-sm text-gray-500 mb-3">
              {story.pageCount || story.pages} {language === 'de' ? 'Seiten' : language === 'fr' ? 'pages' : 'pages'} • {formatDate(story.created_at || story.createdAt)}
            </p>
          )}
        </div>

        {/* Action buttons */}
        <div className="flex gap-2 mt-auto">
          <button
            onClick={(e) => { e.stopPropagation(); onView(); }}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700"
          >
            <Eye size={18} />
            {language === 'de' ? 'Ansehen' : language === 'fr' ? 'Voir' : 'View'}
          </button>

          {/* Add/Remove button for book selection - same style as View button */}
          {!story.isPartial && (
            <button
              onClick={(e) => { e.stopPropagation(); onToggleSelect(); }}
              className={`flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-lg font-medium transition-colors ${
                isSelected
                  ? 'bg-red-600 text-white hover:bg-red-700'
                  : 'bg-green-600 text-white hover:bg-green-700'
              }`}
            >
              {isSelected ? t.remove : t.add}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default function MyStories() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { language } = useLanguage();
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const { showSuccess, showInfo } = useToast();
  const [stories, setStories] = useState<StoryListItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [totalStories, setTotalStories] = useState(0);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => {
    // Restore selection from sessionStorage
    try {
      const saved = sessionStorage.getItem('mystories_selected');
      if (saved) {
        return new Set(JSON.parse(saved));
      }
    } catch {
      // Ignore parse errors
    }
    return new Set();
  });

  // Persist selection to sessionStorage
  useEffect(() => {
    sessionStorage.setItem('mystories_selected', JSON.stringify([...selectedIds]));
  }, [selectedIds]);

  // Check for Stripe payment callback on page load
  useEffect(() => {
    const checkPaymentStatus = async () => {
      const paymentStatus = searchParams.get('payment');
      const sessionId = searchParams.get('session_id');

      if (paymentStatus === 'success' && sessionId) {
        log.info('Payment successful! Checking order status...');

        try {
          const data = await storyService.getOrderStatus(sessionId);
          log.info('Order Status:', data);

          if (data.order) {
            // Clear selection after successful purchase
            setSelectedIds(new Set());
            sessionStorage.removeItem('mystories_selected');

            const amount = `CHF ${(data.order.amount_total / 100).toFixed(2)}`;
            const titles = {
              en: 'Payment Successful!',
              de: 'Zahlung erfolgreich!',
              fr: 'Paiement réussi!',
            };
            const messages = {
              en: 'Your book order has been received and will be printed soon.',
              de: 'Ihre Buchbestellung wurde entgegengenommen und wird bald gedruckt.',
              fr: 'Votre commande de livre a été reçue et sera bientôt imprimée.',
            };
            const details = [
              `${language === 'de' ? 'Kunde' : language === 'fr' ? 'Client' : 'Customer'}: ${data.order.customer_name}`,
              `Email: ${data.order.customer_email}`,
              `${language === 'de' ? 'Betrag' : language === 'fr' ? 'Montant' : 'Amount'}: ${amount}`,
              `${language === 'de' ? 'Versand an' : language === 'fr' ? 'Expédié à' : 'Shipping to'}: ${data.order.shipping_name}`,
              `${data.order.shipping_address_line1}`,
              `${data.order.shipping_postal_code} ${data.order.shipping_city}`,
              `${data.order.shipping_country}`,
            ];
            showSuccess(
              messages[language as keyof typeof messages] || messages.en,
              titles[language as keyof typeof titles] || titles.en,
              details
            );
          }
        } catch (error) {
          log.error('Error checking order status:', error);
        }

        // Clean up URL parameters
        const newParams = new URLSearchParams(searchParams);
        newParams.delete('payment');
        newParams.delete('session_id');
        setSearchParams(newParams, { replace: true });
      } else if (paymentStatus === 'cancelled') {
        log.info('Payment cancelled by user');
        const messages = {
          en: 'Payment was cancelled. You can try again when ready.',
          de: 'Zahlung wurde abgebrochen. Sie können es erneut versuchen.',
          fr: 'Paiement annulé. Vous pouvez réessayer quand vous êtes prêt.',
        };
        showInfo(
          messages[language as keyof typeof messages] || messages.en,
          language === 'de' ? 'Abgebrochen' : language === 'fr' ? 'Annulé' : 'Cancelled'
        );

        // Clean up URL parameters
        const newParams = new URLSearchParams(searchParams);
        newParams.delete('payment');
        setSearchParams(newParams, { replace: true });
      }
    };

    checkPaymentStatus();
  }, [searchParams, setSearchParams, language, showSuccess, showInfo]);

  const translations = {
    en: {
      myStories: 'My Stories',
      createStory: 'Create Story',
      noStories: 'No stories created yet',
      seePricing: 'See Pricing',
      selectHint: 'Select stories to create a book',
      selected: 'selected',
      pages: 'pages',
      createBook: 'Create Book',
      tooManyPages: 'Too many pages (max 100)',
      add: 'Add',
      remove: 'Remove',
      loadAll: 'Load All',
    },
    de: {
      myStories: 'Meine Geschichten',
      createStory: 'Geschichte erstellen',
      noStories: 'Noch keine Geschichten erstellt',
      seePricing: 'Preise ansehen',
      selectHint: 'Wähle Geschichten, um ein Buch zu erstellen',
      selected: 'ausgewählt',
      pages: 'Seiten',
      createBook: 'Buch erstellen',
      tooManyPages: 'Zu viele Seiten (max. 100)',
      add: 'Hinzufügen',
      remove: 'Entfernen',
      loadAll: 'Alle laden',
    },
    fr: {
      myStories: 'Mes histoires',
      createStory: 'Créer une histoire',
      noStories: 'Aucune histoire créée',
      seePricing: 'Voir les tarifs',
      selectHint: 'Sélectionnez des histoires pour créer un livre',
      selected: 'sélectionné(s)',
      pages: 'pages',
      createBook: 'Créer le livre',
      tooManyPages: 'Trop de pages (max 100)',
      add: 'Ajouter',
      remove: 'Retirer',
      loadAll: 'Tout charger',
    },
  };

  const t = translations[language as keyof typeof translations] || translations.en;

  useEffect(() => {
    // Wait for auth to load before checking authentication
    if (authLoading) return;

    if (!isAuthenticated) {
      navigate('/');
      return;
    }
    loadStories();
  }, [isAuthenticated, authLoading, navigate]);

  const loadStories = async (options: { loadMore?: boolean; loadAll?: boolean } = {}) => {
    const { loadMore = false, loadAll = false } = options;
    log.debug('Loading stories...', { loadMore, loadAll });
    try {
      // Check cache first (only for initial load)
      const now = Date.now();
      if (!loadMore && !loadAll && storiesCache.data && (now - storiesCache.timestamp) < CACHE_DURATION) {
        log.debug('Using cached stories');
        setStories(storiesCache.data);
        setTotalStories(storiesCache.total);
        setHasMore(storiesCache.data.length < storiesCache.total);
        setIsLoading(false);
        return;
      }

      if (loadMore || loadAll) {
        setIsLoadingMore(true);
      } else {
        setIsLoading(true);
      }

      const offset = (loadMore || loadAll) ? stories.length : 0;
      // If loadAll, fetch all remaining stories at once
      const limit = loadAll ? 1000 : STORIES_PER_PAGE;
      const { stories: newStories, pagination } = await storyService.getStories({
        limit,
        offset,
      });
      log.info('Loaded stories:', newStories.length, 'total:', pagination.total);

      const storyList = newStories as unknown as StoryListItem[];

      if (loadMore || loadAll) {
        // Use functional update to avoid losing concurrent thumbnail updates
        setStories(prev => {
          const updatedStories = [...prev, ...storyList];
          // Update cache with merged data
          storiesCache = { data: updatedStories, total: pagination.total, timestamp: now };
          return updatedStories;
        });
      } else {
        setStories(storyList);
        // Update cache
        storiesCache = { data: storyList, total: pagination.total, timestamp: now };
      }

      setTotalStories(pagination.total);
      setHasMore(pagination.hasMore);
    } catch (error) {
      log.error('Failed to load stories:', error);
    } finally {
      setIsLoading(false);
      setIsLoadingMore(false);
    }
  };

  // Auto-load more stories until we reach AUTO_LOAD_LIMIT
  useEffect(() => {
    if (!isLoading && !isLoadingMore && hasMore && stories.length < AUTO_LOAD_LIMIT && stories.length > 0) {
      loadStories({ loadMore: true });
    }
  }, [stories.length, hasMore, isLoading, isLoadingMore]);

  // Load cover image for a story
  const loadCover = useCallback(async (storyId: string) => {
    try {
      const coverImage = await storyService.getStoryCover(storyId);
      if (coverImage) {
        setStories(prev => prev.map(s =>
          s.id === storyId ? { ...s, thumbnail: coverImage } : s
        ));
        // Update cache
        if (storiesCache.data) {
          storiesCache.data = storiesCache.data.map(s =>
            s.id === storyId ? { ...s, thumbnail: coverImage } : s
          );
        }
      }
    } catch (error) {
      log.error('Failed to load cover for story:', storyId, error);
    }
  }, []);

  const deleteStory = async (id: string) => {
    const confirmMsg = language === 'de'
      ? 'Diese Geschichte wirklich löschen?'
      : language === 'fr'
      ? 'Voulez-vous vraiment supprimer cette histoire?'
      : 'Are you sure you want to delete this story?';

    if (!confirm(confirmMsg)) return;

    try {
      await storyService.deleteStory(id);
      const updatedStories = stories.filter(s => s.id !== id);
      setStories(updatedStories);
      setTotalStories(prev => Math.max(0, prev - 1));
      // Invalidate cache
      storiesCache = { data: updatedStories, total: Math.max(0, totalStories - 1), timestamp: Date.now() };
      // Remove from selection if selected
      setSelectedIds(prev => {
        const newSet = new Set(prev);
        newSet.delete(id);
        return newSet;
      });
    } catch (error) {
      log.error('Failed to delete story:', error);
      alert(language === 'de'
        ? 'Geschichte konnte nicht gelöscht werden. Bitte versuche es erneut.'
        : language === 'fr'
        ? 'Impossible de supprimer l\'histoire. Veuillez réessayer.'
        : 'Failed to delete story. Please try again.');
    }
  };

  const formatDate = useCallback((dateStr: string | undefined) => {
    if (!dateStr) return '';
    try {
      const date = new Date(dateStr);
      return date.toLocaleDateString(language === 'de' ? 'de-DE' : language === 'fr' ? 'fr-FR' : 'en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      });
    } catch {
      return '';
    }
  }, [language]);

  // Toggle story selection
  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const newSet = new Set(prev);
      if (newSet.has(id)) {
        newSet.delete(id);
      } else {
        newSet.add(id);
      }
      return newSet;
    });
  };

  // Calculate total pages of selected stories
  const selectedStories = useMemo(() => {
    return stories.filter(s => selectedIds.has(s.id));
  }, [stories, selectedIds]);

  const totalSelectedPages = useMemo(() => {
    return selectedStories.reduce((sum, s) => sum + (s.pageCount || s.pages), 0);
  }, [selectedStories]);

  const isOverLimit = totalSelectedPages > MAX_BOOK_PAGES;

  // Proceed to book builder
  const goToBookBuilder = () => {
    const selectedData = selectedStories.map(s => ({
      id: s.id,
      title: s.title,
      pages: s.pageCount || s.pages, // Use calculated page count
      thumbnail: s.thumbnail,
    }));
    navigate('/book-builder', { state: { selectedStories: selectedData } });
  };

  if (authLoading || !isAuthenticated) {
    return <LoadingSpinner fullScreen />;
  }

  // Check if there are complete (non-partial) stories for selection
  const completeStories = stories.filter(s => !s.isPartial);
  const canSelectForBook = completeStories.length >= 1;

  return (
    <div className="min-h-screen bg-gray-50 pb-24">
      <Navigation currentStep={0} />

      <div className="px-4 md:px-8 py-8 max-w-6xl mx-auto">
        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6">
          <h1 className="text-2xl md:text-3xl font-bold text-gray-800 flex items-center gap-2">
            <Book size={28} />
            {t.myStories}
          </h1>

          <div className="flex flex-wrap items-center gap-3">
            {/* See Pricing button */}
            <button
              onClick={() => navigate('/pricing')}
              className="flex items-center gap-2 px-4 py-2 border-2 border-gray-300 text-gray-600 rounded-lg hover:border-indigo-400 hover:text-indigo-600 hover:bg-indigo-50 font-medium transition-colors"
            >
              <Tag size={18} />
              {t.seePricing}
            </button>

            {/* Create Book button */}
            {canSelectForBook && (
              <button
                onClick={goToBookBuilder}
                disabled={selectedIds.size === 0 || isOverLimit}
                className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <BookOpen size={18} />
                {t.createBook}
                {selectedIds.size > 0 && (
                  <span className="bg-white text-indigo-600 text-xs px-2 py-0.5 rounded-full">
                    {selectedIds.size}
                  </span>
                )}
              </button>
            )}

            {/* Create Story button */}
            <button
              onClick={() => navigate('/create')}
              className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 font-semibold transition-colors"
            >
              {t.createStory}
            </button>
          </div>
        </div>

        {/* Instructions hint */}
        {stories.length > 0 && (
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 mb-6 flex items-center gap-3">
            <BookOpen size={20} className="text-blue-600 flex-shrink-0" />
            <p className="text-blue-800 text-sm">{t.selectHint}</p>
            {selectedIds.size > 0 && (
              <span className={`ml-auto text-sm font-medium ${isOverLimit ? 'text-red-600' : 'text-blue-600'}`}>
                {selectedIds.size} {t.selected} • {totalSelectedPages} {t.pages}
                {isOverLimit && ` (${t.tooManyPages})`}
              </span>
            )}
          </div>
        )}

        {isLoading ? (
          <LoadingSpinner message={language === 'de' ? 'Laden...' : language === 'fr' ? 'Chargement...' : 'Loading...'} />
        ) : stories.length === 0 ? (
          <div className="text-center py-12">
            <Book className="w-16 h-16 text-gray-300 mx-auto mb-4" />
            <p className="text-gray-500 text-lg">{t.noStories}</p>
            <button
              onClick={() => navigate('/create')}
              className="mt-4 px-6 py-3 bg-indigo-600 text-white rounded-lg font-semibold hover:bg-indigo-700"
            >
              {t.createStory}
            </button>
          </div>
        ) : (
          <>
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {stories.map((story) => (
                <StoryCard
                  key={story.id}
                  story={story}
                  language={language}
                  onView={() => navigate(`/create?storyId=${story.id}`)}
                  onDelete={() => deleteStory(story.id)}
                  formatDate={formatDate}
                  isSelected={selectedIds.has(story.id)}
                  onToggleSelect={() => toggleSelect(story.id)}
                  onLoadCover={loadCover}
                  t={{ add: t.add, remove: t.remove }}
                />
              ))}
            </div>

            {/* Load All button - only shown after auto-loading first 18 stories */}
            {hasMore && stories.length >= AUTO_LOAD_LIMIT && (
              <div className="flex justify-center mt-8">
                <button
                  onClick={() => loadStories({ loadAll: true })}
                  disabled={isLoadingMore}
                  className="flex items-center gap-2 px-6 py-3 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 font-semibold transition-colors disabled:opacity-50"
                >
                  {isLoadingMore ? (
                    <>
                      <div className="w-5 h-5 spinner" />
                      {language === 'de' ? 'Laden...' : language === 'fr' ? 'Chargement...' : 'Loading...'}
                    </>
                  ) : (
                    <>
                      {t.loadAll} ({totalStories - stories.length} {language === 'de' ? 'weitere' : language === 'fr' ? 'autres' : 'more'})
                    </>
                  )}
                </button>
              </div>
            )}
          </>
        )}

        {/* Add padding at bottom to account for sticky bar */}
        {selectedIds.size > 0 && <div className="h-24" />}
      </div>

      {/* Sticky bottom bar for Create Book */}
      {selectedIds.size > 0 && (
        <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 shadow-lg z-50">
          <div className="max-w-7xl mx-auto px-4 py-4 flex items-center justify-between">
            <div className="flex items-center gap-4">
              <span className="font-medium text-gray-700">
                {selectedIds.size} {t.selected} • {totalSelectedPages} {t.pages}
              </span>
              {isOverLimit && (
                <span className="text-red-600 font-medium">({t.tooManyPages})</span>
              )}
            </div>
            <button
              onClick={goToBookBuilder}
              disabled={isOverLimit}
              className={`flex items-center gap-2 px-6 py-3 rounded-lg font-semibold transition-colors ${
                isOverLimit
                  ? 'bg-gray-300 text-gray-500 cursor-not-allowed'
                  : 'bg-indigo-600 text-white hover:bg-indigo-700'
              }`}
            >
              <BookOpen size={20} />
              {t.createBook}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
