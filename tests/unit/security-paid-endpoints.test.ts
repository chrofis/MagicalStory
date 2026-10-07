import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import http from 'node:http';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';

const nodeRequire = createRequire(import.meta.url);
const ROOT = path.resolve(__dirname, '../..');

// Security review 2026-10-07: two paid endpoints an outsider could drive for free.
//
// 1. POST /api/claude and /api/gemini forwarded the client's raw prompt /
//    max_tokens / contents to Sonnet and the Gemini image models for ANY
//    signed-in account, charging no credits. No client code calls them.
//    They are admin-only now.
// 2. POST /api/landmarks/discover is unauthenticated (the trial wizard fires it
//    before a session exists) and, for an un-indexed city, runs one
//    gemini-2.5-flash vision call per landmark (up to 30) in the background.
//    Only the global 100/min/IP limiter covered it. It has its own 10/h/IP store.

function post(port: number, p: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ port, path: p, method: 'POST', headers: { 'Content-Type': 'application/json', ...headers } }, (r) => {
      let body = '';
      r.on('data', (c) => { body += c; });
      r.on('end', () => resolve({ status: r.statusCode || 0, body }));
    });
    req.on('error', reject);
    req.end('{"city":"Baden","country":"Switzerland"}');
  });
}

describe('AI proxy routes are admin-only', () => {
  it('a plain user is refused before any provider call; an admin passes the gate', async () => {
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-security-test';
    const { generateToken } = nodeRequire('../../server/middleware/auth.js');
    // The route verifies the session against the DB; stub that one query.
    const database = nodeRequire('../../server/services/database.js');
    const roles: Record<string, string> = { 'u-1': 'user', 'a-1': 'admin' };
    database.getPool = () => ({
      query: async (_sql: string, params: any[]) => ({ rows: [{ token_version: 0, role: roles[params[0]] }] }),
    });
    database.logActivity = async () => {};
    const router = nodeRequire('../../server/routes/ai-proxy.js');
    const app = express();
    app.use(express.json());
    app.use('/api', router);
    // A provider call from the test would be a bug: make fetch explode loudly.
    const realFetch = globalThis.fetch;
    let providerCalls = 0;
    (globalThis as any).fetch = async () => { providerCalls++; return { ok: false, json: async () => ({ error: { message: 'stubbed' } }) }; };
    const server = app.listen(0);
    const port = (server.address() as any).port;
    try {
      const userTok = generateToken({ id: 'u-1', username: 'u', email: 'u@x', role: 'user', token_version: 0 });
      const adminTok = generateToken({ id: 'a-1', username: 'a', email: 'a@x', role: 'admin', token_version: 0 });
      for (const p of ['/api/claude', '/api/gemini']) {
        const anon = await post(port, p);
        expect(anon.status, `${p} anonymous`).toBe(401);
        const user = await post(port, p, { Authorization: `Bearer ${userTok}` });
        expect(user.status, `${p} plain user`).toBe(403);
      }
      expect(providerCalls).toBe(0);
      // An admin gets past the gate: the handler runs and reaches the (stubbed) provider.
      process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'sk-ant-test';
      const admin = await post(port, '/api/claude', { Authorization: `Bearer ${adminTok}` });
      expect(admin.status).not.toBe(401);
      expect(admin.status).not.toBe(403);
      expect(providerCalls).toBe(1);
    } finally {
      server.close();
      (globalThis as any).fetch = realFetch;
    }
  });
});

describe('POST /api/landmarks/discover has its own per-IP limiter', () => {
  it('server.js mounts landmarkDiscoverLimiter on the route', () => {
    const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    expect(src).toMatch(/app\.post\('\/api\/landmarks\/discover', landmarkDiscoverLimiter,/);
    expect(src).toMatch(/landmarkDiscoverLimiter \} = require\('\.\/server\/middleware\/rateLimit'\)/);
  });

  it('the 11th call from one address inside an hour is refused (429)', async () => {
    const { landmarkDiscoverLimiter } = nodeRequire('../../server/middleware/rateLimit.js');
    const app = express();
    app.use(express.json());
    app.post('/api/landmarks/discover', landmarkDiscoverLimiter, (_req, res) => res.json({ status: 'discovering' }));
    const server = app.listen(0);
    const port = (server.address() as any).port;
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 11; i++) statuses.push((await post(port, '/api/landmarks/discover')).status);
      expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);
      expect(statuses[10]).toBe(429);
    } finally {
      server.close();
    }
  });
});
