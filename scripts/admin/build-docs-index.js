#!/usr/bin/env node
/**
 * Build docs/index.html — a browsable index of every doc in docs/.
 *
 * Scans for .html files, pulls the first <h1> from each as the display
 * title, and sorts alphabetically. Re-run whenever a new doc is added.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const docsDir = path.resolve(__dirname, '..', '..', 'docs');

const STYLE = `
<style>
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", sans-serif;
    color: #1f2328;
    background: #ffffff;
    line-height: 1.6;
    max-width: 920px;
    margin: 0 auto;
    padding: 32px 24px 80px;
  }
  h1 { font-size: 2em; padding-bottom: 0.3em; border-bottom: 1px solid #d1d9e0; }
  ul { list-style: none; padding-left: 0; }
  li { margin: 8px 0; padding: 8px 12px; border-radius: 6px; }
  li:hover { background: #f6f8fa; }
  a { color: #0969da; text-decoration: none; font-size: 1.05em; font-weight: 500; }
  a:hover { text-decoration: underline; }
  .filename { color: #59636e; font-family: ui-monospace, monospace; font-size: 0.85em; margin-left: 8px; }
  .doc-footer { color: #59636e; font-size: 0.85em; margin-top: 48px; padding-top: 16px; border-top: 1px solid #d1d9e0; }
</style>
`;

function extractTitle(html) {
  const m = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (!m) return null;
  // strip nested tags
  return m[1].replace(/<[^>]+>/g, '').trim();
}

const files = fs.readdirSync(docsDir)
  .filter(f => f.endsWith('.html') && f !== 'index.html')
  .sort();

const entries = files.map(f => {
  const html = fs.readFileSync(path.join(docsDir, f), 'utf8');
  const title = extractTitle(html) || f.replace(/\.html$/, '').replace(/[_-]/g, ' ');
  return { file: f, title };
});

const list = entries.map(e =>
  `  <li><a href="${e.file}">${e.title}</a><span class="filename">${e.file}</span></li>`
).join('\n');

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
<p>${entries.length} documents.</p>
<ul>
${list}
</ul>
<footer class="doc-footer">Regenerate with <code>node scripts/admin/build-docs-index.js</code></footer>
</body>
</html>
`;

fs.writeFileSync(path.join(docsDir, 'index.html'), html, 'utf8');
console.log(`✓ docs/index.html (${entries.length} entries)`);
