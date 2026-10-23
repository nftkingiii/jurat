import { describe, expect, it } from 'vitest';
import { checkProof } from './check';

// Run with LIVE=1 (network: NEAR archival RPC, OutLayer API, Intel collateral).
// Live: our first mainnet run (spike enclave, no challenge). Every attestation
// check must pass, and the proof as a whole must fail because it carries no
// Jurat challenge.
describe('checkProof against mainnet', () => {
  it('verifies the attestation of tx 9pJpnKEx and refuses it as a Jurat proof', async () => {
    const p = await checkProof('9pJpnKExPT7bn6HCrdWG9u3z21d1dFudMRNGdrmHih4J', 'juratapp.near');
    const by = Object.fromEntries(p.checks.map((c) => [c.id, c]));
    for (const id of ['tx', 'ran', 'code', 'attestation', 'intel', 'quote-type', 'debug', 'build', 'binding', 'input', 'output', 'wasm']) {
      expect(by[id]?.ok, `${id}: ${by[id]?.detail}`).toBe(true);
    }
    expect(by['challenge-format'].ok).toBe(false);
    expect(p.verdict).toBe('confirmed');
    expect(p.ok).toBe(false);
  }, 60_000);
});
