import type { Language } from '@/types/story';

export const defaultStrengths: Record<Language, string[]> = {
  en: ['Brave', 'Smart', 'Kind', 'Strong', 'Fast', 'Creative', 'Funny', 'Leader', 'Helpful', 'Patient', 'Honest', 'Loyal', 'Curious', 'Determined', 'Caring', 'Confident', 'Cheerful', 'Generous', 'Clever', 'Adventurous', 'Resourceful', 'Protective', 'Imaginative', 'Hardworking', 'Trustworthy'],
  de: ['Mutig', 'Klug', 'Freundlich', 'Stark', 'Schnell', 'Kreativ', 'Lustig', 'Führungspersönlichkeit', 'Hilfsbereit', 'Geduldig', 'Ehrlich', 'Treu', 'Neugierig', 'Entschlossen', 'Fürsorglich', 'Selbstbewusst', 'Fröhlich', 'Großzügig', 'Schlau', 'Abenteuerlustig', 'Einfallsreich', 'Beschützend', 'Fantasievoll', 'Fleißig', 'Vertrauenswürdig'],
  fr: ['Courageux', 'Intelligent', 'Gentil', 'Fort', 'Rapide', 'Créatif', 'Drôle', 'Leader', 'Serviable', 'Patient', 'Honnête', 'Loyal', 'Curieux', 'Déterminé', 'Attentionné', 'Confiant', 'Joyeux', 'Généreux', 'Astucieux', 'Aventureux', 'Débrouillard', 'Protecteur', 'Imaginatif', 'Travailleur', 'Digne de confiance'],
};

export const defaultWeaknesses: Record<Language, string[]> = {
  en: ['Shy', 'Clumsy', 'Impatient', 'Forgetful', 'Messy', 'Talkative', 'Stubborn', 'Lazy', 'Greedy', 'Jealous', 'Anxious', 'Distracted', 'Reckless', 'Bossy', 'Easily scared', 'Too trusting', 'Perfectionist', 'Indecisive', 'Secretive', 'Boastful', 'Quick-tempered', 'Careless', 'Overly cautious', 'Selfish'],
  de: ['Schüchtern', 'Tollpatschig', 'Ungeduldig', 'Vergesslich', 'Unordentlich', 'Gesprächig', 'Stur', 'Faul', 'Gierig', 'Eifersüchtig', 'Ängstlich', 'Abgelenkt', 'Leichtsinnig', 'Herrschsüchtig', 'Leicht ängstlich', 'Zu vertrauensvoll', 'Perfektionist', 'Unentschlossen', 'Verschlossen', 'Prahlerisch', 'Jähzornig', 'Nachlässig', 'Übervorsichtig', 'Egoistisch'],
  fr: ['Timide', 'Maladroit', 'Impatient', 'Distrait', 'Désordonné', 'Bavard', 'Têtu', 'Paresseux', 'Avide', 'Jaloux', 'Anxieux', 'Distrait', 'Imprudent', 'Autoritaire', 'Facilement effrayé', 'Trop confiant', 'Perfectionniste', 'Indécis', 'Secret', 'Vantard', 'Colérique', 'Négligent', 'Trop prudent', 'Égoïste'],
};

export const fearOptions: Record<Language, string[]> = {
  en: ['Fear of heights', 'Fear of spiders', 'Fear of the dark', 'Fear of being alone', 'Fear of loud noises'],
  de: ['Höhenangst', 'Angst vor Spinnen', 'Angst vor der Dunkelheit', 'Angst allein zu sein', 'Angst vor lauten Geräuschen'],
  fr: ['Peur du vide', 'Peur des araignées', 'Peur du noir', "Peur d'être seul", 'Peur des bruits forts'],
};

// Aliases for convenience
export const strengths = defaultStrengths;
export const weaknesses = defaultWeaknesses;
export const fears = fearOptions;
