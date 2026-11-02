#!/usr/bin/env node
// R8. The bridge: local tools drive the browser through this loopback server.
// A service worker cannot listen on a port, so the extension is the client: it long-polls /next, runs the command
// and posts the result to /result. tools/ask.js posts commands to /ask.
//
// While this runs, any local process can drive your browser through it. Stop it when you are done.
import { appendFileSync, mkdirSync } from 'node:fs';
import http from 'node:http';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const DEFAULT_PORT = 8787;
const EXTENSION_HEADER = 'x-browser-tab-helper';
const ANSWER_TIMEOUT_MS = 95_000;
// The worker's alarm fires about every 30 s, and a fetch must answer inside the worker's 30 s event limit.
const POLL_HOLD_MS = 25_000;
const MAX_BODY_BYTES = 64 * 1024 * 1024;

export function defaultLogPath() {
  return join(homedir(), 'Library', 'Caches', 'browser-tab-helper', 'events.jsonl');
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((done, fail) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        fail(new Error('body too large'));
        req.destroy();
      } else {
        chunks.push(chunk);
      }
    });
    req.on('end', () => done(Buffer.concat(chunks).toString()));
    req.on('error', fail);
  });
}

/**
 * Loopback binding keeps other machines out, but a web page in your browser can still reach 127.0.0.1. So:
 * - the Host header must be loopback, which stops DNS rebinding;
 * - /ask refuses anything with an Origin header, which browsers set on a page's POST and local tools do not;
 * - the extension's endpoints need the EXTENSION_HEADER. Origin cannot do this job, since a page's plain GET
 *   (<img src=".../next">) sends none and would take a command. A page can only add a custom header after a CORS
 *   preflight, and this refuses preflights.
 */
function refusal(req, path, port) {
  const host = req.headers.host ?? '';
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return 'bad host';
  const { origin } = req.headers;
  if (path === '/ask') return origin ? 'browser origins may not send commands' : null;
  if (origin && !origin.startsWith('chrome-extension://')) return 'only the extension may use this';
  return req.headers[EXTENSION_HEADER] ? null : 'only the extension may use this';
}

export function createBridge({
  logPath = defaultLogPath(),
  answerTimeoutMs = ANSWER_TIMEOUT_MS,
  pollHoldMs = POLL_HOLD_MS,
} = {}) {
  const queue = [];
  const pollers = [];
  const waiting = new Map();
  let nextId = 1;
  let port = null;

  const deliver = (command) => {
    const poller = pollers.shift();
    if (!poller) {
      queue.push(command);
      return;
    }
    clearTimeout(poller.timer);
    json(poller.res, 200, command);
  };

  const handleAsk = (res, body) => {
    let command;
    try {
      command = JSON.parse(body);
    } catch {
      json(res, 400, { error: 'the command is not JSON' });
      return;
    }
    if (typeof command?.cmd !== 'string') {
      json(res, 400, { error: 'the command has no "cmd"' });
      return;
    }
    const id = nextId++;
    const timer = setTimeout(() => {
      waiting.delete(id);
      const at = queue.findIndex((queued) => queued.id === id);
      if (at >= 0) queue.splice(at, 1);
      json(res, 504, { error: `no answer in ${Math.round(answerTimeoutMs / 1000)} s. Is the bridge switched on in the list page?` });
    }, answerTimeoutMs);
    waiting.set(id, { res, timer });
    deliver({ ...command, id });
  };

  const handleNext = (req, res) => {
    const queued = queue.shift();
    if (queued) {
      json(res, 200, queued);
      return;
    }
    const poller = { res };
    poller.timer = setTimeout(() => {
      pollers.splice(pollers.indexOf(poller), 1);
      res.writeHead(204).end();
    }, pollHoldMs);
    pollers.push(poller);
    // A poller that went away must not be handed a command, which would be lost with it.
    res.on('close', () => {
      const at = pollers.indexOf(poller);
      if (at >= 0) {
        pollers.splice(at, 1);
        clearTimeout(poller.timer);
      }
    });
  };

  const handleResult = (res, body) => {
    const { id, result, error } = JSON.parse(body);
    const asker = waiting.get(id);
    if (asker) {
      waiting.delete(id);
      clearTimeout(asker.timer);
      json(asker.res, error === undefined ? 200 : 500, error === undefined ? { result } : { error });
    }
    json(res, 200, { ok: true });
  };

  const handleEvent = (res, body) => {
    const event = JSON.parse(body);
    mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 });
    appendFileSync(logPath, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`, { mode: 0o600 });
    json(res, 200, { ok: true });
  };

  const server = http.createServer(async (req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    const refused = refusal(req, path, port);
    if (refused) {
      json(res, 403, { error: refused });
      return;
    }
    try {
      if (req.method === 'GET' && path === '/next') handleNext(req, res);
      else if (req.method === 'POST' && path === '/ask') handleAsk(res, await readBody(req));
      else if (req.method === 'POST' && path === '/result') handleResult(res, await readBody(req));
      else if (req.method === 'POST' && path === '/event') handleEvent(res, await readBody(req));
      else json(res, 404, { error: 'not found' });
    } catch (error) {
      if (!res.headersSent) json(res, 400, { error: error.message });
    }
  });

  return {
    server,
    listen: (wanted = DEFAULT_PORT) => new Promise((done, fail) => {
      server.once('error', fail);
      server.listen(wanted, '127.0.0.1', () => {
        ({ port } = server.address());
        done(port);
      });
    }),
    close: () => new Promise((done) => {
      server.close(done);
      server.closeAllConnections();
    }),
  };
}

if (import.meta.main) {
  const wanted = Number(process.argv[2] ?? process.env.BRIDGE_PORT ?? DEFAULT_PORT);
  const bridge = createBridge();
  const port = await bridge.listen(wanted);
  console.log(`Bridge on http://127.0.0.1:${port}. Events go to ${defaultLogPath()}.`);
  console.log('While this runs, any local process can drive your browser. Stop it (Ctrl-C) when you are done.');
}
