/**
 * A generated story idea is the back-cover blurb — and for historical stories
 * the idea prompt (prompts/story-idea-requirements-historical-1.txt) asks the
 * model to OPEN it with a role list:
 *
 *   Rollen:
 *   Luca: Neil Armstrong (erster Mensch auf dem Mond)
 *   Nora: Missionskontrolle (führt vom Boden aus)
 *
 *   Luca hat noch nie ...
 *
 * That list is casting instruction, not blurb. It reached the wizard card
 * verbatim and every blind reader of the 2026-09 idea rounds docked the two
 * historical cells for it ("opens with a ROLES block that breaks the
 * back-cover illusion").
 *
 * The block still has to travel: the chosen idea text becomes `storyDetails`
 * whole, and that is where the writer, the beats chain and the premise-aware
 * judges read the casting from (server/lib/storyScorecard.js). So this is a
 * DISPLAY split only — `rolesBlock + blurb` is byte-identical to the original,
 * and both renderers rejoin them before anything leaves the client.
 */

export interface IdeaCastMember {
  /** The child's name, as written left of the colon. */
  name: string;
  /** Everything right of the colon — the historical figure and their role. */
  role: string;
}

export interface SplitIdea {
  /**
   * The leading role block INCLUDING its trailing whitespace, or '' when the
   * idea has none. `rolesBlock + blurb === original` always holds.
   */
  rolesBlock: string;
  /** The parsed cast lines. Empty when there is no block. */
  cast: IdeaCastMember[];
  /** The back-cover text the reader should see. */
  blurb: string;
}

/**
 * A heading line: one or two words, any language, ending in a colon, alone on
 * its line. Markdown emphasis and list bullets around it are tolerated because
 * models add them. This line is the ONLY discriminator — without it nothing is
 * split, so a blurb that happens to open "Titel: ..." is left alone.
 */
const HEADING_RE = /^([\p{L}][\p{L}\p{M}'’-]*(?:[  ][\p{L}][\p{L}\p{M}'’-]*)?)\s*:$/u;

/** A cast line: `Name: Role (detail)`. The name side stays short and word-ish. */
const CAST_RE = /^([\p{L}][\p{L}\p{M}.'’-]*(?:[  ][\p{L}][\p{L}\p{M}.'’-]*){0,3})\s*:\s*(\S.*)$/u;

/**
 * Markdown emphasis and list bullets are stripped BEFORE matching, because
 * models wrap the block in them freely. Only the parse sees the stripped form;
 * `rolesBlock` is always sliced from the original lines.
 */
function plain(line: string): string {
  return line.replace(/[*_`#]/g, '').replace(/^\s*[-•]\s*/, '').trim();
}

export function splitIdeaRoles(text: string): SplitIdea {
  const original = typeof text === 'string' ? text : '';
  const lines = original.split('\n');

  // Skip leading blank lines, but remember them so the rejoin is exact.
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i++;
  if (i >= lines.length) return { rolesBlock: '', cast: [], blurb: original };

  if (!HEADING_RE.test(plain(lines[i]))) return { rolesBlock: '', cast: [], blurb: original };

  const cast: IdeaCastMember[] = [];
  let j = i + 1;
  while (j < lines.length) {
    const m = plain(lines[j]).match(CAST_RE);
    if (!m) break;
    cast.push({ name: m[1].trim(), role: m[2].trim() });
    j++;
  }

  // A heading with nothing under it is not a role block.
  if (cast.length === 0) return { rolesBlock: '', cast: [], blurb: original };

  // Consume the blank lines separating the block from the blurb (there may be
  // none — models sometimes run the two together).
  while (j < lines.length && !lines[j].trim()) j++;

  const consumed = lines.slice(0, j);
  const rolesBlock = consumed.join('\n') + (j < lines.length ? '\n' : '');
  const blurb = lines.slice(j).join('\n');
  return { rolesBlock, cast, blurb };
}

/** The inverse of the split — what the create-story payload must carry. */
export function joinIdeaRoles(rolesBlock: string, blurb: string): string {
  return (rolesBlock || '') + (blurb || '');
}
