/**
 * Compares Jev question wordings for the idea coherence check against the hand
 * labels of a stored run (no model generation; ~USD 0.0007 per wording).
 *   node scripts/analysis/eval-idea-coherence-wording.js <out.json> <labels.json>
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '../..');
const out = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const labels = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
const { callJev, yesProb } = require(path.join(ROOT, 'server/lib/jevAudit'));
const { COMMISSIONED_ACT_PHRASE: ACT, INSERTED_ACT_PHRASE: INS } = require(path.join(ROOT, 'server/lib/ideaCoherence'));

const V = {
  forced: {
    F2: `If the main character did not deal with the topic named above, what stands in the way in this idea would stay unsolved.`,
    F4: `What the main character does about the topic named above is a reaction to what stands in the way, not something added next to it.`,
    F6: `Without the main character dealing with the topic named above, they could not get past what stands in the way.`,
    F7: `What stands in the way in this idea can only be overcome by dealing with the topic named above.`,
    F8: `The topic named above is dealt with because the situation forces it, not because the story needs to mention it.`,
    F9: `The main character deals with the topic named above only because what stands in the way leaves no other option.`,
    F10: `The act in this idea that deals with the topic named above is needed to solve what stands in the way.`,
  },
  follows: {
    W1: `Every act in this idea follows from the situation set up before it: a reader of the earlier sentences sees why the main character does it, and none is an act ${INS}.`,
    W3: `Some act in this idea has no reason in what happened before it: it is there for another purpose.`,
    W6: `Some act in this idea is there only to bring the topic or the theme into the story, not because the situation calls for it.`,
    W7: `Some act in this idea does not make sense as a reaction to what came before it.`,
  },
};
const auc = (pos, neg) => { let s = 0; for (const p of pos) for (const n of neg) s += p > n ? 1 : p === n ? 0.5 : 0; return s / (pos.length * neg.length); };

(async () => {
  const items = [];
  for (const r of out.rows) for (const arm of Object.keys(r.cards)) {
    const lab = labels[`${r.cell.id}.${arm}`]; const idea = r.cards[arm].final;
    if (lab && idea) items.push({ id: `${r.cell.id}.${arm}`, cell: r.cell, idea, lab });
  }
  for (const q of ['forced', 'follows']) for (const [vid, text] of Object.entries(V[q])) {
    const rows = [];
    for (const it of items) {
      if (q === 'forced' && (it.lab.forced === null || it.cell.category !== 'life-challenge')) continue;
      const topic = it.cell.topic.replace(/-/g, ' ');
      const state = `A STORY IDEA FOR A CHILD'S PICTURE BOOK.\n${q === 'forced' ? `The topic: ${topic}.\n` : ''}\nTHE IDEA:\n${it.idea}`;
      const r = await callJev({ state, questions: { q: { type: 'noul', instructions: text } } });
      const p = yesProb(r.answers.q);
      const good = q === 'forced' ? it.lab.forced : it.lab.follows;
      rows.push({ p: vid === 'W3' ? 1 - p : p, good });
    }
    const pos = rows.filter(x => x.good).map(x => x.p), neg = rows.filter(x => !x.good).map(x => x.p);
    let best = { t: 0, f: -1 };
    for (let t = 0.05; t < 1; t += 0.05) { const fl = rows.filter(x => x.p < t); const tp = fl.filter(x => !x.good).length; const pr = fl.length ? tp / fl.length : 0, rc = neg.length ? tp / neg.length : 0; const f = pr + rc ? 2 * pr * rc / (pr + rc) : 0; if (f > best.f) best = { t: +t.toFixed(2), f: +f.toFixed(2), pr: +pr.toFixed(2), rc: +rc.toFixed(2) }; }
    console.log(`${q} ${vid}: AUC ${auc(pos, neg).toFixed(2)} (good ${pos.length}, bad ${neg.length}) best F1 at t=${best.t}: F1 ${best.f} precision ${best.pr} recall ${best.rc}`);
  }
})().catch(e => { console.error(e); process.exit(1); });
