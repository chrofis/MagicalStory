import { useState, useEffect, useRef } from 'react';
import { useParams, Link } from 'react-router-dom';
import { BookOpen, Loader2, AlertCircle, Sparkles, ChevronLeft, ChevronRight, Pencil, Globe, Lock, Share2 } from 'lucide-react';

// Swipe detection hook
function useSwipe(onSwipeLeft: () => void, onSwipeRight: () => void) {
  const touchStart = useRef<number | null>(null);
  const touchEnd = useRef<number | null>(null);
  const minSwipeDistance = 50;

  const onTouchStart = (e: React.TouchEvent) => {
    touchEnd.current = null;
    touchStart.current = e.targetTouches[0].clientX;
  };

  const onTouchMove = (e: React.TouchEvent) => {
    touchEnd.current = e.targetTouches[0].clientX;
  };

  const onTouchEnd = () => {
    if (!touchStart.current || !touchEnd.current) return;
    const distance = touchStart.current - touchEnd.current;
    const isLeftSwipe = distance > minSwipeDistance;
    const isRightSwipe = distance < -minSwipeDistance;
    if (isLeftSwipe) onSwipeLeft();
    if (isRightSwipe) onSwipeRight();
  };

  return { onTouchStart, onTouchMove, onTouchEnd };
}

interface SharedStoryPage {
  pageNumber: number;
  text: string;
}

interface SharedStoryData {
  id: string;
  title: string;
  language: string;
  pageCount: number;
  pages: SharedStoryPage[];
  dedication?: string;
  hasImages: boolean;
  covers?: {
    frontCover?: boolean;
    initialPage?: boolean;
    backCover?: boolean;
  };
  isOwner?: boolean;
  isShared?: boolean;
}

type PageEntry =
  | { type: 'frontCover' }
  | { type: 'initialPage' }
  | { type: 'story'; storyPageIdx: number }
  | { type: 'backCover' };

export default function SharedStoryViewer() {
  const { shareToken } = useParams<{ shareToken: string }>();
  const [story, setStory] = useState<SharedStoryData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(0); // 0 = cover, 1+ = pages
  const [sharingEnabled, setSharingEnabled] = useState(false);
  const [sharingLoading, setSharingLoading] = useState(false);

  useEffect(() => {
    async function fetchStory() {
      if (!shareToken) {
        setError('Invalid share link');
        setLoading(false);
        return;
      }

      try {
        const authToken = localStorage.getItem('auth_token');
        const headers: Record<string, string> = {};
        if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
        const response = await fetch(`/api/shared/${shareToken}`, { headers });
        if (!response.ok) {
          if (response.status === 404) {
            setError('This story is no longer available or the link is invalid.');
          } else {
            setError('Failed to load story. Please try again later.');
          }
          setLoading(false);
          return;
        }

        const data = await response.json();
        setStory(data);
        setSharingEnabled(data.isShared || false);
      } catch (err) {
        setError('Failed to load story. Please check your connection.');
      } finally {
        setLoading(false);
      }
    }

    fetchStory();
  }, [shareToken]);

  // Toggle sharing on/off (owner only)
  const toggleSharing = async () => {
    if (!story?.isOwner) return;
    setSharingLoading(true);
    try {
      const authToken = localStorage.getItem('auth_token');
      const method = sharingEnabled ? 'DELETE' : 'POST';
      const response = await fetch(`/api/stories/${story.id}/share`, {
        method,
        headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
      });
      if (response.ok) {
        const data = await response.json();
        setSharingEnabled(data.isShared);
      }
    } catch {
      // Ignore errors
    } finally {
      setSharingLoading(false);
    }
  };

  // Native share (mobile) or copy link
  const handleShare = async () => {
    if (!shareToken) return;
    const shareUrl = `${window.location.origin}/s/${shareToken}`;

    // If not shared yet, enable first
    if (!sharingEnabled && story?.isOwner) {
      setSharingLoading(true);
      try {
        const authToken = localStorage.getItem('auth_token');
        const response = await fetch(`/api/stories/${story.id}/share`, {
          method: 'POST',
          headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
        });
        if (response.ok) {
          const data = await response.json();
          setSharingEnabled(data.isShared);
        }
      } catch {
        // Continue anyway
      } finally {
        setSharingLoading(false);
      }
    }

    if (navigator.share) {
      try {
        await navigator.share({ title: story?.title || 'Story', url: shareUrl });
      } catch {
        // User cancelled
      }
    } else {
      try {
        await navigator.clipboard.writeText(shareUrl);
      } catch {
        // Fallback
      }
    }
  };

  // Build dynamic page list based on which covers exist
  const pageList: PageEntry[] = story ? (() => {
    const list: PageEntry[] = [];
    const c = story.covers ?? { frontCover: true, initialPage: true, backCover: true };
    if (c.frontCover) list.push({ type: 'frontCover' });
    if (c.initialPage) list.push({ type: 'initialPage' });
    for (let i = 0; i < story.pages.length; i++) {
      list.push({ type: 'story', storyPageIdx: i });
    }
    if (c.backCover) list.push({ type: 'backCover' });
    return list;
  })() : [];

  const totalPages = pageList.length;
  const currentEntry = pageList[currentPage] || null;

  // Preload adjacent page images for faster navigation
  useEffect(() => {
    if (!story || !shareToken || totalPages === 0) return;

    // Preload next and previous pages
    for (const offset of [-1, 1]) {
      const idx = currentPage + offset;
      if (idx < 0 || idx >= totalPages) continue;
      const entry = pageList[idx];
      const img = new Image();
      if (entry.type === 'story') {
        img.src = `/api/shared/${shareToken}/image/${story.pages[entry.storyPageIdx].pageNumber}`;
      } else {
        img.src = `/api/shared/${shareToken}/cover-image/${entry.type}`;
      }
    }
  }, [currentPage, story, shareToken, totalPages]);

  const goToPage = (page: number) => {
    if (page >= 0 && page < totalPages) {
      setCurrentPage(page);
    }
  };

  const swipeHandlers = useSwipe(
    () => goToPage(currentPage + 1), // swipe left = next
    () => goToPage(currentPage - 1)  // swipe right = prev
  );

  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-indigo-50 to-blue-50 flex items-center justify-center">
        <div className="text-center">
          <Loader2 className="w-12 h-12 animate-spin text-indigo-600 mx-auto mb-4" />
          <p className="text-indigo-800">Loading story...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-indigo-50 to-blue-50 flex items-center justify-center p-4">
        <div className="text-center max-w-md">
          <AlertCircle className="w-16 h-16 text-indigo-500 mx-auto mb-4" />
          <h1 className="text-2xl font-bold text-indigo-900 mb-2">Story Not Found</h1>
          <p className="text-indigo-700 mb-6">{error}</p>
          <Link
            to="/"
            className="inline-flex items-center gap-2 bg-gradient-to-r from-indigo-500 to-blue-500 text-white px-6 py-3 rounded-full font-semibold hover:from-indigo-600 hover:to-blue-600 transition-all"
          >
            <Sparkles className="w-5 h-5" />
            Create Your Own Story
          </Link>
        </div>
      </div>
    );
  }

  if (!story) return null;

  return (
    <div className="min-h-screen bg-gradient-to-b from-indigo-50 to-blue-50 flex flex-col">
      {/* Header */}
      <header className="bg-white/80 backdrop-blur-sm border-b border-indigo-200 sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <BookOpen className="w-6 h-6 text-indigo-600" />
            <span className="font-bold text-indigo-900 hidden sm:inline">MagicalStory</span>
          </div>
          {story?.isOwner ? (
            <div className="flex items-center gap-2">
              {/* Share toggle */}
              <button
                onClick={toggleSharing}
                disabled={sharingLoading}
                className={`inline-flex items-center gap-1 px-3 py-2 rounded-full text-sm font-medium transition-all ${
                  sharingEnabled
                    ? 'bg-green-100 text-green-700 hover:bg-green-200'
                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                }`}
                title={sharingEnabled ? 'Public — anyone with the link can view' : 'Private — only you can view'}
              >
                {sharingLoading ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : sharingEnabled ? (
                  <Globe className="w-4 h-4" />
                ) : (
                  <Lock className="w-4 h-4" />
                )}
                <span className="hidden sm:inline">{sharingEnabled ? 'Public' : 'Private'}</span>
              </button>

              {/* Share button */}
              <button
                onClick={handleShare}
                className="inline-flex items-center gap-1 px-3 py-2 bg-blue-100 text-blue-700 rounded-full text-sm font-medium hover:bg-blue-200 transition-all"
              >
                <Share2 className="w-4 h-4" />
                <span className="hidden sm:inline">Share</span>
              </button>

              {/* Edit button */}
              <Link
                to={`/create?storyId=${story.id}`}
                className="inline-flex items-center gap-1 bg-gradient-to-r from-indigo-500 to-blue-500 text-white px-4 py-2 rounded-full text-sm font-semibold hover:from-indigo-600 hover:to-blue-600 transition-all"
              >
                <Pencil className="w-4 h-4" />
                <span className="hidden sm:inline">Edit</span>
              </Link>
            </div>
          ) : (
            <Link
              to="/"
              className="inline-flex items-center gap-1 bg-gradient-to-r from-indigo-500 to-blue-500 text-white px-4 py-2 rounded-full text-sm font-semibold hover:from-indigo-600 hover:to-blue-600 transition-all"
            >
              <Sparkles className="w-4 h-4" />
              Create Your Own Story
            </Link>
          )}
        </div>
      </header>

      {/* Story Content with side arrows */}
      <main
        className="flex-1 flex items-center justify-center px-2 md:px-4 py-4 md:py-6"
        {...swipeHandlers}
      >
        {/* Left arrow - desktop only */}
        <button
          onClick={() => goToPage(currentPage - 1)}
          disabled={currentPage === 0}
          className="hidden md:flex p-2 lg:p-3 rounded-full bg-white shadow-lg border border-indigo-200 text-indigo-600 disabled:opacity-30 disabled:cursor-not-allowed hover:bg-indigo-50 transition-colors mr-3 lg:mr-6 flex-shrink-0"
          aria-label="Previous page"
        >
          <ChevronLeft className="w-6 h-6 lg:w-8 lg:h-8" />
        </button>

        {/* Book container */}
        <div className="bg-white rounded-2xl shadow-xl overflow-hidden border-2 border-indigo-200 flex-1 max-w-6xl">
          {/* Cover pages (frontCover, initialPage, backCover) */}
          {currentEntry && (currentEntry.type === 'frontCover' || currentEntry.type === 'initialPage' || currentEntry.type === 'backCover') && (
            <div className="flex items-center justify-center bg-gradient-to-br from-indigo-100 to-blue-100 p-4">
              <img
                src={`/api/shared/${shareToken}/cover-image/${currentEntry.type}`}
                alt={currentEntry.type === 'frontCover' ? story.title : currentEntry.type === 'initialPage' ? 'Dedication' : 'Back Cover'}
                className="max-h-[calc(100vh-200px)] max-w-full object-contain rounded-lg shadow-lg"
                loading="eager"
                onError={(e) => {
                  e.currentTarget.style.display = 'none';
                }}
              />
            </div>
          )}

          {/* Story Pages */}
          {currentEntry && currentEntry.type === 'story' && (() => {
            const page = story.pages[currentEntry.storyPageIdx];
            if (!page) return null;
            return (
              <div className="md:grid md:grid-cols-2 h-[calc(100vh-180px)] md:h-[calc(100vh-160px)] min-h-[400px] max-h-[800px]">
                {/* Image - 50% width */}
                <div className="h-1/2 md:h-full bg-gradient-to-br from-indigo-50 to-blue-50 flex items-center justify-center">
                  <img
                    src={`/api/shared/${shareToken}/image/${page.pageNumber}`}
                    alt={`Page ${currentEntry.storyPageIdx + 1}`}
                    className="w-full h-full object-contain"
                    loading="eager"
                    onError={(e) => {
                      e.currentTarget.src = '';
                      e.currentTarget.alt = 'Image not available';
                    }}
                  />
                </div>
                {/* Text - 50% width, scrollable */}
                <div className="h-1/2 md:h-full p-4 md:p-5 lg:p-6 flex flex-col bg-indigo-50/50 overflow-hidden">
                  <div className="flex-1 overflow-y-auto min-h-0">
                    <p className="text-sm md:text-base leading-relaxed text-gray-800 whitespace-pre-wrap">
                      {page.text}
                    </p>
                  </div>
                  <div className="mt-2 pt-2 border-t border-indigo-100 text-right text-indigo-400 text-xs flex-shrink-0">
                    Page {currentEntry.storyPageIdx + 1} of {story.pages.length}
                  </div>
                </div>
              </div>
            );
          })()}


          {/* Page dots - inside book container */}
          <div className="flex items-center justify-center gap-2 py-3 bg-white border-t border-indigo-100">
            {Array.from({ length: Math.min(totalPages, 12) }).map((_, i) => {
              const pageIndex = totalPages <= 12 ? i :
                i < 5 ? i :
                i === 5 ? -1 :
                totalPages - (11 - i);

              if (pageIndex === -1) {
                return <span key={i} className="text-indigo-300 text-xs">...</span>;
              }

              return (
                <button
                  key={i}
                  onClick={() => goToPage(pageIndex)}
                  className={`w-2.5 h-2.5 rounded-full transition-all ${
                    currentPage === pageIndex
                      ? 'bg-indigo-500 scale-125'
                      : 'bg-indigo-200 hover:bg-indigo-300'
                  }`}
                  aria-label={`Go to page ${pageIndex}`}
                />
              );
            })}
          </div>
        </div>

        {/* Right arrow - desktop only */}
        <button
          onClick={() => goToPage(currentPage + 1)}
          disabled={currentPage >= totalPages - 1}
          className="hidden md:flex p-2 lg:p-3 rounded-full bg-white shadow-lg border border-indigo-200 text-indigo-600 disabled:opacity-30 disabled:cursor-not-allowed hover:bg-indigo-50 transition-colors ml-3 lg:ml-6 flex-shrink-0"
          aria-label="Next page"
        >
          <ChevronRight className="w-6 h-6 lg:w-8 lg:h-8" />
        </button>
      </main>

      {/* Mobile navigation - bottom */}
      <div className="md:hidden flex items-center justify-center gap-6 pb-4">
        <button
          onClick={() => goToPage(currentPage - 1)}
          disabled={currentPage === 0}
          className="p-3 rounded-full bg-white shadow-md border border-indigo-200 text-indigo-600 disabled:opacity-30 disabled:cursor-not-allowed"
          aria-label="Previous page"
        >
          <ChevronLeft className="w-6 h-6" />
        </button>
        <p className="text-indigo-400 text-sm">Swipe or tap</p>
        <button
          onClick={() => goToPage(currentPage + 1)}
          disabled={currentPage >= totalPages - 1}
          className="p-3 rounded-full bg-white shadow-md border border-indigo-200 text-indigo-600 disabled:opacity-30 disabled:cursor-not-allowed"
          aria-label="Next page"
        >
          <ChevronRight className="w-6 h-6" />
        </button>
      </div>
    </div>
  );
}
