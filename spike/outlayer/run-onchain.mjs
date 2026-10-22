// Runs the Jurat enclave inside OutLayer (outlayer.testnet or outlayer.near,
// picked from the account name).
//
// The request carries an empty intent signed by a throwaway key, so the enclave
// logs in to live 1Click and reads an empty confidential balance.
//
// OutLayer stopped building from GitHub (testnet, 2026-10-22), so the module
// comes from a release asset: a WasmUrl source with the file's sha256, which
// the worker checks before it runs anything.
//
// Usage:
//   node spike/outlayer/run-onchain.mjs <account> <release tag> [threshold] [--stale] [--mainnet-ok]
// The key comes from ~/.jurat/<network>/<account>.json (written by store-key.mjs).
// A mainnet run spends real NEAR, so it needs --mainnet-ok, attaches only the
// estimated cost, and stops if that is above MAX_MAINNET_DEPOSIT.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, createHash } from 'node:crypto';
import { Account, parseNearAmount, teraToGas } from 'near-api-js';
import { currentSalt, signEmptyIntent } from '../local/intent.mjs';

const REPO = 'https://github.com/nftkingiii/jurat';
const MAX_MAINNET_DEPOSIT = parseNearAmount('0.01');

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const stale = process.argv.includes('--stale');
const [accountId, tag, threshold = '0'] = args;
if (!accountId || !/^enclave-v[0-9A-Za-z.+-]+$/.test(tag ?? '')) {
  console.error('Usage: run-onchain.mjs <account> <enclave-v... release tag> [threshold] [--stale] [--mainnet-ok]');
  process.exit(2);
}
const NETWORK = accountId.endsWith('.testnet') ? 'testnet' : 'mainnet';
const RPC = `https://rpc.${NETWORK}.fastnear.com`;
const OUTLAYER = NETWORK === 'testnet' ? 'outlayer.testnet' : 'outlayer.near';
const EXPLORER = NETWORK === 'testnet' ? 'https://testnet.nearblocks.io/txns/' : 'https://nearblocks.io/txns/';
if (NETWORK === 'mainnet' && !process.argv.includes('--mainnet-ok')) {
  console.error(`${accountId} is a mainnet account; this spends real NEAR. Re-run with --mainnet-ok.`);
  process.exit(2);
}
const WASM_URL = `${REPO}/releases/download/${tag}/jurat-enclave.wasm`;

// The pinned hash is the one the release published, re-checked against the file.
async function releaseHash() {
  const published = (await (await fetch(`${WASM_URL}.sha256`)).text()).trim().split(/\s+/)[0];
  const bytes = Buffer.from(await (await fetch(WASM_URL)).arrayBuffer());
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (!/^[0-9a-f]{64}$/.test(published) || published !== actual) {
    throw new Error(`release hash mismatch: published ${published}, file ${actual}`);
  }
  return actual;
}

const { private_key: secret } = JSON.parse(
  readFileSync(join(homedir(), '.jurat', NETWORK, `${accountId}.json`), 'utf8'),
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
const hash = await releaseHash();
const input = await request();
const cost = await view('estimate_execution_cost', { resource_limits: limits, input_len: input.length });
// Testnet gets headroom; mainnet attaches exactly the estimate, refunded above the actual cost.
const deposit = NETWORK === 'mainnet' ? BigInt(cost) : BigInt(cost) * 3n;
if (NETWORK === 'mainnet' && deposit > BigInt(MAX_MAINNET_DEPOSIT)) {
  throw new Error(`estimated cost ${cost} yocto is above the 0.01 NEAR cap; not sending`);
}
const before = await rpc('query', { request_type: 'view_account', finality: 'final', account_id: accountId });

const callArgs = {
  source: { WasmUrl: { url: WASM_URL, hash, build_target: 'wasm32-wasip2' } },
  resource_limits: limits,
  input_data: input,
  response_format: 'Json',
};
console.log(`${NETWORK} ${OUTLAYER} | threshold ${threshold}${stale ? ' (stale intent)' : ''} | ${tag} sha256 ${hash.slice(0, 12)}… | estimated ${cost} yocto, attaching ${deposit} (refund above cost)`);

const sent = await account.callFunctionRaw({
  contractId: OUTLAYER, methodName: 'request_execution', args: callArgs,
  deposit, gas: teraToGas('300'), waitUntil: 'INCLUDED',
});
const txHash = sent.transaction?.hash ?? sent.transaction_outcome?.id;
console.log(`tx ${txHash}\n   ${EXPLORER}${txHash}`);

const outcome = await waitFinal(txHash);
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
const after = await rpc('query', { request_type: 'view_account', finality: 'final', account_id: accountId });
const spent = BigInt(before.result.amount) - BigInt(after.result.amount);
console.log(`balance change ${Number(spent) / 1e24} NEAR`);
