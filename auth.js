// Wallet sign-in for Radar: the wallet signs a free message (no transaction),
// we verify the ed25519 signature, check its $TRIP balance and hand back a session token.
import crypto from 'node:crypto';
import { cfg } from './config.js';
import { rpc } from './rpc.js';
import { TTLCache, ScanError, B58 } from './util.js';

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function b58decode(s) {
  let n = 0n;
  for (const c of s) {
    const i = ALPHABET.indexOf(c);
    if (i < 0) throw new Error('bad base58');
    n = n * 58n + BigInt(i);
  }
  let hex = n === 0n ? '' : n.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  let lead = 0;
  for (const c of s) { if (c === '1') lead++; else break; }
  return Buffer.concat([Buffer.alloc(lead), Buffer.from(hex, 'hex')]);
}

export function b58encode(buf) {
  buf = Buffer.from(buf);
  let n = BigInt('0x' + (buf.toString('hex') || '0'));
  let out = '';
  while (n > 0n) { out = ALPHABET[Number(n % 58n)] + out; n /= 58n; }
  for (const b of buf) { if (b === 0) out = '1' + out; else break; }
  return out;
}

const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');
export function verifySolanaSignature(walletB58, message, signature) {
  const raw = b58decode(walletB58);
  if (raw.length !== 32 || signature.length !== 64) return false;
  const key = crypto.createPublicKey({ key: Buffer.concat([SPKI_ED25519, raw]), format: 'der', type: 'spki' });
  return crypto.verify(null, Buffer.from(message, 'utf8'), key, signature);
}

// If no SESSION_SECRET is set, sessions reset whenever the server restarts.
const secret = cfg.radar.sessionSecret || crypto.randomBytes(32).toString('hex');
const nonces = new TTLCache(20000, 5 * 60e3);
const balances = new TTLCache(20000, 10 * 60e3);

export function issueNonce(wallet) {
  if (!B58.test(wallet || '')) throw new ScanError('invalid', 'That is not a Solana wallet address.');
  const nonce = crypto.randomBytes(12).toString('hex');
  const message = `Tripwire Radar sign-in\n\nWallet: ${wallet}\nNonce: ${nonce}\nIssued: ${new Date().toISOString()}\n\nThis free signature proves you own this wallet. It does not send a transaction or cost anything.`;
  nonces.set(nonce, { wallet, message });
  return { nonce, message };
}

export async function tripBalance(wallet) {
  if (!cfg.radar.tripMint) return 0;
  const hit = balances.get(wallet);
  if (hit !== undefined) return hit;
  const r = await rpc('getTokenAccountsByOwner', [wallet, { mint: cfg.radar.tripMint }, { encoding: 'jsonParsed' }]);
  const bal = ((r && r.value) || []).reduce((s, a) => {
    const t = a.account.data.parsed.info.tokenAmount;
    return s + Number(t.uiAmountString != null ? t.uiAmountString : t.uiAmount || 0);
  }, 0);
  return balances.set(wallet, bal);
}

// Holder status for a wallet: real holdings, or a tester listed in RADAR_ALLOW_WALLETS.
export async function holderStatus(wallet) {
  const tester = cfg.radar.allowWallets.includes(wallet);
  const balance = await tripBalance(wallet).catch(() => 0);
  return { wallet, balance, tester, holder: tester || (!!cfg.radar.tripMint && balance >= cfg.radar.minHold) };
}

const mac = payload => crypto.createHmac('sha256', secret).update(payload).digest('base64url');

export async function createSession({ wallet, nonce, signature }) {
  if (!B58.test(wallet || '')) throw new ScanError('invalid', 'That is not a Solana wallet address.');
  const n = nonces.get(nonce);
  if (!n || n.wallet !== wallet) throw new ScanError('expired', 'Sign-in expired. Try again.');
  nonces.delete(nonce);
  let sig;
  try { sig = Buffer.from(String(signature || ''), 'base64'); } catch { sig = Buffer.alloc(0); }
  if (!verifySolanaSignature(wallet, n.message, sig)) throw new ScanError('bad_signature', 'The signature did not match this wallet.');
  const exp = Date.now() + 24 * 3600e3;
  const payload = `${wallet}.${exp}`;
  return { token: `${payload}.${mac(payload)}`, exp, ...(await holderStatus(wallet)) };
}

export function readSession(authHeader) {
  const parts = String(authHeader || '').replace(/^Bearer\s+/i, '').split('.');
  if (parts.length !== 3) return null;
  const [wallet, exp, sig] = parts;
  if (!B58.test(wallet) || !(Number(exp) > Date.now())) return null;
  const expect = mac(`${wallet}.${exp}`);
  if (sig.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
  return { wallet };
}
