// Control run: send any public repo + commit to outlayer.testnet and print the
// outcome, to tell a failure in our repo apart from a failure in OutLayer.
// Usage: node spike/outlayer/control.mjs <account.testnet> <repo url> <commit> <build_target> [input json]
// With no input, the request is compile-only.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Account, parseNearAmount, teraToGas } from 'near-api-js';

const RPC = 'https://rpc.testnet.fastnear.com';
const [accountId, repo, commit, buildTarget, input] = process.argv.slice(2);
const { private_key: secret } = JSON.parse(readFileSync(join(homedir(), '.jurat', 'testnet', `${accountId}.json`), 'utf8'));
const account = new Account(accountId, RPC, secret);

const sent = await account.callFunctionRaw({
  contractId: 'outlayer.testnet',
  methodName: 'request_execution',
  args: {
    source: { GitHub: { repo, commit, build_target: buildTarget } },
    resource_limits: input ? { max_instructions: 10_000_000_000, max_memory_mb: 128, max_execution_seconds: 60 } : null,
    input_data: input ?? null,
    response_format: 'Text',
    params: input ? null : { compile_only: true },
  },
  deposit: BigInt(parseNearAmount('0.02')), gas: teraToGas('300'), waitUntil: 'INCLUDED',
});
const hash = sent.transaction?.hash ?? sent.transaction_outcome?.id;
console.log('tx', hash);
for (let i = 0; i < 60; i++) {
  const res = await fetch(RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'c', method: 'EXPERIMENTAL_tx_status', params: { tx_hash: hash, sender_account_id: accountId, wait_until: 'FINAL' } }) });
  const body = await res.json();
  if (body.result?.final_execution_status === 'FINAL') {
    const st = body.result.status;
    console.log('result', st.SuccessValue !== undefined ? Buffer.from(st.SuccessValue, 'base64').toString() || '(empty)' : JSON.stringify(st));
    for (const r of body.result.receipts_outcome) for (const l of r.outcome.logs) if (!l.startsWith('EVENT_JSON')) console.log('log', l.slice(0, 300));
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 5000));
}
