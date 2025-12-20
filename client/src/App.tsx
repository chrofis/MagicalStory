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
          <Route path="/admin" element={<AdminDashboard />} />
        </Routes>
      </Suspense>
    </>
  );
}

export default App;
