import { useState, FormEvent } from 'react';
import { X, KeyRound, CheckCircle } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import { useAuth } from '@/context/AuthContext';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { Alert } from '@/components/common/Alert';

interface ChangePasswordModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const translations = {
  en: {
    title: 'Change Password',
    description: 'Enter your current password and choose a new one.',
    currentPassword: 'Current password',
    newPassword: 'New password',
    confirmPassword: 'Confirm new password',
    changePassword: 'Change Password',
    passwordsMatch: 'Passwords must match',
    passwordTooShort: 'Password must be at least 6 characters',
    success: 'Password changed successfully!',
    successDesc: 'Your password has been updated.',
    close: 'Close',
  },
  de: {
    title: 'Passwort aendern',
    description: 'Geben Sie Ihr aktuelles Passwort ein und waehlen Sie ein neues.',
    currentPassword: 'Aktuelles Passwort',
    newPassword: 'Neues Passwort',
    confirmPassword: 'Neues Passwort bestaetigen',
    changePassword: 'Passwort aendern',
    passwordsMatch: 'Passwoerter muessen uebereinstimmen',
    passwordTooShort: 'Passwort muss mindestens 6 Zeichen lang sein',
    success: 'Passwort erfolgreich geaendert!',
    successDesc: 'Ihr Passwort wurde aktualisiert.',
    close: 'Schliessen',
  },
  fr: {
    title: 'Changer le mot de passe',
    description: 'Entrez votre mot de passe actuel et choisissez-en un nouveau.',
    currentPassword: 'Mot de passe actuel',
    newPassword: 'Nouveau mot de passe',
    confirmPassword: 'Confirmer le nouveau mot de passe',
    changePassword: 'Changer le mot de passe',
    passwordsMatch: 'Les mots de passe doivent correspondre',
    passwordTooShort: 'Le mot de passe doit contenir au moins 6 caracteres',
    success: 'Mot de passe change avec succes!',
    successDesc: 'Votre mot de passe a ete mis a jour.',
    close: 'Fermer',
  },
};

export function ChangePasswordModal({ isOpen, onClose }: ChangePasswordModalProps) {
  const { language } = useLanguage();
  const { changePassword } = useAuth();
  const t = translations[language as keyof typeof translations] || translations.en;

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  if (!isOpen) return null;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');

    if (newPassword.length < 6) {
      setError(t.passwordTooShort);
      return;
    }

    if (newPassword !== confirmPassword) {
      setError(t.passwordsMatch);
      return;
    }

    setIsLoading(true);
    try {
      await changePassword(currentPassword, newPassword);
      setSuccess(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to change password');
    } finally {
      setIsLoading(false);
    }
  };

  const handleClose = () => {
    setCurrentPassword('');
    setNewPassword('');
    setConfirmPassword('');
    setError('');
    setSuccess(false);
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-xl max-w-md w-full p-8 animate-fade-in relative">
        <button
          onClick={handleClose}
          className="absolute top-4 right-4 p-2 rounded-full hover:bg-gray-100 transition-colors"
          aria-label="Close"
        >
          <X size={20} />
        </button>

        {success ? (
          <div className="text-center">
            <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <CheckCircle className="w-8 h-8 text-green-600" />
            </div>
            <h2 className="text-2xl font-bold text-gray-800 mb-2">{t.success}</h2>
            <p className="text-gray-500 mb-6">{t.successDesc}</p>
            <Button onClick={handleClose} variant="primary" className="w-full">
              {t.close}
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
                label={t.currentPassword}
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                placeholder="********"
                required
                disabled={isLoading}
              />

              <Input
                type="password"
                label={t.newPassword}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="********"
                required
                disabled={isLoading}
              />

              <Input
                type="password"
                label={t.confirmPassword}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="********"
                required
                disabled={isLoading}
              />

              <Button
                type="submit"
                variant="primary"
                loading={isLoading}
                className="w-full"
              >
                {t.changePassword}
              </Button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}

export default ChangePasswordModal;
