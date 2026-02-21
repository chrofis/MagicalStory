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

const { dbQuery, getStoryImage } = require('../services/database');
const { log } = require('../utils/logger');

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
 * Get shared story by token (validates is_shared = true)
 */
async function getSharedStory(shareToken) {
  if (!shareToken || shareToken.length !== 64) {
    return null;
  }
  const rows = await dbQuery(
    'SELECT id, data FROM stories WHERE share_token = $1 AND is_shared = true',
    [shareToken]
  );
  if (rows.length === 0) {
    return null;
  }
  // Parse data if it's a JSON string
  const data = typeof rows[0].data === 'string' ? JSON.parse(rows[0].data) : rows[0].data;
  return { id: rows[0].id, data };
}

/**
 * Get shared story ID only (fast path for image endpoints)
 */
async function getSharedStoryId(shareToken) {
  if (!shareToken || shareToken.length !== 64) {
    return null;
  }
  const rows = await dbQuery(
    'SELECT id FROM stories WHERE share_token = $1 AND is_shared = true',
    [shareToken]
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

  // Handle string format with page markers
  const pageMarker = `--- Page ${pageNumber} ---`;
  const pageIndex = storyText.indexOf(pageMarker);
  if (pageIndex === -1) return null;

  const textStart = pageIndex + pageMarker.length;
  const nextPageMarker = storyText.indexOf('--- Page ', textStart);
  const textEnd = nextPageMarker === -1 ? storyText.length : nextPageMarker;

  return storyText.substring(textStart, textEnd).trim();
}

// ============================================
// API ROUTER - Mount at /api
// ============================================

// NOTE: Share auth endpoints (share-status, enable/disable sharing) are in stories.js
// They are mounted at /api/stories before this router, so they handle those requests.

// GET /api/shared/:shareToken - Get shared story data (public, no auth)
apiRouter.get('/shared/:shareToken', async (req, res) => {
  try {
    const { shareToken } = req.params;
    const story = await getSharedStory(shareToken);

    if (!story) {
      return res.status(404).json({ error: 'Story not found or sharing disabled' });
    }

    // Return only safe public data (no user info, no prompts)
    const data = story.data;

    // Extract pages from storyText (format: "--- Page N ---\ntext...")
    const pages = [];
    const pageCount = data.pageCount || data.pages || 10;
    for (let i = 1; i <= pageCount; i++) {
      const text = getPageText(data.storyText || data.generatedStory, i);
      if (text) {
        pages.push({ pageNumber: i, text });
      }
    }

    res.json({
      id: story.id,
      title: data.title,
      language: data.language,
      pageCount: pageCount,
      pages,
      dedication: data.dedication,
      // Image URLs (client will fetch separately)
      hasImages: true
    });
  } catch (err) {
    log.error('Error fetching shared story:', err);
    res.status(500).json({ error: 'Failed to load story' });
  }
});

// GET /api/shared/:shareToken/image/:pageNumber - Get shared story page image
apiRouter.get('/shared/:shareToken/image/:pageNumber', async (req, res) => {
  try {
    const { shareToken, pageNumber } = req.params;
    const pageNum = parseInt(pageNumber, 10);

    // Fast path: get only story ID, then fetch image from separate table
    const storyId = await getSharedStoryId(shareToken);
    if (!storyId) {
      return res.status(404).json({ error: 'Story not found or sharing disabled' });
    }

    const separateImage = await getStoryImage(storyId, 'scene', pageNum, 0);
    if (separateImage?.imageData) {
      const base64 = separateImage.imageData.replace(/^data:image\/\w+;base64,/, '');
      const imageBuffer = Buffer.from(base64, 'base64');
      res.set('Content-Type', 'image/png');
      res.set('Cache-Control', 'public, max-age=86400');
      return res.send(imageBuffer);
    }

    // Fallback: fetch full story data for legacy sceneImages array
    const story = await getSharedStory(shareToken);
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

// GET /api/shared/:shareToken/cover-image/:coverType - Get shared story cover image
apiRouter.get('/shared/:shareToken/cover-image/:coverType', async (req, res) => {
  try {
    const { shareToken, coverType } = req.params;

    // Fast path: get only story ID, then fetch cover from separate table
    const storyId = await getSharedStoryId(shareToken);
    if (!storyId) {
      return res.status(404).json({ error: 'Story not found or sharing disabled' });
    }

    const separateImage = await getStoryImage(storyId, coverType, null, 0);
    if (separateImage?.imageData) {
      const base64 = separateImage.imageData.replace(/^data:image\/\w+;base64,/, '');
      const imageBuffer = Buffer.from(base64, 'base64');
      res.set('Content-Type', 'image/png');
      res.set('Cache-Control', 'public, max-age=86400');
      return res.send(imageBuffer);
    }

    // Fallback: fetch full story data for legacy coverImages
    const story = await getSharedStory(shareToken);
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
    const storyId = await getSharedStoryId(shareToken);
    if (!storyId) {
      log.warn(`[OG-IMAGE] Story not found for shareToken: ${shareToken.substring(0, 8)}...`);
      return res.status(404).json({ error: 'Story not found or sharing disabled' });
    }

    log.debug(`[OG-IMAGE] Fetching frontCover for story ${storyId}`);
    const coverImageResult = await getStoryImage(storyId, 'frontCover', null, 0);
    let coverImage = coverImageResult?.imageData?.replace(/^data:image\/\w+;base64,/, '') || null;

    if (coverImage) {
      log.debug(`[OG-IMAGE] Found frontCover in story_images table (${coverImage.length} chars)`);
    } else {
      log.debug(`[OG-IMAGE] frontCover not in story_images, trying legacy fallback...`);
    }

    // Fallback: fetch full story data for legacy coverImages
    if (!coverImage) {
      const story = await getSharedStory(shareToken);
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
      const pageImageResult = await getStoryImage(storyId, 'scene', 1, 0);
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
    const story = await getSharedStory(shareToken);

    if (story) {
      // HTML-escape the title to prevent broken meta tags from quotes/special chars
      const rawTitle = story.data.title || 'Eine magische Geschichte';
      const title = rawTitle.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const description = `Eine personalisierte Geschichte von MagicalStory.ch`;
      const ogImageUrl = `${SITE_URL}/api/shared/${shareToken}/og-image.jpg`;
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
  <meta property="og:image:type" content="image/jpeg">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:site_name" content="MagicalStory">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${title}">
  <meta name="twitter:image" content="${ogImageUrl}">
  <title>${title}</title>
  <meta http-equiv="refresh" content="0;url=/shared/${shareToken}">
</head>
<body>
  <p>Weiterleitung zu <a href="/shared/${shareToken}">${rawTitle}</a>...</p>
</body>
</html>`;

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
    const story = await getSharedStory(shareToken);
    log.debug(`[SHARED] Story found: ${!!story}, hasDistFolder: ${hasDistFolder}`);

    if (story && hasDistFolder) {
      // Read the index.html
      const indexPath = path.join(distPath, 'index.html');
      let html = await fs.readFile(indexPath, 'utf8');

      const rawTitle = story.data.title || 'Eine magische Geschichte';
      const title = rawTitle.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const description = `Eine personalisierte Geschichte von MagicalStory.ch`;
      const ogImageUrl = `${SITE_URL}/api/shared/${shareToken}/og-image.jpg`;
      const pageUrl = `${SITE_URL}/shared/${shareToken}`;

      // Create OG meta tags
      const ogTags = `
  <!-- Story-specific Open Graph / Facebook / WhatsApp -->
  <meta property="og:type" content="article">
  <meta property="og:url" content="${pageUrl}">
  <meta property="og:title" content="${title}">
  <meta property="og:description" content="${description}">
  <meta property="og:image" content="${ogImageUrl}">
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
