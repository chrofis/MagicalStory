# MagicalStory Server Setup

This document explains how to set up and run the MagicalStory server with user authentication and API key management.

## Features

- **User Authentication**: Login/Registration system with JWT tokens
- **Server-side API Keys**: Store Anthropic and Gemini API keys securely on the server
- **Activity Logging**: Track all user actions and API calls
- **Admin Panel**: First registered user becomes admin with access to logs and key management

## Installation

### 1. Install Dependencies

```bash
npm install
```

This will install:
- `express` - Web server framework
- `cors` - Cross-origin resource sharing
- `bcryptjs` - Password hashing
- `jsonwebtoken` - JWT authentication

### 2. Configuration

Create a `.env` file in the root directory (copy from `.env.example`):

```bash
cp .env.example .env
```

Edit the `.env` file and set a secure JWT secret:

```env
PORT=3000
JWT_SECRET=your-very-secure-random-string-here
```

**Important**: Change the `JWT_SECRET` to a long random string in production!

### 3. Start the Server

```bash
npm start
```

Or for development with auto-reload:

```bash
npm run dev
```

The server will start on `http://localhost:3000`

## First Time Setup

### 1. Register First User (Admin)

When you first start the application, you'll see a login/registration modal.

1. Click "Sign up"
2. Enter username and password
3. The **first user** to register automatically becomes the **admin**

### 2. Configure API Keys (Admin Only)

As an admin, you can set the API keys that all users will share:

1. Open your browser console and run:

```javascript
// Set API keys (admin only)
fetch('http://localhost:3000/api/admin/config', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${localStorage.getItem('auth_token')}`
  },
  body: JSON.stringify({
    anthropicApiKey: 'your-anthropic-api-key',
    geminiApiKey: 'your-gemini-api-key'
  })
})
.then(res => res.json())
.then(data => console.log(data));
```

2. Or add an admin panel UI to the frontend (recommended for production)

### 3. Verify Setup

Open `http://localhost:3000` in your browser. You should see:
- Login/Registration modal
- After logging in, you'll see your username in the navigation bar
- Admin users will see a crown icon (👑) next to their name

## Data Storage

The server uses simple JSON files for storage (located in `data/` directory):

- `data/users.json` - User accounts (passwords are hashed)
- `data/logs.json` - Activity logs
- `data/config.json` - API keys (Anthropic & Gemini)

**Note**: For production, consider migrating to a proper database (PostgreSQL, MongoDB, etc.)

## API Endpoints

### Authentication

- `POST /api/auth/register` - Register new user
- `POST /api/auth/login` - Login user
- `GET /api/health` - Server health check

### Protected Endpoints (Require Authentication)

- `POST /api/claude` - Proxy to Claude API
- `POST /api/gemini` - Proxy to Gemini API

### Admin Only Endpoints

- `POST /api/admin/config` - Set API keys
- `GET /api/admin/logs?limit=100` - View activity logs
- `GET /api/admin/users` - List all users

## Activity Logging

All user actions are logged including:
- User registration/login
- API calls (Claude & Gemini)
- API key updates

View logs (admin only):

```bash
# View last 100 log entries
curl -H "Authorization: Bearer YOUR_TOKEN" http://localhost:3000/api/admin/logs?limit=100
```

Or check the `data/logs.json` file directly.

## Security Notes

### Production Deployment

1. **Change JWT_SECRET**: Use a strong random string
2. **Use HTTPS**: Never run without SSL in production
3. **Environment Variables**: Store API keys in environment variables, not in code
4. **Database**: Migrate from JSON files to a proper database
5. **Rate Limiting**: Add rate limiting to prevent abuse
6. **Input Validation**: Add additional input validation
7. **CORS Configuration**: Restrict CORS to your domain only

### Password Security

- Passwords are hashed using bcrypt before storage
- Passwords are never stored in plain text
- JWT tokens expire after 7 days

## Troubleshooting

### Port Already in Use

If port 3000 is already in use, change it in `.env`:

```env
PORT=3001
```

### Connection Refused

Make sure the server is running:

```bash
npm start
```

### API Keys Not Working

1. Check that keys are correctly set in `data/config.json`
2. Verify you're logged in (check localStorage for `auth_token`)
3. Check server logs for error messages

### Can't Login

1. Clear browser localStorage: `localStorage.clear()`
2. Delete `data/users.json` and restart server
3. Re-register as first user to become admin again

## Monitoring

### View Logs

```bash
# Watch logs in real-time
tail -f data/logs.json

# Pretty print logs
cat data/logs.json | jq '.'
```

### View Users

```bash
# Pretty print users (passwords are hashed)
cat data/users.json | jq '.'
```

## Development

### File Structure

```
MagicalStory/
├── server.js           # Main server file
├── package.json        # Dependencies
├── .env                # Configuration (create from .env.example)
├── index.html          # Frontend application
└── data/               # Data storage (created automatically)
    ├── users.json      # User accounts
    ├── logs.json       # Activity logs
    └── config.json     # API keys
```

### Adding New Endpoints

Edit `server.js` and add new routes:

```javascript
app.post('/api/your-endpoint', authenticateToken, async (req, res) => {
  // Your code here
  await logActivity(req.user.id, req.user.username, 'YOUR_ACTION', {});
  res.json({ success: true });
});
```

## Support

For issues or questions, check the logs:
- Server logs: Console output where `npm start` is running
- Activity logs: `data/logs.json`
- Browser console: F12 in your browser

## License

MIT
