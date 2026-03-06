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

module.exports = router;
