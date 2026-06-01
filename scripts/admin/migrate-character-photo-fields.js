#!/usr/bin/env node
/**
 * Migration Script: Consolidate Character Photo Fields onto Canonical Names
 *
 * Walks two storage locations:
 *   - characters.data (input table — one row per user, with data.characters[])
 *   - stories.data.characters[] (per-story snapshot inside each story)
 *
 * For each character object, consolidates 6 sets of duplicate fields onto
 * canonical names, deleting the duplicates. Same canonical schema applied
 * to BOTH locations.
 *
 * Canonical schema after migration:
 *   character.avatars.standard         (URL string)
 *   character.avatars.winter           (URL string)
 *   character.avatars.summer           (URL string)
 *   character.avatars.faceThumb.{standard, winter, summer}
 *   character.avatars.bodyThumb.{standard, winter, summer}
 *   character.photos.{original, face, body, bodyNoBg, faceBox, bodyBox}
 *
 * Removed after migration:
 *   - avatars.standardUrl / winterUrl / summerUrl
 *   - avatars.standard / winter / summer when they are objects (replaced with URL string)
 *   - avatars.faceThumbnailsUrl / faceThumbnails
 *   - avatars.bodyThumbnailsUrl / bodyThumbnails
 *   - top-level: photo_url, photoUrl, photo, thumbnail_url, body_photo_url,
 *     bodyPhotoUrl, body_no_bg_url, bodyNoBgUrl, facePhoto, face_box, faceBox,
 *     body_box, bodyBox
 *
 * DO NOT TOUCH:
 *   - avatars.styledAvatars (per-story art-style sheets)
 *   - avatars.costumed.* (different concept)
 *   - avatars.faceMatch / prompts / clothing / signatures / crossLpips / etc.
 *   - avatars.status / stale / generatedAt / rawEvaluation
 *
 * Usage:
 *   node scripts/admin/migrate-character-photo-fields.js --dry-run
 *   node scripts/admin/migrate-character-photo-fields.js --dry-run --story-id=job_xxx
 *   node scripts/admin/migrate-character-photo-fields.js --dry-run --character-id=42
 *   node scripts/admin/migrate-character-photo-fields.js   (for real — writes DB)
 *
 * Reports written to:
 *   drafts/photo-migration/{timestamp}/dry-run.log   (--dry-run)
 *   drafts/photo-migration/{timestamp}/migrated.log  (real run)
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

// ---------- args ----------
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const storyIdArg = args.find(a => a.startsWith('--story-id='));
const charIdArg = args.find(a => a.startsWith('--character-id='));
const onlyStoryId = storyIdArg ? storyIdArg.split('=')[1] : null;
const onlyCharacterId = charIdArg ? charIdArg.split('=')[1] : null;

// ---------- helpers ----------
const isString = (v) => typeof v === 'string' && v.length > 0;
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

/**
 * Extract a usable URL string from a value that might be:
 *   - a plain URL string
 *   - a data: URI string
 *   - an object like { url, dataUri, image, imageData, src }
 *   - null / undefined / ""
 *
 * Returns { url, kind } where kind ∈ 'url' | 'dataUri' | null
 * Prefers URLs over data URIs. Empty strings normalize to null.
 */
function coerceToUrl(value) {
  if (!value) return { url: null, kind: null };
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return { url: null, kind: null };
    if (trimmed.startsWith('data:')) return { url: trimmed, kind: 'dataUri' };
    return { url: trimmed, kind: 'url' };
  }
  if (isObj(value)) {
    // Try URL fields first
    const urlCandidates = [value.url, value.imageUrl, value.src];
    for (const c of urlCandidates) {
      if (isString(c) && !c.startsWith('data:')) return { url: c.trim(), kind: 'url' };
    }
    // Fall back to data URI fields
    const dataCandidates = [value.dataUri, value.image, value.imageData, value.data];
    for (const c of dataCandidates) {
      if (isString(c) && c.startsWith('data:')) return { url: c.trim(), kind: 'dataUri' };
    }
    // Last resort: any non-empty string under common keys
    for (const k of ['url', 'imageUrl', 'src', 'dataUri', 'image', 'imageData', 'data']) {
      if (isString(value[k])) return { url: value[k].trim(), kind: value[k].startsWith('data:') ? 'dataUri' : 'url' };
    }
  }
  return { url: null, kind: null };
}

/**
 * Pick the best URL from a set of candidate values (URL form wins over data URI).
 * Returns the chosen URL string or null.
 */
function pickBestUrl(...values) {
  let bestUrl = null;
  let bestDataUri = null;
  for (const v of values) {
    const { url, kind } = coerceToUrl(v);
    if (!url) continue;
    if (kind === 'url' && !bestUrl) bestUrl = url;
    else if (kind === 'dataUri' && !bestDataUri) bestDataUri = url;
  }
  return bestUrl || bestDataUri || null;
}

/**
 * Apply the migration to a single character object IN PLACE.
 * Returns an array of change descriptions: [{ from, to, value }].
 */
function migrateCharacter(character) {
  if (!isObj(character)) return [];

  const changes = [];
  const log = (from, to, value) => changes.push({ from, to, value });

  // ---------- 1. avatars main URLs (standard/winter/summer) ----------
  if (isObj(character.avatars)) {
    const av = character.avatars;

    for (const variant of ['standard', 'winter', 'summer']) {
      const urlKey = `${variant}Url`;
      const directKey = variant;
      const urlValue = av[urlKey];
      const directValue = av[directKey];

      const hasUrlForm = urlValue !== undefined && urlValue !== null && urlValue !== '';
      // 'directValue' counts as needing migration if it's an object (avatar object form)
      // or if it's a string that we want to verify is canonical (we still rewrite to ensure URL form).
      const directIsObject = isObj(directValue);
      const directIsString = isString(directValue);

      // Skip entirely if neither form present.
      if (!hasUrlForm && !directIsObject && !directIsString) {
        // still clean up empty-string direct
        if (directValue === '' || directValue === null) {
          if (urlKey in av) {
            delete av[urlKey];
            log(`avatars.${urlKey}`, `(deleted)`, null);
          }
          if (directKey in av && (directValue === '' || directValue === null)) {
            delete av[directKey];
          }
        }
        continue;
      }

      const chosen = pickBestUrl(urlValue, directValue);

      // Decide whether anything needs to change:
      //   - If urlKey exists, we always want to remove it (consolidation).
      //   - If directValue is an object, we want to flatten to string.
      //   - If directValue is already the chosen string, only delete urlKey.
      const willDeleteUrlKey = hasUrlForm;
      const willRewriteDirect = directIsObject || (directIsString && directValue !== chosen) || (!directIsString && chosen);

      if (willDeleteUrlKey) {
        log(`avatars.${urlKey}`, `avatars.${variant}`, chosen);
      } else if (willRewriteDirect && directIsObject) {
        log(`avatars.${variant} (object)`, `avatars.${variant} (URL string)`, chosen);
      }

      if (chosen) {
        av[variant] = chosen;
      } else if (variant in av) {
        // No usable value found at all — drop empty
        delete av[variant];
      }
      if (willDeleteUrlKey) delete av[urlKey];
    }

    // ---------- 2 & 3. faceThumb + bodyThumb ----------
    for (const [legacyA, legacyB, canonical] of [
      ['faceThumbnailsUrl', 'faceThumbnails', 'faceThumb'],
      ['bodyThumbnailsUrl', 'bodyThumbnails', 'bodyThumb'],
    ]) {
      const a = av[legacyA];
      const b = av[legacyB];
      const c = av[canonical];

      const anyLegacy = isObj(a) || isObj(b);
      const hasCanonical = isObj(c);
      if (!anyLegacy && !hasCanonical) continue;

      const merged = isObj(c) ? { ...c } : {};
      for (const variant of ['standard', 'winter', 'summer']) {
        const aV = isObj(a) ? a[variant] : undefined;
        const bV = isObj(b) ? b[variant] : undefined;
        const cV = merged[variant];

        const chosen = pickBestUrl(cV, aV, bV);
        if (chosen) {
          if (cV !== chosen) {
            // Determine the most informative "from" label
            let fromLabel;
            if (isObj(a) && a[variant]) fromLabel = `avatars.${legacyA}.${variant}`;
            else if (isObj(b) && b[variant]) fromLabel = `avatars.${legacyB}.${variant}`;
            else fromLabel = `avatars.${canonical}.${variant}`;
            log(fromLabel, `avatars.${canonical}.${variant}`, chosen);
          }
          merged[variant] = chosen;
        }
      }

      // Apply / cleanup
      if (Object.keys(merged).length > 0) {
        av[canonical] = merged;
      } else if (canonical in av) {
        delete av[canonical];
      }
      if (legacyA in av) {
        if (isObj(a) && !(canonical in av)) {
          // shouldn't happen, but guard
        }
        delete av[legacyA];
        if (!hasCanonical) log(`avatars.${legacyA}`, `avatars.${canonical}`, null);
      }
      if (legacyB in av) {
        delete av[legacyB];
        if (!hasCanonical && !isObj(a)) log(`avatars.${legacyB}`, `avatars.${canonical}`, null);
      }
    }
  }

  // ---------- 4. Top-level legacy photo fields → photos.* ----------
  const photos = isObj(character.photos) ? { ...character.photos } : {};

  // photos.original
  const originalCandidate = pickBestUrl(
    photos.original,
    character.photo_url,
    character.photoUrl,
    character.photo
  );
  if (originalCandidate && photos.original !== originalCandidate) {
    const from = character.photo_url ? 'photo_url'
      : character.photoUrl ? 'photoUrl'
      : character.photo ? 'photo'
      : 'photos.original';
    log(from, 'photos.original', originalCandidate);
    photos.original = originalCandidate;
  } else if (originalCandidate) {
    photos.original = originalCandidate;
  }

  // photos.face (thumbnail_url, facePhoto)
  const faceCandidate = pickBestUrl(
    photos.face,
    character.thumbnail_url,
    character.facePhoto
  );
  if (faceCandidate && photos.face !== faceCandidate) {
    const from = character.thumbnail_url ? 'thumbnail_url'
      : character.facePhoto ? 'facePhoto'
      : 'photos.face';
    log(from, 'photos.face', faceCandidate);
    photos.face = faceCandidate;
  } else if (faceCandidate) {
    photos.face = faceCandidate;
  }

  // photos.body
  const bodyCandidate = pickBestUrl(
    photos.body,
    character.body_photo_url,
    character.bodyPhotoUrl
  );
  if (bodyCandidate && photos.body !== bodyCandidate) {
    const from = character.body_photo_url ? 'body_photo_url'
      : character.bodyPhotoUrl ? 'bodyPhotoUrl'
      : 'photos.body';
    log(from, 'photos.body', bodyCandidate);
    photos.body = bodyCandidate;
  } else if (bodyCandidate) {
    photos.body = bodyCandidate;
  }

  // photos.bodyNoBg
  const bodyNoBgCandidate = pickBestUrl(
    photos.bodyNoBg,
    character.body_no_bg_url,
    character.bodyNoBgUrl
  );
  if (bodyNoBgCandidate && photos.bodyNoBg !== bodyNoBgCandidate) {
    const from = character.body_no_bg_url ? 'body_no_bg_url'
      : character.bodyNoBgUrl ? 'bodyNoBgUrl'
      : 'photos.bodyNoBg';
    log(from, 'photos.bodyNoBg', bodyNoBgCandidate);
    photos.bodyNoBg = bodyNoBgCandidate;
  } else if (bodyNoBgCandidate) {
    photos.bodyNoBg = bodyNoBgCandidate;
  }

  // photos.faceBox (top-level face_box / faceBox)
  {
    const faceBoxLegacy = character.face_box || character.faceBox;
    const from = character.face_box ? 'face_box' : (character.faceBox ? 'faceBox' : null);
    if (faceBoxLegacy) {
      if (!photos.faceBox) {
        log(from, 'photos.faceBox', '<box>');
        photos.faceBox = faceBoxLegacy;
      } else {
        // canonical already exists — top-level is a redundant duplicate
        log(from, 'photos.faceBox (duplicate, kept canonical)', '<box>');
      }
    }
  }

  // photos.bodyBox (top-level body_box / bodyBox)
  {
    const bodyBoxLegacy = character.body_box || character.bodyBox;
    const from = character.body_box ? 'body_box' : (character.bodyBox ? 'bodyBox' : null);
    if (bodyBoxLegacy) {
      if (!photos.bodyBox) {
        log(from, 'photos.bodyBox', '<box>');
        photos.bodyBox = bodyBoxLegacy;
      } else {
        log(from, 'photos.bodyBox (duplicate, kept canonical)', '<box>');
      }
    }
  }

  // Apply photos back if there's anything to write OR pre-existing object
  if (Object.keys(photos).length > 0) {
    character.photos = photos;
  }

  // Strip top-level legacy keys (whether or not we used them — they are duplicates by definition).
  const legacyTopLevel = [
    'photo_url', 'photoUrl', 'photo',
    'thumbnail_url',
    'body_photo_url', 'bodyPhotoUrl',
    'body_no_bg_url', 'bodyNoBgUrl',
    'facePhoto',
    'face_box', 'faceBox',
    'body_box', 'bodyBox',
  ];
  // Map legacy keys to the canonical target so we can label "duplicate" drops accurately.
  const legacyTarget = {
    photo_url: 'photos.original',
    photoUrl: 'photos.original',
    photo: 'photos.original',
    thumbnail_url: 'photos.face',
    facePhoto: 'photos.face',
    body_photo_url: 'photos.body',
    bodyPhotoUrl: 'photos.body',
    body_no_bg_url: 'photos.bodyNoBg',
    bodyNoBgUrl: 'photos.bodyNoBg',
    face_box: 'photos.faceBox',
    faceBox: 'photos.faceBox',
    body_box: 'photos.bodyBox',
    bodyBox: 'photos.bodyBox',
  };
  for (const k of legacyTopLevel) {
    if (k in character) {
      // Already migrated above when value was truthy; if it was falsy we just drop silently.
      // Avoid double-logging for already-logged keys.
      const already = changes.some(c => c.from === k);
      if (!already && character[k]) {
        // Truthy legacy value, but not chosen above because canonical photos.* already had a (better) value.
        // Log as a duplicate drop so we know data wasn't silently lost.
        const target = legacyTarget[k] || 'photos.*';
        log(k, `${target} (duplicate, kept canonical)`, JSON.stringify(character[k]).slice(0, 80));
      }
      delete character[k];
    }
  }

  return changes;
}

/**
 * Build the "light" metadata version of a character (mirrors
 * server/lib/characterMerge.js createLightCharacter, with the new canonical
 * field names — faceThumb.standard replaces faceThumbnails.standard).
 */
function createLightCharacter(char) {
  // Remove heavy fields
  const { body_no_bg_url, body_photo_url, photo_url, clothing_avatars, photos, ...lightChar } = char;

  if (lightChar.avatars) {
    const av = lightChar.avatars;
    const standardThumb = av.faceThumb?.standard;
    lightChar.avatars = {
      status: av.status,
      stale: av.stale,
      generatedAt: av.generatedAt,
      hasFullAvatars: !!(av.winter || av.standard || av.summer),
      faceThumb: standardThumb ? { standard: standardThumb } : undefined,
      clothing: av.clothing,
    };
  }

  return lightChar;
}

// ---------- DB ----------
// --target=staging routes through STAGING_DATABASE_URL (must be set in .env or
// the shell). --target=prod (default) uses DATABASE_PUBLIC_URL / DATABASE_URL.
// Mismatch protection: --target is REQUIRED for any non-dry-run, so we never
// accidentally write to prod when expecting staging.
function makePool() {
  const target = (() => {
    const t = process.argv.find(a => a.startsWith('--target='));
    return t ? t.split('=')[1] : null;
  })();
  let url;
  let label;
  if (target === 'staging') {
    url = process.env.STAGING_DATABASE_URL;
    label = 'STAGING';
    if (!url) {
      console.error('FATAL: --target=staging requires STAGING_DATABASE_URL in env');
      process.exit(1);
    }
  } else if (target === 'prod' || target === null) {
    url = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
    label = 'PROD';
    if (!url) {
      console.error('FATAL: DATABASE_PUBLIC_URL / DATABASE_URL not set');
      process.exit(1);
    }
    if (target === null && !process.argv.includes('--dry-run')) {
      console.error('FATAL: --target=prod or --target=staging is REQUIRED for non-dry-run');
      console.error('       (refusing to write to prod implicitly)');
      process.exit(1);
    }
  } else {
    console.error(`FATAL: --target must be 'staging' or 'prod', got '${target}'`);
    process.exit(1);
  }
  // Echo the host so the operator can sanity-check before any writes.
  try {
    const u = new URL(url);
    console.log(`Target    : ${label}  (${u.hostname}:${u.port || 'default'})`);
  } catch {
    console.log(`Target    : ${label}`);
  }
  return new Pool({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
  });
}

// ---------- main ----------
async function main() {
  console.log('='.repeat(70));
  console.log('Character Photo Field Consolidation Migration');
  console.log('='.repeat(70));
  console.log(`Mode      : ${DRY_RUN ? 'DRY RUN (no DB writes)' : 'LIVE (DB will be modified)'}`);
  if (onlyStoryId) console.log(`Filter    : --story-id=${onlyStoryId}`);
  if (onlyCharacterId) console.log(`Filter    : --character-id=${onlyCharacterId}`);
  console.log('');

  // Set up report file
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  const reportDir = path.join(__dirname, '..', '..', 'drafts', 'photo-migration', timestamp);
  fs.mkdirSync(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, DRY_RUN ? 'dry-run.log' : 'migrated.log');
  const reportStream = fs.createWriteStream(reportPath, { flags: 'w' });
  const writeReport = (line) => { reportStream.write(line + '\n'); };
  writeReport(`# Character Photo Migration ${DRY_RUN ? '(DRY RUN)' : '(LIVE)'} — ${new Date().toISOString()}`);
  writeReport(`# Filters: storyId=${onlyStoryId || '-'} characterId=${onlyCharacterId || '-'}`);
  writeReport('');

  const pool = makePool();

  // Counters
  const stats = {
    charactersRows: 0,
    charactersRowsChanged: 0,
    charactersObjectsScanned: 0,
    charactersObjectsChanged: 0,
    storiesRows: 0,
    storiesRowsChanged: 0,
    storiesCharactersScanned: 0,
    storiesCharactersChanged: 0,
    errors: 0,
    perField: {}, // canonical → count
  };
  const bumpField = (toLabel) => {
    if (!toLabel) return;
    stats.perField[toLabel] = (stats.perField[toLabel] || 0) + 1;
  };

  try {
    // ============ characters table ============
    if (!onlyStoryId) {
      let query = 'SELECT id, user_id, data, metadata FROM characters';
      const params = [];
      if (onlyCharacterId) {
        query += ' WHERE id = $1';
        params.push(onlyCharacterId);
      }
      query += ' ORDER BY id';

      const result = await pool.query(query, params);
      console.log(`[characters] Found ${result.rows.length} row(s) to scan`);
      writeReport(`## characters table — ${result.rows.length} row(s)`);
      writeReport('');

      for (const row of result.rows) {
        stats.charactersRows++;
        try {
          const data = typeof row.data === 'string' ? JSON.parse(row.data) : (row.data || {});
          if (!Array.isArray(data.characters)) {
            continue;
          }

          let rowChanged = false;
          const rowLines = [];

          for (const char of data.characters) {
            stats.charactersObjectsScanned++;
            const charLabel = char.name || char.id || '<unnamed>';
            const changes = migrateCharacter(char);
            if (changes.length > 0) {
              stats.charactersObjectsChanged++;
              rowChanged = true;
              rowLines.push(`[characters/${row.id}].characters[${charLabel}]:`);
              for (const c of changes) {
                const valStr = c.value === null ? '' :
                  (typeof c.value === 'string' && c.value.length > 120)
                    ? c.value.slice(0, 117) + '...'
                    : (typeof c.value === 'object' ? JSON.stringify(c.value) : c.value);
                rowLines.push(`  ${c.from} → ${c.to}${valStr ? `  (${valStr})` : ''}`);
                bumpField(c.to);
              }
            }
          }

          if (rowChanged) {
            stats.charactersRowsChanged++;
            const newMetadata = {
              ...(typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata || {})),
              characters: data.characters.map(createLightCharacter),
            };
            // If old metadata wasn't an object-with-characters but an array, mirror that shape:
            const oldMeta = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata;
            const metadataToWrite = Array.isArray(oldMeta)
              ? data.characters.map(createLightCharacter)
              : newMetadata;

            for (const line of rowLines) {
              console.log(line);
              writeReport(line);
            }

            if (!DRY_RUN) {
              await pool.query(
                'UPDATE characters SET data = $1, metadata = $2 WHERE id = $3',
                [JSON.stringify(data), JSON.stringify(metadataToWrite), row.id]
              );
            }
          }
        } catch (err) {
          stats.errors++;
          const msg = `[ERROR characters/${row.id}] ${err.message}`;
          console.error(msg);
          writeReport(msg);
        }
      }
      writeReport('');
    }

    // ============ stories table ============
    if (!onlyCharacterId) {
      let query = "SELECT id, data FROM stories";
      const params = [];
      if (onlyStoryId) {
        query += ' WHERE id = $1';
        params.push(onlyStoryId);
      }
      query += ' ORDER BY id';

      const result = await pool.query(query, params);
      console.log(`\n[stories] Found ${result.rows.length} row(s) to scan`);
      writeReport(`## stories table — ${result.rows.length} row(s)`);
      writeReport('');

      for (const row of result.rows) {
        stats.storiesRows++;
        try {
          const data = typeof row.data === 'string' ? JSON.parse(row.data) : (row.data || {});
          if (!Array.isArray(data.characters)) {
            continue;
          }

          let rowChanged = false;
          const rowLines = [];

          for (const char of data.characters) {
            stats.storiesCharactersScanned++;
            const charLabel = char.name || char.id || '<unnamed>';
            const changes = migrateCharacter(char);
            if (changes.length > 0) {
              stats.storiesCharactersChanged++;
              rowChanged = true;
              rowLines.push(`[stories/${row.id}].characters[${charLabel}]:`);
              for (const c of changes) {
                const valStr = c.value === null ? '' :
                  (typeof c.value === 'string' && c.value.length > 120)
                    ? c.value.slice(0, 117) + '...'
                    : (typeof c.value === 'object' ? JSON.stringify(c.value) : c.value);
                rowLines.push(`  ${c.from} → ${c.to}${valStr ? `  (${valStr})` : ''}`);
                bumpField(c.to);
              }
            }
          }

          if (rowChanged) {
            stats.storiesRowsChanged++;
            for (const line of rowLines) {
              console.log(line);
              writeReport(line);
            }

            if (!DRY_RUN) {
              await pool.query(
                'UPDATE stories SET data = $1 WHERE id = $2',
                [JSON.stringify(data), row.id]
              );
            }
          }
        } catch (err) {
          stats.errors++;
          const msg = `[ERROR stories/${row.id}] ${err.message}`;
          console.error(msg);
          writeReport(msg);
        }
      }
      writeReport('');
    }

    // ---------- summary ----------
    const summaryLines = [
      '',
      '='.repeat(70),
      'Summary',
      '='.repeat(70),
      `characters rows scanned         : ${stats.charactersRows}`,
      `characters rows changed         : ${stats.charactersRowsChanged}`,
      `character objects scanned       : ${stats.charactersObjectsScanned}`,
      `character objects changed       : ${stats.charactersObjectsChanged}`,
      `stories rows scanned            : ${stats.storiesRows}`,
      `stories rows changed            : ${stats.storiesRowsChanged}`,
      `stories.characters[] scanned    : ${stats.storiesCharactersScanned}`,
      `stories.characters[] changed    : ${stats.storiesCharactersChanged}`,
      `errors                          : ${stats.errors}`,
      '',
      'Per-field change counts:',
      ...Object.entries(stats.perField)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `  ${v.toString().padStart(6)} → ${k}`),
      '',
      DRY_RUN
        ? '*** DRY RUN — no DB writes performed ***'
        : '*** LIVE — DB writes applied (per-row UPDATE) ***',
      `Report written to: ${reportPath}`,
    ];

    for (const line of summaryLines) {
      console.log(line);
      writeReport(line);
    }
  } catch (err) {
    console.error('Fatal:', err);
    writeReport(`FATAL: ${err.message}`);
    process.exitCode = 1;
  } finally {
    reportStream.end();
    await pool.end();
  }
}

// Export for testing
module.exports = { migrateCharacter, createLightCharacter, pickBestUrl, coerceToUrl };

// Only run main when invoked directly (not when required for tests)
if (require.main === module) {
  main().catch(err => {
    console.error('Top-level error:', err);
    process.exit(1);
  });
}
