#!/usr/bin/env node
/**
 * One-time OAuth flow to obtain a refresh token for the Google Ads API.
 *
 * Requires: config.json populated with client_id + client_secret.
 * Output: prints the refresh token. Paste it into config.json → refresh_token.
 *
 * Usage: node scripts/ads/authorize.js
 */
const http = require('http');
const { URL } = require('url');
const { exec } = require('child_process');
const { loadConfig } = require('./lib/client');

const SCOPE = 'https://www.googleapis.com/auth/adwords';
const REDIRECT = 'http://127.0.0.1:8765/oauth2callback';

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? `start "" "${url}"`
    : process.platform === 'darwin' ? `open "${url}"`
    : `xdg-open "${url}"`;
  exec(cmd, (err) => { if (err) console.log('\nOpen this URL manually:\n  ' + url); });
}

(async () => {
  const cfg = loadConfig();

  const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
    client_id: cfg.client_id,
    redirect_uri: REDIRECT,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent',
  }).toString();

  const code = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, REDIRECT);
      if (u.pathname !== '/oauth2callback') { res.writeHead(404); res.end(); return; }
      const c = u.searchParams.get('code');
      const err = u.searchParams.get('error');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      if (err) {
        res.end(`<h1>Auth failed</h1><p>${err}</p>`);
        server.close(); reject(new Error(err)); return;
      }
      res.end(`<h1>OAuth complete</h1><p>You can close this tab and return to the terminal.</p>`);
      server.close(); resolve(c);
    });
    server.listen(8765, '127.0.0.1', () => {
      console.log('Waiting for Google OAuth redirect on http://127.0.0.1:8765/oauth2callback ...');
      console.log('Opening browser — if it does not open, paste this URL manually:\n  ' + authUrl);
      openBrowser(authUrl);
    });
    setTimeout(() => { server.close(); reject(new Error('OAuth timeout (3 minutes)')); }, 3 * 60 * 1000);
  });

  const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code, client_id: cfg.client_id, client_secret: cfg.client_secret,
      redirect_uri: REDIRECT, grant_type: 'authorization_code',
    }).toString(),
  });
  const tok = await tokenResp.json();
  if (!tokenResp.ok || !tok.refresh_token) {
    console.error('Token exchange failed:', tok);
    process.exit(1);
  }
  console.log('\n✅ Refresh token:\n\n  ' + tok.refresh_token + '\n');
  console.log('Paste that value into scripts/ads/config.json under "refresh_token", then run:');
  console.log('  node scripts/ads/whoami.js');
})().catch((e) => { console.error(e.message); process.exit(1); });
