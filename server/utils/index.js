// Utils exports
const { log, LOG_LEVELS, LOG_LEVEL, CURRENT_LOG_LEVEL } = require('./logger');
const config = require('./config');

module.exports = {
  log,
  LOG_LEVELS,
  LOG_LEVEL,
  CURRENT_LOG_LEVEL,
  ...config
};
