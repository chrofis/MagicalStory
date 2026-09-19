import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const { resolveWornItemsForPage, buildWornStateLines } = require_('../../server/lib/wornItems.js');
const { restoreUndeclaredRemovals } = require_('../../server/lib/sceneReviewGuard.js');

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
    expect(text).toContain('Draw it on Wearer.');
    // Commit 2193438b6: no off-page name reaches a prompt-facing string. An
    // owner named here invites the model to draw the character the page excludes.
    expect(text).not.toMatch(/Owner/);
  });

  it('the full two-name form is UNCHANGED when both are in the cast', () => {
    const out = resolveWornItemsForPage(VB, ['Owner', 'Wearer'], META(HANDOVER), { pageNumber: 17 });
    expect(out[0].ownerInCast).toBe(true);
    const text = buildWornStateLines(out).join('\n');
    expect(text).toContain('Wearer IS wearing this on this page, and Owner is NOT');
    expect(text).toContain('Draw it on Wearer only, and leave it off Owner even if the attached references show the opposite.');
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
    expect(line).toContain('Draw it on Owner even if the attached reference shows Owner without it.');
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

/**
 * `restoreUndeclaredRemovals` spliced blind, so a name the reviewed brief
 * already listed was appended a SECOND time — staging
 * job_1789759147125_p08djwhbl p17 shipped `characters: ["Julian","Julian"]`.
 * The parse failure that triggered it is fixed (b5443396a); the guard must not
 * depend on a parser succeeding upstream.
 */
describe('the cast restore guard is idempotent', () => {
  const brief = (cast: string[], prose: string) =>
    `${prose}\n---METADATA---\n${JSON.stringify({ characters: cast.map(name => ({ name })), objects: [] })}`;

  const run = (afterCastInBrief: string[], undeclared: string[]) => {
    const BEFORE = brief(['Julian', 'Mara'], 'Julian and Mara stand on the quay.');
    const AFTER = brief(afterCastInBrief, 'Two children stand on the quay.');
    const expansions = [{ pageNumber: 17, brief: AFTER, reviewRewrote: true }];
    const sceneDiffs = [{ pageNumber: 17, before: BEFORE, after: AFTER }];
    const changed = [17];
    const audit = [{ pageNumber: 17, lost: undeclared, rerouted: [], declared: [], undeclared }];
    const res = restoreUndeclaredRemovals(expansions, sceneDiffs, changed, audit);
    const meta = JSON.parse(String(expansions[0].brief).split('---METADATA---')[1]);
    return { ...res, cast: meta.characters.map((c: any) => c.name), changed, expansions };
  };

  it('does not append a name the reviewed brief already lists', () => {
    const r = run(['Julian'], ['Julian']);
    expect(r.cast).toEqual(['Julian']);
    expect(r.restored).toEqual([]);
    expect(r.reverted).toEqual([]);
    expect(r.changed).toEqual([17]);
  });

  it('still restores a name that is genuinely missing', () => {
    const r = run(['Julian'], ['Julian', 'Mara']);
    expect(r.cast).toEqual(['Julian', 'Mara']);
    expect(r.restored).toEqual([{ pageNumber: 17, names: ['Mara'] }]);
  });

  it('compares canonically, not by raw string equality', () => {
    const r = run(['julian'], ['Julian']);
    expect(r.cast).toEqual(['julian']);
    expect(r.restored).toEqual([]);
  });

  it('the whole-brief revert still stands when characters[] cannot be located', () => {
    const BEFORE = brief(['Julian', 'Mara'], 'Julian and Mara stand on the quay.');
    const AFTER = 'Two children stand on the quay. No metadata at all.';
    const expansions = [{ pageNumber: 17, brief: AFTER, reviewRewrote: true }];
    const sceneDiffs = [{ pageNumber: 17, before: BEFORE, after: AFTER }];
    const changed = [17];
    const audit = [{ pageNumber: 17, lost: ['Julian'], rerouted: [], declared: [], undeclared: ['Julian'] }];
    const { reverted } = restoreUndeclaredRemovals(expansions, sceneDiffs, changed, audit);
    expect(reverted).toEqual([{ pageNumber: 17, undeclared: ['Julian'] }]);
    expect(expansions[0].brief).toBe(BEFORE);
    expect(changed).toEqual([]);
  });
});
