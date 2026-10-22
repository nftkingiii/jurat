// Stores a NEAR testnet key for the OutLayer spike, outside the repository.
//
// Prompts for the account id and the private key (typed without echo), checks
// the key is an access key of that account on testnet, and writes
// ~/.jurat/testnet/<account>.json with owner-only permissions.
// Nothing is printed except the account and the public key.
//
// Run: node spike/outlayer/store-key.mjs

import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { KeyPair } from 'near-api-js';

const RPC = 'https://rpc.testnet.fastnear.com';

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    process.stdout.write(question);
    const stdin = process.stdin;
    let value = '';
    stdin.setEncoding('utf8');
    if (hidden && stdin.isTTY) stdin.setRawMode(true);
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          stdin.off('data', onData);
          if (hidden && stdin.isTTY) stdin.setRawMode(false);
          stdin.pause();
          process.stdout.write('\n');
          resolve(value.trim());
          return;
        }
        if (ch === '\u0003') process.exit(130); // Ctrl+C
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
        if (!hidden) process.stdout.write(ch);
      }
    };
    stdin.resume();
    stdin.on('data', onData);
  });
}

async function viewAccessKey(accountId, publicKey) {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 'jurat', method: 'query',
      params: { request_type: 'view_access_key', finality: 'final', account_id: accountId, public_key: publicKey },
    }),
  });
  return res.json();
}

const accountId = await ask('Testnet account id (e.g. you.testnet): ');
if (!/^[a-z0-9._-]+$/.test(accountId)) throw new Error('That does not look like a NEAR account id.');
const secret = await ask('Private key (ed25519:..., not shown): ', { hidden: true });

let keyPair;
try { keyPair = KeyPair.fromString(secret); } catch { throw new Error('That is not a valid ed25519:... private key.'); }
const publicKey = keyPair.getPublicKey().toString();

const check = await viewAccessKey(accountId, publicKey);
if (!check.result || check.result.error) {
  throw new Error(`Key ${publicKey} is not an access key of ${accountId} on testnet.`);
}
const perm = check.result.permission === 'FullAccess' ? 'FullAccess' : 'FunctionCall';

const dir = join(homedir(), '.jurat', 'testnet');
mkdirSync(dir, { recursive: true, mode: 0o700 });
const file = join(dir, `${accountId}.json`);
writeFileSync(file, JSON.stringify({ account_id: accountId, private_key: secret }), { mode: 0o600 });
chmodSync(file, 0o600);
console.log(`Stored ${perm} key ${publicKey} for ${accountId} in ${file}`);
