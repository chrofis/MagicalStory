/**
 * Photo Routes - /api/photos/*
 *
 * Photo analysis, avatar generation, and related endpoints
 */

const express = require('express');
const router = express.Router();
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const { log } = require('../utils/logger');

// Photo Analyzer Health Check
// GET /api/photos/status
// Admin only: the response names the internal analyzer URL and raw fetch errors (review S6).
router.get('/status', authenticateToken, requireAdmin, async (req, res) => {
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
  // A user is here and working with photos — make sure the analyzer's models
  // are loading now rather than on the first upload. Debounced and
  // fire-and-forget; never blocks this request.
  //
  // face ONLY (2026-09-05). This used to take the default (face + torch) to get
  // ahead of "the first mask call inside character repair" — but that warm is
  // redundant now: jobs.js warms at story start and storyJobPipeline force-warms
  // at the repair phase, which is where masking actually happens, 20+ minutes
  // later. All the torch worker did here was hold ~430MB from the moment
  // somebody uploaded a photo.
  require('../lib/analyzerClient').ensureWarm('photo-upload', { workers: ['face'] });

  const photoAnalyzerUrl = process.env.PHOTO_ANALYZER_URL || 'http://127.0.0.1:5000';
  const { image, max_size } = req.body;

  if (!image) {
    return res.status(400).json({ success: false, error: 'No image provided' });
  }

  try {
    log.debug(`📸 [REMOVE-BG] Proxying to Python service (${Math.round(image.length / 1024)}KB)`);

    // Retry-aware: the analyzer restarts itself when idle to reclaim memory,
    // and this endpoint is the user's photo upload with no fallback.
    const { analyzerFetch } = require('../lib/analyzerClient');
    const response = await analyzerFetch('/remove-bg', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image, max_size }),
      // 90s, not 30s: since the worker split (2026-08-23) the first photo call
      // spawns the face worker cold — mediapipe boot plus U2-Net load is
      // 10-25s before inference even starts. 30s raced that and lost.
      signal: AbortSignal.timeout(90000)
    });

    const data = await response.json();

    if (!response.ok || !data.success) {
      const { AnalyzerError, reportAnalyzerFailure } = require('../lib/photoAnalyzerClient');
      reportAnalyzerFailure('📸 [REMOVE-BG]', new AnalyzerError('/remove-bg', `HTTP ${response.status} ${data.error || 'success:false'}`, { status: response.status }), { severity: 'customer', userId: req.user?.id });
      return res.status(response.status).json(data);
    }

    log.debug(`📸 [REMOVE-BG] Success: ${Math.round(data.image.length / 1024)}KB PNG`);
    res.json(data);
  } catch (err) {
    const { AnalyzerError, reportAnalyzerFailure } = require('../lib/photoAnalyzerClient');
    reportAnalyzerFailure('📸 [REMOVE-BG]', new AnalyzerError('/remove-bg', `unavailable: ${err.message}`, { cause: err }), { severity: 'customer', userId: req.user?.id });
    res.status(503).json({ success: false, error: err.message });
  }
});

module.exports = router;
