import { useState } from 'react';
import { X } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import { useAuth } from '@/context/AuthContext';
import LoginForm from './LoginForm';
import RegisterForm from './RegisterForm';
import PasswordResetForm from './PasswordResetForm';

interface AuthModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: () => void;
  redirectUrl?: string;
}

type AuthMode = 'login' | 'register' | 'reset' | 'resetSent';

const errorMessages = {
  en: {
    loginFailed: 'Login failed',
    registrationFailed: 'Registration failed',
    googleSignInFailed: 'Google sign-in failed',
    passwordResetFailed: 'Password reset failed',
  },
  de: {
    loginFailed: 'Anmeldung fehlgeschlagen',
    registrationFailed: 'Registrierung fehlgeschlagen',
    googleSignInFailed: 'Google-Anmeldung fehlgeschlagen',
    passwordResetFailed: 'Passwort-Zurücksetzung fehlgeschlagen',
  },
  fr: {
    loginFailed: 'Échec de la connexion',
    registrationFailed: 'Échec de l\'inscription',
    googleSignInFailed: 'Échec de la connexion Google',
    passwordResetFailed: 'Échec de la réinitialisation du mot de passe',
  },
};

export function AuthModal({ isOpen, onClose, onSuccess, redirectUrl }: AuthModalProps) {
  const { t, language } = useLanguage();
  const { login, register, loginWithGoogle, resetPassword } = useAuth();
  const [mode, setMode] = useState<AuthMode>('login');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const errors = errorMessages[language as keyof typeof errorMessages] || errorMessages.en;

  if (!isOpen) return null;

  const handleLoginSuccess = () => {
    onClose();
    if (onSuccess) {
      onSuccess();
    }
  };

  const handleLogin = async (email: string, password: string) => {
    setError('');
    setIsLoading(true);
    try {
      await login(email, password);
      handleLoginSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : errors.loginFailed);
    } finally {
      setIsLoading(false);
    }
  };

  const handleRegister = async (email: string, password: string) => {
    setError('');
    setIsLoading(true);
    try {
      await register(email, password);
      // After registration, login automatically happens in register()
      handleLoginSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : errors.registrationFailed);
    } finally {
      setIsLoading(false);
    }
  };

  const handleGoogleSignIn = async () => {
    setError('');
    setIsLoading(true);
    try {
      await loginWithGoogle(redirectUrl);
      handleLoginSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : errors.googleSignInFailed);
    } finally {
      setIsLoading(false);
    }
  };

  const handlePasswordReset = async (email: string) => {
    setError('');
    setIsLoading(true);
    try {
      await resetPassword(email);
      setMode('resetSent');
    } catch (err) {
      setError(err instanceof Error ? err.message : errors.passwordResetFailed);
    } finally {
      setIsLoading(false);
    }
  };

  const switchMode = (newMode: AuthMode) => {
    setMode(newMode);
    setError('');
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-xl max-w-md w-full p-8 animate-fade-in relative">
        <button
          onClick={onClose}
          className="absolute top-4 right-4 p-2 rounded-full hover:bg-gray-100 transition-colors"
          aria-label="Close"
        >
          <X size={20} />
        </button>

        {mode === 'resetSent' ? (
          <div className="text-center">
            <div className="text-5xl mb-4">📧</div>
            <h2 className="text-2xl font-bold text-gray-800 mb-2">{t.resetLinkSent}</h2>
            <button
              onClick={() => switchMode('login')}
              className="mt-4 text-indigo-600 font-semibold hover:text-gray-800"
            >
              {t.backToLogin}
            </button>
          </div>
        ) : mode === 'reset' ? (
          <PasswordResetForm
            onSubmit={handlePasswordReset}
            onBack={() => switchMode('login')}
            error={error}
            isLoading={isLoading}
          />
        ) : mode === 'register' ? (
          <RegisterForm
            onSubmit={handleRegister}
            onGoogleSignIn={handleGoogleSignIn}
            onSwitchToLogin={() => switchMode('login')}
            error={error}
            isLoading={isLoading}
          />
        ) : (
          <LoginForm
            onSubmit={handleLogin}
            onGoogleSignIn={handleGoogleSignIn}
            onSwitchToRegister={() => switchMode('register')}
            onForgotPassword={() => switchMode('reset')}
            error={error}
            isLoading={isLoading}
          />
        )}
      </div>
    </div>
  );
}

export default AuthModal;
