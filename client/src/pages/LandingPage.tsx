import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useLanguage } from '@/context/LanguageContext';
import { useAuth } from '@/context/AuthContext';
import { Sparkles, ArrowRight } from 'lucide-react';
import { AuthModal } from '@/components/auth';
import { Navigation } from '@/components/common';

export default function LandingPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { t, language } = useLanguage();
  const { isAuthenticated } = useAuth();
  const [showAuthModal, setShowAuthModal] = useState(false);

  // Check for login query param
  useEffect(() => {
    if (searchParams.get('login') === 'true') {
      setShowAuthModal(true);
    }
  }, [searchParams]);

  const handleStartJourney = () => {
    if (isAuthenticated) {
      navigate('/create');
    } else {
      setShowAuthModal(true);
    }
  };

  const handleAuthSuccess = () => {
    // Check for redirect parameter (e.g., from email link when not logged in)
    // Ignore '/' as a redirect - we want to go to /create after login, not stay on home
    const redirectParam = searchParams.get('redirect');
    const redirectUrl = redirectParam && redirectParam !== '/' && redirectParam !== '%2F'
      ? decodeURIComponent(redirectParam)
      : null;
    if (redirectUrl) {
      navigate(redirectUrl);
    } else {
      navigate('/create');
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      {/* Navigation */}
      <Navigation currentStep={0} />

      {/* Main Content */}
      <div className="flex flex-col flex-1 px-4 lg:px-8 py-6 lg:py-8 relative">
        <div className="flex flex-col lg:flex-row gap-6 lg:gap-12 w-full relative z-10 flex-1 items-center">
          {/* Left Side - Text and Button */}
          <div className="w-full lg:w-[35%] flex flex-col justify-center">
            <div>
              <h1 className="text-4xl lg:text-6xl font-title text-black mb-4 lg:mb-6 leading-tight">
                {t.heroTitle}
              </h1>
              <p className="text-lg lg:text-2xl font-body text-black mb-3 lg:mb-4">
                {t.heroDescription}
              </p>
              <p className="text-lg lg:text-2xl font-body text-black mb-6 lg:mb-8">
                {t.bookText}
              </p>

              {/* Button directly below text */}
              <button
                onClick={handleStartJourney}
                className="bg-indigo-600 hover:bg-indigo-700 text-white px-8 lg:px-12 py-4 lg:py-6 rounded-xl text-lg lg:text-2xl font-bold shadow-xl hover:shadow-2xl transform hover:scale-105 transition-all inline-flex items-center gap-3"
              >
                <Sparkles size={28} />
                {t.startJourney}
                <ArrowRight size={28} />
              </button>
            </div>
          </div>

          {/* Right Side - Photos and Video */}
          <div className="w-full lg:w-[65%] flex items-center relative">
            {/* Decorative Sparkles - Hidden on mobile, only in right area */}
            <div className="hidden lg:block absolute top-4 right-8 text-3xl opacity-50 animate-pulse z-20">✨</div>
            <div className="hidden lg:block absolute top-1/4 left-4 text-3xl opacity-50 animate-pulse z-20" style={{animationDelay: '1s'}}>✨</div>
            <div className="hidden lg:block absolute bottom-8 right-1/4 text-3xl opacity-50 animate-pulse z-20" style={{animationDelay: '1.5s'}}>✨</div>
            <div className="hidden lg:block absolute bottom-1/3 left-1/3 text-3xl opacity-50 animate-pulse z-20" style={{animationDelay: '2s'}}>✨</div>

            <div className="flex flex-row gap-3 lg:gap-6 items-center justify-center w-full">
              {/* Photos Column - Stacked Vertically */}
              <div className="flex flex-col gap-2 lg:gap-4 w-1/4 lg:w-[28%]">
                {/* Real Photo */}
                <div className="text-center">
                  <div className="mb-1 lg:mb-2">
                    <img src="/images/Real person.jpg" alt="Your Picture" className="w-full h-auto object-contain rounded-lg max-h-[100px] lg:max-h-[180px]" />
                  </div>
                  <p className="text-xs lg:text-base text-black font-semibold">
                    {language === 'de' ? 'Dein Foto' : language === 'fr' ? 'Votre Photo' : 'Your Picture'}
                  </p>
                </div>

                {/* Arrow Down */}
                <div className="flex justify-center my-1 lg:my-2">
                  <img src="/images/arrow-icon-1162.png" alt="Arrow Down" className="w-6 h-6 lg:w-12 lg:h-12" style={{transform: 'rotate(90deg)'}} />
                </div>

                {/* Avatar */}
                <div className="text-center">
                  <div className="mb-1 lg:mb-2">
                    <img src="/images/Avatar.jpg" alt="Your Character" className="w-full h-auto object-contain rounded-lg max-h-[100px] lg:max-h-[180px]" />
                  </div>
                  <p className="text-xs lg:text-base text-black font-semibold">
                    {language === 'de' ? 'Dein Charakter' : language === 'fr' ? 'Votre Personnage' : 'Your Character'}
                  </p>
                </div>
              </div>

              {/* Arrow Right - Hidden on mobile */}
              <div className="hidden lg:flex justify-center items-center lg:w-[8%] self-center">
                <img src="/images/arrow-icon-1162.png" alt="Arrow Right" className="w-14 h-14 lg:w-16 lg:h-16" />
              </div>

              {/* Video Column */}
              <div className="text-center w-3/4 lg:w-[64%]">
                <div className="rounded-xl overflow-hidden shadow-2xl mb-1 lg:mb-2 h-[280px] lg:h-[480px]">
                  <video
                    autoPlay
                    loop
                    muted
                    playsInline
                    poster="/images/video-poster.jpg"
                    className="w-full h-full object-cover"
                  >
                    <source src="/images/Boy to pirat to book.mp4" type="video/mp4" />
                    Your browser does not support the video tag.
                  </video>
                </div>
                <p className="text-xs lg:text-base text-black font-semibold">
                  {language === 'de' ? 'Deine Geschichte' : language === 'fr' ? 'Votre Histoire' : 'Your Story'}
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Auth Modal */}
      <AuthModal
        isOpen={showAuthModal}
        onClose={() => setShowAuthModal(false)}
        onSuccess={handleAuthSuccess}
        redirectUrl={(() => {
          const redirect = searchParams.get('redirect');
          // Ignore '/' as redirect - always go to /create after login
          return (redirect && redirect !== '/' && redirect !== '%2F')
            ? decodeURIComponent(redirect)
            : '/create';
        })()}
      />
    </div>
  );
}
