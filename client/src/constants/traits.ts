import type { Language } from '@/types/story';

export const defaultStrengths: Record<Language, string[]> = {
  en: ['Cheerful', 'Kind', 'Caring', 'Funny', 'Forgiving', 'Protective', 'Loyal', 'Generous', 'Fair-minded', 'Honest', 'Confident', 'Brave', 'Trustworthy', 'Determined', 'Hardworking', 'Leader', 'Patient', 'Curious', 'Imaginative', 'Smart', 'Creative', 'Observant', 'Resourceful', 'Energetic', 'Fast', 'Strong', 'Adventurous'],
  de: ['Fröhlich', 'Freundlich', 'Hilfsbereit', 'Lustig', 'Nachsichtig', 'Beschützend', 'Treu', 'Grosszügig', 'Gerecht', 'Ehrlich', 'Selbstbewusst', 'Mutig', 'Vertrauenswürdig', 'Entschlossen', 'Fleissig', 'Anführer', 'Geduldig', 'Neugierig', 'Fantasievoll', 'Klug', 'Kreativ', 'Aufmerksam', 'Einfallsreich', 'Energiegeladen', 'Schnell', 'Stark', 'Abenteuerlustig'],
  fr: ['Joyeux(se)', 'Gentil(le)', 'Attentionné(e)', 'Drôle', 'Indulgent(e)', 'Protecteur(trice)', 'Loyal(e)', 'Généreux(se)', 'Équitable', 'Honnête', 'Confiant(e)', 'Courageux(se)', 'Digne de confiance', 'Déterminé(e)', 'Travailleur(se)', 'Meneur(se)', 'Patient(e)', 'Curieux(se)', 'Imaginatif(ve)', 'Intelligent(e)', 'Créatif(ve)', 'Observateur(trice)', 'Débrouillard(e)', 'Énergique', 'Rapide', 'Fort(e)', 'Aventureux(se)'],
  it: ['Allegro', 'Gentile', 'Premuroso', 'Divertente', 'Indulgente', 'Protettivo', 'Leale', 'Generoso', 'Giusto', 'Onesto', 'Sicuro di sé', 'Coraggioso', 'Affidabile', 'Determinato', 'Diligente', 'Leader', 'Paziente', 'Curioso', 'Fantasioso', 'Intelligente', 'Creativo', 'Attento', 'Pieno di risorse', 'Energico', 'Veloce', 'Forte', 'Avventuroso'],
};

export const defaultFlaws: Record<Language, string[]> = {
  en: ['Impatient', 'Distracted', 'Talkative', 'Whiny', 'Messy', 'Forgetful', 'Tattletale', 'Sore Loser', 'Stubborn', 'Dishonest', 'Bossy', 'Gullible', 'Jealous', 'Easily scared', 'Clingy', 'Quick-tempered', 'Selfish', 'Sneaky', 'Reckless', 'Shy', 'Clumsy', 'Lazy', 'Boastful', 'Indecisive', 'Perfectionist'],
  de: ['Ungeduldig', 'Zerstreut', 'Gesprächig', 'Weinerlich', 'Unordentlich', 'Vergesslich', 'Petze', 'Schlechter Verlierer', 'Stur', 'Lügnerisch', 'Rechthaberisch', 'Leichtgläubig', 'Eifersüchtig', 'Ängstlich', 'Anhänglich', 'Jähzornig', 'Egoistisch', 'Hinterlistig', 'Leichtsinnig', 'Schüchtern', 'Tollpatschig', 'Faul', 'Prahlerisch', 'Unentschlossen', 'Perfektionist'],
  fr: ['Impatient(e)', 'Distrait(e)', 'Bavard(e)', 'Pleurnicheur(se)', 'Désordonné(e)', 'Oublieux(se)', 'Rapporteur(se)', 'Mauvais(e) perdant(e)', 'Têtu(e)', 'Menteur(se)', 'Autoritaire', 'Crédule', 'Jaloux(se)', 'Facilement effrayé(e)', 'Collant(e)', 'Colérique', 'Égoïste', 'Sournois(e)', 'Imprudent(e)', 'Timide', 'Maladroit(e)', 'Paresseux(se)', 'Vantard(e)', 'Indécis(e)', 'Perfectionniste'],
  it: ['Impaziente', 'Distratto', 'Chiacchierone', 'Piagnucolone', 'Disordinato', 'Smemorato', 'Spione', 'Cattivo perdente', 'Testardo', 'Bugiardo', 'Prepotente', 'Credulone', 'Geloso', 'Pauroso', 'Appiccicoso', 'Irascibile', 'Egoista', 'Sornione', 'Imprudente', 'Timido', 'Goffo', 'Pigro', 'Vanaglorioso', 'Indeciso', 'Perfezionista'],
};

export const defaultChallenges: Record<Language, string[]> = {
  en: [
    // Challenges first
    'Following rules',
    'Controlling emotions',
    'Sharing with others',
    'Tests and grades',
    'Making new friends',
    'Speaking in public',
    'Trying new things',
    'Accepting and asking for help',
    'Dealing with change',
    'Standing up for oneself',
    // Fears at the end
    'Fear of the dark',
    'Bad dreams and nightmares',
    'Monsters, ghosts and things under the bed',
    'Fear of being alone',
    'Fear of getting lost',
    'Doctors, dentists and shots',
    'Fear of heights',
    'Fear of spiders',
    'Fear of loud noises'
  ],
  de: [
    // Herausforderungen zuerst
    'Regeln befolgen',
    'Gefühle kontrollieren',
    'Mit anderen teilen',
    'Prüfungen und Noten',
    'Neue Freunde finden',
    'Vor anderen sprechen',
    'Neues ausprobieren',
    'Hilfe annehmen und darum bitten',
    'Mit Veränderungen umgehen',
    'Für sich einstehen',
    // Ängste am Ende
    'Angst vor der Dunkelheit',
    'Albträume und schlechte Träume',
    'Monster, Geister und Dinge unter dem Bett',
    'Angst, allein zu sein',
    'Angst, sich zu verlaufen',
    'Ärzte, Zahnärzte und Spritzen',
    'Höhenangst',
    'Angst vor Spinnen',
    'Angst vor lauten Geräuschen'
  ],
  fr: [
    // Défis en premier
    'Suivre les règles',
    'Contrôler ses émotions',
    'Partager avec les autres',
    'Examens et notes',
    'Se faire de nouveaux amis',
    'Parler en public',
    'Essayer de nouvelles choses',
    "Accepter et demander de l'aide",
    'Gérer le changement',
    'Se défendre',
    // Peurs à la fin
    'Peur du noir',
    'Cauchemars et mauvais rêves',
    'Monstres, fantômes et choses sous le lit',
    "Peur d'être seul",
    'Peur de se perdre',
    'Médecins, dentistes et piqûres',
    'Peur du vide',
    'Peur des araignées',
    'Peur des bruits forts'
  ],
  it: [
    // Sfide all'inizio
    'Seguire le regole',
    'Controllare le emozioni',
    'Condividere con gli altri',
    'Esami e voti',
    'Fare nuove amicizie',
    'Parlare in pubblico',
    'Provare cose nuove',
    'Accettare e chiedere aiuto',
    'Affrontare i cambiamenti',
    'Difendere se stessi',
    // Paure alla fine
    'Paura del buio',
    'Incubi e brutti sogni',
    'Mostri, fantasmi e cose sotto il letto',
    'Paura di restare soli',
    'Paura di perdersi',
    'Medici, dentisti e iniezioni',
    'Paura delle altezze',
    'Paura dei ragni',
    'Paura dei rumori forti'
  ],
};

// Aliases for convenience
export const strengths = defaultStrengths;
export const flaws = defaultFlaws;
export const challenges = defaultChallenges;

// Legacy aliases (for backward compatibility)
export const weaknesses = defaultFlaws;
export const fears = defaultChallenges;


/**
 * French trait labels renamed 2026-10-05 (French only — several old words are also English traits) (they were masculine-only, and "Leader" was English).
 * Characters saved before keep the old string; TraitSelector shows it as the new label so the
 * chip stays selected, and the next save stores the new label.
 */
export const RENAMED_TRAITS_FR: Record<string, string> = {
  'Joyeux': 'Joyeux(se)',
  'Gentil': 'Gentil(le)',
  'Attentionné': 'Attentionné(e)',
  'Indulgent': 'Indulgent(e)',
  'Protecteur': 'Protecteur(trice)',
  'Loyal': 'Loyal(e)',
  'Généreux': 'Généreux(se)',
  'Confiant': 'Confiant(e)',
  'Courageux': 'Courageux(se)',
  'Déterminé': 'Déterminé(e)',
  'Travailleur': 'Travailleur(se)',
  'Leader': 'Meneur(se)',
  'Patient': 'Patient(e)',
  'Curieux': 'Curieux(se)',
  'Imaginatif': 'Imaginatif(ve)',
  'Intelligent': 'Intelligent(e)',
  'Créatif': 'Créatif(ve)',
  'Observateur': 'Observateur(trice)',
  'Débrouillard': 'Débrouillard(e)',
  'Fort': 'Fort(e)',
  'Aventureux': 'Aventureux(se)',
  'Impatient': 'Impatient(e)',
  'Distrait': 'Distrait(e)',
  'Bavard': 'Bavard(e)',
  'Pleurnicheur': 'Pleurnicheur(se)',
  'Désordonné': 'Désordonné(e)',
  'Oublieux': 'Oublieux(se)',
  'Rapporteur': 'Rapporteur(se)',
  'Mauvais perdant': 'Mauvais(e) perdant(e)',
  'Têtu': 'Têtu(e)',
  'Menteur': 'Menteur(se)',
  'Jaloux': 'Jaloux(se)',
  'Facilement effrayé': 'Facilement effrayé(e)',
  'Collant': 'Collant(e)',
  'Sournois': 'Sournois(e)',
  'Imprudent': 'Imprudent(e)',
  'Maladroit': 'Maladroit(e)',
  'Paresseux': 'Paresseux(se)',
  'Vantard': 'Vantard(e)',
  'Indécis': 'Indécis(e)'
};
