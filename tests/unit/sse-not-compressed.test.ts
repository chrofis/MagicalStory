import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import http from 'node:http';
import express from 'express';

const nodeRequire = createRequire(import.meta.url);
const compression: any = nodeRequire('compression');
const { compressionFilter } = nodeRequire('../../server/lib/compressionFilter.js');

// Regression: gzip buffered the idea stream's small events until the response
// ended, so the browser saw nothing for 65-112 s and timed out (2026-10-05).
describe('SSE responses are not buffered by compression', () => {
  const app = express();
  app.use(compression({ filter: compressionFilter }));
  app.get('/sse', async (_req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.flushHeaders();
    res.write('data: {"status":"generating"}\n\n');
    await new Promise(r => setTimeout(r, 1500));
    res.write('data: {"done":true}\n\n');
    res.end();
  });
  app.get('/json', (_req, res) => res.json({ pad: 'x'.repeat(5000) }));

  const get = (port: number, path: string, onData: (s: string, t: number) => void) => new Promise<http.IncomingMessage>((resolve) => {
    const t0 = Date.now();
    http.get({ port, path, headers: { 'Accept-Encoding': 'gzip' } }, (r) => {
      r.on('data', (c) => onData(c.toString(), Date.now() - t0));
      r.on('end', () => resolve(r));
    });
  });

  it('delivers the first event before the stream ends, uncompressed', async () => {
    const server = app.listen(0);
    const port = (server.address() as any).port;
    let firstAt = -1; let first = '';
    const r = await get(port, '/sse', (s, t) => { if (firstAt < 0) { firstAt = t; first = s; } });
    server.close();
    expect(r.headers['content-encoding']).toBeUndefined();
    expect(first).toContain('generating');
    expect(firstAt).toBeLessThan(1000);
  });

  it('still gzips ordinary compressible responses', async () => {
    const server = app.listen(0);
    const port = (server.address() as any).port;
    const r = await get(port, '/json', () => {});
    server.close();
    expect(r.headers['content-encoding']).toBe('gzip');
  });
});
