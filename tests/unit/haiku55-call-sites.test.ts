/**
 * Haiku call sites (docs/decisions.md 2026-10-08). Regression for the dead key:
 * visualBible (vb_chr_dedup) and phantomCharacters named 'claude-haiku-4-5', which
 * is not a TEXT_MODELS key, so callTextModel threw "Unknown text model override"
 * on every call (the dedup silently defaulted to "merge"). Every claude-haiku
 * literal in a call site must be a TEXT_MODELS key or a modelId in the registry.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { TEXT_MODELS } = require('../../server/config/models');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { buildSceneTranslationPrompt } = require('../../server/lib/promptBuilders');

const ROOT = join(__dirname, '..', '..');
const FILES = [
  'storyJobPipeline.js',
  'server/lib/visualBible.js',
  'server/lib/phantomCharacters.js',
  'server/lib/landmarkPhotos.js',
  'server/lib/figureDetection.js',
  'server/lib/traitPanel.js',
];
const known = new Set<string>([
  ...Object.keys(TEXT_MODELS),
  ...Object.values(TEXT_MODELS).map((m: any) => m.modelId),
]);

describe('claude-haiku literals at the call sites resolve in the registry', () => {
  for (const f of FILES) {
    it(f, () => {
      const src = readFileSync(join(ROOT, f), 'utf8');
      const code = src.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
      const literals = [...code.matchAll(/'(claude-haiku[a-z0-9-]*)'/g)].map(m => m[1]);
      for (const lit of literals) expect(known.has(lit), `${f}: '${lit}' is neither a TEXT_MODELS key nor a modelId`).toBe(true);
    });
  }
});

describe('buildSceneTranslationPrompt', () => {
  it('numbers only the scenes that have a summary and reports how many lines to expect', () => {
    const built = buildSceneTranslationPrompt([
      { pageNumber: 1, imageSummary: 'A boy stands on a bridge.' },
      { pageNumber: 2, imageSummary: '   ' },
      { pageNumber: 3, imageSummary: 'A cat sits on a wall.' },
    ], 'de-ch');
    expect(built.count).toBe(2);
    expect(built.prompt).toContain('Page 1: A boy stands on a bridge.');
    expect(built.prompt).toContain('Page 3: A cat sits on a wall.');
    expect(built.prompt).not.toContain('Page 2:');
    expect(built.prompt).toContain('one per line');
  });
  it('returns null when no scene has a summary', () => {
    expect(buildSceneTranslationPrompt([{ pageNumber: 1, imageSummary: '' }], 'fr')).toBeNull();
    expect(buildSceneTranslationPrompt([], 'fr')).toBeNull();
  });
});
