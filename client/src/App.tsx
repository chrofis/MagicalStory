import { Suspense, lazy } from 'react';
import { Routes, Route } from 'react-router-dom';
import { LoadingSpinner } from './components/common/LoadingSpinner';

// Lazy load pages for code splitting
const LandingPage = lazy(() => import('./pages/LandingPage'));
const StoryWizard = lazy(() => import('./pages/StoryWizard'));
const AdminDashboard = lazy(() => import('./pages/AdminDashboard'));

function App() {
  return (
    <Suspense fallback={<LoadingSpinner fullScreen />}>
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/create/*" element={<StoryWizard />} />
        <Route path="/admin" element={<AdminDashboard />} />
      </Routes>
    </Suspense>
  );
}

export default App;
