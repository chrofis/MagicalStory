import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { preferredLangFromHeader, isCrawlerUserAgent } = require('../../server/lib/seoMeta.js');

describe('Accept-Language → preferred site language', () => {
  it('matches on the primary subtag and honours q-values', () => {
    expect(preferredLangFromHeader('it-CH,it;q=0.9,en;q=0.8')).toBe('it');
    expect(preferredLangFromHeader('fr-FR;q=0.7, en-US;q=0.9')).toBe('en');
    expect(preferredLangFromHeader('de-CH,de;q=0.9')).toBe('de');
    expect(preferredLangFromHeader('pt-BR,es;q=0.8')).toBeNull();
    expect(preferredLangFromHeader('*')).toBeNull();
    expect(preferredLangFromHeader(undefined)).toBeNull();
  });
});

describe('crawlers are never redirected by Accept-Language', () => {
  it.each([
    'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
    'Mozilla/5.0 (compatible; Google-InspectionTool/1.0)',
    'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
    'Twitterbot/1.0',
    'Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)',
    'DuckDuckBot/1.1; (+http://duckduckgo.com/duckduckbot.html)',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.1 Safari/605.1.15 (Applebot/0.1; +http://www.apple.com/go/applebot)',
    'Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)',
  ])('%s is a crawler', (ua) => {
    expect(isCrawlerUserAgent(ua)).toBe(true);
  });

  it.each([
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0',
    '',
    undefined,
  ])('%s is a visitor and may be redirected', (ua) => {
    expect(isCrawlerUserAgent(ua)).toBe(false);
  });
});
