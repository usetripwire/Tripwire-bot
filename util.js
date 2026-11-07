export const sleep = ms => new Promise(r => setTimeout(r, ms));

export const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const B58_GLOBAL = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;

// Run at most n async jobs at once.
export function createLimiter(n) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= n || !queue.length) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve().then(fn).then(resolve, reject).finally(() => { active--; next(); });
  };
  return fn => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); });
}

// Small in-memory cache with expiry and a size cap.
export class TTLCache {
  constructor(max = 1000, ttlMs = 600000) { this.max = max; this.ttl = ttlMs; this.map = new Map(); }
  get(k) {
    const e = this.map.get(k);
    if (!e) return undefined;
    if (Date.now() > e.exp) { this.map.delete(k); return undefined; }
    return e.v;
  }
  has(k) { return this.get(k) !== undefined; }
  delete(k) { this.map.delete(k); }
  set(k, v, ttlMs) {
    if (this.map.size >= this.max) this.map.delete(this.map.keys().next().value);
    this.map.set(k, { v, exp: Date.now() + (ttlMs || this.ttl) });
    return v;
  }
}

export const short = a => (a && a.length > 12 ? a.slice(0, 4) + '…' + a.slice(-4) : a || '');
export const pct = (n, d = 1) => (n == null || !isFinite(n) ? '—' : n.toFixed(d) + '%');
const usdFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 });
export const usd = n => (n == null || !isFinite(n) ? '—' : usdFmt.format(n));
export const sum = arr => arr.reduce((s, x) => s + x, 0);

export class ScanError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export const log = (...a) => console.log(new Date().toISOString(), ...a);
