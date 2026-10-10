import { describe, it, expect, vi } from 'vitest';

// The server/scripts source walk takes seconds alone and exceeds the 10s default under full-suite load.
vi.setConfig({ testTimeout: 60000 });
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { TEXT_MODELS, MODEL_DEFAULTS, MODEL_PRICING } = require('../../server/config/models');

// Owner directive 2026-10-05: no Sonnet 4.6 anywhere. 'claude-sonnet' is the one alias.
describe('claude-sonnet alias', () => {
  it('resolves to Sonnet 5.5 and shares one entry with claude-sonnet-5-5', () => {
    expect(TEXT_MODELS['claude-sonnet'].modelId).toBe('claude-sonnet-5-5');
    expect(TEXT_MODELS['claude-sonnet']).toBe(TEXT_MODELS['claude-sonnet-5-5']);
    expect(TEXT_MODELS['claude-sonnet'].maxOutputTokens).toBe(128000);
  });

  it('every Sonnet-routed default lands on 5.5', () => {
    for (const k of ['idea', 'outline', 'storyText', 'childCriticModel', 'scorecardJudge']) {
      expect(TEXT_MODELS[MODEL_DEFAULTS[k]].modelId, k).toBe('claude-sonnet-5-5');
    }
  });

  it('the alias is priced as Sonnet 5.5, not 4.6', () => {
    expect(MODEL_PRICING['claude-sonnet']).toEqual(MODEL_PRICING['claude-sonnet-5-5']);
  });

  it('no server code names claude-sonnet-4-6 (price table keeps it for historical costs)', () => {
    const root = path.resolve(__dirname, '../..');
    const hits: string[] = [];
    const walk = (p: string) => {
      for (const e of fs.readdirSync(p, { withFileTypes: true })) {
        const f = path.join(p, e.name);
        if (e.isDirectory()) walk(f);
        else if (f.endsWith('.js')) {
          fs.readFileSync(f, 'utf8').split('\n').forEach((l, i) => {
            if (/claude-sonnet-4-6/.test(l) && !l.trim().startsWith('//') && !(f.split(path.sep).join('/').endsWith('config/models.js') && /^\s*'claude-sonnet-4-6':/.test(l))) hits.push(`${path.relative(root, f)}:${i + 1}`);
          });
        }
      }
    };
    walk(path.join(root, 'server'));
    walk(path.join(root, 'scripts'));
    expect(hits).toEqual([]);
  });
});
