/**
 * client/vite.config.ts manualChunks: which node_modules code lands in the entry
 * graph of every page. The catch-all puts every React-adjacent library into one
 * vendor-react chunk (a React 19 cycle guard, see the config), so a library only
 * leaves the entry graph when a rule above the catch-all names it. These checks
 * keep the page-specific libraries out of vendor-react (2026-10-07: FingerprintJS
 * and react-pageflip/page-flip cost every page ~40 kB gzipped it never ran) and
 * keep the cycle guard intact for the libraries that call React at module init.
 */
import { describe, it, expect } from 'vitest';
import viteConfig from '../../client/vite.config';

type ManualChunks = (id: string) => string | undefined;

function manualChunks(): ManualChunks {
  const resolved = typeof viteConfig === 'function'
    ? viteConfig({ command: 'build', mode: 'production', isSsrBuild: false, isPreview: false })
    : viteConfig;
  const output = (resolved as { build: { rollupOptions: { output: { manualChunks: ManualChunks } } } }).build.rollupOptions.output;
  return output.manualChunks;
}

const nm = (p: string) => `/repo/client/node_modules/${p}`;

describe('vite manualChunks', () => {
  const chunk = manualChunks();

  it('page-specific React-free libraries get their own chunk', () => {
    expect(chunk(nm('@fingerprintjs/fingerprintjs/dist/fp.esm.js'))).toBe('vendor-fingerprint');
    expect(chunk(nm('page-flip/dist/js/page-flip.module.js'))).toBe('vendor-pageflip');
    expect(chunk(nm('react-pageflip/build/index.es.js'))).toBe('vendor-pageflip');
    expect(chunk(nm('firebase/app/dist/index.esm.js'))).toBe('vendor-firebase');
    expect(chunk(nm('lucide-react/dist/esm/lucide-react.js'))).toBe('vendor-icons');
  });

  it('React, the router and every other React-using library share vendor-react (cycle guard)', () => {
    for (const p of ['react/index.js', 'react-dom/client.js', 'react-router/dist/index.mjs', '@marsidev/react-turnstile/dist/index.mjs', '@react-oauth/google/dist/index.esm.js']) {
      expect(chunk(nm(p)), p).toBe('vendor-react');
    }
  });

  it('application code is left to Rollup (route-level code splitting)', () => {
    expect(chunk('/repo/client/src/pages/AdminDashboard.tsx')).toBeUndefined();
    expect(chunk('/repo/client/src/pages/TestLab.tsx')).toBeUndefined();
  });

  it('the SSR build defines no manualChunks (externals cannot be chunked)', () => {
    const ssr = (viteConfig as (env: object) => { build: { rollupOptions: { output?: unknown } } })({ command: 'build', mode: 'production', isSsrBuild: true, isPreview: false });
    expect(ssr.build.rollupOptions.output).toBeUndefined();
  });
});
