// Spike: prove the read path Jurat depends on.
//   signed empty intent -> POST /v0/auth/authenticate -> GET /v0/account/balances
//
// Uses a throwaway ed25519 key made in memory (raw_ed25519 standard, so no
// on-chain key registration is needed). The key is never written to disk and
// no token value is printed.
//
// Run: node spike/local/auth-balances.mjs

import { generateKeyPairSync, sign, randomBytes } from 'node:crypto';

const ONECLICK = 'https://1click.chaindefuser.com';
const RPC = 'https://rpc.mainnet.fastnear.com';
const VERIFIER = 'intents.near';

// Versioned nonce layout, from @defuse-protocol/intents-sdk 0.92.0
// (VersionedNonceBuilder): magic(4) | version(1) | salt(4) | deadline u64 LE ns (8)
// | start time u64 LE ns (8) | random (7) = 32 bytes, base64.
const NONCE_MAGIC = Buffer.from([86, 40, 246, 198]);

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(bytes) {
  let n = BigInt('0x' + (Buffer.from(bytes).toString('hex') || '0'));
  let out = '';
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; out = '1' + out; }
  return out;
}

async function currentSalt() {
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

function signEmptyIntent({ pub, privateKey, salt, start }) {
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

async function main() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const signerId = pub.toString('hex');

  const salt = await currentSalt();
  const signedData = signEmptyIntent({ pub, privateKey, salt, start: new Date() });
  const { payload } = signedData;

  console.log('salt', salt.toString('hex'), '| signer_id', signerId.slice(0, 12) + '...');

  const auth = await fetch(`${ONECLICK}/v0/auth/authenticate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ signedData }),
  });
  const authBody = await auth.json().catch(() => ({}));
  console.log('authenticate', auth.status, auth.ok
    ? { expiresIn: authBody.expiresIn, refreshExpiresIn: authBody.refreshExpiresIn, hasAccessToken: Boolean(authBody.accessToken) }
    : authBody);
  if (!auth.ok) process.exit(1);

  const bal = await fetch(`${ONECLICK}/v0/account/balances`, {
    headers: { Authorization: `Bearer ${authBody.accessToken}` },
  });
  console.log('balances', bal.status, JSON.stringify(await bal.json().catch(() => null)));

  // Adverse check: a payload altered after signing must be refused.
  const tampered = { ...signedData, payload: payload.replace('"intents":[]', '"intents": []') };
  const bad = await fetch(`${ONECLICK}/v0/auth/authenticate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ signedData: tampered }),
  });
  console.log('tampered payload', bad.status, JSON.stringify(await bad.json().catch(() => null)));

  // Adverse check: an intent whose start time is 10 minutes old must be refused.
  const stale = signEmptyIntent({ pub, privateKey, salt, start: new Date(Date.now() - 10 * 60_000) });
  const old = await fetch(`${ONECLICK}/v0/auth/authenticate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ signedData: stale }),
  });
  console.log('stale intent', old.status, JSON.stringify(await old.json().catch(() => null)));

  // Adverse check: no token, balances must be refused.
  const anon = await fetch(`${ONECLICK}/v0/account/balances`);
  console.log('balances without token', anon.status);

  if (!bal.ok || bad.ok || old.ok || anon.ok) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
