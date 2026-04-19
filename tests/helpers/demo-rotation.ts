import type { FamilyId, DemoLanguage } from './demo-characters';
import rotationData from './demo-rotation.json';

/**
 * Demo story rotation list. Source of truth lives in `demo-rotation.json` —
 * this file just re-exports it with TypeScript types attached.
 *
 * Each entry crosses family × language × topic × art style for diverse
 * homepage gallery coverage.
 */

export interface DemoRotationEntry {
  index: number;
  familyId: FamilyId;
  language: DemoLanguage;
  storyCategory: string;
  storyTopic: string;
  storyTheme?: string;
  artStyle: string;
  description: string;
}

export const DEMO_ROTATION: DemoRotationEntry[] = (rotationData as { entries: DemoRotationEntry[] }).entries;
