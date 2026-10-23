// The holder's ownership proof: an empty intent for intents.near, signed as a
// NEP-413 message by their own wallet. Its nonce is a versioned nonce whose 7
// random bytes are sha256(challenge)[0..7], so the signature answers exactly
// one challenge; the enclave checks this before it calls 1Click.

import { base58, sha256, toBase64 } from './bytes';
import { INTENTS } from './config';
import { view } from './rpc';

// From @defuse-protocol/intents-sdk 0.92.0 (VersionedNonceBuilder):
// magic(4) | version(1) | salt(4) | deadline u64 LE ns (8) | start u64 LE ns (8) | random(7)
const NONCE_MAGIC = [86, 40, 246, 198];

export async function currentSalt(): Promise<Uint8Array> {
  const hex = await view<string>(INTENTS, 'current_salt', {});
  return Uint8Array.from(hex.match(/../g)!, (h) => parseInt(h, 16));
}

export async function boundNonce(salt: Uint8Array, deadline: Date, start: Date, challenge: string): Promise<Uint8Array> {
  const out = new Uint8Array(32);
  const dv = new DataView(out.buffer);
  out.set(NONCE_MAGIC, 0);
  out[4] = 0;
  out.set(salt, 5);
  dv.setBigUint64(9, BigInt(deadline.getTime()) * 1_000_000n, true);
  dv.setBigUint64(17, BigInt(start.getTime()) * 1_000_000n, true);
  out.set((await sha256(challenge)).subarray(0, 7), 25);
  return out;
}

export interface SignRequest {
  message: string;
  recipient: string;
  nonce: Uint8Array;
}

/** What the wallet is asked to sign (NEP-413 signMessage). */
export async function signRequest(signerId: string, challenge: string, now = new Date()): Promise<SignRequest> {
  const deadline = new Date(now.getTime() + 5 * 60_000);
  const message = JSON.stringify({ deadline: deadline.toISOString(), intents: [], signer_id: signerId });
  return { message, recipient: INTENTS, nonce: await boundNonce(await currentSalt(), deadline, now, challenge) };
}

/** 1Click's signedData from the request and the wallet's NEP-413 answer. */
export function signedData(req: SignRequest, publicKey: string, signatureBase64: string) {
  const sig = Uint8Array.from(atob(signatureBase64), (c) => c.charCodeAt(0));
  return {
    standard: 'nep413',
    payload: { recipient: req.recipient, nonce: toBase64(req.nonce), message: req.message },
    public_key: publicKey,
    signature: 'ed25519:' + base58(sig),
  };
}

/** Named accounts must register their key on intents.near once before 1Click accepts it. */
export async function keyRegistered(accountId: string, publicKey: string): Promise<boolean> {
  if (/^[0-9a-f]{64}$/.test(accountId)) return true; // implicit: the key is the account
  const keys = await view<string[]>(INTENTS, 'public_keys_of', { account_id: accountId });
  return keys.includes(publicKey);
}
