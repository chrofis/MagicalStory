export interface TranslationStrings {
  title: string;
  subtitle: string;
  heroTitle: string;
  heroSubtitle: string;
  heroDescription: string;
  bookText: string;
  startJourney: string;
  selectLanguage: string;
  login: string;
  register: string;
  logout: string;
  username: string;
  password: string;
  email: string;
  welcomeBack: string;
  createAccount: string;
  noAccount: string;
  haveAccount: string;
  signUp: string;
  signIn: string;
  loginRequired: string;
  continueWithGoogle: string;
  continueWithApple: string;
  orContinueWith: string;
  forgotPassword: string;
  resetPassword: string;
  resetPasswordDesc: string;
  sendResetLink: string;
  resetLinkSent: string;
  backToLogin: string;
  chooseStoryType: string;
  chooseArtStyle: string;
  artStyleDescription: string;
  addCustomStoryType: string;
  storyTypeName: string;
  storyTypeEmoji: string;
  addStoryType: string;
  createCharacters: string;
  characterCreated: string;
  createAnother: string;
  continueToRelationships: string;
  yourCharacters: string;
  startCreating: string;
  characterName: string;
  characterPhoto: string;
  uploadPhoto: string;
  uploadPhotoFirst: string;
  photoGoodExamples: string;
  photoBadExamples: string;
  noFaceDetected: string;
  orDescribe: string;
  characterAge: string;
  hairColor: string;
  otherFeatures: string;
  descriptionPlaceholder: string;
  gender: string;
  male: string;
  female: string;
  other: string;
  age: string;
  strengths: string;
  weaknesses: string;
  selectAtLeast: string;
  selected: string;
  addCustomStrengths: string;
  addCustomWeaknesses: string;
  addCustomFears: string;
  specialDetails: string;
  specialDetailsPlaceholder: string;
  fears: string;
  addCustomRelationship: string;
  cancel: string;
  saveCharacter: string;
  editCharacter: string;
  deleteCharacter: string;
  defineRelationships: string;
  defineRelationshipsDesc: string;
  is: string;
  reverseRelationship: string;
  storySettings: string;
  selectMainCharacters: string;
  numberOfPages: string;
  readingLevel: string;
  firstGrade: string;
  firstGradeDesc: string;
  standard: string;
  standardDesc: string;
  advanced: string;
  advancedDesc: string;
  generateStory: string;
  creating: string;
  storyReady: string;
  downloadTXT: string;
  downloadPDF: string;
  downloadPrompt: string;
  viewPrompt: string;
  hidePrompt: string;
  promptUsed: string;
  createAnotherStory: string;
  back: string;
  next: string;
  exportConfig: string;
  exportStoryInfo: string;
  importConfig: string;
  charactersCreated: string;
  mainCharacter: string;
  apiKeyRequired: string;
  apiKeyPrompt: string;
  apiKeyPlaceholder: string;
  saveApiKey: string;
  apiKeyNote: string;
  promptPreview: string;
  showPromptPreview: string;
  hidePromptPreview: string;
  editPrompt: string;
  resetPrompt: string;
  storyDetails: string;
  storyDetailsOptional: string;
  storyDetailsPlaceholder: string;
  generateOutline: string;
  generatingOutline: string;
  outlineReady: string;
  editOutline: string;
  regenerateOutline: string;
  createScenes: string;
  creatingScenes: string;
  scenesReady: string;
  downloadScenes: string;
  sceneForPage: string;
  yourStory: string;
  uploadStory: string;
  uploadStoryDesc: string;
  generateImages: string;
  generatingImages: string;
  imagesReady: string;
  downloadImage: string;
  geminiApiKey: string;
  geminiApiKeyPrompt: string;
  geminiApiKeyNote: string;
  imageForPage: string;
  generateAvatar: string;
  generatingAvatar: string;
  avatarGenerated: string;
  useGeneratedAvatar: string;
  keepOriginal: string;
  uploadType: string;
  uploadRealPhoto: string;
  uploadReadyAvatar: string;
  editStory: string;
  saveStory: string;
  editScene: string;
  saveScene: string;
  editImage: string;
  regenerateImage: string;
  showEditPrompt: string;
  hideEditPrompt: string;
  editInstruction: string;
  applyEdit: string;
}

export const translations: Record<'en' | 'de' | 'fr', TranslationStrings> = {
  en: {
    title: 'Magical Story',
    subtitle: 'Personalize your story to create magic',
    heroTitle: 'Become the hero of your story',
    heroSubtitle: '',
    heroDescription: 'Turn your wildest ideas into a breathtaking personalized tale.',
    bookText: 'Get a beautifully printed book and make someone feel like the legend they truly are.',
    startJourney: 'Start Your Adventure',
    selectLanguage: 'Choose your language',
    login: 'Login',
    register: 'Register',
    logout: 'Logout',
    username: 'Username',
    password: 'Password',
    email: 'Email (optional)',
    welcomeBack: 'Welcome Back!',
    createAccount: 'Create Account',
    noAccount: "Don't have an account?",
    haveAccount: 'Already have an account?',
    signUp: 'Sign up',
    signIn: 'Sign in',
    loginRequired: 'Please login to continue',
    continueWithGoogle: 'Continue with Google',
    continueWithApple: 'Continue with Apple',
    orContinueWith: 'or continue with',
    forgotPassword: 'Forgot password?',
    resetPassword: 'Reset Password',
    resetPasswordDesc: "Enter your email and we'll send you a reset link",
    sendResetLink: 'Send Reset Link',
    resetLinkSent: 'Password reset email sent! Check your inbox.',
    backToLogin: 'Back to login',
    chooseStoryType: 'Choose Your Story Type',
    chooseArtStyle: 'Choose Your Art Style',
    artStyleDescription: 'Select the visual style for your story',
    addCustomStoryType: 'Add Custom Story Type',
    storyTypeName: 'Story Type Name',
    storyTypeEmoji: 'Emoji',
    addStoryType: 'Add',
    createCharacters: 'Create Your Characters',
    characterCreated: 'Character Created!',
    createAnother: 'Create Another Character',
    continueToRelationships: 'Continue to Relationships',
    yourCharacters: 'Your Characters:',
    startCreating: 'Start Creating Character',
    characterName: 'Character Name',
    characterPhoto: 'Character Photo',
    uploadPhoto: 'Upload Photo',
    uploadPhotoFirst: 'Please upload a photo to continue',
    photoGoodExamples: 'Good: Full body or upper body',
    photoBadExamples: 'Avoid: Close-up face only, sunglasses, hats, helmets, blurry',
    noFaceDetected: 'No face detected in the photo. Please upload a clear photo showing a face.',
    orDescribe: 'OR describe the character',
    characterAge: 'Age',
    hairColor: 'Hair Color',
    otherFeatures: 'Other Features',
    descriptionPlaceholder: 'e.g., Blue eyes, wears glasses, has freckles',
    gender: 'Gender',
    male: 'Male',
    female: 'Female',
    other: 'Unknown',
    age: 'Age',
    strengths: 'Strengths',
    weaknesses: 'Weaknesses',
    selectAtLeast: 'Select at least',
    selected: 'Selected',
    addCustomStrengths: 'Add custom strengths',
    addCustomWeaknesses: 'Add custom weaknesses',
    addCustomFears: 'Add custom fears',
    specialDetails: 'Hobbies, Interests, Favourite Cuddly Toy, Job and Other Details',
    specialDetailsPlaceholder: 'e.g., Enjoys painting, loves dinosaurs, favourite teddy bear called Bruno, wants to be a firefighter',
    fears: 'Fears',
    addCustomRelationship: 'Add custom relationship',
    cancel: 'Cancel',
    saveCharacter: 'Save Character',
    editCharacter: 'Edit',
    deleteCharacter: 'Delete',
    defineRelationships: 'Define Character Relationships',
    defineRelationshipsDesc: 'Define how each character relates to the others.',
    is: 'is',
    reverseRelationship: 'Reverse relationship:',
    storySettings: 'Story Settings',
    selectMainCharacters: 'Select Main Characters (max 2)',
    numberOfPages: 'Number of Pages',
    readingLevel: 'Reading Level',
    firstGrade: 'Picture Book',
    firstGradeDesc: 'Ages 3-6. Simple words, short sentences. Best for 10-20 pages.',
    standard: 'Chapter Book',
    standardDesc: 'Ages 6-10. Ideal for 2-3 characters. Normal sentences, accessible vocabulary.',
    advanced: 'Young Reader',
    advancedDesc: 'Ages 10+. Complex storylines, rich vocabulary. Best with many characters, 30-50 pages.',
    generateStory: 'Generate Story!',
    creating: 'Creating Your Story...',
    storyReady: 'Your Story is Ready!',
    downloadTXT: 'Download as TXT',
    downloadPDF: 'Download as PDF',
    downloadPrompt: 'Download Prompt',
    viewPrompt: 'View Prompt',
    hidePrompt: 'Hide Prompt',
    promptUsed: 'Prompt Used to Generate Story:',
    createAnotherStory: 'Create Another Story',
    back: 'Back',
    next: 'Next',
    exportConfig: 'Export Configuration',
    exportStoryInfo: 'Export Story Info (MD)',
    importConfig: 'Import Configuration',
    charactersCreated: "You've created {count} character{s} so far.",
    mainCharacter: 'Main Character',
    apiKeyRequired: 'API Key Required',
    apiKeyPrompt: 'Please enter your Anthropic API key to generate stories:',
    apiKeyPlaceholder: 'sk-ant-...',
    saveApiKey: 'Save API Key',
    apiKeyNote: 'Your API key is stored locally in your browser and never sent anywhere except to Anthropic.',
    promptPreview: 'Prompt Preview',
    showPromptPreview: 'Show Prompt',
    hidePromptPreview: 'Hide Prompt',
    editPrompt: 'Edit Prompt',
    resetPrompt: 'Reset to Default',
    storyDetails: 'Story Plot / Story Details',
    storyDetailsOptional: '(optional)',
    storyDetailsPlaceholder: 'e.g., Location: Enchanted forest, Special elements: Magical talking animals, Time period: Medieval times...',
    generateOutline: 'Generate Outline',
    generatingOutline: 'Generating Outline...',
    outlineReady: 'Story Outline',
    editOutline: 'You can edit the outline below before generating the full story:',
    regenerateOutline: 'Regenerate Outline',
    createScenes: 'Create Scene Descriptions',
    creatingScenes: 'Creating Scene Descriptions...',
    scenesReady: 'Scene Descriptions',
    downloadScenes: 'Download Scenes',
    sceneForPage: 'Scene for Page',
    yourStory: 'Your Story',
    uploadStory: 'Upload Story',
    uploadStoryDesc: 'Upload an existing story text file to generate scene descriptions',
    generateImages: 'Generate Scene Images',
    generatingImages: 'Generating Images...',
    imagesReady: 'Scene Images',
    downloadImage: 'Download Image',
    geminiApiKey: 'Gemini API Key',
    geminiApiKeyPrompt: 'Enter your Google Gemini API key to generate images:',
    geminiApiKeyNote: 'Get your key from Google AI Studio',
    imageForPage: 'Image for Page',
    generateAvatar: 'Generate Pixar Avatar',
    generatingAvatar: 'Generating Avatar...',
    avatarGenerated: 'Avatar Generated!',
    useGeneratedAvatar: 'Use Generated Avatar',
    keepOriginal: 'Keep Original Photo',
    uploadType: 'What are you uploading?',
    uploadRealPhoto: 'Real Photo (will generate avatar)',
    uploadReadyAvatar: 'Ready Avatar (already stylized)',
    editStory: 'Edit Story',
    saveStory: 'Save Story',
    editScene: 'Edit Scene',
    saveScene: 'Save Scene',
    editImage: 'Edit Image',
    regenerateImage: 'Regenerate Image',
    showEditPrompt: 'Show Prompt',
    hideEditPrompt: 'Hide Prompt',
    editInstruction: 'What should be changed?',
    applyEdit: 'Apply Edit',
  },
  de: {
    title: 'Magical Story',
    subtitle: 'Personalisiere deine Geschichte für Magie',
    heroTitle: 'Werde zum Helden deiner Geschichte',
    heroSubtitle: '',
    heroDescription: 'Verwandle deine wildesten Ideen in eine atemberaubende personalisierte Geschichte.',
    bookText: 'Erhalte ein wunderschön gedrucktes Buch und gib jemandem das Gefühl, die Legende zu sein, die er wirklich ist.',
    startJourney: 'Starte dein Abenteuer',
    selectLanguage: 'Wähle deine Sprache',
    login: 'Anmelden',
    register: 'Registrieren',
    logout: 'Abmelden',
    username: 'Benutzername',
    password: 'Passwort',
    email: 'E-Mail (optional)',
    welcomeBack: 'Willkommen zurück!',
    createAccount: 'Konto erstellen',
    noAccount: 'Noch kein Konto?',
    haveAccount: 'Bereits ein Konto?',
    signUp: 'Registrieren',
    signIn: 'Anmelden',
    loginRequired: 'Bitte melde dich an, um fortzufahren',
    continueWithGoogle: 'Mit Google fortfahren',
    continueWithApple: 'Mit Apple fortfahren',
    orContinueWith: 'oder fortfahren mit',
    forgotPassword: 'Passwort vergessen?',
    resetPassword: 'Passwort zurücksetzen',
    resetPasswordDesc: 'Gib deine E-Mail ein und wir senden dir einen Link zum Zurücksetzen',
    sendResetLink: 'Link senden',
    resetLinkSent: 'E-Mail zum Zurücksetzen gesendet! Überprüfe deinen Posteingang.',
    backToLogin: 'Zurück zur Anmeldung',
    chooseStoryType: 'Wähle deinen Geschichtentyp',
    chooseArtStyle: 'Wähle deinen Kunststil',
    artStyleDescription: 'Wähle den visuellen Stil für deine Geschichte',
    addCustomStoryType: 'Eigenen Geschichtentyp hinzufügen',
    storyTypeName: 'Name des Geschichtentyps',
    storyTypeEmoji: 'Emoji',
    addStoryType: 'Hinzufügen',
    createCharacters: 'Erstelle deine Charaktere',
    characterCreated: 'Charakter erstellt!',
    createAnother: 'Weiteren Charakter erstellen',
    continueToRelationships: 'Weiter zu Beziehungen',
    yourCharacters: 'Deine Charaktere:',
    startCreating: 'Charakter erstellen beginnen',
    characterName: 'Charaktername',
    characterPhoto: 'Charakterfoto',
    uploadPhoto: 'Foto hochladen',
    uploadPhotoFirst: 'Bitte laden Sie ein Foto hoch, um fortzufahren',
    photoGoodExamples: 'Gut: Ganzkörper oder Oberkörper',
    photoBadExamples: 'Vermeiden: Nur Gesicht, Sonnenbrille, Hüte, Helme, unscharf',
    noFaceDetected: 'Kein Gesicht im Foto erkannt. Bitte laden Sie ein klares Foto mit einem sichtbaren Gesicht hoch.',
    orDescribe: 'ODER Figur beschreiben',
    characterAge: 'Alter',
    hairColor: 'Haarfarbe',
    otherFeatures: 'Sonstige Merkmale',
    descriptionPlaceholder: 'z.B. Blaue Augen, trägt Brille, hat Sommersprossen',
    gender: 'Geschlecht',
    male: 'Männlich',
    female: 'Weiblich',
    other: 'Unbekannt',
    age: 'Alter',
    strengths: 'Stärken',
    weaknesses: 'Schwächen',
    selectAtLeast: 'Wähle mindestens',
    selected: 'Ausgewählt',
    addCustomStrengths: 'Eigene Stärken hinzufügen',
    addCustomWeaknesses: 'Eigene Schwächen hinzufügen',
    addCustomFears: 'Eigene Ängste hinzufügen',
    specialDetails: 'Hobbys, Interessen, Lieblingskuscheltier, Beruf und andere Besonderheiten',
    specialDetailsPlaceholder: 'z.B. Malt gerne, liebt Dinosaurier, Lieblingsteddy heisst Bruno, will Feuerwehrmann werden',
    fears: 'Ängste',
    addCustomRelationship: 'Eigene Beziehung hinzufügen',
    cancel: 'Abbrechen',
    saveCharacter: 'Charakter speichern',
    editCharacter: 'Bearbeiten',
    deleteCharacter: 'Löschen',
    defineRelationships: 'Charakterbeziehungen definieren',
    defineRelationshipsDesc: 'Definiere, wie die Charaktere zueinander stehen.',
    is: 'ist',
    reverseRelationship: 'Umgekehrte Beziehung:',
    storySettings: 'Geschichten-Einstellungen',
    selectMainCharacters: 'Hauptfiguren auswählen (max 2)',
    numberOfPages: 'Anzahl der Seiten',
    readingLevel: 'Lesestufe',
    firstGrade: 'Bilderbuch',
    firstGradeDesc: 'Alter 3-6. Einfache Wörter, kurze Sätze. Ideal für 10-20 Seiten.',
    standard: 'Kinderbuch',
    standardDesc: 'Alter 6-10. Ideal für 2-3 Figuren. Normale Sätze, verständlicher Wortschatz.',
    advanced: 'Jugendbuch',
    advancedDesc: 'Alter 10+. Komplexe Handlung, reicher Wortschatz. Ideal mit vielen Figuren, 30-50 Seiten.',
    generateStory: 'Geschichte erstellen!',
    creating: 'Erstelle deine Geschichte...',
    storyReady: 'Deine Geschichte ist fertig!',
    downloadTXT: 'Als TXT herunterladen',
    downloadPDF: 'Als PDF herunterladen',
    downloadPrompt: 'Prompt herunterladen',
    viewPrompt: 'Prompt anzeigen',
    hidePrompt: 'Prompt ausblenden',
    promptUsed: 'Verwendeter Prompt:',
    createAnotherStory: 'Neue Geschichte erstellen',
    back: 'Zurück',
    next: 'Weiter',
    exportConfig: 'Konfiguration exportieren',
    exportStoryInfo: 'Story-Info exportieren (MD)',
    importConfig: 'Konfiguration importieren',
    charactersCreated: 'Du hast bisher {count} Charakter{s} erstellt.',
    mainCharacter: 'Hauptfigur',
    apiKeyRequired: 'API-Schlüssel erforderlich',
    apiKeyPrompt: 'Bitte geben Sie Ihren Anthropic API-Schlüssel ein:',
    apiKeyPlaceholder: 'sk-ant-...',
    saveApiKey: 'API-Schlüssel speichern',
    apiKeyNote: 'Ihr API-Schlüssel wird lokal im Browser gespeichert.',
    promptPreview: 'Prompt-Vorschau',
    showPromptPreview: 'Prompt anzeigen',
    hidePromptPreview: 'Prompt ausblenden',
    editPrompt: 'Prompt bearbeiten',
    resetPrompt: 'Auf Standard zurücksetzen',
    storyDetails: 'Handlung / Angaben zur Geschichte',
    storyDetailsOptional: '(optional)',
    storyDetailsPlaceholder: 'z.B. Ort: Verzauberter Wald, Besondere Elemente: Magische sprechende Tiere, Zeitperiode: Mittelalter...',
    generateOutline: 'Gliederung erstellen',
    generatingOutline: 'Gliederung wird erstellt...',
    outlineReady: 'Story-Gliederung',
    editOutline: 'Sie können die Gliederung unten bearbeiten, bevor Sie die vollständige Geschichte erstellen:',
    regenerateOutline: 'Gliederung neu erstellen',
    createScenes: 'Szenen-Beschreibungen erstellen',
    creatingScenes: 'Szenen-Beschreibungen werden erstellt...',
    scenesReady: 'Szenen-Beschreibungen',
    downloadScenes: 'Szenen herunterladen',
    sceneForPage: 'Szene für Seite',
    yourStory: 'Deine Geschichte',
    uploadStory: 'Geschichte hochladen',
    uploadStoryDesc: 'Laden Sie eine vorhandene Story-Textdatei hoch, um Szenenbeschreibungen zu generieren',
    generateImages: 'Szenenbilder generieren',
    generatingImages: 'Bilder werden generiert...',
    imagesReady: 'Szenenbilder',
    downloadImage: 'Bild herunterladen',
    geminiApiKey: 'Gemini API-Schlüssel',
    geminiApiKeyPrompt: 'Geben Sie Ihren Google Gemini API-Schlüssel ein:',
    geminiApiKeyNote: 'Holen Sie sich Ihren Schlüssel von Google AI Studio',
    imageForPage: 'Bild für Seite',
    generateAvatar: 'Pixar-Avatar erstellen',
    generatingAvatar: 'Avatar wird erstellt...',
    avatarGenerated: 'Avatar erstellt!',
    useGeneratedAvatar: 'Generierten Avatar verwenden',
    keepOriginal: 'Originalfoto behalten',
    uploadType: 'Was laden Sie hoch?',
    uploadRealPhoto: 'Echtes Foto (Avatar wird generiert)',
    uploadReadyAvatar: 'Fertiger Avatar (bereits stilisiert)',
    editStory: 'Geschichte bearbeiten',
    saveStory: 'Geschichte speichern',
    editScene: 'Szene bearbeiten',
    saveScene: 'Szene speichern',
    editImage: 'Bild bearbeiten',
    regenerateImage: 'Bild neu generieren',
    showEditPrompt: 'Prompt anzeigen',
    hideEditPrompt: 'Prompt ausblenden',
    editInstruction: 'Was soll geändert werden?',
    applyEdit: 'Änderung anwenden',
  },
  fr: {
    title: 'Magical Story',
    subtitle: 'Personnalisez votre histoire pour créer la magie',
    heroTitle: 'Devenez le héros de votre histoire',
    heroSubtitle: '',
    heroDescription: 'Transformez vos idées les plus folles en un conte personnalisé époustouflant.',
    bookText: "Obtenez un livre magnifiquement imprimé et donnez à quelqu'un le sentiment d'être la légende qu'il est vraiment.",
    startJourney: 'Commencez votre aventure',
    selectLanguage: 'Choisissez votre langue',
    login: 'Connexion',
    register: "S'inscrire",
    logout: 'Déconnexion',
    username: "Nom d'utilisateur",
    password: 'Mot de passe',
    email: 'Email (facultatif)',
    welcomeBack: 'Bon retour !',
    createAccount: 'Créer un compte',
    noAccount: 'Pas encore de compte ?',
    haveAccount: 'Vous avez déjà un compte ?',
    signUp: "S'inscrire",
    signIn: 'Se connecter',
    loginRequired: 'Veuillez vous connecter pour continuer',
    continueWithGoogle: 'Continuer avec Google',
    continueWithApple: 'Continuer avec Apple',
    orContinueWith: 'ou continuer avec',
    forgotPassword: 'Mot de passe oublié ?',
    resetPassword: 'Réinitialiser le mot de passe',
    resetPasswordDesc: 'Entrez votre e-mail et nous vous enverrons un lien de réinitialisation',
    sendResetLink: 'Envoyer le lien',
    resetLinkSent: 'E-mail de réinitialisation envoyé ! Vérifiez votre boîte de réception.',
    backToLogin: 'Retour à la connexion',
    chooseStoryType: 'Choisissez votre type d\'histoire',
    chooseArtStyle: 'Choisissez Votre Style Artistique',
    artStyleDescription: 'Sélectionnez le style visuel pour votre histoire',
    addCustomStoryType: 'Ajouter un type d\'histoire personnalisé',
    storyTypeName: 'Nom du type d\'histoire',
    storyTypeEmoji: 'Emoji',
    addStoryType: 'Ajouter',
    createCharacters: 'Créez vos personnages',
    characterCreated: 'Personnage créé !',
    createAnother: 'Créer un autre personnage',
    continueToRelationships: 'Continuer vers les Relations',
    yourCharacters: 'Vos personnages :',
    startCreating: 'Commencer à créer un personnage',
    characterName: 'Nom du personnage',
    characterPhoto: 'Photo du personnage',
    uploadPhoto: 'Télécharger une Photo',
    uploadPhotoFirst: 'Veuillez télécharger une photo pour continuer',
    photoGoodExamples: 'Bien : Corps entier ou buste',
    photoBadExamples: 'Éviter : Gros plan visage, lunettes de soleil, chapeaux, casques, flou',
    noFaceDetected: 'Aucun visage détecté dans la photo. Veuillez télécharger une photo claire montrant un visage.',
    orDescribe: 'OU décrivez le personnage',
    characterAge: 'Âge',
    hairColor: 'Couleur des Cheveux',
    otherFeatures: 'Autres Caractéristiques',
    descriptionPlaceholder: 'ex. Yeux bleus, porte des lunettes, a des taches de rousseur',
    gender: 'Genre',
    male: 'Masculin',
    female: 'Féminin',
    other: 'Inconnu',
    age: 'Âge',
    strengths: 'Forces',
    weaknesses: 'Faiblesses',
    selectAtLeast: 'Sélectionnez au moins',
    selected: 'Sélectionné',
    addCustomStrengths: 'Ajouter des forces personnalisées',
    addCustomWeaknesses: 'Ajouter des faiblesses personnalisées',
    addCustomFears: 'Ajouter des peurs personnalisées',
    specialDetails: 'Loisirs, Intérêts, Peluche Préférée, Métier et Autres Détails',
    specialDetailsPlaceholder: 'ex. Aime peindre, adore les dinosaures, son nounours préféré s\'appelle Bruno, veut devenir pompier',
    fears: 'Peurs',
    addCustomRelationship: 'Ajouter une relation personnalisée',
    cancel: 'Annuler',
    saveCharacter: 'Enregistrer le personnage',
    editCharacter: 'Modifier',
    deleteCharacter: 'Supprimer',
    defineRelationships: 'Définir les relations entre personnages',
    defineRelationshipsDesc: 'Définissez comment chaque personnage est lié aux autres.',
    is: 'est',
    reverseRelationship: 'Relation inverse :',
    storySettings: 'Paramètres de l\'histoire',
    selectMainCharacters: 'Sélectionner les personnages principaux (max 2)',
    numberOfPages: 'Nombre de Pages',
    readingLevel: 'Niveau de Lecture',
    firstGrade: 'Livre d\'Images',
    firstGradeDesc: 'Image et texte sur les deux pages',
    standard: 'Standard',
    standardDesc: 'Texte sur une page, image sur l\'autre',
    advanced: 'Avancé',
    advancedDesc: 'Texte plus long, image sur la page opposée',
    generateStory: 'Générer l\'histoire !',
    creating: 'Création de votre histoire...',
    storyReady: 'Votre histoire est prête !',
    downloadTXT: 'Télécharger en TXT',
    downloadPDF: 'Télécharger en PDF',
    downloadPrompt: 'Télécharger le Prompt',
    viewPrompt: 'Voir le Prompt',
    hidePrompt: 'Masquer le Prompt',
    promptUsed: 'Prompt utilisé pour générer l\'histoire :',
    createAnotherStory: 'Créer une autre histoire',
    back: 'Retour',
    next: 'Suivant',
    exportConfig: 'Exporter la Configuration',
    exportStoryInfo: 'Exporter les Infos (MD)',
    importConfig: 'Importer la Configuration',
    charactersCreated: 'Vous avez créé {count} personnage{s} jusqu\'à présent.',
    mainCharacter: 'Personnage principal',
    apiKeyRequired: 'Clé API Requise',
    apiKeyPrompt: 'Veuillez entrer votre clé API Anthropic pour générer des histoires :',
    apiKeyPlaceholder: 'sk-ant-...',
    saveApiKey: 'Enregistrer la Clé API',
    apiKeyNote: 'Votre clé API est stockée localement dans votre navigateur.',
    promptPreview: 'Aperçu du Prompt',
    showPromptPreview: 'Afficher le Prompt',
    hidePromptPreview: 'Masquer le Prompt',
    editPrompt: 'Modifier le Prompt',
    resetPrompt: 'Réinitialiser par Défaut',
    storyDetails: 'Intrigue / Contexte du récit',
    storyDetailsOptional: '(facultatif)',
    storyDetailsPlaceholder: 'ex. Lieu : Forêt enchantée, Éléments spéciaux : Animaux magiques parlants, Période : Moyen Âge...',
    generateOutline: 'Générer le Plan',
    generatingOutline: 'Génération du Plan...',
    outlineReady: 'Plan de l\'histoire',
    editOutline: 'Vous pouvez modifier le plan ci-dessous avant de générer l\'histoire complète :',
    regenerateOutline: 'Regénérer le Plan',
    createScenes: 'Créer les Descriptions de Scènes',
    creatingScenes: 'Création des Descriptions de Scènes...',
    scenesReady: 'Descriptions de Scènes',
    downloadScenes: 'Télécharger les Scènes',
    sceneForPage: 'Scène pour la Page',
    yourStory: 'Votre histoire',
    uploadStory: 'Télécharger une histoire',
    uploadStoryDesc: 'Téléchargez un fichier texte existant pour générer des descriptions de scènes',
    generateImages: 'Générer les Images de Scènes',
    generatingImages: 'Génération des Images...',
    imagesReady: 'Images de Scènes',
    downloadImage: 'Télécharger l\'Image',
    geminiApiKey: 'Clé API Gemini',
    geminiApiKeyPrompt: 'Entrez votre clé API Google Gemini pour générer des images :',
    geminiApiKeyNote: 'Obtenez votre clé sur Google AI Studio',
    imageForPage: 'Image pour la Page',
    generateAvatar: 'Générer un Avatar Pixar',
    generatingAvatar: 'Génération de l\'Avatar...',
    avatarGenerated: 'Avatar Généré !',
    useGeneratedAvatar: 'Utiliser l\'Avatar Généré',
    keepOriginal: 'Garder la Photo Originale',
    uploadType: 'Que téléchargez-vous ?',
    uploadRealPhoto: 'Photo réelle (avatar sera généré)',
    uploadReadyAvatar: 'Avatar prêt (déjà stylisé)',
    editStory: 'Modifier l\'histoire',
    saveStory: 'Enregistrer l\'histoire',
    editScene: 'Modifier la Scène',
    saveScene: 'Enregistrer la Scène',
    editImage: 'Modifier l\'Image',
    regenerateImage: 'Regénérer l\'Image',
    showEditPrompt: 'Afficher le Prompt',
    hideEditPrompt: 'Masquer le Prompt',
    editInstruction: 'Que faut-il changer ?',
    applyEdit: 'Appliquer la Modification',
  },
};
