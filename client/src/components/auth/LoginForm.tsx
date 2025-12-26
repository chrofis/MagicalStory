import { useState, FormEvent } from 'react';
import { useLanguage } from '@/context/LanguageContext';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { Alert } from '@/components/common/Alert';
import GoogleIcon from './GoogleIcon';

interface LoginFormProps {
  onSubmit: (email: string, password: string) => Promise<void>;
  onGoogleSignIn: () => Promise<void>;
  onSwitchToRegister: () => void;
  onForgotPassword: () => void;
  error?: string;
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
  isLoading,
  initialEmail = '',
  onEmailChange,
}: LoginFormProps) {
  const { t } = useLanguage();
  const [email, setEmail] = useState(initialEmail);
  const [password, setPassword] = useState('');

  const handleEmailChange = (value: string) => {
    setEmail(value);
    onEmailChange?.(value);
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

      {error && (
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
          required
          disabled={isLoading}
        />

        <Input
          type="password"
          label={t.password}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
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
