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
  en: ['Fear of heights', 'Fear of spiders', 'Fear of the dark', 'Fear of being alone', 'Fear of loud noises', 'Making new friends', 'Speaking in public', 'Trying new things', 'Accepting help', 'Dealing with change', 'Standing up for oneself', 'Sharing with others', 'Following rules', 'Controlling emotions', 'Asking for help'],
  de: ['Höhenangst', 'Angst vor Spinnen', 'Angst vor der Dunkelheit', 'Angst allein zu sein', 'Angst vor lauten Geräuschen', 'Neue Freunde finden', 'Vor anderen sprechen', 'Neues ausprobieren', 'Hilfe annehmen', 'Mit Veränderungen umgehen', 'Für sich einstehen', 'Mit anderen teilen', 'Regeln befolgen', 'Gefühle kontrollieren', 'Um Hilfe bitten'],
  fr: ['Peur du vide', 'Peur des araignées', 'Peur du noir', "Peur d'être seul", 'Peur des bruits forts', 'Se faire de nouveaux amis', 'Parler en public', 'Essayer de nouvelles choses', "Accepter de l'aide", 'Gérer le changement', 'Se défendre', 'Partager avec les autres', 'Suivre les règles', 'Contrôler ses émotions', "Demander de l'aide"],
};

// Aliases for convenience
export const strengths = defaultStrengths;
export const flaws = defaultFlaws;
export const challenges = defaultChallenges;

// Legacy aliases (for backward compatibility)
export const weaknesses = defaultFlaws;
export const fears = defaultChallenges;
