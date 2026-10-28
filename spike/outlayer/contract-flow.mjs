// One challenge through the live statement contract, end to end:
// create_challenge -> sign an empty intent bound to it (throwaway key) ->
// prove -> read the statement back.
//
// Usage: node spike/outlayer/contract-flow.mjs <account.near> <contract> <tokenId> <threshold> --mainnet-ok
// The key comes from ~/.jurat/mainnet/<account>.json. The account opens the
// challenge and pays for the proof. Stops if the attached deposits exceed
// MAX_SPEND, and reports the account's real balance change at the end.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { Account, parseNearAmount, teraToGas } from 'near-api-js';
import { currentSalt, signEmptyIntent } from '../local/intent.mjs';

const RPC = 'https://rpc.mainnet.fastnear.com';
const MAX_SPEND = BigInt(parseNearAmount('0.03'));
const CHALLENGE_DEPOSIT = BigInt(parseNearAmount('0.005')); // storage, excess refunded
const STATEMENT_RESERVE = BigInt(parseNearAmount('0.01')); // the contract's reserve, unused part refunded

const [accountId, contractId, tokenId, threshold] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!accountId || !contractId || !tokenId || !/^\d+$/.test(threshold ?? '') || !process.argv.includes('--mainnet-ok')) {
  console.error('Usage: contract-flow.mjs <account.near> <contract> <tokenId> <threshold> --mainnet-ok');
  process.exit(2);
}

async function rpc(method, params) {
  const res = await fetch(RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'jurat', method, params }) });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  return body.result;
}
const view = async (account_id, method_name, args) => {
  const r = await rpc('query', { request_type: 'call_function', finality: 'final', account_id, method_name,
    args_base64: Buffer.from(JSON.stringify(args)).toString('base64') });
  return JSON.parse(Buffer.from(r.result).toString());
};
const balance = async () => BigInt((await rpc('query', { request_type: 'view_account', finality: 'final', account_id: accountId })).amount);
const near = (y) => (Number(y) / 1e24).toFixed(6);

async function waitFinal(hash) {
  for (let i = 0; i < 60; i++) {
    const r = await rpc('EXPERIMENTAL_tx_status', { tx_hash: hash, sender_account_id: accountId, wait_until: 'FINAL' }).catch(() => null);
    if (r?.final_execution_status === 'FINAL') return r;
    await new Promise((s) => setTimeout(s, 5000));
  }
  throw new Error('transaction did not finalise within 5 minutes');
}

const { private_key: secret } = JSON.parse(readFileSync(join(homedir(), '.jurat', 'mainnet', `${accountId}.json`), 'utf8'));
const account = new Account(accountId, RPC, secret);
const before = await balance();

// Fee for the enclave run, as OutLayer estimates it for the contract's limits.
const cost = BigInt(await view('outlayer.near', 'estimate_execution_cost', {
  resource_limits: { max_instructions: 10_000_000_000, max_memory_mb: 128, max_execution_seconds: 60 }, input_len: 1200 }));
const proveDeposit = cost + STATEMENT_RESERVE;
if (CHALLENGE_DEPOSIT + proveDeposit > MAX_SPEND) throw new Error(`deposits ${near(CHALLENGE_DEPOSIT + proveDeposit)} NEAR exceed the 0.03 cap; nothing sent`);
console.log(`balance ${near(before)} NEAR | deposits: challenge ${near(CHALLENGE_DEPOSIT)}, prove ${near(proveDeposit)} (OutLayer ${near(cost)} + reserve ${near(STATEMENT_RESERVE)})`);

// 1. Open the challenge.
const c1 = await account.callFunctionRaw({ contractId, methodName: 'create_challenge',
  args: { token_id: tokenId, threshold, ttl_minutes: 30 }, deposit: CHALLENGE_DEPOSIT, gas: teraToGas('30'), waitUntil: 'FINAL' });
const c1hash = c1.transaction?.hash ?? c1.transaction_outcome?.id;
const created = JSON.parse(Buffer.from(c1.status.SuccessValue, 'base64').toString());
console.log(`challenge ${created.id}: ${created.challenge}\n   tx https://nearblocks.io/txns/${c1hash}`);

// 2. A throwaway holder signs an empty intent bound to the challenge text.
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
const signedData = signEmptyIntent({ pub, privateKey, salt: await currentSalt(), start: new Date(), challenge: created.challenge });
const suffix = await view(contractId, 'nonce_suffix', { id: created.id });
const nonce = Buffer.from(JSON.parse(signedData.payload).nonce, 'base64');
console.log(`holder ${pub.toString('hex').slice(0, 12)}… | nonce suffix ${nonce.subarray(25).toString('hex')} (contract expects ${suffix})`);

// 3. Prove through the contract.
const c2 = await account.callFunctionRaw({ contractId, methodName: 'prove',
  args: { challenge_id: created.id, signed_data: signedData }, deposit: proveDeposit, gas: teraToGas('100'), waitUntil: 'INCLUDED' });
const c2hash = c2.transaction?.hash ?? c2.transaction_outcome?.id;
console.log(`prove tx https://nearblocks.io/txns/${c2hash}`);
const done = await waitFinal(c2hash);
for (const r of done.receipts_outcome) for (const l of r.outcome.logs) console.log('log', l.slice(0, 300));
console.log('prove result', done.status.SuccessValue !== undefined ? Buffer.from(done.status.SuccessValue, 'base64').toString() : JSON.stringify(done.status));

// 4. Read the challenge and its statements back from the contract.
console.log('get_challenge', JSON.stringify(await view(contractId, 'get_challenge', { id: created.id })));
const after = await balance();
console.log(`balance ${near(after)} NEAR | spent ${near(before - after)} NEAR`);
if (before - after > MAX_SPEND) console.log('WARNING: spend above the 0.03 NEAR cap');
