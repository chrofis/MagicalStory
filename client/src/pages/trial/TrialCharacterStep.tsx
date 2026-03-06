import { useState, useRef, useCallback } from 'react';
import { Camera, Loader2, X, ArrowRight } from 'lucide-react';
import type { CharacterData } from '../TrialWizard';

// ─── Localized strings ──────────────────────────────────────────────────────

const strings: Record<string, {
  title: string;
  photoTitle: string;
  photoHint: string;
  photoGuidelines: string;
  dropOrClick: string;
  analyzing: string;
  changPhoto: string;
  nameLabel: string;
  namePlaceholder: string;
  ageLabel: string;
  genderLabel: string;
  boy: string;
  girl: string;
  other: string;
  traitsLabel: string;
  traits: string[];
  next: string;
  termsNote: string;
  selectFace: string;
  noFaceDetected: string;
  multipleFaces: string;
  photoError: string;
}> = {
  en: {
    title: 'Create Your Character',
    photoTitle: 'Upload a Photo',
    photoHint: 'Upload a clear photo to create a personalized character',
    photoGuidelines: 'Tip: Clear face, upper body visible works best',
    dropOrClick: 'Drop a photo here or click to upload',
    analyzing: 'Analyzing photo...',
    changPhoto: 'Change photo',
    nameLabel: 'Name',
    namePlaceholder: "Child's name",
    ageLabel: 'Age',
    genderLabel: 'Gender',
    boy: 'Boy',
    girl: 'Girl',
    other: 'Other',
    traitsLabel: 'Personality Traits',
    traits: ['Brave', 'Curious', 'Kind', 'Funny', 'Creative', 'Adventurous'],
    next: 'Next',
    termsNote: 'By uploading, you agree to our Terms',
    selectFace: 'Select the correct face',
    noFaceDetected: 'No face detected. Please try a different photo.',
    multipleFaces: 'Multiple faces detected. Please select the correct one.',
    photoError: 'Failed to analyze photo. Please try again.',
  },
  de: {
    title: 'Erstelle deine Figur',
    photoTitle: 'Foto hochladen',
    photoHint: 'Lade ein klares Foto hoch, um eine personalisierte Figur zu erstellen',
    photoGuidelines: 'Tipp: Klares Gesicht, Oberkorper sichtbar funktioniert am besten',
    dropOrClick: 'Foto hierhin ziehen oder klicken zum Hochladen',
    analyzing: 'Foto wird analysiert...',
    changPhoto: 'Foto andern',
    nameLabel: 'Name',
    namePlaceholder: 'Name des Kindes',
    ageLabel: 'Alter',
    genderLabel: 'Geschlecht',
    boy: 'Junge',
    girl: 'Madchen',
    other: 'Andere',
    traitsLabel: 'Charaktereigenschaften',
    traits: ['Mutig', 'Neugierig', 'Freundlich', 'Lustig', 'Kreativ', 'Abenteuerlustig'],
    next: 'Weiter',
    termsNote: 'Mit dem Hochladen stimmst du unseren Nutzungsbedingungen zu',
    selectFace: 'Wahle das richtige Gesicht',
    noFaceDetected: 'Kein Gesicht erkannt. Bitte versuche ein anderes Foto.',
    multipleFaces: 'Mehrere Gesichter erkannt. Bitte wahle das richtige aus.',
    photoError: 'Foto konnte nicht analysiert werden. Bitte versuche es erneut.',
  },
  fr: {
    title: 'Creez votre personnage',
    photoTitle: 'Telecharger une photo',
    photoHint: 'Telechargez une photo claire pour creer un personnage personnalise',
    photoGuidelines: 'Conseil : Visage clair, haut du corps visible fonctionne le mieux',
    dropOrClick: 'Deposez une photo ici ou cliquez pour telecharger',
    analyzing: 'Analyse de la photo...',
    changPhoto: 'Changer la photo',
    nameLabel: 'Prenom',
    namePlaceholder: "Prenom de l'enfant",
    ageLabel: 'Age',
    genderLabel: 'Genre',
    boy: 'Garcon',
    girl: 'Fille',
    other: 'Autre',
    traitsLabel: 'Traits de personnalite',
    traits: ['Courageux', 'Curieux', 'Gentil', 'Drole', 'Creatif', 'Aventurier'],
    next: 'Suivant',
    termsNote: 'En telechargeant, vous acceptez nos Conditions',
    selectFace: 'Selectionnez le bon visage',
    noFaceDetected: 'Aucun visage detecte. Veuillez essayer une autre photo.',
    multipleFaces: 'Plusieurs visages detectes. Veuillez selectionner le bon.',
    photoError: "Echec de l'analyse de la photo. Veuillez reessayer.",
  },
};

// ─── Types ───────────────────────────────────────────────────────────────────

interface DetectedFace {
  faceId: string;
  thumbnail: string;
}

interface TrialCharacterStepProps {
  characterData: CharacterData;
  onChange: (data: CharacterData) => void;
  onNext: () => void;
  language: string;
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function TrialCharacterStep({ characterData, onChange, onNext, language }: TrialCharacterStepProps) {
  const t = strings[language] || strings.en;
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Photo analysis state
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [detectedFaces, setDetectedFaces] = useState<DetectedFace[]>([]);
  const [cachedFacesData, setCachedFacesData] = useState<any>(null);
  const [originalImageData, setOriginalImageData] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const hasPhoto = !!characterData.photos.face;
  const canProceed = characterData.name.trim() && characterData.age && characterData.gender && hasPhoto;

  // ─── Photo upload ────────────────────────────────────────────────────────────

  const analyzePhoto = useCallback(async (base64: string, selectedFaceId?: string, cachedFaces?: any) => {
    setIsAnalyzing(true);
    setPhotoError(null);
    setDetectedFaces([]);

    try {
      const body: any = { imageData: base64 };
      if (selectedFaceId && cachedFaces) {
        body.selectedFaceId = selectedFaceId;
        body.cachedFaces = cachedFaces;
      }

      const response = await fetch(`${import.meta.env.VITE_API_URL || ''}/api/trial/analyze-photo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const result = await response.json();

      if (!response.ok) {
        setPhotoError(result.error || t.photoError);
        return;
      }

      if (result.success) {
        if (result.multipleFacesDetected) {
          // Show face selection UI
          setDetectedFaces(result.faces || []);
          setCachedFacesData(result.cachedFaces);
          setOriginalImageData(base64);
        } else {
          // Single face - update character photos
          onChange({
            ...characterData,
            photos: {
              original: base64,
              face: result.faceThumbnail,
              body: result.bodyCrop,
              bodyNoBg: result.bodyNoBg,
              faceBox: result.faceBox,
            },
          });
          setDetectedFaces([]);
        }
      } else {
        setPhotoError(result.error || t.noFaceDetected);
      }
    } catch (err) {
      setPhotoError(t.photoError);
    } finally {
      setIsAnalyzing(false);
    }
  }, [characterData, onChange, t]);

  const handleFileSelect = useCallback((file: File) => {
    if (!file.type.startsWith('image/')) return;

    const reader = new FileReader();
    reader.onloadend = () => {
      const base64 = reader.result as string;
      analyzePhoto(base64);
    };
    reader.readAsDataURL(file);
  }, [analyzePhoto]);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFileSelect(file);
    // Reset input so same file can be re-selected
    e.target.value = '';
  };

  const handleFaceSelect = (faceId: string) => {
    if (originalImageData && cachedFacesData) {
      analyzePhoto(originalImageData, faceId, cachedFacesData);
    }
  };

  const handleRemovePhoto = () => {
    onChange({
      ...characterData,
      photos: {},
    });
    setPhotoError(null);
    setDetectedFaces([]);
    setOriginalImageData(null);
    setCachedFacesData(null);
  };

  // Drag and drop handlers
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) handleFileSelect(file);
  };

  // ─── Field updaters ──────────────────────────────────────────────────────────

  const updateField = <K extends keyof CharacterData>(key: K, value: CharacterData[K]) => {
    onChange({ ...characterData, [key]: value });
  };

  const toggleTrait = (trait: string) => {
    const current = characterData.traits;
    if (current.includes(trait)) {
      updateField('traits', current.filter((t) => t !== trait));
    } else {
      updateField('traits', [...current, trait]);
    }
  };

  // ─── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="max-w-lg mx-auto pt-4">
      <h2 className="text-2xl font-bold text-gray-900 text-center mb-6">{t.title}</h2>

      {/* Photo upload area */}
      <div className="mb-6">
        <label className="block text-sm font-semibold text-gray-700 mb-2">{t.photoTitle}</label>
        <p className="text-sm text-gray-500 mb-3">{t.photoHint}</p>

        {/* Face selection UI (multiple faces detected) */}
        {detectedFaces.length > 0 && (
          <div className="mb-4 p-4 bg-amber-50 border border-amber-200 rounded-xl">
            <p className="text-sm font-medium text-amber-800 mb-3">{t.multipleFaces}</p>
            <div className="flex flex-wrap gap-3 justify-center">
              {detectedFaces.map((face) => (
                <button
                  key={face.faceId}
                  onClick={() => handleFaceSelect(face.faceId)}
                  className="relative group"
                  disabled={isAnalyzing}
                >
                  <img
                    src={face.thumbnail}
                    alt={t.selectFace}
                    className="w-16 h-16 rounded-full object-cover border-2 border-amber-300 group-hover:border-indigo-500 transition-colors"
                  />
                  {isAnalyzing && (
                    <div className="absolute inset-0 flex items-center justify-center bg-black/30 rounded-full">
                      <Loader2 className="w-5 h-5 text-white animate-spin" />
                    </div>
                  )}
                </button>
              ))}
            </div>
          </div>
        )}

        {!hasPhoto ? (
          /* Drop zone / upload button */
          <div
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
            className={`relative border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-all ${
              isDragging
                ? 'border-indigo-500 bg-indigo-50'
                : 'border-gray-300 hover:border-indigo-400 hover:bg-indigo-50/50'
            }`}
          >
            {isAnalyzing ? (
              <div className="flex flex-col items-center gap-3 py-4">
                <Loader2 className="w-10 h-10 text-indigo-500 animate-spin" />
                <p className="text-sm text-indigo-600 font-medium">{t.analyzing}</p>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-3">
                <div className="w-16 h-16 rounded-full bg-indigo-100 flex items-center justify-center">
                  <Camera className="w-8 h-8 text-indigo-500" />
                </div>
                <div>
                  <p className="text-sm font-medium text-gray-700">{t.dropOrClick}</p>
                  <p className="text-xs text-gray-400 mt-1">{t.photoGuidelines}</p>
                </div>
              </div>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              onChange={handleInputChange}
              className="hidden"
            />
          </div>
        ) : (
          /* Photo preview */
          <div className="flex items-center gap-4 p-4 bg-white rounded-xl border border-gray-200 shadow-sm">
            <img
              src={characterData.photos.face!}
              alt={characterData.name || 'Character'}
              className="w-20 h-20 rounded-full object-cover border-2 border-indigo-200"
            />
            <div className="flex-1">
              <p className="text-sm font-medium text-green-700">Photo uploaded</p>
              <button
                onClick={handleRemovePhoto}
                className="text-xs text-gray-500 hover:text-red-600 mt-1 flex items-center gap-1 transition-colors"
              >
                <X className="w-3 h-3" />
                {t.changPhoto}
              </button>
            </div>
          </div>
        )}

        {/* Error message */}
        {photoError && (
          <p className="mt-2 text-sm text-red-600">{photoError}</p>
        )}

        {/* Terms note */}
        {!hasPhoto && (
          <p className="mt-2 text-xs text-gray-400 text-center">{t.termsNote}</p>
        )}
      </div>

      {/* Name */}
      <div className="mb-5">
        <label className="block text-sm font-semibold text-gray-700 mb-1.5">{t.nameLabel}</label>
        <input
          type="text"
          value={characterData.name}
          onChange={(e) => updateField('name', e.target.value)}
          placeholder={t.namePlaceholder}
          maxLength={30}
          className="w-full px-4 py-2.5 rounded-lg border border-gray-300 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 outline-none transition-all text-gray-900 placeholder-gray-400"
        />
      </div>

      {/* Age */}
      <div className="mb-5">
        <label className="block text-sm font-semibold text-gray-700 mb-1.5">{t.ageLabel}</label>
        <div className="flex flex-wrap gap-2">
          {Array.from({ length: 11 }, (_, i) => i + 2).map((age) => (
            <button
              key={age}
              onClick={() => updateField('age', String(age))}
              className={`w-10 h-10 rounded-lg text-sm font-medium transition-all ${
                characterData.age === String(age)
                  ? 'bg-indigo-600 text-white shadow-md'
                  : 'bg-white border border-gray-300 text-gray-700 hover:border-indigo-400 hover:bg-indigo-50'
              }`}
            >
              {age}
            </button>
          ))}
        </div>
      </div>

      {/* Gender */}
      <div className="mb-5">
        <label className="block text-sm font-semibold text-gray-700 mb-1.5">{t.genderLabel}</label>
        <div className="flex gap-3">
          {[
            { value: 'male', label: t.boy },
            { value: 'female', label: t.girl },
            { value: 'other', label: t.other },
          ].map(({ value, label }) => (
            <button
              key={value}
              onClick={() => updateField('gender', value)}
              className={`flex-1 py-2.5 rounded-lg text-sm font-medium transition-all ${
                characterData.gender === value
                  ? 'bg-indigo-600 text-white shadow-md'
                  : 'bg-white border border-gray-300 text-gray-700 hover:border-indigo-400 hover:bg-indigo-50'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Traits */}
      <div className="mb-8">
        <label className="block text-sm font-semibold text-gray-700 mb-1.5">{t.traitsLabel}</label>
        <div className="flex flex-wrap gap-2">
          {t.traits.map((trait) => (
            <button
              key={trait}
              onClick={() => toggleTrait(trait)}
              className={`px-4 py-2 rounded-full text-sm font-medium transition-all ${
                characterData.traits.includes(trait)
                  ? 'bg-indigo-600 text-white shadow-md'
                  : 'bg-white border border-gray-300 text-gray-700 hover:border-indigo-400 hover:bg-indigo-50'
              }`}
            >
              {trait}
            </button>
          ))}
        </div>
      </div>

      {/* Next button */}
      <button
        onClick={onNext}
        disabled={!canProceed}
        className={`w-full py-3 rounded-xl text-base font-semibold flex items-center justify-center gap-2 transition-all ${
          canProceed
            ? 'bg-indigo-600 text-white hover:bg-indigo-700 shadow-lg shadow-indigo-200'
            : 'bg-gray-200 text-gray-400 cursor-not-allowed'
        }`}
      >
        {t.next}
        <ArrowRight className="w-4 h-4" />
      </button>
    </div>
  );
}
