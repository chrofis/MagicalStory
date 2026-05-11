#!/usr/bin/env node
/**
 * One-shot: convert every docs/*.md to docs/*.html and delete the .md
 * originals. Skips CLAUDE.md (Claude Code reads it as markdown) and
 * README.md (GitHub renders it as markdown).
 *
 * Each HTML output gets a minimal stylesheet so it's readable in a
 * browser without external CSS. Tables, code blocks, and fenced syntax
 * highlighting all survive through `marked`.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { marked } = require('marked');

const docsDir = path.resolve(__dirname, '..', '..', 'docs');

// Minimal stylesheet — readable in any browser, no external deps.
const STYLE = `
<style>
  :root {
    --fg: #1f2328;
    --bg: #ffffff;
    --muted: #59636e;
    --border: #d1d9e0;
    --code-bg: #f6f8fa;
    --link: #0969da;
    --accent: #0969da;
  }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", sans-serif;
    color: var(--fg);
    background: var(--bg);
    line-height: 1.6;
    max-width: 920px;
    margin: 0 auto;
    padding: 32px 24px 80px;
  }
  h1, h2, h3, h4, h5, h6 { line-height: 1.25; margin-top: 1.5em; margin-bottom: 0.5em; font-weight: 600; }
  h1 { font-size: 2em; padding-bottom: 0.3em; border-bottom: 1px solid var(--border); }
  h2 { font-size: 1.5em; padding-bottom: 0.3em; border-bottom: 1px solid var(--border); }
  h3 { font-size: 1.25em; }
  h4 { font-size: 1em; }
  h5 { font-size: 0.875em; }
  h6 { font-size: 0.85em; color: var(--muted); }
  p, ul, ol, blockquote, table, pre { margin: 0 0 16px; }
  a { color: var(--link); text-decoration: none; }
  a:hover { text-decoration: underline; }
  code {
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
    font-size: 85%;
    background: var(--code-bg);
    padding: 0.2em 0.4em;
    border-radius: 6px;
  }
  pre {
    background: var(--code-bg);
    padding: 16px;
    border-radius: 6px;
    overflow-x: auto;
    font-size: 85%;
    line-height: 1.45;
  }
  pre code { background: transparent; padding: 0; font-size: 100%; border-radius: 0; }
  blockquote {
    border-left: 4px solid var(--border);
    color: var(--muted);
    padding: 0 1em;
    margin: 0 0 16px;
  }
  ul, ol { padding-left: 2em; }
  li { margin: 0.25em 0; }
  table { border-collapse: collapse; display: block; overflow: auto; width: max-content; max-width: 100%; }
  th, td { border: 1px solid var(--border); padding: 6px 13px; }
  th { background: var(--code-bg); font-weight: 600; }
  hr { border: 0; border-top: 1px solid var(--border); margin: 24px 0; }
  img { max-width: 100%; height: auto; }
  .doc-footer { color: var(--muted); font-size: 0.85em; margin-top: 48px; padding-top: 16px; border-top: 1px solid var(--border); }
</style>
`;

function htmlShell(title, body) {
  const safeTitle = String(title).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${safeTitle}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
${STYLE}
</head>
<body>
<main>
${body}
</main>
<footer class="doc-footer">
  Rendered from <code>${safeTitle.replace(/\.html$/i, '.md')}</code>.
</footer>
</body>
</html>
`;
}

marked.setOptions({
  gfm: true,
  breaks: false,
  headerIds: true,
  mangle: false,
});

const SKIP = new Set(['README.md', 'CLAUDE.md']);

function main() {
  const entries = fs.readdirSync(docsDir).filter(f => f.endsWith('.md'));
  let converted = 0;
  let skipped = 0;
  for (const file of entries) {
    if (SKIP.has(file)) {
      console.log(`skip (system file): ${file}`);
      skipped++;
      continue;
    }
    const md = fs.readFileSync(path.join(docsDir, file), 'utf8');
    const body = marked.parse(md);
    const htmlName = file.replace(/\.md$/i, '.html');
    const html = htmlShell(htmlName, body);
    fs.writeFileSync(path.join(docsDir, htmlName), html, 'utf8');
    fs.unlinkSync(path.join(docsDir, file));
    console.log(`✓ ${file} → ${htmlName}`);
    converted++;
  }
  console.log(`\n${converted} converted, ${skipped} skipped (system files).`);
}

main();
