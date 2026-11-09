'use strict';
// Real-Opus check (owner 2026-11-09 "Grade, then real-Opus check", ~USD 1.5, cap USD 2): book_audit stage on staging,
// today's prompt (arm A, no override) vs D3, books 13, 06, 04, 15, 09. Usage: node .../run-real-check.js
const fs = require('fs'); const path = require('path'); const { execSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..'); const key = require(path.join(ROOT, 'key.json'));
const BOOKS = ['book13', 'book06', 'book04', 'book15', 'book09'];
const BASE = 'https://staging.magicalstory.ch';
const token = execSync('node scripts/admin/get-admin-token.js', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
const H = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
const D3 = fs.readFileSync(path.join(ROOT, 'templates/d3-book-audit.txt'), 'utf8');
const targets = BOOKS.map(b => ({ storyId: key.books[b].storyId }));
const params = { modelId: key.modelId, bookReview: true };
(async () => {
  const ids = {};
  for (const [arm, override] of [['A', null], ['D3', D3]]) {
    const r = await fetch(BASE + '/api/admin/testlab/experiments', { method: 'POST', headers: H,
      body: JSON.stringify({ stage: 'book_audit', label: `Test I real check, arm ${arm} (5 books)`, targets, params, ...(override ? { promptOverride: override } : {}) }) });
    const j = await r.json(); if (!r.ok) throw new Error(arm + ' HTTP ' + r.status + ' ' + JSON.stringify(j).slice(0, 200));
    ids[arm] = j.experimentId || j.id; console.log(arm, 'exp', ids[arm]);
  }
  fs.writeFileSync(path.join(ROOT, 'real/exps.json'), JSON.stringify({ ids, books: BOOKS }, null, 1));
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
