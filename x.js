// Minimal X API v2 client using OAuth 1.0a user context (no dependencies).
import crypto from 'node:crypto';
import { cfg } from './config.js';
import { sleep, log } from './util.js';

const enc = s => encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());

export function oauthHeader(method, url, formParams, creds, nonce = crypto.randomBytes(16).toString('hex'), timestamp = String(Math.floor(Date.now() / 1000))) {
  const u = new URL(url);
  const oauth = {
    oauth_consumer_key: creds.apiKey,
    oauth_nonce: nonce,
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: timestamp,
    oauth_token: creds.accessToken,
    oauth_version: '1.0'
  };
  const pairs = [...Object.entries(oauth), ...u.searchParams.entries(), ...Object.entries(formParams || {})]
    .map(([k, v]) => [enc(k), enc(String(v))])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  const paramString = pairs.map(([k, v]) => `${k}=${v}`).join('&');
  const base = [method.toUpperCase(), enc(u.origin + u.pathname), enc(paramString)].join('&');
  const key = `${enc(creds.apiSecret)}&${enc(creds.accessSecret)}`;
  const signature = crypto.createHmac('sha1', key).update(base).digest('base64');
  return 'OAuth ' + Object.entries({ ...oauth, oauth_signature: signature }).map(([k, v]) => `${enc(k)}="${enc(v)}"`).join(', ');
}

export class XError extends Error {
  constructor(status, body) { super(`X API ${status}: ${JSON.stringify(body).slice(0, 300)}`); this.status = status; this.body = body; }
}

async function xfetch(method, path, body) {
  const url = cfg.x.apiBase + path;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, {
      method,
      headers: { authorization: oauthHeader(method, url, null, cfg.x), ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    if (res.status === 429) {
      const reset = Number(res.headers.get('x-rate-limit-reset')) * 1000;
      const wait = Math.min(Math.max((reset || 0) - Date.now(), 15000), 15 * 60e3);
      log(`X rate limit hit, waiting ${Math.round(wait / 1000)}s`);
      await sleep(wait);
      continue;
    }
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new XError(res.status, j);
    return j;
  }
  throw new XError(429, { error: 'rate limited' });
}

export const getMe = () => xfetch('GET', '/2/users/me');

export function getMentions(userId, sinceId) {
  const q = new URLSearchParams({
    max_results: '100',
    'tweet.fields': 'author_id,conversation_id,created_at,entities,referenced_tweets,in_reply_to_user_id',
    expansions: 'referenced_tweets.id,author_id',
    'user.fields': 'username'
  });
  if (sinceId) q.set('since_id', sinceId);
  return xfetch('GET', `/2/users/${userId}/mentions?${q}`);
}

export const postReply = (text, inReplyTo) => xfetch('POST', '/2/tweets', { text, reply: { in_reply_to_tweet_id: inReplyTo } });
