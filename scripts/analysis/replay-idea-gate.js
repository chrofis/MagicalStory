/**
 * Replays the WIRED trial idea gate (ideaJevRubric.judgeIdeaRubric, the function
 * trialIdeaCheck.finishIdeaCard calls) over the stored labelled cards of
 * evals/runs/2026-10-09_jev-idea-rubric/.
 *
 *   node scripts/analysis/replay-idea-gate.js replay            # stored Jev answers (prod-answers.jsonl), no calls
 *   node scripts/analysis/replay-idea-gate.js latency [N=30]    # N real Jev calls on stored cards, 2 at a time (USD ~0.00004 each)
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const DIR = path.join(ROOT, 'evals/runs/2026-10-09_jev-idea-rubric');
const R = require(path.join(ROOT, 'server/lib/ideaJevRubric'));

const cards = JSON.parse(fs.readFileSync(path.join(DIR, 'cards.json'), 'utf8')).filter(c => c.set === 'real');
const isGood = c => ['forced', 'follows', 'enjoy', 'buy', 'charcon', 'agency', 'agefit', 'topic', 'theme'].every(k => c.lab[k] == null || c.lab[k] === 1);
const ctxOf = c => ({ age: c.ctx.age, topic: c.ctx.topic || '', theme: c.ctx.theme || '' });
const pct = x => (100 * x).toFixed(1) + '%';

async function replay() {
  const stored = new Map(fs.readFileSync(path.join(DIR, 'prod-answers.jsonl'), 'utf8').trim().split('\n').map(l => { const j = JSON.parse(l); return [j.id, j]; }));
  const rows = [];
  for (const c of cards) {
    const s = stored.get(c.id);
    if (!s) continue;
    const r = await R.judgeIdeaRubric(c.text, ctxOf(c), { callImpl: async () => ({ answers: s.answers, cost: s.cost }) });
    rows.push({ id: c.id, blind: c.blind, good: isGood(c), ok: r.ok, failure: r.failure, score: r.score, tripped: r.tripped });
  }
  const flagged = rows.filter(r => !r.ok); const bad = rows.filter(r => !r.good);
  const tp = flagged.filter(r => !r.good).length;
  console.log(`cards ${rows.length}, bad by hand ${bad.length}`);
  console.log(`rerun rate ${pct(flagged.length / rows.length)} (${flagged.length}), precision ${(tp / flagged.length).toFixed(2)}, recall ${(tp / bad.length).toFixed(2)}`);
  console.log(`by cause: tripwire ${flagged.filter(r => r.tripped.length).length}, low score ${flagged.filter(r => !r.tripped.length).length}`);
  console.log('tripped:', JSON.stringify(rows.filter(r => r.tripped.length).map(r => [r.blind, r.tripped])));
}

async function latency(n) {
  const sample = cards.slice(0, n); const ms = []; let cost = 0; let fails = 0;
  for (let i = 0; i < sample.length; i += 2) {
    await Promise.all(sample.slice(i, i + 2).map(async c => {
      try { const r = await R.judgeIdeaRubric(c.text, ctxOf(c)); ms.push(r.ms); cost += r.cost; } catch (e) { fails++; console.error(c.id, e.message); }
    }));
  }
  ms.sort((a, b) => a - b);
  const q = p => ms[Math.min(ms.length - 1, Math.floor(p * ms.length))];
  console.log(`real Jev calls ${ms.length} ok, ${fails} failed; added latency per card p50 ${q(0.5)} ms, p90 ${q(0.9)} ms, max ${ms[ms.length - 1]} ms; cost USD ${cost.toFixed(5)}`);
}

(async () => {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === 'replay') await replay();
  else if (cmd === 'latency') await latency(parseInt(arg, 10) || 30);
  else { console.error('usage: replay | latency [N]'); process.exit(1); }
})().catch(e => { console.error(e); process.exit(1); });
