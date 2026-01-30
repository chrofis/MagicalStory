// Authentication Middleware
const jwt = require('jsonwebtoken');

// JWT_SECRET must be set in environment - no fallback for security
if (!process.env.JWT_SECRET) {
  console.error('FATAL: JWT_SECRET environment variable is not set. Server cannot start securely.');
  process.exit(1);
}
const JWT_SECRET = process.env.JWT_SECRET;

// Middleware to verify JWT token
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      console.log(`🔐 Auth failed for ${req.path}: ${err.message}`);
      return res.status(403).json({ error: 'Invalid or expired token' });
    }
    req.user = user;
    next();
  });
}

// Middleware to check if user is admin
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

// Generate JWT token for a user
function generateToken(user, expiresIn = '7d') {
  return jwt.sign(
    {
      id: user.id,           // Use 'id' so req.user.id works in routes
      userId: user.id,       // Keep for backwards compatibility
      username: user.username,
      role: user.role,
      email: user.email,
      emailVerified: user.email_verified
    },
    JWT_SECRET,
    { expiresIn }
  );
}

module.exports = {
  authenticateToken,
  requireAdmin,
  generateToken,
  JWT_SECRET
};
