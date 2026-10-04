import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

/**
 * Code review 2026-10 batch 5: V1 retry avatar keeps its own R2 URLs, A4/T5 locked
 * read-modify-write of the characters row (modifyCharactersRow), V2 sync avatar branch gone.
 */
const nodeRequire = createRequire(import.meta.url);
process.env.JWT_SECRET = 'test-secret-avatar-row-writes';
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-key';
// database.js destructures Pool at load, so swap it before the first require.
let fakePoolRef: any = null;
nodeRequire('pg').Pool = class { constructor() { return fakePoolRef; } };
const db: any = nodeRequire('../../server/services/database.js');
const avatars: any = nodeRequire('../../server/routes/avatars.js');

describe('V1: adoptRetryAvatar', () => {
  const uploaders = {
    main: async (_u: any, _c: any, cat: string, _img: string, tag: string) => `https://r2/${cat}-${tag}.jpg`,
    thumb: async (_u: any, _c: any, kind: string, cat: string, _img: string, tag: string) => `https://r2/${kind}-${cat}-${tag}.jpg`,
  };
  const firstAttempt = () => ({
    standard: 'FIRST', standardUrl: 'https://r2/standard-first.jpg',
    faceThumbnails: { standard: 'F1' }, faceThumbnailsUrl: { standard: 'https://r2/face-standard-first.jpg' },
    bodyThumbnails: { standard: 'B1' }, bodyThumbnailsUrl: { standard: 'https://r2/body-standard-first.jpg' },
  });

  it('replaces the rejected attempt URLs with the retry URLs', async () => {
    const results: any = firstAttempt();
    await avatars.adoptRetryAvatar(results, 'standard',
      { imageData: 'RETRY', faceThumbnail: 'F2', bodyThumbnail: 'B2', userId: 1, characterId: 2, tag: 'vr' }, uploaders);
    expect(results.standard).toBe('RETRY');
    expect(results.standardUrl).toBe('https://r2/standard-vr.jpg');
    expect(results.faceThumbnailsUrl.standard).toBe('https://r2/face-standard-vr.jpg');
    expect(results.bodyThumbnailsUrl.standard).toBe('https://r2/body-standard-vr.jpg');
  });

  it('leaves no stale URL when the retry upload fails (retry bytes persist, not the rejected image)', async () => {
    const results: any = firstAttempt();
    const failing = { main: async () => undefined, thumb: async () => undefined };
    await avatars.adoptRetryAvatar(results, 'standard',
      { imageData: 'RETRY', faceThumbnail: 'F2', bodyThumbnail: null, userId: 1, characterId: 2, tag: 'vr' }, failing);
    expect(results.standardUrl).toBeUndefined();
    expect(results.faceThumbnailsUrl.standard).toBeUndefined();
    expect(results.bodyThumbnailsUrl.standard).toBeUndefined();
    expect(results.bodyThumbnails.standard).toBeUndefined();
    expect(results.standard).toBe('RETRY');
  });
});

describe('A4/T5: modifyCharactersRow', () => {
  function fakePool(initial: any) {
    const log: string[] = [];
    const state = { data: initial as any };
    const client = {
      query: async (sql: string, params: any[] = []) => {
        log.push(sql.split(/\s+/).slice(0, 2).join(' ') + (sql.includes('FOR UPDATE') ? ' FOR UPDATE' : ''));
        if (sql.startsWith('SELECT')) return { rows: state.data ? [{ data: JSON.stringify(state.data) }] : [] };
        if (sql.startsWith('UPDATE')) state.data = JSON.parse(params[0]);
        return { rows: [] };
      },
      release: () => log.push('release'),
    };
    return { pool: { connect: async () => client, on: () => {} }, state, log };
  }

  it('merges into the CURRENT row under a lock, inside one transaction', async () => {
    const { pool, state, log } = fakePool({ characters: [{ name: 'Edited by user', physical: {} }] });
    fakePoolRef = pool;
    db.initializePool();
    const out = await db.modifyCharactersRow('characters_1', 1, (d: any) => { d.characters[0].previewAvatar = 'X'; });
    expect(out.characters[0].name).toBe('Edited by user');
    expect(state.data.characters[0].previewAvatar).toBe('X');
    expect(log).toEqual(['BEGIN', 'SELECT data FOR UPDATE', 'UPDATE characters', 'COMMIT', 'release']);
  });
});

describe('V2: the sync /generate-clothing-avatars branch is gone', () => {
  it('handler source has no SYNC MODE branch or stale-index charIndex write', () => {
    const fs = nodeRequire('node:fs');
    const src = fs.readFileSync(nodeRequire.resolve('../../server/routes/avatars.js'), 'utf8');
    expect(src).not.toMatch(/bSYNC MODE/);
    expect(src).not.toMatch(/\[CLOTHING AVATARS\] Failed to save to database/);
  });
});
