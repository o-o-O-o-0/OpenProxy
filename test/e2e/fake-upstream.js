/**
 * Fake upstream OpenAI-compatible server for stream-disconnect repro.
 *
 * Modes (selected via `?mode=...` on POST /v1/chat/completions):
 *   - normal      : send 5 deltas + finish_reason=stop + [DONE], close cleanly
 *   - mid-abort   : send 2 deltas, then destroy the socket abruptly
 *   - hang        : send 2 deltas, then keep the socket open forever (no [DONE])
 *   - slow-connect: never respond (test connect timeout)
 *   - http500     : respond 500 with JSON error body (no SSE)
 */

import http from 'node:http';

export function startFakeUpstream({ port = 0 } = {}) {
  const sockets = new Set();

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const mode = url.searchParams.get('mode') || 'normal';

    if (req.method !== 'POST') {
      res.statusCode = 404;
      res.end('not found');
      return;
    }

    // Drain body
    req.on('data', () => {});
    req.on('end', () => handle(mode, res));
  });

  server.on('connection', (sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
  });

  function handle(mode, res) {
    if (mode === 'http500') {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: { message: 'simulated upstream 500' } }));
      return;
    }

    if (mode === 'slow-connect') {
      // Never write headers, never end. The proxy's connect-timeout should fire.
      return;
    }

    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const sendDelta = (text) => {
      const payload = {
        id: 'chatcmpl-fake',
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
      };
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    if (mode === 'normal') {
      let i = 0;
      const ticks = ['Hello', ' from', ' fake', ' upstream', '!'];
      const timer = setInterval(() => {
        if (i < ticks.length) {
          sendDelta(ticks[i++]);
          return;
        }
        clearInterval(timer);
        res.write(`data: ${JSON.stringify({
          id: 'chatcmpl-fake',
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      }, 30);
      return;
    }

    if (mode === 'mid-abort') {
      sendDelta('partial');
      setTimeout(() => sendDelta(' more'), 20);
      // Destroy the underlying socket without an end event \u2014 simulates ECONNRESET.
      setTimeout(() => res.socket.destroy(), 60);
      return;
    }

    if (mode === 'hang') {
      sendDelta('partial');
      setTimeout(() => sendDelta(' more'), 20);
      // Then never close. Upstream just stops sending, holding the socket open.
      return;
    }
  }

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const actualPort = server.address().port;
      resolve({
        port: actualPort,
        baseUrl: `http://127.0.0.1:${actualPort}`,
        close: () => new Promise((r) => {
          for (const sock of sockets) sock.destroy();
          server.close(() => r());
        }),
      });
    });
  });
}
