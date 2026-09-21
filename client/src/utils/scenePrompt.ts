import type { SceneDescription, SceneExpansionReport } from '../types/story';

/**
 * The Art Director prompt that wrote a page's brief.
 *
 * Client sibling of `resolveScenePrompt()` in `server/lib/storyShape.js` — keep
 * the two in step. The all-pages scene-expansion prompt is ~112 KB and the same
 * for every page of a book, so it is stored once in
 * `sceneExpansionReport.prompts[]` and each scene carries `scenePromptRef`, the
 * index into it. Rows written before 2026-09-21 hold the prompt inline on
 * `scenePrompt`; that is stored legacy data, not a second write path.
 */
export function resolveScenePrompt(
  sceneDescriptions: SceneDescription[] | undefined,
  report: SceneExpansionReport | null | undefined,
  pageNumber: number
): string | undefined {
  const scene = (sceneDescriptions || []).find(s => s.pageNumber === pageNumber);
  if (!scene) return undefined;
  if (scene.scenePrompt) return scene.scenePrompt;
  const ref = scene.scenePromptRef;
  if (ref === null || ref === undefined) return undefined;
  return report?.prompts?.[ref]?.prompt || undefined;
}
