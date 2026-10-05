import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { localizedApiError, KNOWN_API_ERROR_CODES } from '../../client/src/utils/apiErrors';
import { uiLabel, type UiLabelKey } from '../../client/src/utils/uiLabels';
import { resolveVisitorLanguage } from '../../client/src/utils/languagePreference';

const LANGS = ['en', 'de', 'fr', 'it'];

describe('G-4 localizedApiError', () => {
  it('maps a stable server code to the visitor language, never the raw English', () => {
    const err = Object.assign(new Error('Invalid credentials'), { code: 'INVALID_CREDENTIALS', status: 401 });
    expect(localizedApiError(err, 'de')).toBe('E-Mail-Adresse oder Passwort ist falsch.');
    expect(localizedApiError(err, 'it')).toContain('password');
    expect(localizedApiError(err, 'fr')).not.toBe('Invalid credentials');
  });

  it('every known code has non-empty text in all four languages, distinct from English', () => {
    for (const code of KNOWN_API_ERROR_CODES) {
      const en = localizedApiError({ code }, 'en');
      expect(en.length).toBeGreaterThan(5);
      for (const l of ['de', 'fr', 'it']) {
        const txt = localizedApiError({ code }, l);
        expect(txt.length, `${code}/${l}`).toBeGreaterThan(5);
        expect(txt, `${code}/${l}`).not.toBe(en);
      }
    }
  });

  it('French strings use vous, never tu (decision #10)', () => {
    for (const code of KNOWN_API_ERROR_CODES) {
      expect(localizedApiError({ code }, 'fr'), code).not.toMatch(/\b(tu|ton|ta|tes|toi)\b/i);
    }
  });

  it('unknown code with no status falls back to the caller sentence, else a generic localised message', () => {
    expect(localizedApiError({ code: 'NOT_A_REAL_CODE' }, 'fr', 'Échec de la connexion')).toBe('Échec de la connexion');
    for (const l of LANGS) {
      const generic = localizedApiError(new Error('Some English server text'), l);
      expect(generic).not.toContain('English server text');
    }
    expect(localizedApiError(new Error('x'), 'de')).toMatch(/schiefgelaufen/);
  });

  it('status classes without a code: 402 credits, 429 rate limit, 5xx server text', () => {
    expect(localizedApiError({ status: 402 }, 'de')).toMatch(/Credits/);
    expect(localizedApiError({ status: 429 }, 'it')).toMatch(/Troppi tentativi/);
    expect(localizedApiError({ status: 500 }, 'fr')).toMatch(/de notre côté/);
  });

  it('a network failure (fetch TypeError) says connection problem, not "Failed to fetch"', () => {
    expect(localizedApiError(new TypeError('Failed to fetch'), 'de')).toMatch(/Verbindungsproblem/);
  });

  it('an unsupported language falls back to English text, still not the raw server string', () => {
    expect(localizedApiError({ code: 'INVALID_EMAIL' }, 'es')).toBe('Please enter a valid email address.');
  });
});

describe('G-4 server codes the customer flows send are all explained by the client', () => {
  const files = ['auth.js', 'trial.js', 'user.js', 'print.js'];
  it('every `code:` literal in those routes has a client message', () => {
    const missing: string[] = [];
    for (const f of files) {
      const src = fs.readFileSync(path.join(__dirname, '../../server/routes', f), 'utf8');
      for (const m of src.matchAll(/code: '([A-Z_]+)'/g)) {
        if (!KNOWN_API_ERROR_CODES.includes(m[1])) missing.push(`${f}:${m[1]}`);
      }
    }
    expect(missing).toEqual([]);
  });
});

describe('L-3 language precedence after load (decision #12)', () => {
  it('?lang= beats the stored language', () => {
    expect(resolveVisitorLanguage('fr', 'it')).toBe('fr');
  });
  it('stored language wins over the prerender language (null = no visitor preference)', () => {
    expect(resolveVisitorLanguage(null, 'it')).toBe('it');
  });
  it('no preference leaves the prerender language alone', () => {
    expect(resolveVisitorLanguage(null, null)).toBeNull();
  });
  it('ignores unsupported values', () => {
    expect(resolveVisitorLanguage('es', 'xx')).toBeNull();
  });
});

describe('G-5 uiLabel', () => {
  const keys: UiLabelKey[] = ['close', 'dismiss', 'fullscreen', 'zoomIn', 'zoomOut', 'resetZoom', 'page', 'noImage', 'dedication', 'backCover', 'character', 'faceCrop', 'exampleFullBody', 'menu'];
  it('every accessible name exists in all four languages', () => {
    for (const k of keys) for (const l of LANGS) expect(uiLabel(k, l).length, `${k}/${l}`).toBeGreaterThan(1);
  });
  it('is not English for de/fr/it where the word differs', () => {
    expect(uiLabel('close', 'de')).toBe('Schliessen');
    expect(uiLabel('close', 'fr')).toBe('Fermer');
    expect(uiLabel('close', 'it')).toBe('Chiudi');
    expect(uiLabel('close', 'xx')).toBe('Close');
  });
});
