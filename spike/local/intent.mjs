// Shared helpers: sign an empty intent with an ed25519 key (raw_ed25519).
import { sign, randomBytes } from 'node:crypto';

export const ONECLICK = 'https://1click.chaindefuser.com';
const RPC = 'https://rpc.mainnet.fastnear.com';
const VERIFIER = 'intents.near';

// Versioned nonce layout, from @defuse-protocol/intents-sdk 0.92.0
// (VersionedNonceBuilder): magic(4) | version(1) | salt(4) | deadline u64 LE ns (8)
// | start time u64 LE ns (8) | random (7) = 32 bytes, base64.
const NONCE_MAGIC = Buffer.from([86, 40, 246, 198]);

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function base58(bytes) {
  let n = BigInt('0x' + (Buffer.from(bytes).toString('hex') || '0'));
  let out = '';
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; out = '1' + out; }
  return out;
}

export async function currentSalt() {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 'jurat', method: 'query',
      params: { request_type: 'call_function', finality: 'final', account_id: VERIFIER, method_name: 'current_salt', args_base64: 'e30=' },
    }),
  });
  const body = await res.json();
  if (!body.result) throw new Error('current_salt failed: ' + JSON.stringify(body.error ?? body));
  const hex = JSON.parse(Buffer.from(body.result.result).toString());
  return Buffer.from(hex, 'hex');
}

function versionedNonce(salt, deadline, start) {
  const out = Buffer.alloc(32);
  NONCE_MAGIC.copy(out, 0);
  out[4] = 0;
  salt.copy(out, 5);
  out.writeBigUInt64LE(BigInt(deadline.getTime()) * 1_000_000n, 9);
  out.writeBigUInt64LE(BigInt(start.getTime()) * 1_000_000n, 17);
  randomBytes(7).copy(out, 25);
  return out.toString('base64');
}

// `pub` is the raw 32-byte public key; `privateKey` a node KeyObject.
export function signEmptyIntent({ pub, privateKey, salt, start }) {
  const deadline = new Date(start.getTime() + 5 * 60_000);
  const payload = JSON.stringify({
    signer_id: pub.toString('hex'),
    verifying_contract: VERIFIER,
    deadline: deadline.toISOString(),
    nonce: versionedNonce(salt, deadline, start),
    intents: [],
  });
  const signature = sign(null, Buffer.from(payload, 'utf8'), privateKey);
  return {
    standard: 'raw_ed25519',
    payload,
    public_key: 'ed25519:' + base58(pub),
    signature: 'ed25519:' + base58(signature),
  };
}
