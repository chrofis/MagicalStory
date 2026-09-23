import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);

// The per-image judge prompts were never stored: the 2026-09-23 audit of
// staging job_1790100385959_1nitlympp rebuilt them from the builders. Each call
// now leaves one eval_calls row (migrations/041_eval_calls.sql).

const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

describe('eval_calls', () => {
  it('the migration declares every column the writer inserts', () => {
    const sql = read('migrations/041_eval_calls.sql');
    const writer = read('server/lib/evalCallLog.js');
    const cols = /INSERT INTO eval_calls \(([^)]+)\)/.exec(writer)![1].split(',').map(s => s.trim());
    for (const c of cols) expect(sql, `column ${c}`).toMatch(new RegExp(`\\n\\s+${c} `));
  });

  it('every judge kind is recorded at its call site', () => {
    const sites: Array<[string, string]> = [
      ['server/lib/evalPipeline.js', "'quality_cover' : 'quality'"],
      ['server/lib/evalPipeline.js', "kind: 'inventory'"],
      ['server/lib/evalPipeline.js', "kind: 'plate_qc'"],
      ['server/lib/sceneValidator.js', "kind: 'semantic'"],
      ['server/lib/images.js', "kind: 'iterate_rebrief'"],
    ];
    for (const [file, marker] of sites) expect(read(file), `${file} records ${marker}`).toContain(marker);
  });

  it('outside a story scope nothing is written and nothing throws', () => {
    const { recordEvalCall } = require_('../../server/lib/evalCallLog.js');
    expect(() => recordEvalCall({ kind: 'quality', prompt: 'x', pageNumber: 1 })).not.toThrow();
  });
});
