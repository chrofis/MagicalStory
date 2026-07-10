// End-to-end test of the merged save path (persistStoryToDatabase) against
// the STAGING database: upsertStory (firstSave) then saveStoryData (update),
// verifying story_images rows, v0 single-writer semantics, retry-history
// extraction, and blob stripping. Cleans up after itself.
require('dotenv').config();
process.env.DATABASE_URL = process.env.STAGING_DATABASE_URL; // staging, NOT prod
const db = require('../../server/services/database');
db.initializePool();

const px = (c) => 'data:image/jpeg;base64,' + Buffer.from('fake-image-bytes-' + c.repeat(400)).toString('base64');

(async () => {
  const id = 'test_savemerge_' + Date.now();
  const userId = null; // FK: users nullable? use a real user? check constraint
  // find any staging user id for the FK
  const u = await db.dbQuery('SELECT id FROM users LIMIT 1');
  const uid = u[0].id;

  const story = {
    id, title: 'SaveMerge Test', artStyle: 'watercolor',
    sceneImages: [
      { pageNumber: 1, text: 'p1', imageData: px('A'),
        imageVersions: [ { imageData: px('A'), type: 'original' }, { imageData: px('B'), type: 'repair', qualityScore: 80 } ],
        retryHistory: [ { attempt: 1, type: 'generation', score: 50, imageData: px('R') } ] },
      { pageNumber: 2, text: 'p2', imageData: px('C'), emptySceneImage: px('E') },
    ],
    coverImages: { frontCover: { imageData: px('F'),
      imageVersions: [ { imageData: px('F'), type: 'original' } ],
      retryHistory: [ { attempt: 1, imageData: px('G') } ] } },
  };

  console.log('1) upsertStory (firstSave)...');
  await db.upsertStory(id, uid, story);

  const imgs = await db.dbQuery('SELECT image_type, page_number, version_index FROM story_images WHERE story_id=$1 ORDER BY image_type, page_number, version_index', [id]);
  console.log('   story_images rows:', imgs.map(r => `${r.image_type}:p${r.page_number}:v${r.version_index}`).join(' '));
  const retry = await db.dbQuery('SELECT page_number, image_type FROM story_retry_images WHERE story_id=$1', [id]);
  console.log('   retry rows:', retry.map(r => `${r.image_type}@p${r.page_number}`).join(' '));
  const blob = await db.dbQuery('SELECT pg_column_size(data) AS b, data FROM stories WHERE id=$1', [id]);
  const d = blob[0].data;
  const blobHasBytes = JSON.stringify(d).includes('fake-image-bytes');
  console.log('   blob size:', blob[0].b, 'bytes | inline bytes leaked:', blobHasBytes);

  // v0 single-writer check: page1 v0 should exist exactly once
  const v0count = imgs.filter(r => r.image_type === 'scene' && r.page_number === 1 && r.version_index === 0).length;
  console.log('   p1 v0 rows (must be 1):', v0count);

  console.log('2) saveStoryData (update) with a new version...');
  const reloaded = (await db.dbQuery('SELECT data FROM stories WHERE id=$1', [id]))[0].data;
  reloaded.sceneImages[0].imageVersions = reloaded.sceneImages[0].imageVersions || [];
  reloaded.sceneImages[0].imageVersions.push({ imageData: px('Z'), type: 'repair', qualityScore: 90 });
  await db.saveStoryData(id, reloaded);
  const imgs2 = await db.dbQuery('SELECT image_type, page_number, version_index FROM story_images WHERE story_id=$1 AND image_type=$2 AND page_number=1 ORDER BY version_index', [id, 'scene']);
  console.log('   p1 versions after update:', imgs2.map(r => 'v' + r.version_index).join(' '));
  const blob2 = await db.dbQuery('SELECT data FROM stories WHERE id=$1', [id]);
  console.log('   blob bytes leaked after update:', JSON.stringify(blob2[0].data).includes('fake-image-bytes'));

  console.log('3) _alreadySaved is honored for scenes (no double-write at the wrong index)...');
  // Simulate a regen route: write the bytes explicitly at DB MAX+1 and stamp
  // the version. The save loop must SKIP it (previously it re-saved at the
  // array index, which could overwrite an older row on lazy-migrated blobs).
  const reloaded3 = (await db.dbQuery('SELECT data FROM stories WHERE id=$1', [id]))[0].data;
  const nextIdx = await db.getNextVersionIndex(id, 'scene', 1);
  await db.saveStoryImage(id, 'scene', 1, px('Q'), { versionIndex: nextIdx });
  reloaded3.sceneImages[0].imageVersions.push({
    imageData: px('Q'), type: 'edit', dbVersionIndex: nextIdx, _alreadySaved: true
  });
  const rowsBefore = await db.dbQuery('SELECT version_index, md5(coalesce(image_data,\'\')) AS h FROM story_images WHERE story_id=$1 AND image_type=$2 AND page_number=1 ORDER BY version_index', [id, 'scene']);
  await db.saveStoryData(id, reloaded3);
  const rowsAfter = await db.dbQuery('SELECT version_index, md5(coalesce(image_data,\'\')) AS h FROM story_images WHERE story_id=$1 AND image_type=$2 AND page_number=1 ORDER BY version_index', [id, 'scene']);
  const untouched = JSON.stringify(rowsBefore) === JSON.stringify(rowsAfter);
  console.log(`   rows unchanged by save (must be true): ${untouched} (${rowsAfter.map(r => 'v' + r.version_index).join(' ')})`);

  console.log('4) pinned active version survives saveStoryData recompute...');
  // Pin v0 even though a higher-scored version exists — the recompute inside
  // saveStoryData must leave the pin alone (it used to clobber user picks).
  await db.setActiveVersion(id, '1', 0, { pinned: true });
  const reloaded4 = (await db.dbQuery('SELECT data FROM stories WHERE id=$1', [id]))[0].data;
  await db.saveStoryData(id, reloaded4);
  const meta = (await db.dbQuery('SELECT image_version_meta AS m FROM stories WHERE id=$1', [id]))[0].m || {};
  const pinHeld = meta['1']?.activeVersion === 0 && meta['1']?.pinned === true;
  console.log(`   pin held after save (must be true): ${pinHeld} (meta['1']=${JSON.stringify(meta['1'])})`);
  // Blob mirror must agree with the pinned choice.
  const blob4 = (await db.dbQuery('SELECT data FROM stories WHERE id=$1', [id]))[0].data;
  console.log(`   blob activeVersion mirrors pin (must be 0): ${blob4.sceneImages[0].activeVersion}`);
  // Unpinned set (pick-best semantics) clears the pin.
  await db.setActiveVersion(id, '1', 1);
  const meta2 = (await db.dbQuery('SELECT image_version_meta AS m FROM stories WHERE id=$1', [id]))[0].m || {};
  console.log(`   plain set cleared pin (must be true): ${meta2['1']?.pinned === undefined}`);

  console.log('5) cover NULL-page upsert dedups (no duplicate frontCover v0)...');
  await db.saveStoryImage(id, 'frontCover', null, px('F'), { versionIndex: 0 });
  await db.saveStoryImage(id, 'frontCover', null, px('F'), { versionIndex: 0 });
  const coverRows = await db.dbQuery('SELECT count(*) AS n FROM story_images WHERE story_id=$1 AND image_type=$2 AND version_index=0', [id, 'frontCover']);
  console.log(`   frontCover v0 rows after double upsert (must be 1): ${coverRows[0].n}`);

  console.log('6) cleanup...');
  await db.dbQuery('DELETE FROM stories WHERE id=$1', [id]);
  const gone = await db.dbQuery('SELECT count(*) AS n FROM story_images WHERE story_id=$1', [id]);
  console.log('   cascade cleaned story_images:', gone[0].n === '0' || gone[0].n === 0);
  console.log('DONE');
  process.exit(0);
})().catch(e => { console.error('TEST FAILED:', e.message); process.exit(1); });
