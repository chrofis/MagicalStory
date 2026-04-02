import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { useLanguage } from '@/context/LanguageContext';
import { Sparkles, ArrowRight, Camera, Users, BookOpen, Palette, Printer, Download, ChevronDown, Heart } from 'lucide-react';
import { AuthModal } from '@/components/auth';
import { Navigation, Footer, Button } from '@/components/common';
import { storyService } from '@/services';

const sectionTranslations = {
  en: {
    // Section 1: Characters
    step1: 'Step 1',
    createCharacters: 'Create Your Characters',
    createCharactersDesc: 'Upload photos of your family and watch them appear as illustrated characters throughout the story. Each character keeps their unique look on every page.',
    addFamily: 'Add your whole family - children, parents, grandparents, or friends',
    defineNames: 'Define names, ages, and relationships between characters',
    consistentCharacters: 'Characters appear consistently throughout your entire story',
    // Section 2: Story
    step2: 'Step 2',
    tellStory: 'Tell Your Story',
    tellStoryDesc: "Choose from 170+ themes or describe your own adventure — from pirates to the first day of school. You're in full control: edit any text and shape every illustration exactly the way you want it.",
    selectThemes: 'Adventure, fantasy, birthday, bedtime stories, life challenges, and more',
    customElements: 'Edit text freely — every page, every word',
    readingLevel: 'Shape images to your vision — change scenes, adjust style, refine details',
    // Section 3: Style
    step3: 'Step 3',
    chooseStyle: 'Choose Your Style',
    chooseStyleDesc: 'Pick the illustration style that fits your story. Watercolor, 3D animation, comic, anime — each style is applied consistently across all pages.',
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
    giftGuideLink: 'Browse gift ideas by age & occasion',
    // Why It Works
    whyTitle: 'Why lecture when you can tell a story?',
    whyDesc: "Children don't learn from nagging — they learn from stories they love. A story about brushing teeth inspires more than any argument. And when they're the hero? They can't wait to do it themselves.",
    whyLink: 'Learn why it works',
    // CTA
    readyToCreate: 'Ready to create your book?',
    ctaDesc: 'Upload a photo, pick an adventure, and your personalized story is ready in under 3 minutes.',
  },
  de: {
    // Section 1: Characters
    step1: 'Schritt 1',
    createCharacters: 'Erstelle deine Charaktere',
    createCharactersDesc: 'Lade Fotos deiner Familie hoch und sieh sie als illustrierte Figuren in der ganzen Geschichte. Jede Figur behält ihr einzigartiges Aussehen auf jeder Seite.',
    addFamily: 'Füge deine ganze Familie hinzu - Kinder, Eltern, Grosseltern oder Freunde',
    defineNames: 'Definiere Namen, Alter und Beziehungen zwischen den Charakteren',
    consistentCharacters: 'Charaktere erscheinen einheitlich in der gesamten Geschichte',
    // Section 2: Story
    step2: 'Schritt 2',
    tellStory: 'Erzähle deine Geschichte',
    tellStoryDesc: 'Wähle aus 170+ Themen oder beschreibe dein eigenes Abenteuer — von Piraten bis zum ersten Schultag. Du hast die volle Kontrolle: Passe jeden Text an und gestalte jedes Bild genau so, wie du es dir vorstellst.',
    selectThemes: 'Abenteuer, Fantasy, Geburtstag, Gute-Nacht-Geschichten, Herausforderungen und mehr',
    customElements: 'Texte frei bearbeiten — jede Seite, jedes Wort',
    readingLevel: 'Bilder anpassen — Szene verändern, Stil wechseln, Details verfeinern',
    // Section 3: Style
    step3: 'Schritt 3',
    chooseStyle: 'Wähle deinen Stil',
    chooseStyleDesc: 'Wähle den Illustrationsstil, der zu deiner Geschichte passt. Aquarell, 3D-Animation, Comic, Anime — jeder Stil wird einheitlich auf allen Seiten angewendet.',
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
    giftGuideLink: 'Geschenkideen nach Alter & Anlass entdecken',
    // Why It Works
    whyTitle: 'Eine Geschichte bewirkt mehr als tausend Ermahnungen.',
    whyDesc: 'Kinder lernen nicht durch Schimpfen — sie lernen durch Geschichten, die sie lieben. Eine Geschichte übers Zähneputzen bewirkt mehr als jede Diskussion. Und wenn sie selbst der Held sind? Können sie es kaum erwarten, es nachzumachen.',
    whyLink: 'Erfahre warum es wirkt',
    // CTA
    readyToCreate: 'Bereit für dein eigenes Buch?',
    ctaDesc: 'Lade ein Foto hoch, wähle ein Abenteuer und deine personalisierte Geschichte ist in unter 3 Minuten fertig.',
  },
  fr: {
    // Section 1: Characters
    step1: 'Étape 1',
    createCharacters: 'Créez vos personnages',
    createCharactersDesc: "Téléchargez des photos de votre famille et retrouvez-les comme personnages illustrés tout au long de l'histoire. Chaque personnage garde son apparence unique sur chaque page.",
    addFamily: 'Ajoutez toute votre famille - les enfants, parents, grands-parents ou amis',
    defineNames: 'Définissez les noms, âges et relations entre les personnages',
    consistentCharacters: 'Les personnages apparaissent de manière cohérente tout au long de votre histoire',
    // Section 2: Story
    step2: 'Étape 2',
    tellStory: 'Racontez votre histoire',
    tellStoryDesc: "Choisissez parmi 170+ thèmes ou décrivez votre propre aventure — des pirates au premier jour d'école. Vous avez le contrôle total : modifiez chaque texte et façonnez chaque illustration exactement comme vous le souhaitez.",
    selectThemes: 'Aventure, fantasy, anniversaire, histoires du soir, défis de la vie, et plus',
    customElements: 'Modifiez les textes librement — chaque page, chaque mot',
    readingLevel: 'Façonnez les images — changez la scène, ajustez le style, affinez les détails',
    // Section 3: Style
    step3: 'Étape 3',
    chooseStyle: 'Choisissez votre style',
    chooseStyleDesc: "Choisissez le style d'illustration qui correspond à votre histoire. Aquarelle, animation 3D, bande dessinée, anime — chaque style est appliqué de manière cohérente sur toutes les pages.",
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
    giftGuideLink: 'Idées cadeaux par âge et occasion',
    // Why It Works
    whyTitle: 'Pourquoi sermonner quand on peut raconter une histoire ?',
    whyDesc: "Les enfants n'apprennent pas par les sermons — ils apprennent par les histoires qu'ils aiment. Une histoire sur le brossage des dents inspire plus que n'importe quelle discussion. Et quand ils sont le héros ? Ils ont hâte de le faire eux-mêmes.",
    whyLink: 'Découvrez pourquoi ça marche',
    // CTA
    readyToCreate: 'Prêt à créer votre livre ?',
    ctaDesc: "Téléchargez une photo, choisissez une aventure et votre histoire personnalisée est prête en moins de 3 minutes.",
  },
};

export default function LandingPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { t, language } = useLanguage();
  const [showAuthModal, setShowAuthModal] = useState(() => searchParams.get('signup') === 'true');
  const st = sectionTranslations[language] || sectionTranslations.en;


  // Check for login query param
  useEffect(() => {
    if (searchParams.get('login') === 'true') {
      setShowAuthModal(true);
    }
  }, [searchParams]);

  const handleStartJourney = () => {
    navigate('/try');
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
    <div className="bg-stone-50">

      {/* Navigation - Fixed at top */}
      <div className="fixed top-0 left-0 right-0 z-50 bg-stone-50">
        <Navigation currentStep={0} />
      </div>

      {/* Hero Section - Full viewport height */}
      <section className="min-h-screen flex flex-col px-4 lg:px-8 pt-24 lg:pt-28 pb-6 lg:pb-8 relative">
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
              <Button
                onClick={handleStartJourney}
                size="xl"
                icon={Sparkles}
                className="font-bold"
              >
                {t.startJourney}
                <ArrowRight size={24} />
              </Button>
              <div className="mt-4">
                <button
                  onClick={() => setShowAuthModal(true)}
                  className="text-indigo-500 hover:text-indigo-800 text-sm font-medium underline"
                >
                  {t.alreadyHaveAccount || 'Already have an account? Log in'}
                </button>
              </div>
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
          <ChevronDown size={32} className="text-stone-400" />
        </div>
      </section>

      {/* Why It Works */}
      <section className="py-16 lg:py-24 px-4 lg:px-8 bg-white">
        <div className="max-w-6xl mx-auto">
          <div className="flex flex-col lg:flex-row items-center gap-8 lg:gap-16">
            {/* Image - Left on desktop */}
            <div className="w-full lg:w-1/2 order-2 lg:order-1 flex items-center">
              <video
                src="/images/landing-why-it-works.mp4"
                autoPlay
                loop
                muted
                playsInline
                className="w-full h-auto rounded-2xl shadow-lg"
              />
            </div>
            {/* Text Content - Right on desktop */}
            <div className="w-full lg:w-1/2 order-1 lg:order-2">
              <div className="flex items-center gap-3 mb-4">
                <div className="bg-indigo-100 p-3 rounded-full">
                  <Heart className="w-6 h-6 text-indigo-500" />
                </div>
              </div>
              <h2 className="text-3xl lg:text-4xl font-title text-stone-900 mb-6">
                {st.whyTitle}
              </h2>
              <p className="text-lg text-stone-600 mb-4">
                {st.whyDesc}
              </p>
              <Link
                to="/science"
                className="inline-flex items-center gap-1 mt-2 text-indigo-500 hover:text-indigo-800 font-medium text-sm"
              >
                {st.whyLink} <ArrowRight size={16} />
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* Section 1: Create Your Characters */}
      <section className="py-16 lg:py-24 px-4 lg:px-8 bg-white">
        <div className="max-w-6xl mx-auto">
          <div className="flex flex-col lg:flex-row items-center gap-8 lg:gap-16">
            {/* Text Content - First on mobile */}
            <div className="w-full lg:w-1/2 order-1 lg:order-1">
              <div className="flex items-center gap-3 mb-4">
                <div className="bg-indigo-100 p-3 rounded-full">
                  <Camera className="w-6 h-6 text-indigo-500" />
                </div>
                <span className="text-indigo-500 font-semibold text-lg">{st.step1}</span>
              </div>
              <h2 className="text-3xl lg:text-4xl font-title text-stone-900 mb-6">
                {st.createCharacters}
              </h2>
              <p className="text-lg text-stone-600 mb-4">
                {st.createCharactersDesc}
              </p>
              <ul className="space-y-3">
                <li className="flex items-start gap-3">
                  <Users className="w-5 h-5 text-indigo-500 mt-1 flex-shrink-0" />
                  <span className="text-stone-600">{st.addFamily}</span>
                </li>
                <li className="flex items-start gap-3">
                  <Users className="w-5 h-5 text-indigo-500 mt-1 flex-shrink-0" />
                  <span className="text-stone-600">{st.defineNames}</span>
                </li>
                <li className="flex items-start gap-3">
                  <Users className="w-5 h-5 text-indigo-500 mt-1 flex-shrink-0" />
                  <span className="text-stone-600">{st.consistentCharacters}</span>
                </li>
              </ul>
            </div>
            {/* Image - Second on mobile, peeks from below */}
            <div className="w-full lg:w-1/2 order-2 lg:order-2 flex items-center">
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
      <section className="py-16 lg:py-24 px-4 lg:px-8 bg-stone-50">
        <div className="max-w-6xl mx-auto">
          <div className="flex flex-col lg:flex-row items-center gap-8 lg:gap-16">
            {/* Text Content - First on mobile */}
            <div className="w-full lg:w-1/2 order-1 lg:order-2">
              <div className="flex items-center gap-3 mb-4">
                <div className="bg-indigo-100 p-3 rounded-full">
                  <BookOpen className="w-6 h-6 text-indigo-500" />
                </div>
                <span className="text-indigo-500 font-semibold text-lg">{st.step2}</span>
              </div>
              <h2 className="text-3xl lg:text-4xl font-title text-stone-900 mb-6">
                {st.tellStory}
              </h2>
              <p className="text-lg text-stone-600 mb-4">
                {st.tellStoryDesc}
              </p>
              <ul className="space-y-3">
                <li className="flex items-start gap-3">
                  <BookOpen className="w-5 h-5 text-indigo-500 mt-1 flex-shrink-0" />
                  <span className="text-stone-600">{st.selectThemes}</span>
                </li>
                <li className="flex items-start gap-3">
                  <Heart className="w-5 h-5 text-indigo-500 mt-1 flex-shrink-0" />
                  <span className="text-stone-600">{st.customElements}</span>
                </li>
                <li className="flex items-start gap-3">
                  <BookOpen className="w-5 h-5 text-indigo-500 mt-1 flex-shrink-0" />
                  <span className="text-stone-600">{st.readingLevel}</span>
                </li>
              </ul>
              <Link
                to="/themes"
                className="inline-flex items-center gap-1 mt-4 text-indigo-500 hover:text-indigo-800 font-medium text-sm"
              >
                {language === 'de' ? 'Alle Themen entdecken' : language === 'fr' ? 'Découvrir tous les thèmes' : 'Browse all themes'} <ArrowRight size={16} />
              </Link>
            </div>
            {/* Image - Second on mobile, peeks from below */}
            <div className="w-full lg:w-1/2 order-2 lg:order-1 flex items-center">
              <img
                src="/images/landing-tell-your-story.jpg"
                alt={st.tellStory}
                className="w-full h-auto rounded-2xl shadow-lg"
              />
            </div>
          </div>
        </div>
      </section>

      {/* Section 3: Choose Your Style */}
      <section className="py-16 lg:py-24 px-4 lg:px-8 bg-white">
        <div className="max-w-6xl mx-auto">
          <div className="flex flex-col lg:flex-row items-center gap-8 lg:gap-16">
            {/* Text Content - First on mobile */}
            <div className="w-full lg:w-1/2 order-1 lg:order-1">
              <div className="flex items-center gap-3 mb-4">
                <div className="bg-indigo-100 p-3 rounded-full">
                  <Palette className="w-6 h-6 text-indigo-500" />
                </div>
                <span className="text-indigo-500 font-semibold text-lg">{st.step3}</span>
              </div>
              <h2 className="text-3xl lg:text-4xl font-title text-stone-900 mb-6">
                {st.chooseStyle}
              </h2>
              <p className="text-lg text-stone-600 mb-4">
                {st.chooseStyleDesc}
              </p>
              <ul className="space-y-3">
                <li className="flex items-start gap-3">
                  <Palette className="w-5 h-5 text-indigo-500 mt-1 flex-shrink-0" />
                  <span className="text-stone-600">{st.artStyles}</span>
                </li>
                <li className="flex items-start gap-3">
                  <Palette className="w-5 h-5 text-indigo-500 mt-1 flex-shrink-0" />
                  <span className="text-stone-600">{st.consistentStyle}</span>
                </li>
                <li className="flex items-start gap-3">
                  <Palette className="w-5 h-5 text-indigo-500 mt-1 flex-shrink-0" />
                  <span className="text-stone-600">{st.bookLength}</span>
                </li>
              </ul>
            </div>
            {/* Image - Second on mobile, peeks from below */}
            <div className="w-full lg:w-1/2 order-2 lg:order-2 flex items-center">
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
      <section className="py-16 lg:py-24 px-4 lg:px-8 bg-stone-50">
        <div className="max-w-6xl mx-auto">
          <div className="flex flex-col lg:flex-row items-center gap-8 lg:gap-16">
            {/* Text Content - First on mobile */}
            <div className="w-full lg:w-1/2 order-1 lg:order-2">
              <div className="flex items-center gap-3 mb-4">
                <div className="bg-indigo-100 p-3 rounded-full">
                  <Printer className="w-6 h-6 text-indigo-500" />
                </div>
                <span className="text-indigo-500 font-semibold text-lg">{st.step4}</span>
              </div>
              <h2 className="text-3xl lg:text-4xl font-title text-stone-900 mb-6">
                {st.printShare}
              </h2>
              <p className="text-lg text-stone-600 mb-4">
                {st.printShareDesc}
              </p>
              <ul className="space-y-3">
                <li className="flex items-start gap-3">
                  <Download className="w-5 h-5 text-indigo-500 mt-1 flex-shrink-0" />
                  <span className="text-stone-600">{st.pdfDownload}</span>
                </li>
                <li className="flex items-start gap-3">
                  <Printer className="w-5 h-5 text-indigo-500 mt-1 flex-shrink-0" />
                  <span className="text-stone-600">{st.printOptions}</span>
                </li>
                <li className="flex items-start gap-3">
                  <Printer className="w-5 h-5 text-indigo-500 mt-1 flex-shrink-0" />
                  <span className="text-stone-600">{st.shipping}</span>
                </li>
              </ul>
              <Link
                to="/geschenk"
                className="inline-flex items-center gap-1 mt-4 text-indigo-500 hover:text-indigo-800 font-medium text-sm"
              >
                {st.giftGuideLink} <ArrowRight size={16} />
              </Link>
            </div>
            {/* Image - Second on mobile, peeks from below */}
            <div className="w-full lg:w-1/2 order-2 lg:order-1 flex items-center">
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
      <section className="py-16 lg:py-24 px-4 lg:px-8 bg-indigo-500">
        <div className="max-w-4xl mx-auto text-center">
          <h2 className="text-3xl lg:text-5xl font-title text-white mb-6">
            {st.readyToCreate}
          </h2>
          <p className="text-xl text-indigo-100 mb-8 max-w-2xl mx-auto">
            {st.ctaDesc}
          </p>
          <button
            onClick={handleStartJourney}
            className="inline-flex items-center justify-center gap-2 rounded-lg font-bold transition-all duration-200 transform hover:scale-[1.02] px-8 py-4 text-lg lg:px-10 lg:py-5 lg:text-xl bg-white hover:bg-stone-100 text-indigo-500 shadow-lg hover:shadow-xl"
          >
            <Sparkles size={24} />
            {t.startJourney}
            <ArrowRight size={24} />
          </button>
          <div className="mt-4">
            <button
              onClick={() => setShowAuthModal(true)}
              className="text-indigo-200 hover:text-white text-sm font-medium underline"
            >
              {t.alreadyHaveAccount || 'Already have an account? Log in'}
            </button>
          </div>
        </div>
      </section>

      {/* Footer */}
      <div>
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
