/**
 * How the printed book lies open. The print PDF is: page 1 the cover (back, spine, front in one wide page),
 * then the interior pages, which start on the RIGHT of the first spread (server/lib/pdf.js: page 2 is the blank
 * left page of the first spread, page 3 the dedication). So the spreads are [cover], [2,3], [4,5], ... and a
 * trailing unpaired page stands alone. Input and output are 0-based indices into the manifest's `pages`.
 */
export type Spread = number[];

export function buildSpreads(pageCount: number): Spread[] {
  if (!Number.isInteger(pageCount) || pageCount < 1) throw new Error(`buildSpreads: bad page count ${pageCount}`);
  const spreads: Spread[] = [[0]];
  for (let i = 1; i < pageCount; i += 2) spreads.push(i + 1 < pageCount ? [i, i + 1] : [i]);
  return spreads;
}
