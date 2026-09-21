import type { ClothingReviewReport } from '../types/story';

/**
 * One wardrobe entry as the dev panel shows it: the outfit that shipped, and —
 * when the review rewrote it — the text it replaced.
 */
export interface ClothingReviewRow {
  /** Character the outfit belongs to. */
  name: string;
  /** Wardrobe slot: `standard` or `costumed`. */
  category: string;
  /** Costume name when the slot is `costumed`, else null. */
  costume: string | null;
  /** The outfit as it left the review — what the avatars and pages were drawn from. */
  final: string;
  /** The outfit as the bible wrote it, only when the review rewrote it. */
  before: string | null;
  changed: boolean;
}

export interface ClothingReviewSummary {
  model: string | null;
  durationMs: number | null;
  analysis: string;
  prompt: string | null;
  changedCount: number;
  rows: ClothingReviewRow[];
}

/** `costumed:pirate` (changed[]) → `{ category: 'costumed', costume: 'pirate' }`. */
function splitCategory(raw: string): { category: string; costume: string | null } {
  const i = (raw || '').indexOf(':');
  if (i < 0) return { category: raw || '', costume: null };
  return { category: raw.slice(0, i), costume: raw.slice(i + 1) || null };
}

const keyOf = (name: string, category: string, costume: string | null) =>
  `${(name || '').toLowerCase()}|${category}|${costume || ''}`;

/**
 * Fold the stored wardrobe review into one row per outfit.
 *
 * `outfitsIn[]` is the post-review wardrobe (every used outfit, rewritten or
 * not) and `changed[]` holds the before/after of the ones that moved, so the
 * join is what makes a row readable. A `changed` entry with no matching
 * `outfitsIn` row is still listed — dropping it would hide a rewrite.
 *
 * Returns null when there is nothing to show: no report at all (older rows,
 * trial stories, a run where the reviewer failed) or an empty one.
 */
export function summarizeClothingReview(
  report: ClothingReviewReport | null | undefined,
): ClothingReviewSummary | null {
  if (!report || typeof report !== 'object') return null;

  const changed = Array.isArray(report.changed) ? report.changed : [];
  const outfitsIn = Array.isArray(report.outfitsIn) ? report.outfitsIn : [];
  const analysis = (report.analysis || '').trim();
  const prompt = report.prompt || null;

  if (!changed.length && !outfitsIn.length && !analysis && !prompt) return null;

  const changeByKey = new Map<string, { before: string; after: string }>();
  for (const ch of changed) {
    const { category, costume } = splitCategory(ch?.category || '');
    changeByKey.set(keyOf(ch?.name || '', category, costume), {
      before: ch?.before || '',
      after: ch?.after || '',
    });
  }

  const seen = new Set<string>();
  const rows: ClothingReviewRow[] = outfitsIn.map(o => {
    const costume = o?.costume || null;
    const key = keyOf(o?.name || '', o?.category || '', costume);
    seen.add(key);
    const hit = changeByKey.get(key);
    return {
      name: o?.name || '',
      category: o?.category || '',
      costume,
      final: o?.description || '',
      before: hit ? hit.before : null,
      changed: Boolean(hit),
    };
  });

  for (const ch of changed) {
    const { category, costume } = splitCategory(ch?.category || '');
    const key = keyOf(ch?.name || '', category, costume);
    if (seen.has(key)) continue;
    rows.push({
      name: ch?.name || '',
      category,
      costume,
      final: ch?.after || '',
      before: ch?.before || '',
      changed: true,
    });
  }

  return {
    model: report.model || null,
    durationMs: typeof report.durationMs === 'number' ? report.durationMs : null,
    analysis,
    prompt,
    changedCount: rows.filter(r => r.changed).length,
    rows,
  };
}
