import familiesData from './demo-families.json';

export type FamilyId = 'berger' | 'miller' | 'dubois';
export type DemoLanguage = 'en' | 'de' | 'fr';

export interface DemoCharacter {
  id: number;
  name: string;
  gender: 'female' | 'male';
  age: string;
  ageCategory: 'preschooler' | 'young-school-age' | 'adult';
  storyRole: 'main' | 'in' | 'not';
  physical: Record<string, string>;
  traits: {
    strengths: string[];
    flaws: string[];
    challenges: string[];
    specialDetails: string;
  };
  clothing: { structured: { upperBody: string; lowerBody: string; shoes: string } };
  portraitPrompt: string;
}

export interface DemoFamily {
  id: FamilyId;
  label: string;
  email: string;
  primaryLanguage: DemoLanguage;
  characters: DemoCharacter[];
  relationships: Record<string, string>;
}

const raw = familiesData as { families: DemoFamily[] };
export const DEMO_FAMILIES: DemoFamily[] = raw.families;

export function getFamily(id: FamilyId): DemoFamily {
  const family = DEMO_FAMILIES.find(f => f.id === id);
  if (!family) throw new Error(`Unknown demo family: ${id}`);
  return family;
}

// Back-compat exports (pre-multi-family callers used Berger).
const berger = getFamily('berger');
export const DEMO_FAMILY_NAME = berger.label;
export const DEMO_CHARACTERS = berger.characters;
export const DEMO_RELATIONSHIPS = berger.relationships;
