# Deployment Guide

## Push to GitHub and Deploy

### Step 1: Create a GitHub Repository

1. Go to [GitHub](https://github.com) and log in
2. Click the **+** icon in the top right and select **New repository**
3. Name your repository: `MagicalStory` (or any name you prefer)
4. Make it **Public** (required for GitHub Pages)
5. **Do NOT** initialize with README, .gitignore, or license (we already have these)
6. Click **Create repository**

### Step 2: Push Your Code to GitHub

After creating the repository, GitHub will show you commands. Run these in your terminal:

```bash
# Add the GitHub repository as remote
git remote add origin https://github.com/YOUR_USERNAME/MagicalStory.git

# Push your code to GitHub
git push -u origin master
```

Replace `YOUR_USERNAME` with your actual GitHub username.

### Step 3: Enable GitHub Pages

1. Go to your repository on GitHub
2. Click **Settings** (top menu)
3. Scroll down and click **Pages** (left sidebar)
4. Under **Source**, select **Deploy from a branch**
5. Under **Branch**, select **master** and **/ (root)**
6. Click **Save**
7. Wait a few minutes for the site to deploy

Your site will be available at:
```
https://YOUR_USERNAME.github.io/MagicalStory/
```

## Alternative: Deploy to IONOS

### Option 1: Direct Upload
1. Log in to your IONOS account
2. Go to your website's file manager
3. Upload `index.html` to your public web directory
4. Access it via your domain: `https://yourdomain.com/index.html`

### Option 2: Import from GitHub (Recommended)
1. First, deploy to GitHub Pages (see above)
2. In IONOS, set up a redirect or frame to your GitHub Pages URL
3. Or use IONOS Deploy Now feature to connect your GitHub repository

## Testing Your Deployment

After deployment:
1. Visit your site URL
2. Select a language
3. When prompted, enter your Anthropic API key
   - Get one free at [console.anthropic.com](https://console.anthropic.com/)
   - Your API key is stored locally in your browser only
4. Create characters and generate stories!

## Troubleshooting

### GitHub Pages not showing up?
- Wait 5-10 minutes after enabling GitHub Pages
- Check that repository is **Public**
- Verify the branch is set to **master**

### API Key not working?
- Make sure you copied the entire key (starts with `sk-ant-`)
- Check your Anthropic account has API credits
- Open browser console (F12) to see any error messages

### IONOS Upload Issues?
- Make sure `index.html` is in the correct public directory
- File permissions should be readable (644)
- Try clearing your browser cache

## Need Help?

- GitHub Pages: https://docs.github.com/pages
- IONOS Support: https://www.ionos.com/help
- Anthropic API: https://docs.anthropic.com/

## Security Note

Your Anthropic API key is stored in your browser's localStorage and is only sent to Anthropic's servers when generating stories. It's never sent to any other server or exposed publicly.

For production use, consider setting up a backend server to securely handle API keys instead of client-side storage.
