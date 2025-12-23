// Services exports
const database = require('./database');
const prompts = require('./prompts');

module.exports = {
  ...database,
  ...prompts
};
