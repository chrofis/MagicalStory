import { useState, FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { X, Mail, Loader2, CheckCircle, Sparkles } from 'lucide-react';
import { GoogleIcon } from '@/components/auth/GoogleIcon';
import { signInWithGoogle, getIdToken } from '@/services/firebase';
import type { CharacterData, StoryInput } from '../TrialWizard';

const API_URL = import.meta.env.VITE_API_URL || '';

type ModalState = 'input' | 'verifying' | 'generating' | 'error';

interface Props {
  characterData: CharacterData;
  storyInput: StoryInput;
  onClose: () => void;
}

const translations = {
  en: {
    title: 'Get your free story',
    subtitle: 'Enter your email to receive the story as PDF.',
    googleButton: 'Continue with Google',
    orDivider: 'or',
    emailLabel: 'Email address',
    emailPlaceholder: 'you@example.com',
    emailSubmit: 'Send verification link',
    terms: 'By continuing, you agree to our',
    termsLink: 'Terms of Service',
    and: 'and',
    privacyLink: 'Privacy Policy',
    verifyingTitle: 'Check your inbox!',
    verifyingDesc: 'We sent a verification link to your email. Click it to start creating your story.',
    verifyingNote: 'Didn\'t get it? Check your spam folder or try again.',
    generatingTitle: 'Your story is being created!',
    generatingDesc: 'We\'ll email you the finished story as PDF in about 5-10 minutes.',
    accountExists: 'An account with this email already exists.',
    accountExistsLogin: 'Please log in instead.',
    trialUsed: 'This email has already been used for a free trial.',
    error: 'Something went wrong. Please try again.',
    close: 'Close',
    upsellTitle: 'Want even more?',
    upsellDesc: 'With a full account you unlock:',
    upsellFeatures: [
      'Multiple characters in one story',
      'Longer stories',
      'Multiple drawing styles',
      'Higher image quality and title page',
      'Order as a printed book',
    ],
  },
  de: {
    title: 'Erstelle deine kostenlose Geschichte',
    subtitle: 'Gib deine E-Mail ein, um die Geschichte als PDF zu erhalten.',
    googleButton: 'Weiter mit Google',
    orDivider: 'oder',
    emailLabel: 'E-Mail-Adresse',
    emailPlaceholder: 'du@beispiel.com',
    emailSubmit: 'Bestätigungslink senden',
    terms: 'Mit der Fortsetzung stimmst du unseren',
    termsLink: 'Nutzungsbedingungen',
    and: 'und',
    privacyLink: 'Datenschutzrichtlinien',
    verifyingTitle: 'Prüfe deinen Posteingang!',
    verifyingDesc: 'Wir haben dir einen Bestätigungslink per E-Mail gesendet. Klicke darauf, um deine Geschichte zu erstellen.',
    verifyingNote: 'Nicht erhalten? Prüfe deinen Spam-Ordner.',
    generatingTitle: 'Deine Geschichte wird erstellt!',
    generatingDesc: 'Du erhältst die fertige Geschichte als PDF in etwa 5-10 Minuten.',
    accountExists: 'Ein Konto mit dieser E-Mail existiert bereits.',
    accountExistsLogin: 'Bitte melde dich stattdessen an.',
    trialUsed: 'Diese E-Mail wurde bereits für eine kostenlose Testversion verwendet.',
    error: 'Etwas ist schiefgelaufen. Bitte versuche es erneut.',
    close: 'Schliessen',
    upsellTitle: 'Du willst noch mehr?',
    upsellDesc: 'Mit einem vollständigen Konto erhältst du:',
    upsellFeatures: [
      'Mehrere Figuren in einer Geschichte',
      'Längere Geschichten',
      'Verschiedene Zeichenstile',
      'Höhere Bildqualität und Titelseite',
      'Als gedrucktes Buch bestellen',
    ],
  },
  fr: {
    title: 'Obtenez votre histoire gratuite',
    subtitle: 'Entrez votre e-mail pour recevoir l\'histoire en PDF.',
    googleButton: 'Continuer avec Google',
    orDivider: 'ou',
    emailLabel: 'Adresse e-mail',
    emailPlaceholder: 'vous@exemple.com',
    emailSubmit: 'Envoyer le lien de vérification',
    terms: 'En continuant, vous acceptez nos',
    termsLink: 'Conditions d\'utilisation',
    and: 'et',
    privacyLink: 'Politique de confidentialité',
    verifyingTitle: 'Vérifiez votre boîte de réception !',
    verifyingDesc: 'Nous vous avons envoyé un lien de vérification par e-mail. Cliquez dessus pour commencer à créer votre histoire.',
    verifyingNote: 'Pas reçu ? Vérifiez votre dossier spam ou réessayez.',
    generatingTitle: 'Votre histoire est en cours de création !',
    generatingDesc: 'Vous recevrez l\'histoire terminée en PDF dans environ 5 à 10 minutes.',
    accountExists: 'Un compte avec cet e-mail existe déjà.',
    accountExistsLogin: 'Veuillez vous connecter.',
    trialUsed: 'Cet e-mail a déjà été utilisé pour un essai gratuit.',
    error: 'Quelque chose s\'est mal passé. Veuillez réessayer.',
    close: 'Fermer',
    upsellTitle: 'Vous en voulez plus ?',
    upsellDesc: 'Avec un compte complet, vous débloquez :',
    upsellFeatures: [
      'Plusieurs personnages dans une même histoire',
      'Des histoires plus longues',
      'Plusieurs styles de dessin',
      'Qualité d\'image supérieure et page de titre',
      'Commander en livre imprimé',
    ],
  },
};

export default function TrialAuthModal({ characterData, storyInput, onClose }: Props) {
  const navigate = useNavigate();
  const lang = (storyInput.language?.startsWith('de') ? 'de' : storyInput.language === 'fr' ? 'fr' : 'en') as keyof typeof translations;
  const t = translations[lang] || translations.en;

  const [state, setState] = useState<ModalState>('input');
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  // ── Email registration ──────────────────────────────────────────────────────

  const handleEmailSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!email.trim() || isLoading) return;

    setError('');
    setIsLoading(true);

    try {
      const response = await fetch(`${API_URL}/api/trial/register-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), characterData, storyInput }),
      });

      const data = await response.json();

      if (!response.ok) {
        if (response.status === 409) {
          if (data.code === 'TRIAL_USED') {
            setError(t.trialUsed);
          } else {
            setError(`${t.accountExists} ${t.accountExistsLogin}`);
          }
        } else {
          setError(data.error || t.error);
        }
        return;
      }

      setState('verifying');
    } catch {
      setError(t.error);
    } finally {
      setIsLoading(false);
    }
  };

  // ── Google registration ─────────────────────────────────────────────────────

  const handleGoogleSignIn = async () => {
    if (isLoading) return;

    setError('');
    setIsLoading(true);

    try {
      const firebaseUser = await signInWithGoogle();
      const idToken = await getIdToken(firebaseUser);

      const response = await fetch(`${API_URL}/api/trial/register-google`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken, characterData, storyInput }),
      });

      const data = await response.json();

      if (!response.ok) {
        if (response.status === 409) {
          if (data.code === 'TRIAL_USED') {
            setError(t.trialUsed);
          } else {
            setError(`${t.accountExists} ${t.accountExistsLogin}`);
          }
        } else {
          setError(data.error || t.error);
        }
        return;
      }

      // Store JWT token for authenticated access
      if (data.token) {
        localStorage.setItem('auth_token', data.token);
      }

      setState('generating');

      // Navigate to confirmation page after a brief moment
      setTimeout(() => {
        navigate('/trial-started');
      }, 2000);
    } catch (err) {
      // Don't show error for redirect-based auth
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
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-xl max-w-md w-full p-8 animate-fade-in relative">
        {/* Close button */}
        <button
          onClick={onClose}
          className="absolute top-4 right-4 p-2 rounded-full hover:bg-gray-100 transition-colors"
          aria-label={t.close}
        >
          <X size={20} className="text-gray-400" />
        </button>

        {/* ── Verifying state ──────────────────────────────────────────────── */}
        {state === 'verifying' && (
          <div className="py-4">
            <div className="text-center">
              <div className="w-16 h-16 bg-indigo-100 rounded-full flex items-center justify-center mx-auto mb-4">
                <Mail className="w-8 h-8 text-indigo-600" />
              </div>
              <h2 className="text-2xl font-bold text-gray-800 mb-2">{t.verifyingTitle}</h2>
              <p className="text-gray-600 mb-4">{t.verifyingDesc}</p>
              <p className="text-sm text-gray-400 mb-5">{t.verifyingNote}</p>
            </div>
            <div className="bg-gradient-to-r from-indigo-50 to-purple-50 rounded-xl p-4 border border-indigo-100">
              <p className="text-sm font-semibold text-indigo-700 mb-2">{t.upsellTitle}</p>
              <p className="text-xs text-gray-600 mb-2">{t.upsellDesc}</p>
              <ul className="text-xs text-gray-600 space-y-1">
                {t.upsellFeatures.map((f, i) => (
                  <li key={i} className="flex items-start gap-1.5">
                    <span className="text-indigo-500 mt-0.5">+</span> {f}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}

        {/* ── Generating state ─────────────────────────────────────────────── */}
        {state === 'generating' && (
          <div className="py-4">
            <div className="text-center">
              <div className="w-16 h-16 bg-purple-100 rounded-full flex items-center justify-center mx-auto mb-4">
                <Sparkles className="w-8 h-8 text-purple-600 animate-pulse" />
              </div>
              <h2 className="text-2xl font-bold text-gray-800 mb-2">{t.generatingTitle}</h2>
              <p className="text-gray-600 mb-5">{t.generatingDesc}</p>
            </div>
            <div className="bg-gradient-to-r from-indigo-50 to-purple-50 rounded-xl p-4 border border-indigo-100">
              <p className="text-sm font-semibold text-indigo-700 mb-2">{t.upsellTitle}</p>
              <p className="text-xs text-gray-600 mb-2">{t.upsellDesc}</p>
              <ul className="text-xs text-gray-600 space-y-1">
                {t.upsellFeatures.map((f, i) => (
                  <li key={i} className="flex items-start gap-1.5">
                    <span className="text-indigo-500 mt-0.5">+</span> {f}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}

        {/* ── Input state (default) ────────────────────────────────────────── */}
        {state === 'input' && (
          <>
            <div className="text-center mb-6">
              <h2 className="text-2xl font-bold text-gray-800 mb-1">{t.title}</h2>
              <p className="text-gray-500 text-sm">{t.subtitle}</p>
            </div>

            {/* Error display */}
            {error && (
              <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-3 mb-4 text-sm">
                {error}
              </div>
            )}

            {/* Google button */}
            <button
              type="button"
              onClick={handleGoogleSignIn}
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

            {/* Divider */}
            <div className="flex items-center gap-3 my-5">
              <div className="flex-1 h-px bg-gray-200" />
              <span className="text-sm text-gray-400 font-medium">{t.orDivider}</span>
              <div className="flex-1 h-px bg-gray-200" />
            </div>

            {/* Email form */}
            <form onSubmit={handleEmailSubmit} className="space-y-3">
              <div>
                <label htmlFor="trial-email" className="block text-sm font-medium text-gray-700 mb-1">
                  {t.emailLabel}
                </label>
                <input
                  id="trial-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder={t.emailPlaceholder}
                  required
                  disabled={isLoading}
                  className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none transition-all disabled:opacity-50 disabled:bg-gray-50"
                />
              </div>

              <button
                type="submit"
                disabled={isLoading || !email.trim()}
                className="w-full bg-indigo-600 text-white py-3 rounded-lg font-semibold hover:bg-indigo-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {isLoading ? (
                  <Loader2 className="w-5 h-5 animate-spin" />
                ) : (
                  <CheckCircle className="w-5 h-5" />
                )}
                {t.emailSubmit}
              </button>
            </form>

            {/* Terms note */}
            <p className="text-xs text-gray-400 text-center mt-4">
              {t.terms}{' '}
              <a href="/terms" target="_blank" className="underline hover:text-gray-600">
                {t.termsLink}
              </a>{' '}
              {t.and}{' '}
              <a href="/privacy" target="_blank" className="underline hover:text-gray-600">
                {t.privacyLink}
              </a>
              .
            </p>
          </>
        )}
      </div>
    </div>
  );
}
