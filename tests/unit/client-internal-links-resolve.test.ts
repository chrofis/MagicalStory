import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// Every internal path literal in the client (to="/x", href="/x", navigate('/x'), to={`/x/${id}`},
// `{ to: '/x' }` link tables) must resolve to a <Route path> in App.tsx. Found 2026-10-07: the
// occasion page's breadcrumb and its not-found redirect pointed at /anlaesse while the route is
// /anlass, so every occasion page carried a dead hub link. This scans client/src (pages, components,
// constants) so the next renamed route cannot leave a literal behind.
const ROOT = path.resolve(__dirname, '../..');
const CLIENT_SRC = path.join(ROOT, 'client', 'src');

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

function routePatterns(): RegExp[] {
  const app = fs.readFileSync(path.join(CLIENT_SRC, 'App.tsx'), 'utf-8');
  const out: RegExp[] = [];
  for (const m of app.matchAll(/<Route\s+path="([^"]+)"/g)) {
    const p = m[1];
    if (p === '*') continue;
    // `/create/*` also matches `/create` itself (react-router splat semantics).
    const re = p
      .split('/')
      .map((seg) => {
        if (seg === '*') return '(.*)?';
        if (seg.startsWith(':')) return '[^/]+';
        return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      })
      .join('/')
      .replace(/\/\(\.\*\)\?$/, '(/.*)?');
    out.push(new RegExp(`^${re}$`));
  }
  return out;
}

// Internal path literals: to="/x", href="/x", to={`/x/${id}`}, to={lp('/x')} (the useLangPath
// helper), { to: '/x' } link tables and navigate('/x'). Template-literal segments (`${id}`) are
// treated as one dynamic segment. Query strings and hashes are stripped: they are not part of the route.
const LITERAL_RE = /(?:\bto|\bhref)\s*[:=]\s*\{?\s*(?:lp\()?\s*(['"`])(\/[^'"`\s]*)\1|navigate\(\s*(?:lp\()?\s*(['"`])(\/[^'"`\s]*)\3/g;

function pathLiterals(file: string): string[] {
  const src = fs.readFileSync(file, 'utf-8');
  const out: string[] = [];
  for (const m of src.matchAll(LITERAL_RE)) {
    const raw = m[2] ?? m[4];
    if (!raw) continue;
    const noQuery = raw.split(/[?#]/)[0];
    // A placeholder glued to the end of a path (`/try${suffix}`, `/create${qs}`) carries the
    // ?lang= / query suffix, not a segment: drop it. Every other `${expr}` is one dynamic segment.
    const normalised = noQuery
      .replace(/(?<=[^/])\$\{[^}]*\}$/, '')
      .replace(/\$\{[^}]*\}/g, '__dyn__');
    out.push(normalised);
  }
  return out;
}

describe('client internal links resolve to App.tsx routes', () => {
  const routes = routePatterns();
  const files = walk(CLIENT_SRC);
  const literals = new Map<string, string[]>(); // literal → files

  for (const f of files) {
    for (const lit of pathLiterals(f)) {
      // Static asset paths (fonts, images) are served by express, not the router.
      if (/^\/(images|fonts|assets|api)\//.test(lit)) continue;
      const list = literals.get(lit) || [];
      list.push(path.relative(ROOT, f));
      literals.set(lit, list);
    }
  }

  it('finds the known link literals (regex sanity)', () => {
    expect(routes.length).toBeGreaterThan(20);
    expect(literals.has('/anlass')).toBe(true);
    expect(literals.has('/stadt/__dyn__')).toBe(true);
    expect(literals.has('/try')).toBe(true);
  });

  it('every literal matches a route', () => {
    const dead: string[] = [];
    for (const [lit, where] of literals) {
      const target = lit.replace(/__dyn__/g, 'x');
      if (!routes.some((re) => re.test(target))) dead.push(`${lit} (${[...new Set(where)].join(', ')})`);
    }
    expect(dead).toEqual([]);
  });

  it('the occasion hub is linked as /anlass, never /anlaesse', () => {
    expect(literals.has('/anlaesse')).toBe(false);
    const occ = fs.readFileSync(path.join(CLIENT_SRC, 'pages', 'OccasionPage.tsx'), 'utf-8');
    expect(occ).not.toContain('/anlaesse');
    expect(occ).toContain("lp('/anlass')");
  });
});
