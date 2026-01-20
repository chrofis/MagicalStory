import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { BookOpen, Loader2, AlertCircle, Sparkles, ChevronLeft, ChevronRight } from 'lucide-react';

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
}

export default function SharedStoryViewer() {
  const { shareToken } = useParams<{ shareToken: string }>();
  const [story, setStory] = useState<SharedStoryData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(0); // 0 = cover, 1+ = pages

  useEffect(() => {
    async function fetchStory() {
      if (!shareToken) {
        setError('Invalid share link');
        setLoading(false);
        return;
      }

      try {
        const response = await fetch(`/api/shared/${shareToken}`);
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
      } catch (err) {
        setError('Failed to load story. Please check your connection.');
      } finally {
        setLoading(false);
      }
    }

    fetchStory();
  }, [shareToken]);

  const totalPages = story ? story.pages.length + 1 : 0; // +1 for cover

  const goToPage = (page: number) => {
    if (page >= 0 && page < totalPages) {
      setCurrentPage(page);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-amber-50 to-orange-50 flex items-center justify-center">
        <div className="text-center">
          <Loader2 className="w-12 h-12 animate-spin text-amber-600 mx-auto mb-4" />
          <p className="text-amber-800">Loading story...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-amber-50 to-orange-50 flex items-center justify-center p-4">
        <div className="text-center max-w-md">
          <AlertCircle className="w-16 h-16 text-amber-500 mx-auto mb-4" />
          <h1 className="text-2xl font-bold text-amber-900 mb-2">Story Not Found</h1>
          <p className="text-amber-700 mb-6">{error}</p>
          <Link
            to="/"
            className="inline-flex items-center gap-2 bg-gradient-to-r from-amber-500 to-orange-500 text-white px-6 py-3 rounded-full font-semibold hover:from-amber-600 hover:to-orange-600 transition-all"
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
    <div className="min-h-screen bg-gradient-to-b from-amber-50 to-orange-50">
      {/* Header */}
      <header className="bg-white/80 backdrop-blur-sm border-b border-amber-200 sticky top-0 z-10">
        <div className="max-w-4xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <BookOpen className="w-6 h-6 text-amber-600" />
            <span className="font-bold text-amber-900 hidden sm:inline">MagicalStory</span>
          </div>
          <Link
            to="/"
            className="inline-flex items-center gap-1 bg-gradient-to-r from-amber-500 to-orange-500 text-white px-4 py-2 rounded-full text-sm font-semibold hover:from-amber-600 hover:to-orange-600 transition-all"
          >
            <Sparkles className="w-4 h-4" />
            Create Your Own
          </Link>
        </div>
      </header>

      {/* Story Content */}
      <main className="max-w-4xl mx-auto px-4 py-8">
        {/* Book container */}
        <div className="bg-white rounded-2xl shadow-xl overflow-hidden border-4 border-amber-200">
          {/* Cover Page */}
          {currentPage === 0 && (
            <div className="aspect-[3/4] md:aspect-[4/3] relative bg-gradient-to-br from-amber-100 to-orange-100">
              <img
                src={`/api/shared/${shareToken}/cover-image/frontCover`}
                alt="Story Cover"
                className="w-full h-full object-contain"
                onError={(e) => {
                  // Hide broken image
                  e.currentTarget.style.display = 'none';
                }}
              />
              {/* Title overlay */}
              <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/60 to-transparent p-6">
                <h1 className="text-2xl md:text-4xl font-bold text-white text-center drop-shadow-lg">
                  {story.title}
                </h1>
              </div>
            </div>
          )}

          {/* Story Pages */}
          {currentPage > 0 && story.pages[currentPage - 1] && (
            <div className="md:grid md:grid-cols-2">
              {/* Image */}
              <div className="aspect-square bg-gradient-to-br from-amber-50 to-orange-50 flex items-center justify-center">
                <img
                  src={`/api/shared/${shareToken}/image/${story.pages[currentPage - 1].pageNumber}`}
                  alt={`Page ${currentPage}`}
                  className="w-full h-full object-contain"
                  loading="lazy"
                  onError={(e) => {
                    e.currentTarget.src = '';
                    e.currentTarget.alt = 'Image not available';
                  }}
                />
              </div>
              {/* Text */}
              <div className="p-6 md:p-8 flex flex-col justify-center bg-amber-50/50">
                <p className="text-lg md:text-xl leading-relaxed text-amber-900 whitespace-pre-wrap">
                  {story.pages[currentPage - 1].text}
                </p>
                <div className="mt-4 text-right text-amber-400 text-sm">
                  Page {currentPage} of {story.pages.length}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Navigation */}
        <div className="flex items-center justify-center gap-4 mt-6">
          <button
            onClick={() => goToPage(currentPage - 1)}
            disabled={currentPage === 0}
            className="p-3 rounded-full bg-white shadow-md border border-amber-200 text-amber-600 disabled:opacity-40 disabled:cursor-not-allowed hover:bg-amber-50 transition-colors"
            aria-label="Previous page"
          >
            <ChevronLeft className="w-6 h-6" />
          </button>

          <div className="flex items-center gap-2">
            {Array.from({ length: Math.min(totalPages, 10) }).map((_, i) => {
              // Show dots for pages, with special handling for many pages
              const pageIndex = totalPages <= 10 ? i :
                i < 4 ? i :
                i === 4 ? -1 : // ellipsis
                totalPages - (9 - i);

              if (pageIndex === -1) {
                return <span key={i} className="text-amber-400">...</span>;
              }

              return (
                <button
                  key={i}
                  onClick={() => goToPage(pageIndex)}
                  className={`w-3 h-3 rounded-full transition-all ${
                    currentPage === pageIndex
                      ? 'bg-amber-500 scale-125'
                      : 'bg-amber-200 hover:bg-amber-300'
                  }`}
                  aria-label={`Go to page ${pageIndex}`}
                />
              );
            })}
          </div>

          <button
            onClick={() => goToPage(currentPage + 1)}
            disabled={currentPage >= totalPages - 1}
            className="p-3 rounded-full bg-white shadow-md border border-amber-200 text-amber-600 disabled:opacity-40 disabled:cursor-not-allowed hover:bg-amber-50 transition-colors"
            aria-label="Next page"
          >
            <ChevronRight className="w-6 h-6" />
          </button>
        </div>

        {/* Call to Action */}
        <div className="mt-12 text-center bg-gradient-to-r from-amber-100 to-orange-100 rounded-2xl p-8 border border-amber-200">
          <h2 className="text-2xl font-bold text-amber-900 mb-2">
            Love this story?
          </h2>
          <p className="text-amber-700 mb-6">
            Create your own personalized magical story in minutes!
          </p>
          <Link
            to="/"
            className="inline-flex items-center gap-2 bg-gradient-to-r from-amber-500 to-orange-500 text-white px-8 py-4 rounded-full text-lg font-bold hover:from-amber-600 hover:to-orange-600 transition-all shadow-lg hover:shadow-xl"
          >
            <Sparkles className="w-6 h-6" />
            Create Your Own Story
          </Link>
        </div>
      </main>

      {/* Footer */}
      <footer className="bg-white/60 border-t border-amber-200 py-6 mt-12">
        <div className="max-w-4xl mx-auto px-4 text-center text-amber-600 text-sm">
          Shared with love from{' '}
          <a href="https://magicalstory.ch" className="font-semibold hover:text-amber-800">
            MagicalStory.ch
          </a>
        </div>
      </footer>
    </div>
  );
}
