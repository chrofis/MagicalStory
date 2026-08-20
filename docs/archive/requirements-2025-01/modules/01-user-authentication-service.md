# Module Requirements Specification: User Authentication Service

**Module ID:** MS-AUTH-001
**Version:** 1.0
**Last Updated:** 2025-01-26
**Owner:** Backend Team
**Status:** Draft

---

## 1. Module Overview

### 1.1 Purpose
The User Authentication Service manages user registration, login, session management, and authorization for the Magical Story platform across all client applications (web, iOS, Android, admin portal).

### 1.2 Scope
This module handles:
- User registration and onboarding
- Multi-factor authentication
- Session management and token refresh
- Password management (reset, change)
- Social authentication (Google, Apple, Facebook)
- Role-based access control (RBAC)
- Account deletion and GDPR compliance

### 1.3 Dependencies
- **Upstream Dependencies:** None (foundational service)
- **Downstream Dependencies:**
  - Story Configuration Service
  - Payment Service
  - Notification Service
  - Logging Service

### 1.4 Technology Stack
- **Language:** TypeScript (Node.js 20)
- **Framework:** Express.js 4.18
- **Database:** PostgreSQL 15
- **Cache:** Redis 7.2
- **Libraries:**
  - `jsonwebtoken` (JWT generation/validation)
  - `bcrypt` (password hashing)
  - `passport` (authentication strategies)
  - `express-rate-limit` (rate limiting)
  - `validator` (input validation)

---

## 2. Functional Requirements

### 2.1 User Registration

#### FR-AUTH-001: Email Registration
**Priority:** MUST HAVE
**Description:** Users can register using email and password.

**Acceptance Criteria:**
- User provides email, password, full name, date of birth
- Email validation (RFC 5322 compliant)
- Password requirements:
  - Minimum 8 characters
  - At least 1 uppercase letter
  - At least 1 lowercase letter
  - At least 1 number
  - At least 1 special character
- Password strength meter displayed
- Duplicate email check
- Age verification (minimum 13 years or parental consent)
- Terms of service acceptance required
- Verification email sent immediately
- Account in "unverified" state until email confirmed

**API Endpoint:**
```typescript
POST /api/v1/auth/register
Request Body:
{
  email: string,
  password: string,
  fullName: string,
  dateOfBirth: string, // ISO 8601 format
  acceptedTerms: boolean,
  parentalConsent?: boolean // Required if under 13
}

Response (201 Created):
{
  userId: string,
  email: string,
  emailVerificationSent: boolean,
  message: "Registration successful. Please verify your email."
}

Errors:
400 Bad Request - Validation errors
409 Conflict - Email already exists
429 Too Many Requests - Rate limit exceeded
```

#### FR-AUTH-002: Email Verification
**Priority:** MUST HAVE
**Description:** Users must verify their email address before full account access.

**Acceptance Criteria:**
- Verification email contains unique token (valid for 24 hours)
- Token is single-use
- Clicking link verifies email
- Resend verification option available (max 3 times per hour)
- Unverified accounts deleted after 7 days

**API Endpoint:**
```typescript
GET /api/v1/auth/verify-email?token={token}
Response (200 OK):
{
  verified: boolean,
  message: "Email verified successfully",
  redirectUrl: "/login"
}

POST /api/v1/auth/resend-verification
Request Body: { email: string }
Response (200 OK):
{
  sent: boolean,
  message: "Verification email resent"
}
```

#### FR-AUTH-003: Social Authentication
**Priority:** SHOULD HAVE (Phase 2)
**Description:** Users can register/login using social providers.

**Acceptance Criteria:**
- Support Google OAuth 2.0
- Support Apple Sign In
- Support Facebook Login
- Auto-link accounts by email
- Fetch profile photo from provider
- Handle provider errors gracefully

**API Endpoints:**
```typescript
GET /api/v1/auth/google
GET /api/v1/auth/google/callback

GET /api/v1/auth/apple
POST /api/v1/auth/apple/callback

GET /api/v1/auth/facebook
GET /api/v1/auth/facebook/callback
```

### 2.2 User Login

#### FR-AUTH-004: Email/Password Login
**Priority:** MUST HAVE
**Description:** Users can log in with email and password.

**Acceptance Criteria:**
- Email and password validation
- Account locked after 5 failed attempts (15 minutes)
- Return access token (JWT) and refresh token
- Token expiry: Access token 15 minutes, refresh token 30 days
- Log all login attempts (IP, timestamp, user agent)
- Support "remember me" option (extends refresh token to 90 days)

**API Endpoint:**
```typescript
POST /api/v1/auth/login
Request Body:
{
  email: string,
  password: string,
  rememberMe?: boolean
}

Response (200 OK):
{
  accessToken: string, // JWT
  refreshToken: string,
  expiresIn: number, // seconds
  user: {
    id: string,
    email: string,
    fullName: string,
    role: string,
    subscriptionTier: string,
    emailVerified: boolean
  }
}

Errors:
401 Unauthorized - Invalid credentials
403 Forbidden - Account locked or unverified
429 Too Many Requests - Rate limit
```

#### FR-AUTH-005: Token Refresh
**Priority:** MUST HAVE
**Description:** Refresh expired access tokens using refresh token.

**Acceptance Criteria:**
- Validate refresh token
- Issue new access token
- Optionally rotate refresh token
- Invalidate old refresh token after use
- Support token family tracking (detect token reuse attacks)

**API Endpoint:**
```typescript
POST /api/v1/auth/refresh
Request Body:
{
  refreshToken: string
}

Response (200 OK):
{
  accessToken: string,
  expiresIn: number
}

Errors:
401 Unauthorized - Invalid or expired refresh token
```

#### FR-AUTH-006: Logout
**Priority:** MUST HAVE
**Description:** Users can logout from current session or all sessions.

**Acceptance Criteria:**
- Invalidate current refresh token
- Option to logout from all devices
- Clear server-side session
- Redis token blacklist for immediate invalidation

**API Endpoints:**
```typescript
POST /api/v1/auth/logout
Headers: { Authorization: "Bearer {accessToken}" }
Response (200 OK):
{
  message: "Logged out successfully"
}

POST /api/v1/auth/logout-all
Headers: { Authorization: "Bearer {accessToken}" }
Response (200 OK):
{
  message: "Logged out from all devices"
}
```

### 2.3 Password Management

#### FR-AUTH-007: Forgot Password
**Priority:** MUST HAVE
**Description:** Users can reset forgotten passwords via email.

**Acceptance Criteria:**
- User provides email
- Reset token sent to email (valid for 1 hour)
- Token is single-use
- Rate limit: 3 requests per hour per email
- No user enumeration (same response for existing/non-existing emails)

**API Endpoint:**
```typescript
POST /api/v1/auth/forgot-password
Request Body:
{
  email: string
}

Response (200 OK):
{
  message: "If the email exists, a reset link has been sent"
}
```

#### FR-AUTH-008: Reset Password
**Priority:** MUST HAVE
**Description:** Users can set new password using reset token.

**Acceptance Criteria:**
- Validate reset token
- New password meets strength requirements
- Invalidate all existing sessions
- Send confirmation email

**API Endpoint:**
```typescript
POST /api/v1/auth/reset-password
Request Body:
{
  token: string,
  newPassword: string
}

Response (200 OK):
{
  message: "Password reset successful"
}

Errors:
400 Bad Request - Invalid or expired token
```

#### FR-AUTH-009: Change Password
**Priority:** MUST HAVE
**Description:** Authenticated users can change their password.

**Acceptance Criteria:**
- Require current password
- Validate new password strength
- Logout from other devices
- Send security notification email

**API Endpoint:**
```typescript
PUT /api/v1/auth/change-password
Headers: { Authorization: "Bearer {accessToken}" }
Request Body:
{
  currentPassword: string,
  newPassword: string
}

Response (200 OK):
{
  message: "Password changed successfully"
}

Errors:
401 Unauthorized - Current password incorrect
```

### 2.4 Profile Management

#### FR-AUTH-010: Get User Profile
**Priority:** MUST HAVE
**Description:** Retrieve authenticated user's profile information.

**API Endpoint:**
```typescript
GET /api/v1/users/profile
Headers: { Authorization: "Bearer {accessToken}" }

Response (200 OK):
{
  id: string,
  email: string,
  fullName: string,
  dateOfBirth: string,
  role: string,
  subscriptionTier: string,
  emailVerified: boolean,
  createdAt: string,
  lastLogin: string,
  preferences: {
    language: string,
    notifications: boolean
  }
}
```

#### FR-AUTH-011: Update User Profile
**Priority:** MUST HAVE
**Description:** Users can update their profile information.

**Acceptance Criteria:**
- Allow updating: fullName, dateOfBirth, preferences
- Email change requires re-verification
- Validate all inputs
- Log profile changes

**API Endpoint:**
```typescript
PUT /api/v1/users/profile
Headers: { Authorization: "Bearer {accessToken}" }
Request Body:
{
  fullName?: string,
  preferences?: {
    language?: string,
    notifications?: boolean
  }
}

Response (200 OK):
{
  message: "Profile updated successfully",
  user: { /* updated user object */ }
}
```

#### FR-AUTH-012: Delete Account
**Priority:** MUST HAVE (GDPR Compliance)
**Description:** Users can permanently delete their account.

**Acceptance Criteria:**
- Require password confirmation
- Immediate account deactivation
- 30-day grace period before permanent deletion
- Delete all personal data (GDPR Right to Erasure)
- Anonymize non-deletable data (orders, transactions)
- Send confirmation email
- Option to cancel deletion within grace period

**API Endpoint:**
```typescript
DELETE /api/v1/users/account
Headers: { Authorization: "Bearer {accessToken}" }
Request Body:
{
  password: string,
  confirmation: "DELETE MY ACCOUNT"
}

Response (200 OK):
{
  message: "Account scheduled for deletion",
  deletionDate: string // ISO 8601
}
```

### 2.5 Multi-Factor Authentication (MFA)

#### FR-AUTH-013: Enable MFA
**Priority:** SHOULD HAVE (Phase 2)
**Description:** Users can enable TOTP-based MFA.

**Acceptance Criteria:**
- Generate QR code for authenticator app
- Require verification code to confirm setup
- Provide backup codes (10 single-use codes)
- Store hashed secrets

**API Endpoints:**
```typescript
POST /api/v1/auth/mfa/setup
Headers: { Authorization: "Bearer {accessToken}" }
Response (200 OK):
{
  qrCode: string, // base64 encoded
  secret: string, // for manual entry
  backupCodes: string[]
}

POST /api/v1/auth/mfa/verify
Request Body:
{
  code: string
}
Response (200 OK):
{
  enabled: boolean
}
```

#### FR-AUTH-014: MFA Login
**Priority:** SHOULD HAVE (Phase 2)
**Description:** Users with MFA enabled must provide 2FA code at login.

**API Endpoint:**
```typescript
POST /api/v1/auth/login/mfa
Request Body:
{
  userId: string, // from initial login attempt
  code: string
}

Response (200 OK):
{
  accessToken: string,
  refreshToken: string,
  /* ... */
}
```

### 2.6 Authorization

#### FR-AUTH-015: Role-Based Access Control
**Priority:** MUST HAVE
**Description:** Implement RBAC for feature access.

**Roles:**
- `user` - Standard user (free tier)
- `premium_user` - Paid subscription user
- `moderator` - Content moderator
- `admin` - Platform administrator

**Permissions Matrix:**
| Feature | User | Premium | Moderator | Admin |
|---------|------|---------|-----------|-------|
| Create Stories | ✓ (5/month) | ✓ (unlimited) | ✓ | ✓ |
| Generate Images | ✗ | ✓ | ✓ | ✓ |
| Print Orders | ✓ | ✓ | ✓ | ✓ |
| Review Content | ✗ | ✗ | ✓ | ✓ |
| Admin Portal | ✗ | ✗ | ✓ | ✓ |
| User Management | ✗ | ✗ | ✗ | ✓ |

**Implementation:**
- Middleware: `requireAuth()`, `requireRole(role)`, `requirePermission(permission)`
- JWT claims include `role` and `permissions` array

---

## 3. Non-Functional Requirements

### 3.1 Performance

#### NFR-AUTH-001: Response Time
- 95th percentile: < 100ms for authentication operations
- 99th percentile: < 200ms
- Database query time: < 50ms

#### NFR-AUTH-002: Throughput
- Support 10,000 login requests per minute
- Support 1,000 registration requests per minute
- Token refresh: 50,000 requests per minute

### 3.2 Security

#### NFR-AUTH-003: Password Storage
- Use bcrypt with work factor 12 (minimum)
- Never store plaintext passwords
- Never log passwords (even hashed)

#### NFR-AUTH-004: Token Security
- JWT signed with RS256 (asymmetric)
- Private key stored in AWS Secrets Manager
- Rotate signing keys every 90 days
- Token payload includes: userId, email, role, iat, exp, jti

#### NFR-AUTH-005: Rate Limiting
- Login attempts: 5 per 15 minutes per IP
- Registration: 3 per hour per IP
- Password reset: 3 per hour per email
- Email verification resend: 3 per hour per email

#### NFR-AUTH-006: Input Validation
- Sanitize all inputs against XSS
- Validate email format (regex + DNS check)
- Parameterized queries (prevent SQL injection)
- Content Security Policy headers

### 3.3 Availability

#### NFR-AUTH-007: Uptime
- 99.95% uptime (4.38 hours downtime/year)
- Automated health checks every 30 seconds
- Failover to standby instance < 30 seconds

### 3.4 Scalability

#### NFR-AUTH-008: Horizontal Scaling
- Stateless service design
- Support 3-10 replicas
- Load balanced (round-robin)
- Session data in Redis (not in-memory)

### 3.5 Monitoring

#### NFR-AUTH-009: Logging
- Log all authentication events (login, logout, failed attempts)
- PII redaction in logs
- Structured logging (JSON format)
- Correlation IDs for request tracing

#### NFR-AUTH-010: Metrics
- Track: login success rate, failed login rate, registration rate
- Alert on: high failure rate (>5%), account lockout rate, unusual traffic patterns

### 3.6 Compliance

#### NFR-AUTH-011: GDPR
- Data portability (export user data)
- Right to erasure (account deletion)
- Consent management
- Data processing agreements

#### NFR-AUTH-012: COPPA
- Age gate (minimum 13 years)
- Parental consent mechanism for users under 13
- Parental email verification

---

## 4. Data Models

### 4.1 Users Table
```sql
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) UNIQUE NOT NULL,
  email_verified BOOLEAN DEFAULT FALSE,
  password_hash VARCHAR(255) NOT NULL,
  full_name VARCHAR(255) NOT NULL,
  date_of_birth DATE NOT NULL,
  role VARCHAR(50) DEFAULT 'user' NOT NULL,
  subscription_tier VARCHAR(50) DEFAULT 'free' NOT NULL,
  mfa_enabled BOOLEAN DEFAULT FALSE,
  mfa_secret VARCHAR(255),
  backup_codes TEXT[],
  account_locked BOOLEAN DEFAULT FALSE,
  locked_until TIMESTAMP,
  failed_login_attempts INTEGER DEFAULT 0,
  last_login TIMESTAMP,
  deletion_scheduled_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),

  CONSTRAINT valid_role CHECK (role IN ('user', 'premium_user', 'moderator', 'admin')),
  CONSTRAINT valid_tier CHECK (subscription_tier IN ('free', 'basic', 'premium', 'enterprise'))
);

CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_role ON users(role);
CREATE INDEX idx_users_deletion ON users(deletion_scheduled_at) WHERE deletion_scheduled_at IS NOT NULL;
```

### 4.2 User Sessions Table
```sql
CREATE TABLE user_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_token_hash VARCHAR(255) UNIQUE NOT NULL,
  token_family UUID NOT NULL, -- for token rotation tracking
  device_info JSONB, -- { type, os, browser, ip }
  expires_at TIMESTAMP NOT NULL,
  revoked BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW(),

  CONSTRAINT valid_expiry CHECK (expires_at > created_at)
);

CREATE INDEX idx_sessions_user ON user_sessions(user_id);
CREATE INDEX idx_sessions_token ON user_sessions(refresh_token_hash);
CREATE INDEX idx_sessions_expiry ON user_sessions(expires_at);
CREATE INDEX idx_sessions_family ON user_sessions(token_family);
```

### 4.3 Password Reset Tokens Table
```sql
CREATE TABLE password_reset_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash VARCHAR(255) UNIQUE NOT NULL,
  used BOOLEAN DEFAULT FALSE,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),

  CONSTRAINT valid_expiry CHECK (expires_at > created_at)
);

CREATE INDEX idx_reset_tokens_user ON password_reset_tokens(user_id);
CREATE INDEX idx_reset_tokens_hash ON password_reset_tokens(token_hash);
```

### 4.4 Email Verification Tokens Table
```sql
CREATE TABLE email_verification_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash VARCHAR(255) UNIQUE NOT NULL,
  used BOOLEAN DEFAULT FALSE,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_verification_tokens_user ON email_verification_tokens(user_id);
CREATE INDEX idx_verification_tokens_hash ON email_verification_tokens(token_hash);
```

### 4.5 Social Accounts Table
```sql
CREATE TABLE social_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider VARCHAR(50) NOT NULL, -- 'google', 'apple', 'facebook'
  provider_user_id VARCHAR(255) NOT NULL,
  access_token TEXT,
  refresh_token TEXT,
  token_expires_at TIMESTAMP,
  profile_data JSONB, -- name, email, photo, etc.
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),

  UNIQUE(provider, provider_user_id)
);

CREATE INDEX idx_social_accounts_user ON social_accounts(user_id);
CREATE INDEX idx_social_accounts_provider ON social_accounts(provider, provider_user_id);
```

### 4.6 Audit Log Table
```sql
CREATE TABLE auth_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  email VARCHAR(255),
  event_type VARCHAR(100) NOT NULL, -- 'login', 'logout', 'failed_login', 'registration', etc.
  ip_address INET,
  user_agent TEXT,
  success BOOLEAN NOT NULL,
  error_message TEXT,
  metadata JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_audit_user ON auth_audit_log(user_id);
CREATE INDEX idx_audit_event ON auth_audit_log(event_type);
CREATE INDEX idx_audit_created ON auth_audit_log(created_at);
```

---

## 5. API Specification

See comprehensive API documentation in `/requirements/api-specs/authentication-api.yaml` (OpenAPI 3.1 format)

---

## 6. Testing Requirements

### 6.1 Unit Tests
- Password hashing and validation
- JWT generation and validation
- Token expiry logic
- Input validation functions
- Role-based access control checks

**Coverage Target:** 90%

### 6.2 Integration Tests
- Full registration flow
- Login flow with valid/invalid credentials
- Token refresh cycle
- Password reset flow
- Account deletion flow
- Social authentication flow

**Coverage Target:** 80%

### 6.3 Security Tests
- SQL injection attempts
- XSS attacks
- CSRF protection
- Rate limiting enforcement
- Token reuse detection
- Brute force attack simulation

### 6.4 Load Tests
- 10,000 concurrent login requests
- Token refresh under load
- Database connection pool saturation

---

## 7. Deployment

### 7.1 Environment Variables
```bash
# Database
DATABASE_URL=postgresql://user:pass@host:5432/dbname
REDIS_URL=redis://host:6379

# JWT
JWT_PRIVATE_KEY_PATH=/secrets/jwt-private-key.pem
JWT_PUBLIC_KEY_PATH=/secrets/jwt-public-key.pem
JWT_ACCESS_TOKEN_EXPIRY=15m
JWT_REFRESH_TOKEN_EXPIRY=30d

# Secrets
PASSWORD_RESET_SECRET=xxx
EMAIL_VERIFICATION_SECRET=xxx

# External Services
SENDGRID_API_KEY=xxx
GOOGLE_OAUTH_CLIENT_ID=xxx
GOOGLE_OAUTH_CLIENT_SECRET=xxx
APPLE_SIGN_IN_KEY=xxx
FACEBOOK_APP_ID=xxx
FACEBOOK_APP_SECRET=xxx

# Security
BCRYPT_ROUNDS=12
RATE_LIMIT_WINDOW_MS=900000
RATE_LIMIT_MAX_REQUESTS=5

# Application
NODE_ENV=production
PORT=3000
LOG_LEVEL=info
CORS_ORIGIN=https://magicalstory.com
```

### 7.2 Kubernetes Configuration
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: auth-service
spec:
  replicas: 3
  selector:
    matchLabels:
      app: auth-service
  template:
    metadata:
      labels:
        app: auth-service
    spec:
      containers:
      - name: auth-service
        image: magicalstory/auth-service:latest
        ports:
        - containerPort: 3000
        env:
        - name: DATABASE_URL
          valueFrom:
            secretKeyRef:
              name: db-credentials
              key: url
        resources:
          requests:
            memory: "256Mi"
            cpu: "250m"
          limits:
            memory: "512Mi"
            cpu: "500m"
        livenessProbe:
          httpGet:
            path: /health
            port: 3000
          initialDelaySeconds: 30
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /ready
            port: 3000
          initialDelaySeconds: 10
          periodSeconds: 5
```

---

## 8. Migration Strategy

### 8.1 Phase 1: MVP
- Basic email/password authentication
- JWT tokens
- Password reset

### 8.2 Phase 2: Enhanced Security
- MFA support
- Social authentication
- Enhanced rate limiting

### 8.3 Phase 3: Scale
- Token rotation
- Geographic distribution
- Advanced monitoring

---

## 9. Risks & Mitigations

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| Account takeover | High | Medium | MFA, rate limiting, account lockout |
| Token theft | High | Medium | Short-lived tokens, secure storage, HTTPS only |
| Password database breach | Critical | Low | Bcrypt hashing, encryption at rest, regular audits |
| DDoS on login endpoint | High | Medium | Rate limiting, CAPTCHA, CDN protection |
| Social provider outage | Medium | Medium | Fallback to email/password, status page |

---

## 10. Success Metrics

- Registration completion rate > 80%
- Login success rate > 98%
- Average login time < 1 second
- Account lockout rate < 0.5%
- Zero password breaches
- Zero successful account takeovers

---

## 11. Appendix

### 11.1 JWT Payload Structure
```json
{
  "sub": "user-uuid",
  "email": "user@example.com",
  "role": "premium_user",
  "permissions": ["create_story", "generate_images"],
  "tier": "premium",
  "iat": 1640000000,
  "exp": 1640000900,
  "jti": "token-unique-id"
}
```

### 11.2 Error Response Format
```json
{
  "error": {
    "code": "INVALID_CREDENTIALS",
    "message": "Invalid email or password",
    "details": {},
    "timestamp": "2025-01-26T10:00:00Z",
    "requestId": "req-12345"
  }
}
```

---

**Document Control**

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | 2025-01-26 | Backend Team | Initial specification |
