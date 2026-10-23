import { describe, expect, it } from 'vitest';
import { hex, sha256 } from './bytes';
import { makeChallenge, parseChallenge } from './challenge';
import { boundNonce } from './intent';

describe('challenge', () => {
  it('round-trips, with a token id that contains colons', () => {
    const c = makeChallenge('nep141:usdc.near', '1000000', 30, 1_792_000_000_000);
    expect(c.text).toMatch(/^jurat:v1:1792001800000:[0-9a-f]{16}:1000000:nep141:usdc\.near$/);
    expect(parseChallenge(c.text)).toEqual(c);
  });

  it('refuses text that is not a challenge', () => {
    expect(() => parseChallenge('jurat:jurat.near:0:0707070707070707')).toThrow();
    expect(() => parseChallenge('jurat:v1:1792001800000:xyz:1:nep141:usdc.near')).toThrow();
    expect(() => makeChallenge('nep141:usdc.near', '1.5', 30)).toThrow(/integer/);
    expect(() => makeChallenge('nep141:usdc.near', '1', 0)).toThrow(/expiry/);
  });
});

describe('bound nonce', () => {
  it('carries sha256(challenge)[0..7] where the enclave looks for it', async () => {
    const salt = Uint8Array.from([0x25, 0x28, 0x12, 0xb3]);
    const n = await boundNonce(salt, new Date(1_792_000_300_000), new Date(1_792_000_000_000), 'jurat:jurat.near:0:0707070707070707');
    expect(n.length).toBe(32);
    expect([...n.subarray(0, 5)]).toEqual([86, 40, 246, 198, 0]);
    expect(hex(n.subarray(5, 9))).toBe('252812b3');
    // Same digest as the contract and enclave tests, computed outside both.
    expect(hex(n.subarray(25))).toBe('8f9910b585a96d');
    expect(hex((await sha256('jurat:jurat.near:0:0707070707070707')).subarray(0, 7))).toBe('8f9910b585a96d');
  });
});
