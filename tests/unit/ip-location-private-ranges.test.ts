/**
 * iPhone trial got no location: isPrivateIp treated every 172.x address as
 * private, but only 172.16.0.0/12 is. iCloud Private Relay egresses from
 * 172.224.0.0/12, so those visitors were never looked up. IPv6 and
 * ::ffff:-mapped addresses were not classified either.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { isPrivateIp } = require('../../server/lib/ipLocation.js');

describe('isPrivateIp', () => {
  it.each(['172.224.10.5', '172.226.100.50', '172.15.0.1', '172.32.0.1', '2a02:1205:3c0:1::1', '::ffff:203.0.113.7', '8.8.8.8'])(
    'public address %s is looked up', (ip) => { expect(isPrivateIp(ip)).toBe(false); });

  it.each(['10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '127.0.0.1', '::1', '::ffff:10.0.0.1', '::ffff:127.0.0.1', 'fe80::1', 'fd12:3456::1', '100.64.1.1', '169.254.1.1', '', undefined, 'not-an-ip'])(
    'non-public or invalid %s is skipped', (ip) => { expect(isPrivateIp(ip as string)).toBe(true); });
});
