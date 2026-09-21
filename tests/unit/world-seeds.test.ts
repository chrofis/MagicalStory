import { describe, it, expect } from 'vitest';
import path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const { parseWorldSeeds, stripSeedLists, pickWorldSeeds, worldSeedInstruction, parseHistoricalAngles, pickHistoricalAngle, historicalAngleInstruction, parseWorldPlaces, pickWorldPlace, worldPlaceInstruction } = require(path.join(ROOT, 'server/lib/worldSeeds'));
const { parseTeachingGuideFile, getAdventureGuide } = require(path.join(ROOT, 'server/lib/promptBuilders'));

const GUIDES = parseTeachingGuideFile(path.join(ROOT, 'prompts', 'adventure-guides.txt'));

describe('parseWorldSeeds', () => {
  it('parses ten centres and ten turns for every adventure world', () => {
    expect(GUIDES.size).toBeGreaterThanOrEqual(30);
    for (const [id, text] of GUIDES) {
      const seeds = parseWorldSeeds(text);
      expect(seeds, `world ${id} has no seed lists`).not.toBeNull();
      expect(seeds.centres.length, `world ${id} centres`).toBe(10);
      expect(seeds.turns.length, `world ${id} turns`).toBe(10);
      for (const line of [...seeds.centres, ...seeds.turns]) {
        expect(line.length).toBeGreaterThan(10);
        expect(line.startsWith('-')).toBe(false);
      }
    }
  });

  it('returns null when a guide carries no lists', () => {
    expect(parseWorldSeeds('COSTUME: none\n\nStory guidance:\n- be nice')).toBeNull();
    expect(parseWorldSeeds('')).toBeNull();
    expect(parseWorldSeeds(null)).toBeNull();
  });
});

describe('pickWorldSeeds', () => {
  const cast = [{ name: 'Noah', age: 3, isMain: true }];
  const input = { theme: 'pirate', characters: cast, topic: '', language: 'de' };

  it('is deterministic for the same seed inputs', () => {
    const a = pickWorldSeeds({ ...input, arm: 0 });
    const b = pickWorldSeeds({ ...input, arm: 0 });
    expect(a).toEqual(b);
    expect(a).not.toBeNull();
  });

  it('gives the two arms a different centre AND a different turn', () => {
    for (const theme of [...GUIDES.keys()]) {
      for (const cast2 of [cast, [{ name: 'Mia', age: 7, isMain: true }, { name: 'Leo', age: 9, isMain: true }]]) {
        const a = pickWorldSeeds({ theme, characters: cast2, topic: 'x', language: 'de', arm: 0 });
        const b = pickWorldSeeds({ theme, characters: cast2, topic: 'x', language: 'de', arm: 1 });
        expect(a, theme).not.toBeNull();
        expect(a.centre, `${theme} centre`).not.toBe(b.centre);
        expect(a.turn, `${theme} turn`).not.toBe(b.turn);
      }
    }
  });

  it('picks from the named world only', () => {
    const seeds = parseWorldSeeds(getAdventureGuide('pirate'));
    const picked = pickWorldSeeds({ ...input, arm: 1 });
    expect(seeds.centres).toContain(picked.centre);
    expect(seeds.turns).toContain(picked.turn);
  });

  it('is null for a theme with no adventure guide, and injects nothing', () => {
    expect(pickWorldSeeds({ theme: 'realistic-no-such-world', characters: cast, arm: 0 })).toBeNull();
    expect(pickWorldSeeds({ theme: '', characters: cast, arm: 0 })).toBeNull();
    expect(pickWorldSeeds({ characters: cast, arm: 0 })).toBeNull();
    expect(worldSeedInstruction(null)).toBe('');
  });

  // The turn is still PICKED — it is what guarantees the two arms differ and it
  // rides in the idea_generated telemetry — and it is deliberately not in the
  // line: round 12 measured the turn supplying a place and peril's height class
  // going 1 -> 4 on it, and a "turn" asked of a five-sentence back cover is a
  // middle to narrate.
  it('names the centre in the instruction, and never the turn', () => {
    const picked = pickWorldSeeds({ ...input, arm: 0 });
    const line = worldSeedInstruction(picked);
    expect(line).toBe(`Someone in this idea: ${picked.centre}. Build the want or the obstacle on them.`);
    expect(line).not.toContain(picked.turn);
    expect(line).not.toContain('Turn:');
  });
});

describe('stripSeedLists — the idea prompt sees the pick, never the menu', () => {
  it('removes both ten-item lists from every world, and keeps everything else', () => {
    for (const [id, text] of GUIDES) {
      const stripped = stripSeedLists(text);
      expect(stripped, `world ${id}`).not.toContain('Who lives here (pick one):');
      expect(stripped, `world ${id}`).not.toContain('What turns (pick one):');
      const seeds = parseWorldSeeds(text);
      for (const line of [...seeds.centres, ...seeds.turns]) expect(stripped, `world ${id}`).not.toContain(line);
      expect(stripped, `world ${id}`).toContain('Story guidance:');
      expect(stripped, `world ${id}`).toMatch(/^COSTUME:/m);
      expect(parseWorldPlaces(stripped) || [], `world ${id}`).toEqual(parseWorldPlaces(text) || []);
    }
  });

  it('leaves a guide with no lists alone, and is safe on empty input', () => {
    const plain = 'COSTUME: none\n\nStory guidance:\n- be nice';
    expect(stripSeedLists(plain)).toBe(plain);
    expect(stripSeedLists('')).toBe('');
    expect(stripSeedLists(null)).toBeNull();
  });

  it('the STORY path still gets the lists — only the idea route strips them', () => {
    expect(getAdventureGuide('space')).toContain('Who lives here (pick one):');
    const route = require('fs').readFileSync(path.join(ROOT, 'server/routes/storyIdeas.js'), 'utf-8');
    expect(route).toContain('stripSeedLists(getAdventureGuide(effectiveTheme))');
  });
});

describe('pickHistoricalAngle — historical has no centre list, so its angles are the seed', () => {
  const sheet = 'EVENT: A thing (1969)\n\nSTORY ANGLES:\n- angle one about a child\n- angle two about a sister\n- angle three about a dog\n- angle four about a radio\n\nTHEMES:\n- courage';
  const cast = [{ name: 'Luca', age: 9, isMain: true }];

  it('parses the angles and stops at the next section', () => {
    expect(parseHistoricalAngles(sheet)).toEqual([
      'angle one about a child', 'angle two about a sister', 'angle three about a dog', 'angle four about a radio',
    ]);
    expect(parseHistoricalAngles('EVENT: x')).toBeNull();
    expect(parseHistoricalAngles(null)).toBeNull();
  });

  it('is deterministic and gives the two arms different angles', () => {
    const a = pickHistoricalAngle({ sheet, characters: cast, topic: 'moon-landing', language: 'de', arm: 0 });
    const b = pickHistoricalAngle({ sheet, characters: cast, topic: 'moon-landing', language: 'de', arm: 1 });
    expect(a).toBe(pickHistoricalAngle({ sheet, characters: cast, topic: 'moon-landing', language: 'de', arm: 0 }));
    expect(a).not.toBe(b);
    expect(parseHistoricalAngles(sheet)).toContain(a);
  });

  it('injects nothing when the sheet names no angles', () => {
    expect(pickHistoricalAngle({ sheet: 'EVENT: x', characters: cast, arm: 0 })).toBeNull();
    expect(historicalAngleInstruction(null)).toBe('');
    expect(historicalAngleInstruction('angle one')).toBe('This idea is seen from here: angle one. Build the want or the obstacle on it.');
  });

  it('every real historical guide yields two different angles', () => {
    const { getIdeaGuide, getTeachingGuide } = require(path.join(ROOT, 'server/lib/promptBuilders'));
    for (const topic of ['moon-landing', 'wright-brothers']) {
      const guide = getIdeaGuide('historical', topic);
      expect(guide, topic).toBeTruthy();
      const a = pickHistoricalAngle({ sheet: guide, characters: cast, topic, language: 'de', arm: 0 });
      const b = pickHistoricalAngle({ sheet: guide, characters: cast, topic, language: 'de', arm: 1 });
      expect(a, topic).toBeTruthy();
      expect(a, topic).not.toBe(b);
      expect(parseHistoricalAngles(getTeachingGuide('historical', topic))).toContain(a);
    }
  });
});

describe('the seed line is injected once per arm, in both siblings', () => {
  // Round 16: the centre goes back into the templates, alone. Both members of
  // the `story-idea-templates` set carry it — the single template once (the
  // caller overrides {WORLD_SEED} per arm), the pair template once per draft
  // block, beside the shape it sits with.
  const fs = require('fs');
  const single = fs.readFileSync(path.join(ROOT, 'prompts/generate-story-idea-single.txt'), 'utf-8');
  const pair = fs.readFileSync(path.join(ROOT, 'prompts/generate-story-ideas.txt'), 'utf-8');
  const route = fs.readFileSync(path.join(ROOT, 'server/routes/storyIdeas.js'), 'utf-8');
  it('the single template carries {WORLD_SEED} exactly once, right after the world guide', () => {
    expect(single.split('{WORLD_SEED}').length - 1).toBe(1);
    expect(single).toMatch(/\{ADVENTURE_SETTING_GUIDE\}\s*\n\s*\n\{WORLD_SEED\}/);
  });
  it('the pair template carries one per draft block, beside the shape', () => {
    expect(pair.split('{WORLD_SEED_1}').length - 1).toBe(1);
    expect(pair.split('{WORLD_SEED_2}').length - 1).toBe(1);
    expect(pair).toMatch(/\{PREMISE_SHAPE_1\}\n\{WORLD_SEED_1\}/);
    expect(pair).toMatch(/\{PREMISE_SHAPE_2\}\n\{WORLD_SEED_2\}/);
  });
  it('the route still declares all three placeholders, from ONE per-arm value', () => {
    for (const k of ['WORLD_SEED:', 'WORLD_SEED_1:', 'WORLD_SEED_2:']) expect(route).toContain(k);
    expect(route).toContain('worldSeedLines');
  });
});


// ---- WORLD PLACE (2026-09-21) ----
// The location arm is handed named landmarks; the fantasy arm invented its own
// scenery and read 3.63 against the location arm's 4.08 in the round-10 blind.
// Worlds with no setting line in their guide yield null and inject nothing.
const WORLDS_WITHOUT_A_SETTING_LINE = new Set(['detective', 'ninja']);

describe('parseWorldPlaces', () => {
  it('yields places for every adventure world that names them, and null for the rest', () => {
    expect(GUIDES.size).toBeGreaterThanOrEqual(30);
    let withPlaces = 0;
    for (const [id, text] of GUIDES) {
      const places = parseWorldPlaces(text);
      if (WORLDS_WITHOUT_A_SETTING_LINE.has(id)) {
        expect(places, `world ${id} was expected to have no setting line`).toBeNull();
        continue;
      }
      expect(places, `world ${id} has no setting line`).not.toBeNull();
      withPlaces++;
      expect(places.length, `world ${id} places`).toBeGreaterThanOrEqual(3);
      for (const place of places) {
        expect(place.length, `world ${id}: ${place}`).toBeGreaterThan(2);
        // a place, not a list, not a leftover bullet, not a parenthetical
        expect(place).not.toMatch(/^[-•]/);
        expect(place).not.toContain(',');
        expect(place).not.toContain('(');
        expect(place).not.toContain(')');
        expect(place).not.toMatch(/^(or|and)/i);
        expect(place).toBe(place.trim());
      }
    }
    expect(withPlaces).toBe(GUIDES.size - WORLDS_WITHOUT_A_SETTING_LINE.size);
  });

  it('takes the places after a colon, not the era in front of it', () => {
    const places = parseWorldPlaces(GUIDES.get('roman'));
    expect(places).not.toContain('ancient Rome');
    expect(places[0]).toBe('marble forums');
    // the parenthetical on the Colosseum entry is dropped, the entry is kept
    expect(places).toContain('Colosseum');
  });

  it('handles a setting line with a preposition other than "in"', () => {
    expect(parseWorldPlaces(GUIDES.get('pirate'))).toEqual(['ships', 'tropical islands', 'coastal towns']);
  });

  it('returns null with no setting line at all', () => {
    expect(parseWorldPlaces('Story guidance:\n- Focus on teamwork')).toBeNull();
    expect(parseWorldPlaces('')).toBeNull();
    expect(parseWorldPlaces(null)).toBeNull();
  });
});

describe('pickWorldPlace', () => {
  const cast = [{ name: 'Noah', age: 3, isMain: true }];
  const input = { theme: 'pirate', characters: cast, topic: '', language: 'de' };

  it('is deterministic and gives the two arms different places', () => {
    expect(pickWorldPlace({ ...input, arm: 0 })).toBe(pickWorldPlace({ ...input, arm: 0 }));
    expect(pickWorldPlace({ ...input, arm: 1 })).not.toBe(pickWorldPlace({ ...input, arm: 0 }));
  });

  it('picks a place the guide actually names, for every world', () => {
    for (const [id, text] of GUIDES) {
      for (const arm of [0, 1]) {
        const place = pickWorldPlace({ theme: id, characters: cast, topic: 'x', language: 'de', arm });
        if (WORLDS_WITHOUT_A_SETTING_LINE.has(id)) { expect(place).toBeNull(); continue; }
        expect(parseWorldPlaces(text), `world ${id}`).toContain(place);
      }
    }
  });

  it('yields null with no theme and for a theme with no adventure guide', () => {
    expect(pickWorldPlace({ ...input, theme: null })).toBeNull();
    expect(pickWorldPlace({ ...input, theme: 'no-such-world' })).toBeNull();
  });
});

describe('worldPlaceInstruction', () => {
  it('names the place where the action is and asks for no description', () => {
    const line = worldPlaceInstruction('a lantern-lit porch');
    expect(line).toContain('a lantern-lit porch');
    expect(line).toMatch(/do not describe it/i);
  });
  it('is empty when there is no place', () => {
    expect(worldPlaceInstruction(null)).toBe('');
    expect(worldPlaceInstruction('')).toBe('');
  });
});
