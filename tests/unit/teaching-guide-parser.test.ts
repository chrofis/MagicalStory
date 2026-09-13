import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { parseTeachingGuideFile } = require('../../server/lib/promptBuilders.js');

const PROMPTS_DIR = path.join(__dirname, '../../prompts');
const GUIDE_FILES = [
  'educational-guides.txt',
  'life-challenge-guides.txt',
  'adventure-guides.txt',
  'historical-guides.txt',
  'swiss-sagen-guides.txt',
];

function parseString(body: string): Map<string, string> {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'guide-')), 'g.txt');
  fs.writeFileSync(file, body, 'utf-8');
  return parseTeachingGuideFile(file);
}

describe('parseTeachingGuideFile', () => {
  it('skips a section banner that FOLLOWS a topic content (the reported defect)', () => {
    const guides = parseString(
      [
        '# File header',
        '',
        '# ===========',
        '# TODDLER',
        '# ===========',
        '',
        '[first-topic]',
        'Real guidance line one.',
        'Real guidance line two.',
        '',
        '# ===========',
        '# PRESCHOOL',
        '# ===========',
        '',
        '[second-topic]',
        'Second guidance.',
        '',
      ].join('\n')
    );

    expect(guides.get('first-topic')).toBe('Real guidance line one.\nReal guidance line two.');
    expect(guides.get('second-topic')).toBe('Second guidance.');
  });

  it('still skips a comment that PRECEDES a topic content', () => {
    const guides = parseString(['[t]', '# leading comment', 'Body.', ''].join('\n'));
    expect(guides.get('t')).toBe('Body.');
  });

  it('only a line-leading # is a comment; a # inside a line is content', () => {
    const guides = parseString(['[t]', 'Count to 10 # not a comment marker here', ''].join('\n'));
    expect(guides.get('t')).toBe('Count to 10 # not a comment marker here');
  });

  it('parses a CRLF file identically to LF (the $ anchor must not see a CR)', () => {
    const body = ['[t]', 'Line one.', 'Line two.', ''].join('\n');
    const lf = parseString(body);
    const crlf = parseString(body.split('\n').join('\r\n'));
    expect(lf.size).toBe(1);
    expect(crlf.size).toBe(lf.size);
    expect(crlf.get('t')).toBe(lf.get('t'));
  });

  it('adventure guides parse all 15 themes regardless of checkout line endings', () => {
    const guides = parseTeachingGuideFile(path.join(PROMPTS_DIR, 'adventure-guides.txt'));
    expect(guides.size).toBe(15);
    expect(guides.get('pirate')).toBeTruthy();
  });

  it('no shipped guide topic contains a comment/banner line, and none is empty', () => {
    let total = 0;
    for (const f of GUIDE_FILES) {
      const guides = parseTeachingGuideFile(path.join(PROMPTS_DIR, f));
      expect(guides.size, `${f} parsed no topics`).toBeGreaterThan(0);
      for (const [id, guide] of guides) {
        total++;
        expect(guide.trim(), `${f} [${id}] is empty`).not.toBe('');
        const banner = guide.split('\n').find((l: string) => l.startsWith('#'));
        expect(banner, `${f} [${id}] has banner pollution`).toBeUndefined();
      }
    }
    expect(total).toBe(184);
  });

  it('life-challenge guides parse all 59 topics clean', () => {
    const guides = parseTeachingGuideFile(path.join(PROMPTS_DIR, 'life-challenge-guides.txt'));
    expect(guides.size).toBe(59);
    for (const id of ['no-pacifier', 'understanding-rules', 'trying-new-things', 'grandparent-sick']) {
      const g = guides.get(id);
      expect(g, `${id} missing`).toBeTruthy();
      expect(g!.split('\n').some((l: string) => l.startsWith('#'))).toBe(false);
    }
  });
});
