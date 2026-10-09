#!/usr/bin/env node
/**
 * Candidate units for the Jev "people-free geometry" measurement (2026-10-09): the clauses of stored page prose
 * that sceneGeometry would consider (GEOMETRY_RE hit), with the code's verdict (isClean + ELIDED_SUBJECT_RE).
 * MEASUREMENT ONLY: it reads sceneGeometry.js's private regexes by compiling the module with an extra export.
 *   node scripts/analysis/jev-geometry-units.js [--pages=40]
 */
const path = require('path'); const fs = require('fs'); const Module = require('module');
const ROOT = path.join(__dirname, '../..');
const file = path.join(ROOT, 'server/lib/sceneGeometry.js');
const m = new Module(file, module); m.filename = file; m.paths = Module._nodeModulePaths(path.dirname(file));
m._compile(fs.readFileSync(file, 'utf8') + '\nmodule.exports._t = { isClean, GEOMETRY_RE, ELIDED_SUBJECT_RE, CLAUSE_SPLIT_RE, stripCastAppositives, namesIn, VB_ID_RE, METADATA_TAIL_RE };', file);
const T = m.exports._t;
const nPages = Number((process.argv.find(a => a.startsWith('--pages=')) || '--pages=40').split('=')[1]);
const cases = JSON.parse(fs.readFileSync(path.join(ROOT, 'evals/runs/2026-10-09_jev-clothing/cases.json'), 'utf8'));
const pages = new Map();
for (const c of cases) { const k = `${c.sid}:${c.page}`; if (!pages.has(k)) pages.set(k, { sid: c.sid, page: c.page, prose: c.prose, names: new Set() }); pages.get(k).names.add(c.name); }
let seed = 11; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const all = [...pages.values()].sort(() => rnd() - 0.5).slice(0, nPages);
const units = [];
for (const p of all) {
  const names = T.namesIn([...p.names]);
  const sentences = p.prose.replace(T.METADATA_TAIL_RE, ' ').replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);
  for (const s0 of sentences) {
    const s = T.stripCastAppositives(s0.replace(T.VB_ID_RE, ''), names).replace(/\s+/g, ' ').trim();
    for (const u of [s, ...s.split(T.CLAUSE_SPLIT_RE)].map(x => x.trim().replace(/[.!?,;:"']+$/, '').trim())) {
      if (u.length <= 3 || !T.GEOMETRY_RE.test(u)) continue;
      units.push({ id: units.length, sid: p.sid, page: p.page, names: [...p.names], unit: u, whole: u === s.replace(/[.!?,;:"']+$/, '').trim(), codeClean: T.isClean(u, names) && !(u !== s && T.ELIDED_SUBJECT_RE.test(u)) });
    }
  }
}
const seen = new Set(); const uniq = units.filter(u => { const k = u.sid + u.page + u.unit; if (seen.has(k)) return false; seen.add(k); return true; });
uniq.forEach((u, i) => { u.id = i; });
fs.writeFileSync(path.join(ROOT, 'evals/runs/2026-10-09_jev-geometry/units.json'), JSON.stringify(uniq));
console.log('pages', all.length, 'units', uniq.length, 'code says people-free', uniq.filter(u => u.codeClean).length);
