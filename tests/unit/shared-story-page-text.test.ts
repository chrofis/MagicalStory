import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';

/**
 * GET /api/shared/:shareToken builds the viewer's page list from the stored story text.
 * The route used to carry its own page-marker parser that knew only `Page` / `Seite`;
 * the Italian i18n commit taught sceneMetadata.getPageText and pdf.js the `Pagina`
 * marker (storyJobPipeline writes `## Pagina N` for Italian stories) and never reached
 * that copy, so every page of an Italian story read as empty text in the shared viewer
 * while the PDF of the same story had its text. One parser now serves both readers.
 */
const nodeRequire = createRequire(import.meta.url);
process.env.JWT_SECRET = 'test-secret-shared-page-text';
const db: any = nodeRequire('../../server/services/database.js');

const TOKEN = 'b'.repeat(64);
let row: any;

db.dbQuery = async (sql: string) => {
  if (/FROM stories/.test(sql)) return [row];
  return [];
};
db.imagesExistByType = async () => new Set();
let versionMeta: any = {};
db.getActiveVersionMeta = async () => versionMeta;

const { apiRouter } = nodeRequire('../../server/routes/sharing.js');

function handler(path: string) {
  const layer = apiRouter.stack.find((l: any) => l.route && l.route.path === path && l.route.methods.get);
  if (!layer) throw new Error(`no GET ${path}`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}
async function getStory() {
  const req: any = { params: { shareToken: TOKEN }, query: {}, headers: {}, user: { id: 'owner' } };
  let status = 200; let body: any = null;
  const res: any = {
    status(s: number) { status = s; return this; },
    json(b: any) { body = b; return this; },
    set() { return this; },
  };
  await handler('/shared/:shareToken')(req, res);
  return { status, body };
}

const pageText = (word: string, n: number) => `${word} ${n} text with é, ß and «quotes»`;
const scenes = (n: number) => Array.from({ length: n }, (_, i) => ({ pageNumber: i + 1 }));

beforeEach(() => {
  versionMeta = {};
  row = { id: 's1', user_id: 'owner', is_shared: true, admin_draft: false, data: { title: 'T', sceneImages: scenes(3) } };
});

describe('shared story page text parser', () => {
  it.each([
    ['Italian', 'Pagina'],
    ['German', 'Seite'],
    ['French/English', 'Page'],
  ])('%s `## %s N` markers yield every page text', async (_lang, word) => {
    row.data.storyText = [1, 2, 3].map(n => `## ${word} ${n}\n\n${pageText(word, n)}`).join('\n\n');
    const r = await getStory();
    expect(r.status).toBe(200);
    expect(r.body.pages.map((p: any) => p.text)).toEqual([1, 2, 3].map(n => pageText(word, n)));
  });

  it('`--- Pagina N ---` markers (older blobs) work too', async () => {
    row.data.story = [1, 2, 3].map(n => `--- Pagina ${n} ---\n${pageText('Pagina', n)}`).join('\n\n');
    const r = await getStory();
    expect(r.body.pages.map((p: any) => p.text)).toEqual([1, 2, 3].map(n => pageText('Pagina', n)));
  });

  it('a page whose marker is missing still appears, with empty text', async () => {
    row.data.storyText = `## Seite 1\n\nuno\n\n## Seite 3\n\ntre`;
    const r = await getStory();
    expect(r.body.pages.map((p: any) => [p.pageNumber, p.text])).toEqual([[1, 'uno'], [2, ''], [3, 'tre']]);
  });
});

describe('shared story active image versions', () => {
  // /image/:page and /cover-image/:type answer with a 24h-cacheable redirect to the
  // active version's R2 object. The viewer keys its image URLs on these numbers so a
  // version switch is a new URL instead of a day-old cached redirect to the old picture.
  it('each page and cover carries the active version from image_version_meta (0 when unset)', async () => {
    row.data.storyText = `## Seite 1\n\nuno\n\n## Seite 2\n\ndue\n\n## Seite 3\n\ntre`;
    versionMeta = { '2': { activeVersion: 3 }, frontCover: { activeVersion: 1 } };
    const r = await getStory();
    expect(r.body.pages.map((p: any) => p.imageVersion)).toEqual([0, 3, 0]);
    expect(r.body.coverVersions).toEqual({ frontCover: 1, initialPage: 0, backCover: 0 });
  });
});
