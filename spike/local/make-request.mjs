// Prints one enclave request on stdout, signed by a throwaway in-memory key:
//   { "signedData": ..., "tokenId": ..., "threshold": ... }
// Usage: node spike/local/make-request.mjs [tokenId] [threshold] [--stale]
// --stale signs with a start time 10 minutes old, which 1Click must refuse.

import { generateKeyPairSync } from 'node:crypto';
import { currentSalt, signEmptyIntent } from './intent.mjs';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const stale = process.argv.includes('--stale');
const [tokenId = 'nep141:wrap.near', threshold = '0'] = args;

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
const start = new Date(Date.now() - (stale ? 10 * 60_000 : 0));
const signedData = signEmptyIntent({ pub, privateKey, salt: await currentSalt(), start });

process.stdout.write(JSON.stringify({ signedData, tokenId, threshold }));
