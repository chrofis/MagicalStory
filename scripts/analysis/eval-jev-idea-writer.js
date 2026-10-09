#!/usr/bin/env node
/**
 * Latency / quality of the writer with and without the in-stream [DRAFT]/[REVIEW]. Uses the stored FULL production
 * prompts of round 25 (tests/manual/story-idea-rounds/round-25.json), same model route as POST /generate-story-ideas-stream
 * (getModelDefaults().idea, no effort override).
 *   node scripts/analysis/eval-jev-idea-writer.js gen --ids=R25/c2/a1,... [--cap=0.45]
 *     arm TODAY      the stored prompt, [DRAFT]/[REVIEW]/[FINAL] in one stream   -> time to the card = end of stream
 *     arm FINALONLY  the same prompt with GENERATION PROCESS replaced by "output the idea only"
 *     arm FINAL+JEV  FINALONLY, then Jev review (narrow defect set); a flagged card gets ONE fed-back rewrite (FINALONLY prompt + the faults)
 * Output evals/runs/2026-10-09_jev-idea-review/writer.jsonl
 */
const fs = require('fs');
const path = require('path');
require('dotenv').config();
const RUN = path.join(__dirname, '../../evals/runs/2026-10-09_jev-idea-review/');
const { callTextModelStreaming, getModelDefaults } = require('../../server/lib/textModels');
const { MODEL_PRICING } = require('../../server/config/models');
const { callJev } = require('../../server/lib/jevAudit');
const E = require('./eval-jev-idea-review');
const argv = Object.fromEntries(process.argv.slice(3).map(a => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));
const MODEL = getModelDefaults().idea;
const OUT = RUN + 'writer.jsonl';

/** Jev review of a card: the narrow defect questions whose false-flag rate on stored finals is small (injection control). */
const REVIEW_SET = {
  B_LEAK_END: { thr: 0.7, fault: 'It tells how the story ends or whether the child manages it. Stop before the outcome.' },
  B_FEEL: { thr: 0.5, fault: 'It names a feeling in words. Show it by what the body does or cut it.' },
  B_OPEN_STATES: { thr: 0.5, fault: 'The first sentence only states where and when. Open on the main character or the one out-of-the-ordinary thing.' },
  B_NEW_COMPANION: { thr: 0.8, fault: 'A person joins who is not in the cast. Only the cast, a stranger or a keeper standing in the way may appear.' },
  B_ACT_HOLD: { thr: 0.6, fault: 'The last sentence has the child already holding or having the thing the idea turns on. End on a movement of the body toward the want.' },
};
async function jevReview(it, text) {
  const all = E.questionsFor(it, 'B');
  const questions = Object.fromEntries(Object.keys(REVIEW_SET).map(q => [q, all[q]]));
  const t0 = Date.now();
  const r = await callJev({ state: E.state(it, text), questions });
  const flags = Object.entries(REVIEW_SET).filter(([q, c]) => r.answers[q].noul >= c.thr).map(([q, c]) => ({ q, p: r.answers[q].noul, fault: c.fault }));
  return { flags, ms: Date.now() - t0, cost: r.cost, probs: Object.fromEntries(Object.keys(REVIEW_SET).map(q => [q, r.answers[q].noul])) };
}

function finalOnlyPrompt(p) {
  const a = p.indexOf('## GENERATION PROCESS:');
  const f = p.indexOf('[FINAL]\nThe corrected, final version of the story idea.');
  if (a < 0 || f < 0) throw new Error('prompt shape changed');
  const tail = p.slice(f + '[FINAL]\nThe corrected, final version of the story idea.'.length);
  return p.slice(0, a)
    .replace('All text in [DRAFT], [REVIEW], and [FINAL] sections must be in this language', 'All text must be in this language')
    .replace('[FINAL] holds the idea text only:', 'The output holds the idea text only:')
    + '## OUTPUT\n\nWrite the finished story idea and nothing else: no headings, no notes, no second version, no commentary. Before you write it, hold it against every rule above.\n' + tail;
}
const lastFinal = raw => { const m = [...String(raw).matchAll(/\[FINAL\]\s*/gi)]; return m.length ? raw.slice(m[m.length - 1].index + m[m.length - 1][0].length).trim() : null; };
const price = u => ((u?.input_tokens || 0) * MODEL_PRICING['claude-sonnet'].input + ((u?.output_tokens || 0) + (u?.thinking_tokens || 0) * 0) * MODEL_PRICING['claude-sonnet'].output) / 1e6;

async function stream(prompt) {
  const t0 = Date.now(); let first = null; let text = '';
  const r = await callTextModelStreaming(prompt, null, (d, full) => { if (first === null) first = Date.now() - t0; text = full; }, MODEL, {});
  return { text: r?.text || text, ms: Date.now() - t0, ttft: first, usage: r?.usage || null, cost: price(r?.usage) };
}

async function gen() {
  const r25 = JSON.parse(fs.readFileSync(path.join(__dirname, '../../tests/manual/story-idea-rounds/round-25.json'), 'utf8'));
  const prompts = {}; for (const c of r25.cells) for (const i of c.ideas) prompts[`R25/c${c.cell.id}/a${i.index}`] = i.prompt;
  const meta = Object.fromEntries(E.load().filter(x => x.round === '25').map(x => [x.id, x]));
  const ids = String(argv.ids).split(',');
  const cap = Number(argv.cap || 0.45); let spent = 0;
  const out = fs.createWriteStream(OUT, { flags: 'a' });
  await Promise.all(ids.map(async id => {
    const it = meta[id]; const p = prompts[id];
    const [today, fo] = await Promise.all([stream(p), stream(finalOnlyPrompt(p))]);
    spent += today.cost + fo.cost;
    const todayFinal = lastFinal(today.text);
    const foText = fo.text.replace(/^\s*\[FINAL\]\s*/i, '').trim();
    let jev = await jevReview(it, foText); let rewrite = null;
    if (jev.flags.length && spent < cap) {
      const fb = `\n\nA reviewer read your idea and found:\n${jev.flags.map(f => '- ' + f.fault).join('\n')}\n\nYour idea was:\n${foText}\n\nWrite the corrected idea now, nothing else.`;
      rewrite = await stream(finalOnlyPrompt(p) + fb); spent += rewrite.cost;
      rewrite.text = rewrite.text.replace(/^\s*\[FINAL\]\s*/i, '').trim();
      rewrite.jev = await jevReview(it, rewrite.text);
    }
    const row = { id, model: MODEL, today: { ms: today.ms, ttft: today.ttft, usage: today.usage, cost: today.cost, text: todayFinal, raw: today.text },
      finalOnly: { ms: fo.ms, ttft: fo.ttft, usage: fo.usage, cost: fo.cost, text: foText }, jev, rewrite };
    out.write(JSON.stringify(row) + '\n');
    console.log(id, `today ${today.ms}ms $${today.cost.toFixed(3)} out ${today.usage?.output_tokens} | finalOnly ${fo.ms}ms $${fo.cost.toFixed(3)} out ${fo.usage?.output_tokens} | jev ${jev.ms}ms flags ${jev.flags.map(f => f.q).join(',') || '-'}${rewrite ? ` | rewrite ${rewrite.ms}ms flags-after ${rewrite.jev.flags.map(f => f.q).join(',') || '-'}` : ''}`);
  }));
  out.end(); console.log('spent', spent.toFixed(3));
}
if (process.argv[2] === 'gen') gen().catch(e => { console.error(e); process.exit(1); });
