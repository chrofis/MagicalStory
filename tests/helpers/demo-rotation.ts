/**
 * Demo story rotation list.
 * Each test run picks the next entry and generates one story.
 * Covers all 13 art styles and a diverse mix of topics.
 */

export interface DemoRotationEntry {
  index: number;
  storyCategory: string;
  storyTopic: string;
  storyTheme?: string;  // For adventure stories, this is the theme
  artStyle: string;
  description: string;  // Human-readable description for logging
}

export const DEMO_ROTATION: DemoRotationEntry[] = [
  {
    index: 0,
    storyCategory: 'life-challenge',
    storyTopic: 'first-kindergarten',
    artStyle: 'pixar',
    description: 'Erster Kindergartentag (Pixar)',
  },
  {
    index: 1,
    storyCategory: 'adventure',
    storyTopic: 'pirate',
    storyTheme: 'pirate',
    artStyle: 'watercolor',
    description: 'Piratenabenteuer (Aquarell)',
  },
  {
    index: 2,
    storyCategory: 'life-challenge',
    storyTopic: 'new-sibling',
    artStyle: 'cartoon',
    description: 'Neues Geschwisterchen (Cartoon)',
  },
  {
    index: 3,
    storyCategory: 'adventure',
    storyTopic: 'space',
    storyTheme: 'space',
    artStyle: 'concept',
    description: 'Weltraumabenteuer (Concept Art)',
  },
  {
    index: 4,
    storyCategory: 'life-challenge',
    storyTopic: 'brushing-teeth',
    artStyle: 'chibi',
    description: 'Zähneputzen (Chibi)',
  },
  {
    index: 5,
    storyCategory: 'adventure',
    storyTopic: 'dinosaur',
    storyTheme: 'dinosaur',
    artStyle: 'comic',
    description: 'Dinosaurierabenteuer (Comic)',
  },
  {
    index: 6,
    storyCategory: 'life-challenge',
    storyTopic: 'going-to-bed',
    artStyle: 'oil',
    description: 'Ins Bett gehen (Ölgemälde)',
  },
  {
    index: 7,
    storyCategory: 'adventure',
    storyTopic: 'knight',
    storyTheme: 'knight',
    artStyle: 'steampunk',
    description: 'Ritterabenteuer (Steampunk)',
  },
  {
    index: 8,
    storyCategory: 'educational',
    storyTopic: 'counting',
    artStyle: 'anime',
    description: 'Zählen lernen (Anime)',
  },
  {
    index: 9,
    storyCategory: 'life-challenge',
    storyTopic: 'making-friends',
    artStyle: 'pixar',
    description: 'Freunde finden (Pixar)',
  },
  {
    index: 10,
    storyCategory: 'adventure',
    storyTopic: 'mermaid',
    storyTheme: 'mermaid',
    artStyle: 'watercolor',
    description: 'Meerjungfrauenabenteuer (Aquarell)',
  },
  {
    index: 11,
    storyCategory: 'historical',
    storyTopic: 'moon-landing',
    artStyle: 'concept',
    description: 'Mondlandung (Concept Art)',
  },
  {
    index: 12,
    storyCategory: 'life-challenge',
    storyTopic: 'sharing',
    artStyle: 'cartoon',
    description: 'Teilen lernen (Cartoon)',
  },
  {
    index: 13,
    storyCategory: 'educational',
    storyTopic: 'planets',
    artStyle: 'cyber',
    description: 'Planetenwissen (Cyberpunk)',
  },
  {
    index: 14,
    storyCategory: 'adventure',
    storyTopic: 'superhero',
    storyTheme: 'superhero',
    artStyle: 'comic',
    description: 'Superheldenabenteuer (Comic)',
  },
  {
    index: 15,
    storyCategory: 'historical',
    storyTopic: 'wilhelm-tell',
    artStyle: 'oil',
    description: 'Wilhelm Tell (Ölgemälde)',
  },
  {
    index: 16,
    storyCategory: 'life-challenge',
    storyTopic: 'managing-emotions',
    artStyle: 'manga',
    description: 'Gefühle verstehen (Manga)',
  },
  {
    index: 17,
    storyCategory: 'adventure',
    storyTopic: 'jungle',
    storyTheme: 'jungle',
    artStyle: 'lowpoly',
    description: 'Dschungelabenteuer (Low Poly)',
  },
];
