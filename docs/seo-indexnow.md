# IndexNow / Bing setup

Why: ChatGPT's web search draws heavily on Bing's index, and ChatGPT is our #1 trial source.
IndexNow (https://www.indexnow.org/documentation) tells Bing (and Yandex etc.) about new/changed URLs immediately.

## How it works here
- `server.js` serves `https://magicalstory.ch/<INDEXNOW_KEY>.txt` (body = the key) **only** when the env var `INDEXNOW_KEY` is set. Unset = 404, no default key.
- `scripts/seo/indexnow-submit.js` verifies that key file is live, reads the live `/sitemap.xml`, and POSTs the URLs (batches of up to 10,000) to `https://api.indexnow.org/indexnow`. Non-2xx = exit 1.
- Tests: `npx vitest run tests/unit/indexnow-submit.test.ts`

## One-time setup (owner)
1. Generate a key: 8-128 chars of `a-z A-Z 0-9 -`, e.g. `node -e "console.log(require('crypto').randomBytes(16).toString('hex'))"`.
2. Set `INDEXNOW_KEY` on Railway **production** (and keep it in your local shell env for the script). Never commit it.
3. Deploy (the key route only exists after a restart with the var set); check `https://magicalstory.ch/<key>.txt` returns the key.
4. Dry run, then the real submission:
   `INDEXNOW_KEY=<key> node scripts/seo/indexnow-submit.js --dry-run`
   `INDEXNOW_KEY=<key> node scripts/seo/indexnow-submit.js`
   Options: `--base=<url>`, `--urls=https://magicalstory.ch/a,https://magicalstory.ch/b`.
5. Bing Webmaster Tools (https://www.bing.com/webmasters): sign in, "Import from Google Search Console", pick `magicalstory.ch`. This verifies the site and pulls the sitemap in one step.

Re-run the script after content/sitemap changes. It is not hooked into deploys.
