#!/usr/bin/env node
/**
 * Render a markdown file to PDF using headless Chromium (via Playwright).
 * Usage: node scripts/ads/md-to-pdf.js <input.md> <output.pdf>
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('@playwright/test');

const md = fs.readFileSync(process.argv[2] || 'tmp/ads-design-doc.md', 'utf8');
const outPath = path.resolve(process.argv[3] || 'tmp/ads-design-doc.pdf');

// Minimal markdown → HTML (good enough for paragraphs, headings, lists, bold).
function mdToHtml(src) {
  const lines = src.split('\n');
  const out = [];
  let inList = false;
  let inCode = false;
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line.startsWith('```')) { inCode = !inCode; out.push(inCode ? '<pre><code>' : '</code></pre>'); continue; }
    if (inCode) { out.push(escape(raw)); continue; }
    if (/^---+$/.test(line)) { out.push('<hr/>'); continue; }
    if (/^# /.test(line)) { out.push(`<h1>${inline(line.slice(2))}</h1>`); continue; }
    if (/^## /.test(line)) { out.push(`<h2>${inline(line.slice(3))}</h2>`); continue; }
    if (/^### /.test(line)) { out.push(`<h3>${inline(line.slice(4))}</h3>`); continue; }
    const ul = line.match(/^(\s*)- (.*)/);
    if (ul) {
      if (!inList) { out.push('<ul>'); inList = true; }
      out.push(`<li>${inline(ul[2])}</li>`);
      continue;
    } else if (inList && !line.trim()) {
      out.push('</ul>'); inList = false;
    } else if (inList) {
      out.push('</ul>'); inList = false;
    }
    if (line.trim() === '') { out.push(''); continue; }
    out.push(`<p>${inline(line)}</p>`);
  }
  if (inList) out.push('</ul>');
  return out.join('\n');
}
function inline(s) {
  return escape(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}
function escape(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
body { font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; max-width: 760px; margin: 24mm auto; color: #111; line-height: 1.45; font-size: 11pt; }
h1 { font-size: 20pt; margin-bottom: 6pt; }
h2 { font-size: 14pt; margin-top: 18pt; }
h3 { font-size: 12pt; margin-top: 12pt; }
p { margin: 6pt 0; }
ul { margin: 6pt 0 6pt 18pt; }
li { margin: 2pt 0; }
hr { border: none; border-top: 1px solid #ccc; margin: 14pt 0; }
code { background: #f4f4f4; padding: 1px 4px; border-radius: 3px; font-size: 10pt; }
pre { background: #f4f4f4; padding: 10px; border-radius: 4px; font-size: 9.5pt; overflow: auto; }
strong { font-weight: 600; }
</style></head><body>${mdToHtml(md)}</body></html>`;

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'load' });
  await page.pdf({ path: outPath, format: 'A4', margin: { top: '20mm', bottom: '20mm', left: '20mm', right: '20mm' } });
  await browser.close();
  console.log(`✅ PDF written: ${outPath}`);
})().catch(e => { console.error(e); process.exit(1); });
