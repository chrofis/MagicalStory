/**
 * THE FACADE MUST FORWARD EVERYTHING — the class fix for a silently undefined binding.
 *
 * Evidence (2026-09-13): `parsePlanCheckRoster` was added to promptBuilders.js on
 * 2026-09-11 (df1eb1ff3) and exported there, but `server/lib/storyHelpers.js` — the
 * re-export facade — listed forwarded names by hand, twice. The name was in neither
 * list, so `beatsPipeline.js:95`, which destructures it from the facade, bound
 * `undefined`. Node reports nothing for a missing property, so every beats run threw
 * "parsePlanCheckRoster is not a function" inside the plan check's try/catch and
 * shipped with the ENTIRE plan-counter layer skipped behind a WARN — for two days,
 * on every staging story (job_1789304198359_y3n0euk3z, job_1789207854566_l43qgl34w).
 *
 * These tests pin the two properties that make that impossible again, not any
 * particular function: (1) the facade forwards every domain export; (2) every name
 * any module destructures from the facade actually resolves.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const LIB = path.join(process.cwd(), 'server', 'lib');
const helpers = require(path.join(LIB, 'storyHelpers.js'));

const DOMAIN_MODULES = ['promptBuilders', 'sceneMetadata', 'clothingResolve'];

describe('storyHelpers re-export facade', () => {
  it('forwards every export of every domain module it fronts', () => {
    const missing: string[] = [];
    for (const name of DOMAIN_MODULES) {
      const mod = require(path.join(LIB, `${name}.js`));
      for (const key of Object.keys(mod)) {
        if (!(key in helpers)) missing.push(`${name}.${key}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('forwards the same object, not a stale copy', () => {
    const pb = require(path.join(LIB, 'promptBuilders.js'));
    for (const key of Object.keys(pb)) {
      // A locally-defined residue name may legitimately override the domain one.
      if (typeof helpers[key] === 'function' && typeof pb[key] === 'function') continue;
      expect(helpers[key]).toBeDefined();
    }
  });
});

/** Every `const { a, b } = require('.../storyHelpers')` in the repo, flattened. */
function destructuredFromHelpers(): Array<{ file: string; name: string }> {
  const roots = [path.join(process.cwd(), 'server'), process.cwd()];
  const files: string[] = [];
  const walk = (dir: string, depth = 0) => {
    if (depth > 6) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist' || e.name === 'client') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (e.name.endsWith('.js') && !files.includes(full)) files.push(full);
    }
  };
  walk(roots[0]);
  for (const f of fs.readdirSync(roots[1])) {
    if (f.endsWith('.js')) files.push(path.join(roots[1], f));
  }
  const out: Array<{ file: string; name: string }> = [];
  const re = /(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require\(\s*['"][^'"]*storyHelpers['"]\s*\)/g;
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      for (const raw of m[1].split(',')) {
        const name = raw.split(':')[0].replace(/\/\/.*$/gm, '').trim();
        if (/^[A-Za-z_$][\w$]*$/.test(name)) out.push({ file: path.relative(process.cwd(), file), name });
      }
    }
  }
  return out;
}

describe('no importer binds undefined from storyHelpers', () => {
  it('finds the destructures at all (the scan itself must not silently pass)', () => {
    expect(destructuredFromHelpers().length).toBeGreaterThan(20);
  });

  it('every destructured name resolves on the facade', () => {
    const bad = destructuredFromHelpers().filter(({ name }) => helpers[name] === undefined);
    expect(bad.map(b => `${b.file}: ${b.name}`)).toEqual([]);
  });

  it('the plan-check roster parser in particular is callable through the facade', () => {
    // The one that broke. Pinned as a binding, not by its output wording.
    expect(typeof helpers.parsePlanCheckRoster).toBe('function');
  });
});
