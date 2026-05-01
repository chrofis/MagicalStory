/**
 * Sharing Routes - /api/shared/*, /s/*, /shared/*
 *
 * Public sharing endpoints for stories:
 * - Public story access (no auth)
 * - Image serving for shared stories (no auth)
 * - OG meta tag pages for social previews (no auth)
 *
 * Exports two routers:
 * - apiRouter: Mount at /api for API endpoints
 * - htmlRouter: Mount at root for HTML preview pages
 */

const express = require('express');
const path = require('path');
const fs = require('fs').promises;
const sharp = require('sharp');

const { dbQuery, getStoryImage, getActiveVersion, imagesExistByType } = require('../services/database');
const { log } = require('../utils/logger');
const { verifyToken } = require('../middleware/auth');

// Base URL for OG tags and share links (consistent with stories.js)
const SITE_URL = process.env.FRONTEND_URL || 'https://www.magicalstory.ch';

// In-memory cache for rendered text overlays. Result is fully deterministic
// for (storyId, pageNumber, activeVersion, languageLevel, textPosition):
// same inputs → same PNG. Without this, every shared-viewer load redoes
// 10× sharp+canvas renders on the server (7-19s per page observed in HAR).
// Browser caching can't help (POST responses aren't cached). Keyed string,
// LRU-evicted when over MAX_OVERLAY_CACHE entries.
const TEXT_OVERLAY_CACHE = new Map();
const MAX_OVERLAY_CACHE = 500; // ~500 pages × ~200KB png = 100MB ceiling
function cacheGet(key) {
  if (!TEXT_OVERLAY_CACHE.has(key)) return null;
  // Refresh recency: re-insert moves to the end of the Map's iteration order
  const v = TEXT_OVERLAY_CACHE.get(key);
  TEXT_OVERLAY_CACHE.delete(key);
  TEXT_OVERLAY_CACHE.set(key, v);
  return v;
}
function cacheSet(key, value) {
  if (TEXT_OVERLAY_CACHE.size >= MAX_OVERLAY_CACHE) {
    // Drop oldest (first inserted) entry
    const oldestKey = TEXT_OVERLAY_CACHE.keys().next().value;
    TEXT_OVERLAY_CACHE.delete(oldestKey);
  }
  TEXT_OVERLAY_CACHE.set(key, value);
}

// API router for /api/* endpoints
const apiRouter = express.Router();
// HTML router for root-level endpoints (/s/*, /shared/*)
const htmlRouter = express.Router();

// These are set by initSharingRoutes() from server.js
let distPath = null;
let hasDistFolder = false;

/**
 * Initialize sharing routes with server configuration
 * @param {Object} config - Configuration from server.js
 * @param {string} config.distPath - Path to client dist folder
 * @param {boolean} config.hasDistFolder - Whether dist folder exists
 */
function initSharingRoutes(config) {
  distPath = config.distPath;
  hasDistFolder = config.hasDistFolder;
}

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Optional auth middleware — sets req.user if valid JWT present, otherwise continues.
 * Checks Authorization header first, then ?token= query param (for <img> tags that can't send headers).
 */
function optionalAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader ? authHeader.split(' ')[1] : req.query.token;
  if (token) {
    try {
      req.user = verifyToken(token);
    } catch {
      // Invalid token — continue as anonymous
    }
  }
  next();
}

// Apply optional auth to all shared API routes
apiRouter.use('/shared', optionalAuth);

/**
 * Get shared story by token.
 * Access allowed if: is_shared=true (public) OR userId matches owner (private owner view)
 */
async function getSharedStory(shareToken, userId = null) {
  if (!shareToken || shareToken.length !== 64) {
    return null;
  }
  const rows = await dbQuery(
    'SELECT id, user_id, is_shared, data FROM stories WHERE share_token = $1 AND (is_shared = true OR user_id = $2)',
    [shareToken, userId]
  );
  if (rows.length === 0) {
    return null;
  }
  const data = typeof rows[0].data === 'string' ? JSON.parse(rows[0].data) : rows[0].data;
  return { id: rows[0].id, userId: rows[0].user_id, isShared: rows[0].is_shared, data };
}

/**
 * Get shared story ID only (fast path for image endpoints)
 * Access allowed if: is_shared=true (public) OR userId matches owner
 */
async function getSharedStoryId(shareToken, userId = null) {
  if (!shareToken || shareToken.length !== 64) {
    return null;
  }
  const rows = await dbQuery(
    'SELECT id FROM stories WHERE share_token = $1 AND (is_shared = true OR user_id = $2)',
    [shareToken, userId]
  );
  return rows.length > 0 ? rows[0].id : null;
}

/**
 * Extract page text from story text by page number
 */
function getPageText(storyText, pageNumber) {
  if (!storyText) return null;

  // Handle array format (unified mode)
  if (Array.isArray(storyText)) {
    const page = storyText.find(p => p.pageNumber === pageNumber);
    return page?.text || null;
  }

  // Try multiple page marker formats
  // Format 1: "--- Page N ---" or "--- Seite N ---"
  // Format 2: "## Page N" or "## Seite N"
  const markers = [
    `--- Page ${pageNumber} ---`,
    `--- Seite ${pageNumber} ---`,
    `## Page ${pageNumber}`,
    `## Seite ${pageNumber}`,
  ];

  for (const marker of markers) {
    const pageIndex = storyText.indexOf(marker);
    if (pageIndex === -1) continue;

    const textStart = pageIndex + marker.length;
    // Find start of next page (any format)
    const nextMatch = storyText.substring(textStart).match(/(?:---\s*(?:Page|Seite)\s+\d+\s*---|##\s*(?:Page|Seite)\s+\d+)/i);
    const textEnd = nextMatch ? textStart + nextMatch.index : storyText.length;

    return storyText.substring(textStart, textEnd).trim();
  }

  return null;
}

// ============================================
// API ROUTER - Mount at /api
// ============================================

// NOTE: Share auth endpoints (share-status, enable/disable sharing) are in stories.js
// They are mounted at /api/stories before this router, so they handle those requests.

// GET /api/shared/:shareToken - Get shared story data (public or owner)
// GET /api/shared/:shareToken/header — slim metadata for first paint.
// Returns just what the title page + cover preload + per-page overlay
// pre-fire need: title, language, page count, cover existence, ownership
// flags. NO JSONB blob fetch — uses Postgres' `->>` JSON extraction so
// PG only ships the scalars over the wire (the full data column for some
// stories is multi-MB and dominated the old endpoint's wall time).
apiRouter.get('/shared/:shareToken/header', async (req, res) => {
  try {
    const { shareToken } = req.params;
    if (!shareToken || shareToken.length !== 64) {
      return res.status(404).json({ error: 'Story not found or sharing disabled' });
    }
    const userId = req.user?.id || null;
    const rows = await dbQuery(
      `SELECT id,
              user_id,
              is_shared,
              data->>'title'         AS title,
              data->>'language'      AS language,
              data->>'languageLevel' AS language_level,
              data->'layout'         AS layout,
              jsonb_array_length(COALESCE(data->'sceneImages', '[]'::jsonb)) AS page_count
         FROM stories
        WHERE share_token = $1
          AND (is_shared = true OR user_id = $2)`,
      [shareToken, userId]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Story not found or sharing disabled' });
    }
    const row = rows[0];
    const isOwner = !!userId && userId === row.user_id;
    let needsPassword = false;
    if (isOwner) {
      const ur = await dbQuery('SELECT password FROM users WHERE id = $1', [userId]);
      needsPassword = ur.length > 0 && !ur[0].password;
    }
    // Cover existence — same Set-returning helper the fat endpoint uses.
    const coverTypes = ['frontCover', 'initialPage', 'backCover'];
    const existing = await imagesExistByType(row.id, coverTypes);
    const covers = {};
    for (const t of coverTypes) covers[t] = existing.has(t);

    // Direct R2 URL for the front cover so the client can fetch the image
    // without the 302 redirect through /api/shared/<token>/cover-image — saves
    // one round-trip on first paint.
    let frontCoverUrl = null;
    if (covers.frontCover) {
      const activeIdx = await getActiveVersion(row.id, 'frontCover');
      const img = await getStoryImage(row.id, 'frontCover', null, activeIdx);
      if (img?.imageUrl) frontCoverUrl = img.imageUrl;
    }

    res.json({
      id: row.id,
      title: row.title,
      language: row.language,
      languageLevel: row.language_level || 'standard',
      layout: row.layout || null,
      pageCount: row.page_count || 0,
      covers,
      frontCoverUrl,
      isOwner,
      isShared: row.is_shared,
      needsPassword,
    });
  } catch (err) {
    log.error('Error fetching shared story header:', err);
    res.status(500).json({ error: 'Failed to load story header' });
  }
});

apiRouter.get('/shared/:shareToken', async (req, res) => {
  try {
    const { shareToken } = req.params;
    const story = await getSharedStory(shareToken, req.user?.id);

    if (!story) {
      return res.status(404).json({ error: 'Story not found or sharing disabled' });
    }

    const isOwner = !!req.user && req.user.id === story.userId;

    // Check if owner needs to set a password (trial user without password)
    let needsPassword = false;
    if (isOwner) {
      const userResult = await dbQuery('SELECT password FROM users WHERE id = $1', [req.user.id]);
      needsPassword = userResult.length > 0 && !userResult[0].password;
    }

    // Return only safe public data (no user info, no prompts)
    const data = story.data;

    // Extract pages from story text (format: "## Seite N\ntext..." or "--- Page N ---\ntext...")
    const pages = [];
    const storyText = data.story || data.storyText || data.generatedStory || '';
    const sceneCount = data.sceneImages?.length || data.totalScenes || data.pages || 10;
    for (let i = 1; i <= sceneCount; i++) {
      const text = getPageText(storyText, i);
      if (text) {
        const sceneImg = data.sceneImages?.find(s => Number(s.pageNumber) === i);
        pages.push({
          pageNumber: i,
          text,
          textPosition: sceneImg?.textPosition || null,
        });
      }
    }

    // Cover existence — single round-trip, no blob fetch. The previous loop
    // ran 3× getActiveVersion + getStoryImage, and getStoryImage pulled the
    // full image_data bytea (multi-MB) just to check a yes/no flag — that
    // alone added ~3s to every shared-viewer load. imagesExistByType returns
    // a Set in one query, no version traversal, no blob transfer.
    //
    // The fetch endpoint /shared/.../cover-image/:coverType still resolves
    // the active version and falls back to v0 — so "exists in any version"
    // is the right signal for whether the page list should include the cover.
    const coverTypes = ['frontCover', 'initialPage', 'backCover'];
    const existing = await imagesExistByType(story.id, coverTypes);
    const covers = {};
    for (const coverType of coverTypes) {
      covers[coverType] = existing.has(coverType)
        || !!data.coverImages?.[coverType]?.imageData; // legacy fallback
    }

    res.json({
      id: story.id,
      title: data.title,
      language: data.language,
      languageLevel: data.languageLevel || 'standard',
      // layout.textInImage=false means the scene was NOT generated with a
      // reserved calm zone — the viewer must render the text in a strip
      // below the image (square layout, advanced reading level) instead of
      // overlaying it.
      layout: data.layout || null,
      pageCount: pages.length,
      pages,
      dedication: data.dedication,
      hasImages: true,
      covers,
      isOwner,
      isShared: story.isShared,
      needsPassword,
    });
  } catch (err) {
    log.error('Error fetching shared story:', err);
    res.status(500).json({ error: 'Failed to load story' });
  }
});

// Safety net for legacy images written before write-time A4 normalization
// landed. New images come out of the DB already at A4 so this is a no-op for
// them. Old 896×1280 stored rows still get the tiny crop here.
async function normalizeToPortrait(imageBuffer) {
  try {
    const { normalizeImageToA4 } = require('../lib/aspectNormalize');
    const base64 = imageBuffer.toString('base64');
    const normalized = await normalizeImageToA4(base64);
    return normalized === base64 ? imageBuffer : Buffer.from(normalized, 'base64');
  } catch (err) {
    log.warn(`[NORMALIZE] Failed: ${err.message}`);
    return imageBuffer;
  }
}

// Detect image content-type from buffer magic bytes (JPEG/PNG/GIF/WebP).
// Covers the mix of formats that flow through sharing routes (legacy PNG +
// new JPEG from the A4 write-time normalize).
function sniffImageMime(buf) {
  if (!buf || buf.length < 8) return 'image/jpeg';
  if (buf[0] === 0xFF && buf[1] === 0xD8) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif';
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) return 'image/webp';
  return 'image/jpeg';
}

// GET /api/shared/:shareToken/image/:pageNumber - Get shared story page image
apiRouter.get('/shared/:shareToken/image/:pageNumber', async (req, res) => {
  try {
    const { shareToken, pageNumber } = req.params;
    const pageNum = parseInt(pageNumber, 10);

    // Fast path: get only story ID, then fetch image from separate table
    const storyId = await getSharedStoryId(shareToken, req.user?.id);
    if (!storyId) {
      return res.status(404).json({ error: 'Story not found or sharing disabled' });
    }

    // Try active version first, fall back to version 0 if not found
    const activeVersion = await getActiveVersion(storyId, pageNum);
    let separateImage = await getStoryImage(storyId, 'scene', pageNum, activeVersion);
    if (!separateImage?.imageData && !separateImage?.imageUrl && activeVersion !== 0) {
      separateImage = await getStoryImage(storyId, 'scene', pageNum, 0);
    }
    // Prefer R2 URL (free egress, CDN-cached) when available; fall back to bytes.
    if (separateImage?.imageUrl) {
      res.set('Cache-Control', 'public, max-age=86400');
      return res.redirect(302, separateImage.imageUrl);
    }
    if (separateImage?.imageData) {
      const base64 = separateImage.imageData.replace(/^data:image\/\w+;base64,/, '');
      // Serve the image at its stored dims. Old code ran normalizeToPortrait
      // here (cover-cropping every scene to A4 on the fly), which silently
      // sliced ~6% off the sides of new 3:4 / 1:1 stories whose layout
      // explicitly asked for non-A4 aspects. The image is already at the
      // aspect the generator was asked for — don't second-guess it at serve
      // time.
      const imageBuffer = Buffer.from(base64, 'base64');
      res.set('Content-Type', sniffImageMime(imageBuffer));
      res.set('Cache-Control', 'public, max-age=86400');
      return res.send(imageBuffer);
    }

    // Fallback: fetch full story data for legacy sceneImages array
    const story = await getSharedStory(shareToken, req.user?.id);
    if (!story) {
      return res.status(404).json({ error: 'Image not found' });
    }
    const sceneImage = story.data.sceneImages?.find(img => img.pageNumber === pageNum);
    const imageData = sceneImage?.imageData;
    if (!imageData) {
      return res.status(404).json({ error: 'Image not found' });
    }

    const base64Data = imageData.replace(/^data:image\/\w+;base64,/, '');
    const imageBuffer = Buffer.from(base64Data, 'base64');
    res.set('Content-Type', sniffImageMime(imageBuffer));
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(imageBuffer);
  } catch (err) {
    log.error('Error fetching shared story image:', err);
    res.status(500).json({ error: 'Failed to load image' });
  }
});

// POST /api/shared/:shareToken/text-overlay/:pageNumber - Render text overlay for shared story page
apiRouter.post('/shared/:shareToken/text-overlay/:pageNumber', async (req, res) => {
  try {
    const { shareToken, pageNumber } = req.params;
    const pageNum = parseInt(pageNumber, 10);

    const storyId = await getSharedStoryId(shareToken, req.user?.id);
    if (!storyId) {
      return res.status(404).json({ error: 'Story not found or sharing disabled' });
    }

    // Custom text override skips the cache (rare path — only when a caller
    // explicitly passes a different text body).
    const customText = req.body?.text;
    const activeVersion = await getActiveVersion(storyId, pageNum);

    // Cache lookup BEFORE doing any of the heavy work (image fetch, sharp,
    // canvas). Only when no custom text override.
    if (!customText) {
      const cacheKey = `${storyId}:${pageNum}:${activeVersion}`;
      const cached = cacheGet(cacheKey);
      if (cached) {
        res.set('Cache-Control', 'private, max-age=3600');
        return res.json({ overlayImage: cached });
      }
    }

    // Get the page image
    let separateImage = await getStoryImage(storyId, 'scene', pageNum, activeVersion);
    if (!separateImage?.imageData && !separateImage?.imageUrl && activeVersion !== 0) {
      separateImage = await getStoryImage(storyId, 'scene', pageNum, 0);
    }
    if (!separateImage?.imageData && !separateImage?.imageUrl) {
      return res.status(404).json({ error: 'Page image not found' });
    }

    // Get text and textPosition from story data
    let text = req.body?.text;
    let textPosition = null;

    const metaRows = await dbQuery(
      `SELECT scene->>'textPosition' as text_position, scene->>'text' as page_text
       FROM stories, jsonb_array_elements(data::jsonb->'sceneImages') AS scene
       WHERE stories.id = $1 AND (scene->>'pageNumber')::int = $2`,
      [storyId, pageNum]
    );

    if (metaRows.length > 0) {
      textPosition = metaRows[0].text_position || null;
      if (!text) {
        text = metaRows[0].page_text || '';
      }
    }

    if (!text) {
      // Fallback: parse story text
      const dataRows = await dbQuery('SELECT data FROM stories WHERE id = $1', [storyId]);
      if (dataRows.length > 0) {
        const storyData = typeof dataRows[0].data === 'string' ? JSON.parse(dataRows[0].data) : dataRows[0].data;
        const storyText = storyData.story || storyData.storyText || '';
        const { parseStoryPages } = require('../lib/storyHelpers');
        const pages = parseStoryPages(storyText, storyData.sceneImages?.length || 10);
        text = pages[pageNum - 1] || '';
      }
    }

    if (!text || !text.trim()) {
      return res.status(400).json({ error: 'No text available for this page' });
    }

    // Enforce spread position rule
    const { enforceSpreadTextPosition } = require('../lib/storyHelpers');
    textPosition = enforceSpreadTextPosition(textPosition, pageNum);

    // Generate the overlay — normalize the image to the same 3:4 aspect we serve
    // so the overlay polygon and the displayed image line up pixel-for-pixel.
    // After R2 migration image_data may be NULL — fetch from imageUrl as fallback.
    const { generateTextOverlay } = require('../lib/textOverlayRenderer');
    let rawBuf;
    if (separateImage.imageData) {
      const imgBase64 = separateImage.imageData.replace(/^data:image\/\w+;base64,/, '');
      rawBuf = Buffer.from(imgBase64, 'base64');
    } else if (separateImage.imageUrl) {
      const { fetchImageBytes } = require('../lib/r2');
      rawBuf = await fetchImageBytes(separateImage.imageUrl);
      if (!rawBuf) return res.status(502).json({ error: 'Failed to fetch image bytes from storage' });
    } else {
      return res.status(404).json({ error: 'Page image not found' });
    }
    // No A4 normalize here — overlay must align pixel-for-pixel with the
    // image served from /shared/.../image/:pageNumber, which now keeps the
    // stored dims. Build the overlay against the same buffer the user sees.
    const imgBuffer = rawBuf;

    // Pick the mask size the page was generated with (so the polygon matches
    // the dark area the image model was asked to paint).
    let languageLevel = 'standard';
    try {
      const lvlRows = await dbQuery(
        `SELECT data->>'languageLevel' as lvl FROM stories WHERE id = $1`,
        [storyId]
      );
      if (lvlRows.length > 0 && lvlRows[0].lvl) languageLevel = lvlRows[0].lvl;
    } catch { /* non-critical */ }

    const result = await generateTextOverlay(imgBuffer, text.trim(), textPosition || 'bottom-left', { languageLevel, pageNumber: pageNum });

    const overlayBase64 = result.overlayImage.toString('base64');
    const dataUrl = `data:image/png;base64,${overlayBase64}`;

    // Populate cache for future requests (skip when caller supplied custom text).
    if (!customText) {
      cacheSet(`${storyId}:${pageNum}:${activeVersion}`, dataUrl);
    }

    res.set('Cache-Control', 'private, max-age=3600');
    res.json({ overlayImage: dataUrl });
  } catch (err) {
    log.error('Error generating shared text overlay:', err);
    res.status(500).json({ error: 'Failed to generate text overlay' });
  }
});

// GET /api/shared/:shareToken/cover-image/:coverType - Get shared story cover image
apiRouter.get('/shared/:shareToken/cover-image/:coverType', async (req, res) => {
  try {
    const { shareToken, coverType } = req.params;

    // Fast path: get only story ID, then fetch cover from separate table
    const storyId = await getSharedStoryId(shareToken, req.user?.id);
    if (!storyId) {
      return res.status(404).json({ error: 'Story not found or sharing disabled' });
    }

    // Use the active version (selected by user), not always version 0
    const activeVersionIdx = await getActiveVersion(storyId, coverType);
    const separateImage = await getStoryImage(storyId, coverType, null, activeVersionIdx);
    // Prefer R2 URL when available.
    if (separateImage?.imageUrl) {
      res.set('Cache-Control', 'public, max-age=86400');
      return res.redirect(302, separateImage.imageUrl);
    }
    if (separateImage?.imageData) {
      const base64 = separateImage.imageData.replace(/^data:image\/\w+;base64,/, '');
      const imageBuffer = await normalizeToPortrait(Buffer.from(base64, 'base64'));
      res.set('Content-Type', sniffImageMime(imageBuffer));
      res.set('Cache-Control', 'public, max-age=86400');
      return res.send(imageBuffer);
    }

    // Fallback: fetch full story data for legacy coverImages
    const story = await getSharedStory(shareToken, req.user?.id);
    if (!story) {
      return res.status(404).json({ error: 'Cover not found' });
    }
    const coverObj = story.data.coverImages?.[coverType];
    const coverImageData = coverObj?.imageData;
    if (!coverImageData) {
      return res.status(404).json({ error: 'Cover not found' });
    }

    const base64Data = coverImageData.replace(/^data:image\/\w+;base64,/, '');
    const imageBuffer = Buffer.from(base64Data, 'base64');
    res.set('Content-Type', sniffImageMime(imageBuffer));
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(imageBuffer);
  } catch (err) {
    log.error('Error fetching shared story cover:', err);
    res.status(500).json({ error: 'Failed to load cover' });
  }
});

// GET /api/shared/:shareToken/og-image.jpg - Generate Open Graph image (1200x630 for social)
// The .jpg extension helps WhatsApp/Facebook crawlers recognize this as an image URL.
// Also supports /og-image without extension for backwards compatibility.
apiRouter.get('/shared/:shareToken/og-image.jpg', ogImageHandler);
apiRouter.get('/shared/:shareToken/og-image', ogImageHandler);

async function ogImageHandler(req, res) {
  try {
    const { shareToken } = req.params;

    // Fast path: get only story ID, then fetch cover from separate table
    const storyId = await getSharedStoryId(shareToken, req.user?.id);
    if (!storyId) {
      log.warn(`[OG-IMAGE] Story not found for shareToken: ${shareToken.substring(0, 8)}...`);
      return res.status(404).json({ error: 'Story not found or sharing disabled' });
    }

    log.debug(`[OG-IMAGE] Fetching frontCover for story ${storyId}`);
    // Use the active version (user-selected), not always version 0
    const activeFrontCoverVersion = await getActiveVersion(storyId, 'frontCover');
    const coverImageResult = await getStoryImage(storyId, 'frontCover', null, activeFrontCoverVersion);
    let coverImage = coverImageResult?.imageData?.replace(/^data:image\/\w+;base64,/, '') || null;

    if (coverImage) {
      log.debug(`[OG-IMAGE] Found frontCover in story_images table (${coverImage.length} chars)`);
    } else {
      log.debug(`[OG-IMAGE] frontCover not in story_images, trying legacy fallback...`);
    }

    // Fallback: fetch full story data for legacy coverImages
    if (!coverImage) {
      const story = await getSharedStory(shareToken, req.user?.id);
      if (story?.data.coverImages?.frontCover) {
        const fc = story.data.coverImages.frontCover;
        log.debug(`[OG-IMAGE] Legacy frontCover type: ${typeof fc}, keys: ${typeof fc === 'object' ? Object.keys(fc).join(',') : 'N/A'}`);
        const fcData = typeof fc === 'string' ? fc : fc?.imageData;
        if (fcData) {
          coverImage = fcData.replace(/^data:image\/\w+;base64,/, '');
          log.debug(`[OG-IMAGE] Found legacy frontCover (${coverImage.length} chars)`);
        } else {
          log.warn(`[OG-IMAGE] Legacy frontCover exists but no imageData - was it stripped? Keys: ${typeof fc === 'object' ? Object.keys(fc).join(',') : 'N/A'}`);
        }
      } else {
        log.warn(`[OG-IMAGE] No coverImages.frontCover in story data`);
      }
    }

    // Fallback 2: use first page image if no cover exists (covers may be skipped)
    if (!coverImage) {
      log.debug(`[OG-IMAGE] No cover found, trying first page image...`);
      const activePage1Version = await getActiveVersion(storyId, 1);
      const pageImageResult = await getStoryImage(storyId, 'scene', 1, activePage1Version);
      if (pageImageResult?.imageData) {
        coverImage = pageImageResult.imageData.replace(/^data:image\/\w+;base64,/, '');
        log.debug(`[OG-IMAGE] Using page 1 image as fallback (${coverImage.length} chars)`);
      }
    }

    if (!coverImage) {
      log.error(`[OG-IMAGE] No image found for story ${storyId} - cover, legacy, and page fallbacks all failed`);
      return res.status(404).json({ error: 'Cover image not found' });
    }

    // Fast OG image: single resize to 1200x630 (fit: cover crops to fill).
    // Previous version did blur + composite (4 sharp ops) which was too slow for WhatsApp's ~5s timeout.
    const imageBuffer = Buffer.from(coverImage, 'base64');
    const ogImage = await sharp(imageBuffer)
      .resize(1200, 630, { fit: 'cover', position: 'centre' })
      .jpeg({ quality: 85 })
      .toBuffer();

    log.debug(`[OG-IMAGE] Generated ${ogImage.length} bytes for story ${storyId}`);
    res.set('Content-Type', 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=86400');
    // Override Helmet's same-origin policy — WhatsApp/Facebook fetches from cross-origin
    res.set('Cross-Origin-Resource-Policy', 'cross-origin');
    res.set('Access-Control-Allow-Origin', '*');
    res.send(ogImage);
  } catch (err) {
    log.error('Error generating OG image:', err);
    res.status(500).json({ error: 'Failed to generate preview image' });
  }
}

// ============================================
// HTML ROUTER - Mount at root
// Social preview pages with OG meta tags
// ============================================

// GET /s/:shareToken - Serve HTML with OG meta tags for WhatsApp/social previews
// This is the PRIMARY sharing URL. It returns a tiny HTML with just OG tags,
// then redirects to /shared/:shareToken for the actual React app.
// WhatsApp's lightweight crawler parses this easily (no scripts/styles/fonts to wade through).
htmlRouter.get('/s/:shareToken', async (req, res) => {
  const { shareToken } = req.params;

  try {
    const story = await getSharedStory(shareToken, req.user?.id);

    if (story) {
      // Strip markdown bold/heading markers, then HTML-escape for safe meta tags
      const rawTitle = (story.data.title || 'Eine magische Geschichte')
        .replace(/^\*{1,2}|\*{1,2}$/g, '').replace(/^#+\s*/, '').trim();
      const title = rawTitle.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const description = `Eine personalisierte Geschichte von MagicalStory.ch`;
      // Cache buster: rotate daily so WhatsApp/Facebook re-fetch after fixes or image changes
      const ogCacheBuster = Math.floor(Date.now() / 86400000);
      const ogImageUrl = `${SITE_URL}/api/shared/${shareToken}/og-image.jpg?v=${ogCacheBuster}`;
      const pageUrl = `${SITE_URL}/s/${shareToken}`;

      // Minimal HTML with ONLY OG tags — nothing else. WhatsApp parses this reliably.
      const html = `<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8">
  <meta property="og:type" content="article">
  <meta property="og:url" content="${pageUrl}">
  <meta property="og:title" content="${title}">
  <meta property="og:description" content="${description}">
  <meta property="og:image" content="${ogImageUrl}">
  <meta property="og:image:secure_url" content="${ogImageUrl}">
  <meta property="og:image:type" content="image/jpeg">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:site_name" content="MagicalStory">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${title}">
  <meta name="twitter:image" content="${ogImageUrl}">
  <title>${title}</title>
  <meta http-equiv="refresh" content="0;url=${SITE_URL}/shared/${shareToken}">
</head>
<body>
  <p>Weiterleitung zu <a href="/shared/${shareToken}">${rawTitle}</a>...</p>
</body>
</html>`;

      // Override Helmet's same-origin CORP so social crawlers (WhatsApp, Facebook) can read OG tags
      res.set('Cross-Origin-Resource-Policy', 'cross-origin');
      res.type('text/html').send(html);
    } else {
      // Story not found - redirect to home
      res.redirect('/');
    }
  } catch (err) {
    log.error('Error serving shared story OG page:', err);
    res.redirect('/');
  }
});

// GET /shared/:shareToken - Serve React app with OG meta tags for social previews
// AND a cover-image preload hint for first-paint perf.
//
// Two passes through the same HTML response:
//   - OG tags: only when the story is PUBLICLY shared (getSharedStory matches
//     is_shared=true) — social crawlers can't be authenticated.
//   - Cover preload + preconnect: always when the token resolves to a story,
//     even private ones owned by a logged-in user. Preconnect to the R2
//     origin saves DNS+TLS handshake on first paint (~150 ms). The actual
//     <link rel=preload> with the R2 cover URL is only added for public
//     stories (we don't want to leak private R2 paths in HTML).
htmlRouter.get('/shared/:shareToken', async (req, res) => {
  const { shareToken } = req.params;
  log.debug(`[SHARED] Request for /shared/${shareToken.substring(0, 8)}...`);

  try {
    if (!hasDistFolder) {
      return res.redirect('/');
    }

    // Story for OG tags — needs public access OR ownership.
    const story = await getSharedStory(shareToken, req.user?.id);

    // Token-only existence check for the perf hints. Even if OG tags can't
    // be added (private story, anonymous request), we still want to inject
    // preconnect so the eventual cover fetch is faster.
    let storyId = null;
    let isPublic = false;
    let coverUrl = null;
    if (shareToken && shareToken.length === 64) {
      const rows = await dbQuery(
        'SELECT id, is_shared FROM stories WHERE share_token = $1',
        [shareToken]
      );
      if (rows.length > 0) {
        storyId = rows[0].id;
        isPublic = !!rows[0].is_shared;
        if (isPublic) {
          try {
            const activeIdx = await getActiveVersion(storyId, 'frontCover');
            const img = await getStoryImage(storyId, 'frontCover', null, activeIdx);
            if (img?.imageUrl) coverUrl = img.imageUrl;
          } catch { /* fall through — preconnect-only */ }
        }
      }
    }

    log.debug(`[SHARED] Story found: ${!!story}, public: ${isPublic}, coverUrl: ${!!coverUrl}, hasDistFolder: ${hasDistFolder}`);

    if (!storyId) {
      // Token unknown — let the SPA shell handle it.
      return res.sendFile(path.join(distPath, 'index.html'));
    }

    const indexPath = path.join(distPath, 'index.html');
    let html = await fs.readFile(indexPath, 'utf8');

    // ── First-paint hints ─────────────────────────────────────────────
    // Always add preconnect to the R2 origin (saves ~150 ms DNS+TLS on
    // first cover fetch). Add the specific cover URL preload only for
    // public stories.
    const r2Origin = coverUrl ? new URL(coverUrl).origin : 'https://images.magicalstory.ch';
    let perfHints = `<link rel="preconnect" href="${r2Origin}" crossorigin>`;
    if (coverUrl) {
      perfHints += `<link rel="preload" as="image" href="${coverUrl}" fetchpriority="high">`;
    }

    // ── OG tags (only when story is public and getSharedStory matched) ─
    if (story) {
      const rawTitle = (story.data.title || 'Eine magische Geschichte')
        .replace(/^\*{1,2}|\*{1,2}$/g, '').replace(/^#+\s*/, '').trim();
      const title = rawTitle.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const description = `Eine personalisierte Geschichte von MagicalStory.ch`;
      const ogCacheBuster = Math.floor(Date.now() / 86400000);
      const ogImageUrl = `${SITE_URL}/api/shared/${shareToken}/og-image.jpg?v=${ogCacheBuster}`;
      const pageUrl = `${SITE_URL}/shared/${shareToken}`;

      const ogTags = `
  <!-- Story-specific Open Graph / Facebook / WhatsApp -->
  <meta property="og:type" content="article">
  <meta property="og:url" content="${pageUrl}">
  <meta property="og:title" content="${title}">
  <meta property="og:description" content="${description}">
  <meta property="og:image" content="${ogImageUrl}">
  <meta property="og:image:secure_url" content="${ogImageUrl}">
  <meta property="og:image:type" content="image/jpeg">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:site_name" content="MagicalStory">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${title}">
  <meta name="twitter:description" content="${description}">
  <meta name="twitter:image" content="${ogImageUrl}">
  <title>${title} - MagicalStory</title>`;

      html = html.replace(/<meta property="og:[^>]*>\s*/g, '');
      html = html.replace(/<meta name="twitter:[^>]*>\s*/g, '');
      html = html.replace(/<title>[^<]*<\/title>/, '');
      html = html.replace(/<link rel="canonical"[^>]*>\s*/g, '');
      html = html.replace('<head>', '<head>' + ogTags);

      res.set('Cross-Origin-Resource-Policy', 'cross-origin');
    }

    // Inject perf hints right before </head> so they parse last but still
    // fire during HTML parse (preconnect/preload are processed eagerly).
    html = html.replace('</head>', `${perfHints}</head>`);
    res.type('text/html').send(html);
  } catch (err) {
    log.error('Error serving shared story page:', err);
    if (hasDistFolder) {
      res.sendFile(path.join(distPath, 'index.html'));
    } else {
      res.redirect('/');
    }
  }
});

module.exports = {
  apiRouter,
  htmlRouter,
  initSharingRoutes
};
