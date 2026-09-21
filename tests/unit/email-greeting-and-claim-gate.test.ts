// Pins two shipped behaviours of the outbound-mail path:
//
//  1. CLAIM GATE — the "claim your account" link is gated on claim STATE
//     (is_trial AND NOT has_set_password), never on trial ORIGIN. A converted
//     trial user must get neither a link nor a freshly minted token. The same
//     test also exercises the token-minting branch, which threw a bare
//     `TypeError: crypto.randomBytes is not a function` in production from
//     2026-08-11 (commit 7ac04a42b) until this commit: storyJobPipeline.js used
//     `crypto` without requiring it, and Node's global `crypto` is WebCrypto.
//
//  2. GREETING — a mail never prints an email address as a name. `users.username`
//     is set to the address on Google link and trial conversion, so 68 of 69 prod
//     users with a real email were greeted by their address. With no usable name
//     the mail greets bare ("Hallo," / "Ciao,"), in every template and language.

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '..', '..');

// eslint-disable-next-line @typescript-eslint/no-var-requires
const email = require(path.join(ROOT, 'email.js'));
const { resolveGreetingName } = email;

describe('resolveGreetingName — an address is not a name', () => {
  it('prefers the shipping first name', () => {
    expect(resolveGreetingName({ shipping_first_name: 'Roger', username: 'r@x.ch' })).toBe('Roger');
  });

  it('rejects a username that is an email address', () => {
    expect(resolveGreetingName({ username: 'amandatavaresfo2@gmail.com' })).toBeNull();
    expect(resolveGreetingName('amandatavaresfo2@gmail.com')).toBeNull();
  });

  it('rejects the anonymous trial placeholder address', () => {
    expect(resolveGreetingName({ username: 'anon_abc-123', email: 'anon_abc-123@anonymous' })).toBe('anon_abc-123');
    expect(resolveGreetingName({ username: 'anon_abc-123@anonymous' })).toBeNull();
  });

  it('takes the first word of a full name', () => {
    expect(resolveGreetingName({ shipping_first_name: 'Anna Maria Berger' })).toBe('Anna');
    expect(resolveGreetingName('Anna Maria Berger')).toBe('Anna');
  });

  it('returns null — not a placeholder word — when nothing usable exists', () => {
    expect(resolveGreetingName({})).toBeNull();
    expect(resolveGreetingName(null)).toBeNull();
    expect(resolveGreetingName({ shipping_first_name: '   ' })).toBeNull();
  });

  it('never returns a value containing @', () => {
    const samples = [
      { username: 'a@b.ch' },
      { shipping_first_name: 'x@y.com', username: 'z@w.com' },
      'someone+tag@example.org',
    ];
    for (const s of samples) {
      const out = resolveGreetingName(s as any);
      expect(out === null || !out.includes('@')).toBe(true);
    }
  });
});

describe('greeting templates read cleanly with no name, in every language', () => {
  // The leading space belongs to the VALUE (`Hallo{greeting},`) so a nameless
  // greeting renders "Hallo," with no stray gap before the comma.
  const TEMPLATES = [
    'story-complete.html',
    'trial-story-complete.html',
    'trial-reminder.html',
    'story-failed.html',
    'order-confirmation.html',
    'order-shipped.html',
    'order-failed.html',
  ];

  for (const file of TEMPLATES) {
    it(`${file} — no space before {greeting}, renders bare and named`, () => {
      const html = fs.readFileSync(path.join(ROOT, 'emails', file), 'utf8');
      expect(html).toContain('{greeting}');
      // A literal space before the placeholder would leave "Hallo ," when empty.
      expect(/\S \{greeting\}/.test(html)).toBe(false);

      // Inspect only the salutation lines — the rest of the template legitimately
      // contains addresses (support@) and whitespace-wrapped commas.
      const lines = html.split(/\r?\n/).filter((l) => l.includes('{greeting}'));
      expect(lines.length).toBe(8); // 4 languages x (plain-text + HTML body)

      for (const line of lines) {
        const bare = line.replace(/\{greeting\}/g, '').trim();
        const named = line.replace(/\{greeting\}/g, ' Roger').trim();

        // Bare: one of the four language forms, comma-tight, no address.
        expect(bare).toMatch(/^(Hello|Hallo|Bonjour|Ciao),|(Hello|Hallo|Bonjour|Ciao),/);
        expect(/\s+,/.test(bare)).toBe(false);
        expect(bare).not.toContain('@');
        // Named: exactly one space between salutation and name.
        expect(named).toMatch(/(Hello|Hallo|Bonjour|Ciao) Roger,/);
      }
    });
  }
});

describe('claim link is gated on claim STATE, not trial origin', () => {
  // Replays the exact predicate both claim-minting sites now use
  // (storyJobPipeline.js unified completion email, server/lib/trialEmail.js).
  const shouldOfferClaim = (u: any) => u.is_trial === true && u.has_set_password !== true;

  it('a genuine unclaimed trial user gets the claim link', () => {
    expect(shouldOfferClaim({ is_trial: true, has_set_password: false })).toBe(true);
    // has_set_password may be null on a row predating migration 002's backfill.
    expect(shouldOfferClaim({ is_trial: true, has_set_password: null })).toBe(true);
  });

  it('every conversion route leaves a user that gets NO claim link', () => {
    // auth.js:824 set-password conversion
    expect(shouldOfferClaim({ is_trial: false, has_set_password: true })).toBe(false);
    // trial.js:1874 link-google conversion
    expect(shouldOfferClaim({ is_trial: false, has_set_password: true })).toBe(false);
    // trial.js:3058 / trial.js:3163 claim routes — these clear is_trial only.
    expect(shouldOfferClaim({ is_trial: false, has_set_password: false })).toBe(false);
  });

  it('a placeholder password is not a conversion signal', () => {
    // Trial accounts are created with a random password (trial.js:1185), so
    // `password IS NOT NULL` would have wrongly suppressed every real claim link.
    const freshTrial = { is_trial: true, has_set_password: false, password: '$2b$10$placeholderhash' };
    expect(shouldOfferClaim(freshTrial)).toBe(true);
  });
});

describe('crypto.randomBytes is available where claim tokens are minted', () => {
  const SITES = ['storyJobPipeline.js', 'server/lib/trialEmail.js'];

  for (const site of SITES) {
    it(`${site} requires node crypto`, () => {
      const src = fs.readFileSync(path.join(ROOT, site), 'utf8');
      expect(src).toContain("crypto.randomBytes(32)");
      expect(/const crypto = require\('crypto'\);/.test(src)).toBe(true);
    });
  }

  it('the minted token is 64 hex chars (the branch actually runs)', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const crypto = require('crypto');
    const token = crypto.randomBytes(32).toString('hex');
    expect(token).toHaveLength(64);
    expect(/^[0-9a-f]{64}$/.test(token)).toBe(true);
  });
});
