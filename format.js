// Turns a scan result into an X reply of at most 280 characters (X counts links as 23).
import { cfg } from './config.js';

const LINK_LEN = 23;
export function xLength(text) {
  let n = 0;
  for (const part of text.split(/(https?:\/\/\S+)/)) {
    if (/^https?:\/\//.test(part)) n += LINK_LEN;
    else for (const ch of part) n += ch.codePointAt(0) > 0x10ff ? 2 : 1;
  }
  return n;
}

const LABEL = { bundle: 'Bundle', sniper: 'Sniper', dev: 'Dev', agent: 'Agent', wash: 'Wash', exit: 'Exit', authority: 'Mint/freeze', holders: 'Holders' };

export function replyText(result) {
  const ran = result.checks.filter(c => !c.na);
  const trips = ran.filter(c => c.tripped).length;
  const name = result.token.symbol ? '$' + result.token.symbol : result.token.name;
  const head = trips ? `${name}: TRIPPED ${trips} of ${ran.length} wires` : `${name}: all ${ran.length} wires clear`;
  const link = `${cfg.siteUrl}/?ca=${result.mint}`;
  const line = (c, withBrief) => {
    const status = c.na ? 'n/a' : c.tripped ? 'TRIPPED' : 'clear';
    return `${LABEL[c.key] || c.name}: ${status}${withBrief && !c.na && c.brief && c.brief !== 'clear' ? ` (${c.brief})` : ''}`;
  };
  const tail = trips ? '' : '\nClear is not a guarantee.';
  for (const withBrief of [true, false]) {
    const text = `${head}\n${result.checks.map(c => line(c, withBrief)).join('\n')}${tail}\n${link}`;
    if (xLength(text) <= 280) return text;
  }
  // Last resort: only list tripped wires
  const tripped = result.checks.filter(c => c.tripped).map(c => LABEL[c.key] || c.name).join(', ');
  return `${head}${tripped ? `\nTripped: ${tripped}` : ''}\n${link}`;
}

export const watchSoonText = () =>
  'Watch alerts launch with $TRIP in Phase 2. For now, tag me with a contract address and I\'ll scan it.';

export const notMintText = () =>
  'That address isn\'t a Solana token mint. Paste the token\'s contract address, not a wallet or pool.';

export const failText = () =>
  'The scan didn\'t finish (Solana data was slow to respond). Try tagging me again in a minute.';
