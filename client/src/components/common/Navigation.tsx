import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Menu, LogOut, BookOpen, Settings, Users, Code } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import { useAuth } from '@/context/AuthContext';
import type { Language } from '@/types/story';

interface NavigationProps {
  currentStep?: number;
  onStepClick?: (step: number) => void;
  canAccessStep?: (step: number) => boolean;
  developerMode?: boolean;
  onDeveloperModeChange?: (enabled: boolean) => void;
}

export function Navigation({ currentStep = 0, onStepClick, canAccessStep, developerMode = false, onDeveloperModeChange }: NavigationProps) {
  const navigate = useNavigate();
  const { t, language, setLanguage } = useLanguage();
  const { isAuthenticated, user, logout } = useAuth();
  const [showMenu, setShowMenu] = useState(false);

  const handleLogout = () => {
    logout();
    setShowMenu(false);
    navigate('/');
  };

  const remaining = user ? (user.storyQuota === -1 ? null : user.storyQuota - user.storiesGenerated) : null;
  const total = user?.storyQuota;
  const isUnlimited = user?.storyQuota === -1;

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

        {/* Quota Display (when on landing page) */}
        {currentStep === 0 && isAuthenticated && user && !isUnlimited && remaining !== null && (
          <div className={`px-3 py-1 rounded text-xs font-semibold ${
            remaining === 0 ? 'bg-red-600 text-white' :
            remaining === 1 ? 'bg-yellow-600 text-white' :
            'bg-green-600 text-white'
          }`}>
            {remaining} / {total} stories
          </div>
        )}

        {/* Developer Mode Toggle - Admin only */}
        {isAuthenticated && user?.role === 'admin' && onDeveloperModeChange && (
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

        {/* Right: Menu Button */}
        <div className="relative">
          <button
            onClick={() => setShowMenu(!showMenu)}
            className="bg-gray-800 text-white px-3 py-1.5 rounded text-xs font-semibold hover:bg-gray-700 flex items-center gap-2"
          >
            <Menu size={16} />
            <span className="hidden md:inline">Menu</span>
          </button>

          {showMenu && (
            <div className="absolute right-0 mt-2 bg-gray-800 rounded-lg shadow-lg overflow-hidden z-50 min-w-[200px]">
              {/* User Info Header */}
              {isAuthenticated && user && (
                <div className="border-b border-gray-700 px-4 py-3 bg-gray-900">
                  <div className="text-white font-semibold text-sm mb-1">
                    {user.username} {user.role === 'admin' && '👑'}
                  </div>
                  {!isUnlimited && remaining !== null && (
                    <div className={`text-xs px-2 py-1 rounded inline-block ${
                      remaining === 0 ? 'bg-red-600 text-white' :
                      remaining === 1 ? 'bg-yellow-600 text-white' :
                      'bg-green-600 text-white'
                    }`}>
                      {remaining} / {total} {language === 'de' ? 'Geschichten' : language === 'fr' ? 'histoires' : 'stories'}
                    </div>
                  )}
                </div>
              )}

              {/* Language Selection */}
              <div className="border-b border-gray-700 px-4 py-2">
                <div className="text-xs text-gray-400 mb-2">
                  {language === 'de' ? 'Sprache' : language === 'fr' ? 'Langue' : 'Language'}
                </div>
                <div className="flex gap-2">
                  {(['en', 'de', 'fr'] as Language[]).map((lang) => (
                    <button
                      key={lang}
                      onClick={() => {
                        setLanguage(lang);
                        setShowMenu(false);
                      }}
                      className={`flex-1 px-3 py-2 rounded text-xs font-semibold ${
                        language === lang
                          ? 'bg-indigo-600 text-white'
                          : 'bg-gray-700 text-white hover:bg-gray-600'
                      }`}
                    >
                      {lang.toUpperCase()}
                    </button>
                  ))}
                </div>
              </div>

              {isAuthenticated && (
                <>
                  {/* My Stories */}
                  <button
                    onClick={() => {
                      navigate('/stories');
                      setShowMenu(false);
                    }}
                    className="w-full text-left px-4 py-3 hover:bg-gray-700 text-white flex items-center gap-2 border-b border-gray-700"
                  >
                    <BookOpen size={16} />
                    <span>{language === 'de' ? 'Meine Geschichten' : language === 'fr' ? 'Mes histoires' : 'My Stories'}</span>
                  </button>

                  {/* Admin Panel (Admin only) */}
                  {user?.role === 'admin' && (
                    <>
                      <button
                        onClick={() => {
                          navigate('/admin');
                          setShowMenu(false);
                        }}
                        className="w-full text-left px-4 py-3 hover:bg-gray-700 text-white flex items-center gap-2 border-b border-gray-700"
                      >
                        <Settings size={16} />
                        <span>{language === 'de' ? 'Admin Panel' : language === 'fr' ? 'Panneau Admin' : 'Admin Panel'}</span>
                      </button>
                      <button
                        onClick={() => {
                          navigate('/admin?tab=users');
                          setShowMenu(false);
                        }}
                        className="w-full text-left px-4 py-3 hover:bg-gray-700 text-white flex items-center gap-2 border-b border-gray-700"
                      >
                        <Users size={16} />
                        <span>{language === 'de' ? 'Benutzer verwalten' : language === 'fr' ? 'Gérer les utilisateurs' : 'Manage Users'}</span>
                      </button>
                    </>
                  )}

                  {/* Logout */}
                  <button
                    onClick={handleLogout}
                    className="w-full text-left px-4 py-3 hover:bg-gray-700 text-white flex items-center gap-2"
                  >
                    <LogOut size={16} />
                    <span>{t.logout}</span>
                  </button>
                </>
              )}

              {!isAuthenticated && (
                <button
                  onClick={() => {
                    navigate('/?login=true');
                    setShowMenu(false);
                  }}
                  className="w-full text-left px-4 py-3 hover:bg-gray-700 text-white flex items-center gap-2"
                >
                  <LogOut size={16} />
                  <span>{t.login}</span>
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </nav>
  );
}

export default Navigation;
