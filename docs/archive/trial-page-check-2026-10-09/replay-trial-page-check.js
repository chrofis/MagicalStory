/**
 * Replay the trial page check (server/lib/trialPageCheck.js) over STORED trial
 * page images. Paid: one inventory call per page (the cheapest inventory model).
 *
 *   node scripts/analysis/replay-trial-page-check.js <dir> <jobId>[,<jobId>...] [--pages 1,2,3]
 *
 * <dir> holds <last9ofJobId>_p<N>.png and <jobId>.story.json (characters,
 * sceneImages[{p,text,desc,sceneMetadata}], visualBible), as written by the
 * fetch step in docs/decisions.md "The trial gets a minimal page check".
 */
'use strict';
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { checkTrialPage } = require('../../server/lib/trialPageCheck');
const { unionPageCast } = require('../../server/lib/sceneMetadata');

(async () => {
  await require('../../server/services/prompts').loadPromptTemplates();
  const [dir, jobsArg, ...rest] = process.argv.slice(2);
  const pagesArg = rest.indexOf('--pages') >= 0 ? rest[rest.indexOf('--pages') + 1].split(',').map(Number) : null;
  const out = [];
  for (const jobId of jobsArg.split(',')) {
    const story = JSON.parse(fs.readFileSync(path.join(dir, `${jobId}.story.json`), 'utf8'));
    const pages = story.sceneImages.filter(s => !pagesArg || pagesArg.includes(s.p));
    const results = await Promise.all(pages.map(async (s) => {
      const file = path.join(dir, `${jobId.slice(-9)}_p${s.p}.png`);
      const imageData = fs.readFileSync(file).toString('base64');
      const names = s.sceneMetadata?.characters || [];
      const sceneCharacters = unionPageCast(`${s.desc || ''}\n${s.text || ''}`, names, story.characters);
      const r = await checkTrialPage({
        imageData, pageContext: `${jobId.slice(-9)} p${s.p}`, pageNumber: s.p,
        sceneMetadata: s.sceneMetadata, sceneCharacters, visualBible: story.visualBible,
        inputData: { characters: story.characters, language: 'de' },
      });
      return { job: jobId.slice(-9), page: s.p, ...r };
    }));
    out.push(...results);
  }
  for (const r of out) {
    console.log(`${r.job} p${r.page}: ${r.available ? (r.ok ? 'CLEAN' : 'FAIL') : 'UNAVAILABLE'} figures=${r.figures} expected=${r.expectedPeople} pop=${r.population} ${r.ms}ms lettering=${JSON.stringify(r.lettering)}${r.findings?.length ? ' :: ' + r.findings.map(f => f.type + ': ' + f.description).join(' | ') : ''}`);
  }
  const ms = out.map(r => r.ms).sort((a, b) => a - b);
  console.log(`latency ms: min ${ms[0]} median ${ms[Math.floor(ms.length / 2)]} max ${ms[ms.length - 1]} (n=${ms.length}, parallel)`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
