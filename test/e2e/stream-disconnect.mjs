/**
 * E2E stream-disconnect repro.
 *
 * Boots a fake OpenAI-compatible upstream and a real OpenProxy server in
 * the same process, then exercises 4 scenarios while capturing stdout/stderr.
 * The captured proxy logs are then printed grouped per scenario so we can
 * verify the new logging shows the right `reason=` for each disconnect type.
 *
 * Run with:  node test/e2e/stream-disconnect.mjs
 */

import express from 'express';
import http from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { startFakeUpstream } from './fake-upstream.js';
import { createProxyServer } from '../../src/server.js';

// ---------- log capture ----------
const captured = [];
const realLog = console.log.bind(console);
const realErr = console.error.bind(console);
console.log = (...args) => captured.push(['log', Date.now(), args.join(' ')]);
console.error = (...args) => captured.push(['err', Date.now(), args.join(' ')]);

function takeLogsSince(t0) {
  return captured.filter(([, ts]) => ts >= t0).map(([k, ts, msg]) => `[${k}] +${ts - t0}ms ${msg}`);
}

// ---------- bring up servers ----------
process.env.DEBUG_STREAM = '1';

const upstream = await startFakeUpstream();
realLog(`fake upstream running at ${upstream.baseUrl}`);

const config = {
  proxy: { host: '127.0.0.1', port: 0, lanAccess: false, apiKey: 'test-key', timeout: 60000 },
  model: { available: [] },
  privacy: { enabled: false, redactAssistantMessages: false, redactToolResults: false, logHits: false },
  ui: { modelSource: 'opencode' },
  backend: {
    opencode: {
      // Will be replaced per-scenario via mode query string
      baseUrl: `${upstream.baseUrl}/v1/chat/completions`,
      upstreamApiKey: 'public',
    },
    custom: { baseUrl: '', apiKey: '', resolvedBaseUrl: '' },
  },
};

const app = express();
app.use(express.json({ limit: '64mb' }));
app.use('/v1', createProxyServer(config));

const proxyServer = await new Promise((resolve) => {
  const s = app.listen(0, '127.0.0.1', () => resolve(s));
});
const proxyPort = proxyServer.address().port;
realLog(`openproxy running at http://127.0.0.1:${proxyPort}`);

// ---------- helpers ----------
function setUpstreamMode(mode) {
  config.backend.opencode.baseUrl = `${upstream.baseUrl}/v1/chat/completions?mode=${mode}`;
}

/**
 * Issue a streaming chat request and return:
 *   { status, headers, chunks: string[], totalBytes, error }
 *
 * abortAfterChunks: if set, abort the client request after that many SSE chunks.
 */
function streamRequest({ abortAfterChunks = null, abortAfterMs = null } = {}) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      model: 'opencode/fake',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    });
    const req = http.request({
      host: '127.0.0.1',
      port: proxyPort,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer test-key',
        'Accept': 'text/event-stream',
        'Content-Length': Buffer.byteLength(body),
      },
    });

    let totalBytes = 0;
    const chunks = [];
    let aborted = false;

    const finish = (extra) => resolve({ totalBytes, chunks, aborted, ...extra });

    req.on('response', (res) => {
      const headers = res.headers;
      const status = res.statusCode;
      if (abortAfterMs) {
        setTimeout(() => {
          if (!res.complete) { aborted = true; req.destroy(new Error('client abort by time')); }
        }, abortAfterMs);
      }
      res.on('data', (buf) => {
        totalBytes += buf.byteLength;
        chunks.push(buf.toString('utf8'));
        if (abortAfterChunks !== null && chunks.length >= abortAfterChunks) {
          aborted = true;
          req.destroy(new Error('client abort by chunk count'));
        }
      });
      res.on('end', () => finish({ status, headers }));
      res.on('error', (err) => finish({ status, headers, error: err.message }));
    });
    req.on('error', (err) => finish({ error: err.message }));
    req.write(body);
    req.end();
  });
}

// ---------- scenarios ----------
async function runScenario(name, mode, fn) {
  realLog(`\n\n==========================================`);
  realLog(`SCENARIO: ${name}  (upstream mode: ${mode})`);
  realLog(`==========================================`);
  setUpstreamMode(mode);
  const t0 = Date.now();
  const result = await fn();
  // Wait briefly for any tail logs to flush.
  await sleep(150);
  const logs = takeLogsSince(t0);
  realLog(`-- client result --`);
  realLog(JSON.stringify({
    status: result.status,
    chunks: result.chunks.length,
    totalBytes: result.totalBytes,
    aborted: result.aborted,
    error: result.error,
    firstChunkPreview: result.chunks[0]?.slice(0, 80),
  }, null, 2));
  realLog(`-- proxy logs (${logs.length}) --`);
  for (const line of logs) realLog(line);
  return { name, result, logs };
}

const summary = [];

summary.push(await runScenario(
  'A. Normal completion',
  'normal',
  () => streamRequest()
));

summary.push(await runScenario(
  'B. Client disconnects mid-stream',
  'normal',
  () => streamRequest({ abortAfterChunks: 2 })
));

summary.push(await runScenario(
  'C. Upstream destroys socket mid-stream',
  'mid-abort',
  () => streamRequest()
));

summary.push(await runScenario(
  'D. Upstream returns HTTP 500 (no stream)',
  'http500',
  () => streamRequest()
));

summary.push(await runScenario(
  'E. Upstream hangs after 2 chunks; client times out',
  'hang',
  () => streamRequest({ abortAfterMs: 800 })
));

// Scenario F runs with a temporarily shrunk connect timeout to keep the test
// fast. The proxy's CONNECT_TIMEOUT_MS is exported so we can override it.
import { __setConnectTimeoutForTest } from '../../src/proxy/upstream.js';
__setConnectTimeoutForTest(500);
summary.push(await runScenario(
  'F. Upstream never responds; proxy connect-timeout fires (P0 verification)',
  'slow-connect',
  () => streamRequest()
));
__setConnectTimeoutForTest(60_000); // restore

// ---------- final summary ----------
realLog(`\n\n========== FINAL SUMMARY ==========`);
for (const s of summary) {
  const reasons = s.logs.filter((l) => l.includes('stream aborted') || l.includes('stream completed') || l.includes('upstream response status='));
  realLog(`\n# ${s.name}`);
  realLog(`  client: status=${s.result.status} chunks=${s.result.chunks.length} bytes=${s.result.totalBytes} aborted=${s.result.aborted} error=${s.result.error || ''}`);
  realLog(`  key proxy events:`);
  for (const r of reasons) realLog(`    ${r}`);
}

await upstream.close();
await new Promise((r) => proxyServer.close(r));
process.exit(0);
