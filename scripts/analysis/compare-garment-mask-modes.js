#!/usr/bin/env node
/**
 * Run every garment-colour MASK MODE against the same real pages, in the Test
 * Lab, through the production code path — then print one comparison table.
 *
 * This exists because the modes were first compared on a downloaded JPEG with a
 * hand-rolled script, which proves nothing about the pipeline: it skips the real
 * detection, the real avatar target, the real crop and the real gates. Every run
 * here goes through `garment_colour_fix`, pinned to a specific version so each
 * mode starts from identical bytes.
 *
 * Usage:
 *   node scripts/analysis/compare-garment-mask-modes.js
 *   node scripts/analysis/compare-garment-mask-modes.js --modes=colour,intersect
 *   node scripts/analysis/compare-garment-mask-modes.js --verify=model
 *
 * Auth: scripts/admin/get-admin-token.js semantics (TESTLAB_USER/PASSWORD).
 */
const arg = (n, d) => {
  const hit = process.argv.find(a => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const BASE = arg('base', 'https://staging.magicalstory.ch');
const MODES = arg('modes', 'dino-sam,dino-sam-points,colour,intersect').split(',');
const VERIFY = arg('verify', 'off');
const QUERY = arg('query', 'single');   // 'single' | 'multi' (multi-phrase garment queries)
const EMAIL = process.env.TESTLAB_USER || 'demo-b-hnecf@magicalstory.ch';
const PASSWORD = process.env.TESTLAB_PASSWORD || 'DemoStory2026!';

// The two known-bad pages, with the garment + observed colour the entity check
// actually emitted for them. `expect` records what a correct mask looks like, so
// the table can be read without opening every image.
const CASES = [
  { label: 'mermaid p4 top', storyId: 'job_1786571353564_0sgrd0f4g', pageNumber: 4, versionIndex: 0,
    characterName: 'Noah', garment: 'top', observedColour: 'yellow',
    expect: 'the yellow shell top — NOT face, hair, arms or tail' },
  { label: 'mermaid p4 skirt', storyId: 'job_1786571353564_0sgrd0f4g', pageNumber: 4, versionIndex: 0,
    characterName: 'Noah', garment: 'skirt', observedColour: 'yellow/gold',
    expect: 'the yellow tail — NOT face, hair or skin' },
  { label: 'wizard p3 dress', storyId: 'job_1786484554633_crojok432', pageNumber: 3, versionIndex: 0,
    characterName: 'Noah', garment: 'dress', observedColour: 'purple',
    expect: 'the purple robe — NOT the cream map' },
  { label: 'wizard p3 hat', storyId: 'job_1786484554633_crojok432', pageNumber: 3, versionIndex: 0,
    characterName: 'Noah', garment: 'hat', observedColour: 'purple',
    expect: 'the purple hat (the control — this one already worked)' },
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: EMAIL, password: PASSWORD }),
  });
  if (!login.ok) { console.error(`login failed: ${login.status}`); process.exit(1); }
  const { token } = await login.json();
  const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

  const rows = [];
  for (const c of CASES) {
    for (const mode of MODES) {
      const label = `${c.label} · ${mode}${QUERY === 'multi' ? ' +multiq' : ''}${VERIFY === 'model' ? ' +ask' : ''}`;
      const body = {
        stage: 'garment_colour_fix', label,
        targets: [{ storyId: c.storyId, pageNumber: c.pageNumber }],
        params: {
          garment: c.garment, versionIndex: c.versionIndex, characterName: c.characterName,
          observedColour: c.observedColour,
          opts: { maskMode: mode, verifyMask: VERIFY, queryMode: QUERY },
        },
      };
      const res = await fetch(`${BASE}/api/admin/testlab/experiments`, { method: 'POST', headers: H, body: JSON.stringify(body) });
      const j = await res.json();
      if (!res.ok) { console.error(`${label}: ${res.status} ${JSON.stringify(j)}`); continue; }
      process.stdout.write(`${label} → exp ${j.id} `);
      let exp = null;
      for (let i = 0; i < 60; i++) {
        await sleep(8000);
        const s = await fetch(`${BASE}/api/admin/testlab/experiments/${j.id}`, { headers: H });
        exp = await s.json();
        if (exp.status !== 'running') break;
      }
      console.log(exp?.status || 'timeout');
      const result = (exp?.results || [])[0] || {};
      const fig = (result.perFigure || []).find(f => (f.name || '').toLowerCase() === c.characterName.toLowerCase())
        || (result.perFigure || [])[0] || {};
      rows.push({
        case: c.label, mode, expId: j.id,
        applied: fig.applied === true,
        maskPx: fig.current?.px ?? null,
        cropPx: fig.cropPx ?? null,
        pct: (fig.current?.px && fig.cropPx) ? Math.round(100 * fig.current.px / fig.cropPx) : null,
        curHue: fig.current?.hueDeg ?? null,
        curL: fig.current?.L ?? null,
        deltaE: fig.delta?.deltaE ?? null,
        boxPct: (fig.dinoBoxPx && fig.cropPx) ? Math.round(100 * fig.dinoBoxPx / fig.cropPx) : null,
        selectPx: fig.colourSelect?.px ?? null,
        ask: fig.maskAsk ? (fig.maskAsk.asked ? (fig.maskAsk.isGarment ? 'YES' : `NO (${fig.maskAsk.whatItIs})`) : `n/a`) : '',
        tried: (fig.queriesTried || []).map(t => `${t.frac ?? '-'}@${t.score ?? '-'}`).join(' '),
        picked: fig.queryPicked || '',
        reason: fig.reason || '',
      });
    }
  }

  console.log('\n' + '='.repeat(118));
  console.log('case                  mode              applied  maskPx   %crop  box%  curL  curHue   ΔE    ask        reason');
  console.log('='.repeat(118));
  for (const r of rows) {
    console.log(
      `${r.case.padEnd(21)} ${r.mode.padEnd(17)} ${String(r.applied).padEnd(7)} `
      + `${String(r.maskPx ?? '-').padStart(7)} ${String(r.pct ?? '-').padStart(5)}% ${String(r.boxPct ?? '-').padStart(4)}% `
      + `${String(r.curL ?? '-').padStart(5)} ${String(r.curHue ?? '-').padStart(7)} ${String(r.deltaE ?? '-').padStart(5)}  `
      + `${String(r.ask).padEnd(10)} ${String(r.reason).slice(0, 34)}`);
    if (r.tried) console.log(`${''.padEnd(22)}   phrasings (frac@score): ${r.tried}${r.picked ? `  → picked "${r.picked}"` : ''}`);
  }
  console.log('='.repeat(118));
  for (const c of CASES) console.log(`${c.label}: expect ${c.expect}`);
  console.log('\nExperiment ids:', rows.map(r => `${r.mode}=${r.expId}`).join(' '));
})().catch(e => { console.error(e); process.exit(1); });
