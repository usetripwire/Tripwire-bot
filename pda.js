// Program-derived addresses (PDAs), so we can find a token's metadata account
// without any extra lookups. Same rules as Solana's findProgramAddress.
import crypto from 'node:crypto';
import { b58decode, b58encode } from './auth.js';

const P = 2n ** 255n - 19n;
const mod = a => { a %= P; return a < 0n ? a + P : a; };
function pow(b, e) { let r = 1n; b = mod(b); while (e > 0n) { if (e & 1n) r = (r * b) % P; b = (b * b) % P; e >>= 1n; } return r; }
const inv = a => pow(a, P - 2n);
const D = mod(-121665n * inv(121666n));

// Is this 32-byte value a valid ed25519 point? PDAs must NOT be.
export function isOnCurve(bytes) {
  const b = Buffer.from(bytes);
  const sign = b[31] & 0x80;
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(i === 31 ? b[i] & 0x7f : b[i]);
  if (y >= P) return false;
  const y2 = (y * y) % P;
  const x2 = (mod(y2 - 1n) * inv(mod(D * y2 + 1n))) % P;
  if (x2 === 0n) return sign === 0;
  return pow(x2, (P - 1n) / 2n) === 1n;
}

export function findPda(seeds, programId) {
  const prog = b58decode(programId);
  for (let bump = 255; bump >= 0; bump--) {
    const h = crypto.createHash('sha256');
    for (const s of seeds) h.update(s);
    h.update(Buffer.from([bump]));
    h.update(prog);
    h.update(Buffer.from('ProgramDerivedAddress'));
    const out = h.digest();
    if (!isOnCurve(out)) return b58encode(out);
  }
  return null;
}

export const METADATA_PROGRAM = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s';
export const metadataPda = mint => findPda([Buffer.from('metadata'), b58decode(METADATA_PROGRAM), b58decode(mint)], METADATA_PROGRAM);
