/**
 * Structural parity between declared sibling paths.
 *
 * WHY THIS EXISTS — 2026-09-15. 27 of 173 behaviour commits in one 60-hour
 * window were partial fixes that reached one path and not its sibling. The
 * pre-push gate (scripts/admin/check-sibling-paths.js) catches the ones where a
 * COMMIT is one-sided; this catches drift that is already in the tree — a field
 * or rule that only ever existed on one side, which no diff will ever flag.
 *
 * The motivating case: `crowdExpected` was declared in the per-page Art Director
 * template's metadata schema and never in the all-pages one that the live beats
 * pipeline runs, so the guard that reads it saw false on every page.
 *
 * Data-driven from scripts/admin/sibling-registry.json — adding a set adds its
 * assertions here automatically. Nothing in this file names a specific rule.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.join(__dirname, '..', '..');
const registry = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'scripts/admin/sibling-registry.json'), 'utf8')
);

const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** A set declares either a flat `members` list or the two roles of a
 *  generator-vs-critic pair. Everything structural applies to the union. */
const membersOf = (set: any): string[] =>
  set.members || [...(set.generators || []), ...(set.critics || [])];


/**
 * Top-level keys of the JSON example that follows the last ---METADATA--- marker
 * in a prompt template. The example is illustrative JSON with placeholders and
 * HTML comments, so it is not parseable — keys are read positionally instead:
 * a line indented exactly two spaces that opens with a quoted key.
 */
function metadataKeys(text: string): string[] {
  const marker = text.lastIndexOf('---METADATA---');
  expect(marker, 'template declares a ---METADATA--- block').toBeGreaterThan(-1);
  const body = text.slice(marker);
  const keys: string[] = [];
  for (const line of body.split('\n')) {
    const m = /^ {2}"([A-Za-z][\w-]*)"\s*:/.exec(line);
    if (m) keys.push(m[1]);
  }
  return keys;
}

describe('sibling registry', () => {
  it('every declared member exists on disk', () => {
    const missing: string[] = [];
    for (const set of registry.sets) {
      for (const m of membersOf(set)) if (!fs.existsSync(path.join(ROOT, m))) missing.push(`${set.id}: ${m}`);
    }
    for (const w of registry.withinFile || []) {
      if (!fs.existsSync(path.join(ROOT, w.file))) missing.push(`${w.id}: ${w.file}`);
    }
    expect(missing, 'a stale member makes its set unenforceable').toEqual([]);
  });

  it('every set blocks — the warn tier was retired by the owner on 2026-09-15', () => {
    // A warn tier let a partial fix through leaving nothing written down. The
    // marker is the one escape now, and it always leaves a reason behind.
    const soft = [...registry.sets, ...(registry.withinFile || [])]
      .filter((s: any) => s.severity && s.severity !== 'block')
      .map((s: any) => `${s.id}: ${s.severity}`);
    expect(soft, 'set severity to "block" or omit the field').toEqual([]);
  });

  it('the pre-push escape marker is recognised only when it carries a reason', () => {
    // Mirrors MARKER in scripts/admin/check-sibling-paths.js.
    const MARKER = /^\s*Siblings-Checked:\s*\S/mi;
    expect(MARKER.test('fix(x): thing\n\nSiblings-Checked: the trial path has no such stage')).toBe(true);
    expect(MARKER.test('fix(x): thing\n\nSiblings-Checked:')).toBe(false);
    expect(MARKER.test('fix(x): thing\n\nchecked the siblings, honest')).toBe(false);
  });
});

for (const set of registry.sets) {
  const parity = set.parity;
  if (!parity) continue;

  describe(`sibling parity: ${set.id} (${set.axis})`, () => {
    if (parity.metadataKeys) {
      it('every member declares the same metadata schema keys', () => {
        const byMember = membersOf(set).map((m: string) => ({ m, keys: metadataKeys(read(m)) }));
        const union = new Set<string>(byMember.flatMap((e: any) => e.keys));
        const gaps: string[] = [];
        for (const { m, keys } of byMember) {
          const have = new Set(keys);
          for (const k of union) {
            if (!have.has(k)) gaps.push(`${m} is missing "${k}" — omission reads as absent/false at runtime`);
          }
        }
        expect(gaps, set.reason).toEqual([]);
      });
    }

    if (Array.isArray(parity.anchors) && parity.anchors.length) {
      it('every member contains each declared rule anchor', () => {
        const gaps: string[] = [];
        for (const m of membersOf(set)) {
          const text = read(m);
          for (const a of parity.anchors) if (!text.includes(a)) gaps.push(`${m} is missing the anchor: ${a}`);
        }
        expect(gaps, set.reason).toEqual([]);
      });
    }
  });
}

for (const w of registry.withinFile || []) {
  describe(`sibling parity: ${w.id} (${w.axis})`, () => {
    it(`every sibling block in ${w.file} contains "${w.mustContain}"`, () => {
      const text = read(w.file);
      const re = new RegExp(w.blockPattern, 'g');
      const starts: Array<{ name: string; at: number }> = [];
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) starts.push({ name: m[1] || m[0], at: m.index });
      expect(starts.length, 'blockPattern matched nothing — the pattern has gone stale').toBeGreaterThan(1);

      const exclude = new Set<string>(w.exclude || []);
      const gaps: string[] = [];
      starts.forEach((s, i) => {
        if (exclude.has(s.name)) return;
        const body = text.slice(s.at, i + 1 < starts.length ? starts[i + 1].at : text.length);
        if (!body.includes(w.mustContain)) gaps.push(`${s.name} does not contain "${w.mustContain}"`);
      });
      expect(gaps, w.reason).toEqual([]);
    });
  });
}
