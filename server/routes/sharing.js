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

const { dbQuery, getStoryImage, getActiveVersion } = require('../services/database');
const { log } = require('../utils/logger');
const { verifyToken } = require('../middleware/auth');

// Base URL for OG tags and share links (consistent with stories.js)
const SITE_URL = process.env.FRONTEND_URL || 'https://www.magicalstory.ch';

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

    // Check which covers exist. Use the ACTIVE version, not hardcoded 0 —
    // a regenerated cover may live at version 1+ with no data at version 0,
    // which would previously make the check falsely return "no cover" and
    // cause the frontend to omit the cover from the page list entirely.
    const coverTypes = ['frontCover', 'initialPage', 'backCover'];
    const covers = {};
    for (const coverType of coverTypes) {
      const activeIdx = await getActiveVersion(story.id, coverType);
      const img = await getStoryImage(story.id, coverType, null, activeIdx);
      if (img?.imageData) {
        covers[coverType] = true;
      } else {
        // Fallback: check legacy coverImages in story data
        covers[coverType] = !!data.coverImages?.[coverType]?.imageData;
      }
    }

    res.json({
      id: story.id,
      title: data.title,
      language: data.language,
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

// Normalize image to A4 portrait aspect (210/297 = 0.7071) so what the viewer
// shows matches the printed book 1:1. Grok's "3:4" preset natively returns
// 896×1280 (ratio 0.700), ~13px off A4 — a tiny invisible crop. True squares
// from legacy repair output also get snapped here.
async function normalizeToPortrait(imageBuffer) {
  try {
    const sharp = require('sharp');
    const meta = await sharp(imageBuffer).metadata();
    const TARGET_RATIO = 210 / 297; // A4 portrait
    const currentRatio = meta.width / meta.height;
    // Within 0.5% of A4 → no-op. Tighter than drift catches Grok's 0.700
    // output (1% off A4) and snaps it to exact 0.7071 — invisible 13px crop.
    if (Math.abs(currentRatio - TARGET_RATIO) / TARGET_RATIO < 0.005) {
      return imageBuffer;
    }
    // Pick output size based on existing dimensions
    const targetHeight = Math.max(meta.height, Math.round(meta.width / TARGET_RATIO));
    const targetWidth = Math.round(targetHeight * TARGET_RATIO);
    return await sharp(imageBuffer)
      .resize(targetWidth, targetHeight, { fit: 'cover', position: 'centre' })
      .png()
      .toBuffer();
  } catch (err) {
    log.warn(`[NORMALIZE] Failed to normalize image: ${err.message}`);
    return imageBuffer;
  }
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
    if (!separateImage?.imageData && activeVersion !== 0) {
      separateImage = await getStoryImage(storyId, 'scene', pageNum, 0);
    }
    if (separateImage?.imageData) {
      const base64 = separateImage.imageData.replace(/^data:image\/\w+;base64,/, '');
      const imageBuffer = await normalizeToPortrait(Buffer.from(base64, 'base64'));
      res.set('Content-Type', 'image/png');
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
    res.set('Content-Type', 'image/png');
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

    // Get the page image
    const activeVersion = await getActiveVersion(storyId, pageNum);
    let separateImage = await getStoryImage(storyId, 'scene', pageNum, activeVersion);
    if (!separateImage?.imageData && activeVersion !== 0) {
      separateImage = await getStoryImage(storyId, 'scene', pageNum, 0);
    }
    if (!separateImage?.imageData) {
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
    const { generateTextOverlay } = require('../lib/textOverlayRenderer');
    const imgBase64 = separateImage.imageData.replace(/^data:image\/\w+;base64,/, '');
    const imgBuffer = await normalizeToPortrait(Buffer.from(imgBase64, 'base64'));

    const result = await generateTextOverlay(imgBuffer, text.trim(), textPosition || 'bottom-left');

    const overlayBase64 = result.overlayImage.toString('base64');
    res.json({
      overlayImage: `data:image/png;base64,${overlayBase64}`,
    });
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
    if (separateImage?.imageData) {
      const base64 = separateImage.imageData.replace(/^data:image\/\w+;base64,/, '');
      const imageBuffer = await normalizeToPortrait(Buffer.from(base64, 'base64'));
      res.set('Content-Type', 'image/png');
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
    res.set('Content-Type', 'image/png');
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
// This is the URL users copy from browser, needs OG tags for WhatsApp/Facebook
htmlRouter.get('/shared/:shareToken', async (req, res) => {
  const { shareToken } = req.params;
  log.debug(`[SHARED] Request for /shared/${shareToken.substring(0, 8)}...`);

  try {
    const story = await getSharedStory(shareToken, req.user?.id);
    log.debug(`[SHARED] Story found: ${!!story}, hasDistFolder: ${hasDistFolder}`);

    if (story && hasDistFolder) {
      // Read the index.html
      const indexPath = path.join(distPath, 'index.html');
      let html = await fs.readFile(indexPath, 'utf8');

      const rawTitle = (story.data.title || 'Eine magische Geschichte')
        .replace(/^\*{1,2}|\*{1,2}$/g, '').replace(/^#+\s*/, '').trim();
      const title = rawTitle.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const description = `Eine personalisierte Geschichte von MagicalStory.ch`;
      // Cache buster: rotate daily so WhatsApp/Facebook re-fetch after fixes or image changes
      const ogCacheBuster = Math.floor(Date.now() / 86400000);
      const ogImageUrl = `${SITE_URL}/api/shared/${shareToken}/og-image.jpg?v=${ogCacheBuster}`;
      const pageUrl = `${SITE_URL}/shared/${shareToken}`;

      // Create OG meta tags
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

      // Replace the default OG tags and title with story-specific ones
      // Remove existing OG tags
      html = html.replace(/<meta property="og:[^>]*>\s*/g, '');
      html = html.replace(/<meta name="twitter:[^>]*>\s*/g, '');
      // Replace title
      html = html.replace(/<title>[^<]*<\/title>/, '');
      // Remove canonical URL (points to homepage, confuses WhatsApp/Facebook crawler)
      html = html.replace(/<link rel="canonical"[^>]*>\s*/g, '');
      // Insert story-specific tags after <head>
      html = html.replace('<head>', '<head>' + ogTags);

      // Override Helmet's same-origin CORP so social crawlers (WhatsApp, Facebook) can read OG tags
      res.set('Cross-Origin-Resource-Policy', 'cross-origin');
      res.type('text/html').send(html);
    } else {
      // Story not found or no dist folder - serve default
      if (hasDistFolder) {
        res.sendFile(path.join(distPath, 'index.html'));
      } else {
        res.redirect('/');
      }
    }
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
