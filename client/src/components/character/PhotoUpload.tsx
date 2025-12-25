import { useState, ChangeEvent } from 'react';
import { Upload, CheckSquare, Square } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useLanguage } from '@/context/LanguageContext';
import { useAuth } from '@/context/AuthContext';

interface PhotoUploadProps {
  onPhotoSelect: (file: File) => void;
  showExamples?: boolean;
}

const consentTexts = {
  en: {
    consent1: 'I confirm I have the right to use this photo and, for photos of minors, I am the parent/guardian or have obtained their consent.',
    consent2: 'I agree to the',
    termsLink: 'Terms of Service',
    and: 'and',
    privacyLink: 'Privacy Policy',
    period: ', including the processing of this photo by AI to create an illustrated avatar.',
    pleaseAccept: 'Please accept the terms above to upload a photo',
  },
  de: {
    consent1: 'Ich bestätige, dass ich das Recht habe, dieses Foto zu verwenden, und bei Fotos von Minderjährigen bin ich der Elternteil/Vormund oder habe deren Zustimmung eingeholt.',
    consent2: 'Ich stimme den',
    termsLink: 'Nutzungsbedingungen',
    and: 'und der',
    privacyLink: 'Datenschutzrichtlinie',
    period: ' zu, einschließlich der Verarbeitung dieses Fotos durch KI zur Erstellung eines illustrierten Avatars.',
    pleaseAccept: 'Bitte akzeptieren Sie die obigen Bedingungen, um ein Foto hochzuladen',
  },
  fr: {
    consent1: 'Je confirme que j\'ai le droit d\'utiliser cette photo et, pour les photos de mineurs, je suis le parent/tuteur ou j\'ai obtenu leur consentement.',
    consent2: 'J\'accepte les',
    termsLink: 'Conditions d\'Utilisation',
    and: 'et la',
    privacyLink: 'Politique de Confidentialité',
    period: ', y compris le traitement de cette photo par l\'IA pour créer un avatar illustré.',
    pleaseAccept: 'Veuillez accepter les conditions ci-dessus pour télécharger une photo',
  },
};

export function PhotoUpload({ onPhotoSelect, showExamples = true }: PhotoUploadProps) {
  const { t, language } = useLanguage();
  const { user, recordPhotoConsent } = useAuth();
  const [consent1Checked, setConsent1Checked] = useState(false);
  const [consent2Checked, setConsent2Checked] = useState(false);
  const [isRecordingConsent, setIsRecordingConsent] = useState(false);
  const texts = consentTexts[language] || consentTexts.en;

  // User has already consented if photoConsentAt is set
  const hasExistingConsent = !!user?.photoConsentAt;

  // Can upload if already consented OR both checkboxes are checked
  const canUpload = hasExistingConsent || (consent1Checked && consent2Checked);

  const handleFileChange = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file && canUpload) {
      // If this is the first time consenting, record it
      if (!hasExistingConsent && consent1Checked && consent2Checked) {
        setIsRecordingConsent(true);
        try {
          await recordPhotoConsent();
        } catch (error) {
          console.error('Failed to record consent:', error);
          // Continue with upload even if consent recording fails
        } finally {
          setIsRecordingConsent(false);
        }
      }
      onPhotoSelect(file);
    }
  };

  // Description text for the photo upload step
  const descriptionText = language === 'de'
    ? 'Deine Geschichte wird basierend auf den hochgeladenen Fotos erstellt. Verwende Fotos mit nur einer Person, idealerweise Ganzkörperaufnahmen, da auch die Kleidung in die Geschichte übernommen wird.'
    : language === 'fr'
    ? 'Votre histoire sera générée à partir des photos téléchargées. Utilisez des photos d\'une seule personne, idéalement en pied, car les vêtements seront également intégrés dans l\'histoire.'
    : 'Your story will be generated based on the photos you upload. Use photos of a single person, ideally full body shots, as clothing will also be copied into the story.';

  return (
    <div className="bg-indigo-50 border-2 border-indigo-300 rounded-lg p-4">
      {/* Description of this step */}
      <p className="text-sm text-gray-700 mb-4 text-center">
        {descriptionText}
      </p>

      {/* Consent checkboxes - only shown if user hasn't already consented */}
      {!hasExistingConsent && (
        <div className="bg-white rounded-lg p-4 mb-4 space-y-3">
          {/* Consent 1: Rights to use photo */}
          <label className="flex items-start gap-3 cursor-pointer group">
            <button
              type="button"
              onClick={() => setConsent1Checked(!consent1Checked)}
              className="flex-shrink-0 mt-0.5 text-indigo-600 hover:text-indigo-800"
            >
              {consent1Checked ? <CheckSquare size={20} /> : <Square size={20} />}
            </button>
            <span className="text-sm text-gray-700 group-hover:text-gray-900">
              {texts.consent1}
            </span>
          </label>

          {/* Consent 2: Terms and Privacy */}
          <label className="flex items-start gap-3 cursor-pointer group">
            <button
              type="button"
              onClick={() => setConsent2Checked(!consent2Checked)}
              className="flex-shrink-0 mt-0.5 text-indigo-600 hover:text-indigo-800"
            >
              {consent2Checked ? <CheckSquare size={20} /> : <Square size={20} />}
            </button>
            <span className="text-sm text-gray-700 group-hover:text-gray-900">
              {texts.consent2}{' '}
              <Link to="/terms" className="text-indigo-600 hover:underline" target="_blank">
                {texts.termsLink}
              </Link>{' '}
              {texts.and}{' '}
              <Link to="/privacy" className="text-indigo-600 hover:underline" target="_blank">
                {texts.privacyLink}
              </Link>
              {texts.period}
            </span>
          </label>
        </div>
      )}

      {/* Upload button - prominent */}
      <div className="text-center mb-5">
        <label className={`inline-flex items-center justify-center gap-3 px-10 py-4 rounded-xl text-xl font-bold shadow-lg transition-colors ${
          canUpload && !isRecordingConsent
            ? 'cursor-pointer bg-indigo-600 text-white hover:bg-indigo-700'
            : 'cursor-not-allowed bg-gray-300 text-gray-500'
        }`}>
          <Upload size={28} /> {isRecordingConsent ? '...' : t.uploadPhoto}
          <input
            type="file"
            accept="image/*"
            onChange={handleFileChange}
            className="hidden"
            disabled={!canUpload || isRecordingConsent}
          />
        </label>
        {!canUpload && !hasExistingConsent && (
          <p className="text-sm text-amber-600 mt-2">{texts.pleaseAccept}</p>
        )}
      </div>

      {/* Photo examples - smaller on desktop */}
      {showExamples && (
        <div className="max-w-xl mx-auto">
          <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
            {/* Good example 1: Full body */}
            <div className="text-center">
              <img
                src="/images/Full body.jpg"
                alt="Full body example"
                className="w-full md:max-h-32 object-contain rounded border-2 border-green-400 mb-1"
              />
              <span className="text-xs text-green-600 font-medium">
                {language === 'de' ? 'Ganzkörper' : language === 'fr' ? 'Corps entier' : 'Full body'}
              </span>
            </div>
            {/* Good example 2: Upper body */}
            <div className="text-center">
              <img
                src="/images/Upper body.jpg"
                alt="Upper body example"
                className="w-full md:max-h-32 object-contain rounded border-2 border-green-400 mb-1"
              />
              <span className="text-xs text-green-600 font-medium">
                {language === 'de' ? 'Oberkörper' : language === 'fr' ? 'Buste' : 'Upper body'}
              </span>
            </div>
            {/* Bad example 1: Close up or blurry */}
            <div className="text-center">
              <img
                src="/images/No zoomed in close up.jpg"
                alt="Too close example"
                className="w-full md:max-h-32 object-contain rounded border-2 border-red-400 mb-1"
              />
              <span className="text-xs text-red-600 font-medium">
                {language === 'de' ? 'Zu nah / Unscharf' : language === 'fr' ? 'Trop proche / Flou' : 'Too close / Blurry'}
              </span>
            </div>
            {/* Bad example 2: Sunglasses, hat, helmet */}
            <div className="text-center">
              <img
                src="/images/No sunglasses, hat or helmets.jpg"
                alt="No accessories example"
                className="w-full md:max-h-32 object-contain rounded border-2 border-red-400 mb-1"
              />
              <span className="text-xs text-red-600 font-medium">
                {language === 'de' ? 'Brille / Hut / Helm' : language === 'fr' ? 'Lunettes / Chapeau' : 'Glasses / Hat / Helmet'}
              </span>
            </div>
            {/* Bad example 3: Multiple people */}
            <div className="text-center">
              <img
                src="/images/One person not many.jpg"
                alt="One person only example"
                className="w-full md:max-h-32 object-contain rounded border-2 border-red-400 mb-1"
              />
              <span className="text-xs text-red-600 font-medium">
                {language === 'de' ? 'Nur eine Person' : language === 'fr' ? 'Une seule personne' : 'Only one person'}
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default PhotoUpload;
