import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Menu, Code } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import { useAuth } from '@/context/AuthContext';
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

export function Navigation({ currentStep = 0, onStepClick, canAccessStep, developerMode = false, onDeveloperModeChange }: NavigationProps) {
  const navigate = useNavigate();
  const { t, language } = useLanguage();
  const { isAuthenticated, user, isImpersonating } = useAuth();
  const [showMenu, setShowMenu] = useState(false);
  const [showCreditsModal, setShowCreditsModal] = useState(false);
  const [showChangePasswordModal, setShowChangePasswordModal] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

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
          <div className="flex items-center gap-0.5 md:gap-1 flex-1 justify-center">
            {[1, 2, 3, 4, 5].map(s => {
              const canAccess = canAccessStep(s);
              return (
                <div key={s} className="flex items-center">
                  <button
                    onClick={() => canAccess && onStepClick(s)}
                    disabled={!canAccess}
                    className={`w-5 h-5 md:w-6 md:h-6 rounded-full flex items-center justify-center text-[10px] md:text-xs font-bold transition-all ${
                      canAccess
                        ? currentStep === s
                          ? 'bg-indigo-600 text-white ring-1 ring-indigo-200'
                          : 'bg-indigo-500 text-white hover:bg-indigo-600 cursor-pointer hover:scale-110'
                        : 'bg-gray-600 text-gray-400 cursor-not-allowed'
                    }`}
                  >
                    {s}
                  </button>
                  {s < 5 && <div className={`w-3 md:w-6 h-0.5 ${canAccess ? 'bg-indigo-500' : 'bg-gray-600'}`} />}
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
