// Deploys the Jurat statement contract to a mainnet account and initialises it,
// in one transaction (if `new` fails, the deploy is rolled back too).
//
// Usage:
//   node spike/outlayer/deploy-contract.mjs <account.near> <contract.wasm> <expected sha256> --mainnet-ok
// The key comes from ~/.jurat/mainnet/<account>.json (written by store-key.mjs).
// It stops before sending if the wasm's hash differs, if its storage would lock
// more than MAX_LOCK, or if the account cannot cover storage plus gas.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Account, actions, parseNearAmount, teraToGas } from 'near-api-js';

const RPC = 'https://rpc.mainnet.fastnear.com';
const MAX_LOCK = BigInt(parseNearAmount('1.8'));
const GAS_BUDGET = BigInt(parseNearAmount('0.01'));
const BYTE_COST = 10n ** 19n; // 0.00001 NEAR per byte, protocol 86
const ENCLAVE = {
  url: 'https://github.com/nftkingiii/jurat/releases/download/enclave-v0.1.0-spike.1/jurat-enclave.wasm',
  hash: '93b9aab6398021efda26aa56d64ce803c1917cffd90e06ae253f00d118efa3b4',
};

const [accountId, wasmPath, expected] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!accountId?.endsWith('.near') || !wasmPath || !/^[0-9a-f]{64}$/.test(expected ?? '')) {
  console.error('Usage: deploy-contract.mjs <account.near> <contract.wasm> <expected sha256> --mainnet-ok');
  process.exit(2);
}
if (!process.argv.includes('--mainnet-ok')) {
  console.error('This locks real NEAR on mainnet. Re-run with --mainnet-ok.');
  process.exit(2);
}

async function view(account_id) {
  const res = await fetch(RPC, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'jurat', method: 'query',
      params: { request_type: 'view_account', finality: 'final', account_id } }),
  });
  return (await res.json()).result;
}

const code = readFileSync(wasmPath);
const hash = createHash('sha256').update(code).digest('hex');
if (hash !== expected) throw new Error(`wasm sha256 ${hash} is not the expected ${expected}`);
const lock = BigInt(code.length) * BYTE_COST;
if (lock > MAX_LOCK) throw new Error(`code would lock ${Number(lock) / 1e24} NEAR, above the 1.8 NEAR cap`);

const before = await view(accountId);
const free = BigInt(before.amount) - BigInt(before.storage_usage) * BYTE_COST;
const need = lock + BigInt(parseNearAmount('0.005')) + GAS_BUDGET;
console.log(`code ${code.length} bytes, sha256 ${hash.slice(0, 12)}…, locks ${Number(lock) / 1e24} NEAR`);
console.log(`balance ${Number(before.amount) / 1e24} NEAR; needs about ${Number(need) / 1e24} NEAR free`);
if (free < need) throw new Error('not enough NEAR on the account; nothing sent');

const { private_key: secret } = JSON.parse(readFileSync(join(homedir(), '.jurat', 'mainnet', `${accountId}.json`), 'utf8'));
const account = new Account(accountId, RPC, secret);
const sent = await account.signAndSendTransaction({
  receiverId: accountId,
  actions: [
    actions.deployContract(new Uint8Array(code)),
    actions.functionCall('new', { owner: accountId, outlayer: 'outlayer.near', wasm: ENCLAVE }, teraToGas('30'), 0n),
  ],
  waitUntil: 'FINAL',
});
const txHash = sent.transaction?.hash ?? sent.transaction_outcome?.id;
console.log(`tx ${txHash}\n   https://nearblocks.io/txns/${txHash}`);
const failure = sent.status?.Failure;
if (failure) throw new Error('transaction failed: ' + JSON.stringify(failure));

const after = await view(accountId);
console.log(`code_hash ${after.code_hash}, storage ${after.storage_usage} bytes`);
console.log(`balance ${Number(after.amount) / 1e24} NEAR (change ${Number(BigInt(before.amount) - BigInt(after.amount)) / 1e24}, of which locked as storage ${Number(BigInt(after.storage_usage - before.storage_usage) * BYTE_COST) / 1e24})`);
