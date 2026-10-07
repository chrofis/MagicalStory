// Compiled email templates, read the way a send reads them, leave no
// `{placeholder}` behind.
//
// order-confirmation / order-shipped wrote `alt="{title}"` on the cover
// thumbnail, but their senders have no title (orders carry only story_id),
// so every order mail with a cover shipped a literal `{title}` alt. The alt
// is now a static localized string (`coverAlt` in emails-src/i18n.ts).

import { describe, it, expect } from 'vitest';
import path from 'path';

const ROOT = path.resolve(__dirname, '..', '..');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const email = require(path.join(ROOT, 'email.js'));
const { getTemplateSection } = email;

const LANGUAGES = ['English', 'German', 'French', 'Italian'];

describe('order mails: the cover alt is a localized string, not {title}', () => {
  for (const name of ['order-confirmation', 'order-shipped']) {
    for (const language of LANGUAGES) {
      it(`${name} [${language}]`, () => {
        const { html } = getTemplateSection(name, language);
        expect(html).not.toContain('{title}');
        const alt = html.match(/<img[^>]*alt="([^"]*)"/)?.[1];
        expect(alt).toBeTruthy();
      });
    }
  }
});
