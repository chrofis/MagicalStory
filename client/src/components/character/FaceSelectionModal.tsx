import { Upload } from 'lucide-react';
import { Modal } from '@/components/common';
import { useLanguage } from '@/context/LanguageContext';
import type { DetectedFace } from '@/types/character';

interface FaceSelectionModalProps {
  isOpen: boolean;
  faces: DetectedFace[];
  onSelect: (faceId: number) => void;
  onUploadNew: () => void;
  developerMode?: boolean;
}

const translations = {
  en: {
    title: 'Multiple Faces Detected',
    description: 'We detected multiple people in your photo. Please select which face belongs to the character you want to create.',
    selectFace: 'Select Face',
    uploadDifferent: 'Upload Different Photo',
    confidence: 'Confidence',
  },
  de: {
    title: 'Mehrere Gesichter erkannt',
    description: 'Wir haben mehrere Personen in Ihrem Foto erkannt. Bitte wählen Sie aus, welches Gesicht zu dem Charakter gehört, den Sie erstellen möchten.',
    selectFace: 'Gesicht auswählen',
    uploadDifferent: 'Anderes Foto hochladen',
    confidence: 'Konfidenz',
  },
  fr: {
    title: 'Plusieurs visages détectés',
    description: 'Nous avons détecté plusieurs personnes sur votre photo. Veuillez sélectionner le visage du personnage que vous souhaitez créer.',
    selectFace: 'Sélectionner le visage',
    uploadDifferent: 'Télécharger une autre photo',
    confidence: 'Confiance',
  },
};

export function FaceSelectionModal({
  isOpen,
  faces,
  onSelect,
  onUploadNew,
  developerMode = false,
}: FaceSelectionModalProps) {
  const { language } = useLanguage();
  const t = translations[language] || translations.en;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onUploadNew}
      title={t.title}
      size="lg"
      showCloseButton={false}
      closeOnOverlayClick={false}
      closeOnEscape={false}
    >
      <div className="space-y-6">
        {/* Description */}
        <p className="text-gray-600 text-center">
          {t.description}
        </p>

        {/* Face grid */}
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
          {faces.map((face, index) => (
            <button
              key={face.id}
              onClick={() => onSelect(face.id)}
              className="group relative bg-white border-2 border-gray-200 rounded-xl p-3
                hover:border-indigo-400 hover:shadow-lg transition-all duration-200
                focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2"
            >
              {/* Face thumbnail */}
              <div className="aspect-square overflow-hidden rounded-lg mb-3">
                <img
                    draggable={false}
                  src={face.thumbnail}
                  alt={`Face ${index + 1}`}
                  className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-200"
                />
              </div>

              {/* Select button text */}
              <div className="text-center">
                <span className="text-sm font-semibold text-indigo-600 group-hover:text-indigo-700">
                  {t.selectFace} {index + 1}
                </span>
              </div>

              {/* Confidence score - only in developer mode */}
              {developerMode && (
                <div className="absolute top-2 right-2 bg-black/70 text-white text-xs px-2 py-1 rounded">
                  {t.confidence}: {Math.round(face.confidence * 100)}%
                </div>
              )}
            </button>
          ))}
        </div>

        {/* Upload different photo button */}
        <div className="pt-4 border-t border-gray-100">
          <button
            onClick={onUploadNew}
            className="w-full flex items-center justify-center gap-2 px-4 py-3
              bg-gray-100 text-gray-700 rounded-lg font-medium
              hover:bg-gray-200 transition-colors"
          >
            <Upload size={20} />
            {t.uploadDifferent}
          </button>
        </div>
      </div>
    </Modal>
  );
}

export default FaceSelectionModal;
