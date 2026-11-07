// The @TripwireScan bot: polls mentions, finds a contract address, scans it, replies.
// It only ever replies to posts that mention it (X's rule for automated replies).
import fs from 'node:fs';
import path from 'node:path';
import { cfg } from './config.js';
import { getMe, getMentions, postReply } from './x.js';
import { scan } from './scan.js';
import { replyText, notMintText, failText, watchSoonText } from './format.js';
import { B58, B58_GLOBAL, sleep, log } from './util.js';

const HOUR = 3600e3;

export function loadState(file = cfg.statePath) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { sinceId: null, processed: [], users: {}, notices: {} }; }
}
export function saveState(state, file = cfg.statePath) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  state.processed = state.processed.slice(-2000);
  fs.writeFileSync(file + '.tmp', JSON.stringify(state));
  fs.renameSync(file + '.tmp', file);
}

// Strip the automatic "@a @b" prefix X adds to replies.
export function stripLeadingMentions(text) {
  return text.replace(/^(\s*@\w+)+\s*/, '').trim();
}

function candidatesFrom(tweet) {
  if (!tweet) return [];
  const fromText = (tweet.text || '').match(B58_GLOBAL) || [];
  const fromUrls = ((tweet.entities && tweet.entities.urls) || []).flatMap(u => (u.expanded_url || '').match(B58_GLOBAL) || []);
  return [...fromText, ...fromUrls].filter(c => B58.test(c));
}

// Decide what to do with one mention. Returns { action, mints?, reason? }.
export function interpret(tweet, includes, botId, botUsername) {
  const refs = tweet.referenced_tweets || [];
  const byId = new Map(((includes && includes.tweets) || []).map(t => [t.id, t]));
  const parent = refs.map(r => byId.get(r.id)).find(Boolean);
  const body = stripLeadingMentions(tweet.text || '');
  const explicitMention = new RegExp('@' + botUsername + '\\b', 'i').test(body);
  const isReplyToBot = tweet.in_reply_to_user_id === botId || (parent && parent.author_id === botId);
  const own = candidatesFrom({ text: body, entities: tweet.entities });
  const lower = body.toLowerCase();

  if (/\b(unwatch|watches|watch)\b/.test(lower)) return { action: 'watch' };
  if (own.length) return { action: 'scan', mints: own };
  // Replying inside the bot's own thread without a new CA or a fresh @mention: stay quiet
  if (isReplyToBot && !explicitMention) return { action: 'ignore', reason: 'conversation' };
  const fromParent = parent && parent.author_id !== botId ? candidatesFrom(parent) : [];
  if (fromParent.length) return { action: 'scan', mints: fromParent };
  return { action: 'ignore', reason: 'no_ca' };
}

function allowUser(state, userId) {
  const now = Date.now();
  const list = (state.users[userId] || []).filter(t => now - t < HOUR);
  if (list.length >= cfg.limits.scansPerUserPerHour) { state.users[userId] = list; return false; }
  list.push(now);
  state.users[userId] = list;
  return true;
}

function noticeOnce(state, key) {
  const now = Date.now();
  if (state.notices[key] && now - state.notices[key] < 24 * HOUR) return false;
  state.notices[key] = now;
  return true;
}

async function send(text, inReplyTo) {
  if (cfg.dryRun) { log(`[dry run] reply to ${inReplyTo}:\n${text}`); return { dryRun: true }; }
  return postReply(text, inReplyTo);
}

export async function handleMention(tweet, includes, ctx, state) {
  if (state.processed.includes(tweet.id) || tweet.author_id === ctx.botId) return null;
  state.processed.push(tweet.id);
  const what = interpret(tweet, includes, ctx.botId, ctx.botUsername);
  if (what.action === 'ignore') return null;
  if (what.action === 'watch') {
    if (!noticeOnce(state, 'watch:' + tweet.author_id)) return null;
    return send(watchSoonText(), tweet.id);
  }
  if (!allowUser(state, tweet.author_id)) { log(`rate limited user ${tweet.author_id}`); return null; }
  let lastErr;
  for (const mint of what.mints.slice(0, 3)) {
    try {
      const result = await scan(mint);
      return send(replyText(result), tweet.id);
    } catch (e) {
      lastErr = e;
      if (e.code !== 'not_mint') break;
    }
  }
  if (lastErr && lastErr.code === 'not_mint') return send(notMintText(), tweet.id);
  log('scan failed', lastErr && lastErr.message);
  return send(failText(), tweet.id);
}

export async function startBot() {
  const missing = ['apiKey', 'apiSecret', 'accessToken', 'accessSecret'].filter(k => !cfg.x[k]);
  if (missing.length) throw new Error('Missing X credentials: ' + missing.join(', '));
  const me = await getMe();
  const ctx = { botId: me.data.id, botUsername: me.data.username };
  log(`bot running as @${ctx.botUsername} (${cfg.dryRun ? 'DRY RUN: replies are logged, not posted' : 'LIVE'})`);
  const state = loadState();
  for (;;) {
    try {
      const r = await getMentions(ctx.botId, state.sinceId);
      const tweets = (r.data || []).sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
      if (!state.sinceId && !cfg.replyBacklog) {
        // First start: skip old mentions instead of replying to all of them
        if (tweets.length) state.sinceId = tweets[tweets.length - 1].id;
        else state.sinceId = '0';
        log(`first start: skipped ${tweets.length} older mentions`);
      } else {
        for (const t of tweets) {
          try { await handleMention(t, r.includes, ctx, state); } catch (e) { log('reply failed', e.message); }
          state.sinceId = t.id;
          saveState(state);
        }
      }
      saveState(state);
    } catch (e) {
      log('poll failed', e.message);
    }
    await sleep(cfg.pollSeconds * 1000);
  }
}
