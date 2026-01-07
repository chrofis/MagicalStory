import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Menu, Code, Sparkles, Loader2 } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import { useAuth } from '@/context/AuthContext';
import { useGenerationOptional } from '@/context/GenerationContext';
import { ChangePasswordModal } from '@/components/auth/ChangePasswordModal';
import { CreditsModal } from './CreditsModal';
import { UserMenu } from './UserMenu';

interface NavigationProps {
  currentStep?: number;
  onStepClick?: (step: number) => void;
  canAccessStep?: (step: number) => boolean;
  developerMode?: boolean;
  onDeveloperModeChange?: (enabled: boolean) => void;
}

// Step labels for desktop view
const stepLabels: Record<string, Record<number, string>> = {
  en: { 1: 'Characters', 2: 'Book', 3: 'Story', 4: 'Style', 5: 'Summary' },
  de: { 1: 'Figuren', 2: 'Buch', 3: 'Story', 4: 'Stil', 5: 'Übersicht' },
  fr: { 1: 'Personnages', 2: 'Livre', 3: 'Histoire', 4: 'Style', 5: 'Résumé' },
};

export function Navigation({ currentStep = 0, onStepClick, canAccessStep, developerMode = false, onDeveloperModeChange }: NavigationProps) {
  const navigate = useNavigate();
  const { t, language } = useLanguage();
  const { isAuthenticated, user, isImpersonating } = useAuth();
  const generation = useGenerationOptional();
  const [showMenu, setShowMenu] = useState(false);
  const [showCreditsModal, setShowCreditsModal] = useState(false);
  const [showChangePasswordModal, setShowChangePasswordModal] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Handle viewing completed story
  const handleViewCompletedStory = () => {
    if (generation?.completedStoryId) {
      generation.markCompletionViewed();
      navigate(`/create?storyId=${generation.completedStoryId}`);
    }
  };

  // Handle clicking on generation progress indicator
  const handleViewProgress = () => {
    navigate('/create');
  };

  // Check if generation is in progress (has active job and not complete)
  const isGenerationInProgress = generation?.activeJob && !generation?.isComplete && !generation?.error;

  // Close menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setShowMenu(false);
      }
    };

    if (showMenu) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [showMenu]);

  return (
    <nav className="bg-black text-white px-3 py-3">
      <div className="flex justify-between items-center">
        {/* Left: Title */}
        <div className="flex-shrink-0">
          <button onClick={() => navigate('/')} className="text-sm md:text-base font-bold whitespace-nowrap hover:opacity-80">
            ✨ {t.title}
          </button>
        </div>

        {/* Center: Step Navigation */}
        {currentStep > 0 && onStepClick && canAccessStep && (
          <div className="flex items-center flex-1 justify-center">
            {[1, 2, 3, 4, 5].map(s => {
              const canAccess = canAccessStep(s);
              const isActive = currentStep === s;
              const labels = stepLabels[language] || stepLabels.en;
              return (
                <div key={s} className="flex items-center">
                  <div className="flex flex-col items-center">
                    <button
                      onClick={() => canAccess && onStepClick(s)}
                      disabled={!canAccess}
                      className={`w-5 h-5 md:w-7 md:h-7 rounded-full flex items-center justify-center text-[10px] md:text-xs font-bold transition-all ${
                        canAccess
                          ? isActive
                            ? 'bg-indigo-500 text-white ring-2 ring-white scale-110 shadow-lg shadow-indigo-500/50'
                            : 'bg-indigo-600 text-white hover:bg-indigo-500 cursor-pointer hover:scale-110'
                          : 'bg-gray-600 text-gray-400 cursor-not-allowed'
                      }`}
                    >
                      {s}
                    </button>
                    {/* Desktop: show label below step */}
                    <span className={`hidden md:block text-[10px] mt-0.5 transition-all ${
                      isActive ? 'text-white font-semibold' : 'text-gray-400'
                    }`}>
                      {labels[s]}
                    </span>
                  </div>
                  {s < 5 && <div className={`w-3 md:w-4 h-0.5 self-start mt-2.5 md:mt-3.5 mx-0.5 md:mx-1 ${canAccess ? 'bg-indigo-500' : 'bg-gray-600'}`} />}
                </div>
              );
            })}
          </div>
        )}

        {/* Right side: DEV toggle + Menu */}
        <div className="flex items-center gap-3">
          {/* Developer Mode Toggle - Admin or impersonating */}
          {isAuthenticated && (user?.role === 'admin' || isImpersonating) && onDeveloperModeChange && (
            <button
              onClick={() => onDeveloperModeChange(!developerMode)}
              className={`px-2 py-1 rounded text-xs font-semibold flex items-center gap-1 transition-colors ${
                developerMode
                  ? 'bg-yellow-500 text-black'
                  : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
              }`}
              title={language === 'de' ? 'Entwicklermodus' : language === 'fr' ? 'Mode développeur' : 'Developer Mode'}
            >
              <Code size={14} />
              <span className="hidden md:inline">DEV</span>
            </button>
          )}

          {/* Generation In Progress Indicator */}
          {isGenerationInProgress && (
            <button
              onClick={handleViewProgress}
              className="bg-indigo-600 text-white px-3 py-1.5 rounded text-xs font-semibold hover:bg-indigo-700 flex items-center gap-2"
              title={language === 'de' ? 'Geschichte wird erstellt...' : language === 'fr' ? 'Création en cours...' : 'Creating story...'}
            >
              <Loader2 size={14} className="animate-spin" />
              <span className="hidden md:inline">
                {generation?.progress ? `${Math.round((generation.progress.current / generation.progress.total) * 100)}%` : '...'}
              </span>
            </button>
          )}

          {/* Story Ready Badge */}
          {generation?.hasUnviewedCompletion && (
            <button
              onClick={handleViewCompletedStory}
              className="bg-green-500 text-white px-3 py-1.5 rounded text-xs font-semibold hover:bg-green-600 flex items-center gap-2 animate-pulse"
              title={language === 'de' ? 'Geschichte fertig!' : language === 'fr' ? 'Histoire terminée!' : 'Story ready!'}
            >
              <Sparkles size={14} />
              <span className="hidden md:inline">
                {language === 'de' ? 'Fertig!' : language === 'fr' ? 'Terminé!' : 'Ready!'}
              </span>
            </button>
          )}

          {/* Menu Button */}
          <div className="relative" ref={menuRef}>
            <button
              onClick={() => setShowMenu(!showMenu)}
              className="bg-gray-800 text-white px-3 py-1.5 rounded text-xs font-semibold hover:bg-gray-700 flex items-center gap-2"
            >
              <Menu size={16} />
              <span className="hidden md:inline">Menu</span>
            </button>

            {showMenu && (
              <UserMenu
                onClose={() => setShowMenu(false)}
                onShowCreditsModal={() => setShowCreditsModal(true)}
                onShowChangePasswordModal={() => setShowChangePasswordModal(true)}
              />
            )}
          </div>
        </div>
      </div>

      {/* Buy Credits Modal */}
      <CreditsModal
        isOpen={showCreditsModal}
        onClose={() => setShowCreditsModal(false)}
      />

      {/* Change Password Modal */}
      <ChangePasswordModal
        isOpen={showChangePasswordModal}
        onClose={() => setShowChangePasswordModal(false)}
      />
    </nav>
  );
}

export default Navigation;
