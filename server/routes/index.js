/**
 * Routes Index
 *
 * Export all migrated route modules
 */

const configRoutes = require('./config');
const healthRoutes = require('./health');
const userRoutes = require('./user');
const characterRoutes = require('./characters');
const authRoutes = require('./auth');
const storyDraftRoutes = require('./storyDraft');

module.exports = {
  configRoutes,
  healthRoutes,
  userRoutes,
  characterRoutes,
  authRoutes,
  storyDraftRoutes,
};
