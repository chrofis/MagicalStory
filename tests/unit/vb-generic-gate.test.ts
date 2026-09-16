/**
 * The generic-vs-specific gate (phase 2 of tasks/vb-scale-class-plan-2026-09-15.md).
 *
 * An everyday instance of a thing must not buy a Visual Bible id, an entry, a
 * paid reference render or one of the page's four reference cells. The gate is
 * an AUTHORED `generic: true` that the parser DROPS — not an instruction to
 * omit the entry, because an omitted entry is indistinguishable from a
 * forgotten one and leaves nothing to audit.
 *
 * What is pinned here is the DROP and its blast radius: no id, no collection
 * entry, no reference-sheet batch, no element-budget row, and a page that cites
 * one is stripped loudly rather than handed a cell. And the control that makes
 * the whole file meaningful: an entry WITHOUT `generic` behaves exactly as it
 * did before this gate existed.
 */
import { describe, it, expect, vi } from 'vitest';

// @ts-ignore - CommonJS
const VB = require('../../server/lib/visualBible');
// @ts-ignore - CommonJS
const { rankPageElements } = require('../../server/lib/vbElementBudget');
// @ts-ignore - CommonJS
const { log } = require('../../server/utils/logger');

const { parseVisualBible, getElementReferenceImagesForPage, getElementsNeedingReferenceImages } = VB;

const NL = String.fromCharCode(10);
const bible = (data: any) => ['---VISUAL BIBLE---', '```json', JSON.stringify(data), '```'].join(NL);

const CUP = {
  id: 'ART002', label: 'tin cup', name: 'tin cup', pages: [1, 2], type: 'tableware',
  size: 'fits in one hand', scaleClass: 'hand', generic: true,
  description: 'a plain dented tin cup'
};
const LANTERN = {
  id: 'ART001', label: 'brass lantern', name: 'brass lantern', pages: [1, 2], type: 'lamp',
  size: 'spans a forearm', scaleClass: 'arm',
  description: 'a dented brass lantern with a cracked green pane'
};

const withRef = (e: any) => ({ ...e, referenceImageGenerated: true, referenceImageData: 'data:image/png;base64,AAA' });

describe('generic gate — the entry is dropped, not hidden', () => {
  it('keeps a generic entry out of artifacts[] and gives it no id', () => {
    const vb = parseVisualBible(bible({ artifacts: [LANTERN, CUP] }));
    expect(vb.artifacts.map((a: any) => a.id)).toEqual(['ART001']);
    expect(vb.genericObjects).toHaveLength(1);
    expect(vb.genericObjects[0].id).toBeUndefined();
    expect(vb.genericObjects[0].name).toBe('tin cup');
    expect(vb.genericObjects[0].collection).toBe('artifacts');
    // the drop is auditable: what was given up is still written down
    expect(vb.genericObjects[0].description).toContain('dented tin cup');
    expect(vb.genericObjects[0].scaleClass).toBe('hand-sized'); // stored 'hand', the legacy alias
  });

  it('applies to animals and vehicles on the same terms', () => {
    const vb = parseVisualBible(bible({
      animals: [{ id: 'ANI001', name: 'street pigeon', pages: [1], species: 'pigeon', scaleClass: 'hand', generic: true }],
      vehicles: [{ id: 'VEH001', name: 'hay cart', pages: [1], colorAndDetails: 'a cart', signatureElement: 'a wheel', scaleClass: 'vehicle', generic: true }],
    }));
    expect(vb.animals).toEqual([]);
    expect(vb.vehicles).toEqual([]);
    expect(vb.genericObjects.map((g: any) => g.collection).sort()).toEqual(['animals', 'vehicles']);
  });

  it('never buys a paid reference render', () => {
    const vb = parseVisualBible(bible({ artifacts: [LANTERN, CUP] }));
    const needing = getElementsNeedingReferenceImages(vb).map((e: any) => e.id);
    expect(needing).toContain('ART001');
    expect(needing).not.toContain('ART002');
  });

  it('never counts against the per-page element budget', () => {
    const vb = parseVisualBible(bible({ artifacts: [LANTERN, CUP] }));
    const rows = rankPageElements(1, { objects: ['ART001', 'ART002'] }, vb);
    expect(rows.map((r: any) => r.id)).toEqual(['ART001']);
  });
});

describe('generic gate — a page that cites one is stripped, loudly', () => {
  it('logs an error and hands out no cell for the cited generic object', () => {
    const vb = parseVisualBible(bible({ artifacts: [LANTERN, CUP] }));
    vb.artifacts[0] = withRef(vb.artifacts[0]);
    const spy = vi.spyOn(log, 'error').mockImplementation(() => {});
    try {
      const refs = getElementReferenceImagesForPage(vb, 1, 4, ['ART001', 'tin cup']);
      expect(refs.map((r: any) => r.id)).toEqual(['ART001']);
      const said = spy.mock.calls.map(c => String(c[0])).join(NL);
      expect(said).toContain('GENERIC');
      expect(said).toContain('tin cup');
    } finally {
      spy.mockRestore();
    }
  });

  it('says nothing at all when no generic object is cited', () => {
    const vb = parseVisualBible(bible({ artifacts: [LANTERN, CUP] }));
    vb.artifacts[0] = withRef(vb.artifacts[0]);
    const spy = vi.spyOn(log, 'error').mockImplementation(() => {});
    try {
      getElementReferenceImagesForPage(vb, 1, 4, ['ART001']);
      const said = spy.mock.calls.map(c => String(c[0])).join(NL);
      expect(said).not.toContain('GENERIC');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('generic gate — the control: absent behaves exactly as before', () => {
  it('an entry with no `generic` key keeps its id, its entry and its cell', () => {
    const vb = parseVisualBible(bible({ artifacts: [LANTERN, { ...CUP, generic: undefined }] }));
    expect(vb.artifacts.map((a: any) => a.id)).toEqual(['ART001', 'ART002']);
    expect(vb.genericObjects).toEqual([]);
    vb.artifacts = vb.artifacts.map(withRef);
    const refs = getElementReferenceImagesForPage(vb, 1, 4, ['ART001', 'ART002']);
    expect(refs.map((r: any) => r.id).sort()).toEqual(['ART001', 'ART002']);
  });

  it('`generic: false` is not the gate — only an explicit true drops an entry', () => {
    const vb = parseVisualBible(bible({ artifacts: [{ ...CUP, generic: false }] }));
    expect(vb.artifacts).toHaveLength(1);
    expect(vb.genericObjects).toEqual([]);
  });
});
