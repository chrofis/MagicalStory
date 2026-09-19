import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';

const {
  resolveSceneCastEntries,
  extractSceneMetadata
} = require('../../server/lib/sceneMetadata');
const { log } = require('../../server/utils/logger');

/**
 * The bbox disambiguation context in entityConsistency.js read `.position` /
 * `.action` off `extractSceneMetadata().characters` — a string[] of names — so
 * every cast line came out as "- undefined:" inside a prompt block headed "use
 * to identify characters by position and action". Property access on a string
 * is silently `undefined`, which is why it survived from 24c8981aa (2026-03-22).
 *
 * These pin BEHAVIOUR: the cast is resolved against real values, and a string
 * where an object belongs fails loudly instead of yielding `undefined`.
 */
describe('resolveSceneCastEntries — the cast objects, never the flat name list', () => {
  let errors: string[] = [];
  let warns: string[] = [];
  let spies: any[] = [];

  beforeEach(() => {
    errors = [];
    warns = [];
    spies = [
      vi.spyOn(log, 'error').mockImplementation((m: string) => { errors.push(String(m)); }),
      vi.spyOn(log, 'warn').mockImplementation((m: string) => { warns.push(String(m)); })
    ];
  });
  afterEach(() => { spies.forEach(s => s.mockRestore()); });

  it('reads position off the structured cast, not undefined off the name list', () => {
    const metadata = {
      characters: ['Liz', 'Ayan'],
      fullData: {
        characters: [
          { name: 'Liz', position: 'left foreground', depth: 'foreground' },
          { name: 'Ayan', position: 'center background', depth: 'background' }
        ]
      }
    };
    const cast = resolveSceneCastEntries(metadata, 'test');
    expect(cast.map((c: any) => c.name)).toEqual(['Liz', 'Ayan']);
    expect(cast.map((c: any) => c.position)).toEqual(['left foreground', 'center background']);
    for (const c of cast) {
      expect(c.name).toBeDefined();
      expect(c.position).not.toBeUndefined();
      expect(c.action).not.toBeUndefined();
    }
    expect(errors).toEqual([]);
  });

  it('a bare-string cast entry fails LOUDLY and never yields undefined fields', () => {
    const metadata = { fullData: { characters: ['Liz', { name: 'Ayan', position: 'right' }] } };
    const cast = resolveSceneCastEntries(metadata, 'p7');
    expect(cast).toHaveLength(2);
    expect(cast[0]).toEqual({ name: 'Liz', position: '', action: '' });
    expect(cast[1].position).toBe('right');
    // Loud: an error naming the call site, not a silent degrade.
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain('p7');
    expect(errors[0]).toContain('Liz');
  });

  it('falls back to the flat name list with a warning when no structured cast exists', () => {
    const cast = resolveSceneCastEntries({ characters: ['Liz'] }, 'p1');
    expect(cast).toEqual([{ name: 'Liz', position: '', action: '' }]);
    expect(warns.length).toBe(1);
    expect(errors).toEqual([]);
  });

  it('drops nameless and unusable entries loudly rather than emitting "- undefined:"', () => {
    const cast = resolveSceneCastEntries({ fullData: { characters: [{ position: 'left' }, null, { name: 'Liz' }] } }, 'p2');
    expect(cast).toEqual([{ name: 'Liz', position: '', action: '' }]);
    expect(errors.length).toBe(2);
  });

  it('handles no metadata and an empty cast without throwing', () => {
    expect(resolveSceneCastEntries(null)).toEqual([]);
    expect(resolveSceneCastEntries({ fullData: { characters: [] }, characters: [] })).toEqual([]);
    expect(errors).toEqual([]);
    expect(warns).toEqual([]);
  });

  it('end-to-end on a real prose brief: the flat list is names, the resolver gives positions', () => {
    const brief = [
      'Liz leans over the rail while Ayan watches from the far bank.',
      '',
      '---METADATA---',
      JSON.stringify({
        characters: [
          { name: 'Liz', clothing: 'standard', position: 'left foreground', depth: 'foreground' },
          { name: 'Ayan', clothing: 'standard', position: 'center background', depth: 'background' }
        ],
        objects: ['LOC001'],
        shot: 'medium'
      })
    ].join('\n');

    const metadata = extractSceneMetadata(brief);
    // The shape that caused the bug is still the documented shape of `characters`.
    expect(metadata.characters).toEqual(['Liz', 'Ayan']);
    expect((metadata.characters as any[]).map((c: any) => c.position)).toEqual([undefined, undefined]);

    const cast = resolveSceneCastEntries(metadata, 'brief');
    expect(cast.map((c: any) => `- ${c.name}: ${c.position}`)).toEqual([
      '- Liz: left foreground',
      '- Ayan: center background'
    ]);
  });
});

describe('wiring guard — the silent-undefined expression cannot be rebuilt', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '../../server/lib/entityConsistency.js'), 'utf8'
  );

  it('entityConsistency builds its bbox scene context through the resolver', () => {
    expect(src).toContain('resolveSceneCastEntries(sceneMetadata');
  });

  it('entityConsistency never takes its scene cast from the flat name list', () => {
    expect(src).not.toMatch(/sceneChars\s*=\s*sceneMetadata\.characters/);
    expect(src).not.toMatch(/sceneChars\s*=\s*sceneMetadata\?\.characters/);
  });
});
