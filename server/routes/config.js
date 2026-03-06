/**
 * Config Routes - /api/config/*
 *
 * Public configuration endpoints
 */

const express = require('express');
const router = express.Router();

const { authenticateToken } = require('../middleware/auth');
const { IMAGE_GEN_MODE } = require('../utils/config');

// GET /api/config - Public config
router.get('/', (req, res) => {
  res.json({
    imageGenMode: IMAGE_GEN_MODE  // 'parallel' or 'sequential'
  });
});

// GET /api/config/print-product-uid - Get default print product UID
router.get('/print-product-uid', authenticateToken, (req, res) => {
  const productUid = process.env.GELATO_PHOTOBOOK_UID;

  if (!productUid) {
    return res.status(500).json({
      error: 'Print product UID not configured',
      message: 'Please set GELATO_PHOTOBOOK_UID in environment variables'
    });
  }

  res.json({ productUid });
});

module.exports = router;
