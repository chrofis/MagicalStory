import { useNavigate } from 'react-router-dom';
import { LogOut, BookOpen, Settings, Users, Package, CreditCard, KeyRound, Scale, Sparkles } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import { useAuth } from '@/context/AuthContext';
import type { Language } from '@/types/story';

interface UserMenuProps {
  onClose: () => void;
  onShowCreditsModal: () => void;
  onShowChangePasswordModal: () => void;
}

export function UserMenu({ onClose, onShowCreditsModal, onShowChangePasswordModal }: UserMenuProps) {
  const navigate = useNavigate();
  const { t, language, setLanguage } = useLanguage();
  const { isAuthenticated, user, logout, isImpersonating } = useAuth();

  const credits = user?.credits ?? 0;
  const isUnlimited = user?.credits === -1 || isImpersonating;

  const handleLogout = () => {
    logout();
    onClose();
    navigate('/');
  };

  const handleNavigate = (path: string) => {
    navigate(path);
    onClose();
  };

  const texts = {
    language: language === 'de' ? 'Sprache' : language === 'fr' ? 'Langue' : 'Language',
    credits: language === 'de' ? 'Credits' : language === 'fr' ? 'crédits' : 'credits',
    createNewStory: language === 'de' ? 'Neue Geschichte' : language === 'fr' ? 'Nouvelle histoire' : 'Create New Story',
    myStories: language === 'de' ? 'Meine Geschichten' : language === 'fr' ? 'Mes histoires' : 'My Stories',
    myOrders: language === 'de' ? 'Meine Bestellungen' : language === 'fr' ? 'Mes commandes' : 'My Orders',
    buyCredits: language === 'de' ? 'Credits kaufen' : language === 'fr' ? 'Acheter des crédits' : 'Buy Credits',
    adminPanel: language === 'de' ? 'Admin Panel' : language === 'fr' ? 'Panneau Admin' : 'Admin Panel',
    manageUsers: language === 'de' ? 'Benutzer verwalten' : language === 'fr' ? 'Gérer les utilisateurs' : 'Manage Users',
    changePassword: language === 'de' ? 'Passwort ändern' : language === 'fr' ? 'Changer le mot de passe' : 'Change Password',
    legal: language === 'de' ? 'Rechtliches' : language === 'fr' ? 'Mentions légales' : 'Legal',
    terms: language === 'de' ? 'AGB' : language === 'fr' ? 'CGU' : 'Terms',
    privacy: language === 'de' ? 'Datenschutz' : language === 'fr' ? 'Confidentialité' : 'Privacy'
  };

  return (
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
            {isUnlimited ? '∞' : credits} {texts.credits}
          </div>
        </div>
      )}

      {/* Language Selection */}
      <div className="border-b border-gray-700 px-4 py-2">
        <div className="text-xs text-gray-400 mb-2">{texts.language}</div>
        <div className="flex gap-2">
          {(['en', 'de', 'fr'] as Language[]).map((lang) => (
            <button
              key={lang}
              onClick={() => {
                setLanguage(lang);
                onClose();
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
          {/* Create New Story */}
          <button
            onClick={() => handleNavigate('/create')}
            className="w-full text-left px-4 py-3 hover:bg-gray-700 text-white flex items-center gap-2 border-b border-gray-700"
          >
            <Sparkles size={16} />
            <span>{texts.createNewStory}</span>
          </button>

          {/* My Stories */}
          <button
            onClick={() => handleNavigate('/stories')}
            className="w-full text-left px-4 py-3 hover:bg-gray-700 text-white flex items-center gap-2 border-b border-gray-700"
          >
            <BookOpen size={16} />
            <span>{texts.myStories}</span>
          </button>

          {/* My Orders */}
          <button
            onClick={() => handleNavigate('/orders')}
            className="w-full text-left px-4 py-3 hover:bg-gray-700 text-white flex items-center gap-2 border-b border-gray-700"
          >
            <Package size={16} />
            <span>{texts.myOrders}</span>
          </button>

          {/* Buy Credits */}
          <button
            onClick={() => {
              onShowCreditsModal();
              onClose();
            }}
            className="w-full text-left px-4 py-3 hover:bg-gray-700 text-white flex items-center gap-2 border-b border-gray-700"
          >
            <CreditCard size={16} />
            <span>{texts.buyCredits}</span>
          </button>

          {/* Admin Panel (Admin or impersonating) */}
          {(user?.role === 'admin' || isImpersonating) && (
            <>
              <button
                onClick={() => handleNavigate('/admin')}
                className="w-full text-left px-4 py-3 hover:bg-gray-700 text-white flex items-center gap-2 border-b border-gray-700"
              >
                <Settings size={16} />
                <span>{texts.adminPanel}</span>
              </button>
              <button
                onClick={() => handleNavigate('/admin?tab=users')}
                className="w-full text-left px-4 py-3 hover:bg-gray-700 text-white flex items-center gap-2 border-b border-gray-700"
              >
                <Users size={16} />
                <span>{texts.manageUsers}</span>
              </button>
            </>
          )}

          {/* Change Password */}
          <button
            onClick={() => {
              onShowChangePasswordModal();
              onClose();
            }}
            className="w-full text-left px-4 py-3 hover:bg-gray-700 text-white flex items-center gap-2 border-b border-gray-700"
          >
            <KeyRound size={16} />
            <span>{texts.changePassword}</span>
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
          onClick={() => handleNavigate('/?login=true')}
          className="w-full text-left px-4 py-3 hover:bg-gray-700 text-white flex items-center gap-2 border-b border-gray-700"
        >
          <LogOut size={16} />
          <span>{t.login}</span>
        </button>
      )}

      {/* Legal Links */}
      <div className="border-t border-gray-700 px-4 py-2">
        <div className="text-xs text-gray-400 mb-2 flex items-center gap-1">
          <Scale size={12} />
          {texts.legal}
        </div>
        <div className="flex flex-wrap gap-2 text-xs">
          <button onClick={() => handleNavigate('/terms')} className="text-gray-400 hover:text-white">
            {texts.terms}
          </button>
          <span className="text-gray-600">•</span>
          <button onClick={() => handleNavigate('/privacy')} className="text-gray-400 hover:text-white">
            {texts.privacy}
          </button>
          <span className="text-gray-600">•</span>
          <button onClick={() => handleNavigate('/impressum')} className="text-gray-400 hover:text-white">
            Impressum
          </button>
        </div>
      </div>
    </div>
  );
}
