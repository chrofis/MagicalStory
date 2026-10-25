const fs = require('fs'); const path = require('path');
const dir = path.join(__dirname, 'stage1');
for (const f of fs.readdirSync(dir)) {
  const r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  console.log(`\n## ${r.kind} ${r.id} "${r.title}" beats=${r.beatsSource} parseError=${r.parseError} markerPresent=${/CLOTHING REQUIREMENTS/.test(r.raw)}`);
  for (const c of r.characters) {
    const e = (r.clothing || {})[c.name];
    if (!e) { console.log(`  ${c.name} (${c.age}): NO ENTRY`); continue; }
    const nw = e.nightwear;
    console.log(`  ${c.name} (${c.age}): nightwearKey=${nw ? 'present' : 'ABSENT'} used=${nw && nw.used}${nw && nw.used ? ' :: ' + nw.description : ''}`);
  }
}
