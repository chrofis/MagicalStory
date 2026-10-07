// IP geolocation via ip-api.com (free, no key, 45 req/min) — the ONE place the
// request is built and the answer shaped. Three routes used to hand-roll it
// (user.js /location, trial.js create + ideas) and the two trial copies asked
// for city/region/country only, so a trial story never had coordinates and the
// landmark proximity rungs (getIndexedLandmarks, 20 → 50 → 100 km) could not
// run for a village with no landmark of its own.
//
// Returns { city, region, country, latitude, longitude } with nulls for
// anything unknown, or null when the caller's IP is private/loopback or the
// lookup failed. Never throws.
const { log } = require('../utils/logger');

const isPrivateIp = ip => !ip || ip === '::1' || ip === '127.0.0.1'
  || ip.startsWith('192.168.') || ip.startsWith('10.') || ip.startsWith('172.');

// The original client is req.ip: Express resolves it from X-Forwarded-For using
// `trust proxy` (runtime trustProxyHops, docs/decisions.md 2026-10-04 "client IP
// is trust-proxy 2"). Raw headers are never read here — no Cloudflare sits in
// front, so a client-sent cf-connecting-ip / x-real-ip / X-Forwarded-For entry
// would let a caller pick its own geolocation.
function clientIp(req) {
  return req.ip;
}

async function lookupIpLocation(req, tag = 'LOCATION') {
  const ip = clientIp(req);
  if (isPrivateIp(ip)) return null;
  try {
    const response = await fetch(`http://ip-api.com/json/${ip}?fields=status,city,regionName,country,lat,lon`);
    const data = await response.json();
    if (data.status === 'fail' || !data.city) {
      log.debug(`📍 [${tag}] IP lookup failed for ${ip}`);
      return null;
    }
    log.debug(`📍 [${tag}] Detected: ${data.city}, ${data.regionName}, ${data.country} (${data.lat},${data.lon}) (IP: ${ip})`);
    return {
      city: data.city || null,
      region: data.regionName || null,
      country: data.country || null,
      latitude: typeof data.lat === 'number' ? data.lat : null,
      longitude: typeof data.lon === 'number' ? data.lon : null,
    };
  } catch (err) {
    log.debug(`📍 [${tag}] IP lookup error for ${ip}: ${err.message}`);
    return null;
  }
}

module.exports = { clientIp, lookupIpLocation };
