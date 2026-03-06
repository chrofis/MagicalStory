# Deploy to Cloudflare Workers + IONOS

This guide will help you deploy the AI Story Creator with:
- **Frontend (HTML)** → IONOS (magicalstory.ch)
- **API Proxy** → Cloudflare Workers (free)

---

## Part 1: Deploy Cloudflare Worker (API Proxy)

### Step 1: Create Cloudflare Account
1. Go to https://dash.cloudflare.com/sign-up
2. Sign up for a **free account**
3. Verify your email

### Step 2: Create Worker
1. Log in to Cloudflare Dashboard
2. Go to **Workers & Pages** (left sidebar)
3. Click **Create Application**
4. Click **Create Worker**
5. Give it a name: `magical-story-api` (or any name)
6. Click **Deploy**

### Step 3: Edit Worker Code
1. After deployment, click **Edit Code**
2. **Delete all existing code** in the editor
3. **Copy and paste** the entire content from `cloudflare-worker.js`
4. Click **Save and Deploy**

### Step 4: Get Worker URL
1. After saving, you'll see your worker URL
2. It will look like: `https://magical-story-api.YOUR-SUBDOMAIN.workers.dev`
3. **Copy this URL** - you'll need it for the next step

---

## Part 2: Update index.html for Production

You need to update the API endpoint in index.html to use your Cloudflare Worker instead of localhost.

### Find and Replace in index.html:

**Find this line (around line 432):**
```javascript
const response = await fetch('http://localhost:8000/api/generate', {
```

**Replace with:**
```javascript
const response = await fetch('https://magical-story-api.YOUR-SUBDOMAIN.workers.dev', {
```

**IMPORTANT:** Replace `YOUR-SUBDOMAIN` with your actual Cloudflare Worker URL from Step 4!

---

## Part 3: Deploy to IONOS

### Step 1: Activate IONOS Hosting
1. Log in to https://www.ionos.com/
2. Go to **Websites & Domains**
3. Find **magicalstory.ch**
4. Make sure it's **Active** (not "Setup Required" or "Not Published")

### Step 2: Upload index.html
1. Open **File Manager** for magicalstory.ch
2. Navigate to the **web root** directory (usually `/` or `/public_html/`)
3. Upload your **updated index.html** file
4. Set permissions to **644** (if needed)

### Step 3: Test
1. Go to https://magicalstory.ch/ (or http://magicalstory.ch/)
2. You should see the AI Story Creator!
3. Test by creating a character and generating a story

---

## Troubleshooting

### Worker Not Working?
- Check the Worker URL is correct in index.html
- Make sure you replaced `YOUR-SUBDOMAIN` with actual subdomain
- Check Cloudflare Worker logs in the dashboard

### IONOS Site Not Loading?
- Verify the website is **Active** in IONOS control panel
- Check that index.html is in the correct directory
- Wait 5-10 minutes after uploading (cache/DNS)
- Try clearing browser cache (Ctrl+Shift+R)

### API Errors?
- Check your Anthropic API key is correct
- Verify you have API credits remaining
- Check browser console (F12) for error messages

---

## Cost Breakdown

- **Cloudflare Workers:** FREE (100,000 requests/day)
- **IONOS Hosting:** Your existing plan
- **Anthropic API:** Pay per use (~$0.01-0.05 per story)

---

## Security Notes

- API keys are stored in browser localStorage (client-side only)
- Cloudflare Worker forwards requests but doesn't store API keys
- For production, consider implementing rate limiting
- Never commit your API key to git (already in .gitignore)

---

## Need Help?

- Cloudflare Workers: https://developers.cloudflare.com/workers/
- IONOS Support: https://www.ionos.com/help
- GitHub Issues: https://github.com/chrofis/MagicalStory/issues
