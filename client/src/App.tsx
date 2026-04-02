import { Suspense, lazy } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { LoadingSpinner } from './components/common/LoadingSpinner';
import { ImpersonationBanner } from './components/common/ImpersonationBanner';
import { ScrollToTop } from './components/common/ScrollToTop';
import { GenerationProvider } from './context/GenerationContext';

// Lazy load pages for code splitting
const LandingPage = lazy(() => import('./pages/LandingPage'));
const WelcomePage = lazy(() => import('./pages/WelcomePage'));
const StoryWizard = lazy(() => import('./pages/StoryWizard'));
const MyStories = lazy(() => import('./pages/MyStories'));
const MyOrders = lazy(() => import('./pages/MyOrders'));
const AdminDashboard = lazy(() => import('./pages/AdminDashboard'));
const Pricing = lazy(() => import('./pages/Pricing'));
const BookBuilder = lazy(() => import('./pages/BookBuilder'));
const ResetPassword = lazy(() => import('./pages/ResetPassword'));
const EmailVerified = lazy(() => import('./pages/EmailVerified'));
const TermsOfService = lazy(() => import('./pages/TermsOfService'));
const PrivacyPolicy = lazy(() => import('./pages/PrivacyPolicy'));
const Impressum = lazy(() => import('./pages/Impressum'));
const SharedStoryViewer = lazy(() => import('./pages/SharedStoryViewer'));
const TrialWizard = lazy(() => import('./pages/TrialWizard'));
const TrialGenerationPage = lazy(() => import('./pages/TrialGenerationPage'));
const ClaimAccount = lazy(() => import('./pages/ClaimAccount'));
const HowItWorks = lazy(() => import('./pages/HowItWorks'));
const FAQ = lazy(() => import('./pages/FAQ'));
const About = lazy(() => import('./pages/About'));
const Contact = lazy(() => import('./pages/Contact'));
const Science = lazy(() => import('./pages/Science'));
const Themes = lazy(() => import('./pages/Themes'));
const ThemeCategory = lazy(() => import('./pages/ThemeCategory'));
const ThemePage = lazy(() => import('./pages/ThemePage'));
const Occasions = lazy(() => import('./pages/Occasions'));
const OccasionPage = lazy(() => import('./pages/OccasionPage'));
const GiftHub = lazy(() => import('./pages/GiftHub'));
const GiftPage = lazy(() => import('./pages/GiftPage'));
const Comparisons = lazy(() => import('./pages/Comparisons'));
const ComparisonPage = lazy(() => import('./pages/ComparisonPage'));
const CityListing = lazy(() => import('./pages/CityListing'));
const CityPage = lazy(() => import('./pages/CityPage'));

function App() {
  return (
    <GenerationProvider>
      <ScrollToTop />
      <ImpersonationBanner />
      <Suspense fallback={<LoadingSpinner fullScreen />}>
        <Routes>
          <Route path="/" element={<LandingPage />} />
          <Route path="/welcome" element={<WelcomePage />} />
          <Route path="/create/*" element={<StoryWizard />} />
          <Route path="/stories" element={<MyStories />} />
          <Route path="/orders" element={<MyOrders />} />
          <Route path="/pricing" element={<Pricing />} />
          <Route path="/book-builder" element={<BookBuilder />} />
          <Route path="/admin" element={<AdminDashboard />} />
          <Route path="/reset-password/:token" element={<ResetPassword />} />
          <Route path="/email-verified" element={<EmailVerified />} />
          <Route path="/terms" element={<TermsOfService />} />
          <Route path="/privacy" element={<PrivacyPolicy />} />
          <Route path="/impressum" element={<Impressum />} />
          <Route path="/so-funktionierts" element={<HowItWorks />} />
          <Route path="/faq" element={<FAQ />} />
          <Route path="/about" element={<About />} />
          <Route path="/contact" element={<Contact />} />
          <Route path="/science" element={<Science />} />
          <Route path="/themes" element={<Themes />} />
          <Route path="/themes/:category" element={<ThemeCategory />} />
          <Route path="/themes/:category/:themeId" element={<ThemePage />} />
          <Route path="/anlass" element={<Occasions />} />
          <Route path="/anlass/:occasionSlug" element={<OccasionPage />} />
          <Route path="/geschenk" element={<GiftHub />} />
          <Route path="/geschenk/:giftSlug" element={<GiftPage />} />
          <Route path="/vergleich" element={<Comparisons />} />
          <Route path="/vergleich/:competitorSlug" element={<ComparisonPage />} />
          <Route path="/stadt" element={<CityListing />} />
          <Route path="/stadt/:cityId" element={<CityPage />} />
          <Route path="/shared/:shareToken" element={<SharedStoryViewer />} />
          <Route path="/s/:shareToken" element={<SharedStoryViewer />} />
          <Route path="/try" element={<TrialWizard />} />
          <Route path="/trial-generation" element={<TrialGenerationPage />} />
          <Route path="/claim/:token" element={<ClaimAccount />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </GenerationProvider>
  );
}

export default App;
