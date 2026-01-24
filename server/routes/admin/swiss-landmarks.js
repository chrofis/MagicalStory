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
      forceReanalyze = false,        // Re-analyze photos even if already have description
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
      forceReanalyze,
      filterCities,
      dryRun,
      errors: []
    };

    log.info(`[ADMIN] Starting Swiss landmark indexing (maxLandmarks=${maxLandmarks}, cities=${effectiveCityCount}, multiImage=${useMultiImageAnalysis}, forceReanalyze=${forceReanalyze}, filter=${filterCities || 'none'}, dryRun=${dryRun})`);

    // Run in background
    discoverAllSwissLandmarks({
      analyzePhotos,
      useMultiImageAnalysis,
      forceReanalyze,
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
      message: `Started indexing up to ${maxLandmarks} landmarks from ${effectiveCityCount} Swiss cities${filterCities ? ` (filter: ${filterCities.join(', ')})` : ''}${forceReanalyze ? ' (FORCE REANALYZE)' : ''}`,
      maxLandmarks,
      cities: effectiveCityCount,
      filterCities,
      analyzePhotos,
      useMultiImageAnalysis,
      forceReanalyze,
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

// POST /api/admin/swiss-landmarks/recalculate-scores - Recalculate all scores based on type
router.post('/recalculate-scores', async (req, res) => {
  if (!checkAuth(req, res, true)) return;

  try {
    const pool = getPool();

    // Update scores based on type
    const result = await pool.query(`
      UPDATE swiss_landmarks SET score = CASE
        WHEN type IN ('Castle', 'Church', 'Cathedral', 'Bridge', 'Tower', 'Abbey', 'Monastery', 'Chapel') THEN 130
        WHEN type IN ('Park', 'Garden', 'Monument', 'Museum', 'Theatre', 'Historic site', 'Statue', 'Fountain', 'Square', 'Library') THEN 80
        WHEN type IS NOT NULL AND type NOT IN ('Unknown', 'Building', 'Station') THEN 30
        ELSE 5
      END
    `);

    log.info(`[ADMIN] Recalculated scores for ${result.rowCount} landmarks`);
    res.json({ success: true, updated: result.rowCount });
  } catch (err) {
    log.error('[ADMIN] Score recalculation error:', err);
    res.status(500).json({ error: 'Failed to recalculate scores' });
  }
});

// POST /api/admin/swiss-landmarks/update-type - Update a landmark's type
router.post('/update-type', async (req, res) => {
  if (!checkAuth(req, res, true)) return;

  try {
    const { id, type } = req.body;

    if (!id || !type) {
      return res.status(400).json({ error: 'id and type are required' });
    }

    const pool = getPool();
    const result = await pool.query(
      'UPDATE swiss_landmarks SET type = $1, updated_at = NOW() WHERE id = $2 RETURNING id, name, type',
      [type, id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Landmark not found' });
    }

    log.info(`[ADMIN] Updated landmark ${id} type to "${type}"`);
    res.json({ success: true, landmark: result.rows[0] });
  } catch (err) {
    log.error('[ADMIN] Update landmark error:', err);
    res.status(500).json({ error: 'Failed to update landmark' });
  }
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
    const { city, lat, lon, radius = 20, limit = 50, full = false } = req.query;
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

    const showFull = full === 'true' || full === true;
    res.json({
      count: landmarks.length,
      landmarks: landmarks.map(l => {
        const truncate = (text) => showFull ? text : (text?.substring(0, 100) + (text?.length > 100 ? '...' : ''));
        return {
          id: l.id,
          name: l.name,
          type: l.type,
          city: l.nearest_city,
          canton: l.canton,
          score: l.score,
          // Wikipedia description
          wikipediaExtract: truncate(l.wikipedia_extract),
          // Exterior photos (1-2)
          photoUrl: l.photo_url,
          photoDescription: truncate(l.photo_description),
          photoUrl2: l.photo_url_2 || null,
          photoDescription2: truncate(l.photo_description_2),
          // Interior photos (3-4)
          photoUrl3: l.photo_url_3 || null,
          photoDescription3: truncate(l.photo_description_3),
          photoUrl4: l.photo_url_4 || null,
          photoDescription4: truncate(l.photo_description_4),
          latitude: l.latitude,
          longitude: l.longitude
        };
      })
    });
  } catch (err) {
    log.error('[ADMIN] Swiss landmarks list error:', err);
    res.status(500).json({ error: 'Failed to get landmarks', details: err.message });
  }
});

// DELETE /api/admin/swiss-landmarks/broken - Delete broken entries (Wikipedia article URLs instead of image URLs)
router.delete('/broken', async (req, res) => {
  if (!checkAuth(req, res, false)) return;

  try {
    const pool = getPool();

    // Find broken entries: photo_url contains wikipedia.org/wiki/ (article URL, not image)
    // Valid entries have photo_url starting with upload.wikimedia.org (actual images)
    const result = await pool.query(`
      DELETE FROM swiss_landmarks
      WHERE photo_url LIKE '%wikipedia.org/wiki/%'
      AND photo_url NOT LIKE '%upload.wikimedia.org%'
      RETURNING id, name, nearest_city
    `);

    log.info(`[ADMIN] Deleted ${result.rowCount} broken landmark entries`);
    res.json({
      success: true,
      deleted: result.rowCount,
      entries: result.rows
    });
  } catch (err) {
    log.error('[ADMIN] Delete broken landmarks error:', err);
    res.status(500).json({ error: 'Failed to delete broken landmarks', details: err.message });
  }
});

module.exports = router;
