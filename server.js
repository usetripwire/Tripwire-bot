// HTTP API for the website.
//   GET  /health
//   GET  /api/scan?ca=<mint>
//   GET  /api/radar/feed            (Authorization: Bearer <session> for holders)
//   GET  /api/radar/nonce?wallet=<address>
//   POST /api/radar/session         { wallet, nonce, signature }
import http from 'node:http';
import { cfg } from './config.js';
import { scan } from './scan.js';
import { feed, radarInfo } from './radar.js';
import { issueNonce, createSession, readSession, holderStatus } from './auth.js';
import { log } from './util.js';

const buckets = new Map();
function allow(ip, bucket, perMinute) {
  const key = bucket + ':' + ip;
  const now = Date.now();
  const list = (buckets.get(key) || []).filter(t => now - t < 60e3);
  if (list.length >= perMinute) { buckets.set(key, list); return false; }
  list.push(now);
  buckets.set(key, list);
  if (buckets.size > 100000) buckets.clear();
  return true;
}

function corsHeaders(origin) {
  if (!cfg.allowedOrigins.length) return { 'access-control-allow-origin': '*' };
  if (origin && cfg.allowedOrigins.includes(origin)) return { 'access-control-allow-origin': origin, vary: 'Origin' };
  return {};
}

function readJson(req, limit = 8192) {
  return new Promise((resolve, reject) => {
    let size = 0, data = '';
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('too_large')); req.destroy(); } else data += c; });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { reject(new Error('bad_json')); } });
    req.on('error', reject);
  });
}

const ERR = { invalid: 400, not_mint: 422, rpc: 503, expired: 401, bad_signature: 401 };

export function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const cors = corsHeaders(req.headers.origin);
    const send = (status, obj, extra = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...cors, ...extra });
      res.end(JSON.stringify(obj));
    };
    const fail = e => {
      if (!ERR[e.code]) log('api error', url.pathname, e.message);
      send(ERR[e.code] || 500, { error: e.code || 'error', message: e.code ? e.message : 'Something went wrong. Try again shortly.' });
    };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { ...cors, 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type, authorization', 'access-control-max-age': '86400' });
      return res.end();
    }
    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    const limited = () => send(429, { error: 'rate_limited', message: 'Too many requests. Wait a minute and try again.' }, { 'retry-after': '60' });

    try {
      if (url.pathname === '/health') return send(200, { ok: true });

      if (url.pathname === '/api/scan' && req.method === 'GET') {
        if (!allow(ip, 'scan', cfg.limits.apiPerIpPerMinute)) return limited();
        return send(200, await scan((url.searchParams.get('ca') || '').trim()));
      }

      if (url.pathname === '/api/radar/feed' && req.method === 'GET') {
        if (!allow(ip, 'feed', cfg.limits.feedPerIpPerMinute)) return limited();
        const session = readSession(req.headers.authorization);
        const status = session ? await holderStatus(session.wallet) : { holder: false };
        return send(200, { ...feed(status), gate: { ...radarInfo(), ...status, signedIn: !!session } });
      }

      if (url.pathname === '/api/radar/nonce' && req.method === 'GET') {
        if (!allow(ip, 'auth', 10)) return limited();
        return send(200, issueNonce((url.searchParams.get('wallet') || '').trim()));
      }

      if (url.pathname === '/api/radar/session' && req.method === 'POST') {
        if (!allow(ip, 'auth', 10)) return limited();
        const body = await readJson(req).catch(() => ({}));
        return send(200, await createSession(body));
      }

      return send(404, { error: 'not_found' });
    } catch (e) {
      return fail(e);
    }
  });
}

export function startServer() {
  const server = createServer();
  server.listen(cfg.port, () => log(`API listening on :${cfg.port}`));
  return server;
}
