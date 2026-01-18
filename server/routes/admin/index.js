/**
 * Admin Routes Index
 *
 * Aggregates all admin route modules into a single router.
 * Each submodule handles a specific domain of admin functionality.
 */

const express = require('express');
const router = express.Router();

// Import modular admin routes
const usersRouter = require('./users');
const printProductsRouter = require('./print-products');
const ordersRouter = require('./orders');
const analyticsRouter = require('./analytics');
const databaseRouter = require('./database');
const jobsRouter = require('./jobs');

// Mount submodule routers
router.use('/users', usersRouter);
router.use('/print-products', printProductsRouter);
router.use('/orders', ordersRouter);
router.use('/jobs', jobsRouter);   // failed jobs view and retry
router.use('/', analyticsRouter);  // stats, database-size, user-storage, config, token-usage
router.use('/', databaseRouter);   // cleanup endpoints

module.exports = router;
