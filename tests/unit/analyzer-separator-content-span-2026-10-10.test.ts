/**
 * photo_analyzer.py _detect_separators: the row divider is searched inside the painted content, never in the blank band above the
 * heads (stored costumed sheet of staging trial 6912628b: the old search returned y=174 of 1024; the seam is at ~450).
 * Runs the real Python function (extracted by ast, numpy + OpenCV only); skipped where Python or those packages are missing.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import path from 'path';

const root = path.resolve(__dirname, '../..');
const script = `
import ast, sys, numpy as np, cv2
src = open(sys.argv[1], encoding='utf-8').read()
fns = [n for n in ast.parse(src).body if isinstance(n, ast.FunctionDef) and n.name in ('_content_row_span', '_detect_separators')]
ns = {'np': np}; exec(compile(ast.Module(fns, []), 'x', 'exec'), ns)
g = cv2.cvtColor(cv2.imdecode(np.fromfile(sys.argv[2], np.uint8), cv2.IMREAD_COLOR), cv2.COLOR_BGR2GRAY)
print(ns['_detect_separators'](g, 'horizontal', 1)[0])
`;
const probe = spawnSync('python', ['-I', '-c', 'import numpy, cv2'], { encoding: 'utf8' });
const haveCv = probe.status === 0;

describe.skipIf(!haveCv)('_detect_separators horizontal', () => {
  it('puts the row divider between the head row and the body row of a sheet with a tall blank band above the heads', () => {
    const r = spawnSync('python', ['-I', '-c', script, path.join(root, 'photo_analyzer.py'), path.join(root, 'tests/unit/fixtures/costumed-sheet-blank-headroom-2026-10-10.jpg')], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    const y = Number(r.stdout.trim());
    // fixture is 512 px tall: heads span ~110-220, bodies ~240-500; the old search answered 87 (the blank band)
    expect(y).toBeGreaterThan(200);
    expect(y).toBeLessThan(250);
  });
});
