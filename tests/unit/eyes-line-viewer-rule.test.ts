/**
 * Every foreground/midground figure's EYES line says where the face turns and
 * that it is never the viewer (staging job_1790446348343_z3fw660ie p16).
 *
 * The viewer rule used to ride a pose FILL line, written only for a figure with
 * no interaction row; a figure that had one got no viewer line, and the whole
 * cast rendered facing the camera while briefed to watch a ship behind them.
 * Offline, no paid call.
 */
import { describe, it, expect } from 'vitest';

const { buildExactPosesBlock } = require('../../server/lib/promptBuilders');

describe('the EYES line carries the viewer rule for every figure', () => {
  const vb = { vehicles: [{ id: 'VEH001', name: 'old sailing ship', label: 'sailing ship' }] };

  it('a figure with an interaction row still gets it', () => {
    const block = String(buildExactPosesBlock(
      [{ character: 'CharacterA', object: 'LOC001', where: 'stands on the stone landing', priority: 'normal' }],
      [
        { name: 'CharacterA', depth: 'midground', looksAt: 'VEH001', expression: 'wide open laughing mouth' },
        { name: 'CharacterB', depth: 'midground', looksAt: 'VEH001', expression: 'soft smile' },
      ],
      vb,
    ));
    expect(block).toMatch(/- CharacterA: wide open laughing mouth; eyes on .*sailing ship.*, face turned the same way, never to the viewer/);
    expect(block).toMatch(/- CharacterB: soft smile; eyes on .*sailing ship.*, face turned the same way, never to the viewer/);
    expect(block).not.toMatch(/VEH001/);
  });

  it('a figure with no gaze gets one, and there is no separate fill pose line', () => {
    const block = String(buildExactPosesBlock([], [{ name: 'CharacterA', depth: 'foreground' }], null));
    expect(block).toMatch(/- CharacterA: eyes off into the scene, face turned the same way, never to the viewer/);
    expect(block).not.toMatch(/EXACT POSES/);
  });

  it('a figure the brief sends to the viewer keeps exactly that', () => {
    const block = String(buildExactPosesBlock([], [{ name: 'CharacterA', depth: 'foreground', looksAt: 'viewer' }], null));
    expect(block).toMatch(/- CharacterA: eyes on the viewer$/m);
    expect(block).not.toMatch(/never to the viewer\n|CharacterA:.*never to the viewer/);
  });

  it('a background figure gets no line', () => {
    const block = String(buildExactPosesBlock([], [{ name: 'CharacterA', depth: 'background', looksAt: 'away' }], null));
    expect(block).toBe('');
  });
});
