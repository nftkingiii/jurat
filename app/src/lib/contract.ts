// The Jurat statement contract: on-chain challenges with enforced expiry, and
// a public statement for every answer. A checker only trusts a contract whose
// deployed code hash is one we published.

import { RPC } from './config';
import { rpc, view } from './rpc';
import type { Challenge } from './challenge';

/** Deployed contracts and the base58 code hash of the wasm we built for each. */
export const CONTRACTS: Record<string, string> = {
  'juratapp.near': '7AEdAAvC9nc856UEijAgfUzabJMdWtCSNhSSoFXExYEw',
};
export const DEFAULT_CONTRACT = 'juratapp.near';

/** Kept back by prove() for the statement; the unused part is refunded. */
export const STATEMENT_RESERVE = 10n ** 22n; // 0.01 NEAR
/** Attached to create_challenge for its storage; the excess is refunded. */
export const CHALLENGE_DEPOSIT = 5n * 10n ** 21n; // 0.005 NEAR
/** prove() needs 90 Tgas: 60 for OutLayer (50 of it for OutLayer's callback), 20 for ours. */
export const PROVE_GAS = '100000000000000';

export interface Statement {
  challenge_id: string;
  verdict: string;
  holder: string | null;
  prover: string;
  token_id: string;
  threshold: string;
  wasm_hash: string;
  reason: string | null;
  recorded_at_ms: string;
  block_height: string;
}

export interface ContractChallenge {
  id: string;
  challenge: string;
  verifier: string;
  token_id: string;
  threshold: string;
  created_at_ms: string;
  expires_at_ms: string;
  confirmed: boolean;
  statements: Statement[];
}

const CONTRACT_TEXT = /^jurat:([a-z0-9._-]{2,64}):(\d{1,20}):([0-9a-f]{16})$/;

/** jurat:<contract>:<id>:<nonce>, the text the contract binds a proof to. */
export function parseContractText(text: string): { contract: string; id: string; nonce: string } | null {
  const m = text.match(CONTRACT_TEXT);
  return m ? { contract: m[1], id: m[2], nonce: m[3] } : null;
}

export async function getChallenge(contract: string, id: string): Promise<ContractChallenge | null> {
  return view<ContractChallenge | null>(contract, 'get_challenge', { id });
}

/** The contract's challenge in the app's common shape. */
export function toChallenge(c: ContractChallenge): Challenge {
  return {
    expiresMs: Number(c.expires_at_ms),
    nonce: c.challenge.split(':').pop()!,
    threshold: c.threshold,
    tokenId: c.token_id,
    text: c.challenge,
  };
}

export async function codeHash(account: string): Promise<string> {
  const a = await rpc<{ code_hash: string }>('query', { request_type: 'view_account', finality: 'final', account_id: account }, RPC);
  return a.code_hash;
}

export function createChallengeTx(contract: string, tokenId: string, threshold: string, ttlMinutes: number) {
  return {
    receiverId: contract,
    actions: [
      {
        type: 'FunctionCall' as const,
        params: {
          methodName: 'create_challenge',
          args: { token_id: tokenId, threshold, ttl_minutes: ttlMinutes },
          gas: '30000000000000',
          deposit: CHALLENGE_DEPOSIT.toString(),
        },
      },
    ],
  };
}

export function proveTx(contract: string, id: string, signedData: object, outlayerCost: bigint) {
  return {
    receiverId: contract,
    actions: [
      {
        type: 'FunctionCall' as const,
        params: {
          methodName: 'prove',
          args: { challenge_id: id, signed_data: signedData },
          gas: PROVE_GAS,
          deposit: (outlayerCost + STATEMENT_RESERVE).toString(),
        },
      },
    ],
  };
}
