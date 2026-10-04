import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const { resolveWornItemsForPage, buildWornStateLines, buildWornStateBlock, WORN_ITEMS_HEADER } = require_('../../server/lib/wornItems.js');

/**
 * THE CAST GATE TESTS THE PERSON THE ROW CHANGES, NOT ONLY THE OWNER.
 *
 * `wearer` shipped 2026-09-15 (c3e92e2f0): the schema, the prompt line,
 * `applyWornItemsToOutfit`'s swap and `resolveWearer` all support a garment
 * worn by someone other than its owner. The gate did not — it kept a row only
 * when the OWNER was in the page cast, so a handover whose owner is off-page
 * was discarded before the resolver ever saw it and the page shipped with no
 * WORN ITEMS block at all.
 *
 * Measured on staging (read-only pulls): `job_1789759147125_p08djwhbl` p17 and
 * p9, and `job_1789348171785_9oxos7dwv` p10, all resolved to `[]`.
 *
 * Shapes below are the p17 shape with archetypal names.
 */
const JACKET = {
  id: 'CLO002', name: 'moss-green corduroy jacket', type: 'outerwear',
  wornAs: 'Owner.outerwear',
  description: 'A moss-green corduroy jacket with brass buttons.',
};
const VB = { clothing: [JACKET], artifacts: [], locations: [] };

const META = (rows: any[]) => ({ pageNumber: 17, wornItems: rows, characters: [], objects: ['CLO002'] });
const HANDOVER = [{ id: 'CLO002', owner: 'Owner', state: 'worn', wearer: 'Wearer' }];

afterEach(() => { vi.restoreAllMocks(); });

describe('a handover whose OWNER is off-page still resolves', () => {
  it('resolves the row on the wearer alone (the p17 regression)', () => {
    const out = resolveWornItemsForPage(VB, ['Wearer'], META(HANDOVER), { pageNumber: 17 });
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('CLO002');
    expect(out[0].wearer).toBe('Wearer');
    expect(out[0].handedOver).toBe(true);
    expect(out[0].state).toBe('worn');
    expect(out[0].ownerInCast).toBe(false);
  });

  it('the built line names the WEARER and never the absent owner', () => {
    const out = resolveWornItemsForPage(VB, ['Wearer'], META(HANDOVER), { pageNumber: 17 });
    const text = buildWornStateLines(out).join('\n');
    expect(text).toContain('Wearer IS wearing this on this page');
    expect(text).toMatch(/^- Wearer IS wearing this on this page: .+\.$/m);
    // Commit 2193438b6: no off-page name reaches a prompt-facing string. An
    // owner named here invites the model to draw the character the page excludes.
    expect(text).not.toMatch(/Owner/);
  });

  it('the full two-name form is UNCHANGED when both are in the cast', () => {
    const out = resolveWornItemsForPage(VB, ['Owner', 'Wearer'], META(HANDOVER), { pageNumber: 17 });
    expect(out[0].ownerInCast).toBe(true);
    const text = buildWornStateLines(out).join('\n');
    expect(text).toContain('Wearer IS wearing this on this page, and Owner is NOT');
    // The override against the references is said once, by the block header (2026-09-27).
    expect(buildWornStateBlock(out)).toContain(WORN_ITEMS_HEADER);
  });

  it('drops the row LOUDLY when neither owner nor wearer is on the page', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = resolveWornItemsForPage(VB, ['Someone Else'], META(HANDOVER), { pageNumber: 17 });
    expect(out).toEqual([]);
    const said = warn.mock.calls.map((c: any[]) => c.join(' ')).join('\n');
    expect(said).toMatch(/CLO002/);
    expect(said).toMatch(/handover/i);
  });
});

describe('ordinary non-handover rows are untouched', () => {
  const PLAIN = [{ id: 'CLO002', owner: 'Owner', state: 'worn' }];

  it('owner in cast: the affirmative owner line, exactly as before', () => {
    const out = resolveWornItemsForPage(VB, ['Owner'], META(PLAIN), { pageNumber: 17 });
    expect(out).toHaveLength(1);
    expect(out[0].handedOver).toBe(false);
    const line = buildWornStateLines(out).join('\n');
    expect(line.startsWith('- Owner IS wearing this on this page: moss-green corduroy jacket')).toBe(true);
    expect(buildWornStateBlock(out)).toContain(WORN_ITEMS_HEADER);
  });

  it('owner absent and no wearer named: dropped, and SILENTLY — that is every page of every story', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveWornItemsForPage(VB, ['Someone Else'], META(PLAIN), { pageNumber: 17 })).toEqual([]);
    expect(warn.mock.calls.map((c: any[]) => c.join(' ')).join('\n')).not.toMatch(/CLO002/);
  });

  it('a wearer that merely re-states the owner is not a handover', () => {
    const out = resolveWornItemsForPage(
      VB, ['Owner'], META([{ id: 'CLO002', owner: 'Owner', state: 'worn', wearer: 'owner' }]), { pageNumber: 17 },
    );
    expect(out[0].handedOver).toBe(false);
    expect(buildWornStateLines(out).join('\n')).toContain('Owner IS wearing this on this page:');
  });
});
