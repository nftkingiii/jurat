// Lists the token ids of an account's NEAR Intents confidential balance,
// never the amounts. Signs an empty intent as the account (NEP-413, the same
// kind a wallet signs in the app), logs in to 1Click and reads the balances.
// Moves nothing.
//
// Usage: node spike/outlayer/token-ids.mjs <account.near> [token id to look for]
// The key comes from ~/.jurat/mainnet/<account>.json.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Account } from 'near-api-js';
import { signMessage } from 'near-api-js/nep413';
import { ONECLICK, base58, currentSalt } from '../local/intent.mjs';

const [accountId, lookFor = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1'] = process.argv.slice(2);
if (!accountId?.endsWith('.near')) {
  console.error('Usage: token-ids.mjs <account.near> [token id]');
  process.exit(2);
}

const { private_key: secret } = JSON.parse(readFileSync(join(homedir(), '.jurat', 'mainnet', `${accountId}.json`), 'utf8'));
const account = new Account(accountId, 'https://rpc.mainnet.fastnear.com', secret);

// Versioned nonce: magic(4) | version(1) | salt(4) | deadline ns (8) | start ns (8) | random(7).
const start = new Date();
const deadline = new Date(start.getTime() + 5 * 60_000);
const nonce = Buffer.alloc(32);
Buffer.from([86, 40, 246, 198]).copy(nonce, 0);
(await currentSalt()).copy(nonce, 5);
nonce.writeBigUInt64LE(BigInt(deadline.getTime()) * 1_000_000n, 9);
nonce.writeBigUInt64LE(BigInt(start.getTime()) * 1_000_000n, 17);
randomBytes(7).copy(nonce, 25);

const message = JSON.stringify({ deadline: deadline.toISOString(), intents: [], signer_id: accountId });
const signed = await signMessage({ signerAccount: account, payload: { message, recipient: 'intents.near', nonce } });
const signedData = {
  standard: 'nep413',
  payload: { recipient: 'intents.near', nonce: nonce.toString('base64'), message },
  public_key: signed.publicKey.toString(),
  signature: 'ed25519:' + base58(signed.signature),
};

const auth = await fetch(`${ONECLICK}/v0/auth/authenticate`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ signedData }),
});
console.log('authenticate', auth.status);
if (!auth.ok) {
  console.log(await auth.text());
  process.exit(1);
}
const { accessToken } = await auth.json();
const res = await fetch(`${ONECLICK}/v0/account/balances`, { headers: { Authorization: `Bearer ${accessToken}` } });
console.log('balances', res.status);
const { balances = [] } = await res.json();
// Token ids and sources only; amounts are deliberately not printed.
console.log('confidential balance token ids:', balances.length ? balances.map((b) => `${b.tokenId} (${b.source})`).join(', ') : 'none');
console.log(`lists ${lookFor}:`, balances.some((b) => b.tokenId === lookFor));
