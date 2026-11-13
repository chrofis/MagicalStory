// Regression: a customer redrawing a page used the STORED visualBible as-is, so an invented
// secondary that is really a cast child (old stories) came back in the image prompt.
// fetchStoryRowForUser (regeneration.js) now runs every loaded row through
// filterStoredVisualBibleInRows. docs/decisions.md 2026-11-13.
import { describe, it, expect } from 'vitest';
import { filterStoredVisualBibleInRows } from '../../server/lib/visualBible.js';
import fs from 'fs';

const story = () => ({
  characters: [{ id: 1, name: 'Aria' }, { id: 2, name: 'Aurelia, Schwester von Aria' }, { id: 3, name: 'Mia' }],
  visualBible: { secondaryCharacters: [
    { id: 'CHR001', name: 'Aurelia Schwester von Aria' },
    { id: 'CHR002', name: 'Louis' },
    { id: 'CHR003', name: "Mia's mother" },
  ] },
});
const names = (d: any) => d.visualBible.secondaryCharacters.map((s: any) => s.name);

describe('stored story VB at regenerate time', () => {
  it('drops the cast double, keeps genuine secondaries (object data)', () => {
    const rows = filterStoredVisualBibleInRows([{ data: story() }]);
    expect(names(rows[0].data)).toEqual(['Louis', "Mia's mother"]);
  });
  it('handles JSON-string data and returns an object', () => {
    const rows = filterStoredVisualBibleInRows([{ data: JSON.stringify(story()) }]);
    expect(names(rows[0].data)).toEqual(['Louis', "Mia's mother"]);
  });
  it('leaves rows without data / visualBible alone', () => {
    expect(filterStoredVisualBibleInRows([{ id: 1 }, { data: { characters: [] } }])).toHaveLength(2);
    expect(filterStoredVisualBibleInRows(undefined)).toBeUndefined();
  });
  it('the regeneration routes load every story through the filtered loader', () => {
    const src = fs.readFileSync('server/routes/regeneration.js', 'utf8');
    const loader = src.slice(src.indexOf('async function fetchStoryRowForUser'), src.indexOf('// SPD-2'));
    expect(loader).toContain('filterStoredVisualBibleInRows(result.rows)');
  });
});
