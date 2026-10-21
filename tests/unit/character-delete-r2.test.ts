import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
process.env.R2_PUBLIC_URL = 'https://images.test.example';
const r2 = require_('../../server/lib/r2');
const r2Pending = require_('../../server/lib/r2Pending');
const { pruneDeletedCharacterFiles, collectCharacterKeys } = require_('../../server/lib/characterR2');

/**
 * Regression for bug character-delete-leaves-photos-on-r2: files live under
 * characters/<user>/characters_<row>/inline/<index-named>-<hash>.jpg, shared by
 * all characters of the row, so the old per-id prefix prune removed nothing and
 * a folder prune would remove other characters' files.
 */
const USER = 'user-1';
const ROW = 'characters_user-1';
const url = (k: string) => `https://images.test.example/${k}`;
const K = (n: string) => `characters/${USER}/${ROW}/inline/${n}.jpg`;

let bucket: Set<string>;
let deleted: string[];
let remainingRowText: string;
let storiesText: string[];

// Fake of the SQL in findReferencedKeys: a key is referenced if it appears in the remaining row or a story.
const query = async (_sql: string, [keys]: [string[]]) =>
  keys.filter(k => remainingRowText.includes(k) || storiesText.some(t => t.includes(k))).map(k => ({ k }));

beforeEach(() => {
  deleted = [];
  r2.listByPrefix = async (prefix: string) => [...bucket].filter(k => k.startsWith(prefix)).map(key => ({ key, size: 1 }));
  r2Pending.pruneObject = async (key: string) => { bucket.delete(key); deleted.push(key); return 1; };
  storiesText = [];
});

describe('pruneDeletedCharacterFiles', () => {
  it('deletes exactly the deleted character\'s files and leaves the other character untouched', async () => {
    const danilo = {
      id: 2,
      photos: { face: url(K('characters-1-photos-face-aaa')), body: url(K('characters-1-photos-body-bbb')) },
      avatars: { styledAvatars: { pixar: { standard: url(K('preGeneratedStyledAvatars-Danilo-standard-ccc')) } } },
    };
    const other = { id: 1, photos: { face: url(K('characters-0-photos-face-zzz')) } };
    remainingRowText = JSON.stringify({ characters: [other] });
    bucket = new Set([
      K('characters-1-photos-face-aaa'), K('characters-1-photos-body-bbb'),
      K('preGeneratedStyledAvatars-Danilo-standard-ccc'), K('characters-0-photos-face-zzz'),
      `characters/${USER}/2/avatars/summer.jpg`,
    ]);
    const res = await pruneDeletedCharacterFiles({ userId: USER, characterId: 2, rowId: ROW, deletedChar: danilo, query });
    expect(deleted.sort()).toEqual([
      K('characters-1-photos-body-bbb'), K('characters-1-photos-face-aaa'),
      K('preGeneratedStyledAvatars-Danilo-standard-ccc'), `characters/${USER}/2/avatars/summer.jpg`,
    ].sort());
    expect(bucket.has(K('characters-0-photos-face-zzz'))).toBe(true);
    expect(res.failed).toEqual([]);
  });

  it('keeps a key a remaining character shares (identical bytes) and a key a story still shows', async () => {
    const shared = K('characters-0-photos-face-same');
    const storyKey = `characters/${USER}/2/avatars/summer.jpg`;
    const gone = { id: 2, photos: { face: url(shared), body: url(K('only-mine')) }, avatar: url(storyKey) };
    remainingRowText = JSON.stringify({ characters: [{ id: 1, photos: { face: url(shared) } }] });
    storiesText = [JSON.stringify({ characters: [{ avatar: url(storyKey) }] })];
    bucket = new Set([shared, K('only-mine'), storyKey]);
    const res = await pruneDeletedCharacterFiles({ userId: USER, characterId: 2, rowId: ROW, deletedChar: gone, query });
    expect(deleted).toEqual([K('only-mine')]);
    expect(res.keptReferenced.sort()).toEqual([shared, storyKey].sort());
  });

  it('deletes nothing and throws when the reference check fails', async () => {
    remainingRowText = '';
    bucket = new Set([K('x')]);
    await expect(pruneDeletedCharacterFiles({
      userId: USER, characterId: 2, rowId: ROW, deletedChar: { photos: { face: url(K('x')) } },
      query: async () => { throw new Error('db down'); },
    })).rejects.toThrow('db down');
    expect(deleted).toEqual([]);
  });

  it('collectCharacterKeys ignores other users and foreign hosts', () => {
    const keys = collectCharacterKeys({
      a: url(`characters/other-user/x/y.jpg`), b: 'https://elsewhere.example/characters/user-1/a.jpg', c: url(K('mine')),
    }, USER);
    expect([...keys]).toEqual([K('mine')]);
  });
});
