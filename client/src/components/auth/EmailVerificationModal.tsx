import { useState, useEffect, useRef } from 'react';
import { X, Mail, RefreshCw, Edit3, Loader2 } from 'lucide-react';
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
    title: 'Check Your Email',
    description: 'We\'ve sent you a verification link. Your story will start generating automatically once you verify your email!',
    currentEmail: 'Verification sent to',
    sendVerification: 'Send Verification Email',
    resendVerification: 'Resend Verification Email',
    emailSent: 'Verification email sent! Please check your inbox.',
    changeEmail: 'Wrong email? Change it',
    newEmail: 'New email address',
    currentPassword: 'Current password',
    confirmChange: 'Change & Verify',
    cancel: 'Cancel',
    emailChanged: 'Email changed! Please check your new inbox for verification.',
    checkSpam: 'Don\'t see it? Check your spam folder.',
    fillAllFields: 'Please fill in all fields',
  },
  de: {
    title: 'E-Mail prüfen',
    description: 'Wir haben Ihnen einen Bestätigungslink gesendet. Ihre Geschichte wird automatisch erstellt, sobald Sie Ihre E-Mail bestätigen!',
    currentEmail: 'Bestätigung gesendet an',
    sendVerification: 'Bestätigungs-E-Mail senden',
    resendVerification: 'Bestätigungs-E-Mail erneut senden',
    emailSent: 'Bestätigungs-E-Mail gesendet! Bitte prüfen Sie Ihren Posteingang.',
    changeEmail: 'Falsche E-Mail? Ändern',
    newEmail: 'Neue E-Mail-Adresse',
    currentPassword: 'Aktuelles Passwort',
    confirmChange: 'Ändern & Bestätigen',
    cancel: 'Abbrechen',
    emailChanged: 'E-Mail geändert! Bitte prüfen Sie Ihren neuen Posteingang für die Bestätigung.',
    checkSpam: 'Nicht gefunden? Prüfen Sie Ihren Spam-Ordner.',
    fillAllFields: 'Bitte alle Felder ausfüllen',
  },
  fr: {
    title: 'Verifiez votre e-mail',
    description: 'Nous vous avons envoye un lien de verification. Votre histoire sera generee automatiquement une fois votre e-mail verifie!',
    currentEmail: 'Verification envoyee a',
    sendVerification: 'Envoyer l\'e-mail de verification',
    resendVerification: 'Renvoyer l\'e-mail de verification',
    emailSent: 'E-mail de verification envoye! Veuillez verifier votre boite de reception.',
    changeEmail: 'Mauvais e-mail? Changer',
    newEmail: 'Nouvelle adresse e-mail',
    currentPassword: 'Mot de passe actuel',
    confirmChange: 'Changer & Verifier',
    cancel: 'Annuler',
    emailChanged: 'E-mail change! Veuillez verifier votre nouvelle boite de reception pour la verification.',
    checkSpam: 'Pas trouve? Verifiez votre dossier spam.',
    fillAllFields: 'Veuillez remplir tous les champs',
  },
};

export function EmailVerificationModal({ isOpen, onClose, onVerified }: EmailVerificationModalProps) {
  const { language } = useLanguage();
  const { user, refreshUser } = useAuth();
  const t = translations[language as keyof typeof translations] || translations.en;

  const [mode, setMode] = useState<'verify' | 'change'>('verify');
  const [isLoading, setIsLoading] = useState(false);
  const [emailSent, setEmailSent] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [isPolling, setIsPolling] = useState(false);
  const [cooldownSeconds, setCooldownSeconds] = useState(0);

  // Change email form
  const [newEmail, setNewEmail] = useState('');
  const [password, setPassword] = useState('');

  // Polling ref to track interval
  const pollingRef = useRef<NodeJS.Timeout | null>(null);
  const cooldownRef = useRef<NodeJS.Timeout | null>(null);
  const autoSentRef = useRef(false);

  // Cooldown timer effect
  useEffect(() => {
    if (cooldownSeconds > 0) {
      cooldownRef.current = setTimeout(() => {
        setCooldownSeconds(prev => prev - 1);
      }, 1000);
    }
    return () => {
      if (cooldownRef.current) {
        clearTimeout(cooldownRef.current);
      }
    };
  }, [cooldownSeconds]);

  // Auto-send verification email when modal opens
  useEffect(() => {
    if (isOpen && !autoSentRef.current && !emailSent) {
      autoSentRef.current = true;
      // Small delay to let modal animate in, then auto-send
      const timer = setTimeout(async () => {
        setIsLoading(true);
        try {
          const response = await api.post<{ cooldown?: number }>('/api/auth/send-verification', {});
          setEmailSent(true);
          setSuccess(t.emailSent);
          if (response.cooldown) {
            setCooldownSeconds(response.cooldown);
          }
        } catch (err: unknown) {
          const error = err as { retryAfter?: number; message?: string };
          if (error.retryAfter) {
            setCooldownSeconds(error.retryAfter);
            // Don't show error for rate limit on auto-send - just show cooldown
            setEmailSent(true); // Assume previous send worked
          } else {
            setError(error.message || 'Failed to send verification email');
          }
        } finally {
          setIsLoading(false);
        }
      }, 300);
      return () => clearTimeout(timer);
    }
    if (!isOpen) {
      // Reset auto-sent flag when modal closes
      autoSentRef.current = false;
    }
  }, [isOpen, emailSent, t.emailSent]);

  // Poll for email verification status when modal is open
  useEffect(() => {
    if (!isOpen) {
      // Clear polling when modal closes
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
      return;
    }

    // Start polling every 3 seconds
    setIsPolling(true);
    console.log('[EmailVerificationModal] Starting polling');
    pollingRef.current = setInterval(async () => {
      try {
        const response = await api.get<{ emailVerified: boolean }>('/api/auth/verification-status');
        console.log('[EmailVerificationModal] Poll result:', response.emailVerified);
        if (response.emailVerified) {
          console.log('[EmailVerificationModal] Email verified! Refreshing user...');
          // Email verified! Refresh user and trigger callback
          await refreshUser();
          console.log('[EmailVerificationModal] User refreshed, clearing interval');
          if (pollingRef.current) {
            clearInterval(pollingRef.current);
            pollingRef.current = null;
          }
          setIsPolling(false);
          console.log('[EmailVerificationModal] Calling onVerified callback');
          onVerified?.();
          console.log('[EmailVerificationModal] Calling onClose');
          onClose();
        }
      } catch (err) {
        // Silently ignore polling errors
        console.debug('Verification status poll error:', err);
      }
    }, 3000);

    return () => {
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
    };
  }, [isOpen, refreshUser, onVerified, onClose]);

  if (!isOpen) return null;

  const handleSendVerification = async () => {
    setIsLoading(true);
    setError('');
    try {
      const response = await api.post<{ cooldown?: number }>('/api/auth/send-verification', {});
      setEmailSent(true);
      setSuccess(t.emailSent);
      // Start cooldown timer after successful send
      if (response.cooldown) {
        setCooldownSeconds(response.cooldown);
      }
    } catch (err: unknown) {
      // Check if it's a rate limit error with retryAfter
      const error = err as { retryAfter?: number; message?: string };
      if (error.retryAfter) {
        setCooldownSeconds(error.retryAfter);
        setError(
          language === 'de' ? `Bitte warten Sie ${error.retryAfter} Sekunden` :
          language === 'fr' ? `Veuillez patienter ${error.retryAfter} secondes` :
          `Please wait ${error.retryAfter} seconds`
        );
      } else {
        setError(error.message || 'Failed to send verification email');
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleChangeEmail = async () => {
    if (!newEmail || !password) {
      setError(t.fillAllFields);
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

        {isPolling && emailSent && (
          <div className="flex items-center justify-center gap-2 text-indigo-600 mb-4">
            <Loader2 size={16} className="animate-spin" />
            <span className="text-sm">
              {language === 'de' ? 'Warte auf Bestätigung...' :
               language === 'fr' ? 'En attente de verification...' :
               'Waiting for verification...'}
            </span>
          </div>
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
              disabled={cooldownSeconds > 0}
              className="w-full"
            >
              <RefreshCw size={16} className="mr-2" />
              {cooldownSeconds > 0
                ? `${language === 'de' ? 'Warten' : language === 'fr' ? 'Patienter' : 'Wait'} ${cooldownSeconds}s`
                : emailSent ? t.resendVerification : t.sendVerification}
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
