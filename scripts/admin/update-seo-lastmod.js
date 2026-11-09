#!/usr/bin/env node
// Refreshes server/data/seo-lastmod.json: the sitemap's <lastmod> per URL set.
//
// Why a committed file: the Docker image has no .git (.dockerignore) and a file's mtime
// there is the build time, so deriving lastmod at runtime gives "today" for every URL
// (the 2026-11-09 audit found 1396 of 1400). Instead, each set's date is the newest
// commit that touched the files that hold that set's page content, taken here, from git.
// A set whose content is uncommitted right now gets today's date (the change is real,
// the commit just has not happened yet).
//
// Run after changing page content for a set:  node scripts/admin/update-seo-lastmod.js
// Add --check to exit 1 when the committed dates are stale (the unit test does the same).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const MANIFEST = path.join(ROOT, 'server', 'data', 'seo-lastmod.json');

const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();

/** Newest commit date (YYYY-MM-DD, Swiss local) over `sources`, or today if any has uncommitted changes. */
function dateFor(sources) {
  const dirty = git(['status', '--porcelain', '--', ...sources]);
  const fmt = (d) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Zurich' }).format(d);
  if (dirty) return fmt(new Date());
  const iso = git(['log', '-1', '--format=%cI', '--', ...sources]);
  if (!iso) throw new Error(`no git history for ${sources.join(', ')}`);
  return fmt(new Date(iso));
}

function compute(manifest) {
  const out = {};
  for (const [name, set] of Object.entries(manifest.sets)) {
    out[name] = dateFor(set.sources);
  }
  return out;
}

if (require.main === module) {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const fresh = compute(manifest);
  const stale = Object.keys(fresh).filter((k) => manifest.sets[k].lastmod !== fresh[k]);
  if (process.argv.includes('--check')) {
    if (stale.length) { console.error('stale seo-lastmod sets: ' + stale.join(', ')); process.exit(1); }
    console.log('seo-lastmod is current');
  } else {
    for (const k of stale) console.log(`${k}: ${manifest.sets[k].lastmod || '-'} -> ${fresh[k]}`);
    for (const k of Object.keys(fresh)) manifest.sets[k].lastmod = fresh[k];
    fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
    console.log(stale.length ? 'updated' : 'already current');
  }
}

module.exports = { dateFor, compute, MANIFEST };
