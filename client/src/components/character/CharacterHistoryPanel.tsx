import React from 'react';

/**
 * Dev-only panel: lists every 2×4 sheet generated for this character across
 * past stories. Used to inspect cross-story identity / costume drift.
 *
 * Surfaced only when developerMode (or impersonating). Reads from the
 * character's `avatars.storyHistory[]` array, which is appended to after
 * each story job completes (server/lib/storyAvatars.js → appendStoryHistory).
 */
interface StoryHistoryEntry {
  storyId: string;
  generatedAt: string;
  sheetKey: string;
  sheetUrl: string;
  costumeDescription?: string | null;
  artStyle?: string | null;
  language?: string | null;
  title?: string | null;
}

interface CharacterHistoryPanelProps {
  history: StoryHistoryEntry[] | undefined;
}

const CharacterHistoryPanel: React.FC<CharacterHistoryPanelProps> = ({ history }) => {
  if (!history || history.length === 0) return null;

  // Sort newest first.
  const sorted = [...history].sort((a, b) => {
    const ad = a.generatedAt || '';
    const bd = b.generatedAt || '';
    return bd.localeCompare(ad);
  });

  return (
    <details className="mt-1 text-left">
      <summary className="text-[10px] font-medium cursor-pointer text-amber-700">
        Story history ({history.length} sheet{history.length === 1 ? '' : 's'})
      </summary>
      <div className="mt-1 p-2 rounded text-[9px] border bg-amber-50 border-amber-200 space-y-2">
        {sorted.map((entry, idx) => (
          <div key={`${entry.storyId}-${entry.sheetKey}-${idx}`} className="flex gap-2 items-start">
            {entry.sheetUrl && (
              <a href={entry.sheetUrl} target="_blank" rel="noreferrer" className="shrink-0">
                <img
                  src={entry.sheetUrl}
                  alt={`${entry.sheetKey} for ${entry.title || entry.storyId}`}
                  className="w-24 h-12 object-cover rounded border border-amber-300"
                  loading="lazy"
                />
              </a>
            )}
            <div className="flex-1 min-w-0">
              <div className="font-semibold truncate">{entry.title || entry.storyId}</div>
              <div className="text-amber-700">
                {entry.sheetKey} • {entry.artStyle || '?'} • {entry.language || '?'}
              </div>
              {entry.costumeDescription && (
                <div className="text-amber-900 leading-tight mt-0.5 line-clamp-2">
                  {entry.costumeDescription}
                </div>
              )}
              <div className="text-amber-600 text-[8px] mt-0.5">
                {entry.generatedAt ? new Date(entry.generatedAt).toLocaleString() : '?'}
              </div>
            </div>
          </div>
        ))}
      </div>
    </details>
  );
};

export default CharacterHistoryPanel;
