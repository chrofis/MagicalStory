/**
 * ONE PLATE PER VANTAGE — the Art Director writes it once (owner, 2026-09-17:
 * "we either reuse a plate or create a new one. AD should decide. Making a new
 * one and discarding it is obviously stupid.").
 *
 * The backdrop plate was a REQUIRED per-page field of the brief while the
 * render loop has been per Visual Bible vantage since 2026-08-29. On staging
 * job_1789584708605_rts4wqupm that cost 18 authored plates for 3 rendered ones
 * — 15 written and thrown away, and the framing of whichever page happened to
 * sort first decided the backdrop for the other nine.
 *
 * The plate now lives on the vantage (on the location entry when the place is
 * shown from one viewpoint and declares no `vantages[]`). What this locks down:
 * the contract in both Art Director templates, the read ladder that keeps every
 * stored story resolving its own plate verbatim, and the refusal to substitute
 * a plate for a vantage that has none.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'fs';
import path from 'path';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(__dirname, '../..');
const {
  resolvePagePlate,
  getPrimaryVantageForPage,
  describeDegradedSceneMetadata,
} = require('../../server/lib/sceneMetadata.js');

/** Top-level keys of an AD template's single-line JSON metadata example. */
function metadataKeys(file: string): string[] {
  const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const block = [...text.matchAll(/^```[a-z]*\r?\n([\s\S]*?)^```/gm)]
    .map((m) => m[1])
    .find((b) => b.includes('"sceneIntent"')) as string;
  expect(block, `${file} has a fenced metadata example`).toBeTruthy();
  return [...block.matchAll(/^ {2}"([A-Za-z0-9_]+)":/gm)].map((m) => m[1]);
}

describe('the page brief no longer asks for a plate', () => {
  for (const file of ['prompts/scene-expansion-all.txt', 'prompts/scene-expansion.txt']) {
    it(`${path.basename(file)} declares no per-page emptyScenePrompt`, () => {
      expect(metadataKeys(file)).not.toContain('emptyScenePrompt');
    });
  }

  it('the all-pages template puts the plate on the vantage instead', () => {
    const t = fs.readFileSync(path.join(ROOT, 'prompts/scene-expansion-all.txt'), 'utf8');
    expect(t).toContain('One backdrop plate is painted per vantage');
    expect(t).toContain('an `emptyScenePrompt` (the plate, rules below)');
    // A location shown from one viewpoint declares no vantages[] and must still
    // have somewhere to put its plate.
    expect(t).toContain('A location with no `vantages[]` carries its single plate in its own `emptyScenePrompt`');
  });

  it('the per-page template, which authors no bible, writes no plate at all', () => {
    const t = fs.readFileSync(path.join(ROOT, 'prompts/scene-expansion.txt'), 'utf8');
    expect(t).toContain('**Backdrop plate**');
    expect(t).toContain('You do not write one.');
    // It never gained the bible-authoring half, so it must not carry the
    // per-vantage plate rules either.
    expect(t).not.toContain('One backdrop plate is painted per vantage');
  });
});

describe('resolvePagePlate', () => {
  const withVantages = {
    locations: [{
      id: 'LOC001',
      name: 'Market square',
      pages: [1, 2, 3],
      vantages: [
        { id: 'LOC001.1', name: 'from the fountain', shot: 'wide', pages: [1, 2], emptyScenePrompt: 'The wide square from the fountain.' },
        { id: 'LOC001.2', name: 'under the arcade', shot: 'medium', pages: [3], emptyScenePrompt: 'The arcade, columns receding left.' },
      ],
    }],
  };
  const singleViewpoint = {
    locations: [{ id: 'LOC001', name: 'Market square', pages: [1, 2], emptyScenePrompt: 'The wide square under autumn light.' }],
  };
  const legacyBible = {
    locations: [{ id: 'LOC001', name: 'Market square', pages: [1, 2] }],
  };

  it('takes the cited vantage’s own plate', () => {
    const r = resolvePagePlate({
      pageNumber: 3,
      sceneMetadata: { objects: ['LOC001.2'] },
      visualBible: withVantages,
    });
    expect(r).toEqual({ text: 'The arcade, columns receding left.', source: 'vantage', vantageId: 'LOC001.2' });
  });

  it('gives every page of one vantage the same plate', () => {
    const one = resolvePagePlate({ pageNumber: 1, sceneMetadata: { objects: ['LOC001.1'] }, visualBible: withVantages });
    const two = resolvePagePlate({ pageNumber: 2, sceneMetadata: { objects: ['LOC001.1'] }, visualBible: withVantages });
    expect(two.text).toBe(one.text);
    expect(two.vantageId).toBe(one.vantageId);
  });

  it('reads a single-viewpoint location’s plate off the entry itself', () => {
    const r = resolvePagePlate({ pageNumber: 1, sceneMetadata: { objects: ['LOC001'] }, visualBible: singleViewpoint });
    expect(r.source).toBe('vantage');
    expect(r.text).toBe('The wide square under autumn light.');
    expect(r.vantageId).toBe('LOC001.1');
  });

  // BACKWARD COMPATIBILITY. Every stored story carries a per-page plate and no
  // vantage plate at all; it is used exactly as written, never reinterpreted.
  it('falls back to a stored per-page plate, verbatim', () => {
    const stored = 'A gravel square in drifts of red and yellow leaves, lindens left and right.';
    const r = resolvePagePlate({
      pageNumber: 1,
      sceneMetadata: { objects: ['LOC001'], emptyScenePrompt: stored },
      visualBible: legacyBible,
    });
    expect(r).toEqual({ text: stored, source: 'page', vantageId: 'LOC001.1' });
  });

  it('prefers the vantage plate when a transitional brief carries both', () => {
    const r = resolvePagePlate({
      pageNumber: 1,
      sceneMetadata: { objects: ['LOC001'], emptyScenePrompt: 'a leftover per-page plate' },
      visualBible: singleViewpoint,
    });
    expect(r.source).toBe('vantage');
    expect(r.text).toBe('The wide square under autumn light.');
  });

  it('keeps an outline-level plate ahead of both', () => {
    const r = resolvePagePlate({
      pageNumber: 1,
      sceneMetadata: { objects: ['LOC001'], emptyScenePrompt: 'page plate' },
      visualBible: singleViewpoint,
      outlinePlate: 'outline plate',
    });
    expect(r).toEqual({ text: 'outline plate', source: 'outline', vantageId: null });
  });

  // A vantage with no plate fails loudly. The one thing it must never do is
  // quietly inherit the plate of another page that happens to share it — that
  // is the discard-and-guess behaviour this change removes.
  it('reports a vantage with no plate as missing, and borrows nobody else’s', () => {
    const pageTwoHasOne = {
      locations: [{
        id: 'LOC001',
        name: 'Market square',
        pages: [1, 2],
        vantages: [{ id: 'LOC001.1', name: 'from the fountain', shot: 'wide', pages: [1, 2] }],
      }],
    };
    const two = resolvePagePlate({
      pageNumber: 2,
      sceneMetadata: { objects: ['LOC001.1'], emptyScenePrompt: 'page 2 wrote one' },
      visualBible: pageTwoHasOne,
    });
    expect(two.source).toBe('page');

    const one = resolvePagePlate({
      pageNumber: 1,
      sceneMetadata: { objects: ['LOC001.1'] },
      visualBible: pageTwoHasOne,
    });
    expect(one.source).toBe('missing');
    expect(one.text).toBe('');
    expect(one.vantageId).toBe('LOC001.1');
  });

  it('is missing, not empty-stringed, when the page cites no location at all', () => {
    const r = resolvePagePlate({ pageNumber: 1, sceneMetadata: { objects: [] }, visualBible: legacyBible });
    expect(r).toEqual({ text: '', source: 'missing', vantageId: null });
  });
});

describe('the synthesized vantage of a single-viewpoint location', () => {
  it('carries the entry’s plate', () => {
    const v = getPrimaryVantageForPage({ objects: ['LOC001'] }, {
      locations: [{ id: 'LOC001', name: 'Square', pages: [1], emptyScenePrompt: 'The square.' }],
    }, { pageNumber: 1 });
    expect(v.vantageId).toBe('LOC001.1');
    expect(v.emptyScenePrompt).toBe('The square.');
  });

  it('carries an empty plate on a legacy bible rather than inventing one', () => {
    const v = getPrimaryVantageForPage({ objects: ['LOC001'] }, {
      locations: [{ id: 'LOC001', name: 'Square', pages: [1], setting: 'outdoor square', colors: 'grey' }],
    }, { pageNumber: 1 });
    expect(v.emptyScenePrompt).toBe('');
    expect(v.description).toContain('outdoor square'); // setting context is untouched
  });
});

describe('the degraded-brief record', () => {
  it('no longer counts a missing per-page plate as a lost input', () => {
    const d = describeDegradedSceneMetadata({
      isRecovered: true,
      characters: [{ name: 'Mara' }],
      clothing: 'standard',
      objects: ['LOC001'],
      interactions: [],
      textPosition: 'top-left',
      setting: { description: 'a square' },
    });
    expect(d.emptyInputs).not.toContain('emptyScenePrompt');
    expect(d.emptyInputs).toEqual([]);
  });
});

describe('the scene reviewer can still see the plate it grades', () => {
  let buildSceneReviewBibleBlock: any;
  beforeAll(async () => {
    await require('../../server/services/prompts').loadPromptTemplates();
    ({ buildSceneReviewBibleBlock } = require('../../server/lib/promptBuilders.js'));
  });

  it('renders one VANTAGE PLATES row per vantage with its pages', () => {
    const block = buildSceneReviewBibleBlock({
      locations: [
        {
          id: 'LOC001', name: 'Market square', label: 'market square', pages: [1, 2, 3],
          vantages: [
            { id: 'LOC001.1', name: 'from the fountain', shot: 'wide', pages: [1, 2], emptyScenePrompt: 'The wide square from the fountain.' },
            { id: 'LOC001.2', name: 'under the arcade', shot: 'medium', pages: [3], emptyScenePrompt: 'The arcade, columns receding left.' },
          ],
        },
        { id: 'LOC002', name: 'Lane', label: 'narrow lane', pages: [4], emptyScenePrompt: 'A narrow lane climbing away.' },
      ],
    });
    expect(block).toContain('# VANTAGE PLATES');
    expect(block).toContain('LOC001.1');
    expect(block).toContain('pages [1,2]: The wide square from the fountain.');
    expect(block).toContain('LOC001.2');
    expect(block).toContain('LOC002.1'); // single viewpoint, synthesized id
    expect(block).toContain('A narrow lane climbing away.');
  });

  it('emits nothing for a legacy bible that authored no plates', () => {
    const block = buildSceneReviewBibleBlock({ locations: [{ id: 'LOC001', name: 'Square', pages: [1] }] });
    expect(block).toBe('');
  });
});
