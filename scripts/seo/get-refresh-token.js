#!/usr/bin/env node
/**
 * One-time: mint a refresh token for the Search Console API
 * (webmasters.readonly) using the same OAuth client as scripts/ads.
 * The Ads refresh token is NOT touched — this writes a separate token to
 * scripts/seo/config.json.
 *
 * Run: node scripts/seo/get-refresh-token.js
 * Then open the printed URL in your browser, approve, done — the script
 * catches the redirect on localhost and saves the token.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const adsCfg = require('../ads/config.json');
const PORT = 8765;
const REDIRECT = `http://localhost:${PORT}/oauth2callback`;
const SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
const OUT = path.join(__dirname, 'config.json');

const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
  client_id: adsCfg.client_id,
  redirect_uri: REDIRECT,
  response_type: 'code',
  scope: SCOPE,
  access_type: 'offline',
  prompt: 'consent',
}).toString();

console.log('\n1. Open this URL in your browser (log in as the Search Console owner):\n');
console.log(authUrl);
console.log(`\n2. Approve access — the browser will redirect to localhost:${PORT} and this script finishes automatically.\n`);

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, REDIRECT);
  if (u.pathname !== '/oauth2callback') { res.writeHead(404).end(); return; }
  const code = u.searchParams.get('code');
  if (!code) {
    res.end('No code in callback — check the browser URL for an error message.');
    return;
  }
  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: adsCfg.client_id,
        client_secret: adsCfg.client_secret,
        redirect_uri: REDIRECT,
        grant_type: 'authorization_code',
      }),
    });
    const tok = await tokenRes.json();
    if (!tok.refresh_token) throw new Error('No refresh_token in response: ' + JSON.stringify(tok));
    fs.writeFileSync(OUT, JSON.stringify({
      client_id: adsCfg.client_id,
      client_secret: adsCfg.client_secret,
      refresh_token: tok.refresh_token,
      site: 'sc-domain:magicalstory.ch',
    }, null, 2));
    res.end('Search Console token saved. You can close this tab.');
    console.log(`✓ Refresh token saved to ${OUT}`);
    server.close();
    process.exit(0);
  } catch (err) {
    res.end('Token exchange failed: ' + err.message);
    console.error('✗', err.message);
    server.close();
    process.exit(1);
  }
});
server.listen(PORT);
setTimeout(() => { console.error('Timed out after 10 minutes.'); process.exit(1); }, 600000);
