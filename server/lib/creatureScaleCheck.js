/**
 * A CREATURE'S DRAWN SIZE vs THE SIZE IT WAS GIVEN — a measurement, not a judge.
 *
 * image-evaluation D-34 (`creature_scale`) asks the vision judge to notice a
 * creature drawn at half or less (or twice or more) of the size ELEMENT SIZES
 * gave it. On job_1791489793707_2ir6nl5kw the judge was handed "about three
 * times the height of Levin" on twelve pages where the dragon stood 1.0-1.5
 * times a 3-year-old, wrote only `height_order: "... Glutta (noticeably taller)"`
 * and passed every one: a judge asked to estimate a multiple by eye does not
 * (a re-eval of p8 under a prompt that forced a `drawn_times` row answered 2.2,
 * the boxes say 1.17). The evaluator already files a `body_bbox` per matched
 * figure, so the drawn multiple is arithmetic over its own structured output
 * and the given multiple is arithmetic over the Visual Bible's scale band and
 * the cast's heights (the SAME numbers promptBuilders.elementPageScaleNote
 * phrases for the page prompt and the judge). Nothing here reads prose.
 *
 * Deliberately conservative, because a box is only as good as the detector:
 *   - only a creature given at least MIN_GIVEN_TIMES a figure's height;
 *   - only when the drawn multiple is at most HALF the given one against EVERY
 *     comparable figure (the D-34 threshold, "half of it or less");
 *   - a creature cut by the frame is skipped (its visible height understates it).
 *     A FIGURE cut by the frame is kept: its visible height understates it too,
 *     which pushes the drawn multiple UP, so a finding that survives is stronger;
 *   - a creature in the background against a foreground figure is skipped
 *     (distance explains a smaller creature, and nothing else does).
 *
 * @see docs/decisions.md 2026-10-08 "Creature scale from the judge's boxes"
 */
'use strict';

const MIN_GIVEN_TIMES = 2;
const MAX_DRAWN_FRACTION_OF_GIVEN = 0.5;
const EDGE = 0.01;

const norm = (s) => String(s == null ? '' : s).trim().toLowerCase();
const depthOf = (zone) => {
  const m = String(zone || '').match(/(foreground|midground|background)/);
  return m ? ['foreground', 'midground', 'background'].indexOf(m[1]) : null;
};
const heightOf = (box) => (Array.isArray(box) && box.length === 4 ? Number(box[3]) - Number(box[1]) : null);
const clippedByFrame = (box) => !Array.isArray(box) || Number(box[1]) <= EDGE || Number(box[3]) >= 1 - EDGE;

/**
 * @param {Object} args
 * @param {Array<{id:string,name:string,givenTimes:Array<{name:string,times:number}>}>} args.creatures
 *        promptBuilders.creatureHeightMultiples(...)
 * @param {Array} args.matches  the evaluator's figure -> reference pairing ({figure, reference, body_bbox})
 * @param {Array} args.figures  the evaluator's figure list ({id, zone, clipped_by})
 * @returns {Array} findings {type:'creature_scale', severity:'MAJOR', character, source, description, fix}
 */
function checkCreatureScale({ creatures, matches, figures } = {}) {
  const rows = Array.isArray(matches) ? matches : [];
  const figs = Array.isArray(figures) ? figures : [];
  const seen = (name) => {
    const m = rows.find(r => r && norm(r.reference) === norm(name) && Array.isArray(r.body_bbox));
    if (!m) return null;
    const f = figs.find(x => x && x.id === m.figure) || {};
    const clipped = clippedByFrame(m.body_bbox) || (f.clipped_by && String(f.clipped_by).toLowerCase() !== 'none');
    return { height: heightOf(m.body_bbox), depth: depthOf(f.zone), clipped };
  };

  const out = [];
  for (const c of (Array.isArray(creatures) ? creatures : [])) {
    const creature = seen(c.name);
    if (!creature || creature.clipped || !(creature.height > 0)) continue;
    const compared = [];
    for (const g of (c.givenTimes || [])) {
      if (!(g.times >= MIN_GIVEN_TIMES)) continue;
      const fig = seen(g.name);
      if (!fig || !(fig.height > 0)) continue;
      // Distance only explains a creature looking smaller: skip a creature set further back than the figure by a whole band.
      if (creature.depth != null && fig.depth != null && creature.depth - fig.depth >= 2) continue;
      compared.push({ name: g.name, given: g.times, drawn: creature.height / fig.height });
    }
    if (!compared.length) continue;
    if (!compared.every(x => x.drawn <= x.given * MAX_DRAWN_FRACTION_OF_GIVEN)) continue;
    const worst = compared[0];
    const fmt = (n) => (Math.round(n * 10) / 10).toString();
    out.push({
      type: 'creature_scale',
      severity: 'MAJOR',
      character: c.name,
      source: 'scale-boxes',
      description: `${c.name} is given about ${fmt(worst.given)} times the height of ${worst.name}, but is drawn about ${fmt(worst.drawn)} times that height`,
      fix: `Redraw ${c.name} at its given size against the figures beside it.`,
    });
  }
  return out;
}

module.exports = { checkCreatureScale, MIN_GIVEN_TIMES, MAX_DRAWN_FRACTION_OF_GIVEN };
