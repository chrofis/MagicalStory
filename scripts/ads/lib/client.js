const fs = require('fs');
const path = require('path');
const { GoogleAdsApi } = require('google-ads-api');

function loadConfig() {
  const configPath = path.join(__dirname, '..', 'config.json');
  if (!fs.existsSync(configPath)) {
    console.error('Missing scripts/ads/config.json — copy config.example.json and fill it in.');
    process.exit(1);
  }
  const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const required = ['customer_id', 'developer_token', 'client_id', 'client_secret'];
  for (const k of required) {
    if (!cfg[k] || String(cfg[k]).startsWith('PASTE_')) {
      console.error(`config.json is missing "${k}" — fill it in before running.`);
      process.exit(1);
    }
  }
  return cfg;
}

function getClient() {
  const cfg = loadConfig();
  const api = new GoogleAdsApi({
    client_id: cfg.client_id,
    client_secret: cfg.client_secret,
    developer_token: cfg.developer_token,
  });
  if (!cfg.refresh_token) {
    return { api, cfg, customer: null };
  }
  const customer = api.Customer({
    customer_id: cfg.customer_id,
    login_customer_id: cfg.login_customer_id || undefined,
    refresh_token: cfg.refresh_token,
  });
  return { api, cfg, customer };
}

module.exports = { loadConfig, getClient };
