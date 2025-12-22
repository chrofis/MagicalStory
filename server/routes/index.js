/**
 * Routes Index
 *
 * Export all migrated route modules
 */

const configRoutes = require('./config');
const healthRoutes = require('./health');
const userRoutes = require('./user');
const characterRoutes = require('./characters');

module.exports = {
  configRoutes,
  healthRoutes,
  userRoutes,
  characterRoutes,
};
