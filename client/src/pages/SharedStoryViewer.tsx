import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { BookOpen, Loader2, AlertCircle, Sparkles, ChevronLeft, ChevronRight, ChevronsLeft, Pencil, Globe, Lock, Share2, Menu, Eye, X } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import { useLanguage } from '@/context/LanguageContext';
import { UserMenu } from '@/components/common/UserMenu';
import { ChangePasswordModal } from '@/components/auth/ChangePasswordModal';
import { CreditsModal } from '@/components/common/CreditsModal';
import { ImageLightbox } from '@/components/common/ImageLightbox';
import { BookViewer } from '@/components/book';
import type { BookViewerHandle } from '@/components/book';

interface SharedStoryPage {
  pageNumber: number;
  text: string;
  textPosition?: string | null;
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
  | { type: 'storyText'; storyPageIdx: number }
  | { type: 'story'; storyPageIdx: number }
  | { type: 'backCover' }
  | { type: 'endPage' };

/** Reading mode for the shared story view. */
type ReadingMode = 'inline' | 'sidepage';

export default function SharedStoryViewer() {
  const { shareToken } = useParams<{ shareToken: string }>();
  const navigate = useNavigate();
  const { isAuthenticated } = useAuth();
  const { language, t } = useLanguage();
  const [story, setStory] = useState<SharedStoryData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(0);
  const [sharingEnabled, setSharingEnabled] = useState(false);
  const [sharingLoading, setSharingLoading] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const [showCreditsModal, setShowCreditsModal] = useState(false);
  const [showChangePasswordModal, setShowChangePasswordModal] = useState(false);
  const [fullscreenImage, setFullscreenImage] = useState<string | null>(null);
  const [readingMode, setReadingMode] = useState<ReadingMode>(() => {
    // Default to "Read mode" on mobile (text below image) so tiny text doesn't overlay the illustration.
    if (typeof window !== 'undefined' && window.innerWidth < 768) return 'sidepage';
    return 'inline';
  });
  const showTextOverlay = readingMode === 'inline';
  const [isMobile, setIsMobile] = useState(typeof window !== 'undefined' && window.innerWidth < 768);
  const [bannerDismissed, setBannerDismissed] = useState(() => {
    if (typeof window === 'undefined') return false;
    return sessionStorage.getItem('privateStoryBannerDismissed') === '1';
  });
  const menuRef = useRef<HTMLDivElement>(null);
  const bookRef = useRef<BookViewerHandle>(null);

  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

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

  // Auth token suffix for image URLs (img tags can't send Authorization headers).
  // The fullscreen viewer receives URLs that already have ?token=... from BookViewer,
  // so don't double-append. Only use this where we build URLs from scratch.
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
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
      if (sharingEnabled) {
        await fetch(`/api/stories/${story.id}/share`, { method: 'DELETE', headers });
        setSharingEnabled(false);
      } else {
        await fetch(`/api/stories/${story.id}/share`, { method: 'POST', headers });
        setSharingEnabled(true);
      }
    } catch (err) {
      // Silently fail
    } finally {
      setSharingLoading(false);
    }
  };

  // Share link via native share or clipboard
  const handleShare = async () => {
    if (!sharingEnabled) {
      // Auto-enable sharing before sharing
      setSharingLoading(true);
      try {
        const authToken = localStorage.getItem('auth_token');
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
        await fetch(`/api/stories/${story!.id}/share`, { method: 'POST', headers });
        setSharingEnabled(true);
      } catch {
        setSharingLoading(false);
        return;
      } finally {
        setSharingLoading(false);
      }
    }

    const shareUrl = window.location.href;
    if (navigator.share) {
      try {
        await navigator.share({ title: story!.title, url: shareUrl });
      } catch {
        // User cancelled
      }
    } else {
      try {
        await navigator.clipboard.writeText(shareUrl);
        // Could show a toast notification here
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
      // sidepage mode on desktop: text on left page, image on right page (book spread).
      // On mobile, text is rendered below the image on the same page — no extra storyText entry.
      if (readingMode === 'sidepage' && !isMobile) {
        list.push({ type: 'storyText', storyPageIdx: i });
      }
      list.push({ type: 'story', storyPageIdx: i });
    }
    if (c.backCover) list.push({ type: 'backCover' });
    list.push({ type: 'endPage' });
    return list;
  })() : [];

  const totalPages = pageList.length;

  // Preload adjacent page images for faster navigation
  useEffect(() => {
    if (!story || !shareToken || totalPages === 0) return;
    for (const offset of [-2, -1, 1, 2]) {
      const idx = currentPage + offset;
      if (idx < 0 || idx >= totalPages) continue;
      const entry = pageList[idx];
      if (entry.type === 'endPage' || entry.type === 'storyText') continue;
      const img = new Image();
      if (entry.type === 'story') {
        img.src = `/api/shared/${shareToken}/image/${story.pages[entry.storyPageIdx].pageNumber}${tokenParam}`;
      } else {
        img.src = `/api/shared/${shareToken}/cover-image/${entry.type}${tokenParam}`;
      }
    }
  }, [currentPage, story, shareToken, totalPages]);

  // Navigation via book ref
  const flipNext = useCallback(() => bookRef.current?.flipNext(), []);
  const flipPrev = useCallback(() => bookRef.current?.flipPrev(), []);

  // Keyboard navigation — disabled while the fullscreen lightbox is open,
  // so arrows/space in the lightbox don't also flip pages underneath.
  useEffect(() => {
    if (fullscreenImage) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight' || e.key === ' ') { e.preventDefault(); flipNext(); }
      if (e.key === 'ArrowLeft') { e.preventDefault(); flipPrev(); }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [flipNext, flipPrev, fullscreenImage]);

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

  // Reading-mode toggle — sits in the top bar so it doesn't overlap the book image.
  const readingModeToggle = (
    <div className="inline-flex rounded-full bg-indigo-100 border border-indigo-300 p-0.5 shadow-sm text-xs font-medium">
      <button
        onClick={() => setReadingMode('inline')}
        title="Text printed over the image — matches the printed book"
        aria-pressed={readingMode === 'inline'}
        className={`flex items-center gap-1 px-2 sm:px-3 py-1 rounded-full transition-colors ${
          readingMode === 'inline' ? 'bg-indigo-600 text-white shadow' : 'text-indigo-700 hover:bg-indigo-200'
        }`}
      >
        <Eye size={13} />
        <span className="hidden sm:inline">Print preview</span>
      </button>
      <button
        onClick={() => setReadingMode('sidepage')}
        title="Text on a separate facing page — easier to read"
        aria-pressed={readingMode === 'sidepage'}
        className={`flex items-center gap-1 px-2 sm:px-3 py-1 rounded-full transition-colors ${
          readingMode === 'sidepage' ? 'bg-indigo-600 text-white shadow' : 'text-indigo-700 hover:bg-indigo-200'
        }`}
      >
        <BookOpen size={13} />
        <span className="hidden sm:inline">Read mode</span>
      </button>
    </div>
  );

  return (
    <div className="h-[100dvh] overflow-hidden bg-gradient-to-b from-indigo-50 to-blue-50 flex flex-col" style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
      {/* Header */}
      {isAuthenticated ? (
        <header className="bg-black text-white px-3 py-3 sticky top-0 z-10">
          <div className="flex items-center justify-between">
            {/* Left: Title — text hides on small screens so the reading-mode toggle fits */}
            <button onClick={() => navigate('/')} className="text-sm md:text-base font-bold whitespace-nowrap hover:opacity-80 flex items-center gap-1.5 flex-shrink-0">
              <img src="/images/logo-book.png" alt="" className="h-10 md:h-11 -my-2 w-auto" />
              <span className="hidden md:inline">{t.title}</span>
            </button>

            {/* Center: reading mode toggle */}
            <div className="mx-2">{readingModeToggle}</div>

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
                    className="inline-flex items-center gap-1 bg-indigo-500 text-white px-2.5 py-1.5 rounded text-xs font-semibold hover:bg-indigo-600 transition-all"
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
          <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 flex-shrink-0">
              <BookOpen className="w-6 h-6 text-indigo-500" />
              <span className="font-bold text-indigo-900 hidden md:inline">MagicalStory</span>
            </div>
            {readingModeToggle}
            <Link
              to="/"
              className="inline-flex items-center gap-1 bg-gradient-to-r from-indigo-500 to-blue-500 text-white px-3 sm:px-4 py-2 rounded-full text-xs sm:text-sm font-semibold hover:from-indigo-600 hover:to-blue-600 transition-all flex-shrink-0"
            >
              <Sparkles className="w-4 h-4" />
              <span className="hidden sm:inline">Create Your Own Story</span>
            </Link>
          </div>
        </header>
      )}

      {/* Private story banner — shown to owner when story is not shared; dismissable per session */}
      {story.isOwner && !sharingEnabled && !bannerDismissed && (
        <div className="bg-amber-50 border-b border-amber-200 px-4 py-2.5 flex items-center justify-between gap-3">
          <p className="text-sm text-amber-800 min-w-0 flex-1">
            {language === 'de' ? 'Diese Geschichte ist privat — nur du kannst sie sehen.' : language === 'fr' ? 'Cette histoire est privée — vous seul pouvez la voir.' : 'This story is private — only you can see it.'}
          </p>
          <div className="flex items-center gap-2 flex-shrink-0">
            <button
              onClick={handleShare}
              disabled={sharingLoading}
              className="bg-amber-500 text-white px-4 py-1.5 rounded-lg text-sm font-semibold hover:bg-amber-600 transition-colors disabled:opacity-50"
            >
              {sharingLoading ? '...' : language === 'de' ? 'Teilen' : language === 'fr' ? 'Partager' : 'Share'}
            </button>
            <button
              onClick={() => {
                sessionStorage.setItem('privateStoryBannerDismissed', '1');
                setBannerDismissed(true);
              }}
              aria-label={language === 'de' ? 'Schließen' : language === 'fr' ? 'Fermer' : 'Dismiss'}
              className="p-1.5 rounded-md text-amber-700 hover:bg-amber-100 transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* Book with side navigation arrows */}
      <main className="flex-1 min-h-0 flex items-center justify-center px-2 md:px-4 py-2 md:py-4">
        {/* Left arrow - desktop only */}
        <div className="hidden md:flex flex-col items-center gap-2 mr-3 lg:mr-6 flex-shrink-0">
          <button
            onClick={flipPrev}
            disabled={currentPage === 0}
            className="p-2 lg:p-3 rounded-full bg-white shadow-lg border border-indigo-200 text-indigo-500 disabled:opacity-30 disabled:cursor-not-allowed hover:bg-indigo-50 transition-colors"
            aria-label="Previous page"
          >
            <ChevronLeft className="w-6 h-6 lg:w-8 lg:h-8" />
          </button>
          {currentPage > 1 && (
            <button
              onClick={() => bookRef.current?.flipTo(0)}
              className="p-1.5 rounded-full bg-white shadow border border-indigo-200 text-indigo-400 hover:text-indigo-600 hover:bg-indigo-50 transition-colors"
              aria-label="Go to first page"
              title="Go to first page"
            >
              <ChevronsLeft className="w-4 h-4" />
            </button>
          )}
        </div>

        {/* Book viewer */}
        <div className="flex-1 max-w-5xl h-full min-h-0 flex items-center justify-center">
          <BookViewer
            key={`${readingMode}-${isMobile ? 'm' : 'd'}`}
            ref={bookRef}
            pageList={pageList}
            story={story}
            shareToken={shareToken!}
            showTextOverlay={showTextOverlay}
            textOnSidePage={readingMode === 'sidepage'}
            onImageClick={(url) => setFullscreenImage(url)}
            onPageChange={setCurrentPage}
            onNavigate={(path) => navigate(path)}
            onSetPassword={() => setShowChangePasswordModal(true)}
          />
        </div>

        {/* Right arrow - desktop only */}
        <button
          onClick={flipNext}
          disabled={currentPage >= totalPages - 1}
          className="hidden md:flex p-2 lg:p-3 rounded-full bg-white shadow-lg border border-indigo-200 text-indigo-500 disabled:opacity-30 disabled:cursor-not-allowed hover:bg-indigo-50 transition-colors ml-3 lg:ml-6 flex-shrink-0"
          aria-label="Next page"
        >
          <ChevronRight className="w-6 h-6 lg:w-8 lg:h-8" />
        </button>
      </main>

      {/* Text overlay toggle + page counter */}
      <div className="flex items-center justify-center gap-4 pb-3">
        {/* Mobile: first page button */}
        <div className="md:hidden">
          {currentPage > 1 && (
            <button
              onClick={() => bookRef.current?.flipTo(0)}
              className="p-2.5 rounded-full bg-white shadow-md border border-indigo-200 text-indigo-400"
              aria-label="Go to first page"
            >
              <ChevronsLeft className="w-5 h-5" />
            </button>
          )}
        </div>

        {/* Mobile: prev button */}
        <button
          onClick={flipPrev}
          disabled={currentPage === 0}
          className="md:hidden p-3 rounded-full bg-white shadow-md border border-indigo-200 text-indigo-500 disabled:opacity-30 disabled:cursor-not-allowed"
          aria-label="Previous page"
        >
          <ChevronLeft className="w-6 h-6" />
        </button>

        {/* Page counter */}
        <span className="text-indigo-400 text-sm font-medium min-w-[3rem] text-center">
          {currentPage + 1} / {totalPages}
        </span>

        {/* Mobile: next button */}
        <button
          onClick={flipNext}
          disabled={currentPage >= totalPages - 1}
          className="md:hidden p-3 rounded-full bg-white shadow-md border border-indigo-200 text-indigo-500 disabled:opacity-30 disabled:cursor-not-allowed"
          aria-label="Next page"
        >
          <ChevronRight className="w-6 h-6" />
        </button>
      </div>

      {/* Fullscreen image viewer */}
      <ImageLightbox
        src={fullscreenImage}
        alt="Story page"
        onClose={() => setFullscreenImage(null)}
      />

      {/* Modals */}
      {showCreditsModal && <CreditsModal isOpen={showCreditsModal} onClose={() => setShowCreditsModal(false)} />}
      {showChangePasswordModal && <ChangePasswordModal isOpen={showChangePasswordModal} onClose={() => setShowChangePasswordModal(false)} />}
    </div>
  );
}
