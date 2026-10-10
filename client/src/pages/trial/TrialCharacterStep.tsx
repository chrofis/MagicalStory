import { useState, useRef, useCallback, useEffect } from 'react';
import TrialHeroAvatar from './TrialHeroAvatar';
import { Camera, Loader2, X, ArrowRight, CheckSquare, Square } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { Turnstile } from '@marsidev/react-turnstile';
import FingerprintJS from '@fingerprintjs/fingerprintjs';
import type { CharacterData } from '../TrialWizard';
import { defaultStrengths } from '@/constants/traits';
import { MAX_STRENGTHS } from '@/constants/traitLimits';
import type { Language } from '@/types/story';
import { trackTrialStep } from '@/utils/trialFunnel';
import { classifyAccountCreateFailure } from '@/utils/trialSession';
import { localizedApiError } from '@/utils/apiErrors';

const TURNSTILE_SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY || '';
// The standard avatar sheet starts once the form has not changed for this long (an age of two digits passes the
// validity check at its first digit, and the account is created on that instant).
const STANDARD_AVATAR_QUIET_MS = 2000;

/** Whole years 1-18, matching the server's parseTrialAge; the server rejects the same values independently. */
const isValidTrialAge = (raw: string) => /^\d{1,3}$/.test(raw.trim()) && Number(raw) >= 1 && Number(raw) <= 18;

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
  ageRequired: string;
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
  accountFailed: string;
  verificationFailed: string;
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
    ageRequired: 'Please enter an age between 1 and 18',
    continueLabel: 'Continue',
    back: 'Back',
    consentBefore: "I'm the child's guardian (or have their consent), and I accept the ",
    termsLink: 'Terms of Service',
    consentMiddle: ' and ',
    privacyLink: 'Privacy Policy',
    consentAfter: ', including AI processing of the photo for the story.',
    pleaseAccept: 'Please accept the terms above to upload a photo',
    selectFace: 'Select the correct face',
    noFaceDetected: 'No face detected. Please try a different photo.',
    multipleFaces: 'Multiple faces detected. Please select the correct one.',
    photoError: 'Failed to analyze photo. Please try again.',
    accountFailed: 'Account creation failed. Please try again.',
    verificationFailed: 'The security check did not go through. Please try again in a moment.',
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
    ageRequired: 'Bitte ein Alter zwischen 1 und 18 eingeben',
    continueLabel: 'Weiter',
    back: 'Zurück',
    consentBefore: 'Ich bin erziehungsberechtigt (oder habe die Zustimmung) und akzeptiere die ',
    termsLink: 'AGB',
    consentMiddle: ' und ',
    privacyLink: 'Datenschutzerklärung',
    consentAfter: ', inklusive KI-Verarbeitung des Fotos für die Geschichte.',
    pleaseAccept: 'Bitte akzeptiere die obigen Bedingungen, um ein Foto hochzuladen',
    selectFace: 'Wähle das richtige Gesicht',
    noFaceDetected: 'Kein Gesicht erkannt. Bitte versuche ein anderes Foto.',
    multipleFaces: 'Mehrere Gesichter erkannt. Bitte wähle das richtige aus.',
    photoError: 'Foto konnte nicht analysiert werden. Bitte versuche es erneut.',
    accountFailed: 'Das Konto konnte nicht erstellt werden. Bitte versuche es erneut.',
    verificationFailed: 'Die Sicherheitsprüfung hat nicht geklappt. Bitte versuche es gleich noch einmal.',
    photoUploaded: 'Foto hochgeladen',
    traitsOptional: 'optional — kannst du überspringen',
    avatarReward: 'Hier ist {name} als Figur!',
    avatarRewardChild: 'Hier ist dein Kind als Figur!',
    avatarCreating: 'Deine Figur wird erstellt…',
  },
  fr: {
    title: 'Créez votre héros',
    photoTitle: 'Importer une photo',
    photoHint: 'Importez une photo de votre enfant',
    photoGuidelines: 'Le visage et le haut du corps doivent être visibles',
    dropOrClick: 'Déposez une photo ou cliquez pour importer',
    analyzing: 'Analyse de la photo…',
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
    customTraitsPlaceholder: 'Aime les dinosaures, a peur du noir, a une petite sœur…',
    next: 'Suivant',
    nextNoPhoto: 'Ajoutez la photo et les détails pour continuer',
    nextNoDetails: 'Ajoutez les détails pour continuer',
    ageRequired: 'Merci d’indiquer un âge entre 1 et 18 ans',
    continueLabel: 'Continuer',
    back: 'Retour',
    consentBefore: "Je suis le tuteur de l'enfant (ou j'ai son consentement) et j'accepte les ",
    termsLink: "Conditions d'utilisation",
    consentMiddle: ' et la ',
    privacyLink: 'Politique de confidentialité',
    consentAfter: ', y compris le traitement de la photo par IA pour l’histoire.',
    pleaseAccept: 'Veuillez accepter les conditions ci-dessus pour importer une photo',
    selectFace: 'Sélectionnez le bon visage',
    noFaceDetected: 'Aucun visage détecté. Veuillez essayer une autre photo.',
    multipleFaces: 'Plusieurs visages détectés. Veuillez sélectionner le bon.',
    photoError: "Échec de l'analyse de la photo. Veuillez réessayer.",
    accountFailed: 'La création du compte a échoué. Veuillez réessayer.',
    verificationFailed: "La vérification de sécurité n'a pas abouti. Veuillez réessayer dans un instant.",
    photoUploaded: 'Photo importée',
    traitsOptional: 'facultatif — vous pouvez passer',
    avatarReward: 'Voici {name} en personnage !',
    avatarRewardChild: 'Voici votre enfant en personnage !',
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
    ageRequired: 'Inserisci un’età tra 1 e 18 anni',
    continueLabel: 'Continua',
    back: 'Indietro',
    consentBefore: 'Sono il tutore del bambino (o ho il suo consenso) e accetto i ',
    termsLink: 'Termini di servizio',
    consentMiddle: " e l'",
    privacyLink: 'Informativa sulla privacy',
    consentAfter: ', inclusa l\'elaborazione della foto tramite IA per la storia.',
    pleaseAccept: 'Accetta le condizioni qui sopra per caricare una foto',
    selectFace: 'Seleziona il viso corretto',
    noFaceDetected: 'Nessun viso rilevato. Prova con un\'altra foto.',
    multipleFaces: 'Rilevati più visi. Seleziona quello corretto.',
    photoError: 'Impossibile analizzare la foto. Riprova.',
    accountFailed: "Creazione dell'account non riuscita. Riprova.",
    verificationFailed: 'Il controllo di sicurezza non è andato a buon fine. Riprova tra un momento.',
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
  /**
   * Receives the hero's picture: the FRONT body cell of the standard sheet (drawn at the photo; replaced if the declared gender made the form-time call draw it again).
   * Always one cut figure, never a row or a sheet (server/lib/clientAvatarImages.js). null clears it (new photo).
   */
  onHeroAvatar?: (avatarImage: string | null) => void;
  /** The hero's picture so far, shown above the form. */
  heroAvatar?: string | null;
  onAccountCreated?: (sessionToken: string, characterId: string) => void;
  sessionToken?: string | null;
  language: string;
  adminToken?: string | null;
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function TrialCharacterStep({ characterData, onChange, onNext, onHeroAvatar, heroAvatar, onAccountCreated, sessionToken, language, adminToken }: TrialCharacterStepProps) {
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

  // Shared by the click and keyboard handlers on the consent row. Stamps the
  // funnel only on the tick, not the untick — this checkbox gates the photo
  // upload, so "did they ever consent" is the funnel question.
  const toggleConsent = () => {
    const next = !consentChecked;
    if (next) trackTrialStep('consent_given');
    setConsentChecked(next);
  };

  // Keep a ref to the latest characterData so async callbacks don't use stale closures
  const characterDataRef = useRef(characterData);
  useEffect(() => { characterDataRef.current = characterData; }, [characterData]);

  // Photo analysis state
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [detectedFaces, setDetectedFaces] = useState<DetectedFace[]>([]);
  const [cachedFacesData, setCachedFacesData] = useState<any>(null);
  const [originalImageData, setOriginalImageData] = useState<string | null>(null);
  // Multi-face photo: the moment the visitor picks a face its thumbnail (already in hand from
  // the first analysis) stands in for the photo, so the name/age/gender form opens at once.
  // The slow part (body crop + background removal for that face, ~20s) runs in the
  // background and fills characterData.photos when it lands. Cleared when it lands or fails.
  const [pickedFaceThumb, setPickedFaceThumb] = useState<string | null>(null);
  // Next was pressed while that analysis was still running: advance when it has landed.
  const [nextWaitingForPhoto, setNextWaitingForPhoto] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

  const [avatarError, setAvatarError] = useState<string | null>(null);
  const [isCreatingAccount, setIsCreatingAccount] = useState(false);

  // Background create-anonymous-account. As soon as the form is valid we
  // fire the create call in the background — by the time the user clicks
  // "Next" the promise has usually already resolved, so they advance with
  // no perceivable wait. Without this, the click triggers a 5-12s blocking
  // call (DB inserts + Gemini trait extraction + DB updates).
  const accountCreationPromiseRef = useRef<Promise<{ sessionToken: string; characterId: string } | null> | null>(null);
  // The face photo the account was created with: a different one later is a photo change (update-photo).
  const accountPhotoRef = useRef<string | null>(null);
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

  // The declared age is MANDATORY (owner, 2026-09-15). It is the single source
  // the avatar generator builds the body from and the avatar judge scores
  // against (de8753cc1), and it picks the age band and the topic window — with
  // no age, that chain silently falls back to the behaviour the ruling removed.
  // Whole years 1-18, matching the server's parseTrialAge; the server rejects
  // the same values independently, this is only the fast feedback.
  const ageRaw = String(characterData.age || '').trim();
  const ageIsValid = isValidTrialAge(ageRaw);
  // Shown once the user has a photo (i.e. is actually in the details phase) and
  // has either typed something wrong or left the field behind.
  const showAgeError = hasPhoto && !ageIsValid && ageRaw !== '';
  const canProceed = characterData.name.trim() && characterData.gender && ageIsValid && hasPhoto;
  // The picked face's analysis is still running: every required field is in, only the photo data is missing
  const photoPending = !hasPhoto && !!pickedFaceThumb;
  const canQueueNext = !!(characterData.name.trim() && characterData.gender && ageIsValid && photoPending);

  // Shared account creation logic — invoked either by the background prewarm
  // effect (the moment the form first becomes valid) or by handleNext as a
  // fallback if the prewarm hasn't fired yet. Returns null on failure so the
  // caller can decide how to surface the error.
  const startAccountCreation = async (): Promise<{ sessionToken: string; characterId: string } | null> => {
    const data = characterDataRef.current;
    if (!data.photos.face) return null;
    // The account is created the moment the photo is analysed, usually before anything is typed (provisional): the standard
    // avatar sheet starts then (docs/decisions.md 2026-10-09). Only what is valid is sent; the rest follows by PATCH.
    const sentData = { ...data, name: data.name?.trim() ? data.name : '', age: isValidTrialAge(String(data.age || '')) ? data.age : '' };
    const formComplete = !!(sentData.name && sentData.gender && sentData.age);
    accountPhotoRef.current = data.photos.face;

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

    // A Turnstile token is single-use: whatever this attempt's outcome, it is spent. Drop it and
    // reset the widget so the next attempt (retry, or the prewarm) gets a fresh one.
    setTurnstileToken(null);
    turnstileRef.current?.reset?.();

    // Snapshot the user-facing fields we're sending so the dirty-check on
    // Next knows whether a PATCH is needed.
    sentSnapshotRef.current = buildDetailsSnapshot(sentData);
    const accountResponse = await fetch(`${import.meta.env.VITE_API_URL || ''}/api/trial/create-anonymous-account`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: sentData.name,
        age: sentData.age,
        gender: data.gender,
        provisional: !formComplete,
        traits: data.traits,
        customTraits: data.customTraits,
        facePhoto: data.photos.face,
        bodyPhoto: data.photos.body,
        bodyNoBgPhoto: data.photos.bodyNoBg,
        faceBox: data.photos.faceBox,
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
      (err as unknown as { status: number; code?: string }).status = accountResponse.status;
      (err as unknown as { code?: string }).code = accountResult?.code;
      throw err;
    }
    // Fires on the PREWARM too (the moment the form first goes valid), not only
    // when the user presses Next — that's the honest meaning of "a users row now
    // exists". `character_done` is the one that means they moved on.
    trackTrialStep('character_saved');
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
    if (!hasPhoto) return;
    if (sessionToken) return; // already have one (back/forward nav)
    if (accountCreationPromiseRef.current) return; // already in flight
    // The wizard keeps the session from here on (localStorage), so a visitor who leaves after the photo comes back to the SAME
    // account (one account per visitor per day: a second create would be refused) and a new photo goes to update-photo.
    accountCreationPromiseRef.current = startAccountCreation()
      .then((account) => { if (account) onAccountCreated?.(account.sessionToken, account.characterId); return account; })
      .catch(() => null);
  // Trigger exactly when the photo has landed (hasPhoto flips true), not when the form is complete.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasPhoto, sessionToken]);

  // Push the current user-facing fields onto the character row. Called on both
  // advance paths — the freshly-created account (the prewarm sent a body that
  // may predate later edits) AND a RESTORED session. The restored one matters
  // now that the age is mandatory: a trial started before this change has no
  // age on its row, its sentSnapshotRef is null after the remount, and without
  // this call the age the user has just been forced to enter would never reach
  // the DB — the story would generate ageless anyway. A null snapshot
  // therefore means "always sync", not "nothing to sync".
  const syncDetails = async (token: string) => {
    const currentSnapshot = buildDetailsSnapshot(characterDataRef.current);
    if (sentSnapshotRef.current && !detailsDiffer(currentSnapshot, sentSnapshotRef.current)) return;
    try {
      const patchResp = await fetch(`${import.meta.env.VITE_API_URL || ''}/api/trial/update-character-details`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
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
  };

  // The hero's picture: ONE cut figure from the server, the FRONT body cell of the standard sheet. The sheet is drawn at the photo
  // (prepare-standard-body, from the photo's estimates) and taken by the form-time call (prepare-standard-avatar) unless the declared
  // gender changed, in which case it is drawn again and the new picture replaces the first. The first one fires the funnel step.
  const heroShownRef = useRef(false);
  const showHero = (image: string) => {
    if (!heroShownRef.current) { heroShownRef.current = true; trackTrialStep('avatar_ready'); }
    onHeroAvatar?.(image);
  };

  // The standard avatar sheet starts the moment the account exists, from the photo's own age and gender estimates
  // when the form is still empty. One call per photo; a failure only means the form-time call draws the sheet.
  const photoSheetStartedRef = useRef(false);
  const startPhotoSheet = async (token: string) => {
    if (photoSheetStartedRef.current) return;
    photoSheetStartedRef.current = true;
    try {
      const response = await fetch(`${import.meta.env.VITE_API_URL || ''}/api/trial/prepare-standard-body`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: '{}',
      });
      const result = await response.json();
      if (response.ok && result.avatarImage) showHero(result.avatarImage);
    } catch {
      // Non-blocking: the form-time call draws the sheet.
    }
  };
  useEffect(() => {
    // A restored session's account holds an older photo: its sheet starts after update-photo (the photo effect below).
    if (!hasPhoto || photoSheetStartedRef.current || !accountPhotoRef.current) return;
    (async () => {
      const account = await accountCreationPromiseRef.current;
      const token = account?.sessionToken || sessionToken;
      if (token) startPhotoSheet(token);
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasPhoto, sessionToken]);

  // A different photo after the account exists: the same account takes it (one account per visitor), the server drops
  // everything drawn from the old one, and the avatar starts again.
  const faceNow = characterData.photos.face;
  useEffect(() => {
    const accountFace = accountPhotoRef.current;
    if (!faceNow || faceNow === accountFace) return;
    // No account made by this page yet and none restored: the account effect creates it with this photo. A RESTORED session
    // (the visitor came back; its account, often a provisional one, holds an older photo) takes the new photo here.
    if (!accountFace && !sessionToken) return;
    accountPhotoRef.current = faceNow;
    (async () => {
      const account = await accountCreationPromiseRef.current;
      const token = account?.sessionToken || sessionToken;
      if (!token) return;
      const data = characterDataRef.current;
      try {
        const response = await fetch(`${import.meta.env.VITE_API_URL || ''}/api/trial/update-photo`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ facePhoto: data.photos.face, bodyPhoto: data.photos.body, bodyNoBgPhoto: data.photos.bodyNoBg, faceBox: data.photos.faceBox }),
        });
        if (!response.ok) { setAvatarError(t.accountFailed); return; }
      } catch {
        setAvatarError(t.accountFailed);
        return;
      }
      heroShownRef.current = false;
      standardAvatarStartedRef.current = false;
      photoSheetStartedRef.current = false;
      onHeroAvatar?.(null);
      startPhotoSheet(token);
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [faceNow]);

  // The standard avatar sheet (the hero's picture, and the sheet the story reuses): it needs only the photo, the DECLARED age
  // and the gender (its drawing has usually started at the photo, above), so it starts as soon as the form is complete and has been quiet for
  // a moment, not when the topic is picked. It runs in the background; nothing here waits for it. One call per account (the server styles one
  // sheet per trial); a failure only means the story job styles the sheet itself. docs/decisions.md 2026-10-09.
  const standardAvatarStartedRef = useRef(false);
  const startStandardAvatar = async (token: string) => {
    if (standardAvatarStartedRef.current) return;
    standardAvatarStartedRef.current = true;
    // The account was created with whatever the form held the moment it first looked valid (age "1" while "10" is
    // still being typed); the sheet is drawn for the age and gender on the server's row, so bring it up to date first.
    await syncDetails(token);
    try {
      const response = await fetch(`${import.meta.env.VITE_API_URL || ''}/api/trial/prepare-standard-avatar`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: '{}',
      });
      const result = await response.json();
      if (response.ok && result.avatarImage) showHero(result.avatarImage);
    } catch {
      // Non-blocking: the story job styles the standard sheet itself.
    }
  };

  // Fire it once the prewarmed account has resolved and the form has stopped changing.
  useEffect(() => {
    if (!canProceed || standardAvatarStartedRef.current) return;
    const timer = setTimeout(async () => {
      const account = await accountCreationPromiseRef.current;
      if (account) startStandardAvatar(account.sessionToken);
    }, STANDARD_AVATAR_QUIET_MS);
    return () => clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canProceed, characterData.name, characterData.age, characterData.gender]);

  // Create anonymous account (if not already done in background) and advance.
  const handleNext = async () => {
    if (!canProceed || !characterData.photos.face) return;

    // If user already has a session (navigated back and forward), skip account
    // creation — but still sync the details, see syncDetails.
    if (sessionToken) {
      await syncDetails(sessionToken);
      void startStandardAvatar(sessionToken); // no-op when the quiet-form trigger already started it
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
      await syncDetails(activeSession!.sessionToken);
      void startStandardAvatar(activeSession!.sessionToken); // no-op when the quiet-form trigger already started it

      if (onAccountCreated && activeSession) {
        onAccountCreated(activeSession.sessionToken, activeSession.characterId);
      }
    } catch (err) {
      const status = (err as { status?: number })?.status;
      const failure = classifyAccountCreateFailure(status);
      if (failure === 'signup') {
        // Fingerprint/quota refusal: this visitor cannot have a trial
        navigate('/?signup=true');
        return;
      }
      setAvatarError(failure === 'verification' ? t.verificationFailed : t.accountFailed);
      setIsCreatingAccount(false);
      accountCreationPromiseRef.current = null; // allow retry
      return;
    }

    setIsCreatingAccount(false);
    onNext();
  };

  // ─── Photo upload ────────────────────────────────────────────────────────────

  /**
   * The analysis request. A cold face pick runs ~16 s (background-removal model load) and on a phone connection that long-held
   * request can be dropped between the phone and the server although the server answers 200 (owner iPhone, 2026-10-09: pick #1
   * 16.4 s failed on the phone, the same pick 2.1 s later worked). A NETWORK-level failure (fetch rejects) is retried once: the
   * analyzer is warm by then, so the retry takes seconds. An HTTP answer, error or not, is never retried.
   * docs/decisions.md 2026-10-09 "photo analysis network retry".
   */
  const postAnalyzePhoto = async (body: unknown): Promise<Response> => {
    const send = () => fetch(`${import.meta.env.VITE_API_URL || ''}/api/trial/analyze-photo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    try {
      return await send();
    } catch (err) {
      console.warn('[TRIAL] analyze-photo network failure, retrying once:', err);
      return await send();
    }
  };

  /** Resolves true when the photo yielded what the step needs, false when an error is showing. */
  const analyzePhoto = useCallback(async (base64: string, selectedFaceId?: string, cachedFaces?: any): Promise<boolean> => {
    setIsAnalyzing(true);
    setPhotoError(null);
    setDetectedFaces([]);

    try {
      const body: any = { imageData: base64 };
      if (selectedFaceId != null && cachedFaces) {
        body.selectedFaceId = selectedFaceId;
        body.cachedFaces = cachedFaces;
      }

      const response = await postAnalyzePhoto(body);
      const result = await response.json();

      if (!response.ok) {
        setPhotoError(localizedApiError({ code: result.code, status: response.status }, language, t.photoError));
        return false;
      }

      if (result.success) {
        // A usable photo either way — the multi-face branch just needs one more
        // click (face_picked) before it yields a face.
        trackTrialStep('photo_analyzed', { multipleFaces: !!result.multipleFacesDetected });
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
        return true;
      }
      setPhotoError(t.noFaceDetected);
      return false;
    } catch (err) {
      setPhotoError(t.photoError);
      return false;
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
    trackTrialStep('photo_selected');

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
    const picked = detectedFaces.find((f) => f.id === faceId);
    if (!originalImageData || !cachedFacesData || !picked) return;
    trackTrialStep('face_picked');
    const facesBeforePick = detectedFaces;
    setPickedFaceThumb(picked.thumbnail);
    analyzePhoto(originalImageData, faceId, cachedFacesData).then((ok) => {
      setPickedFaceThumb(null);
      if (ok) return;
      // The analysis failed after the form had already opened: bring the face picker and the error
      // back where the visitor can retry, and drop a queued Next so it cannot advance without a photo.
      setNextWaitingForPhoto(false);
      setDetectedFaces(facesBeforePick);
      setPhase('photo');
    });
  };

  // Next was pressed while the picked face was still being analysed: go on as soon as it has landed.
  useEffect(() => {
    if (!nextWaitingForPhoto || !canProceed) return;
    setNextWaitingForPhoto(false);
    handleNext();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nextWaitingForPhoto, canProceed]);

  const handleRemovePhoto = () => {
    onChange({
      ...characterData,
      photos: {},
    });
    setPhotoError(null);
    setDetectedFaces([]);
    setOriginalImageData(null);
    setCachedFacesData(null);
    setPickedFaceThumb(null);
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

  // The trial picker offers strengths only, and carries the SAME cap as the full
  // wizard's (constants/traitLimits). A cap on one entry point and not the other
  // is not a cap — a parent who fills the trial and then saves the character
  // would otherwise arrive in the full wizard already over the limit.
  const traitsAtLimit = characterData.traits.length >= MAX_STRENGTHS;

  const toggleTrait = (trait: string) => {
    const current = characterData.traits;
    if (current.includes(trait)) {
      updateField('traits', current.filter((t) => t !== trait));
    } else {
      if (traitsAtLimit) return;
      updateField('traits', [...current, trait]);
    }
  };

  // ─── Render ──────────────────────────────────────────────────────────────────

  // The avatar reveal is deliberately NOT shown on this step — it cropped the
  // head (square object-cover) and pre-empted the reward. The avatar appears
  // (uncropped, object-contain) on the next step, TrialTopicStep's avatarBanner.
  // Generation still runs in the background via the effect above.

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
                    toggleConsent();
                  }
                }}
                onKeyDown={(e) => {
                  // Enter inside a link element should follow the link,
                  // not toggle the consent — let the browser handle it.
                  if ((e.target as HTMLElement).tagName === 'A') return;
                  if (e.key === ' ' || e.key === 'Enter') {
                    e.preventDefault();
                    toggleConsent();
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

          {!hasPhoto && !pickedFaceThumb ? (
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
                src={characterData.photos.face || pickedFaceThumb!}
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
              <label className="block text-sm font-semibold text-gray-700 mb-1.5">{t.ageLabel} <span className="text-red-400">*</span></label>
              <input
                type="number"
                min={1}
                max={18}
                value={characterData.age}
                onChange={(e) => updateField('age', e.target.value)}
                placeholder={t.agePlaceholder}
                aria-invalid={hasPhoto && !ageIsValid}
                className={`w-full px-4 py-2.5 rounded-lg border outline-none transition-all text-gray-900 placeholder-gray-400 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 ${
                  hasPhoto && !ageIsValid ? 'border-red-300 bg-red-50/30' : 'border-gray-300'
                }`}
              />
              {showAgeError && (
                <p className="mt-1 text-xs text-red-600">{t.ageRequired}</p>
              )}
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
              {t.traitsLabel} <span className="font-normal text-gray-400">({t.traitsOptional}, max. {MAX_STRENGTHS})</span>
            </label>
            <div className="flex flex-wrap gap-2">
              {(defaultStrengths[language as Language] || defaultStrengths.en).map((trait) => (
                <button
                  key={trait}
                  onClick={() => toggleTrait(trait)}
                  disabled={traitsAtLimit && !characterData.traits.includes(trait)}
                  className={`px-3 py-1.5 rounded-full text-sm font-medium transition-all ${
                    characterData.traits.includes(trait)
                      ? 'bg-indigo-500 text-white shadow-md'
                      : traitsAtLimit
                      ? 'bg-gray-100 border border-gray-200 text-gray-400 cursor-not-allowed'
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

          {/* Continue → details phase (enabled once a photo exists) */}
          <button
            onClick={() => setPhase('details')}
            disabled={!hasPhoto && !pickedFaceThumb}
            className={ctaClass(hasPhoto || !!pickedFaceThumb)}
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

          {/* The hero's picture: one figure, shown the moment the sheet's front cell is cut (same frame as the topic step). */}
          {heroAvatar && (
            <div className="flex justify-center">
              <TrialHeroAvatar src={heroAvatar} alt={characterData.name || 'Character'} />
            </div>
          )}

          {detailsBlock}

          {/* Avatar generation error */}
          {avatarError && (
            <p className="text-sm text-red-600 text-center">{avatarError}</p>
          )}

          {/* Next button — wired to handleNext (unchanged) */}
          <button
            onClick={canQueueNext ? () => setNextWaitingForPhoto(true) : handleNext}
            disabled={!(canProceed || canQueueNext) || isCreatingAccount || nextWaitingForPhoto}
            className={ctaClass(!!(canProceed || canQueueNext) && !isCreatingAccount && !nextWaitingForPhoto)}
          >
            {isCreatingAccount || nextWaitingForPhoto ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
              </>
            ) : !canProceed && !canQueueNext ? (
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
