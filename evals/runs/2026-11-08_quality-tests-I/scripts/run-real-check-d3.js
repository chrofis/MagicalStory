'use strict';
// Rerun of arm D3 on 3 books with the per-book placeholders pre-filled exactly as build-packets.js did
// (owner 2026-11-09 "Rerun on 3 books (~USD 0.60)"). Exp 1843 ran D3 with them stripped and is invalid.
// Usage: node .../run-real-check-d3.js [--dry]
require('dotenv').config();
const fs = require('fs'); const path = require('path'); const { execSync } = require('child_process'); const { Pool } = require('pg');
const ROOT = path.resolve(__dirname, '..'); const REPO = path.resolve(ROOT, '../../..');
const key = require(path.join(ROOT, 'key.json'));
const BOOKS = ['book13', 'book06', 'book15'];
const logicLine = (t, id) => { const l = t.split(/\r?\n/).find(x => x.startsWith(`${id}. `)); if (!l) throw new Error('no ' + id); return l.slice(id.length + 2).trim(); };
(async () => {
  const prompts = require(path.join(REPO, 'server/services/prompts')); await prompts.loadPromptTemplates();
  const lt = prompts.PROMPT_TEMPLATES.storyTextLogicRead;
  const LOGIC = { LOGIC_OBSTACLE: logicLine(lt, 'OBSTACLE'), LOGIC_KNOWLEDGE: logicLine(lt, 'KNOWLEDGE'), LOGIC_PLACE: logicLine(lt, 'PLACE'), LOGIC_CONTRADICTION: logicLine(lt, 'CONTRADICTION') };
  const { declaredMainNames } = require(path.join(REPO, 'server/lib/promptBuilders'));
  const { buildIdeaContract } = require(path.join(REPO, 'server/lib/ideaContract'));
  const tpl = fs.readFileSync(path.join(ROOT, 'templates/d3-book-audit.txt'), 'utf8');
  const pool = new Pool({ connectionString: process.env.STAGING_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const jobs = [];
  for (const b of BOOKS) {
    const storyId = key.books[b].storyId;
    const sd = (await pool.query('SELECT data FROM stories WHERE id=$1', [storyId])).rows[0].data;
    const names = declaredMainNames(sd); const chars = (sd.characters || []).map(c => c.name).filter(Boolean);
    const mains = names.length ? names : chars.slice(0, 1);
    const MAIN = mains.length > 1 ? `${mains.join(', ')} (together: the deciding act may be any one of them)` : (mains[0] || 'the character the story follows');
    const ids = sd.mainCharacters || [];
    const BUY = buildIdeaContract((sd.characters || []).map(c => ({ ...c, isMain: c.isMain || c.isMainCharacter || ids.includes(c.id) }))).BUY_CRITERION;
    const pre = { MAIN_CHARACTERS: MAIN, ...LOGIC, BUY_CRITERION: BUY };
    const filled = Object.entries(pre).reduce((t, [k, v]) => t.split(`{${k}}`).join(v), tpl);
    const left = (filled.match(/\{[A-Z_]+\}/g) || []).filter(p => /MAIN_CHARACTERS|LOGIC_|BUY_CRITERION/.test(p));
    if (left.length) throw new Error(b + ' still unfilled ' + left);
    // Same fill as the stand-in packet: every pre value must appear in prompt-D2.txt
    const packet = fs.readFileSync(path.join(ROOT, 'packets', b, 'prompt-D2.txt'), 'utf8');
    for (const [k, v] of Object.entries(pre)) if (!packet.includes(v)) throw new Error(`${b}: ${k} differs from packet`);
    console.log(b, storyId, 'main:', MAIN, 'filled ok');
    jobs.push({ b, storyId, filled });
  }
  await pool.end();
  if (process.argv.includes('--dry')) return;
  const token = execSync('node scripts/admin/get-admin-token.js', { cwd: REPO, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  const out = {};
  for (const j of jobs) {
    const r = await fetch('https://staging.magicalstory.ch/api/admin/testlab/experiments', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ stage: 'book_audit', label: `Test I real check, arm D3 filled, ${j.b}`, targets: [{ storyId: j.storyId }], params: { modelId: key.modelId, bookReview: true }, promptOverride: j.filled }) });
    const x = await r.json(); if (!r.ok) throw new Error(j.b + ' HTTP ' + r.status);
    out[j.b] = x.experimentId || x.id; console.log(j.b, 'exp', out[j.b]);
  }
  fs.writeFileSync(path.join(ROOT, 'real/exps-d3-filled.json'), JSON.stringify(out, null, 1));
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
