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
  languageLevel?: string;
  layout?: { imageAspect?: string; textInImage?: boolean; mode?: string } | null;
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
  const { isAuthenticated, isLoading: isAuthLoading } = useAuth();
  const { language, t } = useLanguage();
  const [story, setStory] = useState<SharedStoryData | null>(null);
  // Slim header (title, cover existence, page count). Lands ~10× faster
  // than the full story payload because it skips the multi-MB JSONB blob
  // fetch — used to paint the title page immediately while the fat
  // /api/shared/<token> request is still in flight.
  const [header, setHeader] = useState<{
    id: string;
    title: string;
    language?: string;
    languageLevel?: string;
    layout?: { textInImage?: boolean } | null;
    pageCount: number;
    covers: { frontCover?: boolean; initialPage?: boolean; backCover?: boolean };
    frontCoverUrl?: string | null;
    isOwner: boolean;
    isShared: boolean;
    needsPassword: boolean;
  } | null>(null);
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
  // Remembers the last-viewed pageList entry so reading-mode switches can
  // map to the equivalent entry in the new pageList (same story page),
  // instead of reusing a logical index that points to a different page.
  const lastEntryRef = useRef<PageEntry | null>(null);

  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Lock the document so swipes inside the book don't scroll the whole page
  // (iOS/Android mobile — `h-[100dvh] overflow-hidden` on the root isn't
  // enough; the body still rubber-bands).
  useEffect(() => {
    const prevHtml = document.documentElement.style.overflow;
    const prevBody = document.body.style.overflow;
    document.documentElement.style.overflow = 'hidden';
    document.body.style.overflow = 'hidden';
    return () => {
      document.documentElement.style.overflow = prevHtml;
      document.body.style.overflow = prevBody;
    };
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
    if (!shareToken) {
      setError('Invalid share link');
      setLoading(false);
      return;
    }
    // Wait for auth state to resolve before fetching — otherwise a private
    // story owned by a logged-in user may 404 during the brief pre-auth window.
    if (isAuthLoading) return;

    let cancelled = false;
    const authToken = localStorage.getItem('auth_token');
    const headers: Record<string, string> = {};
    if (authToken) headers['Authorization'] = `Bearer ${authToken}`;

    // Phase 1: fast header fetch → title page paints immediately.
    // Phase 2: full story fetch (in parallel) → BookViewer mounts when ready.
    // Phase 3: pre-fire text-overlay POSTs as soon as header lands so the
    //          server cache is warm by the time BookViewer asks for them.
    const handle404 = (status: number) => {
      if (status === 404 && !isAuthenticated) {
        const returnTo = `/shared/${shareToken}`;
        navigate(`/?login=true&redirect=${encodeURIComponent(returnTo)}`);
        return;
      }
      if (status === 404) {
        setError('This story is no longer available or the link is invalid.');
      } else {
        setError('Failed to load story. Please try again later.');
      }
      setLoading(false);
    };

    // Phase 1
    fetch(`/api/shared/${shareToken}/header`, { headers })
      .then(async r => {
        if (cancelled) return;
        if (!r.ok) { handle404(r.status); return; }
        const h = await r.json();
        if (cancelled) return;
        setHeader(h);
        setSharingEnabled(h.isShared || false);
        // Phase 3 — fire-and-forget overlay POSTs, one per page. Server caches
        // them; when BookViewer mounts later it'll hit the cache and render
        // without waiting on Sharp.
        for (let p = 1; p <= h.pageCount; p++) {
          fetch(`/api/shared/${shareToken}/text-overlay/${p}`, {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json' },
          }).catch(() => { /* best-effort */ });
        }
      })
      .catch(() => { /* fall through to full fetch error handling */ });

    // Phase 2 — fat request in parallel with the header.
    fetch(`/api/shared/${shareToken}`, { headers })
      .then(async r => {
        if (cancelled) return;
        if (!r.ok) { handle404(r.status); return; }
        const data = await r.json();
        if (cancelled) return;
        setStory(data);
        setSharingEnabled(data.isShared || false);
      })
      .catch(() => {
        if (!cancelled) setError('Failed to load story. Please check your connection.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [shareToken, isAuthLoading, isAuthenticated, navigate]);

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

  // Advanced reading level (and any story with layout.textInImage=false)
  // forces image-top + text-strip-below on the SAME page — matches the
  // actual print PDF. Reading-mode toggle doesn't apply to those stories.
  const forceTextBelow =
    story?.layout?.textInImage === false || story?.languageLevel === 'advanced';

  // Build dynamic page list based on which covers exist
  const pageList: PageEntry[] = story ? (() => {
    const list: PageEntry[] = [];
    const c = story.covers ?? { frontCover: true, initialPage: true, backCover: true };
    if (c.frontCover) list.push({ type: 'frontCover' });
    if (c.initialPage) list.push({ type: 'initialPage' });
    for (let i = 0; i < story.pages.length; i++) {
      // sidepage mode on desktop: text on left page, image on right page (book spread).
      // On mobile, text is rendered below the image on the same page — no extra storyText entry.
      // Advanced layout (forceTextBelow): text always lives on the image page, no storyText entry.
      if (readingMode === 'sidepage' && !isMobile && !forceTextBelow) {
        list.push({ type: 'storyText', storyPageIdx: i });
      }
      list.push({ type: 'story', storyPageIdx: i });
    }
    if (c.backCover) list.push({ type: 'backCover' });
    list.push({ type: 'endPage' });
    return list;
  })() : [];

  const totalPages = pageList.length;

  // When reading mode flips, pageList rebuilds and BookViewer remounts to the
  // equivalent entry via initialLogicalPage — but BookViewer's onPageChange
  // only fires on flip, so currentPage stays stale until the user navigates.
  // Mirror the initial-index logic here so the page counter updates immediately.
  useEffect(() => {
    const last = lastEntryRef.current;
    if (!last || pageList.length === 0) return;
    let idx = -1;
    if (last.type === 'story' || last.type === 'storyText') {
      idx = pageList.findIndex(p => p.type === 'story' && p.storyPageIdx === last.storyPageIdx);
    } else {
      idx = pageList.findIndex(p => p.type === last.type);
    }
    if (idx >= 0 && idx !== currentPage) setCurrentPage(idx);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readingMode, isMobile]);

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

  // Pre-paint state: header arrived but full story still loading. Show the
  // front cover image straight away. Painting happens within ~300 ms of
  // navigation; the BookViewer mounts in place once `story` lands a few
  // seconds later. Stays visually in the same spot to avoid layout shift.
  if (loading && header) {
    // Prefer the direct R2 URL from /header — it's the SAME url the HTML
    // <link rel="preload"> already kicked off, so the browser serves it
    // from cache instantly. Falls back to the redirect endpoint when the
    // direct URL isn't available (e.g. legacy stories with image_data
    // bytes still inline in the JSONB blob).
    const coverUrl = header.frontCoverUrl
      || (header.covers.frontCover ? `/api/shared/${shareToken}/cover-image/frontCover${tokenParam}` : null);
    return (
      <div className="h-[100dvh] overflow-hidden bg-white flex flex-col items-center justify-center p-4">
        {coverUrl ? (
          <img
            src={coverUrl}
            alt={header.title || 'Cover'}
            className="max-h-[85vh] max-w-full object-contain rounded shadow-lg"
            draggable={false}
          />
        ) : (
          <div className="text-center text-gray-500">
            <Loader2 className="w-12 h-12 animate-spin text-indigo-500 mx-auto mb-4" />
            <p>{header.title}</p>
          </div>
        )}
        <div className="mt-4 flex items-center gap-2 text-xs text-gray-500">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          <span>{language === 'de' ? 'Lade Seiten…' : language === 'fr' ? 'Chargement des pages…' : 'Loading pages…'}</span>
        </div>
      </div>
    );
  }

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

  // Reading-mode toggle — segmented control that adapts to its header:
  //   • dark (authenticated) header → white/10 base, white active pill
  //   • cream (public) header       → amber base, amber-700 active pill
  const darkHeader = isAuthenticated;
  const toggleBase = darkHeader
    ? 'bg-white/10'
    : 'bg-amber-200/50 border border-amber-300';
  const activeCls = darkHeader
    ? 'bg-white text-zinc-900 shadow'
    : 'bg-amber-700 text-white shadow';
  const inactiveCls = darkHeader
    ? 'text-white/70 hover:text-white'
    : 'text-amber-900/70 hover:text-amber-900';
  // Advanced layout: image + text-below on the same page is the only mode —
  // inline vs sidepage don't apply. Hide the toggle so users aren't offered
  // modes that wouldn't change anything.
  const readingModeToggle = forceTextBelow ? null : (
    <div className={`inline-flex rounded-full p-0.5 text-xs font-medium ${toggleBase}`} role="tablist">
      <button
        onClick={() => setReadingMode('inline')}
        title="Text printed over the image — matches the printed book"
        aria-pressed={readingMode === 'inline'}
        className={`flex items-center gap-1.5 px-2.5 sm:px-3 py-1 rounded-full transition-colors ${
          readingMode === 'inline' ? activeCls : inactiveCls
        }`}
      >
        <Eye size={13} />
        <span className="hidden sm:inline">Print preview</span>
      </button>
      <button
        onClick={() => setReadingMode('sidepage')}
        title="Text on a separate facing page — easier to read"
        aria-pressed={readingMode === 'sidepage'}
        className={`flex items-center gap-1.5 px-2.5 sm:px-3 py-1 rounded-full transition-colors ${
          readingMode === 'sidepage' ? activeCls : inactiveCls
        }`}
      >
        <BookOpen size={13} />
        <span className="hidden sm:inline">Read mode</span>
      </button>
    </div>
  );

  return (
    <div className="h-[100dvh] overflow-hidden bg-white flex flex-col" style={{ paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)' }}>
      {/* Header — single dark surface with a thin gold underline tying it to the
          book-cover accent used throughout the product. Ghost action buttons,
          one white primary (Share). */}
      {isAuthenticated ? (
        <header className="bg-zinc-900 text-white px-3 py-1.5 md:py-2.5 sticky top-0 z-10 border-b border-amber-400/60">
          <div className="flex items-center justify-between gap-2">
            {/* Left: Logo + optional title */}
            <button onClick={() => navigate('/')} className="text-sm md:text-base font-semibold whitespace-nowrap hover:opacity-80 flex items-center gap-1.5 flex-shrink-0">
              <img src="/images/logo-book.png" alt="" className="h-7 md:h-10 -my-1 md:-my-2 w-auto" />
              <span className="hidden md:inline">{t.title}</span>
            </button>

            {/* Center: reading mode toggle */}
            {readingModeToggle}

            {/* Right: story actions. Ghost style; one primary (Share) stands out. */}
            <div className="flex items-center gap-1">
              {story?.isOwner && (
                <>
                  {/* Visibility toggle — ghost, subtle status dot instead of colour fill */}
                  <button
                    onClick={toggleSharing}
                    disabled={sharingLoading}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium text-white/80 hover:text-white hover:bg-white/10 transition-colors"
                    title={sharingEnabled ? 'Public — anyone with the link can view' : 'Private — only you can view'}
                  >
                    {sharingLoading ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : sharingEnabled ? (
                      <Globe className="w-3.5 h-3.5 text-amber-300" />
                    ) : (
                      <Lock className="w-3.5 h-3.5" />
                    )}
                    <span className="hidden sm:inline">{sharingEnabled ? 'Public' : 'Private'}</span>
                  </button>

                  {/* Share — primary CTA on the dark bar */}
                  <button
                    onClick={handleShare}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 bg-white text-zinc-900 rounded-md text-xs font-semibold hover:bg-white/90 transition-colors"
                  >
                    <Share2 className="w-3.5 h-3.5" />
                    <span className="hidden sm:inline">Share</span>
                  </button>

                  {/* Edit — ghost */}
                  <Link
                    to={`/create?storyId=${story.id}`}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium text-white/80 hover:text-white hover:bg-white/10 transition-colors"
                  >
                    <Pencil className="w-3.5 h-3.5" />
                    <span className="hidden sm:inline">Edit</span>
                  </Link>
                </>
              )}

              {/* Menu — ghost */}
              <div className="relative" ref={menuRef}>
                <button
                  onClick={() => setShowMenu(!showMenu)}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium text-white/80 hover:text-white hover:bg-white/10 transition-colors"
                  aria-label="Menu"
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
        <header className="bg-gradient-to-b from-amber-50 to-amber-100/60 backdrop-blur-sm border-b-2 border-amber-400 sticky top-0 z-10">
          <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 flex-shrink-0">
              <BookOpen className="w-6 h-6 text-amber-700" />
              <span className="font-bold text-amber-900 hidden md:inline">MagicalStory</span>
            </div>
            {readingModeToggle}
            <Link
              to="/"
              className="inline-flex items-center gap-1.5 bg-amber-700 text-white px-3 sm:px-4 py-2 rounded-full text-xs sm:text-sm font-semibold hover:bg-amber-800 transition-colors flex-shrink-0 shadow-sm"
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
      <main className="flex-1 min-h-0 flex items-center justify-center px-2 md:px-4 py-1 md:py-4">
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
            initialLogicalPage={(() => {
              // Use the entry remembered from the previous mode so we land on
              // the same story page / cover instead of reusing a stale index
              // (pageList length differs between inline and sidepage modes).
              const last = lastEntryRef.current;
              if (!last) return Math.min(currentPage, Math.max(0, pageList.length - 1));
              if (last.type === 'story' || last.type === 'storyText') {
                const idx = pageList.findIndex(p => p.type === 'story' && p.storyPageIdx === last.storyPageIdx);
                if (idx >= 0) return idx;
              } else {
                const idx = pageList.findIndex(p => p.type === last.type);
                if (idx >= 0) return idx;
              }
              return Math.min(currentPage, Math.max(0, pageList.length - 1));
            })()}
            onImageClick={(url) => setFullscreenImage(url)}
            onPageChange={(idx) => {
              setCurrentPage(idx);
              // Snapshot the entry from THIS render's pageList so a subsequent
              // mode switch (which rebuilds pageList) can still find the right
              // story page in the new list.
              lastEntryRef.current = pageList[idx] ?? null;
            }}
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
      <div className="flex items-center justify-center gap-3 md:gap-4 pb-0.5">
        {/* Mobile: first page button */}
        <div className="md:hidden">
          {currentPage > 1 && (
            <button
              onClick={() => bookRef.current?.flipTo(0)}
              className="p-1.5 rounded-full bg-white shadow-md border border-indigo-200 text-indigo-400"
              aria-label="Go to first page"
            >
              <ChevronsLeft className="w-4 h-4" />
            </button>
          )}
        </div>

        {/* Mobile: prev button */}
        <button
          onClick={flipPrev}
          disabled={currentPage === 0}
          className="md:hidden p-2 rounded-full bg-white shadow-md border border-indigo-200 text-indigo-500 disabled:opacity-30 disabled:cursor-not-allowed"
          aria-label="Previous page"
        >
          <ChevronLeft className="w-5 h-5" />
        </button>

        {/* Page counter */}
        <span className="text-indigo-400 text-sm font-medium min-w-[3rem] text-center">
          {currentPage + 1} / {totalPages}
        </span>

        {/* Mobile: next button */}
        <button
          onClick={flipNext}
          disabled={currentPage >= totalPages - 1}
          className="md:hidden p-2 rounded-full bg-white shadow-md border border-indigo-200 text-indigo-500 disabled:opacity-30 disabled:cursor-not-allowed"
          aria-label="Next page"
        >
          <ChevronRight className="w-5 h-5" />
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
