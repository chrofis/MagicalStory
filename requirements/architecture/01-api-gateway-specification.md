# API Gateway Specification

**Document Version:** 1.0
**Last Updated:** 2025-01-26
**Status:** Draft

---

## 1. Overview

The API Gateway serves as the single entry point for all client requests. It handles authentication, rate limiting, request routing, and response transformation.

---

## 2. Technology

### AWS API Gateway + Lambda (Option 1)
- Serverless, auto-scaling
- Built-in features: auth, rate limiting, caching
- Pay-per-request pricing

### Kong (Option 2)
- Open-source, self-hosted
- Kubernetes-native
- Plugin ecosystem

### Recommended: Kong on Kubernetes
- More control, better for complex routing
- Cost-effective at scale
- Better monitoring and customization

---

## 3. Core Responsibilities

### 3.1 Request Routing
```yaml
Routes:
  /api/v1/auth/* → Authentication Service
  /api/v1/users/* → User Management Service
  /api/v1/characters/* → Story Configuration Service
  /api/v1/stories/* → AI Story Generation Service
  /api/v1/images/* → Image Generation Service
  /api/v1/payments/* → Payment Service
  /api/v1/subscriptions/* → Payment Service
  /api/v1/print/* → Print Integration Service
  /api/v1/reviews/* → Review Service
  /api/v1/admin/* → Admin Portal Service
```

### 3.2 Authentication
- Validate JWT tokens
- Extract user context (userId, role, tier)
- Inject headers for downstream services

**Implementation:**
```typescript
// Kong plugin: jwt-auth
{
  name: "jwt",
  config: {
    secret_is_base64: false,
    key_claim_name: "sub",
    header_names: ["Authorization"],
    claims_to_verify: ["exp", "iat"]
  }
}
```

### 3.3 Rate Limiting

**Per-User Tier:**
```yaml
Free Tier:
  - 100 requests per minute
  - 5,000 requests per day

Basic Tier:
  - 500 requests per minute
  - 50,000 requests per day

Premium Tier:
  - 2,000 requests per minute
  - Unlimited daily

Admin:
  - No limits
```

**Per-Endpoint:**
```yaml
/api/v1/stories/generate:
  - Free: 5 per day
  - Basic: 20 per day
  - Premium: Unlimited

/api/v1/images/generate:
  - Free: 0 (blocked)
  - Basic: 200 per day
  - Premium: Unlimited
```

**Implementation:**
```typescript
// Kong plugin: rate-limiting-advanced
{
  name: "rate-limiting-advanced",
  config: {
    limit: [100],
    window_size: [60],
    identifier: "consumer",
    sync_rate: -1
  }
}
```

### 3.4 Request/Response Transformation

**Add Headers to Requests:**
```typescript
X-User-Id: {userId}
X-User-Role: {role}
X-User-Tier: {tier}
X-Request-Id: {uuid}
X-Correlation-Id: {correlationId}
```

**Remove Sensitive Headers from Responses:**
```typescript
Remove:
  - X-Powered-By
  - Server
  - X-AspNet-Version
```

### 3.5 CORS Configuration
```yaml
Access-Control-Allow-Origin: https://magicalstory.com
Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS
Access-Control-Allow-Headers: Content-Type, Authorization
Access-Control-Max-Age: 86400
```

### 3.6 Request Logging
```json
{
  "timestamp": "2025-01-26T10:00:00Z",
  "requestId": "req-123",
  "method": "POST",
  "path": "/api/v1/stories/generate",
  "userId": "user-456",
  "userTier": "premium",
  "ip": "1.2.3.4",
  "userAgent": "Mozilla/5.0...",
  "statusCode": 200,
  "latencyMs": 150,
  "upstreamService": "story-generation",
  "upstreamLatencyMs": 120
}
```

---

## 4. Security Features

### 4.1 DDoS Protection
- Rate limiting (see above)
- IP blacklisting
- Geographic restrictions (if needed)

### 4.2 Input Validation
- JSON schema validation
- Max request size: 10MB
- Timeout: 30 seconds

### 4.3 TLS Termination
- TLS 1.3 only
- Strong cipher suites
- Certificate auto-renewal (Let's Encrypt)

### 4.4 WAF Integration
- OWASP Top 10 protection
- SQL injection prevention
- XSS prevention

---

## 5. Caching

### 5.1 Cache Strategy
```yaml
GET /api/v1/stories/:id:
  - Cache: 5 minutes
  - Key: story:{id}:{version}

GET /api/v1/characters/:id:
  - Cache: 10 minutes
  - Key: character:{id}:{version}

GET /api/v1/images/:id:
  - Cache: 1 hour (CDN handles this)
  - Key: image:{id}

POST /api/v1/*:
  - No cache
```

### 5.2 Cache Invalidation
```typescript
// On content update
DELETE cache:story:{id}:*
DELETE cache:character:{id}:*
```

---

## 6. Health Checks

### 6.1 Gateway Health
```
GET /health
Response: { status: "healthy", uptime: 12345, version: "1.0.0" }
```

### 6.2 Upstream Service Health
```
GET /health/services
Response: {
  auth: { status: "healthy", latency: 10 },
  stories: { status: "healthy", latency: 50 },
  images: { status: "degraded", latency: 200 },
  payments: { status: "healthy", latency: 30 }
}
```

---

## 7. Error Handling

### 7.1 Standard Error Response
```json
{
  "error": {
    "code": "RATE_LIMIT_EXCEEDED",
    "message": "Too many requests. Please try again in 60 seconds.",
    "details": {
      "limit": 100,
      "remaining": 0,
      "resetAt": "2025-01-26T10:01:00Z"
    },
    "timestamp": "2025-01-26T10:00:00Z",
    "requestId": "req-123"
  }
}
```

### 7.2 HTTP Status Codes
```
200 OK - Success
201 Created - Resource created
202 Accepted - Async operation started
400 Bad Request - Invalid input
401 Unauthorized - Missing/invalid auth
403 Forbidden - Insufficient permissions
404 Not Found - Resource doesn't exist
409 Conflict - Resource conflict
422 Unprocessable Entity - Validation failed
429 Too Many Requests - Rate limit exceeded
500 Internal Server Error - Server error
502 Bad Gateway - Upstream service error
503 Service Unavailable - Service down
504 Gateway Timeout - Upstream timeout
```

---

## 8. Monitoring & Metrics

### 8.1 Key Metrics
- Requests per second (total, per endpoint, per user)
- Latency (p50, p95, p99)
- Error rate (4xx, 5xx)
- Rate limit hits
- Cache hit rate
- Upstream service health

### 8.2 Dashboards
- Real-time request monitoring
- Error tracking
- Performance analytics
- User activity heatmap

### 8.3 Alerts
- Error rate > 5% for 5 minutes
- Latency p95 > 1 second
- Service health check failure
- Rate limit excessive hits (potential attack)

---

## 9. Deployment

### 9.1 Kubernetes Deployment
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-gateway
spec:
  replicas: 3
  selector:
    matchLabels:
      app: api-gateway
  template:
    metadata:
      labels:
        app: api-gateway
    spec:
      containers:
      - name: kong
        image: kong:3.4
        ports:
        - containerPort: 8000
        - containerPort: 8001
        env:
        - name: KONG_DATABASE
          value: "postgres"
        - name: KONG_PG_HOST
          value: "postgres-service"
        resources:
          requests:
            memory: "512Mi"
            cpu: "500m"
          limits:
            memory: "1Gi"
            cpu: "1000m"
```

### 9.2 Service
```yaml
apiVersion: v1
kind: Service
metadata:
  name: api-gateway
spec:
  type: LoadBalancer
  selector:
    app: api-gateway
  ports:
  - name: http
    port: 80
    targetPort: 8000
  - name: https
    port: 443
    targetPort: 8443
```

---

## 10. API Versioning

### 10.1 URI Versioning (Current)
```
/api/v1/stories/generate
/api/v2/stories/generate  # Future version
```

### 10.2 Version Support Policy
- v1: Supported indefinitely (current)
- v2: Supported when released
- Deprecation notice: 6 months before EOL
- Minimum 1-year support per version

---

## 11. Documentation

### 11.1 OpenAPI Specification
- Auto-generated from route definitions
- Interactive API docs (Swagger UI)
- Available at: https://api.magicalstory.com/docs

### 11.2 Rate Limit Headers
```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 95
X-RateLimit-Reset: 1640000000
```

---

## 12. Testing

### 12.1 Load Testing
```bash
# Using k6
k6 run --vus 100 --duration 5m load-test.js

# Expected results:
- 10,000 req/s sustained
- p95 latency < 200ms
- 0 errors
```

### 12.2 Security Testing
```bash
# Using OWASP ZAP
zap-cli quick-scan https://api.magicalstory.com

# Test cases:
- SQL injection attempts
- XSS attacks
- Authentication bypass
- Rate limit evasion
```

---

## 13. Success Criteria

- 99.99% uptime
- p95 latency < 150ms
- < 0.1% error rate
- Handle 10,000 requests per second
- Rate limiting: < 1% false positives

---

**Document Control**

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | 2025-01-26 | Infrastructure Team | Initial specification |
