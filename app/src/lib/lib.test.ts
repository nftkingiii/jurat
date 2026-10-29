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

import { createChallengeTx, parseContractText, proveTx, toChallenge, type ContractChallenge } from './contract';
import { nearText, shortAccount } from './account';

describe('contract helpers', () => {
  const c: ContractChallenge = {
    id: '2',
    challenge: 'jurat:juratapp.near:2:0123456789abcdef',
    verifier: 'juratapp.near',
    token_id: 'nep141:usdc.near',
    threshold: '1000000',
    created_at_ms: '1792000000000',
    expires_at_ms: '1792003600000',
    confirmed: false,
    statements: [],
  };

  it('parses contract challenge text and rejects other text', () => {
    expect(parseContractText(c.challenge)).toEqual({ contract: 'juratapp.near', id: '2', nonce: '0123456789abcdef' });
    expect(parseContractText('jurat:v1:1:0123456789abcdef:1:nep141:x')).toBeNull();
    expect(parseContractText('jurat:juratapp.near:2:0123')).toBeNull();
  });

  it('maps a contract challenge to the common shape', () => {
    expect(toChallenge(c)).toEqual({ expiresMs: 1792003600000, nonce: '0123456789abcdef', threshold: '1000000', tokenId: 'nep141:usdc.near', text: c.challenge });
  });

  it('builds create_challenge and prove calls with the right deposits', () => {
    const create = createChallengeTx('juratapp.near', 'nep141:usdc.near', '1000000', 60).actions[0].params;
    expect(create).toMatchObject({ methodName: 'create_challenge', args: { token_id: 'nep141:usdc.near', threshold: '1000000', ttl_minutes: 60 }, deposit: '5000000000000000000000' });
    const prove = proveTx('juratapp.near', '2', { a: 1 }, 2n * 10n ** 21n).actions[0].params;
    expect(prove).toMatchObject({ methodName: 'prove', args: { challenge_id: '2', signed_data: { a: 1 } }, gas: '100000000000000', deposit: '12000000000000000000000' });
  });
});

describe('account display', () => {
  it('formats yoctoNEAR without floating point', () => {
    expect(nearText(1_987_654_321n * 10n ** 15n)).toBe('1.987');
    expect(nearText(4n * 10n ** 22n, 2)).toBe('0.04');
    expect(nearText(0n)).toBe('0.000');
  });

  it('shortens only long implicit accounts', () => {
    expect(shortAccount('juratapp.near')).toBe('juratapp.near');
    expect(shortAccount('a'.repeat(64))).toBe('aaaaaaaa…aaaaaa');
  });
});
