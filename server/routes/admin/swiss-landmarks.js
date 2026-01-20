/**
 * Swiss Landmarks Admin Routes
 *
 * Endpoints for managing the pre-indexed Swiss landmarks database.
 */

const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');

const { getPool } = require('../../services/database');
const { JWT_SECRET } = require('../../middleware/auth');
const { log } = require('../../utils/logger');
const {
  discoverAllSwissLandmarks,
  getSwissLandmarksNearLocation,
  getSwissLandmarksByCity,
  getSwissLandmarkStats,
  SWISS_CITIES
} = require('../../lib/landmarkPhotos');

// Track active indexing job
let swissLandmarkIndexingJob = null;

// Helper to check auth (JWT or secret)
function checkAuth(req, res, isPost = false) {
  const secret = isPost ? req.body?.secret : req.query?.secret;
  const secretKey = process.env.ADMIN_SECRET || 'clear-landmarks-2026';

  if (secret === secretKey) {
    return true;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader) {
    res.status(401).json({ error: 'Authentication required (JWT or secret)' });
    return false;
  }

  try {
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.role !== 'admin') {
      res.status(403).json({ error: 'Admin access required' });
      return false;
    }
    return true;
  } catch (err) {
    res.status(401).json({ error: 'Invalid token' });
    return false;
  }
}

// POST /api/admin/swiss-landmarks/index - Trigger indexing
router.post('/index', async (req, res) => {
  if (!checkAuth(req, res, true)) return;

  try {
    // Check if already running
    if (swissLandmarkIndexingJob && swissLandmarkIndexingJob.status === 'running') {
      return res.json({
        status: 'already_running',
        progress: swissLandmarkIndexingJob.progress,
        landmarksSaved: swissLandmarkIndexingJob.landmarksSaved,
        maxLandmarks: swissLandmarkIndexingJob.maxLandmarks,
        message: `Indexing in progress: ${swissLandmarkIndexingJob.currentCity} (${swissLandmarkIndexingJob.citiesProcessed}/${swissLandmarkIndexingJob.totalCities} cities, ${swissLandmarkIndexingJob.landmarksSaved}/${swissLandmarkIndexingJob.maxLandmarks} landmarks)`
      });
    }

    const {
      analyzePhotos = true,
      useMultiImageAnalysis = true,  // Use new multi-image quality analysis
      dryRun = false,
      maxLandmarks = 500,
      maxCities = null,
      filterCities = null  // Array of city names to filter to (for testing)
    } = req.body;

    // Calculate effective city count based on filter
    let effectiveCityCount;
    if (filterCities && filterCities.length > 0) {
      effectiveCityCount = SWISS_CITIES.filter(c =>
        filterCities.some(f => c.city.toLowerCase().includes(f.toLowerCase()))
      ).length;
    } else {
      effectiveCityCount = maxCities || SWISS_CITIES.length;
    }

    swissLandmarkIndexingJob = {
      status: 'running',
      startedAt: new Date(),
      citiesProcessed: 0,
      totalCities: effectiveCityCount,
      currentCity: '',
      progress: 0,
      landmarksFound: 0,
      landmarksSaved: 0,
      landmarksAnalyzed: 0,
      maxLandmarks,
      analyzePhotos,
      useMultiImageAnalysis,
      filterCities,
      dryRun,
      errors: []
    };

    log.info(`[ADMIN] Starting Swiss landmark indexing (maxLandmarks=${maxLandmarks}, cities=${effectiveCityCount}, multiImage=${useMultiImageAnalysis}, filter=${filterCities || 'none'}, dryRun=${dryRun})`);

    // Run in background
    discoverAllSwissLandmarks({
      analyzePhotos,
      useMultiImageAnalysis,
      dryRun,
      maxLandmarks,
      maxCities: maxCities || null,
      filterCities,
      onProgress: (city, current, total, saved) => {
        swissLandmarkIndexingJob.currentCity = city;
        swissLandmarkIndexingJob.citiesProcessed = current;
        swissLandmarkIndexingJob.landmarksSaved = saved || 0;
        swissLandmarkIndexingJob.progress = Math.round((current / total) * 100);
      }
    }).then(result => {
      swissLandmarkIndexingJob.status = result.hitLimit ? 'completed_at_limit' : 'completed';
      swissLandmarkIndexingJob.completedAt = new Date();
      swissLandmarkIndexingJob.landmarksFound = result.totalDiscovered;
      swissLandmarkIndexingJob.landmarksSaved = result.totalSaved;
      swissLandmarkIndexingJob.landmarksAnalyzed = result.totalAnalyzed;
      swissLandmarkIndexingJob.hitLimit = result.hitLimit;
      swissLandmarkIndexingJob.errorCount = result.errors || 0;
      log.info(`[ADMIN] Swiss landmark indexing completed: ${result.totalSaved} saved`);
    }).catch(err => {
      swissLandmarkIndexingJob.status = 'failed';
      swissLandmarkIndexingJob.error = err.message;
      log.error(`[ADMIN] Swiss landmark indexing failed:`, err);
    });

    res.json({
      status: 'started',
      message: `Started indexing up to ${maxLandmarks} landmarks from ${effectiveCityCount} Swiss cities${filterCities ? ` (filter: ${filterCities.join(', ')})` : ''}`,
      maxLandmarks,
      cities: effectiveCityCount,
      filterCities,
      analyzePhotos,
      useMultiImageAnalysis,
      dryRun
    });
  } catch (err) {
    log.error('[ADMIN] Swiss landmark index error:', err);
    res.status(500).json({ error: 'Failed to start indexing', details: err.message });
  }
});

// GET /api/admin/swiss-landmarks/index/status - Check indexing progress
router.get('/index/status', async (req, res) => {
  if (!checkAuth(req, res, false)) return;

  if (!swissLandmarkIndexingJob) {
    return res.json({ status: 'not_started', message: 'No indexing job has been started' });
  }
  res.json(swissLandmarkIndexingJob);
});

// GET /api/admin/swiss-landmarks/stats - Get statistics
router.get('/stats', async (req, res) => {
  if (!checkAuth(req, res, false)) return;

  try {
    const stats = await getSwissLandmarkStats();
    res.json(stats);
  } catch (err) {
    log.error('[ADMIN] Swiss landmark stats error:', err);
    res.status(500).json({ error: 'Failed to get stats' });
  }
});

// GET /api/admin/swiss-landmarks - List landmarks
router.get('/', async (req, res) => {
  if (!checkAuth(req, res, false)) return;

  try {
    const { city, lat, lon, radius = 20, limit = 50 } = req.query;
    const pool = getPool();

    let landmarks;
    if (city) {
      landmarks = await getSwissLandmarksByCity(city, parseInt(limit));
    } else if (lat && lon) {
      landmarks = await getSwissLandmarksNearLocation(
        parseFloat(lat),
        parseFloat(lon),
        parseFloat(radius),
        parseInt(limit)
      );
    } else {
      const result = await pool.query(
        `SELECT * FROM swiss_landmarks ORDER BY score DESC LIMIT $1`,
        [parseInt(limit)]
      );
      landmarks = result.rows;
    }

    res.json({
      count: landmarks.length,
      landmarks: landmarks.map(l => ({
        id: l.id,
        name: l.name,
        type: l.type,
        city: l.nearest_city,
        canton: l.canton,
        score: l.score,
        photoUrl: l.photo_url,
        photoDescription: l.photo_description?.substring(0, 100) + (l.photo_description?.length > 100 ? '...' : ''),
        latitude: l.latitude,
        longitude: l.longitude
      }))
    });
  } catch (err) {
    log.error('[ADMIN] Swiss landmarks list error:', err);
    res.status(500).json({ error: 'Failed to get landmarks', details: err.message });
  }
});

module.exports = router;
