/**
 * Demo family: The Berger Family
 * Used for generating demo stories on the homepage.
 * Characters are in German since demo stories are generated in German.
 */

export const DEMO_FAMILY_NAME = 'Berger';

export const DEMO_CHARACTERS = [
  {
    id: 1,
    name: 'Emma',
    gender: 'female' as const,
    age: '5',
    ageCategory: 'preschooler' as const,
    storyRole: 'main' as const,
    physical: {
      hairColor: 'brown',
      hairLength: 'long',
      hairStyle: 'pigtails',
      eyeColor: 'brown',
      skinTone: 'light',
      build: 'average',
      height: 'short',
    },
    traits: {
      strengths: ['Neugierig', 'Fröhlich', 'Fantasievoll'],
      flaws: ['Ungeduldig', 'Anhänglich'],
      challenges: ['Mit anderen teilen', 'Angst vor der Dunkelheit'],
      specialDetails: 'Liebt Schmetterlinge, malt gerne, Lieblingsteddy heisst Bärli',
    },
    clothing: {
      structured: {
        upperBody: 'rosa T-Shirt mit Schmetterlings-Aufdruck',
        lowerBody: 'blaue Jeans',
        shoes: 'weisse Turnschuhe',
      },
    },
  },
  {
    id: 2,
    name: 'Noah',
    gender: 'male' as const,
    age: '7',
    ageCategory: 'young-school-age' as const,
    storyRole: 'main' as const,
    physical: {
      hairColor: 'blonde',
      hairLength: 'short',
      hairStyle: 'straight',
      eyeColor: 'blue',
      skinTone: 'light',
      build: 'average',
      height: 'average',
    },
    traits: {
      strengths: ['Mutig', 'Kreativ', 'Abenteuerlustig'],
      flaws: ['Stur', 'Schlechter Verlierer'],
      challenges: ['Regeln befolgen', 'Gefühle kontrollieren'],
      specialDetails: 'Liebt Dinosaurier, baut gerne Lego, spielt Fussball',
    },
    clothing: {
      structured: {
        upperBody: 'grünes Kapuzenpullover',
        lowerBody: 'dunkelgraue Jogginghose',
        shoes: 'blaue Sneakers',
      },
    },
  },
  {
    id: 3,
    name: 'Daniel',
    gender: 'male' as const,
    age: '38',
    ageCategory: 'adult' as const,
    storyRole: 'in' as const,
    physical: {
      hairColor: 'dark brown',
      hairLength: 'short',
      hairStyle: 'straight',
      eyeColor: 'brown',
      skinTone: 'light',
      facialHair: 'trimmed beard',
      build: 'average',
      height: 'tall',
    },
    traits: {
      strengths: ['Geduldig', 'Beschützend', 'Lustig'],
      flaws: ['Vergesslich', 'Zerstreut'],
      challenges: ['Mit Veränderungen umgehen'],
      specialDetails: 'Ingenieur, liebt Wandern und kocht gerne',
    },
    clothing: {
      structured: {
        upperBody: 'dunkelblaues Hemd',
        lowerBody: 'beige Chinos',
        shoes: 'braune Lederschuhe',
      },
    },
  },
  {
    id: 4,
    name: 'Sarah',
    gender: 'female' as const,
    age: '36',
    ageCategory: 'adult' as const,
    storyRole: 'in' as const,
    physical: {
      hairColor: 'blonde',
      hairLength: 'shoulder-length',
      hairStyle: 'straight',
      eyeColor: 'green',
      skinTone: 'light',
      build: 'average',
      height: 'average',
      other: 'wears glasses',
    },
    traits: {
      strengths: ['Hilfsbereit', 'Klug', 'Grosszügig'],
      flaws: ['Perfektionist', 'Ungeduldig'],
      challenges: ['Für sich einstehen'],
      specialDetails: 'Lehrerin, liest gerne Bücher, liebt Gartenarbeit',
    },
    clothing: {
      structured: {
        upperBody: 'weisse Bluse',
        lowerBody: 'dunkelblauer Rock',
        shoes: 'schwarze Ballerinas',
      },
    },
  },
];

export const DEMO_RELATIONSHIPS = {
  '1-2': 'sibling',
  '1-3': 'parent-child',
  '1-4': 'parent-child',
  '2-3': 'parent-child',
  '2-4': 'parent-child',
  '3-4': 'partner',
};
