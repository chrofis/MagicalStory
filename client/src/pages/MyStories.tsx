import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Book, Trash2, Eye, AlertTriangle, Plus, Minus, BookOpen, Tag } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import { useAuth } from '@/context/AuthContext';
import { storyService } from '@/services';
import { LoadingSpinner, Navigation } from '@/components/common';
import { MAX_BOOK_PAGES } from './Pricing';
import { createLogger } from '@/services/logger';

const log = createLogger('MyStories');

// Simple cache for stories to prevent reload on navigation
let storiesCache: { data: StoryListItem[] | null; timestamp: number } = { data: null, timestamp: 0 };
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

interface StoryListItem {
  id: string;
  title: string;
  story_type: string;
  art_style: string;
  language: string;
  pages: number;
  created_at: string;
  createdAt?: string;
  thumbnail?: string;
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
  t,
}: {
  story: StoryListItem;
  language: string;
  onView: () => void;
  onDelete: () => void;
  formatDate: (date: string | undefined) => string;
  isSelected: boolean;
  onToggleSelect: () => void;
  t: { add: string; remove: string };
}) {
  const [imageLoaded, setImageLoaded] = useState(false);
  const [imageError, setImageError] = useState(false);
  const [isVisible, setIsVisible] = useState(false);
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

  return (
    <div
      ref={cardRef}
      className={`bg-white rounded-xl shadow-md overflow-hidden transition-all flex flex-col hover:shadow-lg ${
        story.isPartial ? 'ring-2 ring-amber-400' : ''
      } ${
        isSelected ? 'ring-3 ring-green-500 bg-green-50' : ''
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
        ) : !isVisible ? (
          <div className="relative w-full h-48 bg-gray-100 flex items-center justify-center">
            <div className="w-8 h-8 spinner" />
          </div>
        ) : (
          <div className="relative w-full h-48 bg-gradient-to-br from-indigo-100 to-purple-100 flex items-center justify-center">
            <Book className="w-12 h-12 text-indigo-300" />
          </div>
        )}

        {/* Partial badge (top-right) */}
        {story.isPartial && (
          <div className="absolute top-2 right-2 bg-amber-500 text-white px-2 py-1 rounded-md text-xs font-medium flex items-center gap-1">
            <AlertTriangle size={12} />
            {language === 'de' ? 'Teilweise' : language === 'fr' ? 'Partiel' : 'Partial'}
          </div>
        )}

        {/* Selected indicator (top-left) */}
        {isSelected && (
          <div className="absolute top-2 left-2 bg-green-500 text-white px-2 py-1 rounded-md text-xs font-bold">
            ✓
          </div>
        )}
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
              {story.pages} {language === 'de' ? 'Seiten' : language === 'fr' ? 'pages' : 'pages'} • {formatDate(story.created_at || story.createdAt)}
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

          {/* Add/Remove button for book selection */}
          {!story.isPartial && (
            <button
              onClick={(e) => { e.stopPropagation(); onToggleSelect(); }}
              className={`flex items-center justify-center gap-1 px-3 py-2 rounded-lg font-medium transition-colors ${
                isSelected
                  ? 'bg-red-100 text-red-600 hover:bg-red-200'
                  : 'bg-green-100 text-green-600 hover:bg-green-200'
              }`}
            >
              {isSelected ? <Minus size={18} /> : <Plus size={18} />}
              {isSelected ? t.remove : t.add}
            </button>
          )}

          <button
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
            className="p-2 text-red-600 hover:bg-red-50 rounded-lg"
          >
            <Trash2 size={18} />
          </button>
        </div>
      </div>
    </div>
  );
}

export default function MyStories() {
  const navigate = useNavigate();
  const { language } = useLanguage();
  const { isAuthenticated } = useAuth();
  const [stories, setStories] = useState<StoryListItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

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
    },
  };

  const t = translations[language as keyof typeof translations] || translations.en;

  useEffect(() => {
    if (!isAuthenticated) {
      navigate('/');
      return;
    }
    loadStories();
  }, [isAuthenticated, navigate]);

  const loadStories = async () => {
    log.debug('Loading stories...');
    try {
      // Check cache first
      const now = Date.now();
      if (storiesCache.data && (now - storiesCache.timestamp) < CACHE_DURATION) {
        log.debug('Using cached stories');
        setStories(storiesCache.data);
        setIsLoading(false);
        return;
      }

      setIsLoading(true);
      const data = await storyService.getStories();
      log.info('Loaded stories:', data.length);
      const storyList = data as unknown as StoryListItem[];
      setStories(storyList);

      // Update cache
      storiesCache = { data: storyList, timestamp: now };
    } catch (error) {
      log.error('Failed to load stories:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const deleteStory = async (id: string) => {
    const confirmMsg = language === 'de'
      ? 'Diese Geschichte wirklich löschen?'
      : language === 'fr'
      ? 'Voulez-vous vraiment supprimer cette histoire?'
      : 'Are you sure you want to delete this story?';

    if (!confirm(confirmMsg)) return;

    try {
      await storyService.deleteStory(id);
      setStories(stories.filter(s => s.id !== id));
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
    return selectedStories.reduce((sum, s) => sum + s.pages, 0);
  }, [selectedStories]);

  const isOverLimit = totalSelectedPages > MAX_BOOK_PAGES;

  // Enter selection mode
  const enterSelectionMode = () => {
    setSelectionMode(true);
    setSelectedIds(new Set());
  };

  // Exit selection mode
  const exitSelectionMode = () => {
    setSelectionMode(false);
    setSelectedIds(new Set());
  };

  // Proceed to book builder
  const goToBookBuilder = () => {
    const selectedData = selectedStories.map(s => ({
      id: s.id,
      title: s.title,
      pages: s.pages,
      thumbnail: s.thumbnail,
    }));
    navigate('/book-builder', { state: { selectedStories: selectedData } });
  };

  if (!isAuthenticated) {
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
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-8">
          <h1 className="text-2xl md:text-3xl font-bold text-gray-800 flex items-center gap-2">
            <Book size={28} />
            {t.myStories}
          </h1>

          <div className="flex flex-wrap items-center gap-3">
            {/* See Pricing link */}
            <button
              onClick={() => navigate('/pricing')}
              className="flex items-center gap-2 px-4 py-2 text-gray-600 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg transition-colors"
            >
              <Tag size={18} />
              {t.seePricing}
            </button>

            {/* Selection mode toggle */}
            {!selectionMode && canSelectForBook && (
              <button
                onClick={enterSelectionMode}
                className="flex items-center gap-2 px-4 py-2 border-2 border-indigo-600 text-indigo-600 rounded-lg hover:bg-indigo-50 font-semibold transition-colors"
              >
                <BookOpen size={18} />
                {t.selectForBook}
              </button>
            )}

            {selectionMode && (
              <button
                onClick={exitSelectionMode}
                className="flex items-center gap-2 px-4 py-2 border-2 border-gray-300 text-gray-600 rounded-lg hover:bg-gray-100 font-semibold transition-colors"
              >
                <X size={18} />
                {t.cancel}
              </button>
            )}

            {/* Create Story button */}
            {!selectionMode && (
              <button
                onClick={() => navigate('/create')}
                className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 font-semibold transition-colors"
              >
                {t.createStory}
              </button>
            )}
          </div>
        </div>

        {/* Selection mode hint */}
        {selectionMode && (
          <div className="bg-indigo-50 border border-indigo-200 rounded-lg p-4 mb-6 flex items-center gap-3">
            <CheckSquare size={24} className="text-indigo-600" />
            <p className="text-indigo-800 font-medium">{t.selectHint}</p>
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
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {stories.map((story) => (
              <StoryCard
                key={story.id}
                story={story}
                language={language}
                onView={() => navigate(`/create?storyId=${story.id}`)}
                onDelete={() => deleteStory(story.id)}
                formatDate={formatDate}
                selectionMode={selectionMode}
                isSelected={selectedIds.has(story.id)}
                onToggleSelect={() => toggleSelect(story.id)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Floating action bar for selection mode */}
      {selectionMode && selectedIds.size > 0 && (
        <div className="fixed bottom-0 left-0 right-0 bg-white border-t-2 border-indigo-200 shadow-lg p-4 z-50">
          <div className="max-w-6xl mx-auto flex items-center justify-between">
            <div className="flex items-center gap-4">
              <div className="text-gray-800">
                <span className="font-bold text-lg">{selectedIds.size}</span>{' '}
                <span className="text-gray-600">{t.selected}</span>
              </div>
              <div className={`text-sm ${isOverLimit ? 'text-red-600 font-medium' : 'text-gray-500'}`}>
                {totalSelectedPages} {t.pages}
                {isOverLimit && (
                  <span className="ml-2 flex items-center gap-1 inline-flex">
                    <AlertTriangle size={14} />
                    {t.tooManyPages}
                  </span>
                )}
              </div>
            </div>

            <button
              onClick={goToBookBuilder}
              disabled={isOverLimit || selectedIds.size === 0}
              className="flex items-center gap-2 px-6 py-3 bg-gradient-to-r from-indigo-600 to-purple-600 text-white rounded-lg font-bold hover:from-indigo-700 hover:to-purple-700 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
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
