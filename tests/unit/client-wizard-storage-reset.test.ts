import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const read = (p: string) => fs.readFileSync(path.join(__dirname, '../..', p), 'utf8');

// Every localStorage key the wizard restores a story from. Three code paths
// reset it ("Neue Geschichte", ?new=true, logout); the two inline lists had
// drifted (story_custom_theme_text, story_topic_name) and logout cleared none,
// so the next account on the same browser opened on the previous user's step,
// plot and dedication.
function wizardReadKeys(): string[] {
  const src = ['client/src/pages/StoryWizard.tsx', 'client/src/pages/wizard/WizardStep6Summary.tsx'].map(read).join('\n');
  const keys = new Set<string>();
  for (const m of src.matchAll(/localStorage\.getItem\('([^']+)'\)/g)) keys.add(m[1]);
  keys.delete('auth_token');
  keys.delete('story_language'); // a preference, kept across stories and accounts
  return [...keys];
}

describe('clearWizardStorage', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

  it('covers every key the wizard reads a story from', async () => {
    const { WIZARD_STORY_KEYS } = await import('../../client/src/services/storage');
    for (const k of wizardReadKeys()) expect(WIZARD_STORY_KEYS, k).toContain(k);
  });

  it('removes those keys and leaves the session and the language preference', async () => {
    const map = new Map<string, string>();
    const fake = {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => { map.set(k, v); },
      removeItem: (k: string) => { map.delete(k); },
    };
    vi.stubGlobal('window', { localStorage: fake });
    vi.stubGlobal('localStorage', fake);
    const { clearWizardStorage, WIZARD_STORY_KEYS } = await import('../../client/src/services/storage');
    for (const k of WIZARD_STORY_KEYS) map.set(k, 'x');
    map.set('auth_token', 't'); map.set('story_language', 'fr-ch'); map.set('mystories_selected', '[]');
    clearWizardStorage();
    for (const k of WIZARD_STORY_KEYS) expect(map.has(k), k).toBe(false);
    expect([...map.keys()].sort()).toEqual(['auth_token', 'mystories_selected', 'story_language']);
  });

  it('is the only reset the wizard and logout use', () => {
    const wizard = read('client/src/pages/StoryWizard.tsx');
    expect(wizard.match(/clearWizardStorage\(\);/g)?.length).toBe(2);
    expect(wizard).not.toMatch(/localStorage\.removeItem\('wizard_step'\)/);
    expect(wizard).not.toMatch(/localStorage\.removeItem\('story_dedication'\)/);
    const auth = read('client/src/context/AuthContext.tsx');
    const logout = auth.slice(auth.indexOf('const logout = useCallback'));
    expect(logout).toContain('storage.clearWizardStorage();');
  });
});
