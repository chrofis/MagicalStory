/**
 * Page layout resolver — frontend mirror of server/lib/layout.js.
 *
 * Used by StoryDisplay, SharedStoryViewer, and the PDF preview to decide
 * whether to render an A4-overlay layout or a square-with-text-below layout
 * for each page. Backend stamps imageAspect + textInImage onto each scene
 * at expansion time; frontend reads those fields directly. This helper is
 * the fallback when a scene predates those fields (legacy story).
 */

import type { LanguageLevel } from '@/types/story';

export type LayoutOverride = 'auto' | 'a4-overlay' | 'square-below' | 'legacy-square-2page';
export type LayoutMode = 'a4-overlay' | 'square-below' | 'legacy-square-2page';

export interface LayoutResult {
  imageAspect: '1:1' | '3:4';
  textInImage: boolean;
  mode: LayoutMode;
}

const LAYOUTS: Record<LayoutMode, LayoutResult> = {
  'a4-overlay':          { imageAspect: '3:4', textInImage: true,  mode: 'a4-overlay' },
  'square-below':        { imageAspect: '1:1', textInImage: false, mode: 'square-below' },
  'legacy-square-2page': { imageAspect: '1:1', textInImage: false, mode: 'legacy-square-2page' },
};

export function resolveLayout(languageLevel: LanguageLevel | string | undefined, override: LayoutOverride = 'auto'): LayoutResult {
  if (override && override !== 'auto' && LAYOUTS[override as LayoutMode]) {
    return { ...LAYOUTS[override as LayoutMode] };
  }
  if (languageLevel === 'advanced') {
    return { ...LAYOUTS['square-below'] };
  }
  return { ...LAYOUTS['a4-overlay'] };
}

/**
 * Resolve effective layout for a single scene. Prefers the per-scene fields
 * stamped at expansion time; falls back to deriving from languageLevel for
 * stories that pre-date those fields.
 */
export function sceneLayout(
  scene: { imageAspect?: '1:1' | '3:4'; textInImage?: boolean },
  languageLevel?: LanguageLevel | string,
  override: LayoutOverride = 'auto',
): LayoutResult {
  if (scene?.imageAspect && typeof scene.textInImage === 'boolean') {
    return {
      imageAspect: scene.imageAspect,
      textInImage: scene.textInImage,
      mode: scene.textInImage ? 'a4-overlay' : 'square-below',
    };
  }
  return resolveLayout(languageLevel, override);
}
