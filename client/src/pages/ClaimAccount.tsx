import { useState, useEffect, FormEvent } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useLanguage } from '@/context/LanguageContext';
import { KeyRound, Loader2, CheckCircle, XCircle } from 'lucide-react';
import { GoogleIcon } from '@/components/auth/GoogleIcon';
import { signInWithGoogle, getIdToken } from '@/services/firebase';

const API_URL = import.meta.env.VITE_API_URL || '';

const translations = {
  en: {
    brand: 'Magical Story',
    loading: 'Validating your link...',
    welcomeBack: 'Welcome back',
    setPassword: 'Set a password to keep your account.',
    password: 'New password',
    confirmPassword: 'Confirm password',
    submit: 'Set Password & Log In',
    passwordTooShort: 'Password must be at least 6 characters',
    passwordsMismatch: 'Passwords do not match',
    orGoogle: 'Or sign in with Google',
    googleButton: 'Continue with Google',
    invalidTitle: 'Invalid or Expired Link',
    invalidDesc: 'This claim link is invalid or has expired. You can still log in to your account if you have a password set.',
    goToLogin: 'Go to Login',
    successTitle: 'Account claimed!',
    successDesc: 'You\'re now logged in. Redirecting to your stories...',
    error: 'Something went wrong. Please try again.',
  },
  de: {
    brand: 'Magical Story',
    loading: 'Dein Link wird überprüft...',
    welcomeBack: 'Willkommen zurück',
    setPassword: 'Lege ein Passwort fest, um dein Konto zu sichern.',
    password: 'Neues Passwort',
    confirmPassword: 'Passwort bestätigen',
    submit: 'Passwort setzen & Anmelden',
    passwordTooShort: 'Passwort muss mindestens 6 Zeichen lang sein',
    passwordsMismatch: 'Passwörter stimmen nicht überein',
    orGoogle: 'Oder mit Google anmelden',
    googleButton: 'Weiter mit Google',
    invalidTitle: 'Ungültiger oder abgelaufener Link',
    invalidDesc: 'Dieser Link ist ungültig oder abgelaufen. Du kannst dich trotzdem anmelden, wenn du ein Passwort hast.',
    goToLogin: 'Zur Anmeldung',
    successTitle: 'Konto beansprucht!',
    successDesc: 'Du bist jetzt eingeloggt. Weiterleitung zu deinen Geschichten...',
    error: 'Etwas ist schiefgelaufen. Bitte versuche es erneut.',
  },
  fr: {
    brand: 'Magical Story',
    loading: 'Validation de votre lien...',
    welcomeBack: 'Bon retour',
    setPassword: 'Définissez un mot de passe pour sécuriser votre compte.',
    password: 'Nouveau mot de passe',
    confirmPassword: 'Confirmer le mot de passe',
    submit: 'Définir le mot de passe et se connecter',
    passwordTooShort: 'Le mot de passe doit contenir au moins 6 caractères',
    passwordsMismatch: 'Les mots de passe ne correspondent pas',
    orGoogle: 'Ou connectez-vous avec Google',
    googleButton: 'Continuer avec Google',
    invalidTitle: 'Lien invalide ou expiré',
    invalidDesc: 'Ce lien est invalide ou a expiré. Vous pouvez toujours vous connecter si vous avez un mot de passe.',
    goToLogin: 'Aller à la connexion',
    successTitle: 'Compte revendiqué !',
    successDesc: 'Vous êtes maintenant connecté. Redirection vers vos histoires...',
    error: 'Quelque chose s\'est mal passé. Veuillez réessayer.',
  },
};

type PageState = 'loading' | 'form' | 'invalid' | 'success' | 'error';

export default function ClaimAccount() {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const { language } = useLanguage();
  const t = translations[language as keyof typeof translations] || translations.en;

  const [pageState, setPageState] = useState<PageState>('loading');
  const [userEmail, setUserEmail] = useState('');
  const [userName, setUserName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  // ── Validate claim token on mount ───────────────────────────────────────────

  useEffect(() => {
    if (!token) {
      setPageState('invalid');
      return;
    }

    const validateToken = async () => {
      try {
        const response = await fetch(`${API_URL}/api/trial/claim/${token}`);
        const data = await response.json();

        if (!response.ok) {
          setPageState('invalid');
          return;
        }

        setUserEmail(data.email || '');
        setUserName(data.username || data.email || '');
        setPageState('form');
      } catch {
        setPageState('invalid');
      }
    };

    validateToken();
  }, [token]);

  // ── Password submit ─────────────────────────────────────────────────────────

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');

    if (password.length < 6) {
      setError(t.passwordTooShort);
      return;
    }

    if (password !== confirmPassword) {
      setError(t.passwordsMismatch);
      return;
    }

    setIsLoading(true);

    try {
      const response = await fetch(`${API_URL}/api/trial/claim/${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });

      const data = await response.json();

      if (!response.ok) {
        if (response.status === 404) {
          setPageState('invalid');
        } else {
          setError(data.error || t.error);
        }
        return;
      }

      // Store JWT + user data and redirect
      if (data.token) {
        localStorage.setItem('auth_token', data.token);
        if (data.user) {
          localStorage.setItem('current_user', JSON.stringify(data.user));
        }
        // Clear any stale admin-only flags from previous sessions
        if (!data.user || data.user.role !== 'admin') {
          localStorage.removeItem('developer_mode');
        }
      }

      setPageState('success');
      setTimeout(() => { window.location.href = '/stories'; }, 1500);
    } catch {
      setError(t.error);
    } finally {
      setIsLoading(false);
    }
  };

  // ── Google claim ────────────────────────────────────────────────────────────

  const handleGoogleClaim = async () => {
    if (isLoading) return;

    setError('');
    setIsLoading(true);

    try {
      const firebaseUser = await signInWithGoogle();
      const idToken = await getIdToken(firebaseUser);

      const response = await fetch(`${API_URL}/api/trial/claim-google`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken, claimToken: token }),
      });

      const data = await response.json();

      if (!response.ok) {
        if (response.status === 404) {
          setPageState('invalid');
        } else {
          setError(data.error || t.error);
        }
        return;
      }

      // Store JWT + user data and redirect
      if (data.token) {
        localStorage.setItem('auth_token', data.token);
        if (data.user) {
          localStorage.setItem('current_user', JSON.stringify(data.user));
        }
        // Clear any stale admin-only flags from previous sessions
        if (!data.user || data.user.role !== 'admin') {
          localStorage.removeItem('developer_mode');
        }
      }

      setPageState('success');
      setTimeout(() => { window.location.href = '/stories'; }, 1500);
    } catch (err) {
      if (err instanceof Error && err.message === 'Redirecting to Google...') {
        return;
      }
      setError(t.error);
    } finally {
      setIsLoading(false);
    }
  };

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Navigation bar matching the trial wizard */}
      <nav className="bg-black text-white px-3 py-3">
        <div className="flex justify-between items-center">
          <button onClick={() => navigate('/')} className="text-sm md:text-base font-bold whitespace-nowrap hover:opacity-80 flex items-center gap-1.5">
            <img src="/images/logo-book.png" alt="" className="h-10 md:h-11 -my-2 w-auto" />
            {t.brand}
          </button>
        </div>
      </nav>

      {/* Content */}
      <div className="px-3 md:px-8 py-4 md:py-8">
        <div className="bg-white rounded-2xl shadow-xl max-w-md mx-auto p-8">

          {/* Loading */}
          {pageState === 'loading' && (
            <div className="text-center py-8">
              <Loader2 className="w-8 h-8 text-indigo-500 animate-spin mx-auto mb-4" />
              <p className="text-gray-500">{t.loading}</p>
            </div>
          )}

          {/* Invalid token */}
          {pageState === 'invalid' && (
            <div className="text-center py-4">
              <div className="w-16 h-16 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-4">
                <XCircle className="w-8 h-8 text-red-600" />
              </div>
              <h2 className="text-2xl font-bold text-gray-800 mb-2">{t.invalidTitle}</h2>
              <p className="text-gray-500 mb-6">{t.invalidDesc}</p>
              <button
                onClick={() => navigate('/welcome')}
                className="bg-indigo-500 text-white px-6 py-3 rounded-lg font-semibold hover:bg-indigo-600 transition-colors"
              >
                {t.goToLogin}
              </button>
            </div>
          )}

          {/* Success */}
          {pageState === 'success' && (
            <div className="text-center py-4">
              <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
                <CheckCircle className="w-8 h-8 text-green-600" />
              </div>
              <h2 className="text-2xl font-bold text-gray-800 mb-2">{t.successTitle}</h2>
              <p className="text-gray-500">{t.successDesc}</p>
            </div>
          )}

          {/* Claim form */}
          {pageState === 'form' && (
            <>
              <div className="text-center mb-6">
                <div className="w-16 h-16 bg-indigo-100 rounded-full flex items-center justify-center mx-auto mb-4">
                  <KeyRound className="w-8 h-8 text-indigo-500" />
                </div>
                <h2 className="text-2xl font-bold text-gray-800 mb-1">
                  {t.welcomeBack}, {userEmail.split('@')[0]}!
                </h2>
                <p className="text-gray-500 text-sm">{t.setPassword}</p>
                {userName !== userEmail && (
                  <p className="text-gray-400 text-xs mt-1">{userEmail}</p>
                )}
              </div>

              {/* Error display */}
              {error && (
                <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-3 mb-4 text-sm">
                  {error}
                </div>
              )}

              {/* Password form */}
              <form onSubmit={handleSubmit} className="space-y-4 mb-5">
                <div>
                  <label htmlFor="claim-password" className="block text-sm font-medium text-gray-700 mb-1">
                    {t.password}
                  </label>
                  <input
                    id="claim-password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="******"
                    required
                    disabled={isLoading}
                    className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none transition-all disabled:opacity-50 disabled:bg-gray-50"
                  />
                </div>

                <div>
                  <label htmlFor="claim-confirm-password" className="block text-sm font-medium text-gray-700 mb-1">
                    {t.confirmPassword}
                  </label>
                  <input
                    id="claim-confirm-password"
                    type="password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="******"
                    required
                    disabled={isLoading}
                    className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none transition-all disabled:opacity-50 disabled:bg-gray-50"
                  />
                </div>

                <button
                  type="submit"
                  disabled={isLoading || !password || !confirmPassword}
                  className="w-full bg-indigo-500 text-white py-3 rounded-lg font-semibold hover:bg-indigo-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                >
                  {isLoading ? (
                    <Loader2 className="w-5 h-5 animate-spin" />
                  ) : (
                    <CheckCircle className="w-5 h-5" />
                  )}
                  {t.submit}
                </button>
              </form>

              {/* Google divider */}
              <div className="flex items-center gap-3 mb-4">
                <div className="flex-1 h-px bg-gray-200" />
                <span className="text-sm text-gray-400 font-medium">{t.orGoogle}</span>
                <div className="flex-1 h-px bg-gray-200" />
              </div>

              {/* Google button */}
              <button
                type="button"
                onClick={handleGoogleClaim}
                disabled={isLoading}
                className="w-full flex items-center justify-center gap-3 bg-white border border-gray-300 text-gray-700 py-3 rounded-lg font-semibold hover:bg-gray-50 transition-colors disabled:opacity-50"
              >
                {isLoading ? (
                  <Loader2 className="w-5 h-5 animate-spin" />
                ) : (
                  <GoogleIcon />
                )}
                {t.googleButton}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
