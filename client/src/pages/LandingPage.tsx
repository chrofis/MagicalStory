import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useLanguage } from '@/context/LanguageContext';
import { useAuth } from '@/context/AuthContext';
import { Sparkles, ArrowRight, Camera, Users, BookOpen, Palette, Printer, Download, ChevronDown } from 'lucide-react';
import { AuthModal } from '@/components/auth';
import { Navigation, Footer } from '@/components/common';
import { storyService } from '@/services';

// Scroll indicator component - subtle dots on the right
function ScrollIndicator({ activeIndex, totalSections, onDotClick }: {
  activeIndex: number;
  totalSections: number;
  onDotClick: (index: number) => void;
}) {
  return (
    <div className="fixed right-4 top-1/2 -translate-y-1/2 z-40 hidden md:flex flex-col gap-2">
      {Array.from({ length: totalSections }).map((_, index) => (
        <button
          key={index}
          onClick={() => onDotClick(index)}
          className={`w-2 h-2 rounded-full transition-all duration-300 ${
            index === activeIndex
              ? 'bg-indigo-600 scale-125'
              : 'bg-gray-300 hover:bg-gray-400'
          }`}
          aria-label={`Go to section ${index + 1}`}
        />
      ))}
    </div>
  );
}

const sectionTranslations = {
  en: {
    // Section 1: Characters
    step1: 'Step 1',
    createCharacters: 'Create Your Characters',
    createCharactersDesc: 'Upload photos of your loved ones and watch them transform into beautiful illustrated characters. Our AI analyzes each photo to capture unique features, expressions, and personality.',
    addFamily: 'Add your whole family - children, parents, grandparents, or friends',
    defineNames: 'Define names, ages, and relationships between characters',
    consistentCharacters: 'Characters appear consistently throughout your entire story',
    // Section 2: Story
    step2: 'Step 2',
    tellStory: 'Tell Your Story',
    tellStoryDesc: "Choose from magical themes or describe your own adventure. Whether it's a birthday surprise, a bedtime tale, or an educational journey - you're in control of the narrative.",
    selectThemes: 'Select from popular themes: Adventure, Fantasy, Educational, Birthday, and more',
    customElements: 'Add custom story elements and personal details',
    readingLevel: "Adjust reading level to match your child's age",
    // Section 3: Style
    step3: 'Step 3',
    chooseStyle: 'Choose Your Style',
    chooseStyleDesc: 'Select from a variety of beautiful illustration styles. From delicate watercolors to bold 3D animation - find the perfect look for your story.',
    artStyles: '8+ unique art styles: Pixar-style 3D, Watercolor, Comic, Anime, and more',
    consistentStyle: 'Consistent style across all pages and characters',
    bookLength: 'Choose your preferred book length - from short stories to longer adventures',
    // Section 4: Print
    step4: 'Step 4',
    printShare: 'Print & Share',
    printShareDesc: 'Your story is ready! Download it instantly as a PDF or order a beautifully printed book delivered to your door.',
    pdfDownload: 'Instant PDF download - perfect for reading on tablets or printing at home',
    printOptions: 'Hardcover or softcover printing - 20x20cm, professional quality',
    shipping: 'Ships within Switzerland - the perfect gift for any occasion',
    // CTA
    readyToCreate: 'Ready to Create Magic?',
    ctaDesc: 'Transform your photos into a personalized storybook in minutes. Your child will be the hero of their very own adventure!',
  },
  de: {
    // Section 1: Characters
    step1: 'Schritt 1',
    createCharacters: 'Erstelle deine Charaktere',
    createCharactersDesc: 'Lade Fotos deiner Liebsten hoch und sieh zu, wie sie sich in wunderschön illustrierte Charaktere verwandeln. Unsere KI analysiert jedes Foto, um einzigartige Merkmale, Ausdrücke und Persönlichkeit einzufangen.',
    addFamily: 'Füge deine ganze Familie hinzu - Kinder, Eltern, Grosseltern oder Freunde',
    defineNames: 'Definiere Namen, Alter und Beziehungen zwischen den Charakteren',
    consistentCharacters: 'Charaktere erscheinen einheitlich in der gesamten Geschichte',
    // Section 2: Story
    step2: 'Schritt 2',
    tellStory: 'Erzähle deine Geschichte',
    tellStoryDesc: 'Wähle aus magischen Themen oder beschreibe dein eigenes Abenteuer. Ob Geburtstagsüberraschung, Gute-Nacht-Geschichte oder Lernreise - du bestimmst die Handlung.',
    selectThemes: 'Wähle aus beliebten Themen: Abenteuer, Fantasy, Lerngeschichten, Geburtstag und mehr',
    customElements: 'Füge eigene Story-Elemente und persönliche Details hinzu',
    readingLevel: 'Passe das Leseniveau an das Alter deines Kindes an',
    // Section 3: Style
    step3: 'Schritt 3',
    chooseStyle: 'Wähle deinen Stil',
    chooseStyleDesc: 'Wähle aus einer Vielzahl schöner Illustrationsstile. Von zarten Aquarellen bis zu kräftiger 3D-Animation - finde den perfekten Look für deine Geschichte.',
    artStyles: '8+ einzigartige Kunststile: Pixar-ähnliches 3D, Aquarell, Comic, Anime und mehr',
    consistentStyle: 'Einheitlicher Stil auf allen Seiten und bei allen Charakteren',
    bookLength: 'Wähle deine bevorzugte Buchlänge - von kurzen Geschichten bis zu längeren Abenteuern',
    // Section 4: Print
    step4: 'Schritt 4',
    printShare: 'Drucken & Teilen',
    printShareDesc: 'Deine Geschichte ist fertig! Lade sie sofort als PDF herunter oder bestelle ein wunderschön gedrucktes Buch direkt zu dir nach Hause.',
    pdfDownload: 'Sofortiger PDF-Download - perfekt zum Lesen auf Tablets oder zum Ausdrucken zu Hause',
    printOptions: 'Hardcover oder Softcover Druck - 20x20cm, professionelle Qualität',
    shipping: 'Versand innerhalb der Schweiz - das perfekte Geschenk für jeden Anlass',
    // CTA
    readyToCreate: 'Bereit, Magie zu erschaffen?',
    ctaDesc: 'Verwandle deine Fotos in Minuten in ein personalisiertes Geschichtenbuch. Dein Kind wird der Held seines eigenen Abenteuers!',
  },
  fr: {
    // Section 1: Characters
    step1: 'Étape 1',
    createCharacters: 'Créez vos personnages',
    createCharactersDesc: "Téléchargez des photos de vos proches et regardez-les se transformer en magnifiques personnages illustrés. Notre IA analyse chaque photo pour capter les traits uniques, les expressions et la personnalité.",
    addFamily: 'Ajoutez toute votre famille - les enfants, parents, grands-parents ou amis',
    defineNames: 'Définissez les noms, âges et relations entre les personnages',
    consistentCharacters: 'Les personnages apparaissent de manière cohérente tout au long de votre histoire',
    // Section 2: Story
    step2: 'Étape 2',
    tellStory: 'Racontez votre histoire',
    tellStoryDesc: "Choisissez parmi des thèmes magiques ou décrivez votre propre aventure. Que ce soit une surprise d'anniversaire, l'histoire du soir ou un voyage éducatif - vous contrôlez le récit.",
    selectThemes: "Sélectionnez parmi les thèmes populaires : aventure, fantasy, éducatif, anniversaire, et plus",
    customElements: 'Ajoutez des éléments personnalisés et des détails personnels',
    readingLevel: "Ajustez le niveau de lecture à l'âge de votre enfant",
    // Section 3: Style
    step3: 'Étape 3',
    chooseStyle: 'Choisissez votre style',
    chooseStyleDesc: "Sélectionnez parmi une variété de beaux styles d'illustration. De l'aquarelle délicate à l'animation 3D audacieuse - trouvez le look parfait pour votre histoire.",
    artStyles: "8+ styles artistiques uniques : 3D style Pixar, aquarelle, bande dessinée, anime, et plus",
    consistentStyle: 'Style cohérent sur toutes les pages et personnages',
    bookLength: 'Choisissez la longueur de livre souhaitée - des histoires courtes aux aventures plus longues',
    // Section 4: Print
    step4: 'Étape 4',
    printShare: 'Imprimez & Partagez',
    printShareDesc: "Votre histoire est prête ! Téléchargez-la instantanément en PDF ou commandez un beau livre imprimé livré à votre porte.",
    pdfDownload: "Téléchargement PDF instantané - parfait pour lire sur tablette ou imprimer à la maison",
    printOptions: 'Impression reliée ou brochée - 20x20cm, qualité professionnelle',
    shipping: 'Livraison en Suisse - le cadeau parfait pour toute occasion',
    // CTA
    readyToCreate: 'Prêt à créer de la magie ?',
    ctaDesc: "Transformez vos photos en livre d'histoires personnalisé en quelques minutes. Votre enfant sera le héros de sa propre aventure !",
  },
};

export default function LandingPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { t, language } = useLanguage();
  const { isAuthenticated } = useAuth();
  const [showAuthModal, setShowAuthModal] = useState(false);
  const st = sectionTranslations[language] || sectionTranslations.en;

  // Scroll indicator state
  const [activeSection, setActiveSection] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const sectionRefs = useRef<(HTMLElement | null)[]>([]);
  const TOTAL_SECTIONS = 6;

  // Track scroll position with IntersectionObserver
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            const index = sectionRefs.current.indexOf(entry.target as HTMLElement);
            if (index !== -1) {
              setActiveSection(index);
            }
          }
        });
      },
      {
        root: container,
        threshold: 0.5,
      }
    );

    sectionRefs.current.forEach((section) => {
      if (section) observer.observe(section);
    });

    return () => observer.disconnect();
  }, []);

  // Handle dot click to scroll to section
  const handleDotClick = useCallback((index: number) => {
    const section = sectionRefs.current[index];
    if (section) {
      section.scrollIntoView({ behavior: 'smooth' });
    }
  }, []);

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

  const handleAuthSuccess = async () => {
    // Check for redirect parameter (e.g., from email link when not logged in)
    // Ignore '/' as a redirect - we want to go to /create after login, not stay on home
    const redirectParam = searchParams.get('redirect');
    let redirectUrl = redirectParam && redirectParam !== '/' && redirectParam !== '%2F'
      ? decodeURIComponent(redirectParam)
      : null;

    // Strip any login=true from the redirect URL to avoid redirect loops
    if (redirectUrl && redirectUrl.includes('login=true')) {
      try {
        const url = new URL(redirectUrl, window.location.origin);
        url.searchParams.delete('login');
        // If it's just the home page with no meaningful path, use the inner redirect
        const innerRedirect = url.searchParams.get('redirect');
        if (url.pathname === '/' && innerRedirect) {
          redirectUrl = decodeURIComponent(innerRedirect);
        } else {
          redirectUrl = url.pathname + url.search;
        }
      } catch {
        // If URL parsing fails, try to extract path
        const match = redirectUrl.match(/redirect=([^&]+)/);
        if (match) {
          redirectUrl = decodeURIComponent(match[1]);
        }
      }
    }

    console.log('[AUTH SUCCESS] Starting redirect logic', { redirectUrl, redirectParam });

    if (redirectUrl && redirectUrl !== '/' && !redirectUrl.includes('login=true')) {
      console.log('[AUTH SUCCESS] Redirecting to URL param:', redirectUrl);
      navigate(redirectUrl);
    } else {
      // Check if user has any stories - redirect accordingly
      try {
        const { pagination } = await storyService.getStories({ limit: 1 });
        console.log('[AUTH SUCCESS] Stories count:', pagination.total);
        if (pagination.total > 0) {
          // Existing user with stories → go to My Stories
          console.log('[AUTH SUCCESS] Has stories, going to /stories');
          navigate('/stories');
        } else {
          // New user without stories
          // Check if they've completed onboarding (photoConsentAt is set)
          // Need to re-fetch user data since auth just completed
          const quotaResponse = await fetch(`${import.meta.env.VITE_API_URL || ''}/api/user/quota`, {
            headers: { 'Authorization': `Bearer ${localStorage.getItem('auth_token')}` }
          });
          const quotaData = await quotaResponse.json();
          console.log('[AUTH SUCCESS] Quota data:', quotaData);

          // If user hasn't consented to photo terms yet, show welcome page
          if (!quotaData.photoConsentAt) {
            console.log('[AUTH SUCCESS] No consent, going to /welcome');
            navigate('/welcome');
          } else {
            console.log('[AUTH SUCCESS] Has consent, going to /create');
            navigate('/create');
          }
        }
      } catch (error) {
        // On error, default to welcome page for new users
        console.error('[AUTH SUCCESS] Error:', error);
        navigate('/welcome');
      }
    }
  };

  return (
    <div ref={containerRef} className="h-screen overflow-y-auto snap-y snap-mandatory bg-gray-50">
      {/* Scroll Indicator */}
      <ScrollIndicator
        activeIndex={activeSection}
        totalSections={TOTAL_SECTIONS}
        onDotClick={handleDotClick}
      />

      {/* Navigation - Fixed at top */}
      <div className="fixed top-0 left-0 right-0 z-50 bg-gray-50">
        <Navigation currentStep={0} />
      </div>

      {/* Hero Section - Full viewport height */}
      <section ref={(el) => { sectionRefs.current[0] = el; }} className="min-h-screen flex flex-col px-4 lg:px-8 pt-24 lg:pt-28 pb-6 lg:pb-8 relative snap-start">
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
      <section ref={(el) => { sectionRefs.current[1] = el; }} className="min-h-screen pt-20 lg:py-24 px-4 lg:px-8 bg-white snap-start flex flex-col justify-center">
        <div className="max-w-6xl mx-auto">
          <div className="flex flex-col lg:flex-row items-center gap-8 lg:gap-16">
            {/* Text Content - First on mobile */}
            <div className="w-full lg:w-1/2 order-1 lg:order-1 min-h-[70vh] lg:min-h-0 flex flex-col justify-center pt-8 pb-4 lg:py-0">
              <div className="flex items-center gap-3 mb-4">
                <div className="bg-indigo-100 p-3 rounded-full">
                  <Camera className="w-6 h-6 text-indigo-600" />
                </div>
                <span className="text-indigo-600 font-semibold text-lg">{st.step1}</span>
              </div>
              <h2 className="text-3xl lg:text-4xl font-title text-gray-900 mb-6">
                {st.createCharacters}
              </h2>
              <p className="text-lg text-gray-600 mb-4">
                {st.createCharactersDesc}
              </p>
              <ul className="space-y-3">
                <li className="flex items-start gap-3">
                  <Users className="w-5 h-5 text-indigo-600 mt-1 flex-shrink-0" />
                  <span className="text-gray-600">{st.addFamily}</span>
                </li>
                <li className="flex items-start gap-3">
                  <Users className="w-5 h-5 text-indigo-600 mt-1 flex-shrink-0" />
                  <span className="text-gray-600">{st.defineNames}</span>
                </li>
                <li className="flex items-start gap-3">
                  <Users className="w-5 h-5 text-indigo-600 mt-1 flex-shrink-0" />
                  <span className="text-gray-600">{st.consistentCharacters}</span>
                </li>
              </ul>
            </div>
            {/* Image - Second on mobile, peeks from below */}
            <div className="w-full lg:w-1/2 order-2 lg:order-2 lg:min-h-0 flex items-center pb-8 lg:py-0">
              <img
                src={`/images/landing-characters-${language}.jpg`}
                alt={st.createCharacters}
                className="w-full h-auto rounded-2xl shadow-lg"
              />
            </div>
          </div>
        </div>
      </section>

      {/* Section 2: Tell Your Story */}
      <section ref={(el) => { sectionRefs.current[2] = el; }} className="min-h-screen pt-20 lg:py-24 px-4 lg:px-8 bg-gray-50 snap-start flex flex-col justify-center">
        <div className="max-w-6xl mx-auto">
          <div className="flex flex-col lg:flex-row items-center gap-8 lg:gap-16">
            {/* Text Content - First on mobile */}
            <div className="w-full lg:w-1/2 order-1 lg:order-2 min-h-[70vh] lg:min-h-0 flex flex-col justify-center pt-8 pb-4 lg:py-0">
              <div className="flex items-center gap-3 mb-4">
                <div className="bg-amber-100 p-3 rounded-full">
                  <BookOpen className="w-6 h-6 text-amber-600" />
                </div>
                <span className="text-amber-600 font-semibold text-lg">{st.step2}</span>
              </div>
              <h2 className="text-3xl lg:text-4xl font-title text-gray-900 mb-6">
                {st.tellStory}
              </h2>
              <p className="text-lg text-gray-600 mb-4">
                {st.tellStoryDesc}
              </p>
              <ul className="space-y-3">
                <li className="flex items-start gap-3">
                  <BookOpen className="w-5 h-5 text-amber-600 mt-1 flex-shrink-0" />
                  <span className="text-gray-600">{st.selectThemes}</span>
                </li>
                <li className="flex items-start gap-3">
                  <BookOpen className="w-5 h-5 text-amber-600 mt-1 flex-shrink-0" />
                  <span className="text-gray-600">{st.customElements}</span>
                </li>
                <li className="flex items-start gap-3">
                  <BookOpen className="w-5 h-5 text-amber-600 mt-1 flex-shrink-0" />
                  <span className="text-gray-600">{st.readingLevel}</span>
                </li>
              </ul>
            </div>
            {/* Image - Second on mobile, peeks from below */}
            <div className="w-full lg:w-1/2 order-2 lg:order-1 lg:min-h-0 flex items-center pb-8 lg:py-0">
              <img
                src="/images/landing-story.jpg"
                alt={st.tellStory}
                className="w-full h-auto rounded-2xl shadow-lg"
              />
            </div>
          </div>
        </div>
      </section>

      {/* Section 3: Choose Your Style */}
      <section ref={(el) => { sectionRefs.current[3] = el; }} className="min-h-screen pt-20 lg:py-24 px-4 lg:px-8 bg-white snap-start flex flex-col justify-center">
        <div className="max-w-6xl mx-auto">
          <div className="flex flex-col lg:flex-row items-center gap-8 lg:gap-16">
            {/* Text Content - First on mobile */}
            <div className="w-full lg:w-1/2 order-1 lg:order-1 min-h-[70vh] lg:min-h-0 flex flex-col justify-center pt-8 pb-4 lg:py-0">
              <div className="flex items-center gap-3 mb-4">
                <div className="bg-pink-100 p-3 rounded-full">
                  <Palette className="w-6 h-6 text-pink-600" />
                </div>
                <span className="text-pink-600 font-semibold text-lg">{st.step3}</span>
              </div>
              <h2 className="text-3xl lg:text-4xl font-title text-gray-900 mb-6">
                {st.chooseStyle}
              </h2>
              <p className="text-lg text-gray-600 mb-4">
                {st.chooseStyleDesc}
              </p>
              <ul className="space-y-3">
                <li className="flex items-start gap-3">
                  <Palette className="w-5 h-5 text-pink-600 mt-1 flex-shrink-0" />
                  <span className="text-gray-600">{st.artStyles}</span>
                </li>
                <li className="flex items-start gap-3">
                  <Palette className="w-5 h-5 text-pink-600 mt-1 flex-shrink-0" />
                  <span className="text-gray-600">{st.consistentStyle}</span>
                </li>
                <li className="flex items-start gap-3">
                  <Palette className="w-5 h-5 text-pink-600 mt-1 flex-shrink-0" />
                  <span className="text-gray-600">{st.bookLength}</span>
                </li>
              </ul>
            </div>
            {/* Image - Second on mobile, peeks from below */}
            <div className="w-full lg:w-1/2 order-2 lg:order-2 lg:min-h-0 flex items-center pb-8 lg:py-0">
              <img
                src="/images/landing-styles.jpg"
                alt={st.chooseStyle}
                className="w-full h-auto rounded-2xl shadow-lg"
              />
            </div>
          </div>
        </div>
      </section>

      {/* Section 4: Print & Share */}
      <section className="min-h-screen pt-20 lg:py-24 px-4 lg:px-8 bg-gray-50 snap-start flex flex-col justify-center">
        <div className="max-w-6xl mx-auto">
          <div className="flex flex-col lg:flex-row items-center gap-8 lg:gap-16">
            {/* Text Content - First on mobile */}
            <div className="w-full lg:w-1/2 order-1 lg:order-2 min-h-[70vh] lg:min-h-0 flex flex-col justify-center pt-8 pb-4 lg:py-0">
              <div className="flex items-center gap-3 mb-4">
                <div className="bg-emerald-100 p-3 rounded-full">
                  <Printer className="w-6 h-6 text-emerald-600" />
                </div>
                <span className="text-emerald-600 font-semibold text-lg">{st.step4}</span>
              </div>
              <h2 className="text-3xl lg:text-4xl font-title text-gray-900 mb-6">
                {st.printShare}
              </h2>
              <p className="text-lg text-gray-600 mb-4">
                {st.printShareDesc}
              </p>
              <ul className="space-y-3">
                <li className="flex items-start gap-3">
                  <Download className="w-5 h-5 text-emerald-600 mt-1 flex-shrink-0" />
                  <span className="text-gray-600">{st.pdfDownload}</span>
                </li>
                <li className="flex items-start gap-3">
                  <Printer className="w-5 h-5 text-emerald-600 mt-1 flex-shrink-0" />
                  <span className="text-gray-600">{st.printOptions}</span>
                </li>
                <li className="flex items-start gap-3">
                  <Printer className="w-5 h-5 text-emerald-600 mt-1 flex-shrink-0" />
                  <span className="text-gray-600">{st.shipping}</span>
                </li>
              </ul>
            </div>
            {/* Image - Second on mobile, peeks from below */}
            <div className="w-full lg:w-1/2 order-2 lg:order-1 lg:min-h-0 flex items-center pb-8 lg:py-0">
              <img
                src="/images/landing-print.jpg"
                alt={st.printShare}
                className="w-full h-auto rounded-2xl shadow-lg"
              />
            </div>
          </div>
        </div>
      </section>

      {/* Final CTA Section */}
      <section className="min-h-screen py-16 lg:py-24 px-4 lg:px-8 bg-indigo-600 snap-start flex flex-col justify-center">
        <div className="max-w-4xl mx-auto text-center">
          <h2 className="text-3xl lg:text-5xl font-title text-white mb-6">
            {st.readyToCreate}
          </h2>
          <p className="text-xl text-indigo-100 mb-8 max-w-2xl mx-auto">
            {st.ctaDesc}
          </p>
          <button
            onClick={handleStartJourney}
            className="bg-white hover:bg-gray-100 text-indigo-600 px-8 lg:px-12 py-4 lg:py-6 rounded-xl text-lg lg:text-2xl font-bold shadow-xl hover:shadow-2xl transform hover:scale-105 transition-all inline-flex items-center gap-3"
          >
            <Sparkles size={28} />
            {t.startJourney}
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
