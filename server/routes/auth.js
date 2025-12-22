/**
 * Auth Routes - /api/auth/*
 *
 * This is an EXAMPLE file showing the pattern for migrating routes.
 * Currently, auth routes are still handled by server.js.
 *
 * To migrate:
 * 1. Move the route handler code from server.js here
 * 2. Update dependencies (dbQuery, bcrypt, jwt, etc.)
 * 3. Import this router in server/index.js
 * 4. Remove the routes from server.js
 */

const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const { dbQuery } = require('../services/database');
const { generateToken, authenticateToken } = require('../middleware/auth');
const { registerLimiter, authLimiter } = require('../middleware/rateLimit');
const { log } = require('../utils/logger');

// POST /api/auth/register
// TODO: Migrate from server.js
// router.post('/register', registerLimiter, async (req, res) => { ... });

// POST /api/auth/login
// TODO: Migrate from server.js
// router.post('/login', authLimiter, async (req, res) => { ... });

// GET /api/auth/me
// TODO: Migrate from server.js
// router.get('/me', authenticateToken, async (req, res) => { ... });

// POST /api/auth/firebase
// TODO: Migrate from server.js

// POST /api/auth/reset-password
// TODO: Migrate from server.js

// POST /api/auth/change-password
// TODO: Migrate from server.js

// POST /api/auth/send-verification
// TODO: Migrate from server.js

// GET /api/auth/verify-email/:token
// TODO: Migrate from server.js

module.exports = router;
