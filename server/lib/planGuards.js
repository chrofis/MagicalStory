/**
 * THE RE-PLAN ROUND'S STRUCTURAL GUARDS — one implementation for every caller.
 *
 * Three guards stand between a re-plan's reply and the division that ships, and
 * each was written after a real corruption (docs/decisions.md; the dates are in
 * the comments in beatsPipeline.runReplanRounds):
 *   merge      a re-plan is asked for the pages a finding names; every other
 *              page it returns is restored from the division that stands
 *   duplicate  two pages with the same plan line is corruption, not a fix
 *   page count a round that returns more or fewer pages than the order is not a
 *              re-division of THIS book
 * They were inline in runReplanRounds; the typed plan's single targeted re-plan
 * (typedPlan.js, Lab experiment 2026-10-05) needs the same three, so they live
 * here and runReplanRounds calls them too.
 */

/**
 * Merge a re-plan's returned pages into the standing division.
 *
 * A returned page is accepted when it is in scope (`inScope(pageNumber)`), when
 * the whole division is in scope (`scopeAll`), or when the standing division
 * has no such page; every other returned page is replaced by the standing one,
 * and a standing page the reply omitted is filled from the standing division.
 *
 * @param {Array<{pageNumber:number, planLine:string}>} returned
 * @param {Array<{pageNumber:number, planLine:string}>} standingPages
 * @param {{inScope: (n:number)=>boolean, scopeAll?: boolean}} scope
 * @returns {{pages: Array, overridden: number}} `overridden` = returned pages the merge restored
 */
function mergeReplanPages(returned, standingPages, { inScope, scopeAll = false }) {
  const standing = new Map(standingPages.map(b => [b.pageNumber, b]));
  const kept = [];
  for (const pg of returned) {
    if (scopeAll || inScope(pg.pageNumber) || !standing.has(pg.pageNumber)) kept.push(pg);
    else kept.push(standing.get(pg.pageNumber));
  }
  for (const [num, pg] of standing) if (!kept.some(k => k.pageNumber === num)) kept.push(pg);
  kept.sort((a, b) => a.pageNumber - b.pageNumber);
  const overridden = scopeAll ? 0 : returned.filter(pg => !inScope(pg.pageNumber) && standing.has(pg.pageNumber)).length;
  return { pages: kept, overridden };
}

/** The first plan line two pages share (normalised), or undefined. */
function duplicatePlanLine(pages) {
  const lines = pages.map(pg => String(pg.planLine || '').toLowerCase().replace(/\s+/g, ' ').trim());
  return lines.find((t, k) => t && lines.indexOf(t) !== k);
}

/** True when the reply carries exactly the order's page count. */
function pageCountHolds(pages, expected) {
  return pages.length === expected;
}

module.exports = { mergeReplanPages, duplicatePlanLine, pageCountHolds };
