#!/usr/bin/env node
/**
 * Positive control for the Jev idea reviewer: inject ONE blatant, known defect into each stored FINAL
 * (end told, new companion, act holds the key thing, named feeling, opening states where/when) and see
 * whether the matching narrow question moves. Injected defects are easy; real REVIEW fixes are not
 * (see docs/decisions.md 2026-09-27 "Jev text audit": injected AUC high, real errors ~ chance).
 *   node scripts/analysis/eval-jev-idea-injection.js run | analyse
 */
const fs = require('fs');
const path = require('path');
require('dotenv').config();
const RUN = path.join(__dirname, '../../evals/runs/2026-10-09_jev-idea-review/');
const { callJev } = require('../../server/lib/jevAudit');
const E = require('./eval-jev-idea-review');
const OUT = RUN + 'injection.jsonl';
const mode = process.argv[2];
const T = {
  de: {
    END: m => `Am Ende gelingt es ${m}, und alle freuen sich.`,
    COMPANION: m => `Ein Nachbar namens Herr Brunner kommt dazu und hilft ${m} beim Suchen.`,
    HOLD: m => `${m} hält den Schlüssel schon in der Hand und weiss, was zu tun ist.`,
    FEEL: m => `${m} ist traurig und hat Angst.`,
    OPEN: () => 'Es ist Herbst, und die Geschichte spielt in Baden.',
  },
  fr: {
    END: m => `À la fin, ${m} y arrive et tout le monde est content.`,
    COMPANION: m => `Un voisin, Monsieur Brunner, vient aider ${m} à chercher.`,
    HOLD: m => `${m} tient déjà la clé dans sa main et sait quoi faire.`,
    FEEL: m => `${m} est triste et a peur.`,
    OPEN: () => "C'est l'automne, et l'histoire se passe à Baden.",
  },
};
const sentences = t => t.replace(/\n+/g, ' ').split(/(?<=[.!?»])\s+/).filter(Boolean);
function variants(it) {
  const m = E.mainName(it).split(' and ')[0];
  const t = T[String(it.lang).slice(0, 2)]; const s = sentences(it.final);
  if (!t || s.length < 3) return null;
  return {
    ORIG: it.final,
    END: [...s, t.END(m)].join(' '),
    COMPANION: [s[0], t.COMPANION(m), ...s.slice(1)].join(' '),
    HOLD: [...s.slice(0, -1), t.HOLD(m)].join(' '),
    FEEL: [...s, t.FEEL(m)].join(' '),
    OPEN: [t.OPEN(), ...s].join(' '),
  };
}
async function run() {
  const ideas = E.load().filter(x => !x.id.startsWith('R25') || true);
  const done = new Set(fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8').split('\n').filter(Boolean).map(l => { const o = JSON.parse(l); return `${o.id}|${o.v}`; }) : []);
  const jobs = [];
  for (const it of ideas) { const v = variants(it); if (!v) continue; for (const [k, text] of Object.entries(v)) if (!done.has(`${it.id}|${k}`)) jobs.push({ it, k, text }); }
  console.log('jobs', jobs.length);
  const out = fs.createWriteStream(OUT, { flags: 'a' });
  let i = 0; let spent = 0;
  async function worker() {
    while (i < jobs.length && spent < 0.25) {
      const { it, k, text } = jobs[i++];
      const questions = { ...E.questionsFor(it, 'B'), ...E.questionsFor(it, 'S'), ...Object.fromEntries(Object.entries(E.questionsFor(it, 'G')).filter(([q]) => ['G_NO_END', 'G_NO_NEW', 'G_ACT', 'G_ACT_FREE', 'G_FEEL', 'G_OPEN', 'G_NO_MIDDLE'].includes(q))) };
      try { const r = await callJev({ state: E.state(it, text), questions }); spent += r.cost; out.write(JSON.stringify({ id: it.id, v: k, answers: r.answers }) + '\n'); } catch (e) { console.log('FAIL', it.id, k, e.message.slice(0, 100)); }
    }
  }
  await Promise.all(Array.from({ length: 8 }, worker));
  out.end(); console.log('spent', spent.toFixed(4));
}
const auc = (pos, neg) => { let w = 0; for (const p of pos) for (const n of neg) w += p > n ? 1 : p === n ? 0.5 : 0; return w / (pos.length * neg.length); };
function analyse() {
  const rows = fs.readFileSync(OUT, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  const by = {}; for (const r of rows) (by[r.v] = by[r.v] || {})[r.id] = Object.fromEntries(Object.entries(r.answers).map(([q, a]) => [q, a.type === 'score' ? a.score : a.noul]));
  const MAP = { END: ['B_LEAK_END', 'G_NO_END', 'S_LEAK'], COMPANION: ['B_NEW_COMPANION', 'G_NO_NEW'], HOLD: ['B_ACT_HOLD', 'G_ACT_FREE', 'S_ACT', 'G_ACT'], FEEL: ['B_FEEL', 'G_FEEL'], OPEN: ['B_OPEN_STATES', 'G_OPEN'] };
  const ids = Object.keys(by.ORIG);
  for (const [v, qs] of Object.entries(MAP)) for (const q of qs) {
    const hi = q.startsWith('B_'); // defect question: injected should score higher
    const sgn = (hi) ? 1 : -1; // for G/S injected should score LOWER
    const a = ids.filter(i => by[v][i]).map(i => by[v][i][q] * sgn), o = ids.filter(i => by[v][i]).map(i => by.ORIG[i][q] * sgn);
    // paired wins
    let w = 0; ids.filter(i => by[v][i]).forEach(i => { const d = (by[v][i][q] - by.ORIG[i][q]) * sgn; w += d > 0 ? 1 : d === 0 ? 0.5 : 0; });
    // flag rate at 0.5 on originals vs injected (noul only)
    const fl = x => (q.startsWith('S_') ? x * sgn < -2 * sgn * sgn : (hi ? x > 0.5 : x < 0.5));
    console.log(`${v.padEnd(10)} ${q.padEnd(16)} n=${a.length} AUC ${auc(a, o).toFixed(2)} paired ${(w / a.length).toFixed(2)}${q.startsWith('S_') ? '' : `  flag@0.5 injected ${(a.length ? a.map((_, k) => fl(by[v][ids.filter(i => by[v][i])[k]][q])).filter(Boolean).length / a.length : 0).toFixed(2)} originals ${(ids.map(i => fl(by.ORIG[i][q])).filter(Boolean).length / ids.length).toFixed(2)}`}`);
  }
}
if (mode === 'run') run().catch(e => { console.error(e); process.exit(1); });
if (mode === 'analyse') analyse();
