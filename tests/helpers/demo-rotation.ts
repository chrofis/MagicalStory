import type { FamilyId, DemoLanguage } from './demo-characters';

/**
 * Demo story rotation list.
 * Each test run picks the next entry and generates one story.
 * Crosses: family × language × topic × art style — diverse homepage gallery.
 */

export interface DemoRotationEntry {
  index: number;
  familyId: FamilyId;
  language: DemoLanguage;
  storyCategory: string;
  storyTopic: string;
  storyTheme?: string;  // For adventure stories, this is the theme
  artStyle: string;
  description: string;  // Human-readable description for logging
}

export const DEMO_ROTATION: DemoRotationEntry[] = [
  // ── Berger (DE) ──────────────────────────────────────────────────
  {
    index: 0,
    familyId: 'berger',
    language: 'de',
    storyCategory: 'life-challenge',
    storyTopic: 'first-kindergarten',
    artStyle: 'pixar',
    description: 'Berger/DE — Erster Kindergartentag (Pixar)',
  },
  {
    index: 1,
    familyId: 'berger',
    language: 'de',
    storyCategory: 'adventure',
    storyTopic: 'pirate',
    storyTheme: 'pirate',
    artStyle: 'watercolor',
    description: 'Berger/DE — Piratenabenteuer (Aquarell)',
  },
  {
    index: 2,
    familyId: 'berger',
    language: 'de',
    storyCategory: 'life-challenge',
    storyTopic: 'new-sibling',
    artStyle: 'cartoon',
    description: 'Berger/DE — Neues Geschwisterchen (Cartoon)',
  },
  {
    index: 3,
    familyId: 'berger',
    language: 'de',
    storyCategory: 'adventure',
    storyTopic: 'dinosaur',
    storyTheme: 'dinosaur',
    artStyle: 'comic',
    description: 'Berger/DE — Dinosaurierabenteuer (Comic)',
  },
  {
    index: 4,
    familyId: 'berger',
    language: 'de',
    storyCategory: 'historical',
    storyTopic: 'wilhelm-tell',
    artStyle: 'oil',
    description: 'Berger/DE — Wilhelm Tell (Ölgemälde)',
  },
  {
    index: 5,
    familyId: 'berger',
    language: 'de',
    storyCategory: 'life-challenge',
    storyTopic: 'managing-emotions',
    artStyle: 'manga',
    description: 'Berger/DE — Gefühle verstehen (Manga)',
  },

  // ── Miller (EN) ──────────────────────────────────────────────────
  {
    index: 6,
    familyId: 'miller',
    language: 'en',
    storyCategory: 'life-challenge',
    storyTopic: 'making-friends',
    artStyle: 'pixar',
    description: 'Miller/EN — Making friends (Pixar)',
  },
  {
    index: 7,
    familyId: 'miller',
    language: 'en',
    storyCategory: 'adventure',
    storyTopic: 'space',
    storyTheme: 'space',
    artStyle: 'concept',
    description: 'Miller/EN — Space adventure (Concept)',
  },
  {
    index: 8,
    familyId: 'miller',
    language: 'en',
    storyCategory: 'life-challenge',
    storyTopic: 'sharing',
    artStyle: 'watercolor',
    description: 'Miller/EN — Learning to share (Watercolor)',
  },
  {
    index: 9,
    familyId: 'miller',
    language: 'en',
    storyCategory: 'adventure',
    storyTopic: 'superhero',
    storyTheme: 'superhero',
    artStyle: 'comic',
    description: 'Miller/EN — Superhero adventure (Comic)',
  },
  {
    index: 10,
    familyId: 'miller',
    language: 'en',
    storyCategory: 'educational',
    storyTopic: 'planets',
    artStyle: 'cyber',
    description: 'Miller/EN — Planets (Cyberpunk)',
  },
  {
    index: 11,
    familyId: 'miller',
    language: 'en',
    storyCategory: 'historical',
    storyTopic: 'moon-landing',
    artStyle: 'concept',
    description: 'Miller/EN — Moon landing (Concept)',
  },

  // ── Dubois (FR) ──────────────────────────────────────────────────
  {
    index: 12,
    familyId: 'dubois',
    language: 'fr',
    storyCategory: 'life-challenge',
    storyTopic: 'brushing-teeth',
    artStyle: 'chibi',
    description: 'Dubois/FR — Se brosser les dents (Chibi)',
  },
  {
    index: 13,
    familyId: 'dubois',
    language: 'fr',
    storyCategory: 'adventure',
    storyTopic: 'mermaid',
    storyTheme: 'mermaid',
    artStyle: 'watercolor',
    description: 'Dubois/FR — Aventure sirène (Aquarelle)',
  },
  {
    index: 14,
    familyId: 'dubois',
    language: 'fr',
    storyCategory: 'life-challenge',
    storyTopic: 'going-to-bed',
    artStyle: 'oil',
    description: 'Dubois/FR — Aller au lit (Peinture à l\'huile)',
  },
  {
    index: 15,
    familyId: 'dubois',
    language: 'fr',
    storyCategory: 'adventure',
    storyTopic: 'knight',
    storyTheme: 'knight',
    artStyle: 'steampunk',
    description: 'Dubois/FR — Aventure chevalier (Steampunk)',
  },
  {
    index: 16,
    familyId: 'dubois',
    language: 'fr',
    storyCategory: 'educational',
    storyTopic: 'counting',
    artStyle: 'anime',
    description: 'Dubois/FR — Apprendre à compter (Anime)',
  },
  {
    index: 17,
    familyId: 'dubois',
    language: 'fr',
    storyCategory: 'adventure',
    storyTopic: 'jungle',
    storyTheme: 'jungle',
    artStyle: 'lowpoly',
    description: 'Dubois/FR — Aventure jungle (Low Poly)',
  },
];
