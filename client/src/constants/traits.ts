import type { Language } from '@/types/story';

export const defaultStrengths: Record<Language, string[]> = {
  en: ['Brave', 'Smart', 'Kind', 'Strong', 'Fast', 'Creative', 'Funny', 'Leader', 'Helpful', 'Patient', 'Honest', 'Loyal', 'Curious', 'Determined', 'Caring', 'Confident', 'Cheerful', 'Generous', 'Clever', 'Adventurous', 'Resourceful', 'Protective', 'Imaginative', 'Hardworking', 'Trustworthy'],
  de: ['Mutig', 'Klug', 'Freundlich', 'Stark', 'Schnell', 'Kreativ', 'Lustig', 'Führungspersönlichkeit', 'Hilfsbereit', 'Geduldig', 'Ehrlich', 'Treu', 'Neugierig', 'Entschlossen', 'Fürsorglich', 'Selbstbewusst', 'Fröhlich', 'Grosszügig', 'Schlau', 'Abenteuerlustig', 'Einfallsreich', 'Beschützend', 'Fantasievoll', 'Fleissig', 'Vertrauenswürdig'],
  fr: ['Courageux', 'Intelligent', 'Gentil', 'Fort', 'Rapide', 'Créatif', 'Drôle', 'Leader', 'Serviable', 'Patient', 'Honnête', 'Loyal', 'Curieux', 'Déterminé', 'Attentionné', 'Confiant', 'Joyeux', 'Généreux', 'Astucieux', 'Aventureux', 'Débrouillard', 'Protecteur', 'Imaginatif', 'Travailleur', 'Digne de confiance'],
};

export const defaultFlaws: Record<Language, string[]> = {
  en: ['Shy', 'Clumsy', 'Impatient', 'Forgetful', 'Messy', 'Talkative', 'Stubborn', 'Lazy', 'Greedy', 'Jealous', 'Anxious', 'Distracted', 'Reckless', 'Bossy', 'Easily scared', 'Too trusting', 'Perfectionist', 'Indecisive', 'Secretive', 'Boastful', 'Quick-tempered', 'Careless', 'Overly cautious', 'Selfish'],
  de: ['Schüchtern', 'Tollpatschig', 'Ungeduldig', 'Vergesslich', 'Unordentlich', 'Gesprächig', 'Stur', 'Faul', 'Gierig', 'Eifersüchtig', 'Ängstlich', 'Abgelenkt', 'Leichtsinnig', 'Herrschsüchtig', 'Leicht ängstlich', 'Zu vertrauensvoll', 'Perfektionist', 'Unentschlossen', 'Verschlossen', 'Prahlerisch', 'Jähzornig', 'Nachlässig', 'Übervorsichtig', 'Egoistisch'],
  fr: ['Timide', 'Maladroit', 'Impatient', 'Distrait', 'Désordonné', 'Bavard', 'Têtu', 'Paresseux', 'Avide', 'Jaloux', 'Anxieux', 'Distrait', 'Imprudent', 'Autoritaire', 'Facilement effrayé', 'Trop confiant', 'Perfectionniste', 'Indécis', 'Secret', 'Vantard', 'Colérique', 'Négligent', 'Trop prudent', 'Égoïste'],
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
