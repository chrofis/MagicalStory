import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Menu, LogOut, BookOpen, Settings, Users, Code, Package, CreditCard, KeyRound, Loader2 } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import { useAuth } from '@/context/AuthContext';
import { ChangePasswordModal } from '@/components/auth/ChangePasswordModal';
import { storyService } from '@/services';
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
  const { isAuthenticated, user, logout, isImpersonating } = useAuth();
  const [showMenu, setShowMenu] = useState(false);
  const [showCreditsModal, setShowCreditsModal] = useState(false);
  const [showChangePasswordModal, setShowChangePasswordModal] = useState(false);
  const [isBuyingCredits, setIsBuyingCredits] = useState(false);
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

  const handleLogout = () => {
    logout();
    setShowMenu(false);
    navigate('/');
  };

  const credits = user?.credits ?? 0;
  const isUnlimited = user?.credits === -1;

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
            <div className="absolute right-0 mt-2 bg-gray-800 rounded-lg shadow-lg overflow-hidden z-50 min-w-[200px]">
              {/* User Info Header */}
              {isAuthenticated && user && (
                <div className="border-b border-gray-700 px-4 py-3 bg-gray-900">
                  <div className="text-white font-semibold text-sm mb-1">
                    {user.username} {user.role === 'admin' && '👑'}
                  </div>
                  <div className={`text-xs px-2 py-1 rounded inline-block ${
                    isUnlimited ? 'bg-purple-600 text-white' :
                    credits === 0 ? 'bg-red-600 text-white' :
                    credits < 50 ? 'bg-yellow-600 text-white' :
                    'bg-green-600 text-white'
                  }`}>
                    {isUnlimited ? '∞' : credits} {language === 'de' ? 'Credits' : language === 'fr' ? 'crédits' : 'credits'}
                  </div>
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

                  {/* My Orders */}
                  <button
                    onClick={() => {
                      navigate('/orders');
                      setShowMenu(false);
                    }}
                    className="w-full text-left px-4 py-3 hover:bg-gray-700 text-white flex items-center gap-2 border-b border-gray-700"
                  >
                    <Package size={16} />
                    <span>{language === 'de' ? 'Meine Bestellungen' : language === 'fr' ? 'Mes commandes' : 'My Orders'}</span>
                  </button>

                  {/* Buy Credits */}
                  <button
                    onClick={() => {
                      setShowCreditsModal(true);
                      setShowMenu(false);
                    }}
                    className="w-full text-left px-4 py-3 hover:bg-gray-700 text-white flex items-center gap-2 border-b border-gray-700"
                  >
                    <CreditCard size={16} />
                    <span>{language === 'de' ? 'Credits kaufen' : language === 'fr' ? 'Acheter des crédits' : 'Buy Credits'}</span>
                  </button>

                  {/* Admin Panel (Admin or impersonating) */}
                  {(user?.role === 'admin' || isImpersonating) && (
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

                  {/* Change Password */}
                  <button
                    onClick={() => {
                      setShowChangePasswordModal(true);
                      setShowMenu(false);
                    }}
                    className="w-full text-left px-4 py-3 hover:bg-gray-700 text-white flex items-center gap-2 border-b border-gray-700"
                  >
                    <KeyRound size={16} />
                    <span>{language === 'de' ? 'Passwort ändern' : language === 'fr' ? 'Changer le mot de passe' : 'Change Password'}</span>
                  </button>

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
      </div>

      {/* Buy Credits Modal */}
      {showCreditsModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => !isBuyingCredits && setShowCreditsModal(false)}>
          <div className="bg-white rounded-lg p-6 max-w-md mx-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-xl font-bold text-gray-900 mb-4">
              {language === 'de' ? 'Credits kaufen' : language === 'fr' ? 'Acheter des credits' : 'Buy Credits'}
            </h2>

            {/* Credit Package */}
            <div className="bg-gradient-to-br from-indigo-50 to-purple-50 rounded-xl p-6 mb-6 border-2 border-indigo-200">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <CreditCard className="text-indigo-600" size={24} />
                  <span className="text-2xl font-bold text-gray-900">100</span>
                  <span className="text-gray-600">{language === 'de' ? 'Credits' : language === 'fr' ? 'credits' : 'credits'}</span>
                </div>
                <div className="text-right">
                  <span className="text-3xl font-bold text-indigo-600">CHF 5.-</span>
                </div>
              </div>
              <p className="text-sm text-gray-500">
                {language === 'de'
                  ? '100 Credits reichen fuer etwa 3-4 Geschichten'
                  : language === 'fr'
                  ? '100 credits suffisent pour environ 3-4 histoires'
                  : '100 credits are enough for about 3-4 stories'}
              </p>
            </div>

            <p className="text-sm text-gray-500 mb-4 text-center">
              {language === 'de'
                ? 'Sichere Zahlung mit Stripe'
                : language === 'fr'
                ? 'Paiement securise avec Stripe'
                : 'Secure payment with Stripe'}
            </p>

            <div className="flex gap-3">
              <button
                onClick={() => setShowCreditsModal(false)}
                disabled={isBuyingCredits}
                className="flex-1 bg-gray-200 text-gray-700 py-3 px-4 rounded-lg hover:bg-gray-300 font-semibold disabled:opacity-50"
              >
                {language === 'de' ? 'Abbrechen' : language === 'fr' ? 'Annuler' : 'Cancel'}
              </button>
              <button
                onClick={async () => {
                  setIsBuyingCredits(true);
                  try {
                    const { url } = await storyService.createCreditsCheckout(100, 500);
                    if (url) {
                      window.location.href = url;
                    }
                  } catch (error) {
                    console.error('Failed to create checkout:', error);
                    alert(language === 'de'
                      ? 'Fehler beim Erstellen der Zahlung. Bitte versuchen Sie es erneut.'
                      : language === 'fr'
                      ? 'Erreur lors de la creation du paiement. Veuillez reessayer.'
                      : 'Failed to create payment. Please try again.');
                    setIsBuyingCredits(false);
                  }
                }}
                disabled={isBuyingCredits}
                className="flex-1 bg-indigo-600 text-white py-3 px-4 rounded-lg hover:bg-indigo-700 font-semibold disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {isBuyingCredits ? (
                  <>
                    <Loader2 size={18} className="animate-spin" />
                    {language === 'de' ? 'Wird geladen...' : language === 'fr' ? 'Chargement...' : 'Loading...'}
                  </>
                ) : (
                  <>
                    {language === 'de' ? 'Jetzt kaufen' : language === 'fr' ? 'Acheter maintenant' : 'Buy Now'}
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Change Password Modal */}
      <ChangePasswordModal
        isOpen={showChangePasswordModal}
        onClose={() => setShowChangePasswordModal(false)}
      />
    </nav>
  );
}

export default Navigation;
