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
const net = require('net');
const { log } = require('../utils/logger');

// Non-routable ranges only. This used to be `ip.startsWith('172.')`, which treats
// all of 172.0.0.0/8 as private - but only 172.16.0.0/12 is. Apple iCloud
// Private Relay (every iPhone with it on, the default for many) egresses from
// 172.224.0.0/12, so every such visitor was skipped as "private" and the trial
// story got no town (docs/decisions.md 2026-10-09 "iPhone trial: location").
// IPv6 was never checked either (fc00::/7, fe80::/10), and an IPv4 address
// arriving as ::ffff:a.b.c.d bypassed even the IPv4 prefixes.
const NON_PUBLIC = new net.BlockList();
[['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.168.0.0', 16]].forEach(([a, p]) => NON_PUBLIC.addSubnet(a, p, 'ipv4'));
[['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10]].forEach(([a, p]) => NON_PUBLIC.addSubnet(a, p, 'ipv6'));

function isPrivateIp(ip) {
  if (!ip) return true;
  const plain = ip.replace(/^::ffff:/i, '').replace(/%.*$/, '');
  const family = net.isIP(plain);
  if (!family) return true; // not an address at all - nothing to look up
  return NON_PUBLIC.check(plain, family === 4 ? 'ipv4' : 'ipv6');
}

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
  if (isPrivateIp(ip)) {
    // Warn, not debug: a visitor with no location is a placeless story, and the
    // only evidence of why (which address arrived) used to be thrown away.
    log.warn(`📍 [${tag}] No lookup, address is not public: ${ip}`);
    return null;
  }
  try {
    const response = await fetch(`http://ip-api.com/json/${ip}?fields=status,city,regionName,country,lat,lon`, { signal: AbortSignal.timeout(5000) });
    const data = await response.json();
    if (data.status === 'fail' || !data.city) {
      log.warn(`📍 [${tag}] IP lookup returned no city for ${ip}`);
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
    log.warn(`📍 [${tag}] IP lookup error for ${ip}: ${err.message}`);
    return null;
  }
}

module.exports = { clientIp, isPrivateIp, lookupIpLocation };
