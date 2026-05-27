#!/usr/bin/env node
/**
 * Phase 1 sanity test for the dual-shape character photo helpers.
 *
 * Loads two synthetic character objects — one in the OLD shape (pre-migration,
 * Manuel-style: `avatars.standardUrl`, `avatars.faceThumbnailsUrl.standard`,
 * top-level `body_box`) and one in the NEW shape (post-migration:
 * `avatars.standard`, `avatars.faceThumb.standard`, `photos.bodyBox`).
 *
 * Asserts:
 *   - every helper returns the SAME URL for both shapes
 *   - missing values return null (never undefined / never an object)
 *
 * Run: node scripts/admin/test-photo-helpers.js
 */

const assert = require('assert');
const {
  getStandardAvatar,
  getFaceThumb,
  getBodyThumb,
  getFacePhoto,
  getPrimaryPhoto,
  hasAnyStandardAvatar,
} = require('../../server/lib/characterPhotos');

// ---------- Synthetic fixtures ----------
//
// Same URLs in both shapes — the helpers must return identical values.
const STANDARD_URL = 'https://r2.example.com/avatars/manuel-standard.jpg';
const WINTER_URL   = 'https://r2.example.com/avatars/manuel-winter.jpg';
const SUMMER_URL   = 'https://r2.example.com/avatars/manuel-summer.jpg';
const FACE_THUMB_STANDARD = 'https://r2.example.com/thumbs/face-standard.jpg';
const FACE_THUMB_WINTER   = 'https://r2.example.com/thumbs/face-winter.jpg';
const BODY_THUMB_STANDARD = 'https://r2.example.com/thumbs/body-standard.jpg';
const BODY_BOX = { x: 10, y: 20, width: 100, height: 200 };
const FACE_PHOTO = 'https://r2.example.com/photos/face.jpg';
const ORIGINAL_PHOTO = 'https://r2.example.com/photos/original.jpg';

// OLD shape — Manuel-style, pre-migration
const charOld = {
  id: 1,
  name: 'TestOld',
  avatars: {
    status: 'complete',
    // R2 URL siblings — the OLD canonical post-Phase-4 storage
    standardUrl: STANDARD_URL,
    winterUrl:   WINTER_URL,
    summerUrl:   SUMMER_URL,
    // Inline form is null (or could be an object) — covered by URL siblings
    standard: null,
    winter: null,
    summer: null,
    faceThumbnailsUrl: {
      standard: FACE_THUMB_STANDARD,
      winter:   FACE_THUMB_WINTER,
    },
    bodyThumbnailsUrl: {
      standard: BODY_THUMB_STANDARD,
    },
  },
  // Legacy top-level photo fields (pre-photos.* migration)
  thumbnail_url: FACE_PHOTO,
  photo_url: ORIGINAL_PHOTO,
  body_box: BODY_BOX,
};

// NEW shape — post-Phase-2 migration
const charNew = {
  id: 2,
  name: 'TestNew',
  avatars: {
    status: 'complete',
    // Main URLs collapsed onto the canonical field name
    standard: STANDARD_URL,
    winter:   WINTER_URL,
    summer:   SUMMER_URL,
    // Single canonical thumbnail field, URL string per variant
    faceThumb: {
      standard: FACE_THUMB_STANDARD,
      winter:   FACE_THUMB_WINTER,
    },
    bodyThumb: {
      standard: BODY_THUMB_STANDARD,
    },
  },
  // Canonical photos.* sub-object
  photos: {
    face: FACE_PHOTO,
    original: ORIGINAL_PHOTO,
    bodyBox: BODY_BOX,
  },
};

// Empty character — for null checks
const charEmpty = { id: 3, name: 'Empty' };
const charEmptyAvatars = { id: 4, name: 'EmptyAvatars', avatars: {} };

// Object-form OLD inline (some legacy rows store the inline avatar as
// { url: 'https://...' } or { imageUrl: 'data:...' } or { imageData: '...' })
const charOldObjectForm = {
  id: 5,
  name: 'TestOldObject',
  avatars: {
    standard: { url: STANDARD_URL },
    winter:   { imageUrl: WINTER_URL },
  },
};

// ---------- Test runner ----------
const out = [];
const log = (s) => { out.push(s); console.log(s); };

let failures = 0;
function expect(label, actual, expected) {
  try {
    assert.strictEqual(actual, expected, `${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
    log(`  PASS  ${label} -> ${actual === null ? 'null' : actual}`);
  } catch (err) {
    failures++;
    log(`  FAIL  ${label} :: ${err.message}`);
  }
}

log('='.repeat(72));
log('Phase 1 dual-shape helper sanity test');
log('='.repeat(72));

log('\n[1] OLD vs NEW return the same URL for getStandardAvatar(standard)');
expect('OLD getStandardAvatar(standard)', getStandardAvatar(charOld, 'standard'), STANDARD_URL);
expect('NEW getStandardAvatar(standard)', getStandardAvatar(charNew, 'standard'), STANDARD_URL);

log('\n[2] OLD vs NEW return the same URL for getStandardAvatar(winter)');
expect('OLD getStandardAvatar(winter)', getStandardAvatar(charOld, 'winter'), WINTER_URL);
expect('NEW getStandardAvatar(winter)', getStandardAvatar(charNew, 'winter'), WINTER_URL);

log('\n[3] OLD vs NEW return the same URL for getStandardAvatar(summer)');
expect('OLD getStandardAvatar(summer)', getStandardAvatar(charOld, 'summer'), SUMMER_URL);
expect('NEW getStandardAvatar(summer)', getStandardAvatar(charNew, 'summer'), SUMMER_URL);

log('\n[4] OLD vs NEW return the same URL for getFaceThumb(standard / winter)');
expect('OLD getFaceThumb(standard)', getFaceThumb(charOld, 'standard'), FACE_THUMB_STANDARD);
expect('NEW getFaceThumb(standard)', getFaceThumb(charNew, 'standard'), FACE_THUMB_STANDARD);
expect('OLD getFaceThumb(winter)',   getFaceThumb(charOld, 'winter'),   FACE_THUMB_WINTER);
expect('NEW getFaceThumb(winter)',   getFaceThumb(charNew, 'winter'),   FACE_THUMB_WINTER);

log('\n[5] OLD vs NEW return the same URL for getBodyThumb(standard)');
expect('OLD getBodyThumb(standard)', getBodyThumb(charOld, 'standard'), BODY_THUMB_STANDARD);
expect('NEW getBodyThumb(standard)', getBodyThumb(charNew, 'standard'), BODY_THUMB_STANDARD);

log('\n[6] Helpers return null for missing values (not undefined)');
expect('empty charEmpty.getStandardAvatar(standard)', getStandardAvatar(charEmpty, 'standard'), null);
expect('empty charEmpty.getFaceThumb(standard)',      getFaceThumb(charEmpty, 'standard'),      null);
expect('empty charEmpty.getBodyThumb(standard)',      getBodyThumb(charEmpty, 'standard'),      null);
expect('empty avatars getStandardAvatar(standard)',   getStandardAvatar(charEmptyAvatars, 'standard'), null);
expect('empty avatars getFaceThumb(standard)',        getFaceThumb(charEmptyAvatars, 'standard'), null);
expect('empty avatars getBodyThumb(standard)',        getBodyThumb(charEmptyAvatars, 'standard'), null);
expect('null character getStandardAvatar(standard)',  getStandardAvatar(null, 'standard'),       null);
expect('null character getFaceThumb(standard)',       getFaceThumb(null, 'standard'),            null);
expect('null character getBodyThumb(standard)',       getBodyThumb(null, 'standard'),            null);
expect('OLD getFaceThumb(summer) [unset variant]',    getFaceThumb(charOld, 'summer'),           null);
expect('NEW getFaceThumb(summer) [unset variant]',    getFaceThumb(charNew, 'summer'),           null);

log('\n[7] Object-form OLD inline avatars unwrap to URL string');
expect('OLD-obj getStandardAvatar(standard) (url field)',    getStandardAvatar(charOldObjectForm, 'standard'), STANDARD_URL);
expect('OLD-obj getStandardAvatar(winter) (imageUrl field)', getStandardAvatar(charOldObjectForm, 'winter'),   WINTER_URL);

log('\n[8] getFacePhoto handles both legacy and canonical photos');
expect('OLD getFacePhoto',  getFacePhoto(charOld), FACE_PHOTO);
expect('NEW getFacePhoto',  getFacePhoto(charNew), FACE_PHOTO);

log('\n[9] hasAnyStandardAvatar — true when any variant resolvable, false otherwise');
expect('OLD hasAnyStandardAvatar',     hasAnyStandardAvatar(charOld),     true);
expect('NEW hasAnyStandardAvatar',     hasAnyStandardAvatar(charNew),     true);
expect('empty hasAnyStandardAvatar',   hasAnyStandardAvatar(charEmpty),   false);
expect('null hasAnyStandardAvatar',    hasAnyStandardAvatar(null),        false);

log('\n[10] Helpers accept an avatars sub-object directly');
expect('OLD avatars-only getStandardAvatar(standard)', getStandardAvatar(charOld.avatars, 'standard'), STANDARD_URL);
expect('NEW avatars-only getFaceThumb(standard)',       getFaceThumb(charNew.avatars, 'standard'),      FACE_THUMB_STANDARD);

log('\n' + '='.repeat(72));
if (failures > 0) {
  log(`FAILED: ${failures} assertion(s) failed`);
  process.exit(1);
} else {
  log('OK: all assertions passed');
  process.exit(0);
}
