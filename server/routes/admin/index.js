/**
 * Admin Routes Index
 *
 * Aggregates all admin route modules
 */

const express = require('express');
const router = express.Router();

// Import modular admin routes
const usersRouter = require('./users');

// Mount user management routes
router.use('/users', usersRouter);

// Export for use in main admin.js
module.exports = {
  usersRouter
};
