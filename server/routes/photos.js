/**
 * Photo Routes - /api/photos/*
 *
 * Photo analysis, avatar generation, and related endpoints
 */

const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const { log } = require('../utils/logger');

// Photo Analyzer Health Check
// GET /api/photos/status
router.get('/status', async (req, res) => {
  const photoAnalyzerUrl = process.env.PHOTO_ANALYZER_URL || 'http://127.0.0.1:5000';

  try {
    const response = await fetch(`${photoAnalyzerUrl}/health`, {
      signal: AbortSignal.timeout(5000)
    });
    const data = await response.json();

    log.debug('📸 [HEALTH] Python service status:', data);

    res.json({
      status: 'ok',
      pythonService: data,
      url: photoAnalyzerUrl
    });
  } catch (err) {
    log.error('📸 [HEALTH] Python service unavailable:', err.message);
    res.status(503).json({
      status: 'error',
      error: err.message,
      url: photoAnalyzerUrl
    });
  }
});

// Remove background from a pre-cropped image
// POST /api/photos/remove-bg
router.post('/remove-bg', authenticateToken, async (req, res) => {
  const photoAnalyzerUrl = process.env.PHOTO_ANALYZER_URL || 'http://127.0.0.1:5000';
  const { image, max_size } = req.body;

  if (!image) {
    return res.status(400).json({ success: false, error: 'No image provided' });
  }

  try {
    log.debug(`📸 [REMOVE-BG] Proxying to Python service (${Math.round(image.length / 1024)}KB)`);

    const response = await fetch(`${photoAnalyzerUrl}/remove-bg`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image, max_size }),
      signal: AbortSignal.timeout(30000)
    });

    const data = await response.json();

    if (!response.ok || !data.success) {
      log.error(`📸 [REMOVE-BG] Python error: ${data.error}`);
      return res.status(response.status).json(data);
    }

    log.debug(`📸 [REMOVE-BG] Success: ${Math.round(data.image.length / 1024)}KB PNG`);
    res.json(data);
  } catch (err) {
    log.error(`📸 [REMOVE-BG] Error: ${err.message}`);
    res.status(503).json({ success: false, error: err.message });
  }
});

module.exports = router;
