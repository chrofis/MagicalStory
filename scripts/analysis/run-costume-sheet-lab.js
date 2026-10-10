// Runs the Lab stage avatar_sheet_variant over the 10 characters of the 2026-10-10 costume-sheet test (stored staging characters).
// usage (from the repo root): node run.js <label> <variant> <costume> <ageLine 0|1> <outfile> [names comma list] [extra stage params as JSON, e.g. '{"grokModel":"2.0","anchor":false}']
// (the 2026-10-10 Grok 2.0 sheet matrix used the extra-params argument and the 3 characters Emma, Lukas, Hans)
const { execSync } = require('child_process');
const fs = require('fs');
const [label, variant, costume, ageLine, out, only, extraJson] = process.argv.slice(2);
const BASE = 'https://staging.magicalstory.ch';
const token = execSync('node scripts/admin/get-admin-token.js', { cwd: require('path').join(__dirname, '../..') }).toString().trim();
const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
const all = [
  ['Noah', 'job_1788715081819_lvxzpul0z'], ['Felix', 'job_1791218523638_d2gmrn0yn'], ['Emma', 'job_1791554548909_kl0phznw2'],
  ['Lily6', 'job_1788725396265_p3dh87hsv'], ['Lily7', 'job_1791500208126_at0wow7xa'], ['Serafin', 'job_1791560888615_uaivmr21o'],
  ['Lukas', 'job_1791490151653_r9mypyn0c'], ['Daniel', 'job_1791551239260_a0dpn715x'], ['Sarah', 'job_1787469664089_9e27p42el7l'], ['Hans', 'job_1791551239260_a0dpn715x'],
];
const want = only ? only.split(',') : all.map(a => a[0]);
const targets = all.filter(a => want.includes(a[0])).map(([n, s]) => ({ storyId: s, character: n.replace(/\d$/, '') }));
(async () => {
  const body = { stage: 'avatar_sheet_variant', label, params: { variant, costume, skipReview: true, ...(ageLine === '1' ? { ageLine: true } : {}), ...(extraJson ? JSON.parse(extraJson) : {}) }, targets };
  const r = await fetch(`${BASE}/api/admin/testlab/experiments`, { method: 'POST', headers: H, body: JSON.stringify(body) });
  const j = await r.json(); console.log('start', r.status, JSON.stringify(j).slice(0, 200));
  if (!j.id) process.exit(1);
  for (;;) {
    await new Promise(res => setTimeout(res, 15000));
    const e = await (await fetch(`${BASE}/api/admin/testlab/experiments/${j.id}`, { headers: H })).json();
    const ex = e.experiment || e;
    const n = (ex.results || []).length;
    console.log(new Date().toISOString(), ex.status, n + '/' + targets.length);
    if (ex.status !== 'running') { fs.writeFileSync(out, JSON.stringify(ex, null, 1)); console.log('saved', out, 'id', j.id); break; }
  }
})();
