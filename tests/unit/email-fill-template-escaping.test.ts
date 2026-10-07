// fillTemplate escapes interpolated values in the Html part only. A story
// title «Max & Moritz» or a shipping name containing `<` used to be injected
// into the markup as-is; the Subject and Text parts are plain text and keep
// the raw value. No sender passes markup as a value (every value in email.js
// is plain text or a URL), so there is no raw marker — this test pins the
// escaping on the real templates filled the way the senders fill them.

import { describe, it, expect } from 'vitest';
import path from 'path';

const ROOT = path.resolve(__dirname, '..', '..');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const email = require(path.join(ROOT, 'email.js'));
const { fillTemplate, getTemplateSection } = email;

const HOSTILE = `Max & Moritz <b>"bold"</b> 'quote' $& $1`;
const ESCAPED = 'Max &amp; Moritz &lt;b&gt;&quot;bold&quot;&lt;/b&gt; &#39;quote&#39; $&amp; $1';

describe('fillTemplate', () => {
  it('escapes & < > " \' in values when { html: true }', () => {
    expect(fillTemplate('<h1>{title}</h1>', { title: HOSTILE }, { html: true })).toBe(`<h1>${ESCAPED}</h1>`);
  });

  it('keeps values raw for Subject and Text (the default)', () => {
    expect(fillTemplate('Subject {title}', { title: HOSTILE })).toBe(`Subject ${HOSTILE}`);
    expect(fillTemplate('Text {title}', { title: HOSTILE }, { html: false })).toBe(`Text ${HOSTILE}`);
  });

  it('never reads a value as a replacement pattern ($& / $1 stay literal)', () => {
    expect(fillTemplate('{a}', { a: 'cost $& or $1' })).toBe('cost $& or $1');
  });

  it('escapes once — a value is never double-escaped', () => {
    expect(fillTemplate('{a}', { a: '&amp;' }, { html: true })).toBe('&amp;amp;');
    expect(fillTemplate('{a}', { a: 'a & b' }, { html: true })).toBe('a &amp; b');
  });

  it('a conditional block tests the raw value; an empty value strips the block', () => {
    expect(fillTemplate('{?x}<img src="{x}">{/x}', { x: 'https://r2/c.jpg?a=1&b=2' }, { html: true }))
      .toBe('<img src="https://r2/c.jpg?a=1&amp;b=2">');
    expect(fillTemplate('{?x}<img src="{x}">{/x}', { x: '' }, { html: true })).toBe('');
  });

  it('null and undefined values fill as empty, in both modes', () => {
    expect(fillTemplate('[{a}][{b}]', { a: null, b: undefined }, { html: true })).toBe('[][]');
    expect(fillTemplate('[{a}][{b}]', { a: null, b: undefined })).toBe('[][]');
  });
});

describe('the story-complete mail, filled as its sender fills it', () => {
  for (const language of ['English', 'German', 'French', 'Italian']) {
    it(`[${language}] title is escaped in the html and raw in subject and text`, () => {
      const section = getTemplateSection('story-complete', language);
      const values = { greeting: ' Anna <script>', title: HOSTILE, storyUrl: 'https://magicalstory.ch/shared/t?key=1.ab', claimUrl: '', coverUrl: '', credits: '10' };
      const html = fillTemplate(section.html, values, { html: true });
      const text = fillTemplate(section.text, values);
      const subject = fillTemplate(section.subject, values);
      expect(html).toContain(ESCAPED);
      expect(html).not.toContain('<b>"bold"</b>');
      expect(html).not.toContain('<script>');
      expect(html).toContain('Anna &lt;script&gt;');
      expect(text).toContain(HOSTILE);
      expect(subject).toContain(HOSTILE);
    });
  }
});

describe('every sender fills the Html part with { html: true } and the Subject/Text parts without', () => {
  it('email.js source', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const source = require('fs').readFileSync(path.join(ROOT, 'email.js'), 'utf8');
    const htmlFills = source.match(/html: fillTemplate\(template\.html, values(, \{ html: true \})?\)/g) || [];
    expect(htmlFills.length).toBeGreaterThanOrEqual(8);
    for (const f of htmlFills) expect(f).toContain('{ html: true }');
    expect(source).not.toMatch(/subject: fillTemplate\([^)]*html: true/);
    expect(source).not.toMatch(/text: fillTemplate\([^)]*html: true/);
  });
});
