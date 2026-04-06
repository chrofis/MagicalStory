/**
 * SSR-only app shell. Renders SEO routes with eagerly imported page components.
 *
 * Why a separate file from App.tsx?
 *  - App.tsx uses React.lazy() + Suspense for code splitting on the client.
 *  - renderToString does not support Suspense — it would force the page into
 *    client-rendered fallback. So SSR needs synchronous, statically imported
 *    page components.
 *  - We only render SEO routes here — app routes (/create, /wizard, /admin,
 *    etc.) are not pre-rendered and never reach this tree.
 *
 * Both files must keep the same route patterns and the same component output
 * for SEO routes — otherwise hydration will mismatch.
 */
import { Routes, Route, Navigate } from 'react-router-dom';
import { ScrollToTop } from './components/common/ScrollToTop';

// Static page imports (SEO-public routes only)
import LandingPage from './pages/LandingPage';
import Pricing from './pages/Pricing';
import HowItWorks from './pages/HowItWorks';
import FAQ from './pages/FAQ';
import About from './pages/About';
import Contact from './pages/Contact';
import Science from './pages/Science';
import TermsOfService from './pages/TermsOfService';
import PrivacyPolicy from './pages/PrivacyPolicy';
import Impressum from './pages/Impressum';
import Themes from './pages/Themes';
import ThemeCategory from './pages/ThemeCategory';
import ThemePage from './pages/ThemePage';
import Occasions from './pages/Occasions';
import OccasionPage from './pages/OccasionPage';
import GiftHub from './pages/GiftHub';
import GiftPage from './pages/GiftPage';
import Comparisons from './pages/Comparisons';
import ComparisonPage from './pages/ComparisonPage';
import CityListing from './pages/CityListing';
import CityPage from './pages/CityPage';

export default function SSRApp() {
  return (
    <>
      <ScrollToTop />
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/pricing" element={<Pricing />} />
        <Route path="/so-funktionierts" element={<HowItWorks />} />
        <Route path="/faq" element={<FAQ />} />
        <Route path="/about" element={<About />} />
        <Route path="/contact" element={<Contact />} />
        <Route path="/science" element={<Science />} />
        <Route path="/terms" element={<TermsOfService />} />
        <Route path="/privacy" element={<PrivacyPolicy />} />
        <Route path="/impressum" element={<Impressum />} />
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
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  );
}
