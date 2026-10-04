import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';

/**
 * Code review 2026-10 T1 / R4 / V5: free-text caps, the photo-source allowlist and the
 * client-disconnect abort signal used by the paid idea and avatar routes.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-request-guards';
process.env.R2_PUBLIC_URL = 'https://cdn.example-r2.test';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const g = require('../../server/lib/requestGuards.js');

describe('text caps', () => {
  it('accepts absent, short, and exactly-at-cap text', () => {
    expect(g.textError('topic', undefined)).toBeNull();
    expect(g.textError('topic', 'x'.repeat(g.FIELD_MAX_CHARS))).toBeNull();
  });
  it('rejects over-cap and non-string text', () => {
    expect(g.textError('topic', 'x'.repeat(g.FIELD_MAX_CHARS + 1))).toMatch(/too long/);
    expect(g.textError('topic', { a: 1 })).toMatch(/must be text/);
  });
  it('the idea text has its own larger cap', () => {
    expect(g.textFieldsError([['storyDetails', 'x'.repeat(3000), g.IDEA_TEXT_MAX_CHARS]])).toBeNull();
    expect(g.textFieldsError([['storyDetails', 'x'.repeat(4001), g.IDEA_TEXT_MAX_CHARS]])).toMatch(/too long/);
  });
});

describe('traits', () => {
  it('caps a flat list at 20 items of 100 characters', () => {
    expect(g.characterTraitsError(Array(20).fill('brave'))).toBeNull();
    expect(g.characterTraitsError(Array(21).fill('brave'))).toMatch(/too many/);
    expect(g.characterTraitsError(['x'.repeat(101)])).toMatch(/too long/);
    expect(g.characterTraitsError([1, 2])).toMatch(/only text/);
  });
  it('caps the structured shape the full wizard sends', () => {
    expect(g.characterTraitsError({ strengths: ['a'], flaws: [], challenges: [], specialDetails: 'ok' })).toBeNull();
    expect(g.characterTraitsError({ strengths: Array(21).fill('a') })).toMatch(/strengths/);
    expect(g.characterTraitsError({ specialDetails: 'x'.repeat(2001) })).toMatch(/specialDetails/);
  });
});

describe('characters / relationships / location', () => {
  it('rejects an oversized name, trait list or character count', () => {
    expect(g.characterListError([{ name: 'Mia', age: 7, gender: 'female', traits: ['kind'] }])).toBeNull();
    expect(g.characterListError([{ name: 'x'.repeat(2001) }])).toMatch(/name/);
    expect(g.characterListError([{ name: 'a', traits: Array(25).fill('t') }])).toMatch(/too many/);
    expect(g.characterListError(Array(21).fill({ name: 'a' }))).toMatch(/too many characters/);
    expect(g.characterListError('nope')).toMatch(/list/);
  });
  it('caps relationship text and location parts', () => {
    expect(g.relationshipListError([{ character1: 'a', character2: 'b', relationship: 'siblings' }])).toBeNull();
    expect(g.relationshipListError([{ character1: 'a', character2: 'b', relationship: 'x'.repeat(2001) }])).toMatch(/too long/);
    expect(g.locationError({ city: 'Baden' })).toBeNull();
    expect(g.locationError({ city: 'x'.repeat(201) })).toMatch(/too long/);
    expect(g.locationError('Baden')).toMatch(/object/);
  });
});

describe('V5: user photo sources', () => {
  it('accepts data URIs, raw base64 and our own R2 URLs', () => {
    expect(g.userImageSourceError('p', 'data:image/jpeg;base64,AAAA')).toBeNull();
    expect(g.userImageSourceError('p', '/9j/4AAQSkZJRg==')).toBeNull();
    expect(g.userImageSourceError('p', 'https://cdn.example-r2.test/characters/1/face.jpg')).toBeNull();
    expect(g.userImageSourceError('p', null)).toBeNull();
  });
  it('rejects any other http(s) host, including internal addresses', () => {
    expect(g.userImageSourceError('p', 'https://evil.example/x.jpg')).toMatch(/external URL/);
    expect(g.userImageSourceError('p', 'http://169.254.169.254/latest/meta-data')).toMatch(/external URL/);
    expect(g.userImageSourceError('p', 'https://cdn.example-r2.test.evil.example/x.jpg')).toMatch(/external URL/);
    expect(g.userImageSourceError('p', 42)).toMatch(/image string/);
  });
});

describe('abortOnClientClose', () => {
  it('aborts (clientAborted) when the response closes before it finished', () => {
    const res: any = new EventEmitter();
    res.writableFinished = false;
    const signal = g.abortOnClientClose(res);
    expect(signal.aborted).toBe(false);
    res.emit('close');
    expect(signal.aborted).toBe(true);
    expect(signal.reason.clientAborted).toBe(true);
  });
  it('does not abort after a normal finish', () => {
    const res: any = new EventEmitter();
    res.writableFinished = true;
    const signal = g.abortOnClientClose(res);
    res.emit('close');
    expect(signal.aborted).toBe(false);
  });
});
