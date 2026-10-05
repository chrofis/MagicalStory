// French trait labels were masculine-only and "Leader" was English (code review 2026-10-05).
// Renamed labels must stay recognisable for characters saved before: RENAMED_TRAITS_FR maps
// old → new, applied by TraitSelector on French screens only.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { strengths, flaws, RENAMED_TRAITS_FR } from '../../client/src/constants/traits';

describe('French trait labels', () => {
  it('cover both genders and contain no English "Leader"', () => {
    expect(strengths.fr).toContain('Joyeux(se)');
    expect(strengths.fr).toContain('Meneur(se)');
    expect(strengths.fr).not.toContain('Leader');
    expect(flaws.fr).toContain('Têtu(e)');
    expect(flaws.fr).not.toContain('Têtu');
  });

  it('every renamed label maps to a label that exists in the French lists', () => {
    const fr = new Set([...strengths.fr, ...flaws.fr]);
    for (const [oldLabel, newLabel] of Object.entries(RENAMED_TRAITS_FR)) {
      expect(fr.has(newLabel), `${oldLabel} → ${newLabel}`).toBe(true);
      expect(fr.has(oldLabel), `old label still listed: ${oldLabel}`).toBe(false);
    }
  });

  it('the mapping is applied on French screens only (old French words are also English traits)', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../client/src/components/character/TraitSelector.tsx'), 'utf8');
    expect(src).toMatch(/language === 'fr'\s*\?\s*\[\.\.\.new Set\(storedTraits\.map\(tr => RENAMED_TRAITS_FR\[tr\] \?\? tr\)\)\]/);
    expect(strengths.en).toContain('Patient');
    expect(RENAMED_TRAITS_FR.Patient).toBe('Patient(e)');
  });
});
