/**
 * Landmark Index Admin Routes
 *
 * Endpoints for managing the landmark_index database (works for any city worldwide).
 * Renamed from swiss-landmarks to support global coverage.
 */

const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');

const { getPool } = require('../../services/database');
const { JWT_SECRET } = require('../../middleware/auth');
const { log } = require('../../utils/logger');
const {
  indexLandmarksForCities,
  indexLandmarksForCity,
  getIndexedLandmarksNearLocation,
  getIndexedLandmarks,
  getLandmarkIndexStats,
  SWISS_CITIES
} = require('../../lib/landmarkPhotos');

// Track active indexing job
let landmarkIndexingJob = null;

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

// POST /api/admin/landmark-index/index - Trigger indexing for cities
router.post('/index', async (req, res) => {
  if (!checkAuth(req, res, true)) return;

  try {
    // Check if already running
    if (landmarkIndexingJob && landmarkIndexingJob.status === 'running') {
      return res.json({
        status: 'already_running',
        progress: landmarkIndexingJob.progress,
        landmarksSaved: landmarkIndexingJob.landmarksSaved,
        maxLandmarks: landmarkIndexingJob.maxLandmarks,
        message: `Indexing in progress: ${landmarkIndexingJob.currentCity} (${landmarkIndexingJob.citiesProcessed}/${landmarkIndexingJob.totalCities} cities, ${landmarkIndexingJob.landmarksSaved}/${landmarkIndexingJob.maxLandmarks} landmarks)`
      });
    }

    const {
      cities = null,           // Optional: array of {city, country, region} objects
      analyzePhotos = true,
      useMultiImageAnalysis = true,  // Use new multi-image quality analysis
      forceReanalyze = false,        // Re-analyze photos even if already have description
      dryRun = false,
      maxLandmarks = 500,
      maxCities = null,
      filterCities = null  // Array of city names to filter to (for testing)
    } = req.body;

    // Use provided cities or default to SWISS_CITIES
    const cityList = cities || SWISS_CITIES;

    // Calculate effective city count based on filter
    let effectiveCityCount;
    if (filterCities && filterCities.length > 0) {
      effectiveCityCount = cityList.filter(c =>
        filterCities.some(f => c.city.toLowerCase().includes(f.toLowerCase()))
      ).length;
    } else {
      effectiveCityCount = maxCities || cityList.length;
    }

    landmarkIndexingJob = {
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

    log.info(`[ADMIN] Starting landmark indexing (maxLandmarks=${maxLandmarks}, cities=${effectiveCityCount}, multiImage=${useMultiImageAnalysis}, forceReanalyze=${forceReanalyze}, filter=${filterCities || 'none'}, dryRun=${dryRun})`);

    // Run in background
    indexLandmarksForCities({
      cities: cities || undefined,  // undefined to use default SWISS_CITIES
      analyzePhotos,
      useMultiImageAnalysis,
      forceReanalyze,
      dryRun,
      maxLandmarks,
      maxCities: maxCities || null,
      filterCities,
      onProgress: (city, current, total, saved) => {
        landmarkIndexingJob.currentCity = city;
        landmarkIndexingJob.citiesProcessed = current;
        landmarkIndexingJob.landmarksSaved = saved || 0;
        landmarkIndexingJob.progress = Math.round((current / total) * 100);
      }
    }).then(result => {
      landmarkIndexingJob.status = result.hitLimit ? 'completed_at_limit' : 'completed';
      landmarkIndexingJob.completedAt = new Date();
      landmarkIndexingJob.landmarksFound = result.totalDiscovered;
      landmarkIndexingJob.landmarksSaved = result.totalSaved;
      landmarkIndexingJob.landmarksAnalyzed = result.totalAnalyzed;
      landmarkIndexingJob.hitLimit = result.hitLimit;
      landmarkIndexingJob.errorCount = result.errors || 0;
      log.info(`[ADMIN] Landmark indexing completed: ${result.totalSaved} saved`);
    }).catch(err => {
      landmarkIndexingJob.status = 'failed';
      landmarkIndexingJob.error = err.message;
      log.error(`[ADMIN] Landmark indexing failed:`, err);
    });

    res.json({
      status: 'started',
      message: `Started indexing up to ${maxLandmarks} landmarks from ${effectiveCityCount} cities${filterCities ? ` (filter: ${filterCities.join(', ')})` : ''}${forceReanalyze ? ' (FORCE REANALYZE)' : ''}`,
      maxLandmarks,
      cities: effectiveCityCount,
      filterCities,
      analyzePhotos,
      useMultiImageAnalysis,
      forceReanalyze,
      dryRun
    });
  } catch (err) {
    log.error('[ADMIN] Landmark index error:', err);
    res.status(500).json({ error: 'Failed to start indexing', details: err.message });
  }
});

// POST /api/admin/landmark-index/index-city - Index a single city on-demand
router.post('/index-city', async (req, res) => {
  if (!checkAuth(req, res, true)) return;

  try {
    const { city, country, analyzePhotos = true, maxLandmarks = 30 } = req.body;

    if (!city || !country) {
      return res.status(400).json({ error: 'city and country are required' });
    }

    log.info(`[ADMIN] Starting on-demand indexing for ${city}, ${country}`);

    // Run in background
    indexLandmarksForCity(city, country, { analyzePhotos, maxLandmarks })
      .then(result => {
        log.info(`[ADMIN] On-demand indexing completed for ${city}: ${result.totalSaved} saved`);
      })
      .catch(err => {
        log.error(`[ADMIN] On-demand indexing failed for ${city}:`, err);
      });

    res.json({
      status: 'started',
      message: `Started indexing landmarks for ${city}, ${country}`,
      city,
      country,
      maxLandmarks
    });
  } catch (err) {
    log.error('[ADMIN] Index city error:', err);
    res.status(500).json({ error: 'Failed to start indexing', details: err.message });
  }
});

// GET /api/admin/landmark-index/index/status - Check indexing progress
router.get('/index/status', async (req, res) => {
  if (!checkAuth(req, res, false)) return;

  if (!landmarkIndexingJob) {
    return res.json({ status: 'not_started', message: 'No indexing job has been started' });
  }
  res.json(landmarkIndexingJob);
});

// POST /api/admin/landmark-index/recalculate-scores - Recalculate all scores based on type
router.post('/recalculate-scores', async (req, res) => {
  if (!checkAuth(req, res, true)) return;

  try {
    const pool = getPool();

    // Update scores based on type
    const result = await pool.query(`
      UPDATE landmark_index SET score = CASE
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

// POST /api/admin/landmark-index/update-type - Update a landmark's type
router.post('/update-type', async (req, res) => {
  if (!checkAuth(req, res, true)) return;

  try {
    const { id, type } = req.body;

    if (!id || !type) {
      return res.status(400).json({ error: 'id and type are required' });
    }

    const pool = getPool();
    const result = await pool.query(
      'UPDATE landmark_index SET type = $1, updated_at = NOW() WHERE id = $2 RETURNING id, name, type',
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

// GET /api/admin/landmark-index/stats - Get statistics
router.get('/stats', async (req, res) => {
  if (!checkAuth(req, res, false)) return;

  try {
    const stats = await getLandmarkIndexStats();

    // Also get country breakdown
    const pool = getPool();
    const countryResult = await pool.query(
      'SELECT country, COUNT(*) as count FROM landmark_index GROUP BY country ORDER BY count DESC'
    );
    stats.byCountry = {};
    for (const row of countryResult.rows) {
      stats.byCountry[row.country || 'Unknown'] = parseInt(row.count);
    }

    res.json(stats);
  } catch (err) {
    log.error('[ADMIN] Landmark stats error:', err);
    res.status(500).json({ error: 'Failed to get stats' });
  }
});

// GET /api/admin/landmark-index - List landmarks
router.get('/', async (req, res) => {
  if (!checkAuth(req, res, false)) return;

  try {
    const { city, country, lat, lon, radius = 20, limit = 50, full = false } = req.query;
    const pool = getPool();

    let landmarks;
    if (city) {
      landmarks = await getIndexedLandmarks(city, parseInt(limit));
    } else if (lat && lon) {
      landmarks = await getIndexedLandmarksNearLocation(
        parseFloat(lat),
        parseFloat(lon),
        parseFloat(radius),
        parseInt(limit)
      );
    } else if (country) {
      const result = await pool.query(
        `SELECT * FROM landmark_index WHERE LOWER(country) = LOWER($1) ORDER BY score DESC LIMIT $2`,
        [country, parseInt(limit)]
      );
      landmarks = result.rows;
    } else {
      const result = await pool.query(
        `SELECT * FROM landmark_index ORDER BY score DESC LIMIT $1`,
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
          country: l.country,
          region: l.region,
          score: l.score,
          // Wikipedia description
          wikipediaExtract: truncate(l.wikipedia_extract),
          // Exterior photos (1-3)
          photoUrl: l.photo_url,
          photoDescription: truncate(l.photo_description),
          photoUrl2: l.photo_url_2 || null,
          photoDescription2: truncate(l.photo_description_2),
          photoUrl3: l.photo_url_3 || null,
          photoDescription3: truncate(l.photo_description_3),
          // Interior photos (4-6)
          photoUrl4: l.photo_url_4 || null,
          photoDescription4: truncate(l.photo_description_4),
          photoUrl5: l.photo_url_5 || null,
          photoDescription5: truncate(l.photo_description_5),
          photoUrl6: l.photo_url_6 || null,
          photoDescription6: truncate(l.photo_description_6),
          latitude: l.latitude,
          longitude: l.longitude
        };
      })
    });
  } catch (err) {
    log.error('[ADMIN] Landmark list error:', err);
    res.status(500).json({ error: 'Failed to get landmarks', details: err.message });
  }
});

// DELETE /api/admin/landmark-index/broken - Delete broken entries (Wikipedia article URLs instead of image URLs)
router.delete('/broken', async (req, res) => {
  if (!checkAuth(req, res, false)) return;

  try {
    const pool = getPool();

    // Find broken entries: photo_url contains wikipedia.org/wiki/ (article URL, not image)
    // Valid entries have photo_url starting with upload.wikimedia.org (actual images)
    const result = await pool.query(`
      DELETE FROM landmark_index
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
