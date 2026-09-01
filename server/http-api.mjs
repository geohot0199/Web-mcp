/*
 * Orbit public HTTP API — exposes the studio's WebMCP tool surface to external
 * LLMs and agents over plain HTTP/JSON. Zero dependencies (Node >= 18 only).
 *
 * How it works
 * ------------
 * The 32 WebMCP tools run against the *live* scene, which only exists inside an
 * open studio tab (human approvals, permissions, locks and undo all live there).
 * This server therefore acts as a bridge:
 *
 *   your LLM ──HTTP──▶ this server ──long-poll──▶ open Orbit tab ──▶ tool result
 *
 *  - The studio page polls GET  /api/bridge/poll    (holds ~20 s, 204 = idle)
 *  - The studio page posts POST /api/bridge/result  with { id, ok, result|error }
 *  - Your LLM calls    GET  /api/webmcp/tools       → tool names + JSON schemas
 *                      POST /api/webmcp/call        → { tool, arguments } → result
 *                      POST /api/webmcp/route       → deterministic text → tool routing
 *                      GET  /api/webmcp/health      → bridge status
 *
 * Staged & approval-gated semantics are preserved: mutations still appear as
 * proposal cards in the studio and a human still approves them there.
 *
 * Env: PORT (default 8080) · ORBIT_API_KEY (optional Bearer token for /api/webmcp/*)
 */
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { routePrompt } from '../js/agent-router.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = Number(process.env.PORT || 8080);
const API_KEY = process.env.ORBIT_API_KEY || '';
const LONG_POLL_MS = 20_000; // below typical proxy read timeouts
const DEFAULT_CALL_TIMEOUT_MS = 50_000;
const MAX_CALL_TIMEOUT_MS = 115_000;
const MAX_BODY_BYTES = 256 * 1024;
const STUDIO_CONNECTED_WINDOW_MS = LONG_POLL_MS * 2.5;

/* ------------------------------------------------------------------ *
 *  Job queue: one pending FIFO, one waiter per tab, results by job id *
 * ------------------------------------------------------------------ */
const pendingJobs = []; // [{ id, tool, arguments, resolve, timer }]
const pollWaiters = []; // [{ clientId, res, timer }]
const inFlight = new Map(); // id -> { resolve, timer }
let activeClientId = null; // jobs are pinned to the most recently polling tab
let lastPollAt = null;
let callsServed = 0;

const now = () => Date.now();

function studioConnected() {
  return lastPollAt !== null && now() - lastPollAt <= STUDIO_CONNECTED_WINDOW_MS;
}

function enqueueToolJob(tool, args, timeoutMs) {
  return new Promise((resolvePromise) => {
    const job = {
      id: randomUUID(),
      tool,
      arguments: args || {},
      resolve: resolvePromise,
      timer: setTimeout(() => {
        removeJob(job);
        resolvePromise({ status: 504, body: { ok: false, error: 'timeout', message: `No studio result within ${timeoutMs} ms. Is an Orbit tab open and idle?` } });
      }, timeoutMs)
    };
    if (!studioConnected() && lastPollAt === null) {
      clearTimeout(job.timer);
      resolvePromise({
        status: 503,
        body: {
          ok: false,
          error: 'no_studio_connected',
          message: 'The tools execute inside a live Orbit studio tab. Open the app root URL in a browser, keep the tab open, then retry.'
        }
      });
      return;
    }
    pendingJobs.push(job);
    flushJobs();
  });
}

function removeJob(job) {
  const queued = pendingJobs.indexOf(job);
  if (queued !== -1) pendingJobs.splice(queued, 1);
  inFlight.delete(job.id);
}

function resolveJob(id, ok, payload) {
  const entry = inFlight.get(id);
  if (!entry) return false;
  clearTimeout(entry.timer);
  inFlight.delete(id);
  callsServed += 1;
  entry.resolve(
    ok
      ? { status: 200, body: { ok: true, tool: entry.tool, result: payload } }
      : { status: 502, body: { ok: false, tool: entry.tool, error: typeof payload === 'string' ? payload : 'tool_error', detail: payload } }
  );
  return true;
}

function flushJobs() {
  if (!pendingJobs.length || inFlight.size > 0) return; // serialize: one job in the tab at a time
  const waiterIndex = pollWaiters.findIndex((waiter) => waiter.clientId === activeClientId);
  if (waiterIndex === -1) return; // active tab isn't polling right now; next poll picks it up
  const [waiter] = pollWaiters.splice(waiterIndex, 1);
  clearTimeout(waiter.timer);
  const job = pendingJobs.shift();
  inFlight.set(job.id, { resolve: job.resolve, timer: job.timer, tool: job.tool });
  sendJson(waiter.res, 200, { id: job.id, tool: job.tool, arguments: job.arguments });
}

/* ----------------------------- helpers ----------------------------- */
function sendJson(res, status, body, extraHeaders = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    ...extraHeaders
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        rejectBody(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolveBody({});
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        rejectBody(new Error('Body must be valid JSON'));
      }
    });
    req.on('error', rejectBody);
  });
}

function authorised(req) {
  if (!API_KEY) return true;
  const header = req.headers.authorization || '';
  return header === `Bearer ${API_KEY}`;
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.md': 'text/markdown; charset=utf-8',
  '.stl': 'model/stl'
};

async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = normalize(join(ROOT, rel));
  if (!filePath.startsWith(ROOT)) {
    sendJson(res, 403, { ok: false, error: 'forbidden' });
    return;
  }
  try {
    const info = await stat(filePath);
    const target = info.isDirectory() ? join(filePath, 'index.html') : filePath;
    const content = await readFile(target);
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[extname(target).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(content);
  } catch {
    sendJson(res, 404, { ok: false, error: 'not_found', path: pathname });
  }
}

/* --------------------------- API endpoints -------------------------- */
function apiIndex() {
  return {
    ok: true,
    name: 'orbit-webmcp-http-api',
    description: 'Public HTTP access to Orbit\'s goal-oriented WebMCP tools. Tools execute inside the live studio tab, so human approval, permissions and undo stay in force.',
    endpoints: {
      'GET /api/webmcp/health': 'Bridge status (studio_connected, calls_served, pending_jobs).',
      'GET /api/webmcp/tools': 'Names, descriptions and JSON schemas of every WebMCP tool (server-proxied listTools).',
      'POST /api/webmcp/call': 'Body { tool, arguments?, timeout_ms? } → executes the tool in the open studio tab and returns its JSON result (incl. live_context).',
      'POST /api/webmcp/route': 'Body { text, context? } → deterministic intent routing { tool, parameters, requiresHumanApproval, sensitive }. Works without a connected tab.',
      'GET /api': 'This document.'
    },
    auth: API_KEY ? 'bearer' : 'none (set ORBIT_API_KEY to require a Bearer token)',
    example: 'curl -X POST "$BASE/api/webmcp/call" -H "Content-Type: application/json" -d \'{"tool":"get_scene"}\''
  };
}

async function handleApi(req, res, pathname, url) {
  if (req.method === 'OPTIONS') {
    sendJson(res, 204, null);
    return;
  }
  if (pathname === '/api' || pathname === '/api/') {
    sendJson(res, 200, apiIndex());
    return;
  }

  /* Studio tab side of the bridge (same-origin, no API key) */
  if (pathname === '/api/bridge/poll' && req.method === 'GET') {
    lastPollAt = now();
    activeClientId = url.searchParams.get('client') || 'anonymous';
    if (pendingJobs.length && inFlight.size === 0) {
      flushJobs();
      return;
    }
    const waiter = { clientId: activeClientId, res };
    pollWaiters.push(waiter);
    waiter.timer = setTimeout(() => {
      const index = pollWaiters.indexOf(waiter);
      if (index !== -1) pollWaiters.splice(index, 1);
      sendJson(res, 204, null);
    }, LONG_POLL_MS);
    return;
  }
  if (pathname === '/api/bridge/result' && req.method === 'POST') {
    lastPollAt = now();
    try {
      const body = await readBody(req);
      if (!body.id) {
        sendJson(res, 400, { ok: false, error: 'missing_job_id' });
        return;
      }
      const handled = resolveJob(body.id, Boolean(body.ok), body.ok ? body.result : (body.error ?? body.result));
      sendJson(res, handled ? 200 : 409, handled ? { ok: true } : { ok: false, error: 'unknown_or_expired_job_id' });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error.message });
    }
    return;
  }

  /* LLM-facing API */
  if (pathname.startsWith('/api/webmcp/')) {
    if (!authorised(req)) {
      sendJson(res, 401, { ok: false, error: 'unauthorised', message: 'Send Authorization: Bearer <ORBIT_API_KEY>.' });
      return;
    }
    if (pathname === '/api/webmcp/health') {
      sendJson(res, 200, {
        ok: true,
        studio_connected: studioConnected(),
        ever_connected: lastPollAt !== null,
        last_seen_ms_ago: lastPollAt === null ? null : now() - lastPollAt,
        pending_jobs: pendingJobs.length,
        in_flight: inFlight.size,
        calls_served: callsServed,
        auth: API_KEY ? 'bearer' : 'none'
      });
      return;
    }
    if (pathname === '/api/webmcp/tools' && req.method === 'GET') {
      const outcome = await enqueueToolJob('__describe_tools', {}, DEFAULT_CALL_TIMEOUT_MS);
      if (outcome.status === 200) {
        sendJson(res, 200, { ok: true, count: outcome.body.result.length, tools: outcome.body.result });
      } else {
        sendJson(res, outcome.status, outcome.body);
      }
      return;
    }
    if (pathname === '/api/webmcp/route') {
      let text = url.searchParams.get('text');
      let context = {};
      if (req.method === 'POST') {
        try {
          const body = await readBody(req);
          text = text ?? body.text ?? body.prompt;
          context = typeof body.context === 'object' && body.context ? body.context : {};
        } catch (error) {
          sendJson(res, 400, { ok: false, error: error.message });
          return;
        }
      }
      if (!text) {
        sendJson(res, 400, { ok: false, error: 'missing_text', message: 'Provide text as a query param or in the JSON body.' });
        return;
      }
      const routed = routePrompt(text, context);
      sendJson(res, 200, { ok: true, ...routed });
      return;
    }
    if (pathname === '/api/webmcp/call' && req.method === 'POST') {
      let body;
      try {
        body = await readBody(req);
      } catch (error) {
        sendJson(res, 400, { ok: false, error: error.message });
        return;
      }
      const tool = body.tool || body.name;
      const args = body.arguments ?? body.args ?? body.parameters ?? {};
      if (!tool || typeof tool !== 'string') {
        sendJson(res, 400, { ok: false, error: 'missing_tool', message: 'Body must include { "tool": "<name>", "arguments": {…} }.' });
        return;
      }
      const requestedTimeout = Number(body.timeout_ms);
      const timeoutMs = Number.isFinite(requestedTimeout)
        ? Math.min(Math.max(requestedTimeout, 5_000), MAX_CALL_TIMEOUT_MS)
        : DEFAULT_CALL_TIMEOUT_MS;
      const outcome = await enqueueToolJob(tool, args, timeoutMs);
      sendJson(res, outcome.status, {
        ...outcome.body,
        ...(outcome.status === 200 ? { note: noteForResult(outcome.body.result) } : {})
      });
      return;
    }
    sendJson(res, 404, { ok: false, error: 'not_found', message: 'Unknown API route.', see: '/api' });
    return;
  }

  sendJson(res, 404, { ok: false, error: 'not_found', path: pathname });
}

function noteForResult(result) {
  if (result && result.staged) {
    return 'This staged a proposal for the human. Mutations only apply after approval in the studio; poll apply_approved_proposal or watch get_history.';
  }
  if (result && result.success === false && result.message) return result.message;
  return undefined;
}

/* -------------------------------- server ---------------------------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://bridge.local');
  const pathname = url.pathname;
  try {
    if (pathname === '/api' || pathname.startsWith('/api/')) {
      await handleApi(req, res, pathname, url);
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
      return;
    }
    await serveStatic(req, res, pathname);
  } catch (error) {
    console.error('[http-api] unhandled error:', error);
    if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'internal_error' });
    else res.end();
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[http-api] Orbit public HTTP API + studio on http://0.0.0.0:${PORT}`);
  console.log(`[http-api] LLM endpoints: GET /api · GET /api/webmcp/health · GET /api/webmcp/tools · POST /api/webmcp/route · POST /api/webmcp/call`);
  if (API_KEY) console.log('[http-api] Bearer auth enabled for /api/webmcp/* (ORBIT_API_KEY set).');
});
