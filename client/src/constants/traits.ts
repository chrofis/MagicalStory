import type { Language } from '@/types/story';

export const defaultStrengths: Record<Language, string[]> = {
  en: ['Cheerful', 'Kind', 'Caring', 'Funny', 'Forgiving', 'Protective', 'Loyal', 'Generous', 'Fair-minded', 'Honest', 'Confident', 'Brave', 'Trustworthy', 'Determined', 'Hardworking', 'Leader', 'Patient', 'Curious', 'Imaginative', 'Smart', 'Creative', 'Observant', 'Resourceful', 'Energetic', 'Fast', 'Strong', 'Adventurous'],
  de: ['Fröhlich', 'Freundlich', 'Hilfsbereit', 'Lustig', 'Nachsichtig', 'Beschützend', 'Treu', 'Grosszügig', 'Gerecht', 'Ehrlich', 'Selbstbewusst', 'Mutig', 'Vertrauenswürdig', 'Entschlossen', 'Fleissig', 'Leader', 'Geduldig', 'Neugierig', 'Fantasievoll', 'Klug', 'Kreativ', 'Aufmerksam', 'Einfallsreich', 'Energiegeladen', 'Schnell', 'Stark', 'Abenteuerlustig'],
  fr: ['Joyeux', 'Gentil', 'Attentionné', 'Drôle', 'Indulgent', 'Protecteur', 'Loyal', 'Généreux', 'Équitable', 'Honnête', 'Confiant', 'Courageux', 'Digne de confiance', 'Déterminé', 'Travailleur', 'Leader', 'Patient', 'Curieux', 'Imaginatif', 'Intelligent', 'Créatif', 'Observateur', 'Débrouillard', 'Énergique', 'Rapide', 'Fort', 'Aventureux'],
};

export const defaultFlaws: Record<Language, string[]> = {
  en: ['Impatient', 'Distracted', 'Talkative', 'Whiny', 'Messy', 'Forgetful', 'Tattletale', 'Sore Loser', 'Stubborn', 'Lying', 'Bossy', 'Gullible', 'Jealous', 'Easily scared', 'Clingy', 'Quick-tempered', 'Selfish', 'Sneaky', 'Reckless', 'Shy', 'Clumsy', 'Lazy', 'Boastful', 'Indecisive', 'Perfectionist'],
  de: ['Ungeduldig', 'Zerstreut', 'Gesprächig', 'Weinerlich', 'Unordentlich', 'Vergesslich', 'Petze', 'Schlechter Verlierer', 'Stur', 'Lügnerisch', 'Rechthaberisch', 'Leichtgläubig', 'Eifersüchtig', 'Ängstlich', 'Anhänglich', 'Jähzornig', 'Egoistisch', 'Hinterlistig', 'Leichtsinnig', 'Schüchtern', 'Tollpatschig', 'Faul', 'Prahlerisch', 'Unentschlossen', 'Perfektionist'],
  fr: ['Impatient', 'Distrait', 'Bavard', 'Pleurnicheur', 'Désordonné', 'Oublieux', 'Rapporteur', 'Mauvais perdant', 'Têtu', 'Menteur', 'Autoritaire', 'Crédule', 'Jaloux', 'Facilement effrayé', 'Collant', 'Colérique', 'Égoïste', 'Sournois', 'Imprudent', 'Timide', 'Maladroit', 'Paresseux', 'Vantard', 'Indécis', 'Perfectionniste'],
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
    'Prüfungsangst',
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
    'Angst allein zu sein',
    'Angst sich zu verlaufen',
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
};

// Aliases for convenience
export const strengths = defaultStrengths;
export const flaws = defaultFlaws;
export const challenges = defaultChallenges;

// Legacy aliases (for backward compatibility)
export const weaknesses = defaultFlaws;
export const fears = defaultChallenges;
