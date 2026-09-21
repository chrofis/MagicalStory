/**
 * The historical idea prompt opens the back-cover blurb with a role block. It
 * must not be shown as blurb text, and it must still reach `storyDetails`
 * unchanged — so the split is exact and reversible by construction.
 */
import { describe, it, expect } from 'vitest';
import { splitIdeaRoles, joinIdeaRoles } from '../../client/src/utils/ideaRoles';

const roundTrips = (text: string) => {
  const s = splitIdeaRoles(text);
  expect(joinIdeaRoles(s.rolesBlock, s.blurb)).toBe(text);
  return s;
};

describe('splitIdeaRoles', () => {
  it('splits a German block off the blurb', () => {
    const text = 'Rollen:\nLuca: Neil Armstrong (erster Mensch auf dem Mond)\nNora: Missionskontrolle (führt vom Boden)\n\nLuca hat noch nie etwas so Grosses gewagt.\nDoch heute zählt jede Sekunde.';
    const s = roundTrips(text);
    expect(s.cast).toEqual([
      { name: 'Luca', role: 'Neil Armstrong (erster Mensch auf dem Mond)' },
      { name: 'Nora', role: 'Missionskontrolle (führt vom Boden)' },
    ]);
    expect(s.blurb).toBe('Luca hat noch nie etwas so Grosses gewagt.\nDoch heute zählt jede Sekunde.');
  });

  it('splits an English block', () => {
    const text = 'Roles:\nAmir: Orville Wright (pilot of the first flight)\nYara: Wilbur Wright (runs alongside)\n\nAmir has built wings out of paper all winter.';
    const s = roundTrips(text);
    expect(s.cast.map(c => c.name)).toEqual(['Amir', 'Yara']);
    expect(s.blurb).toBe('Amir has built wings out of paper all winter.');
  });

  it('splits a French block with accents and a two-word heading', () => {
    const text = 'Les rôles:\nChloé: Marie Curie (découvre le radium)\nThéo: Pierre Curie (partage le laboratoire)\n\nChloé n’a jamais vu briller la nuit.';
    const s = roundTrips(text);
    expect(s.cast[0]).toEqual({ name: 'Chloé', role: 'Marie Curie (découvre le radium)' });
    expect(s.blurb).toBe('Chloé n’a jamais vu briller la nuit.');
  });

  it('splits a block that runs straight into the blurb with no blank line', () => {
    const text = 'Rollen:\nLuca: Neil Armstrong (Kommandant)\nLuca hat noch nie etwas so Grosses gewagt, und heute zählt jede Sekunde.';
    const s = roundTrips(text);
    // The blurb sentence is prose, not `Name: Role`, so it ends the block.
    expect(s.cast).toEqual([{ name: 'Luca', role: 'Neil Armstrong (Kommandant)' }]);
    expect(s.blurb).toBe('Luca hat noch nie etwas so Grosses gewagt, und heute zählt jede Sekunde.');
  });

  it('tolerates markdown emphasis around the heading and the cast lines', () => {
    const text = '**Rollen:**\n- **Luca**: Neil Armstrong (Kommandant)\n\nEin Bub, ein Countdown.';
    const s = roundTrips(text);
    expect(s.cast).toEqual([{ name: 'Luca', role: 'Neil Armstrong (Kommandant)' }]);
    expect(s.blurb).toBe('Ein Bub, ein Countdown.');
  });

  it('leaves an idea with no role block completely alone', () => {
    const text = 'Mia sucht ihre Freundin auf dem Pausenplatz.\nNiemand dreht sich um.';
    const s = roundTrips(text);
    expect(s.rolesBlock).toBe('');
    expect(s.cast).toEqual([]);
    expect(s.blurb).toBe(text);
  });

  it('does not eat a blurb whose first line merely contains a colon', () => {
    const text = 'Ein Versprechen: Emma wollte den Stein zurückbringen.\nDoch der Bach ist gestiegen.';
    const s = roundTrips(text);
    expect(s.rolesBlock).toBe('');
    expect(s.blurb).toBe(text);
  });

  it('treats a heading with nothing under it as ordinary text', () => {
    const text = 'Rollen:\n\nEmma steht allein am Ufer.';
    const s = roundTrips(text);
    expect(s.rolesBlock).toBe('');
    expect(s.blurb).toBe(text);
  });

  it('round-trips an empty string and a block with no blurb after it', () => {
    expect(roundTrips('').blurb).toBe('');
    const onlyBlock = roundTrips('Rollen:\nLuca: Neil Armstrong (Kommandant)');
    expect(onlyBlock.cast).toHaveLength(1);
    expect(onlyBlock.blurb).toBe('');
  });
});
