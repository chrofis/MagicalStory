import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

const require = createRequire(import.meta.url);
const { THEMES, getMetaForRoute } = require('../../server/lib/seoMeta.js');

const ROOT = path.resolve(__dirname, '../..');
const src = fs.readFileSync(path.join(ROOT, 'client/src/constants/storyTypes.ts'), 'utf8');

// Ids of one array literal in storyTypes.ts (lifeChallenges is derived
// from a catalogue, so its ids are read from that catalogue's `id:` lines).
function idsOf(exportName: string): string[] {
  const start = src.indexOf(`const ${exportName}`);
  if (start < 0) throw new Error(`${exportName} not found`);
  const end = src.indexOf('\n];', start);
  return [...src.slice(start, end).matchAll(/\bid:\s*'([^']+)'/g)].map(m => m[1]);
}

const CLIENT_THEMES: Record<string, string[]> = {
  adventure: idsOf('storyTypes').filter(id => id !== 'custom'),
  educational: idsOf('educationalTopics'),
  historical: idsOf('historicalEvents'),
  'life-challenges': idsOf('lifeChallengeCatalogue'),
};

describe('every theme page the client renders has server meta (title, Product, sitemap entry)', () => {
  it.each(Object.keys(CLIENT_THEMES))('%s: client ids and seoMeta THEMES agree', (category) => {
    const client = CLIENT_THEMES[category];
    expect(client.length).toBeGreaterThan(20);
    const server = Object.keys(THEMES[category]);
    expect(client.filter(id => !server.includes(id)), 'client themes without meta').toEqual([]);
    expect(server.filter(id => !client.includes(id)), 'meta for themes the client does not render').toEqual([]);
  });

  it('the themes that were missing (princess, mothers-day, fathers-day, spelling-name) now get their own title', () => {
    for (const route of ['/themes/adventure/princess', '/themes/adventure/mothers-day', '/themes/adventure/fathers-day', '/themes/educational/spelling-name']) {
      const meta = getMetaForRoute(route, 'de');
      expect(meta.noindex, route).toBe(false);
      expect(meta.title).toMatch(/^Personalisiertes .+-Kinderbuch \| Magical Story$/);
      expect(meta.jsonLd.map((j: { '@type': string }) => j['@type'])).toEqual(['Product', 'BreadcrumbList']);
    }
    expect(getMetaForRoute('/themes/adventure/mothers-day', 'de').title).toBe('Personalisiertes Muttertags-Kinderbuch | Magical Story');
    expect(getMetaForRoute('/themes/adventure/custom', 'de').noindex).toBe(true);
  });
});
