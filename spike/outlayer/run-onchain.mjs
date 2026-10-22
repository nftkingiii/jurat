// Runs the Jurat enclave inside OutLayer through outlayer.testnet.
//
// The request carries an empty intent signed by a throwaway key, so the enclave
// logs in to live 1Click and reads an empty confidential balance. OutLayer
// compiles the module itself from this repository at the given commit.
//
// Usage:
//   node spike/outlayer/run-onchain.mjs <account.testnet> <commit> --compile-only
//   node spike/outlayer/run-onchain.mjs <account.testnet> <commit> [threshold] [--stale]
// The key comes from ~/.jurat/testnet/<account>.json (written by store-key.mjs).

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { Account, parseNearAmount, teraToGas } from 'near-api-js';
import { currentSalt, signEmptyIntent } from '../local/intent.mjs';

const RPC = 'https://rpc.testnet.fastnear.com';
const OUTLAYER = 'outlayer.testnet';
const REPO = 'https://github.com/nftkingiii/jurat';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const compileOnly = process.argv.includes('--compile-only');
const stale = process.argv.includes('--stale');
const [accountId, commit, threshold = '0'] = args;
if (!accountId || !/^[0-9a-f]{40}$/.test(commit ?? '')) {
  console.error('Usage: run-onchain.mjs <account.testnet> <40-char commit> [threshold] [--compile-only] [--stale]');
  process.exit(2);
}

const { private_key: secret } = JSON.parse(
  readFileSync(join(homedir(), '.jurat', 'testnet', `${accountId}.json`), 'utf8'),
);
const account = new Account(accountId, RPC, secret);

async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'jurat', method, params }),
  });
  return res.json();
}

async function view(methodName, argsObj) {
  const body = await rpc('query', {
    request_type: 'call_function', finality: 'final', account_id: OUTLAYER,
    method_name: methodName, args_base64: Buffer.from(JSON.stringify(argsObj)).toString('base64'),
  });
  if (!body.result) throw new Error(`${methodName} failed: ${JSON.stringify(body.error)}`);
  return JSON.parse(Buffer.from(body.result.result).toString());
}

async function request() {
  if (compileOnly) return null;
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const start = new Date(Date.now() - (stale ? 10 * 60_000 : 0));
  const signedData = signEmptyIntent({ pub, privateKey, salt: await currentSalt(), start });
  return JSON.stringify({ signedData, tokenId: 'nep141:wrap.near', threshold });
}

// The resumed result lands in a later receipt; poll until the transaction is final.
async function waitFinal(hash) {
  for (let i = 0; i < 60; i++) {
    const body = await rpc('EXPERIMENTAL_tx_status', { tx_hash: hash, sender_account_id: accountId, wait_until: 'FINAL' });
    if (body.result?.final_execution_status === 'FINAL') return body.result;
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error('transaction did not finalise within 5 minutes');
}

const limits = { max_instructions: 10_000_000_000, max_memory_mb: 128, max_execution_seconds: 60 };
const input = await request();
const cost = await view('estimate_execution_cost', { resource_limits: limits, input_len: input?.length ?? 0 });
const deposit = (BigInt(cost) * 3n > BigInt(parseNearAmount('0.02'))) ? BigInt(cost) * 3n : BigInt(parseNearAmount('0.02'));

const callArgs = {
  source: { GitHub: { repo: REPO, commit, build_target: 'wasm32-wasip2' } },
  resource_limits: compileOnly ? null : limits,
  input_data: input,
  response_format: 'Json',
  params: compileOnly ? { compile_only: true } : null,
};
console.log(`${compileOnly ? 'compile only' : `threshold ${threshold}${stale ? ' (stale intent)' : ''}`} | commit ${commit.slice(0, 7)} | estimated ${cost} yocto, attaching ${deposit} (refund above cost)`);

const sent = await account.callFunctionRaw({
  contractId: OUTLAYER, methodName: 'request_execution', args: callArgs,
  deposit, gas: teraToGas('300'), waitUntil: 'INCLUDED',
});
const hash = sent.transaction?.hash ?? sent.transaction_outcome?.id;
console.log(`tx ${hash}\n   https://testnet.nearblocks.io/txns/${hash}`);

const outcome = await waitFinal(hash);
const status = outcome.status;
if (status.SuccessValue !== undefined) {
  const value = Buffer.from(status.SuccessValue, 'base64').toString();
  console.log('result', value || '(empty)');
} else {
  console.log('failure', JSON.stringify(status.Failure ?? status));
}
for (const r of outcome.receipts_outcome) {
  for (const log of r.outcome.logs) console.log('log', log.slice(0, 400));
}
