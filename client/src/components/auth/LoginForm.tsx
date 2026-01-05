import { useState, FormEvent } from 'react';
import { useLanguage } from '@/context/LanguageContext';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { Alert } from '@/components/common/Alert';
import GoogleIcon from './GoogleIcon';

const emailNotRegisteredTexts = {
  en: {
    title: 'Email not registered',
    message: 'The email address is not registered:',
    changeEmail: 'Change email',
    createAccount: 'Create account',
  },
  de: {
    title: 'E-Mail nicht registriert',
    message: 'Diese E-Mail-Adresse ist nicht registriert:',
    changeEmail: 'E-Mail ändern',
    createAccount: 'Konto erstellen',
  },
  fr: {
    title: 'Email non enregistré',
    message: 'Cette adresse email n\'est pas enregistrée:',
    changeEmail: 'Modifier l\'email',
    createAccount: 'Créer un compte',
  },
};

interface LoginFormProps {
  onSubmit: (email: string, password: string) => Promise<void>;
  onGoogleSignIn: () => Promise<void>;
  onSwitchToRegister: () => void;
  onForgotPassword: () => void;
  error?: string;
  errorCode?: string | null;
  onClearError?: () => void;
  isLoading?: boolean;
  initialEmail?: string;
  onEmailChange?: (email: string) => void;
}

export function LoginForm({
  onSubmit,
  onGoogleSignIn,
  onSwitchToRegister,
  onForgotPassword,
  error,
  errorCode,
  onClearError,
  isLoading,
  initialEmail = '',
  onEmailChange,
}: LoginFormProps) {
  const { t, language } = useLanguage();
  const [email, setEmail] = useState(initialEmail);
  const [password, setPassword] = useState('');

  const notRegisteredTexts = emailNotRegisteredTexts[language as keyof typeof emailNotRegisteredTexts] || emailNotRegisteredTexts.en;
  const isEmailNotRegistered = errorCode === 'EMAIL_NOT_REGISTERED';

  const handleEmailChange = (value: string) => {
    setEmail(value);
    onEmailChange?.(value);
  };

  const handleChangeEmail = () => {
    onClearError?.();
    setPassword('');
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    await onSubmit(email, password);
  };

  return (
    <>
      <div className="text-center mb-6">
        <h2 className="text-2xl font-bold text-gray-800 mb-2">{t.welcomeBack}</h2>
        <p className="text-gray-500">{t.loginRequired}</p>
      </div>

      {isEmailNotRegistered ? (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 mb-4">
          <h3 className="font-semibold text-amber-800 mb-2">{notRegisteredTexts.title}</h3>
          <p className="text-sm text-amber-700 mb-2">{notRegisteredTexts.message}</p>
          <p className="font-medium text-gray-800 mb-4 break-all">{email}</p>
          <div className="flex gap-3">
            <button
              type="button"
              onClick={handleChangeEmail}
              className="flex-1 px-4 py-2 border border-gray-300 rounded-lg text-gray-700 font-medium hover:bg-gray-50 transition-colors"
            >
              {notRegisteredTexts.changeEmail}
            </button>
            <button
              type="button"
              onClick={onSwitchToRegister}
              className="flex-1 px-4 py-2 bg-indigo-600 text-white rounded-lg font-medium hover:bg-indigo-700 transition-colors"
            >
              {notRegisteredTexts.createAccount}
            </button>
          </div>
        </div>
      ) : error && (
        <Alert variant="error" className="mb-4">
          {error}
        </Alert>
      )}

      {/* Social Login */}
      <div className="space-y-3 mb-4">
        <button
          type="button"
          onClick={onGoogleSignIn}
          disabled={isLoading}
          className="w-full flex items-center justify-center gap-3 bg-white border border-gray-300 text-gray-700 py-3 rounded-lg font-semibold hover:bg-gray-50 transition-colors disabled:opacity-50"
        >
          <GoogleIcon />
          {t.continueWithGoogle}
        </button>
      </div>

      {/* Divider */}
      <div className="relative my-6">
        <div className="absolute inset-0 flex items-center">
          <div className="w-full border-t border-gray-300"></div>
        </div>
        <div className="relative flex justify-center text-sm">
          <span className="px-2 bg-white text-gray-500">{t.orContinueWith}</span>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <Input
          type="email"
          label={t.email}
          value={email}
          onChange={(e) => handleEmailChange(e.target.value)}
          placeholder="your@email.com"
          autoComplete="email"
          required
          disabled={isLoading}
        />

        <Input
          type="password"
          label={t.password}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          required
          disabled={isLoading}
        />

        <div className="text-right">
          <button
            type="button"
            onClick={onForgotPassword}
            className="text-sm text-indigo-600 hover:text-indigo-800"
          >
            {t.forgotPassword}
          </button>
        </div>

        <Button
          type="submit"
          variant="primary"
          loading={isLoading}
          className="w-full"
        >
          {t.signIn}
        </Button>
      </form>

      <div className="mt-4 text-center">
        <p className="text-sm text-gray-500">
          {t.noAccount}{' '}
          <button
            onClick={onSwitchToRegister}
            className="text-indigo-600 font-semibold hover:text-gray-800"
          >
            {t.signUp}
          </button>
        </p>
      </div>
    </>
  );
}

export default LoginForm;
