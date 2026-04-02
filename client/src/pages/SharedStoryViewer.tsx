import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { BookOpen, Loader2, AlertCircle, Sparkles, ChevronLeft, ChevronRight, Pencil, Globe, Lock, Share2, Menu, BookOpenCheck, Plus, X } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import { useLanguage } from '@/context/LanguageContext';
import { UserMenu } from '@/components/common/UserMenu';
import { ChangePasswordModal } from '@/components/auth/ChangePasswordModal';
import { CreditsModal } from '@/components/common/CreditsModal';

// Swipe detection hook — only triggers on the image area, not scrollable text
function useSwipe(onSwipeLeft: () => void, onSwipeRight: () => void) {
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const touchEnd = useRef<{ x: number; y: number } | null>(null);
  const minSwipeDistance = 50;

  const onTouchStart = (e: React.TouchEvent) => {
    // Only allow swipe on image area — skip if touch started in a scrollable text container
    const target = e.target as HTMLElement;
    if (target.closest('[data-text-scroll]')) return;
    touchEnd.current = null;
    touchStart.current = { x: e.targetTouches[0].clientX, y: e.targetTouches[0].clientY };
  };

  const onTouchMove = (e: React.TouchEvent) => {
    if (!touchStart.current) return;
    touchEnd.current = { x: e.targetTouches[0].clientX, y: e.targetTouches[0].clientY };
  };

  const onTouchEnd = () => {
    if (!touchStart.current || !touchEnd.current) return;
    const dx = touchStart.current.x - touchEnd.current.x;
    const dy = Math.abs(touchStart.current.y - touchEnd.current.y);
    // Only count as swipe if horizontal distance exceeds vertical (not a scroll)
    if (dy > Math.abs(dx)) { touchStart.current = null; return; }
    if (dx > minSwipeDistance) onSwipeLeft();
    if (dx < -minSwipeDistance) onSwipeRight();
    touchStart.current = null;
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
  needsPassword?: boolean;
}

type PageEntry =
  | { type: 'frontCover' }
  | { type: 'initialPage' }
  | { type: 'story'; storyPageIdx: number }
  | { type: 'backCover' }
  | { type: 'endPage' };

// End page translations keyed by story language
const endPageText: Record<string, Record<string, string>> = {
  de: {
    secureTitle: 'Sichere deine Geschichte!',
    secureDesc: 'Setze ein Passwort, damit du jederzeit auf deine Geschichte zugreifen kannst. Ohne Passwort geht deine Geschichte verloren.',
    setPassword: 'Passwort setzen',
    benefits: 'Mit deinem kostenlosen Konto kannst du:',
    endTitle: 'Ende der Geschichte',
    printBook: 'Als Buch drucken',
    newStory: 'Neue Geschichte erstellen',
    f1: 'Mehrere Figuren in einer Geschichte',
    f2: 'Längere Geschichten mit mehr Seiten',
    f3: 'Verschiedene Zeichenstile',
    f4: 'Höhere Bildqualität und Titelseite',
    f5: 'Als gedrucktes Buch bestellen',
  },
  en: {
    secureTitle: 'Secure your story!',
    secureDesc: 'Set a password so you can access your story anytime. Without a password your story will be lost.',
    setPassword: 'Set password',
    benefits: 'With your free account you can:',
    endTitle: 'The End',
    printBook: 'Print as a book',
    newStory: 'Create a new story',
    f1: 'Multiple characters in one story',
    f2: 'Longer stories with more pages',
    f3: 'Different drawing styles',
    f4: 'Higher image quality and title page',
    f5: 'Order as a printed book',
  },
  fr: {
    secureTitle: 'Sécurisez votre histoire !',
    secureDesc: 'Définissez un mot de passe pour accéder à votre histoire à tout moment. Sans mot de passe, votre histoire sera perdue.',
    setPassword: 'Définir un mot de passe',
    benefits: 'Avec votre compte gratuit, vous pouvez :',
    endTitle: 'Fin de l\'histoire',
    printBook: 'Imprimer en livre',
    newStory: 'Créer une nouvelle histoire',
    f1: 'Plusieurs personnages dans une même histoire',
    f2: 'Des histoires plus longues',
    f3: 'Différents styles de dessin',
    f4: 'Meilleure qualité d\'image et page de titre',
    f5: 'Commander en livre imprimé',
  },
};

export default function SharedStoryViewer() {
  const { shareToken } = useParams<{ shareToken: string }>();
  const navigate = useNavigate();
  const { isAuthenticated } = useAuth();
  const { t } = useLanguage();
  const [story, setStory] = useState<SharedStoryData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(0); // 0 = cover, 1+ = pages
  const [sharingEnabled, setSharingEnabled] = useState(false);
  const [sharingLoading, setSharingLoading] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const [showCreditsModal, setShowCreditsModal] = useState(false);
  const [showChangePasswordModal, setShowChangePasswordModal] = useState(false);
  const [fullscreenImage, setFullscreenImage] = useState<string | null>(null);
  const [pageTransition, setPageTransition] = useState<'none' | 'slide-left' | 'slide-right'>('none');
  const menuRef = useRef<HTMLDivElement>(null);
  const textScrollRef = useRef<HTMLDivElement>(null);

  // Close menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setShowMenu(false);
      }
    };
    if (showMenu) document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showMenu]);

  // Auth token suffix for image URLs (img tags can't send Authorization headers)
  const authToken = localStorage.getItem('auth_token');
  const tokenParam = authToken ? `?token=${encodeURIComponent(authToken)}` : '';

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
    list.push({ type: 'endPage' });
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
      if (entry.type === 'endPage') continue;
      const img = new Image();
      if (entry.type === 'story') {
        img.src = `/api/shared/${shareToken}/image/${story.pages[entry.storyPageIdx].pageNumber}${tokenParam}`;
      } else {
        img.src = `/api/shared/${shareToken}/cover-image/${entry.type}${tokenParam}`;
      }
    }
  }, [currentPage, story, shareToken, totalPages]);

  // Scroll text back to top when page changes
  useEffect(() => {
    textScrollRef.current?.scrollTo(0, 0);
  }, [currentPage]);

  const goToPage = useCallback((page: number) => {
    if (page >= 0 && page < totalPages && page !== currentPage) {
      const direction = page > currentPage ? 'slide-left' : 'slide-right';
      setPageTransition(direction);
      setTimeout(() => {
        setCurrentPage(page);
        setPageTransition('none');
      }, 250);
    }
  }, [totalPages, currentPage]);

  const swipeHandlers = useSwipe(
    () => goToPage(currentPage + 1), // swipe left = next
    () => goToPage(currentPage - 1)  // swipe right = prev
  );

  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-indigo-50 to-blue-50 flex items-center justify-center">
        <div className="text-center">
          <Loader2 className="w-12 h-12 animate-spin text-indigo-500 mx-auto mb-4" />
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
      {isAuthenticated ? (
        <header className="bg-black text-white px-3 py-3 sticky top-0 z-10">
          <div className="flex items-center justify-between">
            {/* Left: Title */}
            <button onClick={() => navigate('/')} className="text-sm md:text-base font-bold whitespace-nowrap hover:opacity-80 flex items-center gap-1.5">
              <img src="/images/logo-book.png" alt="" className="h-10 md:h-11 -my-2 w-auto" />
              {t.title}
            </button>

            {/* Right: Story actions + Menu */}
            <div className="flex items-center gap-2">
              {story?.isOwner && (
                <>
                  {/* Share toggle */}
                  <button
                    onClick={toggleSharing}
                    disabled={sharingLoading}
                    className={`inline-flex items-center gap-1 px-2.5 py-1.5 rounded text-xs font-medium transition-all ${
                      sharingEnabled
                        ? 'bg-green-600 text-white hover:bg-green-700'
                        : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                    }`}
                    title={sharingEnabled ? 'Public — anyone with the link can view' : 'Private — only you can view'}
                  >
                    {sharingLoading ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : sharingEnabled ? (
                      <Globe className="w-3.5 h-3.5" />
                    ) : (
                      <Lock className="w-3.5 h-3.5" />
                    )}
                    <span className="hidden sm:inline">{sharingEnabled ? 'Public' : 'Private'}</span>
                  </button>

                  {/* Share button */}
                  <button
                    onClick={handleShare}
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 bg-indigo-500 text-white rounded text-xs font-medium hover:bg-indigo-600 transition-all"
                  >
                    <Share2 className="w-3.5 h-3.5" />
                    <span className="hidden sm:inline">Share</span>
                  </button>

                  {/* Edit button */}
                  <Link
                    to={`/create?storyId=${story.id}`}
                    className="inline-flex items-center gap-1 bg-indigo-500 text-white px-2.5 py-1.5 rounded text-xs font-semibold hover:bg-indigo-500 transition-all"
                  >
                    <Pencil className="w-3.5 h-3.5" />
                    <span className="hidden sm:inline">Edit</span>
                  </Link>
                </>
              )}

              {/* Menu Button */}
              <div className="relative" ref={menuRef}>
                <button
                  onClick={() => setShowMenu(!showMenu)}
                  className="bg-gray-800 text-white px-3 py-1.5 rounded text-xs font-semibold hover:bg-gray-700 flex items-center gap-2"
                >
                  <Menu size={16} />
                  <span className="hidden md:inline">Menu</span>
                </button>

                {showMenu && (
                  <UserMenu
                    onClose={() => setShowMenu(false)}
                    onShowCreditsModal={() => setShowCreditsModal(true)}
                    onShowChangePasswordModal={() => setShowChangePasswordModal(true)}
                  />
                )}
              </div>
            </div>
          </div>
        </header>
      ) : (
        <header className="bg-white/80 backdrop-blur-sm border-b border-indigo-200 sticky top-0 z-10">
          <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <BookOpen className="w-6 h-6 text-indigo-500" />
              <span className="font-bold text-indigo-900 hidden sm:inline">MagicalStory</span>
            </div>
            <Link
              to="/"
              className="inline-flex items-center gap-1 bg-gradient-to-r from-indigo-500 to-blue-500 text-white px-4 py-2 rounded-full text-sm font-semibold hover:from-indigo-600 hover:to-blue-600 transition-all"
            >
              <Sparkles className="w-4 h-4" />
              Create Your Own Story
            </Link>
          </div>
        </header>
      )}

      {/* Story Content with side arrows */}
      <main
        className="flex-1 flex items-center justify-center px-2 md:px-4 py-4 md:py-6"
        {...swipeHandlers}
      >
        {/* Left arrow - desktop only */}
        <button
          onClick={() => goToPage(currentPage - 1)}
          disabled={currentPage === 0}
          className="hidden md:flex p-2 lg:p-3 rounded-full bg-white shadow-lg border border-indigo-200 text-indigo-500 disabled:opacity-30 disabled:cursor-not-allowed hover:bg-indigo-50 transition-colors mr-3 lg:mr-6 flex-shrink-0"
          aria-label="Previous page"
        >
          <ChevronLeft className="w-6 h-6 lg:w-8 lg:h-8" />
        </button>

        {/* Book container with page turn animation */}
        <div className={`bg-white rounded-xl sm:rounded-2xl shadow-xl overflow-hidden border border-indigo-100 sm:border-2 sm:border-indigo-200 flex-1 max-w-6xl transition-all duration-300 ease-in-out ${
          pageTransition === 'slide-left' ? 'opacity-0 translate-x-[-40px]' :
          pageTransition === 'slide-right' ? 'opacity-0 translate-x-[40px]' : 'opacity-100 translate-x-0'
        }`}>
          {/* Cover pages (frontCover, initialPage, backCover) */}
          {currentEntry && (currentEntry.type === 'frontCover' || currentEntry.type === 'initialPage' || currentEntry.type === 'backCover') && (
            <div
              className="flex items-center justify-center bg-gradient-to-br from-indigo-100 to-blue-100 p-2 sm:p-4 cursor-pointer"
              onClick={() => setFullscreenImage(`/api/shared/${shareToken}/cover-image/${currentEntry.type}${tokenParam}`)}
            >
              <img
                src={`/api/shared/${shareToken}/cover-image/${currentEntry.type}${tokenParam}`}
                alt={currentEntry.type === 'frontCover' ? story.title : currentEntry.type === 'initialPage' ? 'Dedication' : 'Back Cover'}
                className="max-h-[calc(100vh-200px)] max-w-full object-contain rounded-lg shadow-lg pointer-events-none"
                loading="eager"
                onError={(e) => {
                  e.currentTarget.style.display = 'none';
                }}
              />
            </div>
          )}

          {/* Story Pages — text left, image right (desktop) / image top, text bottom (mobile) */}
          {currentEntry && currentEntry.type === 'story' && (() => {
            const page = story.pages[currentEntry.storyPageIdx];
            if (!page) return null;
            return (
              <div className="flex flex-col md:grid md:grid-cols-2 h-[calc(100vh-180px)] md:h-[calc(100vh-160px)] min-h-[400px] max-h-[900px]">
                {/* Text — left on desktop, bottom on mobile */}
                <div className="h-1/2 md:h-full p-5 md:p-8 lg:p-10 flex flex-col md:justify-center bg-white overflow-hidden order-2 md:order-1">
                  <div ref={textScrollRef} className="overflow-y-auto min-h-0 md:max-h-full" data-text-scroll>
                    <p className="text-base md:text-lg lg:text-xl leading-relaxed md:leading-loose text-gray-800 whitespace-pre-wrap">
                      {page.text}
                    </p>
                  </div>
                  <div className="mt-2 pt-2 border-t border-indigo-100 text-right text-indigo-400 text-xs flex-shrink-0">
                    {currentEntry.storyPageIdx + 1} / {story.pages.length}
                  </div>
                </div>
                {/* Image — right on desktop, top on mobile */}
                <div
                  className="h-1/2 md:h-full bg-gradient-to-br from-indigo-50 to-blue-50 flex items-center justify-center order-1 md:order-2 cursor-pointer"
                  onClick={() => setFullscreenImage(`/api/shared/${shareToken}/image/${page.pageNumber}${tokenParam}`)}
                >
                  <img
                    src={`/api/shared/${shareToken}/image/${page.pageNumber}${tokenParam}`}
                    alt={`Page ${currentEntry.storyPageIdx + 1}`}
                    className="w-full h-full object-contain pointer-events-none"
                    loading="eager"
                  />
                </div>
              </div>
            );
          })()}

          {/* End Page — CTA after last page */}
          {currentEntry && currentEntry.type === 'endPage' && (() => {
            const lang = (story.language || 'en').split('-')[0].toLowerCase();
            const et = endPageText[lang] || endPageText.en;
            return (
            <div className="flex items-center justify-center bg-gradient-to-br from-indigo-100 to-blue-100 min-h-[400px] h-[calc(100vh-200px)] max-h-[800px] p-6">
              <div className="text-center max-w-md">
                {story.needsPassword ? (
                  <>
                    <div className="w-16 h-16 bg-amber-100 rounded-full flex items-center justify-center mx-auto mb-4">
                      <Lock className="w-8 h-8 text-amber-600" />
                    </div>
                    <h2 className="text-2xl font-bold text-gray-800 mb-2">{et.secureTitle}</h2>
                    <p className="text-gray-600 mb-4">{et.secureDesc}</p>
                    <button
                      onClick={() => setShowChangePasswordModal(true)}
                      className="w-full bg-indigo-500 text-white py-3 rounded-lg font-semibold hover:bg-indigo-600 transition-colors mb-4"
                    >
                      {et.setPassword}
                    </button>
                    <div className="bg-indigo-50 rounded-xl p-4 border border-indigo-100 text-left">
                      <p className="text-xs font-semibold text-indigo-700 mb-2">{et.benefits}</p>
                      <ul className="text-xs text-gray-600 space-y-1">
                        {[et.f1, et.f2, et.f3, et.f4, et.f5].map((f, i) => (
                          <li key={i} className="flex items-center gap-1.5"><span className="text-indigo-500 font-bold">+</span> {f}</li>
                        ))}
                      </ul>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="w-16 h-16 bg-indigo-100 rounded-full flex items-center justify-center mx-auto mb-4">
                      <BookOpenCheck className="w-8 h-8 text-indigo-500" />
                    </div>
                    <h2 className="text-2xl font-bold text-gray-800 mb-2">{et.endTitle}</h2>
                    <p className="text-gray-500 mb-6">{story.title}</p>
                    <div className="flex flex-col gap-3">
                      <button
                        onClick={() => navigate('/stories')}
                        className="w-full bg-indigo-500 text-white py-3 rounded-lg font-semibold hover:bg-indigo-600 transition-colors flex items-center justify-center gap-2"
                      >
                        <BookOpen className="w-5 h-5" />
                        {et.printBook}
                      </button>
                      <button
                        onClick={() => navigate('/create?new=true')}
                        className="w-full bg-white text-indigo-500 py-3 rounded-lg font-semibold border-2 border-indigo-200 hover:bg-indigo-50 transition-colors flex items-center justify-center gap-2"
                      >
                        <Plus className="w-5 h-5" />
                        {et.newStory}
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
            );
          })()}


          {/* Page dots - inside book container */}
          <div className="flex items-center justify-center gap-1.5 sm:gap-2 py-2 sm:py-3 bg-white border-t border-indigo-50 sm:border-indigo-100">
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
          className="hidden md:flex p-2 lg:p-3 rounded-full bg-white shadow-lg border border-indigo-200 text-indigo-500 disabled:opacity-30 disabled:cursor-not-allowed hover:bg-indigo-50 transition-colors ml-3 lg:ml-6 flex-shrink-0"
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
          className="p-3 rounded-full bg-white shadow-md border border-indigo-200 text-indigo-500 disabled:opacity-30 disabled:cursor-not-allowed"
          aria-label="Previous page"
        >
          <ChevronLeft className="w-6 h-6" />
        </button>
        <p className="text-indigo-400 text-sm">Swipe or tap</p>
        <button
          onClick={() => goToPage(currentPage + 1)}
          disabled={currentPage >= totalPages - 1}
          className="p-3 rounded-full bg-white shadow-md border border-indigo-200 text-indigo-500 disabled:opacity-30 disabled:cursor-not-allowed"
          aria-label="Next page"
        >
          <ChevronRight className="w-6 h-6" />
        </button>
      </div>

      {/* Fullscreen image viewer */}
      {fullscreenImage && (
        <div
          className="fixed inset-0 bg-black z-50 flex items-center justify-center"
          onClick={() => setFullscreenImage(null)}
        >
          <img
            src={fullscreenImage}
            alt="Fullscreen"
            className="max-w-full max-h-full object-contain"
          />
          <button className="absolute top-3 right-3 text-white/70 hover:text-white p-2" onClick={() => setFullscreenImage(null)}>
            <X size={24} />
          </button>
        </div>
      )}

      {/* Modals */}
      {showCreditsModal && <CreditsModal isOpen={showCreditsModal} onClose={() => setShowCreditsModal(false)} />}
      {showChangePasswordModal && <ChangePasswordModal isOpen={showChangePasswordModal} onClose={() => setShowChangePasswordModal(false)} />}
    </div>
  );
}
