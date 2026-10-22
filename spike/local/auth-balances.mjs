// Spike: prove the read path Jurat depends on.
//   signed empty intent -> POST /v0/auth/authenticate -> GET /v0/account/balances
//
// Uses a throwaway ed25519 key made in memory (raw_ed25519 standard, so no
// on-chain key registration is needed). The key is never written to disk and
// no token value is printed.
//
// Run: node spike/local/auth-balances.mjs

import { generateKeyPairSync } from 'node:crypto';
import { ONECLICK, currentSalt, signEmptyIntent } from './intent.mjs';

async function authenticate(signedData) {
  const res = await fetch(`${ONECLICK}/v0/auth/authenticate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ signedData }),
  });
  return { res, body: await res.json().catch(() => ({})) };
}

async function main() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);

  const salt = await currentSalt();
  const signedData = signEmptyIntent({ pub, privateKey, salt, start: new Date() });
  console.log('salt', salt.toString('hex'), '| signer_id', pub.toString('hex').slice(0, 12) + '...');

  const auth = await authenticate(signedData);
  console.log('authenticate', auth.res.status, auth.res.ok
    ? { expiresIn: auth.body.expiresIn, refreshExpiresIn: auth.body.refreshExpiresIn, hasAccessToken: Boolean(auth.body.accessToken) }
    : auth.body);
  if (!auth.res.ok) process.exit(1);

  const bal = await fetch(`${ONECLICK}/v0/account/balances`, {
    headers: { Authorization: `Bearer ${auth.body.accessToken}` },
  });
  console.log('balances', bal.status, JSON.stringify(await bal.json().catch(() => null)));

  // Adverse check: a payload altered after signing must be refused.
  const tampered = { ...signedData, payload: signedData.payload.replace('"intents":[]', '"intents": []') };
  const bad = await authenticate(tampered);
  console.log('tampered payload', bad.res.status, JSON.stringify(bad.body));

  // Adverse check: an intent whose start time is 10 minutes old must be refused.
  const stale = signEmptyIntent({ pub, privateKey, salt, start: new Date(Date.now() - 10 * 60_000) });
  const old = await authenticate(stale);
  console.log('stale intent', old.res.status, JSON.stringify(old.body));

  // Adverse check: no token, balances must be refused.
  const anon = await fetch(`${ONECLICK}/v0/account/balances`);
  console.log('balances without token', anon.status);

  if (!bal.ok || bad.res.ok || old.res.ok || anon.ok) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
