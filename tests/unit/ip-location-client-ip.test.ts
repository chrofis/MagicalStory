/** BACKLOG F4 (code review 2026-10-04): clientIp must not trust client-sent headers. */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { clientIp } = require('../../server/lib/ipLocation.js');

describe('clientIp', () => {
  it('returns req.ip, which Express resolves via trust proxy', () => {
    expect(clientIp({ ip: '203.0.113.7', headers: {} })).toBe('203.0.113.7');
  });
  it('ignores spoofable cf-connecting-ip / x-real-ip / x-forwarded-for headers', () => {
    const req = {
      ip: '203.0.113.7',
      headers: {
        'cf-connecting-ip': '6.6.6.6',
        'x-real-ip': '7.7.7.7',
        'x-forwarded-for': '8.8.8.8, 203.0.113.7',
      },
    };
    expect(clientIp(req)).toBe('203.0.113.7');
  });
});
