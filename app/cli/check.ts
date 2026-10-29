// Checks a Jurat proof from the command line, with the same code the Check tab
// runs in the browser. Exits 0 for a valid proof, 1 for an invalid one, 2 on error.
//
//   npm run check -- <tx-hash> <sender> [--challenge <text>] [--json]

import { checkProof } from '../src/lib/check';

const args = process.argv.slice(2);
const json = args.includes('--json');
const at = args.indexOf('--challenge');
const expected = at >= 0 ? args[at + 1] : undefined;
const [tx, sender] = args.filter((a, i) => !a.startsWith('--') && (at < 0 || i !== at + 1));

if (!tx || !sender) {
  console.error('usage: npm run check -- <tx-hash> <sender> [--challenge <text>] [--json]');
  process.exit(2);
}

try {
  const p = await checkProof(tx, sender, expected);
  if (json) {
    console.log(JSON.stringify(p, null, 2));
  } else {
    for (const c of p.checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.id.padEnd(16)} ${c.label}${c.detail ? ` (${c.detail})` : ''}`);
    console.log('');
    console.log(p.ok ? `VALID  ${p.verdict}  holder ${p.holder}  challenge ${p.challenge?.text}` : 'INVALID  this transaction proves nothing about a balance');
  }
  process.exit(p.ok ? 0 : 1);
} catch (e) {
  console.error(`error: ${(e as Error)?.message ?? e}`);
  process.exit(2);
}
