import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useLanguage } from '@/context/LanguageContext';
import { useAuth } from '@/context/AuthContext';
import { Sparkles, ArrowRight, Camera, Users, BookOpen, Palette, Printer, Download, ChevronDown } from 'lucide-react';
import { AuthModal } from '@/components/auth';
import { Navigation, Footer } from '@/components/common';

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
    <div className="h-screen overflow-y-auto snap-y snap-mandatory bg-gray-50">
      {/* Navigation - Fixed at top */}
      <div className="fixed top-0 left-0 right-0 z-50 bg-gray-50">
        <Navigation currentStep={0} />
      </div>

      {/* Hero Section - Full viewport height */}
      <section className="min-h-screen flex flex-col px-4 lg:px-8 pt-24 lg:pt-28 pb-6 lg:pb-8 relative snap-start">
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

        {/* Scroll indicator */}
        <div className="absolute bottom-8 left-1/2 transform -translate-x-1/2 animate-bounce hidden lg:block">
          <ChevronDown size={32} className="text-gray-400" />
        </div>
      </section>

      {/* Section 1: Create Your Characters */}
      <section className="min-h-screen py-16 lg:py-24 px-4 lg:px-8 bg-white snap-start flex flex-col justify-center">
        <div className="max-w-6xl mx-auto">
          <div className="flex flex-col lg:flex-row items-center gap-8 lg:gap-16">
            {/* Text Content */}
            <div className="w-full lg:w-1/2 order-2 lg:order-1">
              <div className="flex items-center gap-3 mb-4">
                <div className="bg-indigo-100 p-3 rounded-full">
                  <Camera className="w-6 h-6 text-indigo-600" />
                </div>
                <span className="text-indigo-600 font-semibold text-lg">Step 1</span>
              </div>
              <h2 className="text-3xl lg:text-4xl font-title text-gray-900 mb-6">
                Create Your Characters
              </h2>
              <p className="text-lg text-gray-600 mb-4">
                Upload photos of your loved ones and watch them transform into beautiful illustrated characters. Our AI analyzes each photo to capture unique features, expressions, and personality.
              </p>
              <ul className="space-y-3">
                <li className="flex items-start gap-3">
                  <Users className="w-5 h-5 text-indigo-600 mt-1 flex-shrink-0" />
                  <span className="text-gray-600">Add up to 5 characters - children, parents, grandparents, or friends</span>
                </li>
                <li className="flex items-start gap-3">
                  <Users className="w-5 h-5 text-indigo-600 mt-1 flex-shrink-0" />
                  <span className="text-gray-600">Define names, ages, and relationships between characters</span>
                </li>
                <li className="flex items-start gap-3">
                  <Users className="w-5 h-5 text-indigo-600 mt-1 flex-shrink-0" />
                  <span className="text-gray-600">Characters appear consistently throughout your entire story</span>
                </li>
              </ul>
            </div>
            {/* Image Placeholder */}
            <div className="w-full lg:w-1/2 order-1 lg:order-2">
              <div className="bg-gradient-to-br from-indigo-100 to-purple-100 rounded-2xl p-8 aspect-[4/3] flex items-center justify-center">
                <div className="text-center">
                  <Camera className="w-16 h-16 text-indigo-300 mx-auto mb-4" />
                  <p className="text-indigo-400 font-medium">[Character Creation Screenshot]</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Section 2: Tell Your Story */}
      <section className="min-h-screen py-16 lg:py-24 px-4 lg:px-8 bg-gray-50 snap-start flex flex-col justify-center">
        <div className="max-w-6xl mx-auto">
          <div className="flex flex-col lg:flex-row items-center gap-8 lg:gap-16">
            {/* Image Placeholder */}
            <div className="w-full lg:w-1/2">
              <div className="bg-gradient-to-br from-amber-100 to-orange-100 rounded-2xl p-8 aspect-[4/3] flex items-center justify-center">
                <div className="text-center">
                  <BookOpen className="w-16 h-16 text-amber-300 mx-auto mb-4" />
                  <p className="text-amber-400 font-medium">[Story Settings Screenshot]</p>
                </div>
              </div>
            </div>
            {/* Text Content */}
            <div className="w-full lg:w-1/2">
              <div className="flex items-center gap-3 mb-4">
                <div className="bg-amber-100 p-3 rounded-full">
                  <BookOpen className="w-6 h-6 text-amber-600" />
                </div>
                <span className="text-amber-600 font-semibold text-lg">Step 2</span>
              </div>
              <h2 className="text-3xl lg:text-4xl font-title text-gray-900 mb-6">
                Tell Your Story
              </h2>
              <p className="text-lg text-gray-600 mb-4">
                Choose from magical themes or describe your own adventure. Whether it's a birthday surprise, a bedtime tale, or an educational journey - you're in control of the narrative.
              </p>
              <ul className="space-y-3">
                <li className="flex items-start gap-3">
                  <BookOpen className="w-5 h-5 text-amber-600 mt-1 flex-shrink-0" />
                  <span className="text-gray-600">Select from popular themes: Adventure, Fantasy, Educational, Birthday, and more</span>
                </li>
                <li className="flex items-start gap-3">
                  <BookOpen className="w-5 h-5 text-amber-600 mt-1 flex-shrink-0" />
                  <span className="text-gray-600">Add custom story elements and personal details</span>
                </li>
                <li className="flex items-start gap-3">
                  <BookOpen className="w-5 h-5 text-amber-600 mt-1 flex-shrink-0" />
                  <span className="text-gray-600">Choose reading level from toddler-friendly to chapter books</span>
                </li>
              </ul>
            </div>
          </div>
        </div>
      </section>

      {/* Section 3: Choose Your Style */}
      <section className="min-h-screen py-16 lg:py-24 px-4 lg:px-8 bg-white snap-start flex flex-col justify-center">
        <div className="max-w-6xl mx-auto">
          <div className="flex flex-col lg:flex-row items-center gap-8 lg:gap-16">
            {/* Text Content */}
            <div className="w-full lg:w-1/2 order-2 lg:order-1">
              <div className="flex items-center gap-3 mb-4">
                <div className="bg-pink-100 p-3 rounded-full">
                  <Palette className="w-6 h-6 text-pink-600" />
                </div>
                <span className="text-pink-600 font-semibold text-lg">Step 3</span>
              </div>
              <h2 className="text-3xl lg:text-4xl font-title text-gray-900 mb-6">
                Choose Your Style
              </h2>
              <p className="text-lg text-gray-600 mb-4">
                Select from a variety of beautiful illustration styles. From whimsical watercolors to modern 3D animation - find the perfect look for your story.
              </p>
              <ul className="space-y-3">
                <li className="flex items-start gap-3">
                  <Palette className="w-5 h-5 text-pink-600 mt-1 flex-shrink-0" />
                  <span className="text-gray-600">8+ unique art styles: Pixar-style 3D, Watercolor, Comic, Anime, and more</span>
                </li>
                <li className="flex items-start gap-3">
                  <Palette className="w-5 h-5 text-pink-600 mt-1 flex-shrink-0" />
                  <span className="text-gray-600">Consistent style across all pages and characters</span>
                </li>
                <li className="flex items-start gap-3">
                  <Palette className="w-5 h-5 text-pink-600 mt-1 flex-shrink-0" />
                  <span className="text-gray-600">Choose book length: 10, 15, or 20 pages</span>
                </li>
              </ul>
            </div>
            {/* Image Placeholder */}
            <div className="w-full lg:w-1/2 order-1 lg:order-2">
              <div className="bg-gradient-to-br from-pink-100 to-rose-100 rounded-2xl p-8 aspect-[4/3] flex items-center justify-center">
                <div className="text-center">
                  <Palette className="w-16 h-16 text-pink-300 mx-auto mb-4" />
                  <p className="text-pink-400 font-medium">[Art Style Gallery]</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Section 4: Print & Share */}
      <section className="min-h-screen py-16 lg:py-24 px-4 lg:px-8 bg-gray-50 snap-start flex flex-col justify-center">
        <div className="max-w-6xl mx-auto">
          <div className="flex flex-col lg:flex-row items-center gap-8 lg:gap-16">
            {/* Image Placeholder */}
            <div className="w-full lg:w-1/2">
              <div className="bg-gradient-to-br from-emerald-100 to-teal-100 rounded-2xl p-8 aspect-[4/3] flex items-center justify-center">
                <div className="text-center">
                  <Printer className="w-16 h-16 text-emerald-300 mx-auto mb-4" />
                  <p className="text-emerald-400 font-medium">[Printed Book Photo]</p>
                </div>
              </div>
            </div>
            {/* Text Content */}
            <div className="w-full lg:w-1/2">
              <div className="flex items-center gap-3 mb-4">
                <div className="bg-emerald-100 p-3 rounded-full">
                  <Printer className="w-6 h-6 text-emerald-600" />
                </div>
                <span className="text-emerald-600 font-semibold text-lg">Step 4</span>
              </div>
              <h2 className="text-3xl lg:text-4xl font-title text-gray-900 mb-6">
                Print & Share
              </h2>
              <p className="text-lg text-gray-600 mb-4">
                Your story is ready! Download it instantly as a PDF or order a beautifully printed hardcover book delivered to your door.
              </p>
              <ul className="space-y-3">
                <li className="flex items-start gap-3">
                  <Download className="w-5 h-5 text-emerald-600 mt-1 flex-shrink-0" />
                  <span className="text-gray-600">Instant PDF download - perfect for reading on tablets or printing at home</span>
                </li>
                <li className="flex items-start gap-3">
                  <Printer className="w-5 h-5 text-emerald-600 mt-1 flex-shrink-0" />
                  <span className="text-gray-600">Premium hardcover printing - 20x20cm, professional quality</span>
                </li>
                <li className="flex items-start gap-3">
                  <Printer className="w-5 h-5 text-emerald-600 mt-1 flex-shrink-0" />
                  <span className="text-gray-600">Ships worldwide - the perfect gift for any occasion</span>
                </li>
              </ul>
            </div>
          </div>
        </div>
      </section>

      {/* Final CTA Section */}
      <section className="min-h-screen py-16 lg:py-24 px-4 lg:px-8 bg-indigo-600 snap-start flex flex-col justify-center">
        <div className="max-w-4xl mx-auto text-center">
          <h2 className="text-3xl lg:text-5xl font-title text-white mb-6">
            Ready to Create Magic?
          </h2>
          <p className="text-xl text-indigo-100 mb-8 max-w-2xl mx-auto">
            Transform your photos into a personalized storybook in minutes. Your child will be the hero of their very own adventure!
          </p>
          <button
            onClick={handleStartJourney}
            className="bg-white hover:bg-gray-100 text-indigo-600 px-10 lg:px-14 py-5 lg:py-6 rounded-xl text-xl lg:text-2xl font-bold shadow-xl hover:shadow-2xl transform hover:scale-105 transition-all inline-flex items-center gap-3"
          >
            <Sparkles size={28} />
            Start Your Story
            <ArrowRight size={28} />
          </button>
        </div>
      </section>

      {/* Footer */}
      <div className="snap-start">
        <Footer />
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
