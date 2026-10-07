// Every link a mail carries points at the canonical apex host
// https://magicalstory.ch, never https://www.magicalstory.ch. server.js
// 301-redirects www to the apex, so a www link cost every click one redirect
// (and Gmail's link scanner a second fetch) for nothing.

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '..', '..');
const WWW = /https?:\/\/www\.magicalstory\.ch/;

// email.js builds the story links itself; the route files build the
// verification, reset, share and checkout links that reach a mail or a
// customer's browser; the compiled templates and their sources are checked
// whole. sharing.js and stories.js share the same fallback (SITE_URL).
const SOURCES = [
  'email.js',
  'server/lib/trialReminders.js',
  'server/lib/unsubscribeToken.js',
  'server/lib/gelato.js',
  'server/routes/auth.js',
  'server/routes/jobs.js',
  'server/routes/trial.js',
  'server/routes/sharing.js',
  'server/routes/stories.js',
  'server/routes/print.js',
];

describe('links reach the apex host, not www', () => {
  for (const file of SOURCES) {
    it(file, () => {
      expect(fs.readFileSync(path.join(ROOT, file), 'utf8')).not.toMatch(WWW);
    });
  }
  for (const dir of ['emails', 'emails-src', 'emails-src/templates', 'emails-src/components']) {
    const full = path.join(ROOT, dir);
    for (const name of fs.readdirSync(full).filter((f) => /\.(html|ts|tsx)$/.test(f))) {
      it(`${dir}/${name}`, () => {
        expect(fs.readFileSync(path.join(full, name), 'utf8')).not.toMatch(WWW);
      });
    }
  }
  it('email.js story links are built on https://magicalstory.ch', () => {
    const source = fs.readFileSync(path.join(ROOT, 'email.js'), 'utf8');
    expect(source).toContain('`https://magicalstory.ch/shared/${options.shareToken}`');
    expect(source).toContain('`https://magicalstory.ch/create?storyId=${storyId}`');
  });
});
