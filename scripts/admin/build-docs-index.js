#!/usr/bin/env node
/**
 * Build docs/index.html — a browsable index of every doc in docs/.
 *
 * Curated topic groups for the canonical documentation set. Anything in
 * docs/ that isn't categorised falls into "Other" so nothing is hidden.
 * Files moved to docs/archive/ are listed at the bottom under "Archive"
 * with light styling — they're kept for historical reference only.
 *
 * Re-run with: node scripts/admin/build-docs-index.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const docsDir = path.resolve(__dirname, '..', '..', 'docs');
const archiveDir = path.join(docsDir, 'archive');

// ── Canonical topic structure ───────────────────────────────────────────────
// Each entry's `files` is the full list of canonical docs in display order.
// New docs added under a topic should be inserted here, not appended ad-hoc.
const TOPICS = [
  {
    id: 'core',
    title: 'Core',
    blurb: 'Start here — the system at a glance and the REST surface.',
    files: [
      'architecture.html',
      'api-reference.html',
    ],
  },
  {
    id: 'pipeline',
    title: 'Story Generation',
    blurb: 'How a story goes from "create" click to a finished, illustrated book.',
    files: [
      'story-pipeline.html',
      'character-system.html',
      'image-quality.html',
      'covers-and-composite.html',
      'text-overlay.html',
      'landmarks.html',
    ],
  },
  {
    id: 'product',
    title: 'Product & Operations',
    blurb: 'Pricing, deployment, day-to-day running of the platform.',
    files: [
      'pricing.html',
      'operations.html',
    ],
  },
  {
    id: 'meta',
    title: 'Research, Compliance & Backlog',
    blurb: 'What we evaluated, what is open, and what we still owe.',
    files: [
      'research-log.html',
      'compliance-and-todo.html',
    ],
  },
];

// ── Style ───────────────────────────────────────────────────────────────────
const STYLE = `
<style>
  :root {
    --fg: #1f2328;
    --muted: #59636e;
    --link: #0969da;
    --border: #d1d9e0;
    --hover: #f6f8fa;
  }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", sans-serif;
    color: var(--fg);
    background: #ffffff;
    line-height: 1.55;
    max-width: 1080px;
    margin: 0 auto;
    padding: 32px 24px 80px;
  }
  h1 {
    font-size: 2em;
    margin: 0 0 4px;
    padding-bottom: 0.3em;
    border-bottom: 1px solid var(--border);
  }
  .lede { color: var(--muted); margin: 0 0 28px; font-size: 0.95em; }
  .toc {
    background: var(--hover);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 14px 18px;
    margin: 0 0 32px;
    font-size: 0.95em;
  }
  .toc strong { display: block; margin-bottom: 6px; color: var(--muted); font-size: 0.78em; text-transform: uppercase; letter-spacing: 0.05em; }
  .toc a { color: var(--link); text-decoration: none; margin-right: 14px; line-height: 2; white-space: nowrap; display: inline-block; }
  .toc a:hover { text-decoration: underline; }
  section.topic { margin: 0 0 36px; scroll-margin-top: 16px; }
  section.topic h2 {
    font-size: 1.35em;
    margin: 0 0 4px;
    padding-bottom: 6px;
    border-bottom: 1px solid var(--border);
  }
  .topic-blurb { color: var(--muted); margin: 0 0 12px; font-size: 0.9em; }
  ul { list-style: none; padding: 0; margin: 0; }
  li { margin: 4px 0; padding: 6px 10px; border-radius: 6px; }
  li:hover { background: var(--hover); }
  a.doc { color: var(--link); text-decoration: none; font-weight: 500; }
  a.doc:hover { text-decoration: underline; }
  .filename { color: var(--muted); font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 0.82em; margin-left: 10px; }
  details.archive { margin-top: 36px; }
  details.archive > summary { cursor: pointer; font-weight: 600; font-size: 1em; color: var(--muted); padding: 6px 0; }
  details.archive .topic-blurb { margin-bottom: 8px; }
  details.archive li { font-size: 0.9em; }
  details.archive a.doc { color: var(--muted); }
  .doc-footer { color: var(--muted); font-size: 0.85em; margin-top: 48px; padding-top: 16px; border-top: 1px solid var(--border); }
</style>
`;

// ── Helpers ─────────────────────────────────────────────────────────────────
function extractTitle(html) {
  const m = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (!m) return null;
  return m[1].replace(/<[^>]+>/g, '').trim();
}

function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function readTitles(dir, filter = f => f.endsWith('.html') && f !== 'index.html') {
  const out = new Map();
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir).filter(filter).sort()) {
    const html = fs.readFileSync(path.join(dir, f), 'utf8');
    const title = extractTitle(html) || f.replace(/\.html$/, '').replace(/[_-]/g, ' ');
    out.set(f, title);
  }
  return out;
}

// ── Read canonical + archive contents ──────────────────────────────────────
const canonicalTitles = readTitles(docsDir);
const archiveTitles = readTitles(archiveDir);

const knownCanonical = new Set();
for (const topic of TOPICS) {
  for (const f of topic.files) knownCanonical.add(f);
}

// Build canonical sections (only files that exist on disk).
const canonicalSections = TOPICS.map(topic => ({
  ...topic,
  files: topic.files.filter(f => canonicalTitles.has(f)),
})).filter(t => t.files.length > 0);

// Anything in docs/ that isn't categorised — surface so it's not hidden.
const otherFiles = [...canonicalTitles.keys()].filter(f => !knownCanonical.has(f));
if (otherFiles.length > 0) {
  canonicalSections.push({
    id: 'other',
    title: 'Other',
    blurb: 'Uncategorised — add to TOPICS in scripts/admin/build-docs-index.js to file these properly.',
    files: otherFiles,
  });
}

// ── Render ──────────────────────────────────────────────────────────────────
function renderItem(file, titleMap) {
  const title = escapeHtml(titleMap.get(file));
  const href = titleMap === archiveTitles ? `archive/${file}` : file;
  return `    <li><a class="doc" href="${href}">${title}</a><span class="filename">${file}</span></li>`;
}

function renderSection(s) {
  const items = s.files.map(f => renderItem(f, canonicalTitles)).join('\n');
  return `<section class="topic" id="${s.id}">
  <h2>${escapeHtml(s.title)}</h2>
  <p class="topic-blurb">${escapeHtml(s.blurb)}</p>
  <ul>
${items}
  </ul>
</section>`;
}

const tocLinks = canonicalSections
  .map(s => `<a href="#${s.id}">${escapeHtml(s.title)}</a>`)
  .join('\n  ');

const archiveItems = [...archiveTitles.keys()]
  .map(f => renderItem(f, archiveTitles))
  .join('\n');

const archiveBlock = archiveTitles.size > 0
  ? `
<details class="archive" id="archive">
  <summary>Archive (${archiveTitles.size} historical docs)</summary>
  <p class="topic-blurb">Earlier requirements specs, code reviews, migration writeups, and dead-letter proposals. Kept for context — do not treat as current guidance.</p>
  <ul>
${archiveItems}
  </ul>
</details>`
  : '';

const totalCanonical = canonicalTitles.size;
const totalArchive = archiveTitles.size;

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>MagicalStory Documentation</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
${STYLE}
</head>
<body>
<h1>MagicalStory Documentation</h1>
<p class="lede">${totalCanonical} canonical docs across ${canonicalSections.length} topics${totalArchive > 0 ? ` · ${totalArchive} in <a href="#archive">archive</a>` : ''}.</p>

<nav class="toc">
  <strong>Topics</strong>
  ${tocLinks}
</nav>

${canonicalSections.map(renderSection).join('\n\n')}
${archiveBlock}

<footer class="doc-footer">
  Regenerate with <code>node scripts/admin/build-docs-index.js</code>.
  Categorise new docs by adding them to <code>TOPICS</code> in that script.
</footer>
</body>
</html>
`;

fs.writeFileSync(path.join(docsDir, 'index.html'), html, 'utf8');
console.log(`✓ docs/index.html — ${totalCanonical} canonical, ${totalArchive} archived${otherFiles.length > 0 ? `, ${otherFiles.length} uncategorised` : ''}`);
