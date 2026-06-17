import { useState, useRef, useCallback, useEffect } from 'react';
import { Camera, Loader2, X, ArrowRight, CheckSquare, Square } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { Turnstile } from '@marsidev/react-turnstile';
import FingerprintJS from '@fingerprintjs/fingerprintjs';
import type { CharacterData } from '../TrialWizard';
import { defaultStrengths } from '@/constants/traits';
import type { Language } from '@/types/story';

const TURNSTILE_SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY || '';

// ─── Localized strings ──────────────────────────────────────────────────────

const strings: Record<string, {
  title: string;
  photoTitle: string;
  photoHint: string;
  photoGuidelines: string;
  dropOrClick: string;
  analyzing: string;
  changePhoto: string;
  nameLabel: string;
  namePlaceholder: string;
  ageLabel: string;
  agePlaceholder: string;
  genderLabel: string;
  boy: string;
  girl: string;
  traitsLabel: string;
  customTraitsLabel: string;
  customTraitsPlaceholder: string;
  next: string;
  nextNoPhoto: string;
  nextNoDetails: string;
  continueLabel: string;
  back: string;
  consentBefore: string;
  termsLink: string;
  consentMiddle: string;
  privacyLink: string;
  consentAfter: string;
  pleaseAccept: string;
  selectFace: string;
  noFaceDetected: string;
  multipleFaces: string;
  photoError: string;
  photoUploaded: string;
  traitsOptional: string;
  avatarReward: string;
  avatarRewardChild: string;
  avatarCreating: string;
}> = {
  en: {
    title: 'Create Your Hero',
    photoTitle: 'Upload a Photo',
    photoHint: 'Upload a photo of your child',
    photoGuidelines: 'Face and upper body must be visible',
    dropOrClick: 'Drop photo or click to upload',
    analyzing: 'Analyzing photo...',
    changePhoto: 'Change photo',
    nameLabel: 'Name',
    namePlaceholder: "Child's name",
    ageLabel: 'Age',
    agePlaceholder: 'e.g. 5',
    genderLabel: 'Gender',
    boy: 'Boy',
    girl: 'Girl',
    traitsLabel: 'Traits',
    customTraitsLabel: 'Additional characteristics',
    customTraitsPlaceholder: 'Loves dinosaurs, afraid of the dark, has a little sister...',
    next: 'Next',
    nextNoPhoto: 'Add photo and details to continue',
    nextNoDetails: 'Add details to continue',
    continueLabel: 'Continue',
    back: 'Back',
    consentBefore: "I'm the child's parent or guardian (or have their consent), and I accept the ",
    termsLink: 'Terms of Service',
    consentMiddle: ' and ',
    privacyLink: 'Privacy Policy',
    consentAfter: ', including AI processing of the photo to create avatars.',
    pleaseAccept: 'Please accept the terms above to upload a photo',
    selectFace: 'Select the correct face',
    noFaceDetected: 'No face detected. Please try a different photo.',
    multipleFaces: 'Multiple faces detected. Please select the correct one.',
    photoError: 'Failed to analyze photo. Please try again.',
    photoUploaded: 'Photo uploaded',
    traitsOptional: 'optional — skip if you like',
    avatarReward: "Here's {name} as a character!",
    avatarRewardChild: 'Here\'s your child as a character!',
    avatarCreating: 'Creating your character…',
  },
  de: {
    title: 'Erstelle deinen Helden',
    photoTitle: 'Foto hochladen',
    photoHint: 'Lade ein Foto deines Kindes hoch',
    photoGuidelines: 'Gesicht und Oberkörper müssen sichtbar sein',
    dropOrClick: 'Foto hierhin ziehen oder klicken',
    analyzing: 'Foto wird analysiert...',
    changePhoto: 'Foto ändern',
    nameLabel: 'Name',
    namePlaceholder: 'Name des Kindes',
    ageLabel: 'Alter',
    agePlaceholder: 'z.B. 5',
    genderLabel: 'Geschlecht',
    boy: 'Junge',
    girl: 'Mädchen',
    traitsLabel: 'Eigenschaften',
    customTraitsLabel: 'Weitere Eigenschaften',
    customTraitsPlaceholder: 'Liebt Dinosaurier, hat Angst vor der Dunkelheit, hat eine kleine Schwester...',
    next: 'Weiter',
    nextNoPhoto: 'Foto und Details hinzufügen, um fortzufahren',
    nextNoDetails: 'Details hinzufügen, um fortzufahren',
    continueLabel: 'Weiter',
    back: 'Zurück',
    consentBefore: 'Ich bin Elternteil/erziehungsberechtigt (oder habe die Zustimmung) und akzeptiere die ',
    termsLink: 'AGB',
    consentMiddle: ' und ',
    privacyLink: 'Datenschutzerklärung',
    consentAfter: ', einschliesslich der KI-Verarbeitung des Fotos zur Erstellung von Avataren.',
    pleaseAccept: 'Bitte akzeptieren Sie die obigen Bedingungen, um ein Foto hochzuladen',
    selectFace: 'Wähle das richtige Gesicht',
    noFaceDetected: 'Kein Gesicht erkannt. Bitte versuche ein anderes Foto.',
    multipleFaces: 'Mehrere Gesichter erkannt. Bitte wähle das richtige aus.',
    photoError: 'Foto konnte nicht analysiert werden. Bitte versuche es erneut.',
    photoUploaded: 'Foto hochgeladen',
    traitsOptional: 'optional — kannst du überspringen',
    avatarReward: 'Hier ist {name} als Figur!',
    avatarRewardChild: 'Hier ist dein Kind als Figur!',
    avatarCreating: 'Deine Figur wird erstellt…',
  },
  fr: {
    title: 'Créez votre héros',
    photoTitle: 'Télécharger une photo',
    photoHint: 'Téléchargez une photo de votre enfant',
    photoGuidelines: 'Le visage et le haut du corps doivent être visibles',
    dropOrClick: 'Déposez une photo ou cliquez pour télécharger',
    analyzing: 'Analyse de la photo...',
    changePhoto: 'Changer la photo',
    nameLabel: 'Prénom',
    namePlaceholder: "Prénom de l'enfant",
    ageLabel: 'Âge',
    agePlaceholder: 'ex. 5',
    genderLabel: 'Genre',
    boy: 'Garçon',
    girl: 'Fille',
    traitsLabel: 'Traits',
    customTraitsLabel: 'Caractéristiques supplémentaires',
    customTraitsPlaceholder: 'Aime les dinosaures, a peur du noir, a une petite soeur...',
    next: 'Suivant',
    nextNoPhoto: 'Ajoute photo et détails pour continuer',
    nextNoDetails: 'Ajoute les détails pour continuer',
    continueLabel: 'Continuer',
    back: 'Retour',
    consentBefore: "Je suis le parent ou le tuteur de l'enfant (ou j'ai son consentement) et j'accepte les ",
    termsLink: "Conditions d'utilisation",
    consentMiddle: ' et la ',
    privacyLink: 'Politique de confidentialité',
    consentAfter: ', y compris le traitement de la photo par IA pour créer des avatars.',
    pleaseAccept: 'Veuillez accepter les conditions ci-dessus pour télécharger une photo',
    selectFace: 'Sélectionnez le bon visage',
    noFaceDetected: 'Aucun visage détecté. Veuillez essayer une autre photo.',
    multipleFaces: 'Plusieurs visages détectés. Veuillez sélectionner le bon.',
    photoError: "Échec de l'analyse de la photo. Veuillez réessayer.",
    photoUploaded: 'Photo téléchargée',
    traitsOptional: 'optionnel — tu peux passer',
    avatarReward: 'Voici {name} en personnage !',
    avatarRewardChild: 'Voici votre enfant en personnage !',
    avatarCreating: 'Création de votre personnage…',
  },
  it: {
    title: 'Crea il tuo eroe',
    photoTitle: 'Carica una foto',
    photoHint: 'Carica una foto del tuo bambino',
    photoGuidelines: 'Il viso e la parte superiore del corpo devono essere visibili',
    dropOrClick: 'Trascina una foto o clicca per caricare',
    analyzing: 'Analisi della foto...',
    changePhoto: 'Cambia foto',
    nameLabel: 'Nome',
    namePlaceholder: 'Nome del bambino',
    ageLabel: 'Età',
    agePlaceholder: 'es. 5',
    genderLabel: 'Sesso',
    boy: 'Maschio',
    girl: 'Femmina',
    traitsLabel: 'Caratteristiche',
    customTraitsLabel: 'Ulteriori caratteristiche',
    customTraitsPlaceholder: 'Ama i dinosauri, ha paura del buio, ha una sorellina...',
    next: 'Avanti',
    nextNoPhoto: 'Aggiungi foto e dettagli per continuare',
    nextNoDetails: 'Aggiungi i dettagli per continuare',
    continueLabel: 'Continua',
    back: 'Indietro',
    consentBefore: 'Sono il genitore o il tutore del bambino (o ho il suo consenso) e accetto i ',
    termsLink: 'Termini di servizio',
    consentMiddle: " e l'",
    privacyLink: 'Informativa sulla privacy',
    consentAfter: ', inclusa l\'elaborazione della foto tramite IA per creare avatar.',
    pleaseAccept: 'Accetta le condizioni qui sopra per caricare una foto',
    selectFace: 'Seleziona il viso corretto',
    noFaceDetected: 'Nessun viso rilevato. Prova con un\'altra foto.',
    multipleFaces: 'Rilevati più visi. Seleziona quello corretto.',
    photoError: 'Impossibile analizzare la foto. Riprova.',
    photoUploaded: 'Foto caricata',
    traitsOptional: 'opzionale — puoi saltare',
    avatarReward: 'Ecco {name} come personaggio!',
    avatarRewardChild: 'Ecco il tuo bambino come personaggio!',
    avatarCreating: 'Creazione del tuo personaggio…',
  },
};

// ─── Types ───────────────────────────────────────────────────────────────────

interface DetectedFace {
  id: string;
  thumbnail: string;
}

interface TrialCharacterStepProps {
  characterData: CharacterData;
  onChange: (data: CharacterData) => void;
  onNext: () => void;
  previewAvatar?: string | null;
  onAvatarGenerated?: (avatarImage: string) => void;
  onAccountCreated?: (sessionToken: string, characterId: string) => void;
  sessionToken?: string | null;
  language: string;
  adminToken?: string | null;
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function TrialCharacterStep({ characterData, onChange, onNext, previewAvatar, onAvatarGenerated, onAccountCreated, sessionToken, language, adminToken }: TrialCharacterStepProps) {
  const t = strings[language] || strings.en;
  const navigate = useNavigate();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const turnstileRef = useRef<any>(null);

  // Turnstile + Fingerprint for abuse prevention
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [fingerprint, setFingerprint] = useState<string | null>(null);

  // Initialize fingerprint on mount
  useEffect(() => {
    FingerprintJS.load().then(fp => fp.get()).then(result => {
      setFingerprint(result.visitorId);
    }).catch(() => {
      // Fingerprint failed — other layers still protect
    });
  }, []);

  // Two-phase flow internal to this step: 'photo' (consent + upload + avatar
  // reward) then 'details' (name/gender/age/traits). The wizard's STEPS array
  // and progress bar are unchanged — this split is purely local.
  const [phase, setPhase] = useState<'photo' | 'details'>('photo');

  // Consent state — once checked and a photo is uploaded, don't ask again.
  // consentGiven is stored in characterData (parent state) so it survives component remounts
  const [consentChecked, setConsentChecked] = useState(false);
  const hasConsented = !!characterData.consentGiven;
  const canUpload = hasConsented || consentChecked;

  // Keep a ref to the latest characterData so async callbacks don't use stale closures
  const characterDataRef = useRef(characterData);
  useEffect(() => { characterDataRef.current = characterData; }, [characterData]);

  // Photo analysis state
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [detectedFaces, setDetectedFaces] = useState<DetectedFace[]>([]);
  const [cachedFacesData, setCachedFacesData] = useState<any>(null);
  const [originalImageData, setOriginalImageData] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  // Avatar generation state
  const [isGeneratingAvatar, setIsGeneratingAvatar] = useState(false);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const [isCreatingAccount, setIsCreatingAccount] = useState(false);

  // Background create-anonymous-account. As soon as the form is valid we
  // fire the create call in the background — by the time the user clicks
  // "Next" the promise has usually already resolved, so they advance with
  // no perceivable wait. Without this, the click triggers a 5-12s blocking
  // call (DB inserts + Gemini trait extraction + DB updates).
  const accountCreationPromiseRef = useRef<Promise<{ sessionToken: string; characterId: string } | null> | null>(null);
  // Snapshot of the user-facing fields that were sent with the prewarm. On
  // Next we compare this to the current form state and PATCH any
  // diffs to /api/trial/update-character-details — so a name edited after
  // the prewarm still lands on the character row before advancing.
  const sentSnapshotRef = useRef<{ name: string; age: string; gender: string; traits: string[]; customTraits: string } | null>(null);

  const buildDetailsSnapshot = (data: CharacterData) => ({
    name: (data.name || '').trim(),
    age: String(data.age || ''),
    gender: data.gender || '',
    traits: [...(data.traits || [])].sort(),
    customTraits: data.customTraits || '',
  });

  const detailsDiffer = (a: ReturnType<typeof buildDetailsSnapshot>, b: ReturnType<typeof buildDetailsSnapshot>) => (
    a.name !== b.name
    || a.age !== b.age
    || a.gender !== b.gender
    || a.customTraits !== b.customTraits
    || a.traits.length !== b.traits.length
    || a.traits.some((t, i) => t !== b.traits[i])
  );

  const hasPhoto = !!characterData.photos.face;
  const canProceed = characterData.name.trim() && characterData.gender && hasPhoto;

  // Track which face photo the current avatar was generated for
  const facePhotoKey = characterData.photos.face ? characterData.photos.face.slice(-40) : '';
  // Initialize with current facePhotoKey if avatar already exists (survives component remount)
  const avatarPhotoKeyRef = useRef<string>(previewAvatar ? facePhotoKey : '');

  // Start avatar generation in the background as soon as photo is ready
  // Re-triggers when photo changes (different face photo = different key)
  useEffect(() => {
    if (!hasPhoto || isGeneratingAvatar) return;
    if (!characterData.photos.face) return;
    // Skip if avatar was already generated for this exact photo
    if (previewAvatar && avatarPhotoKeyRef.current === facePhotoKey) return;

    // Clear stale avatar from previous photo
    if (previewAvatar && avatarPhotoKeyRef.current !== facePhotoKey) {
      onAvatarGenerated?.(null as any);
    }

    setIsGeneratingAvatar(true);

    const generateAvatar = async () => {
      try {
        // Use current character data for prompt hints (defaults if not yet filled in)
        const data = characterDataRef.current;
        // Prefer bodyNoBg (shows clothing) with face as fallback
        const photoToSend = data.photos.bodyNoBg || data.photos.face;
        const response = await fetch(`${import.meta.env.VITE_API_URL || ''}/api/trial/generate-preview-avatar`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: data.name || 'Child',
            age: data.age || '7',
            gender: data.gender || '',
            facePhoto: photoToSend,
            fingerprint,
          }),
        });

        const result = await response.json();
        if (response.ok && result.avatarImage) {
          avatarPhotoKeyRef.current = facePhotoKey;
          onAvatarGenerated?.(result.avatarImage);
        }
      } catch {
        // Avatar generation failure is non-blocking
      } finally {
        setIsGeneratingAvatar(false);
      }
    };

    generateAvatar();
  // Trigger when photo changes (facePhotoKey changes when different photo uploaded)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasPhoto, facePhotoKey]);

  // Shared account creation logic — invoked either by the background prewarm
  // effect (the moment the form first becomes valid) or by handleNext as a
  // fallback if the prewarm hasn't fired yet. Returns null on failure so the
  // caller can decide how to surface the error.
  const startAccountCreation = async (): Promise<{ sessionToken: string; characterId: string } | null> => {
    const data = characterDataRef.current;
    if (!data.photos.face || !data.name?.trim()) return null;

    // Refresh Turnstile token if expired.
    let token = turnstileToken;
    if (!token && TURNSTILE_SITE_KEY && turnstileRef.current) {
      turnstileRef.current.reset();
      for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 500));
        token = turnstileRef.current?.getResponse?.() || null;
        if (token) break;
      }
    }

    // Snapshot the user-facing fields we're sending so the dirty-check on
    // Next knows whether a PATCH is needed.
    sentSnapshotRef.current = buildDetailsSnapshot(data);
    const accountResponse = await fetch(`${import.meta.env.VITE_API_URL || ''}/api/trial/create-anonymous-account`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: data.name,
        age: data.age,
        gender: data.gender,
        traits: data.traits,
        customTraits: data.customTraits,
        facePhoto: data.photos.face,
        bodyPhoto: data.photos.body,
        bodyNoBgPhoto: data.photos.bodyNoBg,
        faceBox: data.photos.faceBox,
        previewAvatar: previewAvatar || undefined,
        turnstileToken: token,
        fingerprint,
        ...(adminToken ? { adminToken } : {}),
      }),
    });
    const accountResult = await accountResponse.json();
    if (!accountResponse.ok) {
      // On any block (Turnstile, fingerprint, rate limit) — propagate; caller
      // can redirect to /?signup=true. The prewarm path silently swallows.
      const err = new Error(accountResult?.error || `create-anonymous-account failed (${accountResponse.status})`);
      (err as unknown as { status: number }).status = accountResponse.status;
      throw err;
    }
    return {
      sessionToken: accountResult.sessionToken,
      characterId: accountResult.characterId || accountResult.charId,
    };
  };

  // Prewarm: fire create-anonymous-account in the background the moment the
  // form is valid. Runs once per session — if the user changes form fields
  // afterwards, the latest values still flow into the request body because
  // startAccountCreation reads from characterDataRef.current at fetch time
  // (not at promise-creation time).
  //
  // Wait, that's only true for the FIRST call. After the promise is set, the
  // request body has already been serialised. So later edits are lost. For
  // trial this is acceptable: the user usually fills the form once. We could
  // add a re-fire on field-change but it'd risk creating multiple anonymous
  // accounts on every keystroke. Trade-off documented; revisit if reports
  // surface.
  useEffect(() => {
    if (!canProceed) return;
    if (sessionToken) return; // already have one (back/forward nav)
    if (accountCreationPromiseRef.current) return; // already in flight
    accountCreationPromiseRef.current = startAccountCreation().catch(() => null);
  // Trigger exactly when canProceed flips true — readiness to fire.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canProceed, sessionToken]);

  // Create anonymous account (if not already done in background) and advance.
  const handleNext = async () => {
    if (!canProceed || !characterData.photos.face) return;

    // If user already has a session (navigated back and forward), skip account creation
    if (sessionToken) {
      onNext();
      return;
    }

    setIsCreatingAccount(true);
    setAvatarError(null);

    try {
      // Prefer the prewarmed in-flight call. If it hasn't been kicked off yet
      // (e.g. handleNext ran the same tick canProceed became true), fire it now.
      if (!accountCreationPromiseRef.current) {
        accountCreationPromiseRef.current = startAccountCreation();
      }
      const result = await accountCreationPromiseRef.current;
      let activeSession: { sessionToken: string; characterId: string } | null = result;
      if (!result) {
        // Prewarm failed silently — try once more synchronously so the user
        // gets a real error to react to, not a silent abort.
        const retry = await startAccountCreation();
        if (!retry) throw new Error('Account creation failed');
        activeSession = retry;
      }

      // Sync any field edits made after the prewarm fired. The prewarm sent
      // a fixed body; later name/gender/age/traits/customTraits edits
      // wouldn't reach the DB without this PATCH.
      const currentSnapshot = buildDetailsSnapshot(characterDataRef.current);
      if (sentSnapshotRef.current && detailsDiffer(currentSnapshot, sentSnapshotRef.current)) {
        try {
          const patchResp = await fetch(`${import.meta.env.VITE_API_URL || ''}/api/trial/update-character-details`, {
            method: 'PATCH',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${activeSession!.sessionToken}`,
            },
            body: JSON.stringify({
              name: currentSnapshot.name,
              age: currentSnapshot.age,
              gender: currentSnapshot.gender,
              traits: characterDataRef.current.traits,
              customTraits: currentSnapshot.customTraits,
            }),
          });
          if (patchResp.ok) {
            sentSnapshotRef.current = currentSnapshot;
          } else {
            // Don't block advance on the sync — log + continue. Topic step
            // re-reads from local state, so the user still sees their edits.
            console.warn('[TRIAL] update-character-details failed:', patchResp.status);
          }
        } catch (patchErr) {
          console.warn('[TRIAL] update-character-details network error:', patchErr);
        }
      }

      if (onAccountCreated && activeSession) {
        onAccountCreated(activeSession.sessionToken, activeSession.characterId);
      }
    } catch (err) {
      const status = (err as { status?: number })?.status;
      if (status && status >= 400 && status < 500) {
        navigate('/?signup=true');
        return;
      }
      setAvatarError('Account creation failed. Please try again.');
      setIsCreatingAccount(false);
      accountCreationPromiseRef.current = null; // allow retry
      return;
    }

    setIsCreatingAccount(false);
    onNext();
  };

  // ─── Photo upload ────────────────────────────────────────────────────────────

  const analyzePhoto = useCallback(async (base64: string, selectedFaceId?: string, cachedFaces?: any) => {
    setIsAnalyzing(true);
    setPhotoError(null);
    setDetectedFaces([]);

    try {
      const body: any = { imageData: base64 };
      if (selectedFaceId != null && cachedFaces) {
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
          // Single face - use ref to get latest characterData (user may have edited fields during analysis)
          onChange({
            ...characterDataRef.current,
            consentGiven: true,
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
  }, [onChange, t]);

  // Resize image to reduce upload size (max 1500px on longest side, JPEG 85%)
  const resizeImage = (dataUrl: string, maxSize = 1500): Promise<string> => {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        let { width, height } = img;
        if (width > maxSize || height > maxSize) {
          if (width > height) {
            height = Math.round((height * maxSize) / width);
            width = maxSize;
          } else {
            width = Math.round((width * maxSize) / height);
            height = maxSize;
          }
        }
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx?.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', 0.85));
      };
      img.onerror = () => resolve(dataUrl);
      img.src = dataUrl;
    });
  };

  const handleFileSelect = useCallback((file: File) => {
    if (!file.type.startsWith('image/')) return;

    const reader = new FileReader();
    reader.onloadend = async () => {
      const raw = reader.result as string;
      const resized = await resizeImage(raw);
      analyzePhoto(resized);
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

  // Avatar reward / progress element. Shown prominently on the 'photo' phase
  // (size="large") and smaller on the 'details' phase (size="small").
  const renderAvatarReward = (size: 'large' | 'small') => {
    if (!hasPhoto) return null;
    if (!previewAvatar && !isGeneratingAvatar) return null;
    const imgSize = size === 'large' ? 'w-40 h-40' : 'w-20 h-20';
    const rewardLabel = characterData.name.trim()
      ? t.avatarReward.replace('{name}', characterData.name.trim())
      : t.avatarRewardChild;
    return (
      <div className="flex flex-col items-center gap-3 p-4 bg-white rounded-xl border border-gray-200 shadow-sm">
        {isGeneratingAvatar && !previewAvatar ? (
          <>
            <div className={`${imgSize} rounded-2xl bg-indigo-50 flex items-center justify-center`}>
              <Loader2 className="w-10 h-10 text-indigo-500 animate-spin" />
            </div>
            <p className="text-sm text-indigo-500 font-medium">{t.avatarCreating}</p>
          </>
        ) : previewAvatar ? (
          <>
            <img
              src={previewAvatar}
              alt={rewardLabel}
              className={`${imgSize} rounded-2xl object-cover border-2 border-indigo-200`}
            />
            <p className="text-sm font-semibold text-indigo-600 text-center">{rewardLabel}</p>
          </>
        ) : null}
      </div>
    );
  };

  // ── Photo upload block (consent + dropzone + face picker) ──────────────────
  const photoUploadBlock = (
    <div>
      <label className="block text-sm font-semibold text-gray-700 mb-2">{t.photoTitle}</label>
      <p className="text-sm text-gray-500 mb-3">{t.photoHint}</p>

      {/* Face selection UI (multiple faces detected) */}
      {detectedFaces.length > 0 && (
            <div className="mb-4 p-4 bg-amber-50 border border-amber-200 rounded-xl">
              <p className="text-sm font-medium text-amber-800 mb-3">{t.multipleFaces}</p>
              <div className="flex flex-wrap gap-3 justify-center">
                {detectedFaces.map((face) => (
                  <button
                    key={face.id}
                    onClick={() => handleFaceSelect(face.id)}
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

          {/* Single consent checkbox - shown before first upload only.
              Combines the parent/guardian attestation and the Terms/Privacy +
              AI-processing acceptance into one statement. Uses role=checkbox +
              aria-checked + Space/Enter keyboard handler so screen-reader and
              keyboard-only users can interact — without these, VoiceOver/NVDA
              see a plain div and keyboard users can't tab to it. */}
          {!hasPhoto && !hasConsented && (
            <div className="bg-white rounded-lg p-4 mb-4 border border-gray-200">
              <div
                role="checkbox"
                aria-checked={consentChecked}
                tabIndex={0}
                onClick={(e) => {
                  if ((e.target as HTMLElement).tagName !== 'A') {
                    setConsentChecked(!consentChecked);
                  }
                }}
                onKeyDown={(e) => {
                  // Enter inside a link element should follow the link,
                  // not toggle the consent — let the browser handle it.
                  if ((e.target as HTMLElement).tagName === 'A') return;
                  if (e.key === ' ' || e.key === 'Enter') {
                    e.preventDefault();
                    setConsentChecked(!consentChecked);
                  }
                }}
                className="flex items-start gap-3 cursor-pointer group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 rounded"
              >
                <span className="flex-shrink-0 mt-0.5 text-indigo-500 hover:text-indigo-800">
                  {consentChecked ? <CheckSquare size={20} /> : <Square size={20} />}
                </span>
                <span className="text-sm text-gray-700 group-hover:text-gray-900">
                  {t.consentBefore}
                  <Link to="/terms" className="text-indigo-500 hover:underline">
                    {t.termsLink}
                  </Link>
                  {t.consentMiddle}
                  <Link to="/privacy" className="text-indigo-500 hover:underline">
                    {t.privacyLink}
                  </Link>
                  {t.consentAfter}
                </span>
              </div>
            </div>
          )}

          {!hasPhoto ? (
            <div
              onDragOver={canUpload ? handleDragOver : undefined}
              onDragLeave={canUpload ? handleDragLeave : undefined}
              onDrop={canUpload ? handleDrop : undefined}
              onClick={() => canUpload && fileInputRef.current?.click()}
              className={`relative border-2 border-dashed rounded-xl p-8 text-center transition-all ${
                !canUpload
                  ? 'border-gray-200 bg-gray-50 cursor-not-allowed opacity-60'
                  : isDragging
                    ? 'border-indigo-500 bg-indigo-50 cursor-pointer'
                    : 'border-gray-300 hover:border-indigo-400 hover:bg-indigo-50/50 cursor-pointer'
              }`}
            >
              {isAnalyzing ? (
                <div className="flex flex-col items-center gap-3 py-4">
                  <Loader2 className="w-10 h-10 text-indigo-500 animate-spin" />
                  <p className="text-sm text-indigo-500 font-medium">{t.analyzing}</p>
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
            <div className="flex items-center gap-4 p-4 bg-white rounded-xl border border-gray-200 shadow-sm">
              <img
                src={characterData.photos.face!}
                alt={characterData.name || 'Character'}
                className="w-20 h-20 rounded-full object-cover border-2 border-indigo-200"
              />
              <div className="flex-1">
                <p className="text-sm font-medium text-green-700">{t.photoUploaded}</p>
                <button
                  onClick={handleRemovePhoto}
                  className="text-xs text-gray-500 hover:text-red-600 mt-1 flex items-center gap-1 transition-colors"
                >
                  <X className="w-3 h-3" />
                  {t.changePhoto}
                </button>
              </div>
            </div>
          )}

          {photoError && (
            <p className="mt-2 text-sm text-red-600">{photoError}</p>
          )}
          {!hasPhoto && !hasConsented && !canUpload && (
            <p className="mt-2 text-sm text-amber-600 text-center">{t.pleaseAccept}</p>
          )}
    </div>
  );

  // ── Character details block (name / gender / age / traits) ─────────────────
  const detailsBlock = (
    <div>
          {/* Name */}
          <div className="mb-5">
            <label className="block text-sm font-semibold text-gray-700 mb-1.5">{t.nameLabel} <span className="text-red-400">*</span></label>
            <input
              type="text"
              value={characterData.name}
              onChange={(e) => updateField('name', e.target.value)}
              placeholder={t.namePlaceholder}
              maxLength={30}
              className={`w-full px-4 py-2.5 rounded-lg border outline-none transition-all text-gray-900 placeholder-gray-400 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 ${
                hasPhoto && !characterData.name.trim() ? 'border-red-300 bg-red-50/30' : 'border-gray-300'
              }`}
            />
          </div>

          {/* Age + Gender row */}
          <div className="grid grid-cols-2 gap-4 mb-5">
            <div>
              <label className="block text-sm font-semibold text-gray-700 mb-1.5">{t.ageLabel}</label>
              <input
                type="number"
                min={1}
                max={18}
                value={characterData.age}
                onChange={(e) => updateField('age', e.target.value)}
                placeholder={t.agePlaceholder}
                className="w-full px-4 py-2.5 rounded-lg border border-gray-300 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 outline-none transition-all text-gray-900 placeholder-gray-400"
              />
            </div>
            <div>
              <label className="block text-sm font-semibold text-gray-700 mb-1.5">{t.genderLabel} <span className="text-red-400">*</span></label>
              <div className={`flex gap-2 rounded-lg ${hasPhoto && !characterData.gender ? 'ring-2 ring-red-200' : ''}`}>
                {[
                  { value: 'male', label: t.boy },
                  { value: 'female', label: t.girl },
                ].map(({ value, label }) => (
                  <button
                    key={value}
                    onClick={() => updateField('gender', value)}
                    className={`flex-1 py-2.5 rounded-lg text-sm font-medium transition-all ${
                      characterData.gender === value
                        ? 'bg-indigo-500 text-white shadow-md'
                        : hasPhoto && !characterData.gender
                          ? 'bg-red-50/30 border border-red-300 text-gray-700 hover:border-indigo-400 hover:bg-indigo-50'
                          : 'bg-white border border-gray-300 text-gray-700 hover:border-indigo-400 hover:bg-indigo-50'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Traits — optional, never gates Next */}
          <div className="mb-5">
            <label className="block text-sm font-semibold text-gray-700 mb-1.5">
              {t.traitsLabel} <span className="font-normal text-gray-400">({t.traitsOptional})</span>
            </label>
            <div className="flex flex-wrap gap-2">
              {(defaultStrengths[language as Language] || defaultStrengths.en).map((trait) => (
                <button
                  key={trait}
                  onClick={() => toggleTrait(trait)}
                  className={`px-3 py-1.5 rounded-full text-sm font-medium transition-all ${
                    characterData.traits.includes(trait)
                      ? 'bg-indigo-500 text-white shadow-md'
                      : 'bg-white border border-gray-300 text-gray-700 hover:border-indigo-400 hover:bg-indigo-50'
                  }`}
                >
                  {trait}
                </button>
              ))}
            </div>
          </div>

          {/* Custom traits text */}
          <div className="mb-6">
            <label className="block text-sm font-semibold text-gray-700 mb-1.5">{t.customTraitsLabel}</label>
            <textarea
              value={characterData.customTraits}
              onChange={(e) => updateField('customTraits', e.target.value)}
              placeholder={t.customTraitsPlaceholder}
              maxLength={500}
              rows={2}
              className="w-full px-4 py-2.5 rounded-lg border border-gray-300 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 outline-none transition-all text-gray-900 placeholder-gray-400 resize-none"
            />
          </div>
    </div>
  );

  // Shared button styling for the primary CTA on both phases.
  const ctaClass = (enabled: boolean) =>
    `w-full py-3 rounded-xl text-base font-semibold flex items-center justify-center gap-2 transition-all ${
      enabled
        ? 'bg-indigo-500 text-white hover:bg-indigo-600 shadow-lg shadow-indigo-200'
        : 'bg-gray-200 text-gray-400 cursor-not-allowed'
    }`;

  return (
    <div className="max-w-4xl mx-auto pt-4">
      <h2 className="text-2xl font-bold text-gray-900 text-center mb-6">{t.title}</h2>

      {phase === 'photo' ? (
        // ── Phase 1: consent + photo upload + avatar reward ─────────────────
        <div className="max-w-md mx-auto space-y-6">
          {photoUploadBlock}

          {renderAvatarReward('large')}

          {/* Continue → details phase (enabled once a photo exists) */}
          <button
            onClick={() => setPhase('details')}
            disabled={!hasPhoto}
            className={ctaClass(!!hasPhoto)}
          >
            {t.continueLabel}
            <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      ) : (
        // ── Phase 2: small avatar + name/gender/age/traits + Next ───────────
        <div className="max-w-md mx-auto space-y-6">
          {/* Back to photo phase (does NOT call the wizard onBack) */}
          <button
            onClick={() => setPhase('photo')}
            className="text-sm text-gray-500 hover:text-indigo-600 flex items-center gap-1 transition-colors"
          >
            <ArrowRight className="w-4 h-4 rotate-180" />
            {t.back}
          </button>

          {renderAvatarReward('small')}

          {detailsBlock}

          {/* Avatar generation error */}
          {avatarError && (
            <p className="text-sm text-red-600 text-center">{avatarError}</p>
          )}

          {/* Next button — wired to handleNext (unchanged) */}
          <button
            onClick={handleNext}
            disabled={!canProceed || isCreatingAccount}
            className={ctaClass(!!canProceed && !isCreatingAccount)}
          >
            {isCreatingAccount ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
              </>
            ) : isGeneratingAvatar && canProceed ? (
              // Avatar prewarm running but all required fields filled — button
              // is enabled, label reflects the background work that's finishing.
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>{characterData.name || '...'} {language === 'de' ? 'wird erstellt' : language === 'fr' ? 'en cours de création' : language === 'it' ? 'in fase di creazione' : 'is being created'}</span>
                <ArrowRight className="w-4 h-4" />
              </>
            ) : !canProceed ? (
              // Button is disabled because required fields are missing — tell
              // the user what's outstanding instead of a plain greyed-out "Weiter".
              <span>{!hasPhoto ? t.nextNoPhoto : t.nextNoDetails}</span>
            ) : (
              <>
                {t.next}
                <ArrowRight className="w-4 h-4" />
              </>
            )}
          </button>
        </div>
      )}

      {/* Invisible Turnstile widget for bot protection — mounted on BOTH
          phases (needed for account creation which fires on canProceed). */}
      {TURNSTILE_SITE_KEY && (
        <Turnstile
          ref={turnstileRef}
          siteKey={TURNSTILE_SITE_KEY}
          onSuccess={(token) => { setTurnstileToken(token); }}
          onExpire={() => { setTurnstileToken(null); turnstileRef.current?.reset(); }}
          onError={() => {}} // widget error is non-blocking; token fetched at submit time
          options={{ size: 'invisible' }}
        />
      )}
    </div>
  );
}
