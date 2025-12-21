import { useState, FormEvent } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useLanguage } from '@/context/LanguageContext';
import { Navigation } from '@/components/common';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { Alert } from '@/components/common/Alert';
import { KeyRound, CheckCircle, XCircle } from 'lucide-react';

const API_URL = import.meta.env.VITE_API_URL || '';

const translations = {
  en: {
    title: 'Reset Your Password',
    description: 'Enter your new password below.',
    newPassword: 'New password',
    confirmPassword: 'Confirm password',
    resetPassword: 'Reset Password',
    passwordsMatch: 'Passwords must match',
    passwordTooShort: 'Password must be at least 6 characters',
    success: 'Password reset successfully!',
    successDesc: 'You can now log in with your new password.',
    goToLogin: 'Go to Login',
    invalidToken: 'Invalid or Expired Link',
    invalidTokenDesc: 'This password reset link is invalid or has expired. Please request a new one.',
    requestNewLink: 'Request New Link',
  },
  de: {
    title: 'Passwort zuruecksetzen',
    description: 'Geben Sie unten Ihr neues Passwort ein.',
    newPassword: 'Neues Passwort',
    confirmPassword: 'Passwort bestaetigen',
    resetPassword: 'Passwort zuruecksetzen',
    passwordsMatch: 'Passwoerter muessen uebereinstimmen',
    passwordTooShort: 'Passwort muss mindestens 6 Zeichen lang sein',
    success: 'Passwort erfolgreich zurueckgesetzt!',
    successDesc: 'Sie koennen sich jetzt mit Ihrem neuen Passwort anmelden.',
    goToLogin: 'Zur Anmeldung',
    invalidToken: 'Ungueltiger oder abgelaufener Link',
    invalidTokenDesc: 'Dieser Passwort-Reset-Link ist ungueltig oder abgelaufen. Bitte fordern Sie einen neuen an.',
    requestNewLink: 'Neuen Link anfordern',
  },
  fr: {
    title: 'Reinitialiser le mot de passe',
    description: 'Entrez votre nouveau mot de passe ci-dessous.',
    newPassword: 'Nouveau mot de passe',
    confirmPassword: 'Confirmer le mot de passe',
    resetPassword: 'Reinitialiser le mot de passe',
    passwordsMatch: 'Les mots de passe doivent correspondre',
    passwordTooShort: 'Le mot de passe doit contenir au moins 6 caracteres',
    success: 'Mot de passe reinitialise avec succes!',
    successDesc: 'Vous pouvez maintenant vous connecter avec votre nouveau mot de passe.',
    goToLogin: 'Aller a la connexion',
    invalidToken: 'Lien invalide ou expire',
    invalidTokenDesc: 'Ce lien de reinitialisation de mot de passe est invalide ou a expire. Veuillez en demander un nouveau.',
    requestNewLink: 'Demander un nouveau lien',
  },
};

export default function ResetPassword() {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const { language } = useLanguage();
  const t = translations[language as keyof typeof translations] || translations.en;

  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const [invalidToken, setInvalidToken] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');

    if (password.length < 6) {
      setError(t.passwordTooShort);
      return;
    }

    if (password !== confirmPassword) {
      setError(t.passwordsMatch);
      return;
    }

    setIsLoading(true);
    try {
      const response = await fetch(`${API_URL}/api/auth/reset-password/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password }),
      });

      const data = await response.json();

      if (!response.ok) {
        if (response.status === 400 && data.error?.includes('expired')) {
          setInvalidToken(true);
        } else {
          setError(data.error || 'Failed to reset password');
        }
        return;
      }

      setSuccess(true);
    } catch (err) {
      setError('Failed to reset password. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      <Navigation currentStep={0} />

      <div className="flex-1 flex items-center justify-center p-4">
        <div className="bg-white rounded-xl shadow-lg max-w-md w-full p-8">
          {success ? (
            <div className="text-center">
              <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
                <CheckCircle className="w-8 h-8 text-green-600" />
              </div>
              <h2 className="text-2xl font-bold text-gray-800 mb-2">{t.success}</h2>
              <p className="text-gray-500 mb-6">{t.successDesc}</p>
              <Button
                onClick={() => navigate('/?login=true')}
                variant="primary"
                className="w-full"
              >
                {t.goToLogin}
              </Button>
            </div>
          ) : invalidToken ? (
            <div className="text-center">
              <div className="w-16 h-16 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-4">
                <XCircle className="w-8 h-8 text-red-600" />
              </div>
              <h2 className="text-2xl font-bold text-gray-800 mb-2">{t.invalidToken}</h2>
              <p className="text-gray-500 mb-6">{t.invalidTokenDesc}</p>
              <Button
                onClick={() => navigate('/?login=true')}
                variant="primary"
                className="w-full"
              >
                {t.requestNewLink}
              </Button>
            </div>
          ) : (
            <>
              <div className="text-center mb-6">
                <div className="w-16 h-16 bg-indigo-100 rounded-full flex items-center justify-center mx-auto mb-4">
                  <KeyRound className="w-8 h-8 text-indigo-600" />
                </div>
                <h2 className="text-2xl font-bold text-gray-800 mb-2">{t.title}</h2>
                <p className="text-gray-500">{t.description}</p>
              </div>

              {error && (
                <Alert variant="error" className="mb-4">
                  {error}
                </Alert>
              )}

              <form onSubmit={handleSubmit} className="space-y-4">
                <Input
                  type="password"
                  label={t.newPassword}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  required
                  disabled={isLoading}
                />

                <Input
                  type="password"
                  label={t.confirmPassword}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="••••••••"
                  required
                  disabled={isLoading}
                />

                <Button
                  type="submit"
                  variant="primary"
                  loading={isLoading}
                  className="w-full"
                >
                  {t.resetPassword}
                </Button>
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
