import { useState } from 'react';
import { X, Mail, RefreshCw, Edit3 } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import { useAuth } from '@/context/AuthContext';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { Alert } from '@/components/common/Alert';
import { api } from '@/services/api';

interface EmailVerificationModalProps {
  isOpen: boolean;
  onClose: () => void;
  onVerified?: () => void;
}

const translations = {
  en: {
    title: 'Verify Your Email',
    description: 'Please verify your email address before generating your story.',
    currentEmail: 'Current email',
    sendVerification: 'Send Verification Email',
    resendVerification: 'Resend Verification Email',
    emailSent: 'Verification email sent! Please check your inbox.',
    changeEmail: 'Change Email',
    newEmail: 'New email address',
    currentPassword: 'Current password',
    confirmChange: 'Change & Verify',
    cancel: 'Cancel',
    emailChanged: 'Email changed! Please check your new inbox for verification.',
    checkSpam: 'Don\'t see it? Check your spam folder.',
  },
  de: {
    title: 'E-Mail bestaetigen',
    description: 'Bitte bestaetigen Sie Ihre E-Mail-Adresse, bevor Sie Ihre Geschichte erstellen.',
    currentEmail: 'Aktuelle E-Mail',
    sendVerification: 'Bestaetigungs-E-Mail senden',
    resendVerification: 'Bestaetigungs-E-Mail erneut senden',
    emailSent: 'Bestaetigungs-E-Mail gesendet! Bitte pruefen Sie Ihren Posteingang.',
    changeEmail: 'E-Mail aendern',
    newEmail: 'Neue E-Mail-Adresse',
    currentPassword: 'Aktuelles Passwort',
    confirmChange: 'Aendern & Bestaetigen',
    cancel: 'Abbrechen',
    emailChanged: 'E-Mail geaendert! Bitte pruefen Sie Ihren neuen Posteingang fuer die Bestaetigung.',
    checkSpam: 'Nicht gefunden? Pruefen Sie Ihren Spam-Ordner.',
  },
  fr: {
    title: 'Verifiez votre e-mail',
    description: 'Veuillez verifier votre adresse e-mail avant de generer votre histoire.',
    currentEmail: 'E-mail actuel',
    sendVerification: 'Envoyer l\'e-mail de verification',
    resendVerification: 'Renvoyer l\'e-mail de verification',
    emailSent: 'E-mail de verification envoye! Veuillez verifier votre boite de reception.',
    changeEmail: 'Changer d\'e-mail',
    newEmail: 'Nouvelle adresse e-mail',
    currentPassword: 'Mot de passe actuel',
    confirmChange: 'Changer & Verifier',
    cancel: 'Annuler',
    emailChanged: 'E-mail change! Veuillez verifier votre nouvelle boite de reception pour la verification.',
    checkSpam: 'Pas trouve? Verifiez votre dossier spam.',
  },
};

export function EmailVerificationModal({ isOpen, onClose }: EmailVerificationModalProps) {
  const { language } = useLanguage();
  const { user } = useAuth();
  const t = translations[language as keyof typeof translations] || translations.en;

  const [mode, setMode] = useState<'verify' | 'change'>('verify');
  const [isLoading, setIsLoading] = useState(false);
  const [emailSent, setEmailSent] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  // Change email form
  const [newEmail, setNewEmail] = useState('');
  const [password, setPassword] = useState('');

  if (!isOpen) return null;

  const handleSendVerification = async () => {
    setIsLoading(true);
    setError('');
    try {
      await api.post('/api/auth/send-verification', {});
      setEmailSent(true);
      setSuccess(t.emailSent);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send verification email');
    } finally {
      setIsLoading(false);
    }
  };

  const handleChangeEmail = async () => {
    if (!newEmail || !password) {
      setError('Please fill in all fields');
      return;
    }

    setIsLoading(true);
    setError('');
    try {
      await api.post('/api/auth/change-email', { newEmail, password });
      setSuccess(t.emailChanged);
      setMode('verify');
      setNewEmail('');
      setPassword('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to change email');
    } finally {
      setIsLoading(false);
    }
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

        <div className="text-center mb-6">
          <div className="w-16 h-16 bg-indigo-100 rounded-full flex items-center justify-center mx-auto mb-4">
            <Mail className="w-8 h-8 text-indigo-600" />
          </div>
          <h2 className="text-2xl font-bold text-gray-800 mb-2">{t.title}</h2>
          <p className="text-gray-500">{t.description}</p>
        </div>

        {error && (
          <Alert variant="error" className="mb-4">
            {error}
          </Alert>
        )}

        {success && (
          <Alert variant="success" className="mb-4">
            {success}
            <p className="text-sm mt-1 opacity-80">{t.checkSpam}</p>
          </Alert>
        )}

        {mode === 'verify' ? (
          <div className="space-y-4">
            <div className="bg-gray-50 p-4 rounded-lg">
              <p className="text-sm text-gray-500 mb-1">{t.currentEmail}</p>
              <p className="font-medium text-gray-800">{user?.email}</p>
            </div>

            <Button
              onClick={handleSendVerification}
              variant="primary"
              loading={isLoading}
              className="w-full"
            >
              <RefreshCw size={16} className="mr-2" />
              {emailSent ? t.resendVerification : t.sendVerification}
            </Button>

            <button
              onClick={() => {
                setMode('change');
                setError('');
                setSuccess('');
              }}
              className="w-full text-center text-indigo-600 font-semibold hover:text-indigo-800 flex items-center justify-center gap-2"
            >
              <Edit3 size={16} />
              {t.changeEmail}
            </button>
          </div>
        ) : (
          <div className="space-y-4">
            <Input
              type="email"
              label={t.newEmail}
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              placeholder="your@newemail.com"
              disabled={isLoading}
            />

            <Input
              type="password"
              label={t.currentPassword}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              disabled={isLoading}
            />

            <div className="flex gap-3">
              <Button
                onClick={() => {
                  setMode('verify');
                  setError('');
                  setNewEmail('');
                  setPassword('');
                }}
                variant="secondary"
                className="flex-1"
                disabled={isLoading}
              >
                {t.cancel}
              </Button>
              <Button
                onClick={handleChangeEmail}
                variant="primary"
                loading={isLoading}
                className="flex-1"
              >
                {t.confirmChange}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default EmailVerificationModal;
