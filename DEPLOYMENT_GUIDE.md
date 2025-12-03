# MagicalStory - Deployment Guide

This guide shows you how to deploy MagicalStory to make it accessible on the internet.

## 🚀 Deployment Options

### Option 1: Railway.app (Recommended - Easiest)
### Option 2: Render.com (Free tier available)
### Option 3: Your Own VPS/Server
### Option 4: Heroku (Paid only)

---

## Option 1: Deploy to Railway.app (EASIEST)

Railway is perfect for Node.js apps and has a generous free tier.

### Step 1: Prepare Your Code

1. Create a `.gitignore` file:

```
node_modules/
.env
data/
```

2. Create a `railway.json` file:

```json
{
  "$schema": "https://railway.app/railway.schema.json",
  "build": {
    "builder": "NIXPACKS"
  },
  "deploy": {
    "startCommand": "node server.js",
    "restartPolicyType": "ON_FAILURE",
    "restartPolicyMaxRetries": 10
  }
}
```

### Step 2: Update server.js for Production

Add this at the top of server.js (after the imports):

```javascript
// Serve static files from current directory
app.use(express.static(__dirname));

// Serve index.html for root path
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});
```

### Step 3: Deploy to Railway

1. Go to https://railway.app/
2. Sign up with GitHub
3. Click "New Project" → "Deploy from GitHub repo"
4. Select your MagicalStory repository
5. Railway will auto-detect Node.js and deploy!

### Step 4: Configure Environment Variables

In Railway dashboard:
1. Click your project
2. Go to "Variables" tab
3. Add:
   - `JWT_SECRET` = `your-random-secret-string-here`
   - `PORT` = `3000` (Railway will override this automatically)

### Step 5: Get Your URL

Railway will give you a URL like: `https://your-app-name.railway.app`

That's it! Your app is live! 🎉

---

## Option 2: Deploy to Render.com

Render has a free tier and is very reliable.

### Step 1: Prepare Your Code

Same `.gitignore` as Railway (above)

### Step 2: Create render.yaml

```yaml
services:
  - type: web
    name: magical-story
    env: node
    buildCommand: npm install
    startCommand: node server.js
    envVars:
      - key: JWT_SECRET
        generateValue: true
      - key: NODE_ENV
        value: production
```

### Step 3: Deploy

1. Go to https://render.com/
2. Sign up with GitHub
3. Click "New" → "Web Service"
4. Connect your GitHub repository
5. Render will auto-detect settings from render.yaml
6. Click "Create Web Service"

### Step 4: Update Frontend URL

After deployment, update `index.html` to use your Render URL instead of `localhost:3000`:

Find all instances of:
```javascript
fetch('http://localhost:3000/api/
```

Replace with:
```javascript
const API_URL = window.location.origin;
fetch(`${API_URL}/api/
```

Your app will be live at: `https://your-app-name.onrender.com`

---

## Option 3: Deploy to Your Own Server/VPS

If you have a VPS (DigitalOcean, AWS, Linode, etc.):

### Step 1: Server Setup

```bash
# SSH into your server
ssh root@your-server-ip

# Update system
apt update && apt upgrade -y

# Install Node.js
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs

# Install PM2 (process manager)
npm install -g pm2

# Install Nginx (web server)
apt install -y nginx
```

### Step 2: Upload Your Code

```bash
# On your local machine
scp -r C:\Users\roger\MagicalStory root@your-server-ip:/var/www/

# Or use Git
cd /var/www
git clone your-repository-url magical-story
cd magical-story
```

### Step 3: Install Dependencies

```bash
cd /var/www/magical-story
npm install
```

### Step 4: Configure Environment

```bash
# Create .env file
nano .env
```

Add:
```
PORT=3000
JWT_SECRET=your-very-secure-random-string
NODE_ENV=production
```

### Step 5: Start with PM2

```bash
# Start the app
pm2 start server.js --name magical-story

# Make it start on boot
pm2 startup
pm2 save
```

### Step 6: Configure Nginx

```bash
nano /etc/nginx/sites-available/magical-story
```

Add:
```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

Enable site:
```bash
ln -s /etc/nginx/sites-available/magical-story /etc/nginx/sites-enabled/
nginx -t
systemctl restart nginx
```

### Step 7: Setup SSL (HTTPS)

```bash
# Install Certbot
apt install -y certbot python3-certbot-nginx

# Get SSL certificate
certbot --nginx -d your-domain.com
```

Your app is now live at: `https://your-domain.com` 🎉

---

## 📝 IMPORTANT: Production Changes Needed

### 1. Update API URLs in Frontend

In `index.html`, find these lines and update:

**Current (Development):**
```javascript
fetch('http://localhost:3000/api/auth/login', {
```

**Change to (Production):**
```javascript
const API_URL = window.location.origin; // Automatically uses current domain
fetch(`${API_URL}/api/auth/login`, {
```

Do this for ALL fetch calls in the file.

### 2. Use a Real Database (Important!)

The current JSON file storage won't work well in production. Upgrade to a database:

**Quick Fix for Railway/Render:**
- They both offer free PostgreSQL databases
- Install: `npm install pg`
- Update server.js to use PostgreSQL instead of JSON files

**Or use MongoDB:**
- Create free database at MongoDB Atlas
- Install: `npm install mongoose`
- Update server.js to use MongoDB

### 3. Security Updates

Add to `server.js`:

```javascript
// Add security headers
const helmet = require('helmet');
app.use(helmet());

// Rate limiting
const rateLimit = require('express-rate-limit');
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100 // limit each IP to 100 requests per windowMs
});
app.use('/api/', limiter);

// Update CORS for production
app.use(cors({
  origin: 'https://your-domain.com', // Replace with your domain
  credentials: true
}));
```

Install dependencies:
```bash
npm install helmet express-rate-limit
```

### 4. Environment Variables

Never commit these to Git:
- JWT_SECRET
- API keys
- Database passwords

Always use environment variables or secrets management.

---

## 🔧 Quick Production Checklist

- [ ] Update API URLs from localhost to production domain
- [ ] Set strong JWT_SECRET environment variable
- [ ] Configure CORS properly
- [ ] Add rate limiting
- [ ] Setup HTTPS/SSL
- [ ] Use a real database (PostgreSQL/MongoDB)
- [ ] Add security headers (helmet)
- [ ] Setup error logging (e.g., Sentry)
- [ ] Configure backup system for database
- [ ] Test all features on production
- [ ] Setup monitoring (e.g., UptimeRobot)

---

## 🆘 Common Issues

### "Mixed content" errors
- Make sure both frontend and backend use HTTPS
- Update all API URLs to use HTTPS

### CORS errors
- Add your domain to CORS configuration in server.js
- Check that credentials are properly set

### Database not persisting
- JSON files don't persist on platforms like Railway/Render
- Migrate to PostgreSQL or MongoDB

### App crashes on restart
- Use PM2 or platform's built-in process management
- Check logs for errors

---

## 💡 Recommended Setup for Production

**Best practice stack:**

1. **Hosting**: Railway.app or Render.com (easiest)
2. **Database**: Railway/Render PostgreSQL (free tier)
3. **Domain**: Buy from Namecheap/GoDaddy, point to your app
4. **Monitoring**: UptimeRobot (free)
5. **Errors**: Sentry.io (free tier)

**Total cost**: $0 - $7/month depending on traffic

---

## 📞 Need Help?

Check deployment logs:
- Railway: In dashboard → Deployments → View Logs
- Render: In dashboard → Logs tab
- VPS: `pm2 logs magical-story`

Common log locations:
- `pm2 logs`
- `/var/log/nginx/error.log`
- Browser console (F12)
