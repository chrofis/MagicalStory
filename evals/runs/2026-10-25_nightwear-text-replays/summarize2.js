const fs = require('fs'); const path = require('path');
const dir = path.join(__dirname, 'stage2');
for (const f of fs.readdirSync(dir).sort()) {
  const r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  const nw = r.entries.filter(e => e.category === 'nightwear');
  console.log(`\n## ${r.kind} arm${r.arm} ${r.id} "${r.title.slice(0,40)}" entries=${r.entries.length} nightwearEntries=${nw.length} changed=${r.changed.map(c=>c.name+'/'+c.category).join(',')} stray=${JSON.stringify(r.stray)}`);
  nw.forEach(e => console.log(`   ADD/REWRITE ${e.name} / nightwear :: ${String(e.description).slice(0, 200)}`));
  r.entries.filter(e => e.category !== 'nightwear').forEach(e => console.log(`   other ${e.name}/${e.category} :: ${String(e.description).slice(0, 100)}`));
  if (r.kind !== 'negative' || nw.length) {
    String(r.analysis || '').split('\n').filter(l => /^\s*(6|9)\./.test(l)).forEach(l => console.log('   A> ' + l.slice(0, 380)));
  }
}
