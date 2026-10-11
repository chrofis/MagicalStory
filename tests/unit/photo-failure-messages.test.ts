import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { photoFailureMessage, KNOWN_API_ERROR_CODES } from '../../client/src/utils/apiErrors';

// Owner 2026-10-11: failing to upload, to analyze and to find a person are three different messages.
const LANGS = ['en', 'de', 'fr', 'it'];
const upload = (l: string) => photoFailureMessage(new TypeError('Failed to fetch'), l);
const analysis = (l: string) => photoFailureMessage({ code: 'PHOTO_ANALYSIS_FAILED', status: 502 }, l);
const noPerson = (l: string) => photoFailureMessage({ code: 'PHOTO_NO_PERSON', status: 200 }, l);

describe('photoFailureMessage', () => {
  it('network reject / aborted request (no HTTP answer) is the upload message', () => {
    expect(upload('de')).toBe('Das Foto konnte nicht hochgeladen werden. Prüfe deine Internetverbindung und versuche es nochmals.');
    expect(photoFailureMessage(new Error('request aborted'), 'de')).toBe(upload('de'));
  });
  it('a server error answer (5xx, with or without code) is the analysis message', () => {
    expect(analysis('de')).toBe('Das Foto konnte gerade nicht ausgewertet werden. Bitte versuche es gleich nochmals.');
    expect(photoFailureMessage({ status: 500 }, 'de')).toBe(analysis('de'));
    expect(photoFailureMessage({ status: 502 }, 'de')).toBe(analysis('de'));
    expect(photoFailureMessage({ code: 'PHOTO_ANALYSIS_FAILED' }, 'de')).toBe(analysis('de'));
  });
  it('an answered success without a face is the no-person message', () => {
    expect(noPerson('de')).toBe('Auf dem Foto wurde keine Person gefunden. Wähle ein Foto, auf dem ein Gesicht gut zu sehen ist.');
    expect(photoFailureMessage({ code: 'PHOTO_NO_PERSON' }, 'de')).toBe(noPerson('de'));
  });
  it('the three differ in every language, and none is a dash or tu form in French', () => {
    for (const l of LANGS) {
      expect(new Set([upload(l), analysis(l), noPerson(l)]).size).toBe(3);
      for (const m of [upload(l), analysis(l), noPerson(l)]) expect(m).not.toMatch(/[-–—]/);
    }
    for (const m of [upload('fr'), analysis('fr'), noPerson('fr')]) expect(m).not.toMatch(/\b(tu|ton|ta|tes|toi)\b/i);
  });
  it('specific existing answers keep their own message (too large, rate limit, known code)', () => {
    expect(photoFailureMessage({ status: 413 }, 'de')).toBe('Die Datei ist zu gross.');
    expect(photoFailureMessage({ status: 429 }, 'it')).toMatch(/Troppi tentativi/);
    expect(photoFailureMessage({ code: 'TRIAL_SESSION_EXPIRED', status: 401 }, 'de')).toMatch(/Sitzung/);
  });
  it('the codes are known to the client table', () => {
    for (const c of ['PHOTO_UPLOAD_FAILED', 'PHOTO_ANALYSIS_FAILED', 'PHOTO_NO_PERSON']) expect(KNOWN_API_ERROR_CODES).toContain(c);
  });
});

describe('analyze-photo routes send the stable codes (trial and signed-in siblings)', () => {
  for (const f of ['trial.js', 'avatars.js']) {
    const src = fs.readFileSync(path.join(__dirname, '../../server/routes', f), 'utf8');
    const start = src.indexOf("router.post('/analyze-photo'");
    const body = src.slice(start, src.indexOf('\nrouter.', start + 10));
    it(`${f}: no face carries PHOTO_NO_PERSON`, () => {
      expect(body).toMatch(/error: 'no_face_detected',\s*code: 'PHOTO_NO_PERSON'/);
    });
    it(`${f}: every error answer carries PHOTO_ANALYSIS_FAILED`, () => {
      const errorAnswers = [...body.matchAll(/res\.status\((\d+)\)\.json\(\{[^}]*\}\)/gs)].filter(m => m[1] !== '400');
      expect(errorAnswers.length).toBeGreaterThanOrEqual(3);
      for (const m of errorAnswers) expect(m[0], m[0]).toContain("code: 'PHOTO_ANALYSIS_FAILED'");
    });
  }
});
