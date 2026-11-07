// HTTP API for the website: GET /api/scan?ca=<mint>, GET /health
import http from 'node:http';
import { cfg } from './config.js';
import { scan } from './scan.js';
import { log } from './util.js';

const hits = new Map();
function allowIp(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter(t => now - t < 60e3);
  if (list.length >= cfg.limits.apiPerIpPerMinute) { hits.set(ip, list); return false; }
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 50000) hits.clear();
  return true;
}

function corsHeaders(origin) {
  if (!cfg.allowedOrigins.length) return { 'access-control-allow-origin': '*' };
  if (origin && cfg.allowedOrigins.includes(origin)) return { 'access-control-allow-origin': origin, vary: 'Origin' };
  return {};
}

export function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const cors = corsHeaders(req.headers.origin);
    const send = (status, obj, extra = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...cors, ...extra });
      res.end(JSON.stringify(obj));
    };
    if (req.method === 'OPTIONS') { res.writeHead(204, { ...cors, 'access-control-allow-methods': 'GET, OPTIONS', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '86400' }); return res.end(); }
    if (url.pathname === '/health') return send(200, { ok: true });
    if (url.pathname !== '/api/scan' || req.method !== 'GET') return send(404, { error: 'not_found' });

    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    if (!allowIp(ip)) return send(429, { error: 'rate_limited', message: 'Too many scans. Wait a minute and try again.' }, { 'retry-after': '60' });
    const mint = (url.searchParams.get('ca') || '').trim();
    try {
      const result = await scan(mint);
      send(200, result);
    } catch (e) {
      const map = { invalid: 400, not_mint: 422, rpc: 503 };
      if (!map[e.code]) log('scan error', e.message);
      send(map[e.code] || 500, { error: e.code || 'error', message: e.code ? e.message : 'Scan failed. Try again shortly.' });
    }
  });
}

export function startServer() {
  const server = createServer();
  server.listen(cfg.port, () => log(`API listening on :${cfg.port}`));
  return server;
}
