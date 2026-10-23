// A Jurat challenge is plain text that describes itself, so it works without
// a contract:  jurat:v1:<expiresMs>:<nonce hex>:<threshold>:<tokenId>
// The token id goes last because token ids contain colons (nep141:usdc.near).

export interface Challenge {
  expiresMs: number;
  nonce: string;
  /** Integer in the token's smallest unit. */
  threshold: string;
  tokenId: string;
  text: string;
}

const PREFIX = 'jurat:v1:';
const DIGITS = /^[0-9]{1,40}$/;
const NONCE = /^[0-9a-f]{16}$/;
const TOKEN = /^[A-Za-z0-9:._-]{3,128}$/;

function randomHex(bytes: number): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export function makeChallenge(tokenId: string, threshold: string, ttlMinutes: number, now = Date.now()): Challenge {
  if (!TOKEN.test(tokenId)) throw new Error('token id looks wrong');
  if (!DIGITS.test(threshold)) throw new Error("threshold must be an integer in the token's smallest unit");
  if (!(ttlMinutes >= 1 && ttlMinutes <= 7 * 24 * 60)) throw new Error('expiry must be 1 minute to 7 days');
  const expiresMs = now + Math.round(ttlMinutes) * 60_000;
  const nonce = randomHex(8);
  return { expiresMs, nonce, threshold, tokenId, text: `${PREFIX}${expiresMs}:${nonce}:${threshold}:${tokenId}` };
}

export function parseChallenge(text: string): Challenge {
  if (!text.startsWith(PREFIX)) throw new Error('not a Jurat challenge');
  const parts = text.slice(PREFIX.length).split(':');
  if (parts.length < 4) throw new Error('not a Jurat challenge');
  const [expires, nonce, threshold, ...token] = parts;
  const tokenId = token.join(':');
  if (!/^[0-9]{13}$/.test(expires) || !NONCE.test(nonce) || !DIGITS.test(threshold) || !TOKEN.test(tokenId)) {
    throw new Error('not a Jurat challenge');
  }
  return { expiresMs: Number(expires), nonce, threshold, tokenId, text };
}
