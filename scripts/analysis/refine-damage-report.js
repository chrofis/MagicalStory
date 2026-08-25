#!/usr/bin/env node
/**
 * REFINE DAMAGE REPORT — what the text-refine stage costs the prose.
 *
 * The stage fixes real continuity faults and pays for them by rewriting page
 * text. This measures the price on a corpus: for every page, diff the WRITER's
 * sentences against the REFINED ones and count what left, what arrived, and
 * which of the known damage signatures the arrival matches.
 *
 * Born from the 2026-08-25 provenance trace of job_1787638707796, where the
 * stage fixed 14 faults, deleted 8 emotional sentences and invented a wade
 * across a stream that made the story's first obstacle retroactively passable.
 * See docs/decisions.md (2026-08-25) and tasks/story-text-quality-2026-08-25.md.
 *
 * Usage:
 *   node scripts/analysis/refine-damage-report.js --db=staging <storyId> [...]
 *   node scripts/analysis/refine-damage-report.js --db=staging --stored <storyId>
 *   node scripts/analysis/refine-damage-report.js --db=staging --exp=123
 *
 *   --stored   compare data.storyText against the SHIPPED page text (the
 *              baseline arm — what the stage did on the real run, free)
 *   --exp=N    compare data.storyText against a Lab text_refine experiment's
 *              finalPages (the new-prompt arm)
 *
 * Prints a per-story table and a corpus total. Both arms use the same counter,
 * so the two numbers are comparable.
 */
require('dotenv').config();
const { Pool } = require('pg');

const arg = (n, d) => {
  const hit = process.argv.find(a => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const has = n => process.argv.includes(`--${n}`);

const DB = arg('db', 'staging') === 'prod' ? process.env.DATABASE_URL : process.env.STAGING_DATABASE_URL;
const EXP = arg('exp');
const IDS = process.argv.slice(2).filter(a => !a.startsWith('--'));

// ── Damage signatures ────────────────────────────────────────────────────────
// Each is a defect the trace found the stage introducing. They are counted on
// text the refiner ADDED, never on text the writer already had — the question
// is what the stage puts in, not what the story contains.

// A named part of the day or a clock reading, written in to close a
// time-of-day continuity fault instead of showing time in light and behaviour.
const CLOCK = /\b(Nachmittag|Vormittag|Morgen(?:s|stunde)?|Abend(?:s)?|Mittag|Dämmerung|afternoon|morning|evening|midday|noon|dusk|dawn|après-midi|matin|soir)\b/gi;

// A page opening that narrates the journey between two pages rather than the
// page's own moment — what a page turn already carries.
const TRAVELOGUE = /^\s*(Nach\s+(?:dem|der|den)\b|Auf dem (?:Heim)?weg\b|Danach\b|Anschliessend\b|After (?:the|their)\b|On the way\b|Then they (?:walk|went|head)\b|Après\b)/i;

// Prose that names an interior state — the class the stage kept cutting to make
// room. Counted on DEPARTURES (a loss) and on ARRIVALS (a gain).
const FEELING = /\b(fühlt|spürt|merkt|bemerkt|denkt|hofft|Angst|froh|stolz|traurig|müde|erschrocken|zögert|zaudert|traut sich|wagt|beinahe|fast\b|will nicht|mag nicht|Herz|lacht|weint|seufzt|flüstert|strahlt|Gesicht ist|schaut .{0,20}(?:an|zu)|feels?|notices?|wonders?|hopes?|afraid|glad|proud|sad|tired|almost|hesitat|heart|laughs?|cries|whispers?)\b/i;

// Prose that names only objects, positions and who still holds what — the
// bookkeeping the stage substitutes for feeling.
const BOOKKEEPING = /\b(hält|trägt|schiebt|steht neben|liegt neben|in der Hand|dabei|noch immer|weiterhin|holds?|carries|pushes|beside (?:him|her|them)|still (?:has|holds))\b/i;

const sentences = t => String(t || '')
  .replace(/\s+/g, ' ')
  .split(/(?<=[.!?»])\s+/)
  .map(s => s.trim())
  .filter(Boolean);

// Loose match: a sentence counts as SURVIVING when a refined sentence shares
// most of its content words. Refine legitimately rephrases; only a sentence
// whose content is gone counts as a deletion.
const words = s => new Set(String(s).toLowerCase().match(/[\p{L}]{4,}/gu) || []);
const overlap = (a, b) => {
  const A = words(a), B = words(b);
  if (A.size === 0) return 0;
  let hit = 0;
  for (const w of A) if (B.has(w)) hit++;
  return hit / A.size;
};
const survives = (s, pool) => pool.some(p => overlap(s, p) >= 0.5);

function scorePage(writer, refined) {
  const W = sentences(writer), R = sentences(refined);
  const gone = W.filter(s => !survives(s, R));
  const added = R.filter(s => !survives(s, W));
  return {
    changed: writer.replace(/\s+/g, ' ').trim() !== refined.replace(/\s+/g, ' ').trim(),
    feelingLost: gone.filter(s => FEELING.test(s)),
    feelingGained: added.filter(s => FEELING.test(s)),
    bookkeepingAdded: added.filter(s => BOOKKEEPING.test(s) && !FEELING.test(s)),
    // Only clock words the refiner introduced, not ones the writer wrote.
    clockAdded: added.filter(s => CLOCK.test(s)).filter(s => !W.some(w => CLOCK.test(w) && overlap(s, w) >= 0.3)),
    travelogue: TRAVELOGUE.test(refined) && !TRAVELOGUE.test(writer) ? [R[0]] : [],
    gone, added,
  };
}

/**
 * The text the refiner actually started from.
 *
 * NOT data.storyText: whether that field holds the writer's draft or the
 * refined result varies by run (measured 2026-08-25 — prod job_1787638707796
 * kept the draft, staging job_1787436913379 had it overwritten). The report
 * lists only the pages the stage changed, so shipped text is the writer's text
 * everywhere else.
 */
function writerPages(d) {
  const shipped = new Map((d.sceneImages || [])
    .filter(s => (s.text || '').trim())
    .map(s => [s.pageNumber, String(s.text).trim()]));
  for (const p of (d.textRefineReport?.pages || [])) {
    if (p && p.pageNumber != null && String(p.before || '').trim()) {
      shipped.set(p.pageNumber, String(p.before).trim());
    }
  }
  return shipped;
}

(async () => {
  const pool = new Pool({ connectionString: DB, ssl: { rejectUnauthorized: false } });

  // The refined arm: either the shipped pages (baseline) or a Lab experiment.
  let expByStory = null;
  if (EXP) {
    const r = await pool.query('SELECT results FROM testlab_experiments WHERE id = $1', [Number(EXP)]);
    if (!r.rows.length) throw new Error(`experiment ${EXP} not found`);
    expByStory = new Map();
    for (const entry of (r.rows[0].results || [])) {
      const res = entry.result || entry;
      if (!res || !res.finalPages) continue;
      expByStory.set(res.storyId, new Map(res.finalPages.map(p => [p.pageNumber, String(p.final || '').trim()])));
    }
  }

  const ids = IDS.length ? IDS : [...(expByStory?.keys() || [])];
  if (!ids.length) throw new Error('no story ids (pass them, or --exp= with results)');

  const totals = { pages: 0, changed: 0, feelingLost: 0, feelingGained: 0, bookkeepingAdded: 0, clockAdded: 0, travelogue: 0 };
  const detail = [];

  for (const id of ids) {
    const r = await pool.query('SELECT data FROM stories WHERE id = $1', [id]);
    if (!r.rows.length) { console.log(`${id}: NOT FOUND`); continue; }
    const d = r.rows[0].data;
    const writer = writerPages(d);
    const refined = expByStory
      ? (expByStory.get(id) || new Map())
      : new Map((d.sceneImages || []).filter(s => (s.text || '').trim()).map(s => [s.pageNumber, String(s.text).trim()]));

    const t = { pages: 0, changed: 0, feelingLost: 0, feelingGained: 0, bookkeepingAdded: 0, clockAdded: 0, travelogue: 0 };
    for (const [n, w] of [...writer.entries()].sort((a, b) => a[0] - b[0])) {
      const ref = refined.get(n);
      if (!ref) continue;
      const s = scorePage(w, ref);
      t.pages++; totals.pages++;
      if (s.changed) { t.changed++; totals.changed++; }
      for (const k of ['feelingLost', 'feelingGained', 'bookkeepingAdded', 'clockAdded', 'travelogue']) {
        t[k] += s[k].length; totals[k] += s[k].length;
      }
      if (s.feelingLost.length || s.clockAdded.length || s.travelogue.length) {
        detail.push({ id, n, lost: s.feelingLost, clock: s.clockAdded, trav: s.travelogue });
      }
    }
    console.log(
      `${id.padEnd(30)} pages=${String(t.pages).padStart(2)} changed=${String(t.changed).padStart(2)}` +
      `  feelingLost=${String(t.feelingLost).padStart(2)}  feelingGained=${String(t.feelingGained).padStart(2)}` +
      `  bookkeeping+=${String(t.bookkeepingAdded).padStart(2)}  clock+=${String(t.clockAdded).padStart(2)}` +
      `  travelogue=${String(t.travelogue).padStart(2)}   ${(d.title || '').slice(0, 30)}`
    );
  }

  console.log('\n' + '='.repeat(70));
  console.log(`ARM: ${EXP ? `lab experiment #${EXP}` : 'shipped pages (baseline)'}`);
  console.log(`pages=${totals.pages} changed=${totals.changed}`);
  console.log(`  feeling sentences LOST    : ${totals.feelingLost}`);
  console.log(`  feeling sentences GAINED  : ${totals.feelingGained}`);
  console.log(`  bookkeeping sentences ADDED: ${totals.bookkeepingAdded}`);
  console.log(`  clock/time-of-day ADDED   : ${totals.clockAdded}`);
  console.log(`  travelogue openers ADDED  : ${totals.travelogue}`);

  if (has('verbose')) {
    console.log('\n--- per-page detail ---');
    for (const x of detail) {
      console.log(`\n${x.id} p${x.n}`);
      x.lost.forEach(s => console.log(`  LOST FEELING : ${s}`));
      x.clock.forEach(s => console.log(`  CLOCK ADDED  : ${s}`));
      x.trav.forEach(s => console.log(`  TRAVELOGUE   : ${s}`));
    }
  }

  await pool.end();
})().catch(e => { console.error(e.message); process.exit(1); });
