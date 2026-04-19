// Convert Railway JSON log to readable text matching analyze-story-log expectations.
const fs = require('fs');
const inPath = process.argv[2];
const outPath = process.argv[3];
const content = fs.readFileSync(inPath, 'utf-8');
const lines = content.split('\n').filter(l => l.trim());
const out = [];
for (const raw of lines) {
  try {
    const j = JSON.parse(raw);
    const ts = j.timestamp || '';
    const lvl = j.level || 'info';
    const msg = j.message || '';
    out.push(`${ts} [${lvl === 'error' ? 'err' : 'inf'}]  ${msg}`);
  } catch {
    // non-JSON — pass through
    out.push(raw);
  }
}
fs.writeFileSync(outPath, out.join('\n'));
console.log('Wrote', out.length, 'lines to', outPath);
