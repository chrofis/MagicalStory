import { describe, it, expect } from 'vitest';

// The defect this file locks down (de-ch job_1789301291267_ueh8h145m):
//
// Two different artifacts both declared `type: "tool"`, so the REQUIRED
// OBJECTS block of the page prompt read `**tool** (object)` twice and the
// image model had no handle to tell the two props apart. VB ids never reach an
// image model, so the label IS the handle.
//
// These tests pin BEHAVIOUR — which label a consumer gets, which fault code a
// bible earns, and that a repair pass is deterministic and never makes things
// worse. They never pin prompt wording.

// @ts-expect-error - JS module without types
import {
  labelOf,
  stateLabelOf,
  validateLabels,
  repairLabels,
  isEnglishLabel,
  poolOf,
  BARE_CATEGORIES,
  LABEL_CODES,
  GENERIC_NOUN,
} from '../../server/lib/vbLabel.js';

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

const TELESCOPE = {
  id: 'ART001',
  name: 'Fernrohr',
  type: 'tool',
  label: 'tool',
  description: 'A brass telescope with a scratched barrel',
};
const CROWBAR = {
  id: 'ART002',
  name: 'Brecheisen',
  type: 'tool',
  label: 'tool',
  description: 'A rusted iron crowbar bent at one end',
};

describe('labelOf', () => {
  it('prefers the authored label over every other identity field', () => {
    expect(labelOf({ id: 'ART005', label: 'copper kettle', type: 'tool', name: 'Kessel' }))
      .toBe('copper kettle');
  });

  it('strips a trailing orientation parenthetical (the builder re-adds it)', () => {
    expect(labelOf({ id: 'ART005', label: 'copper kettle (side view)' })).toBe('copper kettle');
  });

  it('ignores an authored label that is a raw VB id', () => {
    expect(labelOf({ id: 'ART005', label: 'ART005', type: 'copper kettle' })).toBe('copper kettle');
  });

  describe('backfill for bibles stored before labels existed', () => {
    it('uses a short English type when it names the thing', () => {
      expect(labelOf({ id: 'ART001', type: 'brass telescope', description: 'A brass telescope' }))
        .toBe('brass telescope');
    });

    it('rejects a bare-category type and falls to a description clause', () => {
      expect(labelOf(CROWBAR_NO_LABEL)).toBe('rusted iron crowbar bent');
    });

    it('rejects a non-English type and falls to a description clause', () => {
      expect(labelOf({ id: 'ART003', type: 'roter Umhang für Kinder', description: 'A red felt cloak with a hood' }))
        .toBe('red felt cloak');
    });

    it('falls to the pool-generic noun when nothing is usable', () => {
      expect(labelOf({ id: 'ART004' })).toBe('object');
      expect(labelOf({ id: 'VEH004' })).toBe('vehicle');
      expect(labelOf({ id: 'CLO004' })).toBe('outfit');
    });

    it('labels a secondary character and an animal by name', () => {
      expect(labelOf({ id: 'CHR001', name: 'Frau Meier' })).toBe('Frau Meier');
      expect(labelOf({ id: 'ANI001', name: 'Bruno', type: 'dog' })).toBe('Bruno');
    });

    it('labels a real landmark by name and an invented location by its features', () => {
      expect(labelOf({ id: 'LOC001', name: 'Chapel Bridge', isRealLandmark: true, features: 'covered wooden bridge' }))
        .toBe('Chapel Bridge');
      expect(labelOf({ id: 'LOC002', name: 'Waldhütte', features: 'timber cabin with a mossy roof, deep in pines' }))
        .toBe('timber cabin');
    });
  });

  it('never returns an empty string and never returns a raw id', () => {
    for (const entry of [null, undefined, {}, { id: 'ART009', label: '   ' }, { id: 'LOC009', name: '' }]) {
      const out = labelOf(entry as any);
      expect(out.length).toBeGreaterThan(0);
      expect(out).not.toMatch(/(CHR|ANI|ART|LOC|VEH|CLO)\d+/);
    }
  });

  it('poolOf reads the id prefix, dotted facets included', () => {
    expect(poolOf('ART001.2')).toBe('ART');
    expect(poolOf({ id: 'loc005' })).toBe('LOC');
    expect(poolOf('nonsense')).toBe(null);
    expect(Object.keys(GENERIC_NOUN).sort()).toEqual(['ANI', 'ART', 'CHR', 'CLO', 'LOC', 'VEH']);
  });
});

const CROWBAR_NO_LABEL = { id: 'ART002', type: 'tool', description: 'A rusted iron crowbar bent at one end' };

describe('isEnglishLabel', () => {
  it('accepts ASCII letters, digits, apostrophe, hyphen and space', () => {
    expect(isEnglishLabel("children's knitted hat")).toBe(true);
    expect(isEnglishLabel('half-open crate 2')).toBe(true);
  });
  it('rejects non-ASCII letters and a leading separator', () => {
    expect(isEnglishLabel('Waldhütte')).toBe(false);
    expect(isEnglishLabel('-hat')).toBe(false);
    expect(isEnglishLabel('')).toBe(false);
  });
});

describe('stateLabelOf', () => {
  it('appends the state name, and omits it when the state has none', () => {
    const crate = { id: 'ART006', label: 'wooden crate' };
    expect(stateLabelOf(crate, { name: 'lid open' })).toBe('wooden crate, lid open');
    expect(stateLabelOf(crate, {})).toBe('wooden crate');
    expect(stateLabelOf(crate, null)).toBe('wooden crate');
  });
});

const bibleWith = (artifacts: any[], extra: any = {}) => ({ artifacts, ...extra });

describe('validateLabels emits one code per fault', () => {
  const cases: Array<[string, any]> = [
    ['label_missing', { id: 'ART001', description: 'A brass telescope' }],
    ['label_not_english', { id: 'ART001', label: 'Waldhütte' }],
    ['label_too_long', { id: 'ART001', label: 'small brass folding pocket telescope' }],
    ['label_bare_category', { id: 'ART001', label: 'tool' }],
    ['label_proper_noun', { id: 'ART001', label: 'Excalibur', properName: 'Excalibur' }],
    ['label_contains_id', { id: 'ART001', label: 'ART007' }],
  ];

  for (const [code, entry] of cases) {
    it(`flags ${code}`, () => {
      const findings = validateLabels(bibleWith([entry]));
      expect(findings.map((f: any) => f.code)).toEqual([code]);
      expect(findings[0].id).toBe('ART001');
      expect(findings[0].pool).toBe('ART');
      expect(findings[0].detail).toBeTruthy();
    });
  }

  it('flags label_duplicate on both rivals', () => {
    const findings = validateLabels(bibleWith([clone(TELESCOPE), clone(CROWBAR)]));
    const dupes = findings.filter((f: any) => f.code === 'label_duplicate');
    expect(dupes.map((f: any) => f.id)).toEqual(['ART001', 'ART002']);
    expect(dupes[0].detail).toContain('ART002');
    expect(dupes[1].detail).toContain('ART001');
  });

  it('exempts characters, animals and real landmarks from every code but duplicate', () => {
    const vb = {
      secondaryCharacters: [{ id: 'CHR001', name: 'Frau Meier' }],
      animals: [{ id: 'ANI001', name: 'Bruno' }],
      locations: [{ id: 'LOC001', name: 'Kapellbrücke', isRealLandmark: true }],
    };
    expect(validateLabels(vb)).toEqual([]);
  });

  it('flags a cross-pool collision between an animal name and an artifact label', () => {
    const vb = {
      animals: [{ id: 'ANI001', name: 'Bruno' }],
      artifacts: [{ id: 'ART001', label: 'Bruno' }],
    };
    const findings = validateLabels(vb);
    expect(findings.every((f: any) => f.code === 'label_duplicate')).toBe(true);
    expect(findings.map((f: any) => f.id).sort()).toEqual(['ANI001', 'ART001']);
  });

  it('returns findings in pool, entry and code order', () => {
    expect(LABEL_CODES[0]).toBe('label_missing');
    expect(BARE_CATEGORIES.has('tool')).toBe(true);
    const vb = {
      artifacts: [{ id: 'ART001', label: 'tool' }, { id: 'ART002', label: 'tool' }],
    };
    const findings = validateLabels(vb);
    expect(findings.map((f: any) => `${f.id}:${f.code}`)).toEqual([
      'ART001:label_bare_category',
      'ART001:label_duplicate',
      'ART002:label_bare_category',
      'ART002:label_duplicate',
    ]);
  });
});

describe('repairLabels', () => {
  it('breaks the telescope/crowbar "tool" collision into two distinct English labels', () => {
    const vb = bibleWith([clone(TELESCOPE), clone(CROWBAR)]);
    const { repaired, unresolved } = repairLabels(vb, validateLabels(vb));

    const labels = vb.artifacts.map((a: any) => a.label);
    expect(labels[0]).toMatch(/telescope/i);
    expect(labels[1]).toMatch(/crowbar/i);
    expect(labels[0].toLowerCase()).not.toBe(labels[1].toLowerCase());
    expect(vb.artifacts.every((a: any) => a.labelRepaired === 'label_bare_category')).toBe(true);
    expect(repaired.map((r: any) => r.id)).toEqual(['ART001', 'ART002']);
    expect(unresolved).toEqual([]);
  });

  it('never introduces a new finding', () => {
    const vb = bibleWith([clone(TELESCOPE), clone(CROWBAR)]);
    repairLabels(vb, validateLabels(vb));
    expect(validateLabels(vb)).toEqual([]);
  });

  it('reports a pathological identical pair instead of shipping an empty label', () => {
    const same = 'A tool';
    const vb = bibleWith([
      { id: 'ART001', type: 'tool', label: 'tool', description: same },
      { id: 'ART002', type: 'tool', label: 'tool', description: same },
    ]);
    const { unresolved } = repairLabels(vb, validateLabels(vb));

    expect(unresolved.length).toBeGreaterThan(0);
    const labels = vb.artifacts.map((a: any) => a.label);
    expect(labels.some((l: string) => / 2$/.test(l))).toBe(true);
    for (const l of labels) expect(l).not.toBe('');
    expect(new Set(labels.map((l: string) => l.toLowerCase())).size).toBe(2);
  });

  it('leaves exempt pools alone', () => {
    const vb = {
      animals: [{ id: 'ANI001', name: 'Bruno' }],
      artifacts: [{ id: 'ART001', label: 'Bruno', description: 'A carved wooden bear figurine' }],
    };
    repairLabels(vb, validateLabels(vb));
    expect(vb.animals[0].label).toBeUndefined();
    expect(vb.artifacts[0].label.toLowerCase()).not.toBe('bruno');
  });

  it('never throws on junk input', () => {
    expect(() => repairLabels(null as any)).not.toThrow();
    expect(repairLabels({} as any)).toEqual({ repaired: [], unresolved: [] });
    expect(validateLabels(null as any)).toEqual([]);
  });

  it('is deterministic: the same input twice produces deep-equal output', () => {
    const input = bibleWith([clone(TELESCOPE), clone(CROWBAR), { id: 'ART003', label: 'Waldhütte' }]);
    const a = clone(input);
    const b = clone(input);
    const ra = repairLabels(a, validateLabels(a));
    const rb = repairLabels(b, validateLabels(b));
    expect(ra).toEqual(rb);
    expect(a).toEqual(b);
  });
});
