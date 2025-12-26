import { Suspense, lazy } from 'react';
import { Routes, Route } from 'react-router-dom';
import { LoadingSpinner } from './components/common/LoadingSpinner';
import { ImpersonationBanner } from './components/common/ImpersonationBanner';

// Lazy load pages for code splitting
const LandingPage = lazy(() => import('./pages/LandingPage'));
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

function App() {
  return (
    <>
      <ImpersonationBanner />
      <Suspense fallback={<LoadingSpinner fullScreen />}>
        <Routes>
          <Route path="/" element={<LandingPage />} />
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
        </Routes>
      </Suspense>
    </>
  );
}

export default App;
