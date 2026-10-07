/**
 * The trial page's VB grid is the PRODUCTION page grid (2026-10-07).
 *
 * startTrialPageImageGeneration (storyJobPipeline.js) hand-rolled its own
 * selection: getElementReferenceImagesForPage at cap 6 with no scene objects,
 * an id fallback, cap 6 again, no plate-borne filter, no `aboard` withheld, and
 * the secondary landmark PHOTOS composited among the cells. Production selects
 * through pageRenderCall.selectPageElementRefs (objects[] + id fallback, the
 * physical cap VB_SLOT_MAX_ELEMENTS = 4) and filters through
 * keepPageGridElements (plate-borne elements dropped when a plate is sent,
 * the camera's element withheld), with NO landmark in the grid (owner, settled
 * 2026-08-18). The trial now calls the one helper that composes both,
 * pageRenderCall.buildPageVbGrid, and rebuilds its reference claim from the
 * KEPT cells as Phase 5a-pre-grid does. Same number of image calls.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require_ = createRequire(import.meta.url);
const ROOT = path.resolve(__dirname, '../..');
const PIPELINE = readFileSync(path.join(ROOT, 'storyJobPipeline.js'), 'utf8');

const referenceSheets = require_('../../server/lib/referenceSheets.js');
const gridCalls: Array<{ els: any[]; landmarks: any[] }> = [];
referenceSheets.buildVisualBibleGrid = async (els: any[], landmarks: any[]) => {
  gridCalls.push({ els, landmarks });
  return { rawElements: els, stubGrid: els.map((e: any) => e.id).join(',') };
};
const pageRender = require_('../../server/lib/pageRenderCall.js');
const { extractSceneMetadata } = require_('../../server/lib/sceneMetadata.js');
const { VB_SLOT_MAX_ELEMENTS } = require_('../../server/lib/grok.js');

// A trial writer's scene hint: the JSON shape prompts/story-trial.txt declares
// (no Art Director brief — `objects[]` is the hint's own list, no `aboard`).
const trialHint = (objects: any[]) => JSON.stringify({
  scene: {
    imageSummary: 'Lina stands on the quay beside the fishing boat, holding her lantern.',
    setting: { location: 'The harbour [LOC001]', indoorOutdoor: 'outdoor', description: 'a stone quay', lighting: 'dusk', camera: 'medium', depthLayers: 'quay, boat, sea' },
    timeOfDay: 'evening', weather: 'clear',
    characters: [{ id: null, name: 'Lina', position: 'center', action: 'holding a lantern', expression: 'calm', clothing: 'standard', depth: 'foreground', perspective: 'front' }],
    objects,
    interactions: [{ character: 'Lina', object: 'ART001', where: 'holds the lantern in both hands', priority: 'essential' }],
    background: 'empty',
  },
});

const cell = (id: string, name: string, extra: any = {}) => ({
  id, name, description: `the ${name}`, appearsInPages: [2], referenceImageUrl: `https://r2/${id.toLowerCase()}.png`, ...extra,
});
const VB: any = {
  mainCharacters: [{ id: 'main', name: 'Lina' }],
  secondaryCharacters: [], animals: [], clothing: [],
  locations: [{ id: 'LOC001', name: 'The harbour', description: 'a stone quay', appearsInPages: [2] }],
  artifacts: [
    cell('ART001', 'brass lantern'), cell('ART002', 'coiled rope'), cell('ART003', 'wooden bucket'),
    cell('ART004', 'fishing net'), cell('ART005', 'tin cup'),
  ],
  vehicles: [cell('VEH001', 'fishing boat', { scaleClass: 'double' })],
};
const OBJECTS = [
  { id: 'VEH001', name: 'fishing boat', position: 'moored at the quay' },
  { id: 'ART001', name: 'brass lantern', position: 'in her hands' },
  { id: 'ART002', name: 'coiled rope', position: 'on the quay' },
  { id: 'ART003', name: 'wooden bucket', position: 'by the bollard' },
  { id: 'ART004', name: 'fishing net', position: 'draped over the boat' },
  { id: 'ART005', name: 'tin cup', position: 'on a crate' },
];

describe('trial page grid is built by the production helper', () => {
  it('startTrialPageImageGeneration calls buildPageVbGrid with the trial plate as "plate sent" and claims the kept cells', () => {
    const start = PIPELINE.indexOf('const startTrialPageImageGeneration = (page) => {');
    const end = PIPELINE.indexOf('const startCoverGeneration = ', start);
    expect(start).toBeGreaterThan(-1);
    const trial = PIPELINE.slice(start, end);
    expect(trial).toMatch(/require\('\.\/server\/lib\/pageRenderCall'\)\.buildPageVbGrid\(\{\s*visualBible: streamingVisualBible, pageNumber: page\.pageNumber, sceneMetadata, hasPlate: !!trialPlate,\s*\}\)/);
    // The reference claim is rebuilt from the KEPT cells, as Phase 5a-pre-grid does.
    expect(trial).toContain('})(kept.map(e => e.id).filter(Boolean));');
    // The hand-rolled selection is gone: no own selector call, no cap 6, no
    // landmark photos in the grid, no grid built outside the helper.
    expect(trial).not.toContain('getElementReferenceImagesForPage(');
    expect(trial).not.toContain('getElementReferenceImagesByIds(');
    expect(trial).not.toContain('slice(0, 6)');
    expect(trial).not.toContain('secondaryLandmarks');
    expect(trial).not.toContain('buildVisualBibleGrid(');
    expect(trial).not.toContain('rawElements');
  });

  it('the pipeline no longer imports the selectors the trial hand-rolled with', () => {
    expect(PIPELINE).not.toMatch(/^\s*getElementReferenceImagesForPage,/m);
    expect(PIPELINE).not.toMatch(/^\s*getElementReferenceImagesByIds,/m);
  });

  it('with the plate sent: the plate-borne boat is dropped, the cap is VB_SLOT_MAX_ELEMENTS, no landmark rides in the grid', async () => {
    gridCalls.length = 0;
    const sceneMetadata = extractSceneMetadata(trialHint(OBJECTS));
    // The hint's six objects (plus the setting's LOC, which never gets a cell).
    for (const o of OBJECTS) expect(sceneMetadata.objects.map(String).join(' ')).toContain(o.id);
    const { kept, visualBibleGrid } = await pageRender.buildPageVbGrid({ visualBible: VB, pageNumber: 2, sceneMetadata, hasPlate: true });
    const ids = kept.map((e: any) => e.id);
    expect(ids).not.toContain('VEH001');
    expect(ids.length).toBe(VB_SLOT_MAX_ELEMENTS);
    expect(ids).toEqual(['ART001', 'ART002', 'ART003', 'ART004']);
    expect(visualBibleGrid.rawElements.map((e: any) => e.id)).toEqual(ids);
    expect(gridCalls).toHaveLength(1);
    expect(gridCalls[0].landmarks).toEqual([]);
  });

  it('with no plate sent: the boat keeps its cell (never travels on nothing), still within the cap', async () => {
    const sceneMetadata = extractSceneMetadata(trialHint(OBJECTS));
    const { kept } = await pageRender.buildPageVbGrid({ visualBible: VB, pageNumber: 2, sceneMetadata, hasPlate: false });
    const ids = kept.map((e: any) => e.id);
    expect(ids.length).toBe(VB_SLOT_MAX_ELEMENTS);
    expect(ids).toContain('ART001');
    // Artifacts outrank vehicles in the bible's own priority order: the boat is
    // the first element the cap drops, exactly as on a production page.
    expect(ids).not.toContain('VEH001');
    const { kept: fewer } = await pageRender.buildPageVbGrid({
      visualBible: { ...VB, artifacts: VB.artifacts.slice(0, 2) }, pageNumber: 2, sceneMetadata, hasPlate: false,
    });
    expect(fewer.map((e: any) => e.id)).toEqual(['ART001', 'ART002', 'VEH001']);
  });

  it('an element the hint cites by id but the bible filed under another page is selected (the id fallback)', async () => {
    const vb = { ...VB, artifacts: [cell('ART001', 'brass lantern'), cell('ART009', 'silver key', { appearsInPages: [5] })], vehicles: [] };
    const sceneMetadata = extractSceneMetadata(trialHint([{ id: 'ART001', name: 'brass lantern' }, { id: 'ART009', name: 'silver key' }]));
    const { kept } = await pageRender.buildPageVbGrid({ visualBible: vb, pageNumber: 2, sceneMetadata, hasPlate: true });
    expect(kept.map((e: any) => e.id).sort()).toEqual(['ART001', 'ART009']);
  });

  it('a page with no hint objects and no page elements sends no grid', async () => {
    const sceneMetadata = extractSceneMetadata(trialHint([]));
    const vb = { ...VB, artifacts: [], vehicles: [] };
    const out = await pageRender.buildPageVbGrid({ visualBible: vb, pageNumber: 2, sceneMetadata, hasPlate: true });
    expect(out).toEqual({ kept: [], visualBibleGrid: null });
  });
});
